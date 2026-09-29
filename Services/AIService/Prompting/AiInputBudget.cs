using System;
using System.Collections.Generic;
using System.Linq;
using System.Text;

using Diagramon.Models;
using Diagramon.Services.Documents;

namespace Diagramon.Services.AIService.Prompting;

/// <summary>
/// 输入侧瘦身（V2-7，方案 §6.9）：<b>只作用于发出去的那一份 payload</b>。
/// </summary>
/// <remarks>
/// <para>
/// 面板里的消息列表、<c>Conversations/&lt;hash&gt;.json</c> 本地存档、<c>ClearHistory</c> 的语义
/// <b>全都不变</b> —— 变的只是组装出来的 <c>messages</c> 数组。用户看到的历史是完整的，
/// 发出去的才是有界的。
/// </para>
/// <para>
/// 不这么做的话输入是 <b>O(轮数 × 代码量)</b>：以"300 行 mermaid ≈ 4 KB"为例，第 30 轮的输入约 31.5k
/// token，其中 96% 是重复历史；累计约 492k。瘦身后每轮稳定在 ≈4–5k，且<b>不再随轮数增长</b>。
/// </para>
/// <para>
/// <b>三条不能砍</b>：① 当前文档全文（可截断但必须声明 —— 它是"当前真值"，砍了模型会回退到旧版本）；
/// ② 用户最近一次的修改要求；③ 本次请求的图片（历史裁剪不得连带删掉 <c>image_url</c>）。
/// </para>
/// <para>
/// <b>为什么必须在客户端做</b>：只有客户端知道哪条是"当前文档"、哪条是"历史生成的旧版本"、
/// 用户是否手工改过当前文档。服务端看到的是一个扁平数组，<b>截错了就丢当前状态</b>。
/// </para>
/// </remarks>
public static class AiInputBudget
{
    /// <summary>历史轮数上限，超过从最旧的丢。</summary>
    public const int HistoryTurnsMax = 6;

    /// <summary>只有最近这么多轮带完整代码，更早的压成一行摘要。</summary>
    public const int HistoryFullCodeTurns = 2;

    /// <summary>当前文档行数上限。</summary>
    public const int DocumentMaxLines = 4000;

    /// <summary>当前文档字节上限（UTF-8）。</summary>
    public const int DocumentMaxBytes = 64 * 1024;

    /// <summary>
    /// 输入 token 预算（<b>成本闸门</b>，不是窗口闸门）。超出后从最旧的历史开始丢。
    /// </summary>
    public const int InputTokenBudget = 32_000;

    /// <summary>截断后的当前文档。</summary>
    /// <param name="Text">实际要发出去的文本（已截断）。</param>
    /// <param name="TotalLines">原始行数（用于向模型声明"共多少行"）。</param>
    /// <param name="Truncated">是否发生了截断 —— 必须声明，否则模型以为看到的是全文。</param>
    public sealed record Document(string Text, int TotalLines, bool Truncated)
    {
        public static Document Empty { get; } = new(string.Empty, 0, false);
    }

    /// <summary>一轮对话：一条用户消息 + 其后的一条助手消息（任一侧可能缺）。</summary>
    /// <param name="UserText">用户那一句（连续多条用户消息会合并）。</param>
    /// <param name="AssistantCode">助手那一版代码；<c>null</c> = 这一轮没有代码。</param>
    /// <param name="CodeLines">那一版代码的行数（压成摘要时要报给模型）。</param>
    /// <param name="Elided">这一轮的代码是否已被压成摘要（太旧的轮次）。</param>
    public sealed record Turn(string? UserText, string? AssistantCode, int CodeLines, bool Elided);

    /// <summary>
    /// 按行数与字节数截断当前文档（先截行、再截字节）。
    /// </summary>
    public static Document ClampDocument(string? code)
    {
        if (string.IsNullOrEmpty(code))
        {
            return Document.Empty;
        }

        var lines = code.Split('\n');
        var text = code;

        if (lines.Length > DocumentMaxLines)
        {
            text = string.Join('\n', lines.Take(DocumentMaxLines));
        }

        if (Encoding.UTF8.GetByteCount(text) > DocumentMaxBytes)
        {
            text = TakeBytes(text, DocumentMaxBytes);
        }

        return new Document(text, lines.Length, text.Length != code.Length);
    }

    /// <summary>
    /// 估算一段文本的 token 数。
    /// </summary>
    /// <remarks>
    /// 粗估即可（这是**成本闸门**，不是计费口径）：CJK 约 1 字 1 token，其余约 4 字符 1 token。
    /// 与服务端 <c>tokens.estimate_messages_tokens</c> 同量级，够用来决定"该不该丢最旧的一轮"。
    /// </remarks>
    public static int EstimateTokens(string? text)
    {
        if (string.IsNullOrEmpty(text))
        {
            return 0;
        }

        var cjk = text.Count(ch => ch >= 0x2E80);
        return cjk + ((text.Length - cjk + 3) / 4);
    }

    /// <summary>
    /// 裁剪历史：轮数上限 → 旧轮压摘要 → token 预算。
    /// </summary>
    /// <param name="history">面板传进来的全量历史（本轮提问**不在其中**，它由 prompt 单独传）。</param>
    /// <param name="fixedTokens">每轮固定开销（system prompt + 本次提问 + 当前文档）的估算值。</param>
    public static List<Turn> Trim(IReadOnlyList<AIMessage> history, int fixedTokens)
    {
        var turns = BuildTurns(history);

        if (turns.Count > HistoryTurnsMax)
        {
            turns = turns.Skip(turns.Count - HistoryTurnsMax).ToList();
        }

        // 更早的轮只留一行摘要：历史里那些完整旧代码会让模型倾向于**沿用早期版本**，
        // 而当前文档在 system prompt 里 —— 两处冲突时模型可能选错。只留最近 1–2 轮反而更准。
        for (var i = 0; i < turns.Count - HistoryFullCodeTurns; i++)
        {
            turns[i] = turns[i] with { Elided = true };
        }

        // 成本闸门：超预算就从最旧的丢，但**至少留一轮**（否则模型看不到任何上下文）
        while (turns.Count > 1 && fixedTokens + EstimateTokens(turns) > InputTokenBudget)
        {
            turns.RemoveAt(0);
        }

        return turns;
    }

    /// <summary>把历史消息切成"轮"。</summary>
    private static List<Turn> BuildTurns(IReadOnlyList<AIMessage> history)
    {
        var turns = new List<Turn>();
        string? pendingUser = null;

        foreach (var message in history)
        {
            if (message.IsLoading)
            {
                continue;
            }

            if (message.Role == MessageRole.User)
            {
                // 连续两条用户消息（上一轮没拿到回复）：**合并而不是丢** —— 那是用户说过的话
                pendingUser = pendingUser is null ? message.Content : $"{pendingUser}\n{message.Content}";
                continue;
            }

            if (message.Role == MessageRole.Assistant && !string.IsNullOrWhiteSpace(message.GeneratedCode))
            {
                turns.Add(new Turn(pendingUser, message.GeneratedCode, CountLines(message.GeneratedCode), false));
                pendingUser = null;
            }
        }

        // 末尾可能只剩一条用户消息（比如上一轮失败了）：照样带上
        if (!string.IsNullOrWhiteSpace(pendingUser))
        {
            turns.Add(new Turn(pendingUser, null, 0, false));
        }

        return turns;
    }

    private static int EstimateTokens(IEnumerable<Turn> turns) => turns.Sum(turn =>
        EstimateTokens(turn.UserText)
        + (turn.Elided
            ? SummaryTokens(turn.CodeLines)
            : EstimateTokens(turn.AssistantCode)));

    private static int SummaryTokens(int lines) => EstimateTokens(Summary(lines));

    /// <summary>旧轮次的代码被压成这一行。</summary>
    public static string Summary(int lines) => $"（历史：曾生成过一版 {lines} 行的图）";

    private static int CountLines(string code) => code.Count(ch => ch == '\n') + 1;

    /// <summary>按 UTF-8 字节数取前缀，**不切坏代理对**。</summary>
    private static string TakeBytes(string text, int maxBytes)
    {
        var bytes = 0;
        var index = 0;

        while (index < text.Length)
        {
            var isPair = char.IsSurrogatePair(text, index);
            var size = isPair
                ? 4
                : Encoding.UTF8.GetByteCount(text.AsSpan(index, 1));

            if (bytes + size > maxBytes)
            {
                break;
            }

            bytes += size;
            index += isPair ? 2 : 1;
        }

        return text[..index];
    }
}

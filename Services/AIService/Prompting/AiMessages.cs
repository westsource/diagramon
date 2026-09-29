using System.Collections.Generic;
using System.Linq;

using Diagramon.Models;
using Diagramon.Services.Documents;

namespace Diagramon.Services.AIService.Prompting;

/// <summary>
/// 把「system + 历史 + 本次提问」组装成 OpenAI 形态的 messages。
/// </summary>
/// <remarks>
/// <para>
/// 这段逻辑原先在四个 provider 里**逐字复制**了四份（<c>OpenAIService</c> / <c>AzureOpenAIService</c> /
/// <c>OllamaService</c> / <c>CustomAIService</c>，实测 diff 为空）。四份一模一样的代码不是"风格问题"：
/// 加一个格式、改一次历史回灌的措辞、或做输入侧瘦身，都要改四处 —— 必然漏一处。
/// </para>
/// <para>
/// <b>历史回灌的格式名按当前文档格式取</b>：旧实现把它硬编码成 "Mermaid"，在 DOT 文档下会误导模型
/// （模型看到"这是生成的 Mermaid 代码"却收到 DOT）。
/// </para>
/// <para>
/// <b>这里发出去的是"瘦身后"的那一份</b>（V2-7，见 <see cref="AiInputBudget"/>）：
/// 历史按轮数与 token 预算裁剪、旧轮的代码压成一行摘要、当前文档超长则截断并在 system prompt 里声明。
/// 面板里用户看到的历史不受影响。
/// </para>
/// </remarks>
public static class AiMessages
{
    public static List<object> Build(
        string prompt, string? currentCode, List<AIMessage> history, IDocumentFormat format)
    {
        var turns = Prepare(prompt, currentCode, history, format, out var document);

        var messages = new List<object>
        {
            new { role = "system", content = AiPromptCatalog.BuildSystemPrompt(format.Ai, document) },
        };

        AppendHistory(messages, turns, format);

        messages.Add(new { role = "user", content = prompt });

        return messages;
    }

    /// <summary>
    /// 组装「图片 + 文字」的 messages（V2）。
    /// </summary>
    /// <remarks>
    /// <para>
    /// 本次提问的 <c>content</c> 是<b>数组</b>（OpenAI 多模态形态）：先文字、后图片。
    /// 服务端 <c>gateway.normalize_messages</c> 按数组顺序原样转发，且只保留
    /// <c>type</c> / <c>text</c> / <c>image_url.url</c> 三个键 —— 所以这里不要塞别的字段。
    /// </para>
    /// <para>
    /// <paramref name="imageDataUrl"/> 必须是 <c>data:image/png;base64,…</c> 形态：
    /// 服务端只接受 data URL（不接受 http 图片地址），也正因此体积上限校验的是<b>字符串长度</b>。
    /// </para>
    /// <para>
    /// 历史仍是纯文本 —— 上一轮的图不必回灌（既省 token，也避免模型把旧图当成当前输入）。
    /// 本次请求的图片在**最后一条消息**上，历史裁剪碰不到它（§6.9 的"三条不能砍"之三）。
    /// </para>
    /// </remarks>
    public static List<object> BuildWithImage(
        string prompt,
        string imageDataUrl,
        string? currentCode,
        List<AIMessage> history,
        IDocumentFormat format)
    {
        var turns = Prepare(prompt, currentCode, history, format, out var document);

        var messages = new List<object>
        {
            new { role = "system", content = AiPromptCatalog.BuildVisionPrompt(format.Ai, document) },
        };

        AppendHistory(messages, turns, format);

        messages.Add(new
        {
            role = "user",
            content = new object[]
            {
                new { type = "text", text = prompt },
                new { type = "image_url", image_url = new { url = imageDataUrl } },
            },
        });

        return messages;
    }

    /// <summary>
    /// 共用的准备步骤：截断当前文档 → 去重 → 按预算裁剪历史。
    /// </summary>
    /// <remarks>
    /// <b>去重的判据是"当前文档 == 即将随历史发出去的最近一版生成代码"</b>：
    /// 那份代码本来就在 history 里，system prompt 再塞一遍是纯浪费（每轮约 1k token）。
    /// 用户手工改过当前文档时两者不同 —— 此时**不能**去重，否则模型会拿旧版本继续改。
    /// </remarks>
    private static List<AiInputBudget.Turn> Prepare(
        string prompt,
        string? currentCode,
        List<AIMessage> history,
        IDocumentFormat format,
        out AiInputBudget.Document document)
    {
        document = AiInputBudget.ClampDocument(currentCode);

        // 固定开销（system prompt + 本次提问 + 当前文档）先算出来，历史只能吃剩下的预算
        var fixedTokens = AiInputBudget.EstimateTokens(format.Ai.SystemPrompt)
            + AiInputBudget.EstimateTokens(format.Ai.VisionPrompt)
            + AiInputBudget.EstimateTokens(prompt)
            + AiInputBudget.EstimateTokens(document.Text);

        var turns = AiInputBudget.Trim(history, fixedTokens);

        // 去重只在"没截断"时做：截断过的文档是残缺的，历史里那份才是完整的，不能省
        var newest = turns.Count > 0 ? turns[^1] : null;
        if (!document.Truncated
            && newest is { Elided: false }
            && !string.IsNullOrEmpty(newest.AssistantCode)
            && newest.AssistantCode == document.Text)
        {
            document = document with { Text = string.Empty, Truncated = false };
        }

        return turns;
    }

    /// <summary>
    /// 回灌历史：user 原样、assistant 包成代码块（格式名按当前文档格式取）；
    /// 被压成摘要的旧轮次只发一行 —— 不发它的完整代码。
    /// </summary>
    private static void AppendHistory(
        List<object> messages, IReadOnlyList<AiInputBudget.Turn> turns, IDocumentFormat format)
    {
        var label = format.Ai.DisplayLabel;

        foreach (var turn in turns)
        {
            if (!string.IsNullOrWhiteSpace(turn.UserText))
            {
                messages.Add(new { role = "user", content = turn.UserText });
            }

            if (turn.Elided)
            {
                messages.Add(new { role = "assistant", content = AiInputBudget.Summary(turn.CodeLines) });
            }
            else if (!string.IsNullOrWhiteSpace(turn.AssistantCode))
            {
                messages.Add(
                    new { role = "assistant", content = $"这是生成的 {label} 代码：\n```\n{turn.AssistantCode}\n```" });
            }
        }
    }
}

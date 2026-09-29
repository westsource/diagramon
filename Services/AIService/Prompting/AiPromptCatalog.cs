using System.Text.RegularExpressions;

using Diagramon.Services.Documents;

namespace Diagramon.Services.AIService.Prompting;

/// <summary>
/// 把「格式提供的提示词素材」拼成实际发给模型的文本，并从回复里抽出代码。
/// </summary>
/// <remarks>
/// <para>
/// 这里**只放跨格式共享的拼接规则**（"当前代码"怎么附加、"与图片冲突时以图片为准"这句放哪、
/// 无代码块时怎么兜底）。各格式的提示词原文在 <see cref="IDocumentFormat.Ai"/> 里 ——
/// 提示词属于格式，拼接属于共享逻辑。改造前这两件事混在一个按 id 分支的中心目录里
/// （§9 陷阱 6：每加一个格式都要回去改它，漏一次就静默按 Mermaid 处理）。
/// </para>
/// </remarks>
public static class AiPromptCatalog
{
    /// <summary>文字生成的 system prompt；当前文档非空时追加，被截断时**声明**。</summary>
    public static string BuildSystemPrompt(AiPromptSet ai, AiInputBudget.Document document) =>
        string.IsNullOrEmpty(document.Text)
            ? ai.SystemPrompt
            : $"{ai.SystemPrompt}\n\n{ai.CurrentCodeHeader}{TruncationNote(document)}\n{document.Text}";

    /// <summary>
    /// 识图的 system prompt；当前文档非空时追加。
    /// </summary>
    /// <remarks>
    /// 追加的那句必须写明<b>以图片为准</b>：否则模型会在旧代码上叠加，产出"两版内容的混合体"。
    /// </remarks>
    public static string BuildVisionPrompt(AiPromptSet ai, AiInputBudget.Document document) =>
        string.IsNullOrEmpty(document.Text)
            ? ai.VisionPrompt
            : $"{ai.VisionPrompt}\n\n当前已有代码（供参考结构；**与图片冲突时以图片为准**）{TruncationNote(document)}：\n{document.Text}";

    /// <summary>
    /// 截断必须**声明**：不声明的话模型以为看到的是全文，会"接着往下写"或断言文档里没有的东西。
    /// </summary>
    private static string TruncationNote(AiInputBudget.Document document) =>
        document.Truncated
            ? $"（**文档过长已截断：以下只是前 {document.Text.Split('\n').Length} 行，共 {document.TotalLines} 行**）"
            : string.Empty;

    /// <summary>
    /// 从模型回复中提取本格式的代码；内容为空时返回 null，没有代码块时返回去除首尾空白的原文。
    /// </summary>
    public static string? ExtractCode(string response, AiPromptSet ai)
    {
        if (string.IsNullOrWhiteSpace(response))
        {
            return null;
        }

        if (!string.IsNullOrEmpty(ai.CodeFencePattern)
            && Regex.Match(response, ai.CodeFencePattern) is { Success: true } match)
        {
            return match.Groups[1].Value.Trim();
        }

        // 无代码块：整段当代码（改造前就是这个行为，只是当时分成"命中起始关键字"与"未命中"两条
        // 返回值完全相同的分支；这里合并为一条，行为不变）。
        return response.Trim();
    }
}

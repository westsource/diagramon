using System.Text.RegularExpressions;

namespace Diagramon.Services.AIService.Prompting;

/// <summary>
/// 各图表格式的 AI 提示词与代码提取逻辑的统一入口，未知格式一律按 Mermaid 处理。
/// </summary>
public static class AiPromptCatalog
{
    /// <summary>Graphviz DOT 格式标识。</summary>
    private const string DotFormatId = "dot";

    /// <summary>Mermaid 格式的系统提示词。</summary>
    /// <remarks>该文案与旧版各 Provider 内的实现逐字符一致（含源码换行符），请勿调整换行。</remarks>
    private const string MermaidSystemPrompt = @"你是一个专业的 Mermaid 图表代码生成助手。你的任务是根据用户的自然语言描述生成或修改 Mermaid 代码。

规则：
1. 只返回 Mermaid 代码，不要包含其他解释文字
2. 代码必须符合 Mermaid 语法规范
3. 如果用户要求修改现有代码，请基于现有代码进行修改
4. 如果用户描述不清晰，生成一个合理的默认图表
5. 支持的图表类型：流程图、时序图、类图、状态图、甘特图、饼图、ER图等

返回格式：直接返回 Mermaid 代码，不要使用代码块标记。";

    /// <summary>Graphviz DOT 格式的系统提示词。</summary>
    private const string DotSystemPrompt =
        "你是一个专业的 Graphviz DOT 图表代码生成助手。你的任务是根据用户的自然语言描述生成或修改 Graphviz DOT 代码。\n\n" +
        "规则：\n" +
        "1. 只返回 DOT 代码，不要包含其他解释文字\n" +
        "2. 代码必须符合 Graphviz DOT 语法规范，顶层必须是 digraph 或 graph\n" +
        "3. 如果用户要求修改现有代码，请基于现有代码进行修改\n" +
        "4. 如果用户描述不清晰，生成一个合理的默认图\n" +
        "5. 布局引擎通过代码里的 rankdir/splines 等属性表达即可，不要输出布局引擎名字\n\n" +
        "返回格式：直接返回 DOT 代码，不要使用代码块标记。";

    /// <summary>
    /// 获取指定格式的系统提示词；<paramref name="currentCode"/> 非空时追加当前代码。
    /// </summary>
    public static string SystemPromptFor(string formatId, string? currentCode)
    {
        if (formatId == DotFormatId)
        {
            var dotPrompt = DotSystemPrompt;

            if (!string.IsNullOrWhiteSpace(currentCode))
            {
                dotPrompt += $"\n\n当前 DOT 代码：\n{currentCode}";
            }

            return dotPrompt;
        }

        var prompt = MermaidSystemPrompt;

        if (!string.IsNullOrWhiteSpace(currentCode))
        {
            prompt += $"\n\n当前 Mermaid 代码：\n{currentCode}";
        }

        return prompt;
    }

    /// <summary>
    /// 从模型回复中提取指定格式的代码；内容为空时返回 null，没有代码块时返回去除首尾空白的原文。
    /// </summary>
    public static string? ExtractCode(string response, string formatId)
    {
        if (string.IsNullOrWhiteSpace(response))
            return null;

        var codeBlockMatch = Regex.Match(response, formatId == DotFormatId
            ? @"```\s*(?:dot|graphviz)?\s*([\s\S]*?)```"
            : @"```\s*(?:mermaid)?\s*([\s\S]*?)```");

        if (codeBlockMatch.Success)
        {
            return codeBlockMatch.Groups[1].Value.Trim();
        }

        // 无代码块：整段当代码（改造前就是这个行为，只是当时分成"命中起始关键字"与"未命中"两条
        // 返回值完全相同的分支；这里合并为一条，行为不变）。
        return response.Trim();
    }
}
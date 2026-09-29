using System.Collections.Generic;
using AvaloniaEdit.Highlighting;
using Diagramon.Services.Documents.Renderers;
using Diagramon.Services.Highlighting;

namespace Diagramon.Services.Documents.Formats;

/// <summary>
/// Mermaid 格式条目（方案 §8.2.2）。它是注册表的第一个注册项，也是未知扩展名的回退格式。
/// </summary>
public sealed class MermaidFormat : IDocumentFormat
{
    private static IHighlightingDefinition? _highlighting;
    private static IReadOnlyList<LayoutOption>? _layoutOptions;
    private static IReadOnlyList<string>? _extensions;

    public string Id => "mermaid";

    public string DisplayNameKey => "FormatMermaid";

    public IReadOnlyList<string> Extensions => _extensions ??=
    [
        ".mermaid",
        ".mmd",
    ];

    public string DefaultFileNameKey => "UntitledMermaidFileName";

    /// <summary>沿用既有的 <c>mmd</c>（服务端白名单里的取值），不改成 <c>mermaid</c>。</summary>
    public IReadOnlyList<string> CloudFormatIds => ["mmd", "mermaid"];

    public DocumentSurfaceKind Surface => DocumentSurfaceKind.TextWithPreview;

    public bool SupportsAiAssistant => true;

    /// <summary>
    /// Mermaid 的系统提示词。
    /// </summary>
    /// <remarks>**逐字符与改造前一致（含源码换行符）** —— 这段文案是与模型长期调过的，不要顺手改措辞。</remarks>
    private const string SystemPrompt = @"你是一个专业的 Mermaid 图表代码生成助手。你的任务是根据用户的自然语言描述生成或修改 Mermaid 代码。

规则：
1. 只返回 Mermaid 代码，不要包含其他解释文字
2. 代码必须符合 Mermaid 语法规范
3. 如果用户要求修改现有代码，请基于现有代码进行修改
4. 如果用户描述不清晰，生成一个合理的默认图表
5. 支持的图表类型：流程图、时序图、类图、状态图、甘特图、饼图、ER图等

返回格式：直接返回 Mermaid 代码，不要使用代码块标记。";

    /// <summary>识图的系统提示词（V2）：约束完全不同 —— 看图最大的风险是**编造图里没有的东西**。</summary>
    private const string VisionPrompt =
        "你是一个图表识别助手。用户会给出一张图表截图，请把它逆向成 Mermaid 源码。\n" +
        "规则：\n" +
        "1. 只输出代码，不要任何解释文字\n" +
        "2. **只画图中确实存在的元素与连线**，不要补充你没看到的东西\n" +
        "3. 标签文字**原样保留**（不翻译、不改写、不替用户纠正错别字）\n" +
        "4. 尽量保持原有方向（从上到下 / 从左到右）与分组\n" +
        "5. 无法辨认的文字用「?」占位，不要编造内容\n" +
        "6. 用 flowchart / sequenceDiagram / classDiagram 等 Mermaid 标准语法\n" +
        "返回格式：直接返回代码，不要使用代码块标记。";

    public AiPromptSet Ai { get; } = new(
        "Mermaid",
        SystemPrompt,
        VisionPrompt,
        "当前 Mermaid 代码：",
        @"```\s*(?:mermaid)?\s*([\s\S]*?)```");

    public IDocumentRenderer Renderer { get; } = new MermaidBundledJsRenderer();

    /// <summary>Mermaid 无布局引擎可选（预留给 DOT 等格式的扩展点）。</summary>
    public IReadOnlyList<LayoutOption> LayoutOptions => _layoutOptions ??= [];

    public IHighlightingDefinition? Highlighting => _highlighting ??= MermaidHighlightingProvider.Create();

    public bool UsesMermaidCliExport => true;

    /// <summary>Mermaid 是唯一能被图形编辑器（drawio / Excalidraw）直接读入的格式（方案 §3.2.2）。</summary>
    public bool SupportsGraphImport => true;

    public string CreateDefaultContent() => DefaultContent;

    /// <summary>新建标签页的初始内容；与改造前 <c>MainViewModel.SetInitialContent</c> 的字面量一致。</summary>
    internal const string DefaultContent = """
graph TD
    A[开始] --> B{判断}
    B -->|是| C[处理A]
    B -->|否| D[处理B]
    C --> E[结束]
    D --> E
""";
}
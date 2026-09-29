using System.Collections.Generic;
using AvaloniaEdit.Highlighting;
using Diagramon.Services.Documents.Renderers;
using Diagramon.Services.Highlighting;

namespace Diagramon.Services.Documents.Formats;

/// <summary>
/// Graphviz DOT 格式条目（方案 §8.3.1）。
/// </summary>
/// <remarks>
/// <b>命名注意</b>：<c>dot</c> 同时是格式 id、扩展名与一个布局引擎名。代码里一律不制造语义重载的
/// 标识符（不写 <c>DotDot</c> / <c>dotEngine</c> 这类名字）：布局引擎统一叫 <c>Layout</c>。
/// </remarks>
public sealed class DotFormat : IDocumentFormat
{
    private static IHighlightingDefinition? _highlighting;
    private static IReadOnlyList<LayoutOption>? _layoutOptions;

    public string Id => "dot";

    public string DisplayNameKey => "FormatDot";

    /// <summary>按长度降序（本格式两个扩展名等长，顺序即声明顺序）。</summary>
    public IReadOnlyList<string> Extensions => [".dot", ".gv"];

    public string DefaultFileNameKey => "UntitledDotFileName";

    /// <summary>服务端白名单里的取值（《Diagramon 服务端方案》§6 第 7 条）：<c>dot</c>，别名 <c>gv</c>。</summary>
    public IReadOnlyList<string> CloudFormatIds => ["dot", "gv"];

    public DocumentSurfaceKind Surface => DocumentSurfaceKind.TextWithPreview;

    public bool SupportsAiAssistant => true;

    /// <summary>Graphviz DOT 的系统提示词。与 Mermaid 一样是调过的文案，别顺手改措辞。</summary>
    private const string SystemPrompt =
        "你是一个专业的 Graphviz DOT 图表代码生成助手。你的任务是根据用户的自然语言描述生成或修改 Graphviz DOT 代码。\n\n" +
        "规则：\n" +
        "1. 只返回 DOT 代码，不要包含其他解释文字\n" +
        "2. 代码必须符合 Graphviz DOT 语法规范，顶层必须是 digraph 或 graph\n" +
        "3. 如果用户要求修改现有代码，请基于现有代码进行修改\n" +
        "4. 如果用户描述不清晰，生成一个合理的默认图\n" +
        "5. 布局引擎通过代码里的 rankdir/splines 等属性表达即可，不要输出布局引擎名字\n\n" +
        "返回格式：直接返回 DOT 代码，不要使用代码块标记。";

    /// <summary>识图的系统提示词（V2）。</summary>
    private const string VisionPrompt =
        "你是一个图表识别助手。用户会给出一张图表截图，请把它逆向成 Graphviz DOT 源码。\n" +
        "规则：\n" +
        "1. 只输出代码，不要任何解释文字\n" +
        "2. **只画图中确实存在的元素与连线**，不要补充你没看到的东西\n" +
        "3. 标签文字**原样保留**（不翻译、不改写、不替用户纠正错别字）\n" +
        "4. 尽量保持原有方向（从上到下 / 从左到右）与分组\n" +
        "5. 无法辨认的文字用「?」占位，不要编造内容\n" +
        "6. 顶层必须是 digraph 或 graph，符合 DOT 语法\n" +
        "返回格式：直接返回代码，不要使用代码块标记。";

    public AiPromptSet Ai { get; } = new(
        "Graphviz DOT",
        SystemPrompt,
        VisionPrompt,
        "当前 DOT 代码：",
        @"```\s*(?:dot|graphviz)?\s*([\s\S]*?)```");

    public IDocumentRenderer Renderer { get; } = new DotWasmRenderer();

    /// <summary>
    /// 六个布局引擎 —— 这是 DOT 相对 Mermaid 的核心增量（方案 §8.3.3）。
    /// 显示名就是引擎名本身：它是专有名词，中英文下都写作 <c>neato</c>，不做翻译。
    /// </summary>
    public IReadOnlyList<LayoutOption> LayoutOptions => _layoutOptions ??=
    [
        new LayoutOption(DotWasmRenderer.DefaultLayout, DotWasmRenderer.DefaultLayout, IsDefault: true),
        new LayoutOption("neato", "neato"),
        new LayoutOption("fdp", "fdp"),
        new LayoutOption("sfdp", "sfdp"),
        new LayoutOption("twopi", "twopi"),
        new LayoutOption("circo", "circo"),
    ];

    public IHighlightingDefinition? Highlighting => _highlighting ??= DotHighlightingProvider.Create();

    /// <summary>导出与校验都在页面内完成，零子进程（方案 §8.3.4）。</summary>
    public bool UsesMermaidCliExport => false;

    /// <summary>DOT 不在图形编辑器（drawio / Excalidraw）解析器的输入格式里。</summary>
    public bool SupportsGraphImport => false;

    public string CreateDefaultContent() => DefaultContent;

    internal const string DefaultContent = """
digraph G {
    A -> B;
}
""";
}
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
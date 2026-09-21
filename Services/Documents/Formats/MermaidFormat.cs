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
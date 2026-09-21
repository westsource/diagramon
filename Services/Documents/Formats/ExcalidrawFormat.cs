using System.Collections.Generic;
using AvaloniaEdit.Highlighting;
using Diagramon.Services.Documents.Renderers;

namespace Diagramon.Services.Documents.Formats;

/// <summary>
/// Excalidraw 格式条目（方案 Phase 6）。
/// </summary>
/// <remarks>
/// <para>
/// 文档本体是 **JSON 文本**（<c>.excalidraw</c> 就是 Excalidraw 的场景 JSON），因此沿用文本模型与
/// 既有保存链路；画布由内嵌的 Excalidraw 承载（<see cref="DocumentSurfaceKind.EmbeddedApp"/>）。
/// </para>
/// <para>
/// 与 drawio 的差别：Excalidraw 是**库型**集成（我们自己页面里实例化 React 组件），
/// 没有 iframe / postMessage / init 握手 —— 这一点正是 Phase 6 要压测"承载层抽象是否被 drawio 污染"的地方。
/// </para>
/// </remarks>
public sealed class ExcalidrawFormat : IDocumentFormat
{
    /// <summary>格式 id（<c>MainViewModel</c> 建转换目标标签页时按它查注册表）。</summary>
    public const string FormatId = "excalidraw";

    private static IHighlightingDefinition? _highlighting;

    public string Id => FormatId;

    public string DisplayNameKey => "FormatExcalidraw";

    public IReadOnlyList<string> Extensions => [".excalidraw"];

    public string DefaultFileNameKey => "UntitledExcalidrawFileName";

    /// <summary>服务端白名单里的取值（《Diagramon 服务端方案》§6 第 7 条）。</summary>
    public IReadOnlyList<string> CloudFormatIds => ["excalidraw"];

    public DocumentSurfaceKind Surface => DocumentSurfaceKind.EmbeddedApp;

    /// <summary>与 drawio 同理：图形画布不是文本 DSL，AI 直接产场景 JSON 既不可靠也不可读。</summary>
    public bool SupportsAiAssistant => false;

    public IDocumentRenderer Renderer => NoPreviewRenderer.Instance;

    /// <summary>Excalidraw 没有布局引擎概念。</summary>
    public IReadOnlyList<LayoutOption> LayoutOptions => [];

    /// <summary>JSON 高亮（AvaloniaEdit 自带定义；文本面在 EmbeddedApp 下默认不显示，保留给并排模式）。</summary>
    public IHighlightingDefinition? Highlighting => _highlighting ??= HighlightingManager.Instance.GetDefinition("Json");

    public bool UsesMermaidCliExport => false;

    /// <summary>Excalidraw 自己就是转换目标（它提供 mermaid 导入器），不参与被导入。</summary>
    public bool SupportsGraphImport => false;

    public string CreateDefaultContent() => DefaultContent;

    /// <summary>一个空的 Excalidraw 场景（与该应用"新建"时落盘的结构一致）。</summary>
    internal const string DefaultContent = """
{"type":"excalidraw","version":2,"source":"Diagramon","elements":[],"appState":{"gridSize":null,"viewBackgroundColor":"#ffffff"},"files":{}}
""";
}
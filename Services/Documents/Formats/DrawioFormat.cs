using System.Collections.Generic;
using AvaloniaEdit.Highlighting;
using Diagramon.Services.Documents.Renderers;

namespace Diagramon.Services.Documents.Formats;

/// <summary>
/// drawio 格式条目（方案 §4.3 / §8.4.1）。
/// </summary>
/// <remarks>
/// <para>
/// <b>文档本体是 XML 文本</b>（<c>.drawio</c> 就是 mxfile XML），画布只是它的一个视图，
/// 因此仍然复用文本模型与既有保存链路（<c>TabItem.Content</c> → 落盘）。
/// </para>
/// <para>
/// 承载方式 <see cref="DocumentSurfaceKind.EmbeddedApp"/>：由独立 WebView 里的 drawio 画布占满，
/// 不参与文本预览管线（<see cref="UsesMermaidCliExport"/> 为 <c>false</c>，导出在页面内完成）。
/// </para>
/// </remarks>
public sealed class DrawioFormat : IDocumentFormat
{
    /// <summary>格式 id。<see cref="MainViewModel"/> 建转换目标标签页时按它查注册表，避免散落字面量。</summary>
    public const string FormatId = "drawio";

    private static IHighlightingDefinition? _highlighting;

    public string Id => FormatId;

    public string DisplayNameKey => "FormatDrawio";

    /// <summary>
    /// v1 只认领 <c>.drawio</c>（mxfile XML，纯文本，可编辑可保存）。
    /// </summary>
    /// <remarks>
    /// <c>.drawio.svg</c> / <c>.drawio.png</c>（XML 内嵌进 SVG/PNG 的复合形态）暂不认领：
    /// 前者要按 SVG 形态走 <c>descriptor</c> 载入、后者是**二进制**，而当前文档模型与
    /// <c>FileService</c> 都是纯文本读写 —— 认领了却打不开比不认领更糟。等有实测跑通的
    /// 载入/保存路径再逐条加进来（方案 §8.4.4 的对应验收项仍待补）。
    /// </remarks>
    public IReadOnlyList<string> Extensions => [".drawio"];

    public string DefaultFileNameKey => "UntitledDrawioFileName";

    /// <summary>服务端白名单里的取值（《Diagramon 服务端方案》§6 第 7 条）。</summary>
    public IReadOnlyList<string> CloudFormatIds => ["drawio"];

    public DocumentSurfaceKind Surface => DocumentSurfaceKind.EmbeddedApp;

    /// <summary>
    /// drawio 不接 AI 助手：它是图形编辑器，画布上的模型不是文本 DSL，
    /// 让模型直接产 mxGraph XML 既不可靠也不可读（方案 §12.2 的"高难档"定位）。
    /// </summary>
    public bool SupportsAiAssistant => false;

    public IDocumentRenderer Renderer => NoPreviewRenderer.Instance;

    /// <summary>drawio 自己带布局（层级/树/有机），不走我们的布局选择器。</summary>
    public IReadOnlyList<LayoutOption> LayoutOptions => [];

    /// <summary>XML 高亮：AvaloniaEdit 自带定义，不必再写一份 XSHD。</summary>
    public IHighlightingDefinition? Highlighting => _highlighting ??= HighlightingManager.Instance.GetDefinition("XML");

    public bool UsesMermaidCliExport => false;

    /// <summary>drawio 自己就是转换目标，不参与转换。</summary>
    public bool SupportsGraphImport => false;

    public string CreateDefaultContent() => DefaultContent;

    /// <summary>一个空的单页 drawio 文档（drawio 自己新建文档时产出的同构结构）。</summary>
    internal const string DefaultContent = """
<mxfile host="Diagramon" version="24.0.0"><diagram id="page-1" name="Page-1"><mxGraphModel dx="800" dy="600" grid="1" gridSize="10" guides="1" tooltips="1" connect="1" arrows="1" fold="1" page="1" pageScale="1" pageWidth="850" pageHeight="1100" math="0" shadow="0"><root><mxCell id="0"/><mxCell id="1" parent="0"/></root></mxGraphModel></diagram></mxfile>
""";
}
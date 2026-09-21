using System.Collections.Generic;
using Diagramon.Services.Documents;

namespace Diagramon.Services.Documents.Renderers;

/// <summary>
/// 不走预览路径的渲染器（方案 §4.1.1 的 <see cref="RendererProvision.None"/>）：
/// drawio 由独立的 WebView 承载（<c>EmbeddedApp</c> 表面），与文本预览无关。
/// </summary>
/// <remarks>
/// 这些成员都返回中性值而不是抛异常：它们只会在"格式声明了 EmbeddedApp，但调用方误按预览路径调度"
/// 时被碰到，那种情况下返回空页面比抛异常更安全（界面表现为空白而非崩溃）。分派本身由
/// <c>IDocumentFormat.Surface</c> 挡住，见 <c>MainViewModel</c> 的渲染入口。
/// </remarks>
public sealed class NoPreviewRenderer : IDocumentRenderer
{
    public static readonly NoPreviewRenderer Instance = new();

    public RendererProvision Provision => RendererProvision.None;

    public IReadOnlyList<RendererAsset> Assets => [];

    public string? OriginAssetsDirectory => null;

    public string BuildSurfaceHtml(string source, RenderOptions options) => string.Empty;

    public string BuildReadyProbeScript() => "true";

    public string BuildUpdateScript(string source, RenderOptions options) => string.Empty;

    public string? BuildExportScript(string source, RenderOptions options) => null;
}
using System.Collections.Generic;
using System.Text.Json;
using Diagramon.Services.Documents;

namespace Diagramon.Services.Documents.Renderers;

/// <summary>
/// Mermaid 预览渲染器：自包含 HTML + 随包的 <c>mermaid.min.js</c>，走 <c>file://</c>（方案 §4.1.1）。
/// </summary>
/// <remarks>
/// 页面是**原样搬迁**的：改造前它是 <c>MainViewModel.BuildPreviewHtml</c> 里的一段方法级常量，
/// 搬迁的目的是把"预览渲染不可替换"这个硬编码拆掉，行为必须逐字符保持不变。
/// 导出仍走 <c>mmdc</c> 子进程（决策 3：本期不动 Node / mmdc），所以这里不提供页面内导出。
/// </remarks>
public sealed class MermaidBundledJsRenderer : IDocumentRenderer
{
    public RendererProvision Provision => RendererProvision.BundledJs;

    public IReadOnlyList<RendererAsset> Assets =>
    [
        new RendererAsset("mermaid.min.js", "avares://Diagramon/Assets/mermaid.min.js"),
        new RendererAsset("preview-viewer.js", "avares://Diagramon/Assets/preview-viewer.js"),
    ];

    public string? OriginAssetsDirectory => null;

    public string BuildSurfaceHtml(string source, RenderOptions options)
    {
        var mermaidCodeJson = JsonSerializer.Serialize(source ?? string.Empty);
        return $$"""
<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <style>
    html, body {
      margin: 0;
      padding: 0;
      width: 100%;
      height: 100%;
      background: #fff;
      overflow: hidden;
      font-family: "Segoe UI", "Microsoft YaHei", sans-serif;
    }
    #root {
      width: 100%;
      height: 100%;
      display: flex;
      align-items: center;
      justify-content: center;
      overflow: hidden;
      box-sizing: border-box;
      cursor: grab;
      touch-action: none;
      user-select: none;
      background: #fff;
    }
    #diagram svg {
      display: block;
    }
    .error {
      color: #b42318;
      background: #fef3f2;
      border: 1px solid #fecdca;
      border-radius: 8px;
      padding: 12px;
      white-space: pre-wrap;
      max-width: 100%;
    }
  </style>
</head>
<body>
  <div id="root"><div id="diagram"></div></div>
  <script src="./preview-viewer.js"></script>
  <script src="./mermaid.min.js"></script>
  <script>
    const root = document.getElementById('root');
    const target = document.getElementById('diagram');
    // 视口手势（滚轮=平移、Ctrl+滚轮=缩放、拖拽=平移、双击=适应）由共享脚本提供，
    // 与 DOT 页、两个内嵌画布保持同一套手感。
    const viewport = window.PreviewViewport.attach(root, target);
    const fitToViewport = () => viewport.fit();

    // 渲染报错的**页面级约定**（V2-8，方案 §6.10）：与 window.__export 同一套路 ——
    // 承载层轮询这个变量取值。三态：undefined = 渲染中，null = 成功，字符串 = 报错原文。
    // 之所以要有"渲染中"这一态：只靠"有没有值"分不清"还没渲染完"和"渲染好了"。
    function setDiagramError(value) {
      window.__diagramError = value;
    }

    function showError(message) {
      const safeMessage = String(message ?? '').replace(/[<>&]/g, s => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[s]));
      target.innerHTML = `<pre class="error">${safeMessage}</pre>`;
      setDiagramError(safeMessage);
    }

    async function renderDiagram(code) {
      setDiagramError(undefined);
      try {
        if (!code || !code.trim()) {
          target.innerHTML = '';
          setDiagramError(null);
          return;
        }
        if (!window.mermaid) {
          showError('mermaid.js 暂未加载，请稍候');
          return;
        }
        mermaid.initialize({ startOnLoad: false, securityLevel: 'loose', theme: 'default' });
        const id = `mermaid-${Date.now()}`;
        const container = document.createElement('div');
        container.style.position = 'absolute';
        container.style.top = '-9999px';
        container.style.left = '-9999px';
        document.body.appendChild(container);
        const { svg } = await mermaid.render(id, code, container);
        target.innerHTML = svg;
        container.remove();
        setDiagramError(null);
        requestAnimationFrame(() => fitToViewport());
      } catch (err) {
        showError(err && err.message ? err.message : err);
      }
    }

    renderDiagram({{mermaidCodeJson}});
  </script>
</body>
</html>
""";
    }

    public string BuildReadyProbeScript()
    {
        return "typeof window.mermaid !== 'undefined' && typeof window.renderDiagram === 'function'";
    }

    public string BuildUpdateScript(string source, RenderOptions options)
    {
        return $"renderDiagram({JsonSerializer.Serialize(source ?? string.Empty)})";
    }

    public string? BuildExportScript(string source, RenderOptions options) => null;
}
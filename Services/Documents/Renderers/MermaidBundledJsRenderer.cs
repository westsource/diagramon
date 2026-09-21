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
  <script src="./mermaid.min.js"></script>
  <script>
    const root = document.getElementById('root');
    const target = document.getElementById('diagram');
    let scale = 1;
    let offsetX = 0;
    let offsetY = 0;
    let dragging = false;
    let lastX = 0;
    let lastY = 0;
    const minScale = 0.2;
    const maxScale = 30;

    function applyTransform() {
      target.style.transform = `translate(${offsetX}px, ${offsetY}px) scale(${scale})`;
      target.style.transformOrigin = 'center center';
    }

    function fitToViewport() {
      scale = 1;
      offsetX = 0;
      offsetY = 0;
      applyTransform();

      const rootRect = root.getBoundingClientRect();
      const diagramRect = target.getBoundingClientRect();
      if (rootRect.width <= 0 || rootRect.height <= 0 || diagramRect.width <= 0 || diagramRect.height <= 0) {
        return;
      }

      const padding = 24;
      const fitScaleX = Math.max(0.01, (rootRect.width - padding) / diagramRect.width);
      const fitScaleY = Math.max(0.01, (rootRect.height - padding) / diagramRect.height);
      const fitScale = Math.min(fitScaleX, fitScaleY);
      scale = Math.max(minScale, Math.min(maxScale, fitScale));
      applyTransform();
    }

    function showError(message) {
      const safeMessage = String(message ?? '').replace(/[<>&]/g, s => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[s]));
      target.innerHTML = `<pre class="error">${safeMessage}</pre>`;
    }

    async function renderDiagram(code) {
      try {
        if (!code || !code.trim()) {
          target.innerHTML = '';
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
        requestAnimationFrame(() => fitToViewport());
      } catch (err) {
        showError(err && err.message ? err.message : err);
      }
    }

    root.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      dragging = true;
      lastX = e.clientX;
      lastY = e.clientY;
      root.style.cursor = 'grabbing';
      root.setPointerCapture(e.pointerId);
    });

    root.addEventListener('pointermove', (e) => {
      if (!dragging) return;
      const dx = e.clientX - lastX;
      const dy = e.clientY - lastY;
      lastX = e.clientX;
      lastY = e.clientY;
      offsetX += dx;
      offsetY += dy;
      applyTransform();
    });

    root.addEventListener('pointerup', (e) => {
      dragging = false;
      root.style.cursor = 'grab';
      if (root.hasPointerCapture(e.pointerId)) {
        root.releasePointerCapture(e.pointerId);
      }
    });

    root.addEventListener('wheel', (e) => {
      e.preventDefault();
      const oldScale = scale;
      const zoomStep = e.deltaY < 0 ? 1.1 : 0.9;
      scale = Math.max(minScale, Math.min(maxScale, scale * zoomStep));
      if (Math.abs(scale - oldScale) < 1e-6) return;

      const rect = root.getBoundingClientRect();
      const cx = e.clientX - rect.left - rect.width / 2;
      const cy = e.clientY - rect.top - rect.height / 2;
      const ratio = scale / oldScale;
      offsetX -= cx * (ratio - 1);
      offsetY -= cy * (ratio - 1);
      applyTransform();
    }, { passive: false });

    root.addEventListener('dblclick', () => {
      fitToViewport();
    });

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
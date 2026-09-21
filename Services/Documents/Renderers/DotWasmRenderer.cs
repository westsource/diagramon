using System;
using System.Collections.Generic;
using System.IO;
using System.Text.Json;
using Diagramon.Services.Documents;
using Diagramon.Services.Localization;

namespace Diagramon.Services.Documents.Renderers;

/// <summary>
/// Graphviz DOT 渲染器：页面内加载 <c>@hpcc-js/wasm-graphviz</c>（Graphviz 16.1.0 编进 WASM），
/// 六个布局引擎由 <see cref="RenderOptions.Layout"/> 驱动（方案 §8.3.2）。
/// </summary>
/// <remarks>
/// <para>
/// <b>必须走真实 origin</b>：该渲染器是单文件 ES module，<c>file://</c> 下 Chromium 会拦截
/// module 请求（实测 <c>Failed to fetch dynamically imported module</c>）。因此页面由
/// <c>PreviewSurfaceHost</c> 通过 loopback 提供，渲染器资源挂在 <c>/renderer/</c> 前缀下。
/// </para>
/// <para>
/// <b>切换布局不得重建页面</b>：WASM 在页面里只 <c>load()</c> 一次，布局切换与内容变化都走
/// <see cref="BuildUpdateScript"/> 的增量路径，否则每次输入都要重载 WASM。
/// </para>
/// </remarks>
public sealed class DotWasmRenderer : IDocumentRenderer
{
    /// <summary>默认布局引擎；<see cref="RenderOptions.Layout"/> 为空时用它。</summary>
    public const string DefaultLayout = "dot";

    private static readonly Strings S = Strings.Instance;

    public RendererProvision Provision => RendererProvision.NpmWasm;

    public IReadOnlyList<RendererAsset> Assets => [];

    /// <summary><c>tools/graphviz</c>（由 <c>tools/fetch-graphviz.ps1</c> 拉取）；缺失时返回 <c>null</c>。</summary>
    public string? OriginAssetsDirectory => AppPaths.FindToolsDirectory("graphviz");

    public string BuildSurfaceHtml(string source, RenderOptions options)
    {
        if (!string.IsNullOrEmpty(OriginAssetsDirectory) &&
            !File.Exists(Path.Combine(OriginAssetsDirectory, "graphviz.js")))
        {
            return BuildMissingRendererHtml();
        }

        var sourceJson = JsonSerializer.Serialize(source ?? string.Empty);
        var engineJson = JsonSerializer.Serialize(NormalizeLayout(options.Layout));

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
  <script type="module">
    import { Graphviz } from '/renderer/graphviz.js';

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

    let graphvizPromise = null;

    function ensureGraphviz() {
      if (!graphvizPromise) {
        graphvizPromise = Graphviz.load();
      }
      return graphvizPromise;
    }

    function applyTransform() {
      target.style.transform = `translate(${offsetX}px, ${offsetY}px) scale(${scale})`;
      target.style.transformOrigin = 'center center';
      // 承载层靠轮询全局 scale 显示缩放百分比；module 作用域里的 let 不是全局，必须显式镜像
      window.scale = scale;
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

    async function renderDiagram(code, engine) {
      try {
        if (!code || !code.trim()) {
          target.innerHTML = '';
          return;
        }
        const graphviz = await ensureGraphviz();
        target.innerHTML = graphviz.layout(code, 'svg_inline', engine || 'dot');
        requestAnimationFrame(() => fitToViewport());
      } catch (err) {
        showError(err && err.message ? err.message : err);
      }
    }

    async function renderPng(code, engine, exportScale, transparent) {
      const graphviz = await ensureGraphviz();
      let svg = graphviz.layout(code, 'svg', engine || 'dot');
      if (transparent) {
        // Graphviz 会自绘一块白色背景多边形（fill="white" stroke="none"）。
        // 这是对渲染器输出的**唯一**后处理：目的是与 Mermaid 的 mmdc 导出（-b transparent）保持一致，
        // 否则同一个应用里"复制图片"出来的底一个透明、一个白底。
        svg = svg.replace(/<polygon fill="white" stroke="none"[^>]*\/>/, '');
      }
      const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml;charset=utf-8' }));
      try {
        const img = new Image();
        await new Promise((resolve, reject) => {
          img.onload = resolve;
          img.onerror = () => reject(new Error('SVG 栅格化失败'));
          img.src = url;
        });
        const width = Math.max(1, Math.round(img.naturalWidth * exportScale));
        const height = Math.max(1, Math.round(img.naturalHeight * exportScale));
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        canvas.getContext('2d').drawImage(img, 0, 0, width, height);
        return { dataUrl: canvas.toDataURL('image/png'), width, height };
      } finally {
        URL.revokeObjectURL(url);
      }
    }

    window.renderDiagram = renderDiagram;
    window.renderPng = renderPng;

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

    renderDiagram({{sourceJson}}, {{engineJson}});
  </script>
</body>
</html>
""";
    }

    public string BuildReadyProbeScript()
    {
        return "typeof window.renderDiagram === 'function' && typeof window.renderPng === 'function'";
    }

    public string BuildUpdateScript(string source, RenderOptions options)
    {
        var sourceJson = JsonSerializer.Serialize(source ?? string.Empty);
        var engineJson = JsonSerializer.Serialize(NormalizeLayout(options.Layout));
        return $"window.renderDiagram({sourceJson}, {engineJson})";
    }

    public string? BuildExportScript(string source, RenderOptions options)
    {
        var sourceJson = JsonSerializer.Serialize(source ?? string.Empty);
        var engineJson = JsonSerializer.Serialize(NormalizeLayout(options.Layout));
        var scaleJson = JsonSerializer.Serialize(Math.Clamp(options.Scale, 0.1, 20.0));
        var transparentJson = JsonSerializer.Serialize(options.Transparent);

        // 自带"等渲染器就绪"的循环：脚本可能在页面模块尚未执行完时被注入，
        // 那时直接调用 window.renderPng 会抛 ReferenceError。
        // 整段用一个 IIFE 表达式包住：承载层是按"表达式"执行的，多条语句会被判成语法错误。
        return $$"""
(() => {
  window.__export = null;
  (async () => {
    try {
      for (let i = 0; i < 200 && (!window.renderPng); i++) {
        await new Promise(r => setTimeout(r, 50));
      }
      if (!window.renderPng) {
        throw new Error('渲染器尚未就绪');
      }
      const result = await window.renderPng({{sourceJson}}, {{engineJson}}, {{scaleJson}}, {{transparentJson}});
      window.__export = { ok: true, dataUri: result.dataUrl, width: result.width, height: result.height };
    } catch (err) {
      window.__export = { ok: false, error: String((err && err.message) || err) };
    }
  })();
  return true;
})()
""";
    }

    /// <summary>把未知/空的布局取值收敛到默认引擎，避免把无效值传给 Graphviz。</summary>
    private static string NormalizeLayout(string? layout)
    {
        return string.IsNullOrWhiteSpace(layout) ? DefaultLayout : layout;
    }

    private static string BuildMissingRendererHtml()
    {
        var escaped = System.Net.WebUtility.HtmlEncode(S.Get("DotRendererMissing"));
        return $$"""
<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <style>
    html, body { margin: 0; background: #fff; font-family: "Segoe UI", "Microsoft YaHei", sans-serif; }
    .error {
      color: #b42318;
      background: #fef3f2;
      border: 1px solid #fecdca;
      border-radius: 8px;
      margin: 16px;
      padding: 12px;
      white-space: pre-wrap;
    }
  </style>
</head>
<body>
  <pre class="error">{{escaped}}</pre>
</body>
</html>
""";
    }
}
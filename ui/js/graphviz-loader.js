/* graphviz 预载（原先是 ui/index.html 里的内联 module 脚本，为 CSP 挪到外部文件：
 * `script-src 'self'` 不放行内联脚本，见 index.html 头部的 CSP meta）。
 *
 * graphviz 是 ESM：file:// 下浏览器的模块加载被 CORS 拦截（origin null），
 * 只有 Tauri 自定义协议 / http(s) 里才可用。失败时降级为「不可用」，不阻断整页。
 */
window.DGMGraphvizReady = (async () => {
  try {
    const mod = await import("./vendor/graphviz.js");
    const g = await mod.Graphviz.load();
    window.DGMGraphviz = g;
    return g;
  } catch (e) {
    window.DGMGraphvizError = (e && e.message) || String(e);
    console.warn("[DGM] graphviz 加载失败（DOT 预览不可用）：", window.DGMGraphvizError);
    return null;
  }
})();

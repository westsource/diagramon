/* graphviz 预载（原先是 ui/index.html 里的内联 module 脚本，为 CSP 挪到外部文件：
 * `script-src 'self'` 不放行内联脚本，见 index.html 头部的 CSP meta）。
 *
 * ⚠️ **`import()` 里的相对说明符按「本文件的 URL」解析，不按文档**（这条规则只在内联
 * module 脚本里才恰好等于文档 URL）。外置之后 `./vendor/graphviz.js` 会打到 `/js/vendor/…`，
 * 那不存在 ⇒ 动态导入 404 ⇒ DOT 预览整片死掉，而报错文案还错怪 file://（3.5.2–3.6.0 的实况）。
 * 用 `import.meta.url` 拼绝对 URL，读的人不必记得这条规则。
 *
 * graphviz 是 ESM：file:// 下浏览器的模块加载被 CORS 拦截（origin null），
 * 只有 Tauri 自定义协议 / http(s) 里才可用。失败时降级为「不可用」，不阻断整页 ——
 * 但要走 console.error：漏加载会让 DOT 预览静默变砖，探针只把 console.error 当失败。
 */
window.DGMGraphvizReady = (async () => {
  try {
    const mod = await import(new URL("../vendor/graphviz.js", import.meta.url).href);
    const g = await mod.Graphviz.load();
    window.DGMGraphviz = g;
    return g;
  } catch (e) {
    window.DGMGraphvizError = (e && e.message) || String(e);
    console.error("[DGM] graphviz 加载失败（DOT 预览不可用）：", window.DGMGraphvizError);
    return null;
  }
})();

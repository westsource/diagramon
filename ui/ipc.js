// 与 Rust 侧通信的薄封装，以及占据 `dgm` origin 的共享命名空间 `DGM`。
//
// 所有模块都挂在 `window.DGM` 下（顺序由 index.html 的 script 标签保证），
// 避免引入打包器就能分文件维护。

window.DGM = window.DGM || {};

/** 调用 Tauri 命令（等价于 `invoke`）。 */
DGM.invoke = (cmd, args) => window.__TAURI__.core.invoke(cmd, args);

/** 剪贴板插件（`plugin:clipboard-manager`）。 */
DGM.clipboard = (window.__TAURI__ && window.__TAURI__.clipboardManager) || null;

/** dataURL → Uint8Array（剪贴板图片以原始字节写入）。 */
DGM.dataUrlToBytes = (dataUrl) => {
  const comma = dataUrl.indexOf(",");
  const binary = atob(dataUrl.slice(comma + 1));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
};

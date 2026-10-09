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

/**
 * 把 PNG data URL 写到系统剪贴板。
 * Windows 上剪贴板可能被其它进程短暂占用（"clipboard is not accessible"），
 * 属可恢复竞态，因此做有界重试；重试仍失败则抛出最后一个错误。
 */
DGM.copyImageDataUrl = async (dataUrl) => {
  if (!DGM.clipboard) throw new Error("剪贴板插件不可用");
  const bytes = DGM.dataUrlToBytes(dataUrl);
  let lastErr = null;
  for (let attempt = 0; attempt < 6; attempt += 1) {
    try {
      await DGM.clipboard.writeImage(bytes);
      return;
    } catch (e) {
      lastErr = e;
      await new Promise((r) => setTimeout(r, 150));
    }
  }
  throw lastErr || new Error("复制图片失败");
};

/* 平台标记（只影响样式，不参与功能判断）。
 *
 * macOS 桌面版把窗口按钮交给系统原生交通灯（见 src-tauri/src/lib.rs 的
 * TitleBarStyle::Overlay），自绘的 .win-btns 必须隐藏并给左侧留出位置。
 * 必须在 <head> 里同步执行，否则会先闪一帧 Windows 风格按钮。
 *
 * 只标记真正的 Tauri 桌面运行时：同一个 ui/ 也会被在线版（普通浏览器）加载，
 * 不能因为访客用 Mac 就把网页版的窗口按钮藏掉。判据二选一：
 *   - 桌面版页面由自定义协议加载（macOS/Linux 是 dgm://localhost/）；
 *   - withGlobalTauri 注入的 window.__TAURI__ 已就绪。
 */
(function () {
  "use strict";

  function mark() {
    var ua = navigator.userAgent || "";
    var desktop = location.protocol === "dgm:" || !!window.__TAURI__;
    if (!desktop || !/Macintosh|Mac OS X/.test(ua)) return;
    document.documentElement.dataset.platform = "macos";
  }

  mark();
  // 全局对象若晚于本脚本注入，DOM 就绪后再补一次（正常路径上面已经命中）。
  if (!document.documentElement.dataset.platform) {
    document.addEventListener("DOMContentLoaded", mark, { once: true });
  }
})();

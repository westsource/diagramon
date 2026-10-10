/* 截屏框选 overlay（vision_capture_start 开出的那个窗口）。
 *
 * 关键点只有一个：**在图上量，不在屏幕上量**。
 * 冻结帧是物理像素（比如 2560×1440），overlay 窗口是逻辑像素（比如 1707×960），
 * 两者之间差一个 scale。拖出的矩形先按 CSS 像素量好，再乘
 * `img.naturalWidth / img.clientWidth` 换回物理像素 —— 这一乘把 DPI、
 * 缩放、多屏偏移全都消掉了，Rust 侧拿到的就是原图坐标，直接裁。
 *
 * 自检里等不了这个窗口（它要人来拖），所以它的正确性靠两件事兜底：
 *   - Rust 侧对越界/反常矩形做夹取（vision.rs 的 crop_image 有单测）；
 *   - 这里对"太小"的框不做任何事，而不是发一个 1×1 的裁剪过去。
 */
window.DGM = window.DGM || {};
(function () {
  "use strict";

  const T = window.__TAURI__;
  const invoke = (T && T.core && T.core.invoke) || (T && T.invoke);
  if (!invoke) {
    document.body.textContent = "no tauri runtime";
    return;
  }

  const img = document.getElementById("shot");
  const sel = document.getElementById("sel");
  const size = document.getElementById("size");
  const bar = document.getElementById("bar");
  const err = document.getElementById("err");
  if (!img || !sel) return;

  /* i18n：capture 页只有几个词，但规矩一样 —— 不散落硬编码 */
  DGM.i18n.setLang(DGM.i18n.detect(), { persist: false });
  DGM.i18n.apply();
  document.title = DGM.t("cap.title");

  let scale = 1;
  let dragging = false;
  let start = null;
  let done = false;

  function recompute() {
    const cssW = img.clientWidth || 1;
    scale = (img.naturalWidth || cssW) / cssW;
  }
  img.addEventListener("load", recompute);
  addEventListener("resize", recompute);

  function fail(msg) {
    err.textContent = msg;
    err.style.display = "block";
    setTimeout(() => (err.style.display = "none"), 4000);
  }

  function show(r) {
    sel.style.display = "block";
    sel.style.left = r.x + "px";
    sel.style.top = r.y + "px";
    sel.style.width = r.w + "px";
    sel.style.height = r.h + "px";
    size.textContent = Math.round(r.w * scale) + " × " + Math.round(r.h * scale);
  }

  function norm(a, b) {
    return {
      x: Math.min(a.x, b.x),
      y: Math.min(a.y, b.y),
      w: Math.abs(a.x - b.x),
      h: Math.abs(a.y - b.y),
    };
  }

  function finish(r) {
    if (done) return;
    done = true;
    const rect = {
      x: Math.round(r.x * scale),
      y: Math.round(r.y * scale),
      w: Math.max(1, Math.round(r.w * scale)),
      h: Math.max(1, Math.round(r.h * scale)),
    };
    invoke("vision_crop", { rect }).catch((e) => {
      done = false;
      fail(String((e && e.message) || e));
    });
  }

  addEventListener("mousedown", (e) => {
    if (e.button !== 0) return;
    if (e.target.closest("#bar")) return; // 工具条上的点击不算起笔
    dragging = true;
    start = { x: e.clientX, y: e.clientY };
    show(norm(start, start));
  });

  addEventListener("mousemove", (e) => {
    if (!dragging) return;
    show(norm(start, { x: e.clientX, y: e.clientY }));
  });

  addEventListener("mouseup", (e) => {
    if (!dragging) return;
    dragging = false;
    const r = norm(start, { x: e.clientX, y: e.clientY });
    // 太小多半是误触：收起来，不发给 Rust
    if (r.w * scale < 8 || r.h * scale < 8) {
      sel.style.display = "none";
      return;
    }
    show(r);
    finish(r);
  });

  addEventListener("dblclick", () => {
    finish({ x: 0, y: 0, w: img.clientWidth, h: img.clientHeight });
  });

  addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      e.preventDefault();
      cancel();
    } else if (e.key === "Enter") {
      e.preventDefault();
      finish({ x: 0, y: 0, w: img.clientWidth, h: img.clientHeight });
    }
  });

  function cancel() {
    if (done) return;
    done = true;
    invoke("vision_cancel").catch(() => {});
  }

  document.getElementById("all").addEventListener("click", () => {
    finish({ x: 0, y: 0, w: img.clientWidth, h: img.clientHeight });
  });
  document.getElementById("cancel").addEventListener("click", cancel);

  /* 起手：把冻结帧要过来铺上 */
  (async () => {
    try {
      const frame = await invoke("vision_frame");
      if (!frame || !frame.data_url) return fail(DGM.t("cap.noFrame"));
      img.src = frame.data_url;
      recompute();
    } catch (e) {
      fail(String((e && e.message) || e));
    }
  })();
})();

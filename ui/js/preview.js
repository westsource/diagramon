/* 预览面：mermaid / graphviz 页内真渲染 + 画布手势 + 位图导出。
 *
 * - 文本型（Mermaid / DOT）：先 parse 校验再 render，报错解析出行号，不留在页面上
 *   半渲染的残迹。DOT 走 vendor 里的 graphviz（ESM，加载失败时显式提示）。
 * - 画布型（drawio / Excalidraw）：交给 `DGM.canvas`（同源 iframe 承载面），
 *   本模块只切可见面并把工具条/缩放接到承载页的钩子上。
 * - 手势：滚轮平移 / Shift 横向 / Ctrl 以光标为中心缩放 / 拖拽 / 双击适应视图。
 * - 动态尺寸只经 CSS 自定义属性（--pan-x/--pan-y/--zoom）。
 */
window.DGM = window.DGM || {};
(function () {
  "use strict";

  const state = DGM.state;
  const t = (k, v) => DGM.i18n.t(k, v);
  const icon = DGM.icon;
  const { $, h, esc } = DGM.dom;

  const MIN_SCALE = 0.2;
  const MAX_SCALE = 30;

  let stage = null;
  let viewport = null;
  let lastSvg = ""; // 最近一次渲染出的 SVG 文本（导出用）
  let lastFormat = null;
  let renderToken = 0;
  let renderTimer = 0;

  const view = {
    scale: 1,
    x: 0,
    y: 0,
  };

  function nodes() {
    stage = stage || $("#canvas-stage");
    viewport = viewport || $("#canvas-viewport");
    return { stage, viewport };
  }

  function clamp(v, lo, hi) {
    return Math.max(lo, Math.min(v, hi));
  }

  function apply() {
    const { stage } = nodes();
    if (!stage) return;
    stage.style.setProperty("--pan-x", view.x + "px");
    stage.style.setProperty("--pan-y", view.y + "px");
    stage.style.setProperty("--zoom", String(view.scale));
    const val = $("#zoom-val");
    if (val) val.textContent = Math.round(view.scale * 100) + "%";
    state.ui.zoom = view.scale;
    if (DGM.shell && DGM.shell.renderStatus) DGM.shell.renderStatus();
  }

  function setPannable(on) {
    const { stage, viewport } = nodes();
    if (!stage || !viewport) return;
    stage.classList.toggle("pannable", !!on);
    viewport.classList.toggle("is-pannable", !!on);
    viewport.classList.toggle("no-pan", !on);
  }

  function resetView() {
    view.scale = 1;
    view.x = 0;
    view.y = 0;
    apply();
  }

  function contentSize() {
    const { stage } = nodes();
    const el = stage && stage.firstElementChild;
    if (!el) return null;
    if (el.tagName && el.tagName.toLowerCase() === "svg") {
      const s = svgSize(el);
      if (s.w && s.h) return s;
    }
    const w = el.scrollWidth || el.offsetWidth;
    const h = el.scrollHeight || el.offsetHeight;
    return w && h ? { w, h } : null;
  }

  function fit() {
    // 画布型：缩放归承载页管（它暴露 __hostFit，用的是 drawio 自己的 Fit Page）
    if (canvasMode) {
      DGM.canvas.hostFit(lastFormat);
      return;
    }
    const { viewport } = nodes();
    if (!viewport) return;
    const size = contentSize();
    if (!size) return;
    const rect = viewport.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    const pad = 36;
    const s = clamp(Math.min((rect.width - pad) / size.w, (rect.height - pad) / size.h), MIN_SCALE, MAX_SCALE);
    view.scale = s;
    view.x = (rect.width - size.w * s) / 2;
    view.y = (rect.height - size.h * s) / 2;
    apply();
  }

  function zoomBy(factor, origin) {
    if (canvasMode) {
      DGM.canvas.hostZoomBy(lastFormat, factor);
      return;
    }
    const { viewport } = nodes();
    if (!viewport) return;
    const rect = viewport.getBoundingClientRect();
    const cx = origin ? origin.x - rect.left : rect.width / 2;
    const cy = origin ? origin.y - rect.top : rect.height / 2;
    const next = clamp(view.scale * factor, MIN_SCALE, MAX_SCALE);
    const k = next / view.scale;
    view.x = cx - (cx - view.x) * k;
    view.y = cy - (cy - view.y) * k;
    view.scale = next;
    apply();
  }

  /* ------------------------------------------------------------------ 提示态 */

  /** 当前可见面是不是画布承载（决定缩放/导出往哪条路走）。 */
  let canvasMode = false;

  /** 从画布承载面切回页内舞台（SVG）。 */
  function exitCanvas() {
    const { stage, viewport } = nodes();
    canvasMode = false;
    if (stage) stage.hidden = false;
    if (viewport) viewport.classList.remove("is-canvas-host");
    const ct = $("#canvas-tools");
    if (ct) ct.classList.remove("is-canvas");
    if (DGM.canvas) DGM.canvas.hide();
  }

  function clearStage() {
    const { stage, viewport } = nodes();
    exitCanvas();
    if (!stage) return;
    stage.innerHTML = "";
    stage.hidden = false;
    setPannable(false);
    resetView();
    if (viewport) viewport.classList.remove("grabbing");
  }

  function showNode(node) {
    const { stage } = nodes();
    if (!stage) return;
    stage.innerHTML = "";
    stage.appendChild(node);
    setPannable(false);
    resetView();
  }

  function note(text) {
    lastSvg = "";
    showNode(h("div", "preview-note", esc(text)));
  }

  function errorBox(text) {
    lastSvg = "";
    showNode(h("div", "preview-error", esc(text)));
  }

  function showLoading() {
    showNode(h("div", "preview-loading", `${icon("refresh", "ico-sm")}<span>${esc(t("preview.rendering"))}</span>`));
  }

  /* ------------------------------------------------------------------ 报错解析 */

  function describeError(raw) {
    const text = String(raw == null ? "" : raw);
    const m = /(?:on\s+)?line[ :]+(\d+)/i.exec(text);
    const line = m ? Number(m[1]) : 0;
    const first = text.split("\n").map((s) => s.trim()).find((s) => s.length) || text;
    return line ? { line, text: t("preview.noRender", { msg: t("common.line") + " " + line + "：" + first }) } : { line: 0, text: first };
  }

  /* ------------------------------------------------------------------ 尺寸 / 归一化 */

  function svgSize(svg) {
    const vb = svg.getAttribute("viewBox");
    if (vb) {
      const p = vb.trim().split(/[\s,]+/).map(Number);
      if (p.length === 4 && p[2] > 0 && p[3] > 0) return { w: p[2], h: p[3] };
    }
    const px = (v) => {
      const n = parseFloat(v);
      return Number.isFinite(n) && n > 0 ? n : 0;
    };
    return { w: px(svg.getAttribute("width")) || 300, h: px(svg.getAttribute("height")) || 150 };
  }

  /** 把渲染出来的 <svg> 钉到固有像素尺寸：不同引擎的 width="100%" 会撑坏平移缩放。 */
  function normalizeSvg(svg) {
    const { w, h } = svgSize(svg);
    svg.setAttribute("width", String(w));
    svg.setAttribute("height", String(h));
    svg.style.width = w + "px";
    svg.style.height = h + "px";
    svg.style.maxWidth = "none";
    svg.style.display = "block";
  }

  /* ------------------------------------------------------------------ 渲染入口 */

  function schedule() {
    clearTimeout(renderTimer);
    renderTimer = setTimeout(renderActive, 60);
  }

  /** 预览阈值（app_info.limits），取不到就退成一个很大的数（等于不设防 —— 但不会崩） */
  function L() {
    const l = state.appInfo && state.appInfo.limits;
    return {
      preview_max_lines: (l && l.preview_max_lines) || Number.MAX_SAFE_INTEGER,
      preview_max_bytes: (l && l.preview_max_bytes) || Number.MAX_SAFE_INTEGER,
    };
  }

  function overLimit(body) {
    const lim = L();
    if (lim.preview_max_lines === Number.MAX_SAFE_INTEGER) return false;
    const lines = body.split("\n").length;
    return lines > lim.preview_max_lines || body.length > lim.preview_max_bytes;
  }

  /** 用户点过"仍要渲染"之后，本次会话对这个文档放行 */
  let forceRender = false;

  async function renderActive() {
    nodes();
    const d = state.activeDoc();
    if (!d) {
      lastFormat = null;
      clearStage();
      const { stage } = nodes();
      if (stage) stage.innerHTML = "";
      setSub("");
      toolsVisible(false);
      return;
    }
    const fmt = state.docFmt(d);
    lastFormat = d.format;

    if (state.isCanvasDoc(d)) {
      renderCanvas(d, fmt);
      return;
    }

    exitCanvas();
    setSub(t("preview.remoteOff"));
    const body = d.body || "";
    if (!body.trim()) {
      toolsVisible(false);
      note(t("preview.empty"));
      return;
    }

    // 大文档护栏：先问一句，而不是默默把 WASM 引擎拖死（决定权在用户，代价要说清）。
    // 阈值来自 app_info.limits（唯一真源在 app-core::guard），前端只比数字、不藏第二份。
    if (!forceRender && overLimit(body)) {
      const lines = body.split("\n").length;
      const kb = Math.round(body.length / 1024);
      const why = lines > L().preview_max_lines
        ? t("preview.guard.tooManyLines", { n: lines, max: L().preview_max_lines })
        : t("preview.guard.tooBig", { n: kb, max: Math.round(L().preview_max_bytes / 1024) });
      const node = h("div", "preview-note pv-guard");
      node.innerHTML =
        `<span>${esc(t("preview.guard.title"))}<br><small>${esc(why)}</small></span>` +
        `<button class="mini-btn" id="pv-guard-go">${esc(t("preview.guard.go"))}</button>`;
      lastSvg = "";
      showNode(node);
      toolsVisible(false);
      const go = $("#pv-guard-go");
      if (go) {
        go.addEventListener("click", () => {
          forceRender = true;
          renderActive().finally(() => { forceRender = false; });
        });
      }
      return;
    }

    const mine = ++renderToken;
    showLoading();
    toolsVisible(false);
    try {
      let svgText;
      if (d.format === "mermaid") {
        svgText = await renderMermaid(body, mine);
      } else if (d.format === "dot") {
        svgText = await renderDot(body, d.layout || "dot");
      } else {
        throw new Error(t("preview.noRender", { msg: d.format }));
      }
      if (mine !== renderToken) return;
      mountSvg(svgText, d);
    } catch (err) {
      if (mine !== renderToken) return;
      const described = describeError(err && err.message ? err.message : err);
      errorBox(described.text);
      toolsVisible(false);
      if (DGM.status) DGM.status(described.text, "err");
      if (described.line) {
        state.refreshIssues(d.id);
      }
    }
  }

  async function renderMermaid(body, mine) {
    if (typeof window.mermaid === "undefined") throw new Error(t("preview.mermaidUnavailable"));
    const dark = document.documentElement.dataset.theme === "dark";
    window.mermaid.initialize({ startOnLoad: false, securityLevel: "strict", theme: dark ? "dark" : "default" });
    if (typeof window.mermaid.parse === "function") await window.mermaid.parse(body);
    const out = await window.mermaid.render(`dgm-${mine}`, body);
    return out.svg;
  }

  async function renderDot(body, engine) {
    if (!window.DGMGraphviz) {
      if (window.DGMGraphvizReady) {
        try {
          await window.DGMGraphvizReady;
        } catch (e) {
          /* 落到下面的不可用提示 */
        }
      }
    }
    if (!window.DGMGraphviz) throw new Error(t("preview.graphviz.unavailable"));
    return window.DGMGraphviz.layout(body, "svg", engine, {});
  }

  function mountSvg(svgText, d) {
    const { stage } = nodes();
    if (!stage) return;
    stage.dataset.engine = d.format;
    stage.innerHTML = svgText;
    const svg = stage.querySelector("svg");
    if (svg) normalizeSvg(svg);
    lastSvg = svgText;
    setPannable(true);
    toolsVisible(true);
    if (d.format === "dot") setSub(t("preview.dot.layout", { layout: d.layout || "dot" }));
    fit();
  }

  /* ------------------------------------------------------------------ 画布型承载 */

  /**
   * 画布型格式（drawio / Excalidraw）。
   *
   * 承载面由 `DGM.canvas` 管（同源 iframe），它负责「画布 ↔ 正文」的搬运；
   * 这里只做三件事：切可见面、把工具条摆到画布该有的位置、把缩放的读数接上。
   */
  function renderCanvas(d, fmt) {
    nodes();
    const { stage, viewport } = nodes();
    const host = DGM.canvas;

    // 承载页没接上（理论上不会发生）：如实说不支持，不给一个假的编辑面
    if (!host || !host.supports(d.format) || !host.show(d)) {
      canvasMode = false;
      if (stage) stage.hidden = false;
      if (viewport) viewport.classList.remove("is-canvas-host");
      note(t("preview.canvas.noHost", { name: fmt.name, id: d.format }));
      toolsVisible(false);
      return;
    }

    canvasMode = true;
    lastFormat = d.format;
    lastSvg = "";

    // 让承载面铺满：SVG 舞台收起来，容器不再居中/滚动（画布自己管视口）
    if (stage) stage.hidden = true;
    if (viewport) viewport.classList.add("is-canvas-host");

    setSub(t("preview.canvas.sub", { name: fmt.name }));
    toolsVisible(true);
    const ct = $("#canvas-tools");
    // 画布自带工具栏，本站的浮动工具条往上让一让
    if (ct) ct.classList.add("is-canvas");
  }

  /* ------------------------------------------------------------------ 头部 / 工具 */

  function setSub(text) {
    const n = $("#preview-sub");
    if (n) n.textContent = text || "";
  }

  function toolsVisible(on) {
    const ct = $("#canvas-tools");
    if (ct) ct.hidden = !on;
    const zp = $(".zoom-pill");
    if (zp) zp.hidden = !on;
  }

  /* ------------------------------------------------------------------ 位图导出 */

  function exportScale(svg) {
    const n = svg.querySelectorAll("g.node, g.cluster").length;
    const e = svg.querySelectorAll("g.edge, .edgePath, path.flowchart-link").length;
    const total = n + e;
    if (total <= 10) return 5;
    if (total <= 30) return 4;
    if (total <= 80) return 3;
    if (total <= 200) return 2;
    return 1.5;
  }

  async function toPngDataUrl() {
    // 画布型：让承载页自己导出（drawio 的 export / Excalidraw 的 exportToBlob），
    // 本站只把 data URI 拿回来落盘
    if (canvasMode) {
      const data = await DGM.canvas.exportPng(lastFormat, 2, false);
      if (!data) throw new Error(t("exp.canvasFail"));
      return data;
    }
    if (!lastSvg) throw new Error(t("exp.noContent"));
    const doc = new DOMParser().parseFromString(lastSvg, "image/svg+xml");
    const svg = doc.documentElement;
    const { w, h } = svgSize(svg);
    const scale = exportScale(svg);
    svg.setAttribute("width", String(w));
    svg.setAttribute("height", String(h));
    const text = new XMLSerializer().serializeToString(svg);
    const url = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(text)}`;
    const img = await new Promise((resolve, reject) => {
      const node = new Image();
      node.onload = () => resolve(node);
      node.onerror = () => reject(new Error(t("exp.rasterFail")));
      node.src = url;
    });
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(w * scale));
    canvas.height = Math.max(1, Math.round(h * scale));
    const ctx = canvas.getContext("2d");
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL("image/png");
  }

  function stem() {
    const d = state.activeDoc();
    if (!d) return "diagram";
    return d.name.replace(/\.[^.]*$/, "") || "diagram";
  }

  function dataUrlToBase64(dataUrl) {
    const i = String(dataUrl).indexOf(",");
    return i >= 0 ? String(dataUrl).slice(i + 1) : String(dataUrl);
  }

  async function exportPng() {
    try {
      const dataUrl = await toPngDataUrl();
      let path = await DGM.ipc.dialog.pickSavePath({
        defaultPath: stem() + ".png",
        filters: [{ name: "PNG", extensions: ["png"] }],
      });
      if (!path) path = `E:/OpenCode/diagramon/export/${stem()}.png`; // mock / 无对话框时兜底
      await state.exportWrite(path, dataUrlToBase64(dataUrl));
      state.pushOutput(t("exp.saved", { path }), "ok");
      DGM.toast({ icon: "download", title: t("exp.png"), sub: path });
    } catch (e) {
      DGM.toast({ icon: "alert", title: t("exp.png"), sub: (e && e.message) || String(e), warn: true });
    }
  }

  async function exportSvg() {
    // 承载协议没有 SVG 导出档（drawio 只给 XML / PNG）——如实说，别假装导了个空的
    if (canvasMode) {
      DGM.toast({ icon: "alert", title: t("exp.svg"), sub: t("exp.canvasNoSvg"), warn: true });
      return;
    }
    if (!lastSvg) {
      DGM.toast({ icon: "alert", title: t("exp.svg"), sub: t("exp.noContent"), warn: true });
      return;
    }
    try {
      let path = await DGM.ipc.dialog.pickSavePath({
        defaultPath: stem() + ".svg",
        filters: [{ name: "SVG", extensions: ["svg"] }],
      });
      if (!path) path = `E:/OpenCode/diagramon/export/${stem()}.svg`;
      const b64 = btoa(unescape(encodeURIComponent(lastSvg)));
      await state.exportWrite(path, b64);
      state.pushOutput(t("exp.saved", { path }), "ok");
      DGM.toast({ icon: "download", title: t("exp.svg"), sub: path });
    } catch (e) {
      DGM.toast({ icon: "alert", title: t("exp.svg"), sub: (e && e.message) || String(e), warn: true });
    }
  }

  async function copyImage() {
    try {
      const dataUrl = await toPngDataUrl();
      const ok = await copyImageDataUrl(dataUrl);
      DGM.toast({ icon: "copy", title: t("exp.copy"), sub: ok ? "" : t("exp.copyFail") });
    } catch (e) {
      DGM.toast({ icon: "alert", title: t("exp.copy"), sub: (e && e.message) || String(e), warn: true });
    }
  }

  /**
   * 剪贴板写 PNG。
   *
   * 优先走**原生**（arboard，win32 剪贴板）：WebView2 的 `navigator.clipboard`
   * 在各版本上行为不一致，后台窗口甚至会直接拒写 —— 这条路赌不起。
   * 原生不可用（mock 模式）才落回浏览器 API，仍失败就如实返回 false。
   */
  async function copyImageDataUrl(dataUrl) {
    try {
      const ok = await DGM.ipc.invoke("clip_write_image", { base64: dataUrl });
      if (ok) return true;
    } catch (e) {
      /* mock / 命令不存在 → 落回浏览器 API */
    }
    try {
      if (navigator.clipboard && window.ClipboardItem) {
        const blob = await (await fetch(dataUrl)).blob();
        await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
        return true;
      }
    } catch (e) {
      /* 落到下面 */
    }
    return false;
  }

  /* ------------------------------------------------------------------ 手势 */

  function setupGestures() {
    const { viewport } = nodes();
    if (!viewport) return;
    viewport.addEventListener(
      "wheel",
      (e) => {
        if (!viewport.classList.contains("is-pannable")) return;
        e.preventDefault();
        if (e.ctrlKey || e.metaKey) {
          zoomBy(Math.exp(-e.deltaY * 0.0015), { x: e.clientX, y: e.clientY });
        } else if (e.shiftKey) {
          view.x -= e.deltaY;
          apply();
        } else {
          view.x -= e.deltaX;
          view.y -= e.deltaY;
          apply();
        }
      },
      { passive: false },
    );

    let drag = null;
    viewport.addEventListener("mousedown", (e) => {
      if (e.button !== 0 || !viewport.classList.contains("is-pannable")) return;
      drag = { x: e.clientX, y: e.clientY, ox: view.x, oy: view.y };
      viewport.classList.add("grabbing");
      e.preventDefault();
    });
    window.addEventListener("mousemove", (e) => {
      if (!drag) return;
      view.x = drag.ox + (e.clientX - drag.x);
      view.y = drag.oy + (e.clientY - drag.y);
      apply();
    });
    window.addEventListener("mouseup", () => {
      if (!drag) return;
      drag = null;
      viewport.classList.remove("grabbing");
    });
    viewport.addEventListener("dblclick", () => {
      if (viewport.classList.contains("is-pannable")) fit();
    });
  }

  /* ------------------------------------------------------------------ 绑定 */

  function bind() {
    const zo = $("#zoom-out");
    const zi = $("#zoom-in");
    const zf = $("#zoom-fit");
    if (zo) zo.addEventListener("click", () => zoomBy(1 / 1.2));
    if (zi) zi.addEventListener("click", () => zoomBy(1.2));
    if (zf) zf.addEventListener("click", fit);
    const bf = $("#btn-fit");
    if (bf) bf.addEventListener("click", fit);
    const bs = $("#btn-show-source");
    if (bs) bs.addEventListener("click", () => DGM.shell.setMode("source"));
    const bc = $("#btn-convert");
    if (bc) bc.addEventListener("click", () => DGM.shell.setSidebarView("convert"));
    const cp = $("#btn-copy-img");
    if (cp) cp.addEventListener("click", copyImage);
    const ex = $("#btn-export");
    if (ex) {
      ex.addEventListener("click", (e) => {
        // 同 shell.js::showPop 的约定：锚点要 stopPropagation，
        // 否则文档级"点外面就关"会在同一次点击里把刚弹出的导出菜单关掉。
        e.stopPropagation();
        const r = e.currentTarget.getBoundingClientRect();
        DGM.pop.show(
          [
            { label: t("exp.png"), icon: "download", act: "png" },
            { label: t("exp.svg"), icon: "download", act: "svg" },
            { sep: true },
            { label: t("exp.copy"), icon: "copy", act: "copy" },
          ],
          { x: r.left, y: r.bottom + 4, flip: 28 },
          (it) => {
            DGM.pop.hide();
            if (it.act === "png") exportPng();
            else if (it.act === "svg") exportSvg();
            else if (it.act === "copy") copyImage();
          },
        );
      });
    }
    setupGestures();
  }

  /* ------------------------------------------------------------------ 对外 */

  DGM.bus.on("doc:changed", schedule);
  // 主题变化要让 mermaid 重新按暗色/亮色渲染（渲染器主题不跟 CSS 变量走）
  DGM.bus.on("settings:changed", schedule);

  DGM.preview = {
    render: renderActive,
    schedule,
    fit,
    zoomIn: () => zoomBy(1.2),
    zoomOut: () => zoomBy(1 / 1.2),
    resetZoom: () => (canvasMode ? fit() : resetView()),
    hasContent: () => canvasMode || !!lastSvg,
    isCanvasFormat: () => canvasMode,
    canvasMode: () => canvasMode,
    toPngDataUrl,
    describeError,
    exportPng,
    exportSvg,
    copyImage,
    bind,
    element: { get stage() { return stage; }, get viewport() { return viewport; } },
  };
})();

/* 预览面：mermaid / graphviz 页内真渲染 + 画布手势 + 位图导出。
 *
 * - 文本型（Mermaid / DOT）：先 parse 校验再 render，报错解析出行号，不留在页面上
 *   半渲染的残迹。DOT 走 vendor 里的 graphviz（ESM，加载失败时显式提示）。
 * - 画布型（drawio / Excalidraw）：不假装能编辑，渲染「承载页已就绪」空态。
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

  function clearStage() {
    const { stage, viewport } = nodes();
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

    setSub(t("preview.remoteOff"));
    const body = d.body || "";
    if (!body.trim()) {
      toolsVisible(false);
      note(t("preview.empty"));
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

  /* ------------------------------------------------------------------ 画布型空态 */

  function renderCanvas(d, fmt) {
    nodes();
    const hostName = `tools/${d.format}-host`;
    const ext = (fmt.exts && fmt.exts[0]) || "." + d.format;
    const box = h("div", "canvas-empty");
    box.innerHTML =
      `<span class="ce-hero">${icon("hand")}</span>` +
      `<h3>${esc(t("preview.canvasReady"))}</h3>` +
      `<p>${t("preview.canvasReadyDesc", { name: esc(fmt.name), host: esc(hostName) })}</p>` +
      `<div class="ce-facts">` +
      `<span class="chip">${esc(t("preview.canvasFact.host", { host: hostName }))}</span>` +
      `<span class="chip">${esc(t("preview.canvasFact.surface"))}</span>` +
      `<span class="chip">${esc(t("preview.canvasFact.file", { ext }))}</span>` +
      `</div>`;
    lastSvg = "";
    setSub(t("status.canvasNotReady"));
    showNode(box);
    toolsVisible(false);
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

  /** 剪贴板写 PNG：优先 navigator.clipboard，失败/不支持时回退（并如实返回 false）。 */
  async function copyImageDataUrl(dataUrl) {
    try {
      if (navigator.clipboard && window.ClipboardItem) {
        const blob = await (await fetch(dataUrl)).blob();
        await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
        return true;
      }
    } catch (e) {
      /* 落回下面 */
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
    resetZoom: resetView,
    hasContent: () => !!lastSvg,
    isCanvasFormat: () => lastFormat === "drawio" || lastFormat === "excalidraw",
    toPngDataUrl,
    describeError,
    exportPng,
    exportSvg,
    copyImage,
    bind,
    element: { get stage() { return stage; }, get viewport() { return viewport; } },
  };
})();

// 预览：Mermaid / Graphviz 页内渲染、平移缩放适配、位图导出。
//
// 渲染资产走同源自定义协议（`/mermaid/mermaid.min.js`、`/graphviz/graphviz.js`）。
// 导出走 `data:` URL 栅格化（跨引擎一致；`blob:` 路会被 foreignObject 污染画布）。

(function () {
  const MIN_SCALE = 0.2; // 与既有客户端预览面一致：20%–3000%
  const MAX_SCALE = 30;

  const el = {
    scroll: document.getElementById("preview-scroll"),
    content: document.getElementById("preview-content"),
    empty: document.getElementById("preview-empty"),
    canvas: document.getElementById("preview-canvas"),
    tools: document.getElementById("preview-tools"),
  };

  const state = {
    /** 最近一次渲染出的 SVG 文本（导出用）。 */
    lastSvg: "",
    /** 最近一次渲染的标签格式（决定导出建议名与画布显隐）。 */
    lastFormat: null,
    scale: 1,
    x: 0,
    y: 0,
    onZoom: null,
    onStatus: null,
    onErrorLine: null,
  };

  let mermaidReady = false;
  let graphviz = null;

  function ensureMermaid() {
    if (mermaidReady) return true;
    if (typeof window.mermaid === "undefined") return false;
    window.mermaid.initialize({ startOnLoad: false, securityLevel: "strict" });
    mermaidReady = true;
    return true;
  }

  async function ensureGraphviz() {
    if (!graphviz) {
      const mod = await import("/graphviz/graphviz.js");
      graphviz = await mod.Graphviz.load();
    }
    return graphviz;
  }

  // ---------------------------------------------------------------- 视图变换

  const view = {
    apply() {
      el.content.style.transform = `translate(${state.x}px, ${state.y}px) scale(${state.scale})`;
      if (state.onZoom) state.onZoom(state.scale);
    },
    reset() {
      state.scale = 1;
      state.x = 0;
      state.y = 0;
      view.apply();
    },
    /** 让内容缩放到视口内并居中（"适应视图"）。 */
    fit() {
      const content = el.content.firstElementChild;
      if (!content) return;
      const rect = el.scroll.getBoundingClientRect();
      const cw = content.scrollWidth || content.getBoundingClientRect().width;
      const ch = content.scrollHeight || content.getBoundingClientRect().height;
      if (!cw || !ch || !rect.width || !rect.height) return;
      const pad = 24;
      const s = Math.min((rect.width - pad) / cw, (rect.height - pad) / ch);
      state.scale = clamp(s, MIN_SCALE, MAX_SCALE);
      state.x = (rect.width - cw * state.scale) / 2;
      state.y = (rect.height - ch * state.scale) / 2;
      view.apply();
    },
    zoomBy(factor, origin) {
      const rect = el.scroll.getBoundingClientRect();
      const cx = origin ? origin.x - rect.left : rect.width / 2;
      const cy = origin ? origin.y - rect.top : rect.height / 2;
      const next = clamp(state.scale * factor, MIN_SCALE, MAX_SCALE);
      const k = next / state.scale;
      state.x = cx - (cx - state.x) * k;
      state.y = cy - (cy - state.y) * k;
      state.scale = next;
      view.apply();
    },
  };

  const clamp = (v, lo, hi) => Math.max(lo, Math.min(v, hi));

  function setupGestures() {
    el.scroll.addEventListener(
      "wheel",
      (e) => {
        e.preventDefault();
        if (e.ctrlKey) {
          view.zoomBy(Math.exp(-e.deltaY * 0.0015), { x: e.clientX, y: e.clientY });
        } else if (e.shiftKey) {
          state.x -= e.deltaY;
          view.apply();
        } else {
          state.x -= e.deltaX;
          state.y -= e.deltaY;
          view.apply();
        }
      },
      { passive: false },
    );

    let drag = null;
    el.scroll.addEventListener("mousedown", (e) => {
      if (e.button !== 0) return;
      drag = { x: e.clientX, y: e.clientY, ox: state.x, oy: state.y };
      el.scroll.classList.add("grabbing");
    });
    window.addEventListener("mousemove", (e) => {
      if (!drag) return;
      state.x = drag.ox + (e.clientX - drag.x);
      state.y = drag.oy + (e.clientY - drag.y);
      view.apply();
    });
    window.addEventListener("mouseup", () => {
      drag = null;
      el.scroll.classList.remove("grabbing");
    });

    el.scroll.addEventListener("dblclick", () => view.fit());
  }

  // ---------------------------------------------------------------- 提示与错误

  /**
   * 从渲染器/校验器的原始报错里解析出行号并给出可读文案。
   * 覆盖 Mermaid（`Parse error on line N`）与 Graphviz（`syntax error in line N near '…'`）。
   */
  function describeError(raw) {
    const text = String(raw == null ? "" : raw);
    const match = /(?:on\s+)?line[ :]+(\d+)/i.exec(text);
    const line = match ? Number(match[1]) : 0;
    const firstLine = text.split("\n").map((s) => s.trim()).find((s) => s.length > 0) || text;
    return line ? { line, text: `第 ${line} 行：${firstLine}` } : { line: 0, text: firstLine };
  }

  function showNote(text) {
    state.lastSvg = "";
    el.content.innerHTML = "";
    const div = document.createElement("div");
    div.className = "preview-note";
    div.textContent = text;
    el.content.appendChild(div);
    view.reset();
  }

  function showError(text) {
    state.lastSvg = "";
    el.content.innerHTML = "";
    const div = document.createElement("div");
    div.className = "preview-error";
    div.textContent = text;
    el.content.appendChild(div);
    view.reset();
  }

  // ---------------------------------------------------------------- 渲染

  let token = 0;

  /** 渲染一个文本格式（Mermaid / DOT）的标签页。`engine` 仅 DOT 使用。 */
  async function render(tab, body, opts) {
    const mine = ++token;
    state.lastFormat = tab ? tab.format : null;

    if (!tab) {
      el.content.innerHTML = "";
      el.empty.style.display = "grid";
      el.tools.hidden = true;
      state.lastSvg = "";
      return;
    }
    el.empty.style.display = "none";

    if (tab.format === "drawio" || tab.format === "excalidraw") {
      // 画布格式由 app.js 交给内嵌承载页，这里只收拾预览面。
      el.content.innerHTML = "";
      el.tools.hidden = true;
      state.lastSvg = "";
      return;
    }

    if (body.trim().length === 0) {
      showNote("（空文档）");
      el.tools.hidden = true;
      return;
    }

    try {
      let svg;
      if (tab.format === "mermaid") {
        if (!ensureMermaid()) {
          throw new Error("Mermaid 渲染器未加载：请确认资产目录包含 mermaid.min.js");
        }
        // 先校验（mermaid.parse）再渲染：校验失败不会在页面上留下半渲染的残迹，
        // 且报错文案带行号，能直接定位。
        if (typeof window.mermaid.parse === "function") {
          await window.mermaid.parse(body);
        }
        svg = (await window.mermaid.render(`dgm-${mine}`, body)).svg;
      } else {
        const engine = (opts && opts.engine) || "dot";
        const g = await ensureGraphviz();
        svg = g.layout(body, "svg", engine, {});
      }
      if (mine !== token) return; // 有更新的渲染请求
      el.content.innerHTML = svg;
      state.lastSvg = svg;
      el.tools.hidden = false;
      view.fit();
    } catch (err) {
      if (mine !== token) return;
      const described = describeError(err && err.message ? err.message : err);
      showError(described.text);
      el.tools.hidden = true;
      if (state.onStatus) state.onStatus(described.text, true);
      if (described.line && state.onErrorLine) state.onErrorLine(described.line);
    }
  }

  // ---------------------------------------------------------------- 位图导出

  /** 从 SVG 文本解析出内容尺寸（优先 viewBox）。 */
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

  /** 图元规模 → 导出倍率（1.5x–5.0x，与既有客户端的自适应口径一致）。 */
  function exportScale(svg) {
    const nodes = svg.querySelectorAll("g.node, g.cluster").length;
    const edges = svg.querySelectorAll("g.edge, .edgePath, path.flowchart-link").length;
    const total = nodes + edges;
    if (total <= 10) return 5;
    if (total <= 30) return 4;
    if (total <= 80) return 3;
    if (total <= 200) return 2;
    return 1.5;
  }

  /** 把当前预览栅格化为 PNG data URL。 */
  async function toPngDataUrl() {
    if (!state.lastSvg) throw new Error("当前没有可导出的图");
    const doc = new DOMParser().parseFromString(state.lastSvg, "image/svg+xml");
    const svg = doc.documentElement;
    const { w, h } = svgSize(svg);
    const scale = exportScale(svg);

    // 显式落到像素尺寸：SVG 只带 viewBox 时 <img> 的固有尺寸会退化。
    svg.setAttribute("width", String(w));
    svg.setAttribute("height", String(h));
    const text = new XMLSerializer().serializeToString(svg);
    const url = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(text)}`;

    const img = await new Promise((resolve, reject) => {
      const node = new Image();
      node.onload = () => resolve(node);
      node.onerror = () => reject(new Error("位图栅格化失败"));
      node.src = url;
    });

    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(w * scale));
    canvas.height = Math.max(1, Math.round(h * scale));
    const ctx = canvas.getContext("2d");
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL("image/png");
  }

  /** 建议文件名：基于当前文档标题与格式。 */
  function suggestedName() {
    const base = window.DGM.app ? window.DGM.app.currentExportStem() : "diagram";
    return `${base}.png`;
  }

  async function saveImage() {
    const dataUrl = await toPngDataUrl();
    const path = await window.DGM.invoke("save_image", { dataUrl, fileName: suggestedName() });
    if (path && state.onStatus) state.onStatus(`已保存图片 ${path}`);
    return path;
  }

  async function copyImage() {
    const dataUrl = await toPngDataUrl();
    await window.DGM.copyImageDataUrl(dataUrl);
    if (state.onStatus) state.onStatus("图片已复制到剪贴板");
  }

  DGM.preview = {
    init(opts) {
      setupGestures();
      state.onZoom = (opts && opts.onZoom) || null;
      state.onStatus = (opts && opts.onStatus) || null;
      state.onErrorLine = (opts && opts.onErrorLine) || null;
    },
    render,
    fit: () => view.fit(),
    zoomIn: () => view.zoomBy(1.2),
    zoomOut: () => view.zoomBy(1 / 1.2),
    resetZoom: () => view.reset(),
    hasContent: () => Boolean(state.lastSvg),
    isCanvasFormat: () => state.lastFormat === "drawio" || state.lastFormat === "excalidraw",
    /** 当前预览栅格化为 PNG data URL（导出与自动化验收共用）。 */
    toPngDataUrl,
    /** 从渲染器原始报错解析出行号与可读文案（导出与自动化验收共用）。 */
    describeError,
    saveImage,
    copyImage,
    element: {
      content: el.content,
      canvas: el.canvas,
      scroll: el.scroll,
      tools: el.tools,
    },
  };
})();

/* 预览面：mermaid / graphviz / D2 页内真渲染 + 画布手势 + 位图导出。
 *
 * - 文本型（Mermaid / DOT / D2）：先 parse 校验再 render，报错解析出行号，不留在页面上
 *   半渲染的残迹。DOT 走 vendor 里的 graphviz（ESM，加载失败时显式提示）；
 *   D2 走 `/d2/index.js`（11MB 的官方 wasm 构建，单例懒加载 + 首开加载态，见 `ui/js/d2.js`）。
 * - 渲染失败会额外发一次 `doc:render-error`（载荷 `{docId, format, line, raw}`）：
 *   AI 的「渲染校验回环」靠它把报错原文回喂模型自动修正一次。`raw` 是上游原文。
 * - 画布型（drawio / Excalidraw）：交给 `DGM.canvas`（同源 iframe 承载面），
 *   本模块只切可见面并把工具条/缩放接到承载页的钩子上。
 * - 手势：滚轮平移 / Shift 横向 / Ctrl 以光标为中心缩放 / 拖拽 / 双击适应视图。
 * - 视口：只有**文档第一次挂上（初始化）**和用户显式「适应视图」才按画布大小适应；
 *   此后重渲染（敲字 / 换主题 / 切视图模式）与占位态都不再动用户的缩放与位置。
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

  /* 视口的三条账（2026-10-14 用户反馈：改之前每敲一个字就跳一次缩放与位置）：
   * - targetDoc：上一次渲染的目标文档 —— 换了目标才算一次新的「初始化」；
   * - fittedFor：这一次目标里已经按画布适应过的文档 id（失败不记账，下次重试）；
   * - mountedDoc：舞台里当前挂着哪份文档的 SVG（占位内容会把它清成 null）。
   * 自动适应只发生在「初始化」（目标文档第一次真正挂上图）—— 之后的重渲染
   * （敲字 / 换主题 / 切视图模式）一律保留用户自己调过的缩放与位置。 */
  let targetDoc = null;
  let fittedFor = null;
  let mountedDoc = null;
  /** 已经为哪些文档提示过「该文档有 N 个板」（只提示一次） */
  const notedBoards = new Set();

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

  /**
   * 占位内容（加载中 / 空文档 / 报错 / 大文档护栏）不跟用户的缩放平移跑 ——
   * 但也**不改**用户的视口：只把 DOM 上的变换临时归零，图解回来时 mountSvg 里的
   * apply() 原样还原。（归零是必须的：用户在 400% 且平移出去时，报错文字不能跟着跑出屏外。）
   */
  function parkTransform() {
    const { stage } = nodes();
    if (!stage) return;
    stage.style.setProperty("--pan-x", "0px");
    stage.style.setProperty("--pan-y", "0px");
    stage.style.setProperty("--zoom", "1");
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

  /**
   * 按画布大小适应内容，并把视口居中。
   *
   * 返回**是否真的适应了**（视口还没尺寸、内容还没挂上时是 false）—— 调用方
   * （mountSvg）据此决定要不要把这份文档记成「已初始化」，好在下次重渲染时重试。
   */
  function fit() {
    // 画布型：缩放归承载页管（它暴露 __hostFit，把所有内容整体放进视口并居中）
    if (canvasMode) {
      // 承载页的裁决要如实用起来：它没内容可适配（空文档 / 画布还没起来）时回 false，
      // 那就**不记 markFitted** —— 记账的语义是"这份文档这一次目标里已经适应过了"，
      // 没适应成就不该记账（否则以后再没有重试的机会）。
      if (!DGM.canvas.hostFit(lastFormat)) return false;
      markFitted();
      return true;
    }
    const { viewport } = nodes();
    if (!viewport) return false;
    const size = contentSize();
    if (!size) return false;
    const rect = viewport.getBoundingClientRect();
    if (!rect.width || !rect.height) return false;
    const pad = 36;
    const s = clamp(Math.min((rect.width - pad) / size.w, (rect.height - pad) / size.h), MIN_SCALE, MAX_SCALE);
    view.scale = s;
    view.x = (rect.width - size.w * s) / 2;
    view.y = (rect.height - size.h * s) / 2;
    apply();
    markFitted();
    return true;
  }

  /** 视口「初始化」记账：这一次适应之后，本份文档的重渲染不再自动动缩放与位置。 */
  function markFitted() {
    const d = state.activeDoc();
    if (d) fittedFor = d.id;
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
    // 没有文档了：下一份文档重新「初始化」（重开同一份文件也该重新适应一次）
    targetDoc = null;
    fittedFor = null;
    mountedDoc = null;
    if (viewport) viewport.classList.remove("grabbing");
  }

  function showNode(node) {
    const { stage } = nodes();
    if (!stage) return;
    stage.innerHTML = "";
    stage.appendChild(node);
    mountedDoc = null;
    setPannable(false);
    parkTransform(); // 占位内容落在视口正中；用户视口在 view 里原样留着
  }

  function note(text) {
    lastSvg = "";
    showNode(h("div", "preview-note", esc(text)));
  }

  function errorBox(text, jump) {
    lastSvg = "";
    const node = h("div", "preview-error", esc(text));
    // 有行列定位时给一个「跳到出错处」：切到源码视图并把光标钉到出错行列。
    // 按钮只在编辑器侧真的能跳时出现（vendor 缺失的 textarea 回退也能跳）。
    if (jump && jump.line && DGM.editor && (DGM.editor.jumpTo || DGM.editor.gotoLine)) {
      const btn = h("button", "mini-btn pv-jump", esc(t("src.jumpToError")));
      btn.addEventListener("click", () => {
        if (DGM.shell && DGM.shell.setMode) DGM.shell.setMode("source");
        if (DGM.editor.jumpTo) DGM.editor.jumpTo(jump.line, jump.col || 1);
        else DGM.editor.gotoLine(jump.line);
      });
      node.appendChild(btn);
    }
    showNode(node);
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

  /** mermaid 的解析错误：优先读 err.hash 里的结构化行列，读不到再退化到
   *  describeError 的正则文本扫描（走 err.message，比如 "Parse error on line N"）。
   *
   *  mermaid 12 实测的 hash 形态有三种（解析器来源不同）：
   *  ① hash.loc = { start:{line,column}, end:{...} }        —— 新版 parser；
   *  ② hash.loc = { first_line, first_column, ... }         —— jison 原生（1 基）；
   *  ③ hash.line（**0 基**）+ hash.first_column             —— git 图等手写 throw。
   *  所以下面 ①② 直接用、③ 要 +1。都取不到时行号记 0（调用方按无定位处理）。
   */
  function describeMermaid(err) {
    const h = err && err.hash;
    let line = 0;
    let col = 0;
    if (h && h.loc) {
      if (h.loc.start && Number.isFinite(h.loc.start.line)) {
        line = h.loc.start.line;
        col = h.loc.start.column;
      } else if (Number.isFinite(h.loc.first_line)) {
        line = h.loc.first_line;
        col = h.loc.first_column;
      }
    } else if (h && Number.isFinite(h.line)) {
      line = h.line + 1;
      col = Number.isFinite(h.first_column) ? h.first_column + 1 : 0;
    }
    const msg = String((err && err.message) || err || "");
    if (!line) {
      const d = describeError(msg);
      return { line: d.line, col: 0, text: d.text };
    }
    const first = msg.split("\n").map((s) => s.trim()).find((s) => s.length) || msg;
    const where = t("common.line") + " " + line + (col ? " " + t("common.col") + " " + col : "");
    return { line, col: col || 1, text: t("preview.noRender", { msg: where + "：" + first }) };
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

  /* ------------------------------------------------------------------ 顶栏渲染选项控件 */

  /** 预览顶栏的「外观 / 布局」控件。
   *
   *  - Mermaid：两颗（外观 = fmt.looks；布局 = fmt.layouts，elk 走懒加载离线包）；
   *  - DOT / D2：一颗布局（引擎清单来自注册表，与状态栏旧入口同一数据源）；
   *  - 画布型与其它没有选项的格式：整组隐藏。
   *  点选落 `d.look` / `d.layout`（文档级），点完立即重渲染；Rust 侧同时按**文件路径**
   *  记进 `render-opts.json`，下次打开这个文件就恢复这次的选择（未保存标签页没有路径，
   *  记不了 —— 首次保存那一刻才落上）。
   */
  let optsKey = null;

  function renderOpts(d) {
    const host = document.getElementById("pv-opts");
    if (!host) return;
    const key = d ? [d.id, d.format, d.look || "", d.layout || ""].join("|") : "";
    if (key === optsKey) return;
    optsKey = key;
    host.innerHTML = "";
    if (!d || state.isCanvasDoc(d)) return;
    const fmt = state.docFmt(d);
    const looks = fmt.looks || [];
    const layouts = fmt.layouts || [];
    if (!looks.length && !layouts.length) return;
    if (looks.length) host.appendChild(buildOptBtn(d, "look", t("preview.look"), looks, optsCurLook(d)));
    if (layouts.length) host.appendChild(buildOptBtn(d, "layout", t("preview.layoutName"), layouts, d.layout || layouts[0]));
  }

  /** 当前生效的外观（文档级 > 设置默认 > auto）——按钮上显示的就是它。
   *  转换中心也用这个口径决定要不要把 look 传给引擎（导出供 dialogs.js 复用）。 */
  function optsCurLook(d) {
    if (d.look) return d.look;
    const s = state.settings && state.settings.mermaid && state.settings.mermaid.look;
    return s || "auto";
  }

  function buildOptBtn(d, kind, name, values, cur) {
    const b = h("button", "mini-btn pv-opt");
    b.title = t("preview.renderOptsTip");
    b.innerHTML =
      icon(kind === "look" ? "palette" : "diagram", "ico-sm") +
      `<span>${esc(name)} · <span class="pv-opt-val">${esc(cur)}</span></span>` +
      icon("chevD", "ico-sm");
    b.addEventListener("click", (e) => {
      e.stopPropagation(); // showPop 的约定：锚点点击不能进文档级「点外关闭」监听，否则刚开就被关
      const cur2 = kind === "look" ? optsCurLook(d) : d.layout || values[0];
      const items = values.map((v) => {
        const it = { label: kind === "look" ? t("preview.look." + v) : v, check: true, on: v === cur2, v };
        if (kind === "layout" && v === "elk" && d.format === "mermaid") {
          if (!elkLoaded()) {
            it.disabled = true;
            it.kbd = t("preview.elk.loading");
            loadElk()
              .then(schedule)
              .catch((e) => {
                // 菜单里的后台预热失败也要留痕（以前 `.catch(() => {})` 吞掉，
                // 用户只看到“一直加载中”，不知道离线包已经不可能加载成功）
                state.pushOutput((e && e.message) || String(e), "warn");
              });
          }
        }
        return it;
      });
      items.unshift({ label2: kind === "look" ? t("preview.lookMenu") : t("preview.layoutMenu") });
      if (kind === "look") items.push({ sep: true }, { label2: t("preview.lookFooter") });
      const r = b.getBoundingClientRect();
      DGM.pop.show(items, { x: r.left, y: r.bottom + 4 }, (it) => {
        DGM.pop.hide();
        if (it.disabled || it.v === cur2) return;
        if (kind === "look") state.setLook(d.id, it.v);
        else state.setLayout(d.id, it.v);
        schedule();
      });
    });
    return b;
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
    renderOpts(d); // 顶栏「外观 / 布局」控件随文档/格式显隐与取值

    // 换了目标文档 = 一次新的「初始化」：视口记账作废，这一次挂上图时要重新按画布适应。
    // 同一份文档的重渲染（敲字 / 换主题 / 切视图模式）不走这里 —— 视口保持用户调过的样子。
    if (targetDoc !== d.id) {
      targetDoc = d.id;
      fittedFor = null;
    }

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
    // 同一份文档的重渲染（敲字、换主题、切视图模式）**不清舞台**：清一次就闪一次
    // 加载占位，等于把用户的缩放与位置抹掉。只有这份文档还没挂上图时才显示占位。
    if (mountedDoc !== d.id) {
      showLoading();
      toolsVisible(false);
    }
    try {
      let svgText;
      if (d.format === "mermaid") {
        svgText = await renderMermaid(body, mine, d);
      } else if (d.format === "dot") {
        svgText = await renderDot(body, d.layout || "dot");
      } else if (d.format === "d2") {
        svgText = await renderD2(body, d.layout || "dagre");
      } else {
        throw new Error(t("preview.noRender", { msg: d.format }));
      }
      if (mine !== renderToken) return;
      mountSvg(svgText, d);
      // 渲染成功 → 清掉上一轮可能留下的源码行内错误标记
      if (DGM.editor && DGM.editor.clearError) DGM.editor.clearError();
    } catch (err) {
      if (mine !== renderToken) return;
      // D2 抛的是 JSON 数组串（行列号在 errmsg 里），通用解析认不出来，先单独试一次；
      // mermaid 优先读错误对象上的结构化行列（hash.loc / hash.line），比正则扫文本可靠。
      const d2err = d.format === "d2" ? DGM.d2.describeError(err && err.message ? err.message : err) : null;
      const described =
        d2err ? describeD2(d2err)
        : d.format === "mermaid" ? describeMermaid(err)
        : describeError(err && err.message ? err.message : err);
      errorBox(described.text, described.line ? { line: described.line, col: described.col || 1 } : null);
      toolsVisible(false);
      if (DGM.status) DGM.status(described.text, "err");
      if (described.line) {
        state.refreshIssues(d.id);
        // 源码窗口行内标记（M3）：编辑器在就画，不在（预览模式）就留给 jump 按钮的跳转
        if (DGM.editor && DGM.editor.markError) DGM.editor.markError(described.line, described.col || 1);
      }
      emitRenderError(d, described, err);
    }
  }

  /** 对外播报一次渲染失败。
   *
   *  消费者是 AI 的「渲染校验回环」（`ui/js/ai.js`）：它拿这份载荷去组装第二次请求，
   *  把报错回喂模型修正一次。所以 **`raw` 必须是上游原文** —— `described.text` 是给
   *  人看的中文 UI 串（里面还塞了 `preview.noRender` 的包装文案与本地化行号措辞），
   *  喂模型会把真正有用的语法信息淹没掉。
   */
  function emitRenderError(d, described, err) {
    DGM.bus.emit("doc:render-error", {
      docId: d.id,
      format: d.format,
      line: described.line || 0,
      col: described.col || 0,
      // 个别引擎抛的是非 Error 对象，退化成字符串；截断避免把整篇栈塞进请求
      raw: String((err && err.message) || err || "").slice(0, 800),
    });
  }

  /** Mermaid ELK 布局引擎（懒加载随包离线 bundle，模式与 DGM.d2 一致）。
   *
   *  资产在 `/mermaid-elk/mermaid-layout-elk.esm.js`（crates/assets 的第六个挂载点），
   *  **故意不进 `ui/vendor/`**：`build.frontendDist = "../ui"` 会把 ui 再嵌进 exe 一份。
   *  单例懒加载：首次用到（用户把布局切到 elk）才 `import()`，注册进 mermaid 后复用。
   *  失败不缓存 —— 资产可能刚被取资产脚本补齐，下次还能重试。
   */
  let elkPromise = null;
  let elkReady = false;

  function elkLoaded() {
    return elkReady;
  }

  function loadElk() {
    if (elkReady) return Promise.resolve(true);
    if (!elkPromise) {
      elkPromise = import("/mermaid-elk/mermaid-layout-elk.esm.js")
        .then((m) => {
          if (typeof window.mermaid.registerLayoutLoaders !== "function") {
            throw new Error("mermaid.registerLayoutLoaders is not a function");
          }
          window.mermaid.registerLayoutLoaders(m.default);
          elkReady = true;
          return true;
        })
        .catch((err) => {
          elkPromise = null;
          throw new Error(t("preview.elk.unavailable", { msg: (err && err.message) || String(err) }));
        });
    }
    return elkPromise;
  }

  /** 预热 Mermaid 的 ELK 离线包：只在"以前用过 elk"时由 main.js 调（依据见 `AppInfo.warm_elk`），
   *  失败静默 —— 启动预热不该弹错（与 `DGM.d2.warmup` 同一套约定）。 */
  function warmElk() {
    loadElk().catch(() => {});
  }

  async function renderMermaid(body, mine, d) {
    if (typeof window.mermaid === "undefined") throw new Error(t("preview.mermaidUnavailable"));
    const dark = document.documentElement.dataset.theme === "dark";
    // 外观（look）：文档级 > 设置默认 > 不干预。「auto」与未设置都交给 Mermaid 内建默认
    // （12 的流程图 = neo + redux-color 主题，与 mermaid.live 对齐）。
    const setLookPref = state.settings && state.settings.mermaid && state.settings.mermaid.look;
    let look = d.look && d.look !== "auto" ? d.look : setLookPref && setLookPref !== "auto" ? setLookPref : null;
    // 布局：文档级（Rust 侧按注册表校验过；elk 需要离线包，加载失败回退 dagre 而不是报错断流）
    const fmt = state.docFmt(d);
    let layout = d.layout && fmt.layouts && fmt.layouts.includes(d.layout) ? d.layout : null;
    if (layout === "elk") {
      try {
        await loadElk();
      } catch (e) {
        const msg = t("preview.elk.fallback", { msg: e.message });
        if (DGM.status) DGM.status(msg, "warn");
        // G24：加载失败**不许装作切成功** —— 顶栏给出明确回退说明，并把原因记进输出面板
        state.pushOutput(msg, "warn");
        layout = "dagre";
      }
    }
    window.mermaid.initialize({
      startOnLoad: false,
      securityLevel: "strict",
      theme: dark ? "dark" : "default",
      ...(look ? { look } : {}),
      ...(layout ? { layout } : {}),
    });
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
    // 报错必须带上**真实原因**：这句文案以前是写死的「ES 模块在 file:// 下被拦截」，
    // 于是「加载器把 vendor 路径解析错了」这种完全无关的故障也被讲成 file:// 问题 ——
    // 诊断被文案带跑（3.5.2–3.6.0 的 DOT 预览就是这么误导的）。
    if (!window.DGMGraphviz) {
      throw new Error(
        t("preview.graphviz.unavailable", { msg: window.DGMGraphvizError || t("preview.graphviz.noLoader") })
      );
    }
    return window.DGMGraphviz.layout(body, "svg", engine, {});
  }

  /**
   * D2：页内 wasm（`DGM.d2` 管单例与懒加载，这里只管加载态与产物）。
   *
   * 首次编译要几秒（11MB 的 wasm 要先解压实例化），期间把状态栏说清楚 ——
   * 不然看起来就是卡死。之后就复用实例（~30ms）。
   */
  async function renderD2(body, engine) {
    if (!DGM.d2) throw new Error(t("preview.d2.unavailable", { msg: "ui/js/d2.js 未加载" }));
    if (!DGM.d2.isReady()) {
      showLoading();
      setSub(t("preview.d2.init"));
    }
    return DGM.d2.renderSvg(body, engine);
  }

  /** D2 的解析结果 → 与其它格式同一套报错面板文案（行号在前，用户能直接对到源码）。 */
  function describeD2(e) {
    if (!e.line) return { line: 0, text: e.text };
    return {
      line: e.line,
      text: t("preview.noRender", { msg: t("common.line") + " " + e.line + "：" + e.text }),
    };
  }

  /**
   * 渲染引擎的 SVG 产物进舞台前先消毒（审计 F-2a：第二道防线）。
   *
   * mermaid 有 securityLevel:"strict" 兜着，graphviz / D2 的 wasm 输出依赖上游
   * 自己的转义纪律；而 innerHTML 插入的 SVG 里**事件属性是会执行的**。
   * 用 <template> 承接：模板内容是惰性的（脚本不执行、事件不触发），
   * 且 HTML 解析对 mermaid 标签里未闭合的 `<br>` 宽容（XML 解析会直接 parsererror，
   * 见 pngDataUrl 的注释），消毒完再把 <svg> 摘出来挂载。
   */
  function sanitizeSvgNode(svgText) {
    const tpl = document.createElement("template");
    tpl.innerHTML = String(svgText);
    const root = tpl.content.querySelector("svg");
    if (!root) return null;
    // 可执行/可加载的元素整棵拔掉（script 选择器覆盖任意深度，含 foreignObject 内）
    root.querySelectorAll("script, iframe, object, embed, link, base").forEach((n) => n.remove());
    // 事件属性（on*）与 javascript: 可执行 URL
    tpl.content.querySelectorAll("*").forEach((n) => {
      for (const attr of Array.from(n.attributes || [])) {
        const name = attr.name.toLowerCase();
        if (name.startsWith("on")) {
          n.removeAttribute(attr.name);
        } else if ((name === "href" || name === "xlink:href" || name === "src") && /^\s*javascript:/i.test(attr.value)) {
          n.removeAttribute(attr.name);
        }
      }
    });
    return root;
  }

  function mountSvg(svgText, d) {
    const { stage } = nodes();
    if (!stage) return;
    const sanitized = sanitizeSvgNode(svgText);
    if (!sanitized) {
      errorBox(t("preview.noRender", { msg: "svg" }));
      toolsVisible(false);
      return;
    }
    stage.dataset.engine = d.format;
    stage.innerHTML = "";
    stage.appendChild(sanitized);
    const svg = stage.querySelector("svg");
    if (svg) normalizeSvg(svg);
    // 导出（SVG 文件 / 位图栅格化的兜底）拿的是消毒后的这份；没挂上图就清空，别把上一份的留给人导出
    lastSvg = svg ? new XMLSerializer().serializeToString(svg) : "";
    mountedDoc = d.id;
    setPannable(true);
    toolsVisible(true);
    if (d.format === "dot") setSub(t("preview.dot.layout", { layout: d.layout || "dot" }));
    if (d.format === "d2") {
      // 有 `layers:` 的文档 D2 只渲染 root 板（输出可能是空图）—— 必须说清，否则像坏了。
      // 板切换器按方案不做；提示只在**每份文档第一次**挂图时发一条，免得刷满输出面板。
      const n = DGM.d2 ? DGM.d2.boardCount(d.body || "") : 0;
      const layoutText = t("preview.d2.layout", { layout: d.layout || "dagre" });
      setSub(n ? layoutText + " · " + t("preview.d2.boards", { n }) : layoutText);
      if (n && !notedBoards.has(d.id)) {
        notedBoards.add(d.id);
        state.pushOutput(t("preview.d2.boards", { n }), "warn");
      }
    }
    // 自动适应**只在这份文档第一次挂上时**做一次（初始化）—— 此后一律保留用户自己
    // 调过的缩放与位置。要重新适应就点「适应视图」（Ctrl+0 / 工具条 / 双击画布）。
    apply(); // 先把用户的视口还回去（占位内容期间 DOM 上是归零的）
    if (fittedFor !== d.id) fit();
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
    // 复制/导出已在预览顶栏，可见性跟缩放一致：没有可渲染内容就藏起来
    for (const id of ["#btn-copy-img", "#btn-export"]) {
      const n = $(id);
      if (n) n.hidden = !on;
    }
  }

  /* ------------------------------------------------------------------ 位图导出 */

  /** 导出画布的硬上限（真机实测 WebView2/Chromium）：**面积 ≤ 2^28 px、单边 ≤ 65535**。
   *
   * 超限时 `drawImage` **静默不画**、`toDataURL` 交回一张空图 —— 用户看到的就是
   * "导出的图是空白"。实测（2026-10-19，本机 WebView2）：
   * `16384²` = 268,435,456 ✓ 能画；`20000²` ✗ 空白；`65535×4000` ✓；`100000×1000` ✗。
   * 所以两条都要守：面积是主约束，单边兜底（长条形图不该被单边卡住）。
   */
  const MAX_CANVAS_AREA = 268435456; // 2^28
  const MAX_CANVAS_SIDE = 65535;

  /** 把"想要的倍率"压到上限以内（面积为主、单边兜底）。`capped` = 压过了。 */
  function fitExportScale(w, h, want) {
    if (!(w > 0) || !(h > 0)) return { scale: want, capped: false };
    const bySide = Math.min(MAX_CANVAS_SIDE / w, MAX_CANVAS_SIDE / h);
    const byArea = Math.sqrt(MAX_CANVAS_AREA / (w * h));
    const scale = Math.min(want, bySide, byArea);
    return { scale, capped: scale < want - 1e-6 };
  }

  /** 导出位图的底色：与预览同源（`--canvas-bg`）。
   *
   * 不填底色的 PNG/DIB 是**全透明**的 —— 暗色主题（浅色笔画、深色底）导出来就是
   * "透明底 + 浅灰线条"，在任何白色看图器里几乎一片空白（2026-10-19 用户报的
   * "导出是空白"正是这一条 + 上面那个尺寸上限）。这里按用户眼前所见填底色。
   */
  function exportBg() {
    const pane = document.querySelector(".pane-preview");
    const c = pane ? getComputedStyle(pane).backgroundColor : "";
    if (c && c !== "transparent" && !/rgba\(0, 0, 0, 0\)/.test(c)) return c;
    return getComputedStyle(document.body).backgroundColor || "#ffffff";
  }

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

  function trimNum(v) {
    return String(Number(v.toFixed(2)));
  }

  /** 把当前预览栅格化成 PNG dataURL。
   *
   *  返回 `{ url, w, h, scale, want, capped }` —— 导出/复制两条路都用它，
   *  `capped` 让调用方**如实说出**"为什么不是自适应倍率"（被画布上限压过）。
   */
  async function pngDataUrl() {
    // 画布型：让承载页自己导出（drawio 的 export / Excalidraw 的 exportToBlob），
    // 本站只把 data URI 拿回来落盘
    if (canvasMode) {
      const data = await DGM.canvas.exportPng(lastFormat, 2, false);
      if (!data) throw new Error(t("exp.canvasFail"));
      return { url: data, w: 0, h: 0, scale: 2, want: 2, capped: false };
    }
    if (!lastSvg) throw new Error(t("exp.noContent"));
    // 优先克隆**活着的 SVG 节点**，而不是拿渲染时的原始文本重新过一遍 XML 解析。
    //
    // 坑：mermaid 的 htmlLabels 会把标签文本原样写进 <foreignObject>，正文里的
    // `<br>` 是未闭合的 HTML 形式。页面渲染没问题（innerHTML 是 HTML 解析，宽容），
    // 但 DOMParser 按 image/svg+xml 严格解析会直接 parsererror —— 之后拿 parsererror
    // 元素当 SVG 去加载，就是「位图栅格化失败」（用户标签里带 <br> 时必现）。
    // 挂在页面上的那份已经被浏览器解析成 DOM，XMLSerializer 从 DOM 产出的必然良构。
    const stage = nodes().stage;
    const live = stage ? stage.querySelector("svg") : null;
    const svg = live
      ? live.cloneNode(true)
      : new DOMParser().parseFromString(lastSvg, "image/svg+xml").documentElement;
    const { w, h } = svgSize(svg);
    const want = exportScale(svg);
    const { scale, capped } = fitExportScale(w, h, want);
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
    // 先铺底色：不铺就是"透明 PNG"（见 exportBg 的注释）
    ctx.fillStyle = exportBg();
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    return { url: canvas.toDataURL("image/png"), w, h, scale, want, capped };
  }

  /** 倍率被画布上限压过时，把原因说清楚（状态栏 + 输出面板，不静默降级）。 */
  function noteScaleCap(png) {
    if (!png || !png.capped) return;
    const note = t("exp.scaleCapped", { got: trimNum(png.scale), want: trimNum(png.want) });
    DGM.status(note, "warn");
    state.pushOutput(note, "warn");
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

  /** 保存对话框被取消时如实收场（审计 F-9：原兜底会把文件写进写死的开发路径）。 */
  function exportCancelled(kindLabel) {
    DGM.toast({ icon: "alert", title: kindLabel, sub: t("exp.cancelled"), warn: true });
  }

  async function exportPng() {
    try {
      const png = await pngDataUrl();
      let path = await DGM.ipc.dialog.pickSavePath({
        defaultPath: stem() + ".png",
        filters: [{ name: "PNG", extensions: ["png"] }],
      });
      if (!path) return exportCancelled(t("exp.png"));
      await state.exportWrite(path, dataUrlToBase64(png.url));
      state.pushOutput(t("exp.saved", { path }), "ok");
      DGM.toast({ icon: "download", title: t("exp.png"), sub: path });
      noteScaleCap(png);
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
      if (!path) return exportCancelled(t("exp.svg"));
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
      const png = await pngDataUrl();
      const ok = await copyImageDataUrl(png.url);
      DGM.toast({ icon: "copy", title: t("exp.copy"), sub: ok ? "" : t("exp.copyFail") });
      noteScaleCap(png);
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
    const bs = $("#btn-show-source");
    if (bs) bs.addEventListener("click", () => DGM.shell.setMode("source"));
    // 「转换」入口已收编到标签条（#tab-convert）与状态栏格式项，顶栏不再放
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
  // 设置里改了 Mermaid 默认外观 → 顶栏按钮上的当前值要跟着变（渲染本身由上面的 schedule 兜住）
  DGM.bus.on("settings:changed", () => {
    optsKey = null;
    renderOpts(state.activeDoc());
  });

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
    pngDataUrl,
    fitExportScale,
    MAX_CANVAS_AREA,
    MAX_CANVAS_SIDE,
    describeError,
    describeMermaid,
    elkLoaded,
    warmElk,
    effectiveLook: optsCurLook,
    exportPng,
    exportSvg,
    copyImage,
    bind,
    element: { get stage() { return stage; }, get viewport() { return viewport; } },
  };
})();

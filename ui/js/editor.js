/* 源码窗口：CodeMirror 6 外壳（vendor 里的 window.DGMEditor）。
 *
 * - 一个共享实例常驻 #editor-host；切标签时 setLanguage + setValue（带 guard，
 *   程序化写入不触发 onChange，避免把回填当作用户输入二次落盘）。
 * - 光标/选区：vendor 不回调 selectionchange，这里自己挂在 view.dom 上读
 *   state.selection，经节流后写 state.setCaret（→ doc_set_caret）。
 * - 字体大小读 settings.editor.font_size，经 --editor-fs 下发。
 * - Tab / Shift+Tab 的缩进由这里接管：vendor 没带 indentWithTab（见下方 watchTab）。
 *   语义（2026-10-18 起）：空选区 Tab = 光标处补空格到下一个 tab stop；有选区 = 整行缩进。
 * - vendor 缺失时回退到 <textarea>，功能降级但可编辑。
 */
window.DGM = window.DGM || {};
(function () {
  "use strict";

  const state = DGM.state;
  const ipc = DGM.ipc;
  const t = (k, v) => DGM.i18n.t(k, v);
  const { $, h, esc } = DGM.dom;

  let inst = null; // DGMEditor 实例
  let currentId = null; // 当前挂载的 docId
  let fallback = null; // <textarea> 回退节点
  let caretTimer = 0;

  function host() {
    return $("#editor-host");
  }

  function hasVendor() {
    return !!(window.DGMEditor && typeof window.DGMEditor.create === "function");
  }

  /* ------------------------------------------------------------------ 光标 */

  function readCaret() {
    if (!inst || !inst.view) return null;
    const v = inst.view;
    const pos = v.state.selection.main.head;
    const line = v.state.doc.lineAt(pos);
    return { line: line.number, col: pos - line.from + 1 };
  }

  function scheduleCaret() {
    clearTimeout(caretTimer);
    caretTimer = setTimeout(() => {
      const c = readCaret();
      if (c && currentId) state.setCaret(currentId, c.line, c.col);
    }, 60);
  }

  function watchCaret() {
    if (!inst || !inst.view) return;
    const dom = inst.view.dom;
    ["keyup", "mouseup", "focus", "blur"].forEach((ev) => dom.addEventListener(ev, scheduleCaret));
  }

  /* ------------------------------------------------------------------ Tab 缩进 */

  /* vendor 的 basic setup 里有行号、当前行高亮（highlightActiveLine + 行号槽）、
   * 括号匹配、历史，但**没有 indentWithTab / insertTab**（命令都被 tree-shake 掉了，
   * 见下面 INDENT 的说明）—— 源码窗口里按 Tab 走的是浏览器默认行为（焦点跳到下一个
   * 可聚焦元素），缩进根本用不了。vendor 是随包资产（不当普通源码改），所以这里在
   * 应用层实现，语义对齐主流编辑器（VS Code / JetBrains / Sublime 的习惯，
   * 用户 2026-10-18 拍板）：
   *   Tab        → 空选区：**在光标处**补空格到下一个 tab stop（1..4 个）
   *                非空选区：选区覆盖到的行整行缩进
   *   Shift+Tab  → 空选区：当前行反缩进
   *                非空选区：整块反缩进
   * 光标处而不是行首：旧实现把缩进一律插在行首（照抄 CodeMirror 的 indentWithTab =
   * indentMore 的语义），于是"光标在句子中间按 Tab，整行右移" —— 与所有主流编辑器
   * 都不同。行首按 Tab 仍是整档 4 空格，与旧行为一致，肌肉记忆不废。
   * 一次按键 = 一个事务（userEvent=input.indent），撤销栈里是一步。
   * 只在可编辑区（contentDOM）里接管 —— 查找面板的输入框该有自己的 Tab 行为。 */
  const INDENT = "    "; // 一个缩进单位：与格式注册表的默认正文一致（mermaid / dot 都缩 4 空格）；
  // 也与 vendor 的 tabSize:4 对齐（bundle 里 `tabSize:4`，Tab 档位与显示宽度因此是同一个 4）

  /** 行内位置 `col`（0 基字符下标）对应的**可视列**：制表符展开到下一个 tab stop。
   *
   *  正文里几乎不会出现制表符（编辑器只写空格），所以没有制表符时直接返回 `col`，
   *  省掉逐字符扫描 —— 按 Tab 不该是 O(行长)。 */
  function visualCol(text, col) {
    const seg = text.slice(0, col);
    if (!seg.includes("\t")) return col;
    let vis = 0;
    for (const ch of seg) vis += ch === "\t" ? INDENT.length - (vis % INDENT.length) : 1;
    return vis;
  }

  /** 光标处要补几个空格才落到下一个 tab stop（1..INDENT.length）。 */
  function toNextStop(text, col) {
    return INDENT.length - (visualCol(text, col) % INDENT.length);
  }

  /** 反缩进一行：砍掉至多一个缩进单位的前导空白；没有前导空白 → null（这行不改）。 */
  function outdentChange(line) {
    const ws = /^[ \t]*/.exec(line.text)[0];
    if (!ws) return null;
    // 制表符按一档算 —— 编辑器自己只写空格，但外部文件可能带 tab
    const cut = ws[0] === "\t" ? 1 : Math.min(INDENT.length, ws.length);
    return { from: line.from, to: line.from + cut, insert: "" };
  }

  /** 按 Tab / Shift+Tab 重排各选区。
   *
   *  空选区（Tab）走**光标处插入**这条分支：补几个空格由光标所在的可视列决定
   *  （见 `toNextStop`），多光标各按自己的列插 —— 这正是"与主流编辑器一致"的那条。
   *  其余情况（有选区 / 反缩进）按行处理：与 CodeMirror 的 changeByLine 同规则，
   *  光标所在行总在内；选区正好停在某行行首时，那一行不算被选中。 */
  function reindent(outdent) {
    const view = inst && inst.view;
    if (!view || view.state.readOnly) return;
    const { state } = view;
    const changes = [];
    let lastLine = -1;
    for (const r of state.selection.ranges) {
      if (r.empty && !outdent) {
        const line = state.doc.lineAt(r.head);
        changes.push({ from: r.head, insert: " ".repeat(toNextStop(line.text, r.head - line.from)) });
        continue;
      }
      for (let pos = r.from; pos <= r.to; ) {
        const line = state.doc.lineAt(pos);
        // 与 CodeMirror 的 changeByLine 同规则：光标所在行总在内；
        // 选区正好停在某行行首时，那一行不算被选中
        if (line.number > lastLine && (r.empty || r.to > line.from)) {
          lastLine = line.number;
          const c = outdent ? outdentChange(line) : { from: line.from, insert: INDENT };
          if (c) changes.push(c);
        }
        pos = line.to + 1;
      }
    }
    // 反缩进时可能一行都没得删 —— 照样吞掉这次 Tab（否则焦点会溜出编辑器）
    if (!changes.length) return;
    // 先算出改动落到文档上的样子，再按 assoc=1 映射选区：光标/选区跟着缩进一起右移
    const set = state.changes(changes);
    // 选区的类只能从当前 selection 上取：vendor 只对外导出了 create / LANGUAGES，
    // 没导出 EditorSelection；同一次 bundle 加载里它是同一个类。
    // （别把 {anchor, head} 的**数组**传进 dispatch —— 这一版 CM 不认，会写出带
    //   undefined 位置的选区，渲染时就地崩在 lineAt 上。单个对象形态才被接受。）
    const Sel = state.selection.constructor;
    view.dispatch({
      changes: set,
      selection: Sel.create(
        state.selection.ranges.map((r) => Sel.range(set.mapPos(r.anchor, 1), set.mapPos(r.head, 1))),
        state.selection.mainIndex,
      ),
      userEvent: outdent ? "delete.dedent" : "input.indent",
    });
  }

  /** 接管可编辑区里的 Tab：捕获阶段挂在编辑器根上，抢在 CodeMirror 自己的按键处理之前。 */
  function watchTab() {
    if (!inst || !inst.view) return;
    const view = inst.view;
    view.dom.addEventListener(
      "keydown",
      (e) => {
        // Ctrl/Cmd/Alt 组合留给应用（Ctrl+Tab 是标签页切换）
        if (e.key !== "Tab" || e.ctrlKey || e.metaKey || e.altKey) return;
        if (!view.contentDOM.contains(e.target)) return;
        e.preventDefault(); // 挡掉浏览器默认的"焦点前移"
        e.stopPropagation(); // 别让 CodeMirror 的按键处理再看到同一次 Tab
        reindent(e.shiftKey);
      },
      true,
    );
  }

  /* ------------------------------------------------------------------ 创建 / 挂载 */

  function ensure() {
    const box = host();
    if (!box) return null;
    if (inst) return inst;
    if (!hasVendor()) return ensureFallback(box);
    inst = window.DGMEditor.create(box, {
      doc: "",
      language: "mermaid",
      onChange: (val) => {
        if (currentId) state.setBody(currentId, val);
      },
    });
    watchCaret();
    watchTab();
    watchErrMark();
    watchSwatches();
    scheduleSwatches();
    // 面板可能在创建时就已存在（search({top:true}) 预先建好、藏着），先翻一次并盯住重建
    localizeSearchPanel();
    watchSearchPanel();
    return inst;
  }

  function ensureFallback(box) {
    if (fallback) return null;
    box.innerHTML = "";
    fallback = h("textarea", "fallback-editor");
    fallback.spellcheck = false;
    fallback.addEventListener("input", () => {
      if (currentId) state.setBody(currentId, fallback.value);
    });
    box.appendChild(fallback);
    return null;
  }

  function applyFontSize() {
    const e = state.settings && state.settings.editor;
    const size = (e && e.font_size) || 13;
    document.documentElement.style.setProperty("--editor-fs", size + "px");
    return size;
  }

  /** 把当前活动文档装进编辑器。 */
  function loadActive() {
    const d = state.activeDoc();
    applyFontSize();
    clearError(); // 换文档：上一份的错误标记坐标不再有效
    const langLbl = $("#src-lang");
    if (!d) {
      currentId = null;
      if (inst) inst.setValue("");
      if (fallback) fallback.value = "";
      if (langLbl) langLbl.textContent = "";
      return;
    }
    const fmt = state.docFmt(d);
    const box = host();
    if (langLbl) langLbl.textContent = fmt.name;

    currentId = d.id;
    annKey = { id: "", body: "", scheme: "" }; // 换文档：重算标注
    scheduleSwatches();
    if (hasVendor()) {
      ensure();
      if (inst) {
        inst.setLanguage(d.format);
        if (inst.getValue() !== (d.body || "")) inst.setValue(d.body || "");
        const c = { line: d.caret_line || 1, col: d.caret_col || 1 };
        try {
          inst.revealLine(c.line);
        } catch (e) {
          /* 行号越界时忽略 */
        }
      }
    } else if (box) {
      if (!fallback) ensureFallback(box);
      if (fallback) fallback.value = d.body || "";
    }
  }

  /* ------------------------------------------------------------------ 对外动作 */

  function gotoLine(line) {
    if (!inst) return;
    try {
      inst.revealLine(line);
      inst.focus();
    } catch (e) {
      /* 忽略越界行 */
    }
  }

  /** 精确跳转：光标落到 line:col（均 1 基），滚动进入视口并聚焦。
   *
   *  与 `gotoLine` 的差别：vendor 的 revealLine 只有行号没有列，也不保证把光标
   *  真正落到目标位置。这里用公开 API（dispatch + scrollIntoView）做精确落点，
   *  渲染失败时的「跳到出错处」按钮吃的是它。
   *  vendor 缺失时退到 textarea：按行列算字符偏移设选区。 */
  function jumpTo(line, col) {
    if (!hasVendor()) {
      if (!fallback) return;
      const lines = (fallback.value || "").split("\n");
      const idx = Math.min(Math.max(1, line), lines.length) - 1;
      let pos = 0;
      for (let i = 0; i < idx; i++) pos += lines[i].length + 1;
      pos += Math.max(0, (col || 1) - 1);
      fallback.focus();
      try {
        fallback.setSelectionRange(pos, pos);
      } catch (e) {
        /* 忽略 */
      }
      return;
    }
    if (!inst || !inst.view) return;
    const v = inst.view;
    const doc = v.state.doc;
    const ln = doc.line(Math.min(Math.max(1, line), doc.lines));
    const pos = Math.min(ln.from + Math.max(0, (col || 1) - 1), ln.to);
    v.dispatch({ selection: { anchor: pos }, scrollIntoView: true });
    v.focus();
    scheduleCaret();
    scheduleErrDraw(); // scrollIntoView 触发的滚动事件可能晚于本次绘制，主动补一次
  }

  /* ------------------------------------------------------------------ 行内错误标记（DOM 覆盖层）

   *  渲染失败时在出错的那一行下面画一条红波浪线。vendor 只对外暴露
   *  {create, LANGUAGES} —— CM6 的 StateEffect / StateField / @codemirror/lint
   *  全拿不到，所以不走 diagnostics 管线，改用零依赖的 DOM 覆盖层：
   *
   *  - 位置用公开 API 算：view.coordsAtPos（视口坐标）减宿主矩形 → 覆盖层坐标；
   *  - 覆盖层不随内容滚动，滚动/输入/窗口缩放/字号变化时按当前标记**重画**；
   *  - 出错行被滚出视口时 coordsAtPos 拿不到坐标 → 本轮不画，等下一次滚动补上；
   *  - markError 记住的标记在文档切换 / 正文替换时由 loadActive / setValue 清掉，
   *    渲染成功时由 preview 调 clearError 清掉。
   */

  let errLayer = null; // 覆盖层节点（懒建）
  let errMark = null; // { line, col }（1 基）；null = 无错误
  let errDrawTimer = 0;

  function ensureErrLayer() {
    const box = host();
    if (!box) return null;
    if (!errLayer || !errLayer.isConnected) {
      errLayer = h("div", "editor-err-layer");
      box.appendChild(errLayer);
    }
    return errLayer;
  }

  function drawErrMark() {
    if (!errMark || !inst || !inst.view) return;
    const layer = ensureErrLayer();
    if (!layer) return;
    layer.innerHTML = "";
    const v = inst.view;
    const doc = v.state.doc;
    const ln = doc.line(Math.min(Math.max(1, errMark.line), doc.lines));
    const box = host();
    const hostRect = box.getBoundingClientRect();
    const from = Math.min(ln.from + Math.max(0, (errMark.col || 1) - 1), ln.to);
    const a = v.coordsAtPos(from);
    const b = v.coordsAtPos(ln.to);
    if (!a || !b) return; // 目标行不在已渲染范围里：等滚动事件重画
    const left = Math.min(a.left, b.left) - hostRect.left;
    const right = Math.max(a.right || a.left, b.right || b.left) - hostRect.left;
    const top = Math.max(a.top, b.top) - hostRect.top;
    if (right <= left) return;
    const sq = h("div", "editor-err-squiggle");
    sq.style.left = left + "px";
    sq.style.top = top + "px";
    sq.style.width = right - left + "px";
    layer.appendChild(sq);
  }

  function scheduleErrDraw() {
    if (!errMark) return;
    clearTimeout(errDrawTimer);
    errDrawTimer = setTimeout(drawErrMark, 60);
  }

  /** 在 line:col（1 基）那一行画错误波浪线。重复调用覆盖上一次。 */
  function markError(line, col) {
    errMark = { line: line, col: col || 1 };
    scheduleErrDraw();
  }

  /** 清掉错误标记（渲染成功 / 换文档 / 换正文时调）。 */
  function clearError() {
    errMark = null;
    if (errLayer) errLayer.innerHTML = "";
  }

  /** 覆盖层的重画时机：滚动、键鼠（行高会变）、窗口缩放。字号变化走
   *  settings:changed 里那条（applyFontSize 之后补一次）。 */
  function watchErrMark() {
    if (!inst || !inst.view) return;
    inst.view.scrollDOM.addEventListener("scroll", scheduleErrDraw, { passive: true });
    ["keyup", "mouseup"].forEach((ev) => inst.view.dom.addEventListener(ev, scheduleErrDraw));
    window.addEventListener("resize", scheduleErrDraw);
  }

  /* ------------------------------------------------------------------ 配色标注层（行首色块 / 行底色）

   *  配色是**渲染期**上色（正文里没有色值），所以源码窗口要另画一层提示：
   *  每个"会被上色的节点"在它**首次出现的那一行**左侧点一个色块，颜色 = 它会被染成的颜色；
   *  带手写颜色（会被跳过）的节点画虚线框。可选再铺一层行底色（默认关，见设置）。
   *
   *  为什么坐标靠 DOM 覆盖层：vendor 只对外暴露 {create, LANGUAGES}，CM6 的装饰拿不到
   *  （错误波浪线同理）。位置用 view.coordsAtPos 算，滚动/输入/缩放时重画。
   *  "行 → 角色"由后端算（`palette_annotate`）：角色是推断出来的，前端再算一遍就是第二套规则。
   */
  let swLayer = null;
  let tintLayer = null;
  let ann = [];          // [{line, nodes:[{id, role}]}]
  let annKey = { id: "", body: "", scheme: "" };
  let annDrawTimer = 0;
  let annSeq = 0;

  function ensureSwLayer() {
    const box = host();
    if (!box) return null;
    if (!swLayer || !swLayer.isConnected) {
      swLayer = h("div", "editor-swatch-layer");
      box.appendChild(swLayer);
    }
    if (!tintLayer || !tintLayer.isConnected) {
      tintLayer = h("div", "editor-tint-layer");
      box.insertBefore(tintLayer, box.firstChild); // 放最前面，配合负 z-index 落在文字下面
    }
    return swLayer;
  }

  /** 重新取一次"行 → 角色"（正文 / 色系变了才走 IPC，其余情况只重画）。 */
  async function refreshAnnotate() {
    const d = state.activeDoc();
    const scheme = d && state.schemeOf ? state.schemeOf(d) : "";
    if (!d || !state.isTextDoc(d) || !scheme) {
      ann = [];
      annKey = { id: d ? d.id : "", body: d ? d.body : "", scheme };
      drawSwatches();
      return;
    }
    if (annKey.id === d.id && annKey.body === d.body && annKey.scheme === scheme) {
      drawSwatches();
      return;
    }
    const mine = ++annSeq;
    let lines = [];
    try {
      lines = await ipc.invoke("palette_annotate", {
        req: {
          body: d.body,
          format: d.format,
          dark: document.documentElement.dataset.theme === "dark",
        },
      });
    } catch (e) {
      lines = []; // 解析不了 / mock 里没有实现：不画，也不打扰用户（预览那边会报真错）
    }
    if (mine !== annSeq) return; // 期间正文又变了
    ann = Array.isArray(lines) ? lines : [];
    annKey = { id: d.id, body: d.body, scheme };
    drawSwatches();
  }

  /** 节点的色块取色：**后端已经算好了**（`fill`/`stroke`）。
   *
   *  为什么不再查角色表：颜色现在有两个来源（角色槽位 + 分组色轮），
   *  前端再实现一遍色轮就是第二套规则；后端连槽位带色值一起返回，这里只负责画。 */
  function nodeSwatch(n) {
    if (!n || !n.fill || !n.stroke) return null;
    return { fill: n.fill, stroke: n.stroke };
  }

  /** 按当前视口画标记。视口外的行 coordsAtPos 拿不到坐标，跳过等下次滚动。 */
  function drawSwatches() {
    if (!inst || !inst.view) return;
    const layer = ensureSwLayer();
    if (!layer) return;
    layer.innerHTML = "";
    if (tintLayer) tintLayer.innerHTML = "";
    const d = state.activeDoc();
    // 没选色系就没有"会被染成什么色"这回事
    if (!d || !ann.length) return;
    const scheme = state.schemeOf ? state.schemeOf(d) : "";
    if (!scheme) return;
    const tintOn = !!(state.settings && state.settings.editor && state.settings.editor.source_tint);
    const v = inst.view;
    const box = host();
    const hostRect = box.getBoundingClientRect();
    const doc = v.state.doc;
    const lineH = v.defaultLineHeight || 21;
    for (const row of ann) {
      if (!row.nodes || !row.nodes.length) continue;
      const ln = doc.line(Math.min(Math.max(1, row.line), doc.lines));
      const a = v.coordsAtPos(ln.from);
      if (!a) continue; // 不在已渲染范围
      const top = a.top - hostRect.top;
      const left = a.left - hostRect.left;
      if (top + lineH < 0 || top > hostRect.height) continue;
      const first = row.nodes.find((n) => n.role) || row.nodes[0];
      const c = nodeSwatch(first);
      // 行底色（可选）：先铺，色块盖在上面
      if (tintOn && c && tintLayer) {
        const t = h("div", "editor-swatch-tint");
        t.style.top = Math.round(top) + "px";
        t.style.height = Math.round(lineH) + "px";
        t.style.background = c.fill;
        // 画在文字下面了，可以给足颜色；仍留一点透明让"当前行/选中行"还能看出来
        t.style.opacity = document.documentElement.dataset.theme === "dark" ? "0.55" : "0.75";
        tintLayer.appendChild(t);
      }
      const dot = h("div", "editor-swatch" + (c ? "" : " hand"));
      dot.style.top = Math.round(top + (lineH - 8) / 2) + "px";
      dot.style.left = Math.round(left - 11) + "px";
      if (c) {
        dot.style.background = c.fill;
        dot.style.boxShadow = "inset 0 0 0 1px " + c.stroke;
      }
      // 槽位 `g0/g1/…` 是分组色轮，直接展示槽位名对用户没意义
      const slotLabel = (r) => (/^g\d+$/.test(r) ? t("palette.groupSlot") : r);
      dot.title =
        row.nodes
          .map((n) => (n.role ? `${n.id} · ${slotLabel(n.role)}` : `${n.id} · ${t("palette.handColor")}`))
          .join("  ") + (c ? `\n${c.fill} / ${c.stroke}` : "");
      layer.appendChild(dot);
    }
  }

  function scheduleSwatches() {
    clearTimeout(annDrawTimer);
    annDrawTimer = setTimeout(() => {
      // 异步取标注：失败不该变成未处理拒绝（预览那边会报真正的原因）
      refreshAnnotate().catch(() => {});
    }, 70);
  }

  /** 「行底色」开关：改的是全局设置（设置 → 编辑器 里同一个开关），不是单文档偏好。 */
  function bindTintButton() {
    const btn = $("#btn-tint");
    if (!btn) return;
    const sync = () => {
      const on = !!(state.settings && state.settings.editor && state.settings.editor.source_tint);
      btn.classList.toggle("on", on);
      btn.title = t(on ? "src.tintOn" : "src.tintTip");
    };
    btn.addEventListener("click", () => {
      const on = !!(state.settings && state.settings.editor && state.settings.editor.source_tint);
      state.patchSettings({ editor: { source_tint: !on } });
    });
    DGM.bus.on("settings:changed", sync);
    sync();
  }

  /** 覆盖层重画时机：与错误层同一套（滚动 / 键鼠 / 窗口缩放）。 */
  function watchSwatches() {
    if (!inst || !inst.view) return;
    inst.view.scrollDOM.addEventListener("scroll", () => scheduleSwatches(), { passive: true });
    ["keyup", "mouseup"].forEach((ev) => inst.view.dom.addEventListener(ev, () => scheduleSwatches()));
    window.addEventListener("resize", () => scheduleSwatches());
  }

  /* ------------------------------------------------------------------ 查找面板本地化 */

  /**
   * 源码窗口里 CodeMirror 自带的「查找替换」面板是**英文硬编码**的（Find / Replace /
   * next / match case …）。vendor bundle 是压过的随包资产、也没把 CM 的 `phrases`
   * 选项透出来，所以在应用层按面板的 `name` 属性改写文案：
   *
   *   [name=search]/[name=replace]  输入框的 placeholder 与 aria-label
   *   [name=next]/[prev]/[select]/[replace]/[replaceAll]  按钮文字
   *   [name=case]/[re]/[word]       复选框所在的 <label> 里那个文本节点
   *   [name=close]                  关闭按钮的 aria-label / title
   *
   * 这些 `name` 是 CM 面板的稳定契约（`ui_probe` 与截图都在用同一套），升级后若真变了，
   * 这里只会**静默不生效**（界面回到英文），不会把面板弄坏。幂等：重复调用无副作用。
   *
   * 已知缺口：CM 用 `phrases` 做的那句 aria-live 播报（"replaced N matches"）改不到 ——
   * 那是读屏软件才听到的，且要动 vendor 才能改，先记着。
   */
  const PANEL_TEXT = {
    next: "search.next",
    prev: "search.prev",
    select: "search.all",
    replaceAll: "search.replaceAll",
  };
  const PANEL_LABEL = { case: "search.case", re: "search.regexp", word: "search.word" };
  const PLACEHOLDER = { search: "search.find", replace: "search.replace" };

  function localizeSearchPanel() {
    const root = host();
    if (!root) return;
    const panel = root.querySelector(".cm-search");
    if (!panel) return;

    for (const [name, key] of Object.entries(PANEL_TEXT)) {
      const b = panel.querySelector(`button[name="${name}"]`);
      if (b) b.textContent = t(key);
    }
    // `[name=replace]` 既是输入框也是按钮：按标签名分开处理
    const replaceBtn = panel.querySelector('button[name="replace"]');
    if (replaceBtn) replaceBtn.textContent = t("search.replaceDo");

    for (const [name, key] of Object.entries(PLACEHOLDER)) {
      const i = panel.querySelector(`input[name="${name}"]`);
      if (!i) continue;
      i.setAttribute("placeholder", t(key));
      i.setAttribute("aria-label", t(key));
    }
    for (const [name, key] of Object.entries(PANEL_LABEL)) {
      const cb = panel.querySelector(`input[name="${name}"]`);
      const label = cb && cb.closest("label");
      if (!label) continue;
      const textNode = [...label.childNodes].find((n) => n.nodeType === Node.TEXT_NODE);
      if (textNode) textNode.nodeValue = t(key);
    }
    const close = panel.querySelector('button[name="close"]');
    if (close) {
      close.setAttribute("aria-label", t("search.close"));
      close.setAttribute("title", t("search.close"));
    }
  }

  /** 面板可能在编辑器创建时就存在（`search({top:true})` 会先建好、藏起来），
   *  也可能在关闭后被重建 —— 盯一下 host 的新增节点，出现 `.cm-search` 就翻译一次。 */
  function watchSearchPanel() {
    const root = host();
    if (!root || typeof MutationObserver === "undefined") return;
    new MutationObserver((records) => {
      for (const r of records) {
        for (const n of r.addedNodes) {
          if (n.nodeType === 1 && (n.classList.contains("cm-search") || n.querySelector?.(".cm-search"))) {
            localizeSearchPanel();
            return;
          }
        }
      }
    }).observe(root, { childList: true, subtree: true });
  }

  function openSearch() {
    if (inst && inst.openSearch) {
      inst.openSearch();
      // 面板刚显示出来：立刻翻译（首次创建时 observer 也会兜底）
      localizeSearchPanel();
    } else if (!hasVendor()) DGM.toast({ icon: "search", title: t("src.find"), sub: t("common.notWired") });
  }

  function focus() {
    if (inst) inst.focus();
    else if (fallback) fallback.focus();
  }

  function getValue() {
    if (inst) return inst.getValue();
    if (fallback) return fallback.value;
    return state.activeDoc() ? state.activeDoc().body : "";
  }

  /** 只更新编辑器内容（不动 state）。 */
  function setValue(text) {
    if (inst) inst.setValue(text || "");
    else if (fallback) fallback.value = text || "";
    clearError(); // 正文被整块替换：旧标记的坐标全部作废
    annKey = { id: "", body: "", scheme: "" };
    scheduleSwatches(); // 行号全变了，标注要重算
  }

  /** 整块替换正文：落盘 + 刷新编辑器与派生数据（AI 应用 / 格式化用）。 */
  /** 把一段正文写进编辑器。`opts.hold = true` ⇒ 只留缓冲区，不触发自动保存。 */
  async function applyBody(text, opts) {
    const d = state.activeDoc();
    if (!d) return;
    setValue(text);
    await state.setBodyNow(d.id, text, opts);
    if (DGM.preview && DGM.preview.schedule) DGM.preview.schedule();
  }

  /** 当前选区文本（AI「改这段」用），无选区时返回空串。 */
  function selectionText() {
    if (!inst || !inst.view) return "";
    const v = inst.view;
    const r = v.state.selection.main;
    return r.empty ? "" : v.state.sliceDoc(r.from, r.to);
  }

  function caretLine() {
    const c = readCaret();
    return c ? c.line : 1;
  }

  /** 光标位置 `{line, col}`（1 基；行/列与状态栏同一口径）。
   *
   *  与 `caretLine()` 同源，区别是这里连列一起给 —— 状态栏读到的是 `state.setCaret`
   *  的**节流**结果（60ms，且由 keyup/mouseup 触发），拿它判"刚按完键光标在哪"会读到
   *  上一个动作的值（探针 2026-10-18 就被它骗过一次）。 */
  function caret() {
    return readCaret();
  }

  /* ------------------------------------------------------------------ 绑定 */

  function bind() {
    const f = $("#btn-format");
    if (f) f.addEventListener("click", () => DGM.shell.formatSource());
    const find = $("#btn-find");
    if (find) find.addEventListener("click", openSearch);
    const ai = $("#btn-src-ai");
    if (ai) {
      ai.addEventListener("click", () => {
        const sel = selectionText();
        DGM.ai.focus("review");
        if (sel) DGM.ai.attachSelection(sel);
      });
    }
    const hide = $("#btn-hide-source");
    if (hide) hide.addEventListener("click", () => DGM.shell.setMode("preview"));
    const show = $("#btn-show-source");
    if (show) show.addEventListener("click", () => DGM.shell.setMode("source"));
    // 切语言时把已打开的查找面板跟着翻（面板是 CM 画的，不会自己重渲染）
    if (DGM.i18n && DGM.i18n.onChange) DGM.i18n.onChange(() => localizeSearchPanel());
  }

  /* 设置变化里字号/默认视图可能变 → 重新应用字号；文档切换交给 main/shell 调 loadActive。 */
  bindTintButton();

  DGM.bus.on("settings:changed", () => {
    applyFontSize();
    scheduleErrDraw(); // 字号变了行高就变，错误标记要按新几何重画
    scheduleSwatches(); // 行底色开关 / 色系 / 主题都可能变了
  });
  // 换色系改的是文档级字段（doc:changed），标注的颜色要跟着换
  DGM.bus.on("doc:changed", () => scheduleSwatches());

  DGM.editor = {
    loadActive,
    reload: loadActive,
    gotoLine,
    jumpTo,
    markError,
    refreshSwatches: () => scheduleSwatches(),
    clearError,
    openSearch,
    focus,
    getValue,
    setValue,
    applyBody,
    selectionText,
    caretLine,
    caret,
    bind,
    isFallback: () => !hasVendor(),
  };
})();

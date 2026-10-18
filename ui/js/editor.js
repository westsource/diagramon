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
  }

  /** 整块替换正文：落盘 + 刷新编辑器与派生数据（AI 应用 / 格式化用）。 */
  async function applyBody(text) {
    const d = state.activeDoc();
    if (!d) return;
    setValue(text);
    await state.setBodyNow(d.id, text);
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
        DGM.ai.focus("chat");
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
  DGM.bus.on("settings:changed", applyFontSize);

  DGM.editor = {
    loadActive,
    reload: loadActive,
    gotoLine,
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

/* 源码窗口：CodeMirror 6 外壳（vendor 里的 window.DGMEditor）。
 *
 * - 一个共享实例常驻 #editor-host；切标签时 setLanguage + setValue（带 guard，
 *   程序化写入不触发 onChange，避免把回填当作用户输入二次落盘）。
 * - 光标/选区：vendor 不回调 selectionchange，这里自己挂在 view.dom 上读
 *   state.selection，经节流后写 state.setCaret（→ doc_set_caret）。
 * - 字体大小读 settings.editor.font_size，经 --editor-fs 下发。
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

  function openSearch() {
    if (inst && inst.openSearch) inst.openSearch();
    else if (!hasVendor()) DGM.toast({ icon: "search", title: t("src.find"), sub: t("common.notWired") });
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
    bind,
    isFallback: () => !hasVendor(),
  };
})();

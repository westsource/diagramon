// 编辑器抽象层：优先用打包好的 CodeMirror（`window.DGMEditor`），拿不到时退回纯 textarea。
//
// 之所以保留回退：vendor 产物缺失时应用仍应能编辑（只是没有高亮），而不是整页报错。

(function () {
  const state = { host: null, handle: null, onChange: null, doc: "", language: "mermaid" };

  function cm() {
    return window.DGMEditor && typeof window.DGMEditor.create === "function" ? window.DGMEditor : null;
  }

  function createCodeMirror(host) {
    return window.DGMEditor.create(host, {
      doc: state.doc,
      language: state.language,
      onChange: (v) => state.onChange && state.onChange(v),
    });
  }

  function createTextarea(host) {
    const ta = document.createElement("textarea");
    ta.id = "editor";
    ta.spellcheck = false;
    ta.autocomplete = "off";
    ta.wrap = "off";
    ta.value = state.doc;
    ta.addEventListener("input", () => state.onChange && state.onChange(ta.value));
    host.appendChild(ta);
    return {
      getValue: () => ta.value,
      setValue: (v) => {
        ta.value = v;
      },
      setLanguage: () => {},
      focus: () => ta.focus(),
      openSearch: () => false,
      destroy: () => ta.remove(),
    };
  }

  DGM.editor = {
    mount(host) {
      state.host = host;
      if (!state.handle) state.handle = cm() ? createCodeMirror(host) : createTextarea(host);
    },
    getValue() {
      return state.handle ? state.handle.getValue() : state.doc;
    },
    setValue(value) {
      state.doc = value;
      if (state.handle) state.handle.setValue(value);
    },
    /** 切换语法（按标签格式）。 */
    setLanguage(format) {
      state.language = format || "mermaid";
      if (state.handle && state.handle.setLanguage) state.handle.setLanguage(state.language);
    },
    onChange(cb) {
      state.onChange = cb;
    },
    focus() {
      if (state.handle) state.handle.focus();
    },
    /** 定位到某一行（渲染报错用）；返回实际行号，0 表示后端不支持。 */
    revealLine(line) {
      if (state.handle && state.handle.revealLine) return state.handle.revealLine(line);
      return 0;
    },
    /** 打开查找/替换面板；返回是否可用（textarea 回退下不可用）。 */
    openSearch() {
      return state.handle && state.handle.openSearch ? state.handle.openSearch() : false;
    },
    usingCodeMirror() {
      return Boolean(cm());
    },
  };
})();

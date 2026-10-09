// 编辑器抽象层：外壳只依赖这套接口，具体实现（纯 textarea / CodeMirror）可替换。
//
// 之所以先立接口：语法高亮与查找替换会换掉底层实现，外壳不应跟着改。

(function () {
  const state = { host: null, textarea: null, onChange: null, suppress: false };

  function ensure() {
    if (state.textarea || !state.host) return;
    const ta = document.createElement("textarea");
    ta.id = "editor";
    ta.spellcheck = false;
    ta.autocomplete = "off";
    ta.wrap = "off";
    ta.addEventListener("input", () => {
      if (!state.suppress && state.onChange) state.onChange(ta.value);
    });
    state.host.appendChild(ta);
    state.textarea = ta;
  }

  DGM.editor = {
    /** 挂载到宿主元素；可重复调用（幂等）。 */
    mount(host) {
      state.host = host;
      ensure();
    },
    getValue() {
      ensure();
      return state.textarea ? state.textarea.value : "";
    },
    /** 程序化设置正文（不触发 onChange）。 */
    setValue(value) {
      ensure();
      if (!state.textarea) return;
      state.suppress = true;
      state.textarea.value = value;
      state.suppress = false;
    },
    onChange(cb) {
      state.onChange = cb;
    },
    focus() {
      ensure();
      if (state.textarea) state.textarea.focus();
    },
    /** 切换标签页时的失焦/脏标刷新钩子（实现可覆写）。 */
    refresh() {},
  };
})();

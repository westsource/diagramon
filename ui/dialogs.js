// 模态对话框（纯 DOM，无依赖）：保存确认三键、退出确认。
//
// 之所以不用浏览器原生 `confirm`：它只有两键，无法表达「保存 / 不保存 / 取消」，
// 与既有客户端的 SaveChangesDialog 语义不对等。

(function () {
  let overlay = null;

  function ensureOverlay() {
    if (overlay) return overlay;
    overlay = document.createElement("div");
    overlay.className = "modal-overlay";
    overlay.hidden = true;
    overlay.innerHTML = `
      <div class="modal" role="dialog" aria-modal="true">
        <div class="modal-title"></div>
        <div class="modal-body"></div>
        <div class="modal-actions"></div>
      </div>`;
    document.body.appendChild(overlay);
    return overlay;
  }

  /**
   * 弹一个模态框。
   * @param {{title:string, body?:string, buttons:Array<{id:string,label:string,kind?:string}>}} spec
   * @returns {Promise<string>} 被点击按钮的 id（按 Esc 关闭时返回最后一个 kind==='cancel' 的按钮 id）
   */
  function show(spec) {
    const root = ensureOverlay();
    root.querySelector(".modal-title").textContent = spec.title;
    const body = root.querySelector(".modal-body");
    body.textContent = spec.body || "";
    body.hidden = !spec.body;

    const actions = root.querySelector(".modal-actions");
    actions.innerHTML = "";

    return new Promise((resolve) => {
      let done = false;
      const finish = (id) => {
        if (done) return;
        done = true;
        root.hidden = true;
        document.removeEventListener("keydown", onKey, true);
        resolve(id);
      };

      for (const btn of spec.buttons) {
        const node = document.createElement("button");
        node.className = `modal-btn${btn.kind ? ` ${btn.kind}` : ""}`;
        node.textContent = btn.label;
        node.addEventListener("click", () => finish(btn.id));
        actions.appendChild(node);
      }

      const cancelBtn = spec.buttons.find((b) => b.kind === "cancel");
      function onKey(e) {
        if (e.key === "Escape") {
          e.preventDefault();
          finish(cancelBtn ? cancelBtn.id : "__dismiss");
        }
      }
      document.addEventListener("keydown", onKey, true);

      root.hidden = false;
      const primary = actions.querySelector(".primary") || actions.firstElementChild;
      if (primary) primary.focus();
    });
  }

  DGM.dialogs = {
    init() {
      ensureOverlay();
    },
    show,

    /** 关闭未保存标签页的三键确认。 */
    async saveChanges(title) {
      const id = await show({
        title: "未保存的更改",
        body: `「${title}」有未保存的更改。`,
        buttons: [
          { id: "save", label: "保存", kind: "primary" },
          { id: "discard", label: "不保存" },
          { id: "cancel", label: "取消", kind: "cancel" },
        ],
      });
      return id === "save" || id === "discard" ? id : "cancel";
    },

    /** 退出前对 N 个未保存标签页的确认。 */
    async confirmQuit(count) {
      const id = await show({
        title: "退出 Diagramon",
        body: `有 ${count} 个标签页尚未保存，确定退出吗？`,
        buttons: [
          { id: "quit", label: "退出", kind: "primary" },
          { id: "cancel", label: "取消", kind: "cancel" },
        ],
      });
      return id === "quit";
    },
  };
})();

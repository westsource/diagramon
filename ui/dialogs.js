// 模态对话框（纯 DOM，无依赖）：保存确认三键、退出确认、关于、操作说明、打开历史。
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
   * @param {{title:string, body?:string, buttons?:Array, build?:Function, wide?:boolean}} spec
   * @returns {Promise<string>} 被点击按钮的 id（按 Esc 关闭时返回最后一个 kind==='cancel' 的按钮 id）
   */
  function show(spec) {
    const root = ensureOverlay();
    root.querySelector(".modal-title").textContent = spec.title;

    const body = root.querySelector(".modal-body");
    body.textContent = "";
    body.className = "modal-body" + (spec.bodyClass ? ` ${spec.bodyClass}` : "");
    if (spec.build) {
      spec.build(body);
      body.hidden = false;
    } else {
      body.textContent = spec.body || "";
      body.hidden = !spec.body;
    }

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

      for (const btn of spec.buttons || []) {
        const node = document.createElement("button");
        node.className = `modal-btn${btn.kind ? ` ${btn.kind}` : ""}`;
        node.textContent = btn.label;
        node.addEventListener("click", () => finish(btn.id));
        actions.appendChild(node);
      }

      const cancelBtn = (spec.buttons || []).find((b) => b.kind === "cancel");
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
      if (spec.afterRender) spec.afterRender(root);
    });
  }

  const t = (k, v) => DGM.i18n.t(k, v);

  DGM.dialogs = {
    init() {
      ensureOverlay();
    },
    show,

    /** 关闭未保存标签页的三键确认。 */
    async saveChanges(title) {
      const id = await show({
        title: t("unsavedTitle"),
        body: t("unsavedBody", { name: title }),
        buttons: [
          { id: "save", label: t("save"), kind: "primary" },
          { id: "discard", label: t("dontSave") },
          { id: "cancel", label: t("cancel"), kind: "cancel" },
        ],
      });
      return id === "save" || id === "discard" ? id : "cancel";
    },

    /** 退出前对 N 个未保存标签页的确认。 */
    async confirmQuit(count) {
      const id = await show({
        title: t("quitTitle"),
        body: t("quitBody", { n: count }),
        buttons: [
          { id: "quit", label: t("quit"), kind: "primary" },
          { id: "cancel", label: t("cancel"), kind: "cancel" },
        ],
      });
      return id === "quit";
    },

    /** 关于。 */
    async about(info) {
      const lines = [
        t("aboutBody"),
        "",
        `${t("version")}: ${info.version}`,
        `${t("platform")}: ${info.platform}`,
      ];
      await show({
        title: `${info.name}`,
        body: lines.join("\n"),
        buttons: [{ id: "ok", label: "OK", kind: "primary" }],
      });
    },

    /** 操作说明（正文随包，按语言取）。 */
    async guide() {
      const text = t("guideBody");
      await show({
        title: t("guide"),
        bodyClass: "guide",
        build: (el) => {
          // 极简 markdown：# 标题、- 列表，其余按段落
          for (const raw of text.split("\n")) {
            const line = raw.trimEnd();
            if (!line.trim()) {
              el.appendChild(document.createElement("div"));
            } else if (line.startsWith("## ")) {
              const h = document.createElement("h4");
              h.textContent = line.slice(3);
              el.appendChild(h);
            } else if (line.startsWith("# ")) {
              const h = document.createElement("h3");
              h.textContent = line.slice(2);
              el.appendChild(h);
            } else if (line.startsWith("- ")) {
              const li = document.createElement("div");
              li.textContent = `• ${line.slice(2)}`;
              el.appendChild(li);
            } else {
              const p = document.createElement("div");
              p.textContent = line;
              el.appendChild(p);
            }
          }
        },
        buttons: [{ id: "ok", label: "OK", kind: "primary" }],
      });
    },

    /**
     * 打开历史：搜索过滤 + 双击打开。
     * @param {Array<{path:string,title:string}>} entries
     * @returns {Promise<string|null>} 选中的路径
     */
    history(entries) {
      let picked = null;
      return show({
        title: t("historyTitle"),
        bodyClass: "guide",
        build: (el) => {
          const search = document.createElement("input");
          search.className = "history-search";
          search.placeholder = t("historySearch");
          el.appendChild(search);

          const list = document.createElement("div");
          list.className = "history-list";
          el.appendChild(list);

          const render = (filter) => {
            list.innerHTML = "";
            const needle = String(filter || "").toLowerCase();
            const shown = entries.filter(
              (e) => !needle || e.title.toLowerCase().includes(needle) || e.path.toLowerCase().includes(needle),
            );
            if (!shown.length) {
              const empty = document.createElement("div");
              empty.className = "p";
              empty.textContent = t("recentEmpty");
              list.appendChild(empty);
              return;
            }
            for (const e of shown) {
              const row = document.createElement("button");
              row.className = "history-row";
              const name = document.createElement("span");
              name.textContent = e.title || e.path;
              const p = document.createElement("span");
              p.className = "p";
              p.textContent = e.path;
              row.appendChild(name);
              row.appendChild(p);
              row.addEventListener("dblclick", () => {
                picked = e.path;
                const ok = document.querySelector(".modal-actions .primary");
                if (ok) ok.click();
              });
              row.addEventListener("click", () => {
                for (const other of list.querySelectorAll(".history-row")) other.classList.remove("selected");
                row.classList.add("selected");
                picked = e.path;
              });
              list.appendChild(row);
            }
          };

          render("");
          search.addEventListener("input", () => render(search.value));
          setTimeout(() => search.focus(), 0);
        },
        buttons: [
          { id: "open", label: t("open"), kind: "primary" },
          { id: "cancel", label: t("cancel"), kind: "cancel" },
        ],
      }).then((id) => (id === "open" && picked ? picked : null));
    },
  };
})();

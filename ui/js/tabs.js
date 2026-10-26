/* 标签页：格式色圆点 + 脏标 + 中键/右键关闭 + 新建；
 * 视图模式三态切换器（文本型给三态，画布型显式「画布即编辑器」）。
 *
 * 关闭一律经 shell.closeDocWithConfirm：脏文档弹出「保存 / 不保存 / 取消」三键确认。
 */
window.DGM = window.DGM || {};
(function () {
  "use strict";

  const state = DGM.state;
  const t = (k, v) => DGM.i18n.t(k, v);
  const icon = DGM.icon;
  const { $, h, esc } = DGM.dom;

  const MODE_BTNS = [
    { m: "source", icon: "code", label: "viewmode.source", tip: "viewmode.source.tip" },
    { m: "split", icon: "splitV", label: "viewmode.split", tip: "viewmode.split.tip" },
    { m: "preview", icon: "eye", label: "viewmode.preview", tip: "viewmode.preview.tip" },
  ];

  /* ------------------------------------------------------------------ 标签条 */

  /** 溢出渐隐：按滚动位置给两端挂 mask，让"左边/右边还有标签"可见。
   *  之前滚动条被故意藏掉又没有任何指示，标签一多看不见的就是真看不见。 */
  function updateFade() {
    const box = $("#tabs");
    if (!box) return;
    const max = box.scrollWidth - box.clientWidth;
    box.classList.toggle("fade-left", max > 0 && box.scrollLeft > 2);
    box.classList.toggle("fade-right", max > 0 && box.scrollLeft < max - 2);
  }

  /** 把激活标签滚进视野（手动改 scrollLeft，不用 scrollIntoView ——
   *  后者会连带滚动祖先容器，可能把整页顶歪）。 */
  function revealActive() {
    const box = $("#tabs");
    const on = box && box.querySelector(".tab.on");
    if (!on) return;
    const r = on.getBoundingClientRect();
    const b = box.getBoundingClientRect();
    if (r.left < b.left) box.scrollLeft += r.left - b.left - 8;
    else if (r.right > b.right) box.scrollLeft += r.right - b.right + 8;
    updateFade();
  }

  /** Ctrl+Tab / Ctrl+PgUp/PgDn：沿标签顺序循环切换（shift 反向）。 */
  function cycle(dir) {
    if (state.docs.length < 2) return;
    const i = state.docs.findIndex((d) => d.id === state.active);
    const next = state.docs[(i + dir + state.docs.length) % state.docs.length];
    state.activateDoc(next.id).then(() => {
      if (DGM.editor && DGM.editor.loadActive) DGM.editor.loadActive();
      if (DGM.preview && DGM.preview.schedule) DGM.preview.schedule();
      state.refreshDerived(next.id);
    });
  }

  function renderTabs() {
    const box = $("#tabs");
    if (!box) return;
    box.innerHTML = "";
    for (const d of state.docs) {
      const on = d.id === state.active;
      const tab = h("div", "tab" + (on ? " on" : ""));
      tab.style.setProperty("--tab-accent", `var(--fmt-${d.format})`);
      tab.title = d.path || t("tab.noPath");
      tab.innerHTML =
        `<span class="fmt-dot"></span><span class="nm">${esc(d.name)}</span>` +
        (d.dirty ? `<span class="dirty" title="${esc(t("tab.dirty"))}"></span>` : "") +
        `<button class="x" title="${esc(t("tab.close"))}">${icon("close", "ico-sm")}</button>`;
      tab.addEventListener("click", (e) => {
        if (e.target.closest(".x")) return DGM.shell.closeDocWithConfirm(d.id);
        state.activateDoc(d.id).then(() => {
          if (DGM.editor && DGM.editor.loadActive) DGM.editor.loadActive();
          if (DGM.preview && DGM.preview.schedule) DGM.preview.schedule();
          state.refreshDerived(d.id);
        });
      });
      tab.addEventListener("auxclick", (e) => {
        if (e.button === 1) {
          e.preventDefault();
          DGM.shell.closeDocWithConfirm(d.id);
        }
      });
      tab.addEventListener("contextmenu", (e) => {
        e.preventDefault();
        openTabMenu(e.clientX, e.clientY, d);
      });
      box.appendChild(tab);
    }
    revealActive();
  }

  /* ------------------------------------------------------------------ 视图模式 */

  function renderViewModes() {
    const wrap = $("#viewmodes");
    if (!wrap) return;
    const d = state.activeDoc();
    wrap.innerHTML = "";
    if (!d) {
      wrap.hidden = true;
      return;
    }
    wrap.hidden = false;
    const fmt = state.docFmt(d);
    const text = fmt.split_view;
    wrap.classList.toggle("canvas-mode", !text);
    if (!text) {
      const chip = h("span", "vm-canvas");
      chip.title = t("viewmode.canvas.tip");
      chip.innerHTML = `${icon("hand", "ico-sm")}<span>${esc(t("viewmode.canvas"))}</span>`;
      wrap.appendChild(chip);
    } else {
      const mode = state.mode(d);
      for (const b of MODE_BTNS) {
        const n = h("button", mode === b.m ? "on" : "");
        n.dataset.mode = b.m;
        n.title = t(b.tip);
        n.innerHTML = `${icon(b.icon, "ico-sm")}<span>${esc(t(b.label))}</span>`;
        n.addEventListener("click", () => DGM.shell.setMode(b.m));
        wrap.appendChild(n);
      }
    }
    // 画布型隐藏源码相关按钮（它们在编辑区头部）
    for (const id of ["#btn-hide-source", "#btn-show-source", "#btn-format", "#btn-src-ai"]) {
      const n = $(id);
      if (n) n.hidden = !text;
    }
    // 「转换为」近入口：没文档就藏（与 viewmodes 同进退）
    const conv = $("#tab-convert");
    if (conv) conv.hidden = !d;
  }

  /* ------------------------------------------------------------------ 标签菜单 */

  function openTabMenu(x, y, d) {
    const isActive = d.id === state.active;
    const items = [
      { label: t("tab.explain"), icon: "diagram", act: "explain" },
      { sep: true },
      { label: t("tab.close"), icon: "close", act: "close" },
      { label: t("tab.closeOthers"), icon: "close", act: "others" },
      { label: t("tab.closeAll"), icon: "trash", act: "all" },
      { sep: true },
      { label: t("tab.copyPath"), icon: "copy", act: "path", disabled: !d.path },
      { label: t("tab.reveal"), icon: "folderOpen", act: "reveal", disabled: !d.path },
    ];
    let activated = null;
    if (!isActive) {
      activated = Promise.resolve(state.activateDoc(d.id)).then(() => {
        if (DGM.editor && DGM.editor.loadActive) DGM.editor.loadActive();
        if (DGM.preview && DGM.preview.schedule) DGM.preview.schedule();
      });
    }
    DGM.pop.show(items, { x, y }, (it) => {
      DGM.pop.hide();
      if (it.act === "close") DGM.shell.closeDocWithConfirm(d.id);
      else if (it.act === "others") closeMany(state.docs.filter((x2) => x2.id !== d.id).map((x2) => x2.id));
      else if (it.act === "all") closeMany(state.docs.map((x2) => x2.id));
      else if (it.act === "path") copyPath(d.path);
      else if (it.act === "explain") {
        // 对**右键的那份**文档解读（不是右键时碰巧活动的另一份）：等激活落地再发
        Promise.resolve(activated || true).then(() => DGM.ai.explain());
      } else if (it.act === "reveal") DGM.toast({ icon: "folderOpen", title: t("tab.reveal"), sub: t("common.notWired") });
    });
  }

  async function closeMany(ids) {
    for (const id of ids) {
      if (!state.doc(id)) continue;
      await DGM.shell.closeDocWithConfirm(id);
    }
  }

  function copyPath(path) {
    if (!path) return;
    const done = () => DGM.toast({ icon: "copy", title: t("tab.copyPath"), sub: path });
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(path).then(done).catch(done);
    } else {
      done();
    }
  }

  /* ------------------------------------------------------------------ 绑定 */

  function bind() {
    const tabs = $("#tabs");
    if (tabs) {
      // 滚轮直接横滚标签栏（笔记本触摸板的 deltaX 天然可用）；
      // 垂直 delta 才转成横向 —— 避免吃掉其它滚动
      tabs.addEventListener(
        "wheel",
        (e) => {
          if (Math.abs(e.deltaY) >= Math.abs(e.deltaX)) {
            tabs.scrollLeft += e.deltaY;
            e.preventDefault();
          }
        },
        { passive: false },
      );
      tabs.addEventListener("scroll", updateFade, { passive: true });
      window.addEventListener("resize", updateFade);
    }
    const add = $("#tab-add");
    if (add) add.addEventListener("click", () => DGM.dialogs.newDoc());
    // 「转换为」近入口：动线从"画布 → 最左活动栏 → 侧栏卡片"缩短为"画布 → 标签条"。
    // 锚点必须 stopPropagation（showPop 的约定），否则弹出即被文档级监听关掉。
    const conv = $("#tab-convert");
    if (conv) {
      conv.addEventListener("click", (e) => {
        e.stopPropagation();
        if (state.activeDoc()) DGM.shell.popConvertMenu(e.currentTarget);
      });
    }
    const more = $("#tab-more");
    if (more) {
      more.addEventListener("click", (e) => {
        // 同 showPop 的约定：不停传播就是"点了没反应"（2026-10-13 探针实测它一直是死的）
        e.stopPropagation();
        const r = e.currentTarget.getBoundingClientRect();
        const d = state.activeDoc();
        if (d) openTabMenu(r.left, r.bottom + 4, d);
        else DGM.dialogs.newDoc();
      });
    }
  }

  DGM.bus.on("session:changed", () => {
    renderTabs();
    renderViewModes();
  });
  DGM.bus.on("settings:changed", renderViewModes);

  DGM.tabs = { render: renderTabs, renderViewModes, bind, cycle, updateFade };
})();

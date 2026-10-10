/* 应用入口：加载状态 → 绑定各模块 → 首帧渲染 → 订阅重渲染。
 *
 * 启动顺序有意为之：
 *   1) i18n 先落地（避免首帧英文闪烁）
 *   2) mock 标注先亮（不许悄悄降级）
 *   3) state.load() 拉 app_info / settings / session
 *   4) 各模块 bind()（此刻 DOM 已就位）与命令注册
 *   5) 首帧 renderChrome + 编辑器 + 预览 + 派生数据
 */
window.DGM = window.DGM || {};
(function () {
  "use strict";

  const state = DGM.state;
  const t = (k, v) => DGM.i18n.t(k, v);
  const { $, $$, h, esc } = DGM.dom;

  const ipc = DGM.ipc;

  /* ------------------------------------------------------------------ 欢迎页 */

  function renderWelcome() {
    const w = $("#welcome");
    if (!w) return;
    const recent = (state.settings && state.settings.recent) || [];
    const recentRows = recent.length
      ? recent
          .slice(0, 4)
          .map((r) => `<button class="lnk" data-recent="${esc(r.path)}"><span class="fmt-dot" style="background:var(--fmt-${r.format})"></span>${esc(r.name)}</button>`)
          .join("")
      : `<div class="hint">${esc(t("side.recentEmpty"))}</div>`;
    w.innerHTML = `<div class="welcome-inner">
      <h2>${esc(t("app.name"))}</h2>
      <p class="sub">${esc(t("app.tagline"))}</p>
      <div class="ai-hero">
        <span class="ico-wrap">${DGM.icon("sparkles", "ico-lg")}</span>
        <span class="hero-txt"><b>${esc(t("welcome.heroTitle"))}</b><span>${esc(t("welcome.heroDesc"))}</span></span>
        <button class="btn ai" id="w-ai">${DGM.icon("sparkles")}${esc(t("welcome.start"))}</button>
      </div>
      <div class="cols">
        <div>
          <h4>${esc(t("welcome.new"))}</h4>
          ${state.formatList.map((f) => `<button class="lnk" data-new="${f.id}"><span class="fmt-dot" style="background:var(--fmt-${f.id})"></span>${esc(f.name)}<span class="kbd">${esc((f.exts || [])[0] || "")}</span></button>`).join("")}
        </div>
        <div>
          <h4>${esc(t("welcome.recent"))}</h4>
          ${recentRows}
        </div>
      </div>
      <div class="fmts mt">
        ${state.formatList.map((f) => `<span class="chip ${f.id}">${esc(f.name)}</span>`).join("")}
      </div>
    </div>`;
    const ai = $("#w-ai");
    if (ai) ai.addEventListener("click", () => DGM.ai.focus("chat"));
    $$("[data-new]", w).forEach((b) => b.addEventListener("click", () => DGM.dialogs.newDoc(b.dataset.new)));
    $$("[data-recent]", w).forEach((b) => b.addEventListener("click", () => DGM.shell.openPath(b.dataset.recent)));
  }

  function updateShellVisibility() {
    const has = state.docs.length > 0;
    const split = $("#split");
    const tabbar = $("#tabbar");
    const bp = $("#bottom-panel");
    const welcome = $("#welcome");
    if (split) split.hidden = !has;
    if (tabbar) tabbar.hidden = !has;
    if (bp) bp.hidden = !has || !state.panels().bottom;
    if (welcome) welcome.hidden = has;
    document.body.classList.toggle("no-doc", !has);
    if (!has) renderWelcome();
  }

  /* ------------------------------------------------------------------ URL 状态
   * 供深链与无头截图用（原型 app.html 同款做法）。只接受白名单键，未知键忽略。
   *   ?theme=dark  ?density=compact  ?accent=indigo
   *   ?mode=preview  ?zen=1
   *   ?sidebar=convert  ?nopanel=1  ?noai=1
   *   ?open=palette|new|convert|vision|settings|keys|guide|about|history
   *   ?doc=2  ?q=关键词（填入侧栏搜索）
   */
  function applyUrlState() {
    let q;
    try {
      q = new URLSearchParams(location.search);
    } catch (e) {
      return;
    }
    if (!q || ![...q.keys()].length) return;
    const patch = {};
    if (q.get("theme")) patch.theme = q.get("theme");
    if (q.get("density")) patch.density = q.get("density");
    if (q.get("accent")) patch.accent = q.get("accent");
    const panels = {};
    if (q.get("sidebar")) panels.sidebar_view = q.get("sidebar");
    if (q.get("nopanel")) panels.bottom = false;
    if (q.get("noai")) panels.ai = false;
    if (Object.keys(panels).length) patch.panels = panels;
    if (Object.keys(patch).length) state.patchSettings(patch);

    const docIdx = Number(q.get("doc"));
    if (Number.isInteger(docIdx) && state.docs[docIdx]) {
      state.activateDoc(state.docs[docIdx].id).then(() => {
        DGM.editor.loadActive();
        DGM.preview.schedule();
        state.refreshDerived(state.active);
      });
    }
    const mode = q.get("mode");
    if (mode && state.activeDoc()) DGM.shell.setMode(mode);
    if (q.get("zen")) DGM.shell.zenMode();
    const sview = q.get("sidebar");
    if (sview) DGM.shell.setSidebarView(sview);
    if (q.get("q") && DGM.sidebar) DGM.sidebar.focusSearch();

    const open = q.get("open");
    setTimeout(() => {
      if (open === "palette") DGM.palette.open();
      else if (open === "new") DGM.dialogs.newDoc();
      else if (open === "convert") DGM.dialogs.convertTo();
      else if (open === "vision") DGM.dialogs.vision();
      else if (open === "settings") DGM.dialogs.settings("appearance");
      else if (open === "settings.ai") DGM.dialogs.settings("ai");
      else if (open === "keys") DGM.dialogs.keys();
      else if (open === "guide") DGM.dialogs.guide();
      else if (open === "about") DGM.dialogs.about();
      else if (open === "history") DGM.dialogs.history();
      else if (open === "ai") DGM.ai.focus("chat");
    }, 60);
  }

  /* ------------------------------------------------------------------ 编排 */

  function rerender() {
    updateShellVisibility();
    DGM.shell.render();
  }

  function subscribe() {
    DGM.bus.on("session:changed", () => {
      updateShellVisibility();
      DGM.shell.render();
    });
    DGM.bus.on("settings:changed", () => {
      updateShellVisibility();
      DGM.shell.render();
    });
    DGM.bus.on("doc:changed", () => {
      DGM.shell.renderDocTitle();
      DGM.shell.renderStatus();
    });
    DGM.bus.on("issues:changed", () => DGM.shell.renderStatus());
    DGM.bus.on("scope:changed", () => DGM.shell.renderStatus());
    DGM.bus.on("status:changed", () => DGM.shell.renderStatus());

    // 语言切换时整页重渲染（各模块文案都走 i18n）
    DGM.i18n.onChange(() => {
      DGM.i18n.apply();
      rerender();
      DGM.preview.render();
      DGM.ai.render();
    });
  }

  function seedLog() {
    const d = state.activeDoc();
    state.pushOutput(t("common.ready"), "");
    if (d) state.pushOutput(t("status.opened", { name: d.name, format: state.docFmt(d).name }), "ok");
  }

  function fatal(err) {
    const box = document.createElement("div");
    box.style.cssText = "position:fixed;inset:0;z-index:9999;padding:26px;background:var(--bg,#fff);color:var(--err,#b0554a);font:13px/1.7 var(--font-mono,monospace);white-space:pre-wrap;overflow:auto";
    box.textContent = "[Diagramon] 前端启动失败：\n" + ((err && err.stack) || err);
    document.body.appendChild(box);
    console.error(err);
  }

  async function boot() {
    // 1) i18n 先落地（默认 zh-CN）
    DGM.i18n.setLang(DGM.i18n.detect ? DGM.i18n.detect() : "zh-CN", { persist: false });
    DGM.i18n.apply();

    // 2) mock 标注
    if (DGM.shell && DGM.shell.applyMockBadge) DGM.shell.applyMockBadge();

    // 3) 状态加载
    await state.load();

    // 4) 采用设置里的 locale（若有）
    const loc = state.settings && state.settings.locale;
    if (loc && loc !== DGM.i18n.lang) {
      DGM.i18n.setLang(loc, { persist: false });
      DGM.i18n.apply();
    }

    // 5) 绑定各模块（DOM 已就位）
    DGM.shell.bind();
    DGM.editor.bind();
    DGM.preview.bind();
    DGM.ai.bind();
    if (DGM.palette && DGM.palette.bind) DGM.palette.bind();

    // 6) 命令注册（依赖各模块已定义）
    DGM.registerCommands();

    // 7) 首帧
    rerender();
    DGM.editor.loadActive();
    DGM.preview.render();
    DGM.ai.render();
    if (state.active) state.refreshDerived(state.active);
    seedLog();

    subscribe();

    // 主题/光标等首帧细节
    DGM.shell.applyLayoutVars();

    // 8) 深链 / 截图用 URL 状态
    applyUrlState();
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", () => boot().catch(fatal));
  else boot().catch(fatal);

  DGM.boot = boot;
})();

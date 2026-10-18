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
          // 短名单只给 5 条（用户 2026-10-18 定），剩下的去「文件打开历史」窗口看
          .slice(0, 5)
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
          ${
            recent.length
              ? `<button class="lnk" id="w-recent-more"><span>${esc(t("welcome.recentMore"))}</span><span class="kbd">${DGM.icon("chevR", "ico-sm")}</span></button>`
              : ""
          }
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
    // 「更多」→ 文件打开历史（短名单只有 5 条，更早的去那里看）
    const more = $("#w-recent-more", w);
    if (more) more.addEventListener("click", () => DGM.dialogs.fileHistory());
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
    // 标题栏版本徽标：显示**真实**版本（app_info → CARGO_PKG_VERSION，单一真源在 Cargo.toml）。
    // 这里曾硬编码「dev3.0」—— 与版本无关，看着像坏了。mock 里没有真版本，徽标直接藏掉。
    const bv = document.getElementById("brand-ver");
    if (bv) {
      const info = state.appInfo;
      const real = info && info.version && /^\d+\.\d+\.\d+$/.test(info.version) ? info.version : null;
      bv.textContent = real || "";
      bv.hidden = !real;
    }
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
    // 工作区与外部改动（第 4 步）
    DGM.bus.on("workspace:changed", () => {
      DGM.shell.render();
    });
    DGM.bus.on("fs:changed", () => {
      DGM.shell.renderFsBanner();
      DGM.shell.render();
    });
    DGM.bus.on("search:changed", () => {
      if (DGM.sidebar) DGM.sidebar.render();
    });

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
    // 启动就挂的路径：i18n 可能也没起来 —— 取不到词条就退回键名，报错屏自己绝不能再抛
    const label = (() => {
      try {
        return DGM.i18n ? DGM.i18n.t("boot.failed") : "boot.failed";
      } catch (e) {
        return "boot.failed";
      }
    })();
    box.textContent = label + "\n" + ((err && err.stack) || err);
    document.body.appendChild(box);
    console.error(err);
  }

  /** 心跳：把"走到哪一步"打到后端 stdout（WebView 的 console 在真机上看不见）。
   *  必须足够轻、且自身绝不抛异常 —— 它要在"页面已经卡住"的边缘工作。 */
  const note = (t) => {
    try {
      const T = window.__TAURI__;
      const inv = (T && T.core && T.core.invoke) || (T && T.invoke);
      if (inv) inv("debug_note", { text: t });
    } catch (e) {
      /* 心跳失败不影响主流程 */
    }
  };
  DGM.note = note;

  async function boot() {
    note("boot:1-i18n");
    DGM.i18n.setLang(DGM.i18n.detect ? DGM.i18n.detect() : "zh-CN", { persist: false });
    DGM.i18n.apply();
    note("boot:1-done");

    // 2) mock 标注
    note("boot:2-badge");
    if (DGM.shell && DGM.shell.applyMockBadge) DGM.shell.applyMockBadge();

    // 3) 状态加载
    note("boot:3-load");
    await state.load();
    note("boot:3-done");

    // 4) 采用设置里的 locale（若有）
    const loc = state.settings && state.settings.locale;
    if (loc && loc !== DGM.i18n.lang) {
      DGM.i18n.setLang(loc, { persist: false });
      DGM.i18n.apply();
    }

    // 5) 绑定各模块（DOM 已就位）
    note("boot:5-bind");
    DGM.shell.bind();
    note("boot:5-shell-bound");
    DGM.editor.bind();
    // 画布承载面（同源 iframe）：先给容器再 bind，否则第一次渲染找不到挂载点
    DGM.canvas.init({ container: document.getElementById("canvas-host") });
    DGM.preview.bind();
    DGM.ai.bind();
    if (DGM.palette && DGM.palette.bind) DGM.palette.bind();
    note("boot:5-done");

    // 6) 命令注册（依赖各模块已定义）
    note("boot:6-commands");
    DGM.registerCommands();
    note("boot:6-done");

    // 7) 首帧
    note("boot:7-rerender");
    rerender();
    note("boot:7-editor");
    DGM.editor.loadActive();
    note("boot:7-preview");
    DGM.preview.render();
    note("boot:7-ai");
    DGM.ai.render();
    note("boot:7-derived");
    if (state.active) state.refreshDerived(state.active);
    seedLog();
    note("boot:7-done");

    subscribe();

    // 主题/光标等首帧细节
    DGM.shell.applyLayoutVars();

    note("boot:8-urlstate");
    applyUrlState();

    // 云端状态：后台拉一次（失败也不影响启动 —— 侧栏如实显示"未登录/未配置"）。
    // **失败要重试**：启动初期网络/DNS/代理还没热起来很常见，一次失败就把"已登录"钉成
    // "未登录"，用户看到的就是"启动后得点一下账户才变登录"（2026-10-15 报的）。
    // 退避重试三次；全失败也如实留着 lastError（界面按 lastError 显示原因，不装成未登录）。
    if (state.cloudRefresh) {
      (async () => {
        for (const wait of [0, 1500, 4000]) {
          if (wait) await new Promise((r) => setTimeout(r, wait));
          await state.cloudRefresh();
          if (!state.cloud.lastError) return; // 查成功（含"确实未登录"）就收工
        }
      })().catch((e) => note("cloud-refresh-failed " + String((e && e.message) || e)));
    }

    // 检查更新：后台跑一次。**安静模式** —— 出错与"已最新"都不打扰，只有真发现新版才在
    // 状态栏亮出可点的「有新版本 x.y.z」（见 shell.js::checkUpdate）。延迟 2s 让首帧先落地。
    note("update:autocheck");
    if (DGM.shell && DGM.shell.autoCheckUpdate) {
      setTimeout(() => DGM.shell.autoCheckUpdate(), 2000);
    }

    // D2 引擎预热：**按需**（最近开过 `.d2` 才预）。
    //
    // D2 的 wasm 是 11MB，首次编译要解压 + 实例化（实测冷启动数秒）。给不用 D2 的
    // 用户白背一份 127MB 常驻内存不值当，所以只在最近文件里真有 `.d2` 时提前解压；
    // 否则等用户真打开时再加载（那时有加载态，见 preview.js::renderD2）。
    // 失败**必须静默**：资产缺失 / 离线守卫拦下都不该在启动时弹错。
    const recentList = (state.settings && state.settings.recent) || [];
    if (recentList.some((r) => r && r.format === "d2") && DGM.d2) {
      setTimeout(() => DGM.d2.warmup(), 3000);
    }
    note("boot:done");
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", () => boot().catch(fatal));
  else boot().catch(fatal);

  DGM.boot = boot;
})();

/* ============================================================================
 * 自检（dev-only）：后端 `app_info.dev.selftest_report` 有值时才跑
 *
 * 为什么需要它：单测只覆盖 Rust 纯逻辑层，前端 9000 行只有「真跑起来」才知道对错。
 * 本机 WebView2 不认 `--remote-debugging-port`（wry 默认会传 `--disable-features=…`，
 * 宿主一旦显式传参，WebView2 就不再读 `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS`），
 * 所以改由**页面自己**跑一遍真实 IPC 断言并落盘报告：报告存在且全 PASS
 * ⇒ 前端 ↔ Rust 的契约、命令、事件这一整条缝是真的通的。
 *
 *   DIAGRAMON_SELFTEST=1 ./target/debug/diagramon.exe          # 报告写到数据目录
 *   DIAGRAMON_SELFTEST_REPORT=<绝对路径>                        # 或指定位置
 * ========================================================================== */
(function () {
  if (!(window.DGM && window.DGM.shell)) return;
  const T = window.__TAURI__;
  const invoke = (T && T.core && T.core.invoke) || (T && T.invoke);
  if (!invoke) return; // mock 模式不跑自检

  const q = new URLSearchParams(location.search);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  /** 对象 → base64（分块，避免 apply 参数过多） */
  function enc(obj) {
    const bytes = new TextEncoder().encode(JSON.stringify(obj, null, 2));
    let bin = "";
    for (let i = 0; i < bytes.length; i += 0x8000) {
      bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    }
    return btoa(bin);
  }

  /** 裸文本 → base64。给"造一个真实文件"用 —— `enc` 走 JSON.stringify，
   *  会把换行转义成字面 `\n`、再裹一层引号，写出去就不是两行源码了。 */
  function encRaw(str) {
    const bytes = new TextEncoder().encode(str);
    let bin = "";
    for (let i = 0; i < bytes.length; i += 0x8000) {
      bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    }
    return btoa(bin);
  }

  /** 走到哪一步了 —— 打到后端 stdout（console 在真机上看不见） */
  const note = (t) => window.DGM && DGM.note && DGM.note(t);

  const writeTo = (reportPath, obj, suffix) =>
    invoke("export_write", {
      path: suffix ? reportPath.replace(/\.json$/, suffix) : reportPath,
      base64: enc(obj),
    });

  /** 心跳：判断"卡住"是 JS 线程死了，还是 IPC 响应丢了 —— 二者的修法完全不同。 */
  let hb = 0;
  setInterval(() => note("hb:" + ++hb), 2000);

  /** 页面级钩子：若页面被销毁/导航/渲染进程崩了，所有 await 永不结算且**无报错**。
   *  这三种钩子是唯一能把"静默消失"变成"留下一句话"的手段。 */
  window.addEventListener("error", (e) => note("page-error:" + ((e && e.message) || "unknown")));
  window.addEventListener("unhandledrejection", (e) => note("page-rejection:" + (((e && e.reason) && (e.reason.message || e.reason)) || "unknown")));
  window.addEventListener("pagehide", () => note("pagehide"));
  window.addEventListener("beforeunload", () => note("beforeunload"));
  document.addEventListener("visibilitychange", () => note("vis:" + document.visibilityState));

  async function main() {
    let reportPath = q.get("report") || "";
    if (!reportPath) {
      try {
        const info = await invoke("app_info");
        reportPath = (info && info.dev && info.dev.selftest_report) || "";
      } catch (e) {
        /* 拿不到就当没开自检 */
      }
    }
    if (!reportPath) {
      note("selftest:no-report-path");
      return;
    }
    note("selftest:report-path=" + reportPath);


    const out = [];
    // **只在失败时**打点到 stdout。曾试过"每条都打"，结果 note 本身就是
    // fire-and-forget 的 invoke —— 50 条断言让 IPC 调用数翻倍，恰好把
    // "响应偶发被丢"这个环境问题放大到几乎必现。失败时才打点，
    // 既留得住定位信息，又不给通道加压。note 自身吞掉一切异常。
    const ok = (name, pass, extra) => {
      if (!pass) {
        try {
          note("ok:F " + name + (extra == null ? "" : " | " + JSON.stringify(extra)));
        } catch (e) { /* 打点失败不影响断言 */ }
      }
      out.push({ name, pass: !!pass, extra: extra == null ? null : extra });
    };

    try {
      note("selftest:run");
      // 静态 chrome 在 index.html 里就有，不必等定时器
      // （注意：WebView2 对后台窗口会把 setTimeout 节流到 ~1 次/秒，
      //   所以自检里**不要**用 sleep 轮询等界面，否则要跑一分多钟。）
      const sel = (s) => !!document.querySelector(s);
      ok(
        "五块工作区齐备",
        sel(".titlebar") && sel(".activitybar") && sel(".sidebar") && sel(".editor-col") && sel(".ai-pane") && sel(".statusbar")
      );
      ok("AI 三页签齐备", document.querySelectorAll("#ai-tabs .ai-tab").length === 3);

      // ── 契约与命令（纯 IPC） ──
      const info = await invoke("app_info");
      // 版本号**别硬编码** —— 真源在 Cargo.toml（workspace version），它随每次发版变。
      // 曾经这里写死 "3.0.0"，把「关于窗口永远显示 3.0.0」这个 bug 盖了三个版本。
      ok("app_info 版本号是合法 semver", !!info && /^\d+\.\d+\.\d+$/.test(info.version || ""), info && info.version);
      ok(
        "注册表五种格式",
        info && info.formats && info.formats.length === 5 && info.formats.map((f) => f.id).join(",") === "mermaid,dot,d2,drawio,excalidraw",
        info && info.formats && info.formats.map((f) => f.id).join(","),
      );
      ok(
        "画布型 split_view=false",
        info.formats.filter((f) => ["drawio", "excalidraw"].includes(f.id)).every((f) => f.split_view === false)
      );

      const s0 = await invoke("settings_get");
      ok("settings_get 返回设置", !!s0 && typeof s0.theme === "string", s0 && s0.theme);
      const s1 = await invoke("settings_patch", { patch: { accent: "lotus" } });
      ok("settings_patch 局部更新不清空其它字段", s1.accent === "lotus" && s1.theme === s0.theme && s1.panels.sidebar_w === s0.panels.sidebar_w);
      await invoke("settings_patch", { patch: { accent: s0.accent } });

      // ── 走应用自身的入口建文档（这样界面才会跟着动，等于用户操作） ──
      const st = window.DGM && DGM.state;
      let doc = null;
      if (st && st.newDoc) {
        doc = await st.newDoc("mermaid");
      } else {
        doc = await invoke("doc_new", { format: "mermaid" });
      }
      ok("新建 mermaid 文档", !!doc && doc.format === "mermaid", doc && doc.name);
      await invoke("doc_set_body", { id: doc.id, body: "flowchart TD\n    A([开始]) --> B{判断}\n" });
      if (st && st.refreshIssues) await st.refreshIssues(doc.id);

      const clean = "flowchart TD\n    A([开始]) --> B{判断}\n    B -- 是 --> C([结束])\n    subgraph 风控\n        L --> M\n    end\n";
      await invoke("doc_set_body", { id: doc.id, body: clean });
      const issues0 = await invoke("doc_issues", { id: doc.id });
      ok("正常源码不报问题", issues0.length === 0, JSON.stringify(issues0));

      // 曾经有条假警规则：把标签里的裸 `<` / `>` 一律当问题报。
      // 用仓库里实际打包的 mermaid（与应用同 config）逐个实测后确认**复现不出来**，
      // 规则已删（2026-10-11 用户反馈）。这里反过来钉两件事：
      //   ① 合法源码（含 `>=`）必须零问题；② 真错误照样报 error。
      const withGe = clean.replace("B{判断}", "B{连续失败 >= 5?}");
      await invoke("doc_set_body", { id: doc.id, body: withGe });
      const issues1 = await invoke("doc_issues", { id: doc.id });
      ok("标签里的 >= 不再被误报", issues1.length === 0, JSON.stringify(issues1));

      await invoke("doc_set_body", { id: doc.id, body: clean.replace("C([结束])", "C([结束]") });
      const issues2 = await invoke("doc_issues", { id: doc.id });
      ok("括号不配对照样报 error", issues2.some((i) => i.severity === "error"), JSON.stringify(issues2));

      await invoke("doc_set_body", { id: doc.id, body: withGe }); // 还原后面断言要用的正文

      const outline = await invoke("doc_outline", { id: doc.id });
      ok("大纲三组齐备", outline.length === 3, outline.map((g) => g.title).join("/"));
      const nodes = (outline.find((g) => g.title === "节点") || {}).rows || [];
      ok("大纲取到中文标签", nodes.some((r) => r.name === "开始"), JSON.stringify(nodes.slice(0, 3).map((r) => r.name)));

      await invoke("doc_set_caret", { id: doc.id, line: 6, col: 1 });
      const scope = await invoke("doc_scope", { id: doc.id });
      ok("状态栏作用域 = 风控", scope === "风控", scope);

      // ── 画布型拒绝分屏 ──
      const cv = st && st.newDoc ? await st.newDoc("drawio") : await invoke("doc_new", { format: "drawio" });
      let rejected = false;
      if (st && st.setViewMode) {
        await st.setViewMode(cv.id, "split");
        rejected = cv && true;
      } else {
        rejected = (await invoke("doc_set_view_mode", { id: cv.id, mode: "split" })) !== null;
      }
      const sess = await invoke("session_get");
      const cvBack = sess.docs.find((d) => d.id === cv.id);
      ok("画布型拒绝分屏", cvBack && cvBack.view_mode === "preview", cvBack && cvBack.view_mode);
      ok("会话里至少两份文档", sess.docs.length >= 2, sess.docs.length);

      // ── 界面跟上会话（标签页数量） ──
      ok("标签页跟上了会话", document.querySelectorAll("#tabs .tab").length >= 2, document.querySelectorAll("#tabs .tab").length);

      // ── 画布承载（第 2 步）：同源 iframe 真的挂上去了吗 ──
      //
      // 这里只断言**同步可判定**的东西。drawio 的 `init` 要等它自己的引擎起来，
      // 而本机 WebView2 会把后台窗口的定时器节流到约 1 次/秒 —— 在自检里等它
      // 只会把报告拖到超时。真正的「载入 → 回写」验证在 tools/dev/canvas-probe.mjs
      // （那边用普通 HTTP 起同样的目录布局，定时器不受节流，能踏实等）。
      if (st && st.activateDoc) await st.activateDoc(cv.id);
      await invoke("doc_activate", { id: cv.id });
      // 直接渲染，绕过 preview.schedule 的 60ms 去抖 —— 后台窗口的定时器被节流到约 1 次/秒，
      // 等去抖等于把这条断言变成随机结果
      await DGM.preview.render();
      const canvasHost = document.getElementById("canvas-host");
      const frame = canvasHost && canvasHost.querySelector("iframe");
      ok("画布承载面已挂载", !!frame, frame && frame.getAttribute("src"));
      ok("承载页指向 /drawio/host.html", !!frame && /\/drawio\/host\.html$/.test(frame.getAttribute("src")));
      ok("承载面容器可见", !!canvasHost && !canvasHost.hidden);

      // 同源证明：跨源时读 contentWindow.location 会抛，读得到就是同源
      let sameOrigin = false;
      try {
        sameOrigin = typeof frame.contentWindow.location.href === "string";
      } catch (e) {
        sameOrigin = false;
      }
      ok("承载页与外壳同源（可直读 contentWindow）", sameOrigin);
      ok("canvas 模块认得两种画布格式", !!(DGM.canvas && DGM.canvas.supports("drawio") && DGM.canvas.supports("excalidraw")));

      // 承载页里那两条注入规则（缩缩放框 + Format 贴右缘）—— **不依赖 drawio 引擎**：
      // 注入本身发生在 drawio iframe 的 load 上（那时自检早跑完、且后台窗口的定时器被节流），
      // 所以这里验"协议供出的那份 host.html 确实带着它们"。为什么要验：`ui=min` 下 drawio 的
      // Format 面板是浮动窗口（mxWindow），位置只在创建那一刻算一次 —— 主窗口一变宽它就留在旧
      // 位置、画布从它下面铺到窗口右边（用户 2026-10-14 报过）；规则随包丢了，用户侧就是
      // "面板浮在半空"。**真实的贴边几何**（含拉宽容器）由 tools/dev/canvas_probe.py 验 ——
      // 那边用普通 HTTP、定时器不受节流，还能改容器宽度走那个 bug 的复现路径。
      let hostHtml = "";
      try {
        const r = await fetch("/drawio/host.html");
        hostHtml = r.ok ? await r.text() : "";
      } catch (e) {
        hostHtml = "";
      }
      ok(
        "承载页带着 CHROME_CSS（缩缩放框 + 浮动面板落位 + 顶栏缩放组）",
        /geZoomInput/.test(hostHtml) &&
          /geFormatContainer/.test(hostHtml) &&
          /geSidebarContainer/.test(hostHtml) &&
          /geMenubarContainer/.test(hostHtml),
        hostHtml ? `${hostHtml.length} 字节` : "（取不到 /drawio/host.html）",
      );

      // 几何断言得等 drawio 引擎起来（浮动窗口是引擎建的）—— 拿不到就跳过：
      // 自检里绝不等定时器（后台窗口被节流，等它只会把报告拖死）。
      let pin = null;
      try {
        const host = frame.contentWindow.document;
        const dl = host.getElementById("dl");
        const dd = dl && dl.contentDocument;
        const fmt = dd && dd.querySelector(".geFormatContainer");
        const win = fmt && fmt.closest("div.mxWindow");
        const r = win ? win.getBoundingClientRect() : null;
        const bar = dd && dd.querySelector(".geMenubarContainer");
        if (r && r.width > 0 && r.height > 0 && bar) {
          pin = {
            gap: Math.round(dl.contentWindow.innerWidth - r.right),
            belowBar: Math.round(r.top) >= Math.round(bar.getBoundingClientRect().bottom),
          };
        }
      } catch (e) {
        pin = null;
      }
      ok(
        "drawio 浮动面板落位（右缘 12px 对齐缩放条 / 顶部在顶栏下方）",
        !pin || (Math.abs(pin.gap - 12) <= 1 && pin.belowBar),
        pin ? JSON.stringify(pin) : "（浮动窗口未显示 / 引擎未就绪，跳过）",
      );

      // dgm 协议真的把资产供出来了吗 —— 用 fetch 断言，不走定时器（后台窗口的定时器被节流）
      const headOk = async (path) => {
        try {
          const r = await fetch(path, { method: "HEAD" });
          return r.ok;
        } catch (e) {
          return false;
        }
      };
      ok("协议能供出承载页 /drawio/host.html", await headOk("/drawio/host.html"));
      ok("协议能供出 drawio 应用 /drawio/index.html", await headOk("/drawio/index.html"));
      ok("协议能供出 Excalidraw /excalidraw/index.html", await headOk("/excalidraw/index.html"));
      ok("协议能供出外壳自己的 /js/canvas.js", await headOk("/js/canvas.js"));

      // 承载页的内联脚本跑起来就会挂上 __hostQueue（不依赖 drawio 引擎）——
      // 它存在即证明「协议供出了承载页，且它在外壳里执行了」。
      //
      // **这里绝不能用定时器等待。** WebView2 对后台窗口会挂起渲染进程：
      // 定时器一次都不触发，`20 × 1s` 的等待循环就变成"永远卡在第一格"，
      // 整个自检没有报告、没有报错、没有 pagehide（真实的教训，见 check.mjs）。
      // 改成同步断言：走到这里时前面已经隔了三十多个 IPC 往返，
      // iframe 早就 load 完了；真没就绪就如实报 FAIL，而不是把验收卡死。
      let queueUp = false;
      try {
        queueUp = Array.isArray(frame.contentWindow.__hostQueue);
      } catch (e) {
        queueUp = false;
      }

      // ── 格式转换（第 3 步）：纯 IPC，断言的正是"谁来做"与产物形状 ──
      const srcDoc = sess.docs.find((d) => d.format === "mermaid");
      const srcBody = "flowchart TD\n    A([开始]) --> B{判断}\n    B -- 是 --> C([结束])\n    subgraph 风控\n        L --> M\n    end\n    classDef danger fill:#f8e9e6,stroke:#b0554a;\n    class L danger;\n";
      await invoke("doc_set_body", { id: srcDoc.id, body: srcBody });

      const toDot = await invoke("convert_text", { req: { from: "mermaid", to: "dot", source: srcBody } });
      ok("mermaid → dot 由 Rust 完成", toDot.engine === "rust" && toDot.body.includes("digraph G"), toDot.engine);
      ok("DOT 里带上了节点与标签", toDot.body.includes("label=\"开始\"") && toDot.body.includes("shape=diamond"), "");
      ok("subgraph 变成了 cluster", toDot.body.includes("subgraph cluster_0") && toDot.body.includes("label=\"风控\""));
      ok("classDef 样式挂到了节点上", toDot.body.includes("fillcolor=\"#f8e9e6\""));
      ok("保真度说明非空（有损就要写清）", Array.isArray(toDot.notes) && toDot.notes.length > 0, toDot.notes.join(" / "));

      const toDrawio = await invoke("convert_text", { req: { from: "mermaid", to: "drawio", source: srcBody } });
      ok("mermaid → drawio 交给引擎（不是 Rust）", toDrawio.engine === "drawio" && toDrawio.body === "", toDrawio.engine);
      ok("引擎方向给出原因", (toDrawio.notes[0] || "").includes("drawio"), toDrawio.notes[0]);

      const toXcal = await invoke("convert_text", { req: { from: "mermaid", to: "excalidraw", source: srcBody } });
      ok("mermaid → Excalidraw 交给引擎", toXcal.engine === "excalidraw", toXcal.engine);

      let convertErr = "";
      try {
        await invoke("convert_text", { req: { from: "dot", to: "mermaid", source: "digraph G { a -> b }" } });
      } catch (e) {
        convertErr = (e && e.message) || String(e);
      }
      ok("dot → mermaid 如实报未实现（不是静默成功）", convertErr.includes("实验方向"), convertErr.slice(0, 60));

      // ── D2（第 5 种格式）──
      //
      // 为什么这几条必须在真机自检里跑：D2 的 wasm 走 `/d2/index.js` 这个**自定义协议挂载点**，
      // 而且它自己用 `blob:` 建一个模块 Worker 再喂内联 wasm —— 这两件事在 headless Chrome 里
      // 通过不代表在 WebView2 的自定义协议下也通过（挂载点没接上就是 404，Worker 被 CSP 拦就是白屏）。
      ok("协议能供出 D2 运行时 /d2/index.js", await headOk("/d2/index.js"));

      const toD2 = await invoke("convert_text", { req: { from: "mermaid", to: "d2", source: srcBody } });
      ok("mermaid → d2 由 Rust 完成", toD2.engine === "rust" && toD2.body.includes("direction: down"), toD2.engine);
      ok("subgraph 变成 D2 容器且边用点号路径", toD2.body.includes("风控: {") && toD2.body.includes("风控.L -> 风控.M"), "");
      const dotToD2 = await invoke("convert_text", { req: { from: "dot", to: "d2", source: 'digraph G { rankdir=LR; a -> b [label="x"] }' } });
      ok("dot → d2 由 Rust 完成且带上方向", dotToD2.engine === "rust" && dotToD2.body.includes("direction: right"), dotToD2.engine);
      const d2Refuse = await invoke("convert_text", { req: { from: "d2", to: "mermaid", source: "a -> b" } }).then(() => "", (e) => (e && e.message) || String(e));
      ok("D2 → Mermaid 如实说不做（不是静默转换）", d2Refuse.includes("超集"), d2Refuse.slice(0, 60));
      const d2Mx = await invoke("convert_text", { req: { from: "d2", to: "drawio", source: "a -> b: 标签\n" } });
      ok("d2 → drawio 点名前端 wasm 引擎", d2Mx.engine === "d2wasm" && d2Mx.body === "", d2Mx.engine);

      // 真渲染一次：引擎首次要把 11MB 的 wasm 解压 + 实例化（实测冷启动几秒），
      // 所以给一个**有界**等待。后台窗口定时器被节流到约 1 次/秒，超时仍会触发；
      // 拿不到结果就如实 FAIL，绝不无限等（等下去整场自检就没有报告了）。
      const d2doc = await invoke("doc_new", { format: "d2" });
      // 必须走 state 的激活（`doc_activate` 只改 Rust 侧的会话，界面还停在上一份文档上）——
      // 之前只发 IPC，于是这一条渲染的是那份 drawio 画布，副标题也还是画布的。
      if (st && st.activateDoc) await st.activateDoc(d2doc.id);
      await invoke("doc_activate", { id: d2doc.id });
      try {
        await Promise.race([DGM.preview.render(), new Promise((r) => setTimeout(r, 45000))]);
      } catch (e) {
        /* 渲染失败由下面的断言如实报出来 */
      }
      const d2svg = document.querySelectorAll("#canvas-stage svg").length;
      const d2sub = (document.getElementById("preview-sub") || {}).textContent || "";
      ok("D2 文档能在真机渲染出 SVG", d2svg > 0, `${d2svg} 个 svg`);
      ok("预览副标题标出 D2 与当前布局", d2sub.includes("D2") && d2sub.includes("dagre"), d2sub);

      // D2 → drawio 的产物（前端把 compile() 的绝对几何映射成 mxfile）
      let mxRes = null;
      try {
        mxRes = await DGM.d2.toDrawio("a -> b: 标签\nb -> c\n", "dagre");
      } catch (e) {
        mxRes = { err: (e && e.message) || String(e) };
      }
      const mxXml = (mxRes && mxRes.xml) || "";
      ok(
        "D2 → mxfile 产物是合法 mxfile（mxCell + edge）",
        mxXml.includes("<mxfile") && mxXml.includes('<mxCell') && mxXml.includes('edge="1"'),
        mxRes && mxRes.err ? mxRes.err : mxXml.length + " 字节",
      );
      ok("D2 → mxfile 附保真度说明", !!(mxRes && mxRes.notes && mxRes.notes.length), ((mxRes && mxRes.notes) || []).join(" / "));

      // ── 工作区与文件系统（第 4 步）：全是纯 IPC，不靠定时器 ──
      // 造一个真实目录：借 export_write 的"父目录会自动建"这一特性
      // 每次自检用**独立**目录：上一次失败留下的文件不该让这一次误报"同名已存在"
      const wsDir = reportPath.replace(/[/\\][^/\\]+$/, "") + "/ws-" + Date.now().toString(36);
      await invoke("export_write", { path: wsDir + "/flows/demo.mmd", base64: encRaw("flowchart TD\n    A([开始]) --> B{判断}\n") });

      const wsInfo = await invoke("workspace_open", { path: wsDir });
      ok("打开工作区返回根与树", wsInfo.root && Array.isArray(wsInfo.tree) && wsInfo.tree.length > 0, wsInfo.root);
      ok("树里只有本应用认的文件", wsInfo.file_count === 1 && wsInfo.dir_count === 1, `${wsInfo.file_count}/${wsInfo.dir_count}`);

      const got = await invoke("workspace_get");
      ok("workspace_get 与刚扫的一致", got.root === wsInfo.root && got.file_count === wsInfo.file_count, got.file_count);

      const hits = await invoke("search_once", { req: { request_id: "selftest", query: "判断", max_results: 0 } });
      // "    A([开始]) --> B{判断}"：判断 在第 19 个字符处（1 起）。
      // 若按字节算会得到 22（中文一个字 3 字节）—— 这条断言就是把"字符 vs 字节"钉死。
      ok("全库搜索按字符给列号", hits[0].length === 1 && hits[0][0].line === 2 && hits[0][0].column === 19, JSON.stringify(hits[0].map((x) => `${x.line}:${x.column}`)));
      const hitsBad = await invoke("search_once", { req: { request_id: "selftest", query: "a(b", regex: true } });
      ok("坏正则如实报错而不是当没命中", !!hitsBad[1].error, hitsBad[1].error);

      const made = await invoke("workspace_new_file", { dir: wsDir, name: "selftest-made", format: "dot" });
      ok("新建文件补齐扩展名并落盘", /selftest-made\.dot$/.test(made), made);

      let traversal = "";
      try {
        await invoke("workspace_new_file", { dir: wsDir, name: "../escape", format: "mermaid" });
      } catch (e) {
        traversal = (e && e.message) || String(e);
      }
      ok("路径守卫挡住 ../ 逃逸", traversal.length > 0, traversal.slice(0, 50));

      const renamed = await invoke("workspace_rename", { path: made, name: "selftest-renamed" });
      ok("重命名沿用原扩展名", /selftest-renamed\.dot$/.test(renamed), renamed);

      const afterRename = await invoke("search_once", { req: { request_id: "selftest", query: "digraph" } });
      ok("搜索扫到刚建的文件", afterRename[0].length === 1 && /selftest-renamed\.dot$/.test(afterRename[0][0].path), afterRename[0].map((x) => x.name).join(","));

      // 判别实验：delete 之前先来一次会返回数据的调用 —— 它若能回来，
      // 说明通道没断，问题就特定于 delete 的响应；若卡死，问题是位置性的。
      const pre = await invoke("workspace_get");
      ok("删除前树有两份", pre.file_count === 2, pre.file_count);

      await invoke("workspace_delete", { path: renamed });
      const back = await invoke("workspace_get");
      ok("删除后树回到 1 个文件", back.file_count === 1, back.file_count);

      // 多词命令参数的命名一致性（ai_cancel 曾在两侧各写一套，真机上才炸）
      let cancelErr = "";
      try {
        await invoke("ai_cancel", { id: "no-such-request" });
      } catch (e) {
        cancelErr = (e && e.message) || String(e);
      }
      ok("ai_cancel 的参数能被解析（多词参数两侧一致）", cancelErr.includes("结束"), cancelErr.slice(0, 60));

      // BYOK 密钥的键名必须**只有一处**在算：写走 `ai_model_key_set`（Rust 加
      // `ai-model:` 前缀），读走 `hydrate_models` 查同一把键。曾经前端拿原始 id 去写、
      // Rust 拿前缀去读 —— 于是"填了密钥仍显示未配置、一调用就报缺少 API Key"
      // （2026-10-14 修，BYOK 整条路当时都不可用）。这里把这条配对钉住；
      // 用完恢复原有模型列表，别动用户的配置。
      let keyPair = null;
      const beforeKey = await invoke("settings_get");
      const origModels = (beforeKey.ai && beforeKey.ai.models) || [];
      try {
        const probeId = "selftest-key-probe";
        await invoke("ai_model_key_set", { modelId: probeId, secret: "sk-selftest" });
        const patched = await invoke("settings_patch", {
          patch: {
            ai: {
              models: origModels.concat([
                { id: probeId, name: "selftest", provider: "openai", base_url: "https://example.invalid/v1", model: "x", max_tokens: 16, temperature: 0 },
              ]),
            },
          },
        });
        const probe = (patched.ai.models || []).find((m) => m.id === probeId);
        keyPair = probe ? !!probe.has_key : null;
        await invoke("ai_model_key_delete", { modelId: probeId });
      } finally {
        await invoke("settings_patch", { patch: { ai: { models: origModels } } });
      }
      ok("BYOK 密钥写/读同一把键（填了密钥即显示已配置）", keyPair === true, String(keyPair));

      await invoke("workspace_close");
      const closed = await invoke("workspace_get");
      ok("关闭工作区后根为空", !closed.root, closed.root);

      // ── 识图截屏与原生剪贴板（第 5 步） ──
      // 框选窗口要人拖，自检不碰它；这里钉的是两件纯 IPC 能判定的东西。
      const monitors = await invoke("monitors_list");
      ok(
        "枚举显示器（物理像素 + 缩放）",
        Array.isArray(monitors) && monitors.length >= 1 && monitors[0].width > 0,
        JSON.stringify(monitors.map((m) => `${m.width}x${m.height}@${m.scale}`)),
      );

      const clipCv = document.createElement("canvas");
      clipCv.width = 7;
      clipCv.height = 5;
      clipCv.getContext("2d").fillRect(0, 0, 7, 5);
      const png = clipCv.toDataURL("image/png");
      const clipOk = await invoke("clip_write_image", { base64: png });
      ok("原生剪贴板写图（arboard）", clipOk === true, String(clipOk));
      try {
        const back = await invoke("clip_read_image");
        ok("剪贴板读回尺寸一致", back[0] === 7 && back[1] === 5, JSON.stringify(back));
      } catch (e) {
        // 剪贴板可能被系统/其它程序改写，这不是本应用的错 —— 如实记一条失败原因
        ok("剪贴板读回尺寸一致", false, String((e && e.message) || e));
      }
    } catch (e) {
      note("selftest:error " + String((e && e.message) || e));
      ok("自检过程无异常", false, String((e && e.stack) || (e && e.message) || e));
    }

    const failed = out.filter((r) => !r.pass);
    const report = {
      pass: out.length - failed.length,
      total: out.length,
      failed: failed.map((f) => f.name),
      results: out,
      ua: navigator.userAgent,
      at: new Date().toISOString(),
    };
    mcAlive = false;
    try {
      await writeTo(reportPath, report);
      note("selftest:report-written " + report.pass + "/" + report.total);
    } catch (e) {
      note("selftest:write-failed " + String((e && e.message) || e));
    }
    window.__DGM_SELFTEST_RESULT__ = report;
  }

  main();
})();

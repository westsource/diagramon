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
    if (q.get("sidebar")) {
      const v = q.get("sidebar");
      panels.sidebar_view = v === "search" || v === "convert" ? "explorer" : v;
    }
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

    // Mermaid ELK 离线包预热：3.11.3 起 `elk` 是 Mermaid 的**默认布局**，每次开 Mermaid 都要用，
    // 所以启动 3 秒后就后台加载（2.4MB ESM，实测加载约 0.5s、JS 堆 +7.7MB —— 一次性且常驻）。
    // 失败必须静默：资产缺失 / 离线守卫拦下都不该在启动时弹错（渲染时另有兜底）。
    if (DGM.preview && DGM.preview.warmElk) {
      setTimeout(() => DGM.preview.warmElk(), 3000);
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
      ok(
        "AI 意图滑块与输出格式齐备",
        document.querySelectorAll("#ai-intent-slider button[data-intent]").length === 4 && sel("#ai-out-format")
      );

      // ── 契约与命令（纯 IPC） ──
      const info = await invoke("app_info");
      // 版本号**别硬编码** —— 真源在 Cargo.toml（workspace version），它随每次发版变。
      // 曾经这里写死 "3.0.0"，把「关于窗口永远显示 3.0.0」这个 bug 盖了三个版本。
      ok("app_info 版本号是合法 semver", !!info && /^\d+\.\d+\.\d+$/.test(info.version || ""), info && info.version);
      // ELK 离线包：3.11.3 起 elk 是 Mermaid 的默认布局，boot 里 3 秒后**无条件后台**加载。
      // 这里只钉"真的加载上了"，不再有"有没有依据"的分支。
      {
        let elkNow = DGM.preview.elkLoaded ? DGM.preview.elkLoaded() : null;
        for (let i = 0; i < 60 && !elkNow; i++) {
          await new Promise((r) => setTimeout(r, 250));
          elkNow = DGM.preview.elkLoaded();
        }
        ok("启动后台预热了 ELK 离线包", elkNow === true, String(elkNow));
      }
      ok(
        "注册表五种格式",
        info && info.formats && info.formats.length === 5 && info.formats.map((f) => f.id).join(",") === "drawio,mermaid,excalidraw,dot,d2",
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

      // ── mermaid 解析错误：结构化行列 → 报错面板 → 行内标记与跳转（2026-10-18）──
      //  故意把第 2 行的 `}` 拆掉。错误落在哪一行由解析器说了算（可能是 2，也可能是
      //  报到文末），断言只钉**链路本身**：报错事件带行号、跳转后光标落在报错行。
      {
        const bad = clean.replace("B{判断}", "B{判断");
        let renderErr = null;
        DGM.bus.on("doc:render-error", (p) => {
          if (p && p.docId === doc.id && p.format === "mermaid" && !renderErr) renderErr = p;
        });
        if (st && st.setBodyNow) await st.setBodyNow(doc.id, bad);
        else {
          await invoke("doc_set_body", { id: doc.id, body: bad });
          if (DGM.preview && DGM.preview.schedule) DGM.preview.schedule();
        }
        for (let i = 0; i < 80 && !renderErr; i++) await new Promise((r) => setTimeout(r, 50));
        ok("坏源码触发渲染错误", !!renderErr, renderErr && JSON.stringify(renderErr).slice(0, 160));
        ok("报错带行号定位", !!(renderErr && renderErr.line >= 1), renderErr && (renderErr.line + ":" + renderErr.col));
        if (renderErr && DGM.editor && DGM.editor.jumpTo && !DGM.editor.isFallback()) {
          // 编辑器实例只在 loadActive 时挂载（boot 时还没有文档 → 实例是 null）。
          // 这里显式调一次，并轮询等它就绪（分屏下源码面板可见，坐标才有意义）。
          if (st && st.setViewMode) await st.setViewMode(doc.id, "split");
          DGM.editor.loadActive();
          let c = null;
          for (let i = 0; i < 40; i++) {
            DGM.editor.jumpTo(renderErr.line, renderErr.col || 1);
            c = DGM.editor.caret && DGM.editor.caret();
            if (c) break;
            await new Promise((r) => setTimeout(r, 50));
          }
          ok("跳转后光标落在报错行", !!c && c.line === renderErr.line, c ? c.line + ":" + c.col + " vs 报错 " + renderErr.line : "编辑器未挂载");
        }
        if (st && st.setBodyNow) await st.setBodyNow(doc.id, withGe); // 还原后面的断言要用的正文
      }

      // ── Mermaid 外观 / 布局：注册表契约 + 文档级落盘 + 顶栏控件 + ELK 真渲染（2026-10-19）──
      {
        const mm = info.formats.find((f) => f.id === "mermaid");
        ok(
          "Mermaid 注册 looks×4 + layouts×2（默认 elk）",
          !!mm && mm.looks.length === 4 && mm.layouts.join(",") === "elk,dagre",
          mm && "looks=" + mm.looks.join("/") + " layouts=" + mm.layouts.join("/"),
        );
        ok(
          "顶栏控件对 Mermaid 出三颗（外观 / 布局 / 配色）",
          document.querySelectorAll("#pv-opts .pv-opt").length === 3,
          document.querySelectorAll("#pv-opts .pv-opt").length,
        );
        await invoke("doc_set_look", { id: doc.id, look: "handDrawn" });
        const sessLook = await invoke("session_get");
        ok(
          "外观按文档落盘",
          (sessLook.docs.find((x) => x.id === doc.id) || {}).look === "handDrawn",
          sessLook.docs.find((x) => x.id === doc.id) && sessLook.docs.find((x) => x.id === doc.id).look,
        );
        // 注意：渲染读的是 state 里的文档副本，裸 invoke 不更新它 —— UI 路径必须走 state.setLayout/setLook
        if (st && st.setLook) await st.setLook(doc.id, "handDrawn");

        // ELK 端到端：切布局 → 预览换新 SVG，且 elk 离线包真的加载注册成功
        // （elk 加载失败会静默回退 dagre 照样出图，所以必须钉 elkLoaded 标志）。
        const before = document.querySelector("#canvas-stage svg");
        if (st && st.setLayout) await st.setLayout(doc.id, "elk");
        else await invoke("doc_set_layout", { id: doc.id, layout: "elk" });
        if (DGM.preview && DGM.preview.schedule) DGM.preview.schedule();
        let elkOk = false;
        for (let i = 0; i < 200; i++) {
          const now = document.querySelector("#canvas-stage svg");
          if (now && now !== before && DGM.preview.elkLoaded && DGM.preview.elkLoaded()) {
            elkOk = true;
            break;
          }
          await new Promise((r) => setTimeout(r, 100));
        }
        ok("ELK 布局端到端渲染", elkOk, elkOk ? "elk 离线包加载+注册+渲染全通" : "20s 内没等到 elk 渲染");

        // ── 导出 PNG：必须有底色、有内容，超大图不越画布上限（2026-10-19 用户报"导出是空白"） ──
        //  两个成因各自钉一条：① 位图没铺底色（透明 PNG + 暗色主题 = 白色看图器里一片空白）；
        //  ② 越上限后 drawImage 静默不画（WebView2 实测：面积 2^28 以内能画，之外交回空图）。
        {
          // 后台窗口里定时器被节流：显式催一次渲染，再等预览自报"有内容"（最多 6s）。
          // 不等就调导出会在"渲染还没落图"的窗口里抛 `exp.noContent` —— 那会把整场自检
          // 从这一行之后全带走（下面的断言一条都跑不到）。
          DGM.preview.render();
          let ready = false;
          for (let i = 0; i < 60; i++) {
            if (DGM.preview.hasContent()) {
              ready = true;
              break;
            }
            await new Promise((r) => setTimeout(r, 100));
          }
          const stageText = ((document.querySelector("#canvas-stage") || {}).textContent || "").slice(0, 120);
          ok("预览渲染出可导出的内容", ready, ready ? "hasContent" : stageText);
          if (!ready) {
            ok("导出的 PNG 不是空图", false, "预览没有内容，导出断言无从谈起");
          } else {
            const png = await DGM.preview.pngDataUrl();
            ok(
              "导出的 PNG 不是空图",
              !!png && String(png.url).startsWith("data:image/png") && png.url.length > 2000,
              png && png.url.length,
            );
            const facts = await new Promise((res) => {
              const img = new Image();
              img.onload = () => {
                const c = document.createElement("canvas");
                c.width = img.width;
                c.height = img.height;
                const x = c.getContext("2d");
                x.drawImage(img, 0, 0);
                const d = x.getImageData(0, 0, c.width, c.height).data;
                let content = 0;
                for (let i = 0; i < d.length; i += 4) {
                  if (Math.abs(d[i] - d[0]) + Math.abs(d[i + 1] - d[1]) + Math.abs(d[i + 2] - d[2]) > 24) content++;
                }
                res({ w: c.width, h: c.height, alpha: d[3], content });
              };
              img.onerror = () => res(null);
              img.src = png.url;
            });
            ok("导出的 PNG 有底色（角上不透明）", !!facts && facts.alpha === 255, facts && `alpha=${facts.alpha}`);
            ok("导出的 PNG 画上了内容", !!facts && facts.content > 100, facts && `${facts.content}/${facts.w * facts.h}`);
          }

          const fit = DGM.preview.fitExportScale(8000, 12000, 3);
          ok(
            "超大图导出倍率被压到画布上限内",
            fit.capped === true && 8000 * fit.scale * 12000 * fit.scale <= DGM.preview.MAX_CANVAS_AREA + 1,
            `scale=${fit.scale} capped=${fit.capped}`,
          );
          const small = DGM.preview.fitExportScale(400, 300, 5);
          ok("小图仍是自适应倍率（没被无谓地压）", small.capped === false && small.scale === 5, `scale=${small.scale}`);
        }

        if (st && st.setLayout) await st.setLayout(doc.id, "elk");
        if (st && st.setLook) await st.setLook(doc.id, "auto");

        // ── 层叠：源码窗口的搜索/替换面板不该盖住弹出菜单（2026-10-19 用户报的遮挡） ──
        //  CodeMirror 自带 `.cm-panels{z-index:300}`（比 `.pop` 的 210 高），于是菜单被面板压住；
        //  app.css 里给 `.code-host` 加了 `isolation: isolate` 收口。这里用 elementFromPoint
        //  直接问"叠在一起时谁在上面"，不读 CSS 数字。
        {
          if (st && st.setViewMode) await st.setViewMode(doc.id, "split");
          DGM.editor.loadActive();
          DGM.editor.openSearch();
          await new Promise((r) => setTimeout(r, 300));
          const panel = document.querySelector(".cm-panels");
          const host = document.querySelector(".code-host");
          let verdict = { noPanel: !panel };
          if (panel) {
            const pr = panel.getBoundingClientRect();
            DGM.pop.show([{ label: "层叠测试" }], { x: pr.left + 30, y: pr.top + 2 }, () => {});
            await new Promise((r) => setTimeout(r, 200));
            const pop = document.querySelector(".pop:not([hidden])");
            const el = document.elementFromPoint(pr.left + 40, pr.top + 8);
            verdict = {
              panelZ: getComputedStyle(panel).zIndex,
              hostIsolation: host ? getComputedStyle(host).isolation : null,
              popZ: pop ? getComputedStyle(pop).zIndex : null,
              top: el ? (pop && pop.contains(el) ? "pop" : panel.contains(el) ? "panel" : "other") : "none",
            };
            DGM.pop.hide();
            const close = panel.querySelector("[name=close]");
            if (close) close.click();
          }
          ok("搜索面板不浮在弹出菜单之上", !verdict.noPanel && verdict.top === "pop", JSON.stringify(verdict));
        }

        // 外观口径（转换中心共用）：文档级 > 设置默认 > auto。
        // mermaid→Excalidraw 的 look 透传 e2e 在 tools/dev/excalidraw_probe.py 的 F 用例 ——
        // 自检启动场里加载 Excalidraw 引擎会把整场拖进看门狗（渲染进程被挂起），别搬回来。
        ok(
          "外观口径：文档级优先",
          DGM.preview && DGM.preview.effectiveLook && DGM.preview.effectiveLook(doc) === "auto",
          DGM.preview && DGM.preview.effectiveLook && DGM.preview.effectiveLook(doc),
        );
        if (st && st.setLook) await st.setLook(doc.id, "handDrawn");
        ok(
          "外观口径：切档生效",
          DGM.preview.effectiveLook(doc) === "handDrawn",
          DGM.preview.effectiveLook(doc),
        );
        if (st && st.setLook) await st.setLook(doc.id, "auto");
      }

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

      // ── 渲染选项**按文件**记住（外观 / 布局）：关掉标签页再打开这个文件，还是上次选的 ──
      //  身份是**路径**（`render-opts.json` 里 doc_key(path) → {look, layout}），所以这里必须用
      //  真实文件：未保存标签页没有身份，记不住（保存那一刻才落上，另存为则要把记录挪到新路径）。
      {
        const norm = (p) => String(p || "").replace(/\\/g, "/");
        const keepPath = wsDir + "/flows/keep.mmd";
        const otherPath = wsDir + "/flows/other.mmd";
        await invoke("export_write", { path: keepPath, base64: encRaw("flowchart TD\n    A-->B\n") });
        await invoke("export_write", { path: otherPath, base64: encRaw("flowchart LR\n    X-->Y\n") });

        const open1 = await invoke("doc_open_paths", { paths: [keepPath] });
        const first = open1.docs.find((d) => norm(d.path) === norm(keepPath)) || {};
        ok("按路径打开的文件进了会话", !!first.id && first.look == null && first.layout === "elk", `${first.id} ${first.layout}`);
        // 故意选注册表里的**非默认**布局（dagre）来验"按文件记住"：若记不住，重开就会
        // 回到默认的 elk —— 断言才分得清"记住了"和"碰巧撞上默认值"。
        await invoke("doc_set_look", { id: first.id, look: "handDrawn" });
        await invoke("doc_set_layout", { id: first.id, layout: "dagre" });
        await invoke("doc_close", { id: first.id });

        const open2 = await invoke("doc_open_paths", { paths: [keepPath, otherPath] });
        const again = open2.docs.find((d) => norm(d.path) === norm(keepPath)) || {};
        ok("重开文件恢复上次选的外观", again.look === "handDrawn", again.look);
        ok("重开文件恢复上次选的布局", again.layout === "dagre", again.layout);
        const other = open2.docs.find((d) => norm(d.path) === norm(otherPath)) || {};
        ok(
          "另一个文件不受影响（按文件记的，不是全局默认）",
          other.look == null && other.layout === "elk",
          `look=${other.look} layout=${other.layout}`,
        );

        // 另存为：记录要跟着文件走（新路径接着用、旧路径不留）
        const savePath = wsDir + "/flows/moved.mmd";
        const saved = await invoke("doc_save_as", { id: again.id, path: savePath });
        ok("另存为后渲染选项跟着新路径", saved.look === "handDrawn" && saved.layout === "dagre", `${saved.look}/${saved.layout}`);
        await invoke("doc_close", { id: saved.id });
        const open3 = await invoke("doc_open_paths", { paths: [savePath, keepPath] });
        const movedDoc = open3.docs.find((d) => norm(d.path) === norm(savePath)) || {};
        ok("另存为产生的新文件重开后仍是上次选的外观", movedDoc.look === "handDrawn", movedDoc.look);
        ok("另存为产生的新文件重开后仍是上次选的布局", movedDoc.layout === "dagre", movedDoc.layout);
        const oldPath = open3.docs.find((d) => norm(d.path) === norm(keepPath)) || {};
        ok(
          "另存为后旧路径不再留记录",
          oldPath.look == null && oldPath.layout === "elk",
          `look=${oldPath.look} layout=${oldPath.layout}`,
        );

        // 清理：不留文件、不留标签页，后面的断言不该被这里影响
        for (const id of [movedDoc.id, oldPath.id, other.id].filter(Boolean)) {
          try {
            await invoke("doc_close", { id });
          } catch (e) { /* 已经不在会话里就算了 */ }
        }
        for (const p of [keepPath, otherPath, savePath]) {
          try {
            await invoke("workspace_delete", { path: p });
          } catch (e) { /* 清理失败不影响断言 */ }
        }
      }

      // ── 自动配色：色系清单 + 确定性展开 + 按文件记住 ──
      //  色值的真源在 `app-core::palette`：这里钉的是"展开可复现、换色系只动颜色、
      //  画布型如实拒绝、选择按文件记住"这四件事，而不是某个具体 hex。
      {
        const pals = (info && info.palettes) || [];
        ok(
          "app_info 带 6 个色系 × 7 个角色",
          pals.length === 6 && pals.every((p) => p.roles.length === 7 && p.name_zh && p.name_en),
          pals.map((p) => p.id).join(","),
        );
        const body = "flowchart TD\n    A([开始]):::lvl-entry --> C{是否通过?}:::lvl-decide\n    C --> D[(用户库)]:::lvl-data\n";
        const r1 = await invoke("palette_apply", {
          req: { body, format: "mermaid", palette: "pine", dark: false, mode: "all" },
        });
        ok(
          "palette_apply 把角色展开成 classDef",
          r1.changed && /classDef lvl-data fill:#/.test(r1.body) && /class D lvl-data/.test(r1.body),
          `${r1.applied} 个节点`,
        );
        const r2 = await invoke("palette_apply", {
          req: { body: r1.body, format: "mermaid", palette: "pine", dark: false, mode: "all" },
        });
        ok("重复展开是幂等的（点两次不会多一块）", r2.changed === false && r2.body === r1.body);
        const r3 = await invoke("palette_apply", {
          req: { body: r1.body, format: "mermaid", palette: "lotus", dark: true, mode: "all" },
        });
        ok(
          "换色系/换主题只改色值、不动角色",
          r3.changed && r3.body !== r1.body &&
            (r3.body.match(/^class .* lvl-/gm) || []).join() === (r1.body.match(/^class .* lvl-/gm) || []).join(),
          r3.body.length,
        );
        let canvasErr = "";
        try {
          await invoke("palette_apply", {
            req: { body: "{}", format: "drawio", palette: "pine", dark: false, mode: "all" },
          });
        } catch (e) {
          canvasErr = String((e && e.message) || e);
        }
        ok("画布型如实拒绝配色", canvasErr.includes("画布型"), canvasErr);

        // D2：我们靠"后写的属性覆盖先前的"实现整篇重排 —— 这条假设必须真渲染一次验，
        // 否则 D2 上的「重排」可能是个空操作（用户点了没变化）。
        {
          const pineMain = pals
            .find((p) => p.id === "pine")
            .roles.find((r) => r.role === "main").light.fill.toLowerCase();
          const d2Body = "a: 开始\nb: 写库\na.style.fill: \"#123456\"\n";
          const painted = await invoke("palette_apply", {
            req: { body: d2Body, format: "d2", palette: "pine", dark: false, mode: "all" },
          });
          let svg = "";
          try {
            svg = await DGM.d2.renderSvg(painted.body, "dagre");
          } catch (e) {
            svg = "";
          }
          const hexes = (svg.match(/#[0-9a-fA-F]{6}/g) || []).map((x) => x.toLowerCase());
          ok(
            "D2 的配色真的盖住了手写 style（后写者生效）",
            !!svg && !hexes.includes("#123456") && hexes.includes(pineMain),
            svg ? `${hexes.length} 个色值 / 期望 ${pineMain}` : "D2 没渲染出来",
          );
        }

        // 连线与箭头都要跟着色系。用 init 指令的 lineColor（`linkStyle` 只染线、箭头仍是 #333），
        // 所以这里两条都断言 —— 只验线的话，"箭头没变"这种半吊子实现会被放过。
        {
          const edgeHex = String(pals.find((p) => p.id === "pine").edge_light).toLowerCase();
          const painted = await invoke("palette_apply", {
            req: {
              body: "flowchart TD\n    A([开始]) --> B[写库]\n",
              format: "mermaid",
              palette: "pine",
              dark: false,
              mode: "all",
            },
          });
          const toHex = (rgb) => {
            const m = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(String(rgb || ""));
            return m ? "#" + [m[1], m[2], m[3]].map((x) => Number(x).toString(16).padStart(2, "0")).join("") : String(rgb || "");
          };
          let stroke = "";
          let marker = "";
          try {
            const out = await window.mermaid.render("dgm-edge-probe", painted.body);
            const host = document.createElement("div");
            host.style.cssText = "position:fixed;left:-9999px;top:0";
            host.innerHTML = out.svg;
            document.body.appendChild(host);
            const path = host.querySelector("path.flowchart-link, .edgePath path");
            const mk = host.querySelector("marker path");
            stroke = path ? getComputedStyle(path).stroke : "";
            marker = mk ? getComputedStyle(mk).fill : "";
            host.remove();
          } catch (e) {
            stroke = "ERR " + ((e && e.message) || e);
          }
          ok("连线颜色跟着色系", toHex(stroke) === edgeHex, `${toHex(stroke)} 期望 ${edgeHex}`);
          ok("箭头颜色也跟着（不只是线）", toHex(marker) === edgeHex, `${toHex(marker)} 期望 ${edgeHex}`);
        }

        // 新建 = 无；打开 = 按图内容探测；配色是**渲染期**的（不写正文）
        {
          const nd = await invoke("doc_new", { format: "mermaid" });
          ok("新建文档默认不上色", nd && nd.scheme === "", nd ? String(nd.scheme) : "没建出来");
          await invoke("doc_close", { id: nd.id });

          // 打开一份"数据节点多、还带手写颜色"的文件 → 探测出黛蓝，且正文一个字都不改
          // 直接写盘（`export_write` 的白名单收 .mmd），别用 doc_set_body —— 那只改内存不落盘。
          // 路径用**命令返回的**：自己拼的字符串与后端规范化后的可能不等（拖放那条踩过）。
          const detBody =
            "flowchart TD\n    A[(用户库)] --> B[(订单库)]\n    B --> C[(日志库)]\n    style C fill:#f00\n";
          const detPath = await invoke("export_write", {
            path: wsDir + "/selftest-detect.mmd",
            base64: encRaw(detBody),
          });
          // `wsDir` 可能是混合分隔符（报告路径里带 `\`），两边都得归一后再比
          const norm = (x) => String(x || "").replace(/\\/g, "/").toLowerCase();
          const samePath = (x) => norm(x) === norm(detPath);
          await DGM.state.openPaths([detPath]);
          // 读**状态里**的文档：`doc_open_paths` 的响应是打开那一刻的快照，探测是在之后做的
          const dd = DGM.state.docs.find((x) => samePath(x.path)) || {};
          ok("打开文件按图内容探测配色", dd.scheme === "indigo", String(dd.scheme));
          ok("探测不写正文（文件不变脏）", String(dd.body).includes("style C fill:#f00") && !String(dd.body).includes("classDef"), "正文被改过");
          const scan = await invoke("palette_scan", { req: { body: dd.body, format: "mermaid" } });
          ok("体检数出手写颜色", scan.traces === 1 && scan.sig === "A,B,C", `traces=${scan.traces} sig=${scan.sig}`);

          // 渲染期上色：设了色系 → 预览里有色；正文里没有；置「无」→ 颜色消失
          // 这份图全是"数据/存储"节点（C 带手写颜色会被跳过），所以要验 **data 角色**的色
          const fmtPal = (info.palettes.find((p) => p.id === "indigo") || {}).roles.find((r) => r.role === "data");
          const dark = document.documentElement.dataset.theme === "dark";
          const want = String(dark ? fmtPal.dark.fill : fmtPal.light.fill).toLowerCase();
          const stageHas = () => {
            const svg = document.querySelector("#canvas-stage svg");
            return !!svg && svg.outerHTML.toLowerCase().includes(want);
          };
          let got = false;
          for (let i = 0; i < 40 && !got; i++) {
            if (DGM.preview && DGM.preview.schedule) DGM.preview.schedule();
            await new Promise((r) => setTimeout(r, 100));
            got = stageHas();
          }
          ok("设置色系后预览真的上了色", got, `等 ${want}`);
          ok("但正文里没有 classDef（渲染期上色）", !String((DGM.state.doc(dd.id) || {}).body).includes("classDef"));
          await DGM.state.setScheme(dd.id, "");
          let gone = false;
          for (let i = 0; i < 40 && !gone; i++) {
            if (DGM.preview && DGM.preview.schedule) DGM.preview.schedule();
            await new Promise((r) => setTimeout(r, 100));
            gone = !stageHas();
          }
          ok("选「无」后预览颜色消失（正文本来就干净）", gone);
          await invoke("doc_close", { id: dd.id });
          try {
            await invoke("workspace_delete", { path: detPath });
          } catch (e) { /* 清理失败不影响断言 */ }
        }

        // 只写缓冲区、不落盘：开了自动保存也一样（应用配色 / 清除 / AI 结果都走这条路）
        {
          const holdPath = await invoke("export_write", {
            path: wsDir + "/selftest-hold.mmd",
            base64: encRaw("flowchart TD\n    A --> B\n"),
          });
          const norm2 = (x) => String(x || "").replace(/\\/g, "/").toLowerCase();
          const read = async () => {
            try {
              return (await invoke("file_read_text", { path: holdPath })).text;
            } catch (e) {
              return "";
            }
          };
          // 记下原来的设置再改：后面的"草稿"断言**依赖自动保存**（草稿由 autosave 落盘），
          // 这里强制关掉会把别人铺好的前置条件拆了
          const prevAuto = !!(DGM.state.settings.editor && DGM.state.settings.editor.autosave);
          const prevMs = (DGM.state.settings.editor && DGM.state.settings.editor.autosave_ms) || 5000;
          await invoke("settings_patch", { patch: { editor: { autosave: true, autosave_ms: 500 } } });
          await DGM.state.openPaths([holdPath]);
          const hd = DGM.state.docs.find((x) => norm2(x.path) === norm2(holdPath)) || {};
          if (hd.id) {
            await DGM.state.setBodyNow(hd.id, "flowchart TD\n    A --> B\n    B --> C\n", { hold: true });
            // 自动保存的工作线程 1 秒醒一次 + 500ms 延迟 ⇒ 等 2.5s 才算"它本来会写"
            await new Promise((r) => setTimeout(r, 2500));
            const disk1 = await read();
            ok(
              "hold 写入不落盘（自动保存开着也不写）",
              !String(disk1).includes("B --> C"),
              `磁盘：${String(disk1).replace(/\s+/g, " ").slice(0, 60)}`,
            );
            ok("但文档确实变了（缓冲区里有）", String(((DGM.state.doc(hd.id) || {}).body || "")).includes("B --> C"));
            await DGM.state.setBodyNow(hd.id, "flowchart TD\n    A --> B\n    B --> D\n", {});
            await new Promise((r) => setTimeout(r, 2500));
            const disk2 = await read();
            ok(
              "普通写入照旧走自动保存",
              String(disk2).includes("B --> D"),
              `磁盘：${String(disk2).replace(/\s+/g, " ").slice(0, 60)}`,
            );
            await invoke("doc_close", { id: hd.id });
          } else {
            ok("hold 写入不落盘（自动保存开着也不写）", false, "没打开文件");
            ok("但文档确实变了（缓冲区里有）", false, "没打开文件");
            ok("普通写入照旧走自动保存", false, "没打开文件");
          }
          await invoke("settings_patch", {
            patch: { editor: { autosave: prevAuto, autosave_ms: prevMs } },
          });
          try {
            await invoke("workspace_delete", { path: holdPath });
          } catch (e) { /* 清理失败不影响断言 */ }
        }

        // 恢复默认配色 + 连线开关（3.11.4）
        {
          const src = "flowchart TD\n    A([开始]) --> B[写库]\n";
          const painted = await invoke("palette_apply", {
            req: { body: src, format: "mermaid", palette: "pine", dark: false, edges: true, mode: "all" },
          });
          const noEdges = await invoke("palette_apply", {
            req: { body: src, format: "mermaid", palette: "pine", dark: false, edges: false, mode: "all" },
          });
          ok(
            "关掉连线开关后不再写线色（节点照常上色）",
            !noEdges.body.includes("lineColor") && noEdges.body.includes("classDef lvl-main"),
            noEdges.body.includes("lineColor") ? "仍有 lineColor" : "ok",
          );
          const cleared = await invoke("palette_clear", { req: { body: painted.body, format: "mermaid" } });
          ok(
            "恢复默认配色只删程序生成的那块",
            cleared.changed && !cleared.body.includes("dgm-palette") && !cleared.body.includes("classDef"),
            cleared.changed ? `${cleared.body.length} 字节` : "没变",
          );
          const again = await invoke("palette_clear", { req: { body: cleared.body, format: "mermaid" } });
          ok("再清一次如实报「没变」", again.changed === false);
          const s1 = await invoke("settings_patch", { patch: { palette_edges: false } });
          ok("连线开关能落设置", s1.palette_edges === false, String(s1.palette_edges));
          await invoke("settings_patch", { patch: { palette_edges: true } });
        }

        // 用命令**返回的**路径：自己拼的字符串与后端规范化后的可能不等（拖放那条已踩过）
        const palPath = await invoke("workspace_new_file", { dir: wsDir, name: "selftest-palette", format: "mermaid" });
        const op = await invoke("doc_open_paths", { paths: [palPath] });
        const pd = op.docs.find((x) => String(x.path || "").replace(/\\/g, "/") === palPath) || {};
        ok(
          "新打开的文档没有文档级色系（跟随默认）",
          !!pd.id && pd.scheme == null,
          pd.id ? String(pd.scheme) : "没找到刚打开的那份",
        );
        const set = await invoke("doc_set_scheme", { id: pd.id, scheme: "tungsten" });
        ok("doc_set_scheme 生效", set.scheme === "tungsten", set.scheme);
        await invoke("doc_close", { id: pd.id });
        const op2 = await invoke("doc_open_paths", { paths: [palPath] });
        const pd2 = op2.docs.find((x) => String(x.path || "").replace(/\\/g, "/") === palPath) || {};
        ok("色系按文件记住（重开还在）", pd2.scheme === "tungsten", String(pd2.scheme));
        await invoke("doc_close", { id: pd2.id });
        try {
          await invoke("workspace_delete", { path: palPath });
        } catch (e) { /* 清理失败不影响断言 */ }
      }

      // ── 拖拽打开文件（3.11.3）：原生拖放事件 → 打开标签页 ──
      //  OS 级拖放没法在脚本里制造，直接喂 payload 给公开的分发函数（DGM.shell.handleFileDrop）：
      //  验的是"悬停亮提示层 / 落下开文件 / 不支持的不静默吞 / 落点在 AI 面板时让给它"。
      {
        // 注意：**不能用 `export_write`** 造这个文件 —— 它的白名单只收图片/报告类扩展名，
        // 写 `.dot` 会被挡（自检第一版就是这么红的）。用工作区新建文件那条路。
        // 用命令**返回的**路径（而不是自己拼一个）：身份比较得是同一个字符串，
        // 否则断言失败时说不清是"没打开"还是"路径写法不同"。
        const dropPath = await invoke("workspace_new_file", { dir: wsDir, name: "selftest-dropped", format: "dot" });
        const veil0 = document.querySelector("#drop-veil");
        const over = await DGM.shell.handleFileDrop({ type: "over", paths: [dropPath], position: { x: 400, y: 300 } });
        const veilOn = !!veil0 && !veil0.hidden;
        const dropped = await DGM.shell.handleFileDrop({ type: "drop", paths: [dropPath], position: { x: 400, y: 300 } });
        const veilOff = !!veil0 && veil0.hidden;
        const ddoc = DGM.state.docs.find((x) => String(x.path || "").replace(/\\/g, "/") === dropPath) || {};
        ok(
          "拖入悬停亮起提示层、落下即收",
          over === false && veilOn && veilOff,
          `over=${over} on=${veilOn} off=${veilOff}`,
        );
        ok(
          "拖入图表文件开成标签页",
          dropped === true && ddoc.format === "dot",
          `${dropped} ${ddoc.format} ${dropPath} docs=${JSON.stringify(DGM.state.docs.map((x) => x.path))}`,
        );

        // 不认得的扩展名：不开标签页、不静默吞（状态栏出声）
        const n0 = DGM.state.docs.length;
        const bad = await DGM.shell.handleFileDrop({ type: "drop", paths: [wsDir + "/selftest-dropped.png"], position: { x: 400, y: 300 } });
        ok(
          "拖入不支持的扩展名被挡下并出声",
          bad === false && DGM.state.docs.length === n0 && String(DGM.state.ui.status.text || "").length > 0,
          `bad=${bad} docs=${DGM.state.docs.length} status=${DGM.state.ui.status.text}`,
        );

        // 落点在 AI 面板 → 归它（当对话上下文），这里什么都不做
        const aiPane = document.querySelector("#ai-pane");
        let ownsDrop = false;
        let aiDropped = true;
        if (aiPane && !aiPane.classList.contains("hidden-pane")) {
          const r = aiPane.getBoundingClientRect();
          const s = window.devicePixelRatio || 1;
          const pos = { x: (r.left + r.width / 2) * s, y: (r.top + r.height / 2) * s };
          ownsDrop = !!DGM.ai.ownsDropAt(pos);
          const before = DGM.state.docs.length;
          aiDropped = await DGM.shell.handleFileDrop({ type: "drop", paths: [dropPath], position: pos });
          aiDropped = aiDropped === false && DGM.state.docs.length === before;
        }
        ok("落在 AI 面板上的拖放不被打开文件抢走", !aiPane || aiPane.classList.contains("hidden-pane") || (ownsDrop && aiDropped));

        try { await invoke("doc_close", { id: ddoc.id }); } catch (e) { /* 不在会话里就算了 */ }
        try { await invoke("workspace_delete", { path: dropPath }); } catch (e) { /* 清理失败不影响断言 */ }
      }

      // ── 外部文件作为 AI 上下文：读盘（含截断/二进制拒绝）、拖放落点、手填路径 ──
      //  「指定某个文件给 AI 看」这条链的真机部分在这里钉死；"文件内容有没有真的进请求"
      //  由浏览器原型（tools/dev/ui_probe.py）用 mock 的 `[ctx]` 回显夹具断言 —— 真机自检
      //  没有可用的上游，发不出真实请求。
      {
        const ctxPath = wsDir + "/flows/ctx-note.mmd";
        await invoke("export_write", { path: ctxPath, base64: encRaw("# 需求\n用 mermaid 画登录流程\n") });
        const f = await invoke("file_read_text", { path: ctxPath });
        ok(
          "file_read_text 读回正文与文件名",
          !!f && f.name === "ctx-note.mmd" && f.text.includes("登录流程") && !f.truncated,
          f && `${f.name}/${f.text.length}`,
        );

        const bigPath = wsDir + "/flows/ctx-big.mmd";
        await invoke("export_write", { path: bigPath, base64: encRaw("字".repeat(300 * 1024)) });
        const big = await invoke("file_read_text", { path: bigPath });
        ok(
          "超过 256 KiB 的文件按上限截断并标出来",
          !!big && big.truncated === true && big.text.length >= 80000 && big.text.length <= 262144,
          big && `${big.text.length} 字符 / truncated=${big.truncated}`,
        );

        let binErr = "";
        try {
          const binPath = wsDir + "/flows/ctx-bin.mmd";
          await invoke("export_write", { path: binPath, base64: encRaw("\u0000\u0001\u0002binary") });
          await invoke("file_read_text", { path: binPath });
        } catch (e) {
          binErr = (e && e.message) || String(e);
        }
        ok("二进制文件被拒绝并说明原因（不是静默乱码）", binErr.includes("NUL"), binErr);

        // 拖放：命中 AI 面板才算数（落在面板外的拖动不该被这里吞掉）
        // 注意：自检里没有裸 `state`，要用 `DGM.state`（`st` 就是它）
        ok("原生文件拖放已接上", st && st.ui.aiDragDrop === true, String(st && st.ui.aiDragDrop));
        ok("整窗拖放打开已接上", st && st.ui.fileDrop === true, String(st && st.ui.fileDrop));
        const paneRect = document.querySelector("#ai-pane").getBoundingClientRect();
        const dpr = window.devicePixelRatio || 1;
        await DGM.ai.handleDrop({
          type: "drop",
          paths: [ctxPath],
          position: { x: (paneRect.left + paneRect.width / 2) * dpr, y: (paneRect.top + paneRect.height / 2) * dpr },
        });
        ok("拖到 AI 面板 → 进了上下文", DGM.ai.contextFiles().length === 1, JSON.stringify(DGM.ai.contextFiles().map((x) => x.name)));
        ok(
          "上下文 chip 上显示文件名",
          (document.querySelector("#ai-attachments") || {}).textContent.includes("ctx-note.mmd"),
          (document.querySelector("#ai-attachments") || {}).textContent || "",
        );
        await DGM.ai.handleDrop({ type: "drop", paths: [bigPath], position: { x: 4, y: 4 } });
        ok("拖到面板之外不动上下文", DGM.ai.contextFiles().length === 1, DGM.ai.contextFiles().length);

        // 输入框上方那颗「选择文件」按钮：排在「把当前图作为上下文」之后；再走一次去重
        const fbtn = document.querySelector("#ai-file-pick");
        const cbtn = document.querySelector("#ai-context");
        ok(
          "「选择文件」按钮排在「把当前图作为上下文」之后",
          !!fbtn && !!cbtn && !!(cbtn.compareDocumentPosition(fbtn) & Node.DOCUMENT_POSITION_FOLLOWING),
          !!fbtn,
        );
        await DGM.ai.addContextFile(ctxPath); // 同一路径：按去重拒绝
        ok("重复附加同一路径不重复入列", DGM.ai.contextFiles().length === 1, DGM.ai.contextFiles().length);

        DGM.ai.removeContextFile(ctxPath);
        ok("移除后上下文为空", DGM.ai.contextFiles().length === 0, DGM.ai.contextFiles().length);

        for (const p of [ctxPath, bigPath, wsDir + "/flows/ctx-bin.mmd"]) {
          try {
            await invoke("workspace_delete", { path: p });
          } catch (e) { /* 清理失败不影响断言 */ }
        }
      }

      // ── 对话历史 →「全部」：未保存文档的会话也列出来，且能恢复/删除 ──
      //  数据来自 `conversation_list`（只读 meta）。草稿的「活着」是现算的：草稿仓里还有
      //  那份才叫草稿，否则就是「已失联」—— 所以这里等 autosave（5s）把草稿落下来。
      {
        // 这段**依赖自动保存**（草稿是 autosave 落盘的）——自己打开它、用完还原，
        // 别赌用户的设置里正好开着（曾经因为上游测试把开关关掉而红过一次）。
        const prevAuto2 = !!(DGM.state.settings.editor && DGM.state.settings.editor.autosave);
        const prevMs2 = (DGM.state.settings.editor && DGM.state.settings.editor.autosave_ms) || 5000;
        await invoke("settings_patch", { patch: { editor: { autosave: true, autosave_ms: 500 } } });
        const hd = await invoke("doc_new", { format: "mermaid" });
        await invoke("doc_set_body", { id: hd.id, body: "flowchart TD\n    A([草稿]) --> B[未保存]\n" });
        await invoke("conversation_save", {
          id: hd.id,
          turns: [
            { role: "user", text: "草稿里的问题", at: Date.now() - 2000 },
            { role: "assistant", text: "草稿里的回答", at: Date.now() - 1000, model: "GLM-5.2", tokens: 3 },
          ],
        });
        let row = null;
        for (let i = 0; i < 20; i++) {
          const list = await invoke("conversation_list");
          row = list.find((m) => !m.path && m.first_prompt === "草稿里的问题") || null;
          if (row && row.live_draft) break;
          await new Promise((r) => setTimeout(r, 400));
        }
        ok(
          "未保存文档的会话出现在「全部」列表里",
          !!row && row.turns === 2 && row.missing === false,
          row && JSON.stringify({ turns: row.turns, missing: row.missing }),
        );
        ok("草稿被识别为「草稿」而不是「已失联」", !!row && row.live_draft === true, row && String(row.live_draft));
        const reopened = row ? await invoke("conversation_open", { key: row.key }) : null;
        ok("从列表恢复草稿 → 回到同一个未保存标签页", !!reopened && reopened.id === hd.id, reopened && reopened.id);
        if (row) await invoke("conversation_delete", { key: row.key });
        const after = await invoke("conversation_list");
        ok("删除后列表里不再有这段会话", !after.some((m) => m.key === (row ? row.key : "-")), after.length);
        await invoke("settings_patch", {
          patch: { editor: { autosave: prevAuto2, autosave_ms: prevMs2 } },
        });
        try {
          await invoke("doc_close", { id: hd.id });
        } catch (e) {
          /* 已关掉就算了 */
        }
      }

      // ── 已失联会话的恢复：**要带回最后生成的那张图** ──
      //  一条只会"恢复对话"的恢复没有意义：新标签页必须是那段产物，而不是一张见面示例图。
      //  造法：存文件 → 存一份带 ``` 围栏的会话 → 关标签页 → 删文件（= 已失联）。
      {
        const norm = (p) => String(p || "").replace(/\\/g, "/");
        const orphanPath = wsDir + "/flows/orphan-restore.mmd";
        const code = "graph TD\n    R([恢复]) --> OK[图还在]";
        await invoke("export_write", { path: orphanPath, base64: encRaw("flowchart TD\n    A --> B\n") });
        const opened = await invoke("doc_open_paths", { paths: [orphanPath] });
        const od = (opened.docs || []).find((d) => norm(d.path) === norm(orphanPath)) || opened.docs[0];
        await invoke("conversation_save", {
          id: od.id,
          turns: [
            { role: "user", text: "画个恢复流程图", at: Date.now() - 2000 },
            {
              role: "assistant",
              text: "```mermaid\n" + code + "\n```",
              at: Date.now() - 1000,
              model: "GLM-5.2",
              tokens: 5,
            },
          ],
        });
        await invoke("doc_close", { id: od.id });
        await invoke("workspace_delete", { path: orphanPath });
        const listed = await invoke("conversation_list");
        const orow = listed.find((m) => norm(m.path) === norm(orphanPath)) || null;
        ok("删掉原文件后会话被识别为「已失联」", !!orow && orow.missing === true, orow && String(orow.missing));
        const restored = orow ? await invoke("conversation_open", { key: orow.key }) : null;
        ok(
          "已失联会话恢复后正文就是最后生成的那张图",
          !!restored && restored.body.trim() === code && restored.format === "mermaid" && !restored.path,
          restored && JSON.stringify({ format: restored.format, body: (restored.body || "").slice(0, 40) }),
        );
        if (restored) {
          try {
            await invoke("conversation_delete", { key: "draft-" + restored.id });
          } catch (e) {
            /* 已搬走/已删就算了 */
          }
          try {
            await invoke("doc_close", { id: restored.id });
          } catch (e) {
            /* 已关掉就算了 */
          }
        }
      }

      // ── 文档会话的「打开」：原文件还在时，打开的必须是**那个文件**（不是一张新标签页） ──
      {
        const norm = (p) => String(p || "").replace(/\\/g, "/");
        const livePath = wsDir + "/flows/live-restore.mmd";
        const liveBody = "flowchart TD\n    L([文件]) --> OK[打开]";
        await invoke("export_write", { path: livePath, base64: encRaw(liveBody) });
        const opened = await invoke("doc_open_paths", { paths: [livePath] });
        const ld = (opened.docs || []).find((d) => norm(d.path) === norm(livePath)) || opened.docs[0];
        await invoke("conversation_save", {
          id: ld.id,
          turns: [{ role: "user", text: "文档会话", at: Date.now() }],
        });
        await invoke("doc_close", { id: ld.id });
        const listed = await invoke("conversation_list");
        const drow = listed.find((m) => norm(m.path) === norm(livePath)) || null;
        const reopenedDoc = drow ? await invoke("conversation_open", { key: drow.key }) : null;
        ok(
          "文档会话的「打开」打开的是磁盘上那个文件",
          !!reopenedDoc && norm(reopenedDoc.path) === norm(livePath) && reopenedDoc.body.trim() === liveBody,
          reopenedDoc && JSON.stringify({ path: reopenedDoc.path, body: (reopenedDoc.body || "").slice(0, 30) }),
        );
        if (reopenedDoc) {
          try {
            await invoke("doc_close", { id: reopenedDoc.id });
          } catch (e) {
            /* 已关掉就算了 */
          }
        }
        if (drow) {
          try {
            await invoke("conversation_delete", { key: drow.key });
          } catch (e) {
            /* 已删就算了 */
          }
        }
        try {
          await invoke("workspace_delete", { path: livePath });
        } catch (e) {
          /* 已删就算了 */
        }
      }

      // 多词命令参数的命名一致性（ai_cancel 曾在两侧各写一套，真机上才炸）
      let cancelErr = "";
      try {
        await invoke("ai_cancel", { id: "no-such-request" });
      } catch (e) {
        cancelErr = (e && e.message) || String(e);
      }
      ok("ai_cancel 的参数能被解析（多词参数两侧一致）", cancelErr.includes("结束"), cancelErr.slice(0, 60));

      // BYOK 密钥的键名必须**只有一处**在算：写走 `ai_provider_key_set`（Rust 加
      // `ai-provider:` 前缀），读走 `hydrate_models` 查同一把键。这里把这条配对钉住；
      // 用完恢复原有配置，别动用户的模型/供应商。
      let keyPair = null;
      const beforeKey = await invoke("settings_get");
      const origAi = beforeKey.ai || {};
      const origProviders = origAi.providers || [];
      const origModels = origAi.models || [];
      try {
        const probeId = "selftest-key-probe";
        await invoke("ai_provider_key_set", { providerId: probeId, secret: "sk-selftest" });
        const patched = await invoke("settings_patch", {
          patch: {
            ai: {
              providers: origProviders.concat([
                { id: probeId, name: "selftest", provider: "openai", base_url: "https://example.invalid/v1", max_tokens: 16, temperature: 0 },
              ]),
              models: origModels.concat([
                { id: "selftest-model-probe", provider_id: probeId, model: "x", name: "selftest" },
              ]),
            },
          },
        });
        const probe = (patched.ai.models || []).find((m) => m.id === "selftest-model-probe");
        keyPair = probe ? !!probe.has_key : null;
        await invoke("ai_provider_key_delete", { providerId: probeId });
      } finally {
        await invoke("settings_patch", { patch: { ai: { providers: origProviders, models: origModels } } });
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
      // 剪贴板是全局单例：剪贴板管理器 / 截图工具会占住它。vision.rs 已带 1.5s 小步重试
      // （瞬态占用必成），但**长期持锁**（比如机器上正开着截图/剪贴板历史类工具）时重试
      // 也拿不到。这不是本应用能修的：系统剪贴板整体不可用时（PowerShell 的 Get-Clipboard
      // 也会失败）按**跳过**记，别让环境问题把发布门禁判成代码回归。
      let clipOk = null;
      let clipErr = "";
      try {
        clipOk = await invoke("clip_write_image", { base64: png });
      } catch (e) {
        clipErr = String((e && e.message) || e);
      }
      const clipEnv = /not accessible due to being held|剪贴板操作失败|OpenClipboard/i.test(clipErr);
      if (clipEnv) {
        note("selftest:skip 原生剪贴板写图（系统剪贴板不可用）：" + clipErr);
      } else {
        ok("原生剪贴板写图（arboard）", clipOk === true, clipOk === true ? "true" : clipErr || String(clipOk));
      }
      if (clipOk === true) {
        try {
          const back = await invoke("clip_read_image");
          ok("剪贴板读回尺寸一致", back[0] === 7 && back[1] === 5, JSON.stringify(back));
        } catch (e) {
          // 剪贴板可能被系统/其它程序改写，这不是本应用的错 —— 如实记一条失败原因
          ok("剪贴板读回尺寸一致", false, String((e && e.message) || e));
        }
      } else if (!clipEnv) {
        ok("剪贴板读回尺寸一致", false, "跳过：写剪贴板就失败了（" + (clipErr || clipOk) + "）");
      } else {
        note("selftest:skip 剪贴板读回尺寸一致（系统剪贴板不可用）");
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

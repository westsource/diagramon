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

  /** 走到哪一步了 —— 打到后端 stdout（console 在真机上看不见） */
  const note = (t) => window.DGM && DGM.note && DGM.note(t);

  const writeTo = (reportPath, obj, suffix) =>
    invoke("export_write", {
      path: suffix ? reportPath.replace(/\.json$/, suffix) : reportPath,
      base64: enc(obj),
    });

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
    const ok = (name, pass, extra) => out.push({ name, pass: !!pass, extra: extra == null ? null : extra });

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
      ok("app_info 版本 3.0.0", info && info.version === "3.0.0", info && info.version);
      ok("注册表四种格式", info && info.formats && info.formats.length === 4, info && info.formats && info.formats.map((f) => f.id).join(","));
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

      const bad = clean.replace("B{判断}", "B{连续失败 >= 5?}");
      await invoke("doc_set_body", { id: doc.id, body: bad });
      const issues1 = await invoke("doc_issues", { id: doc.id });
      ok("裸 >= 被判为警告", issues1.some((i) => i.severity === "warning"), JSON.stringify(issues1.map((i) => i.line)));

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
      // 这是自检里唯一需要等的断言：给 20 次 1 秒的机会（节流下也够），不成就如实报失败。
      let queueUp = false;
      for (let i = 0; i < 20 && !queueUp; i++) {
        try {
          queueUp = Array.isArray(frame.contentWindow.__hostQueue);
        } catch (e) {
          queueUp = false;
        }
        if (!queueUp) await new Promise((r) => setTimeout(r, 1000));
      }
      ok("承载页脚本已在同源 iframe 内执行（__hostQueue 就位）", queueUp);

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

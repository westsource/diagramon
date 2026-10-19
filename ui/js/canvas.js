/* 内嵌画布承载（drawio / Excalidraw）：画布 ↔ 正文文本的搬运与协议翻译。
 *
 * **同源 iframe 是关键前提**：外壳页与承载页都在 `dgm` 自定义协议下（见
 * `crates/assets` 与 `src-tauri/src/lib.rs` 的 `webview_url`），因此可以直接读写
 * 承载页的 `window.__hostQueue`、直接调 `window.__apply` ——
 * 不需要脚本注入，也不需要就绪探测。
 *
 * 承载页的契约写在 `tools/drawio-host/host.html` 的注释里（那是它的真源）：
 *   画布 → 本站 : window.__hostQueue.push(str)
 *   本站 → 画布 : frame.contentWindow.__apply(str)
 * 外加三个可选钩子：`__hostZoom()`（当前缩放读数）/ `__hostFit()` / `__hostZoomBy(factor)`。
 * 三者的真源都在各自承载页里；`__hostFit` 返回**是否真的适配了**（false = 没内容可适配 /
 * 画布还没起来），别把它当"命令已发出"。
 *
 * 职责边界：本模块只管「画布 ↔ 正文」的搬运与协议翻译；文件读写仍在 state/shell。
 */
window.DGM = window.DGM || {};
(function () {
  "use strict";

  const state = DGM.state;
  const t = (k, v) => DGM.i18n.t(k, v);

  /** 轮询间隔：drawio 的 autosave 是 1.5s 去抖，120ms 足够跟手又不烧 CPU。 */
  const POLL_MS = 120;

  /** 画布标签页落盘前等待 XML 导出的上限。 */
  const FLUSH_TIMEOUT_MS = 4000;
  /** 位图导出的上限（大图慢）。 */
  const PNG_TIMEOUT_MS = 15000;

  const HOST_SRC = {
    drawio: "/drawio/host.html",
    // Excalidraw 是**库型**集成（同页实例，不是 iframe 套 iframe），所以直接指向它的页面。
    excalidraw: "/excalidraw/index.html",
  };

  /** 每个格式一份常驻实例：切标签页不重建，保留画布内的撤销历史。 */
  const hosts = {};

  /**
   * 登记一次「下一次 show 改用 Mermaid 源码载入」。
   *
   * 转换中心用它：先建目标格式的新文档，再把源码交给承载页 ——
   * 由 drawio / Excalidraw **自己的** Mermaid 导入器解析，而不是让 Rust 再实现一遍。
   */
  let pendingConversion = null;

  /** `opts.mermaid`（可选）随源码一起发给承载页：Mermaid 渲染配置（如 look），
   *  Excalidraw 的导入器支持把它平铺进 mermaid.initialize。drawio 的导入器不可配置，
   *  这里的 opts 它拿不到（descriptor 协议里没有这个字段），如实不传。 */
  function setPendingConversion(format, source, opts) {
    pendingConversion = { format, source, opts: opts || null };
  }

  let container = null;
  let activeFormat = null;
  let pollTimer = 0;

  function entry(format) {
    if (!hosts[format]) {
      hosts[format] = {
        frame: null,
        ready: false,
        loadedDoc: null,
        lastApplied: "",
        pending: [],
        waiters: [],
        /** Excalidraw 的 `files` 段（图片等二进制附件），回写时必须原样带上 */
        files: {},
      };
    }
    return hosts[format];
  }

  function ensureFrame(format) {
    const e = entry(format);
    if (e.frame) return e;
    const src = HOST_SRC[format];
    if (!src) return e; // 未知画布格式：不建 frame
    const frame = document.createElement("iframe");
    frame.className = "canvas-frame canvas-" + format;
    frame.setAttribute("title", t("canvas.frameTitle", { name: state.fmtById(format).name }));
    frame.src = src;
    container.appendChild(frame);
    e.frame = frame;
    frame.addEventListener("load", () => syncTheme(format));
    return e;
  }

  function winFor(format) {
    const e = hosts[format];
    return e && e.frame ? e.frame.contentWindow : null;
  }

  /* ------------------------------------------------------------------ 下发 */

  /** 向承载页投递一个动作（未就绪先排队：`init` 是 drawio 唯一的同步点）。 */
  function send(format, action) {
    const e = entry(format);
    const payload = JSON.stringify(action);
    const win = winFor(format);
    if (!e.ready || !win || typeof win.__apply !== "function") {
      e.pending.push(payload);
      return;
    }
    try {
      win.__apply(payload);
    } catch (err) {
      // 跨源不该发生（同源），但真发生了要让用户知道而不是静默丢动作
      report(t("canvas.sendFail"), err);
    }
  }

  function flushPending(format) {
    const e = entry(format);
    const win = winFor(format);
    if (!e.ready || !win || typeof win.__apply !== "function") return;
    const queued = e.pending.splice(0, e.pending.length);
    for (const payload of queued) {
      try {
        win.__apply(payload);
      } catch (err) {
        report(t("canvas.sendFail"), err);
      }
    }
  }

  /* ------------------------------------------------------------------ 等待者 */

  function takeWaiter(format, kind) {
    const e = entry(format);
    const i = e.waiters.findIndex((w) => w.kind === kind);
    return i < 0 ? null : e.waiters.splice(i, 1)[0];
  }

  function settle(format, kind, payload) {
    const w = takeWaiter(format, kind);
    if (w) w.resolve(payload);
  }

  function report(message, err) {
    const text = err && err.message ? `${message}：${err.message}` : message;
    state.pushOutput(text, "warn");
    if (DGM.toast) DGM.toast({ icon: "alert", title: t("canvas.title"), sub: text, warn: true });
  }

  /* ------------------------------------------------------------------ 回收事件 */

  function handleEvent(format, msg) {
    const e = entry(format);
    switch (msg.event) {
      case "init":
      case "ready":
        e.ready = true;
        flushPending(format);
        break;

      // 文档已载入：**不回写**，否则一打开就被标成「已修改」
      case "load":
      case "loaded":
        break;

      case "autosave":
      case "save":
        if (typeof msg.xml === "string" && msg.xml && msg.xml !== e.lastApplied) {
          e.lastApplied = msg.xml;
          if (e.loadedDoc) state.setBody(e.loadedDoc, msg.xml);
        }
        break;

      // Excalidraw：画布变更以 elements/appState 回传，这里还原成 `.excalidraw` 文件正文
      case "scene": {
        const json = sceneToJson(msg, e);
        if (json && json !== e.lastApplied) {
          e.lastApplied = json;
          if (e.loadedDoc) state.setBody(e.loadedDoc, json);
        }
        if (json) settle(format, "scene", json);
        break;
      }

      case "export":
        if (String(msg.format).toLowerCase() === "xml") {
          e.lastApplied = msg.xml || "";
          settle(format, "xml", msg.xml || "");
        } else {
          settle(format, "png", msg.data || "");
        }
        break;

      case "error":
        report(typeof msg.message === "string" ? msg.message : t("canvas.title"), null);
        break;

      case "hotkey":
        forwardHotkey(msg.combo);
        break;

      default:
        break;
    }
  }

  /**
   * 把 Excalidraw 的 scene 事件还原成 `.excalidraw` 文件正文。
   *
   * `files` 是**图片元素的真正字节**（元素本身只存一个 `fileId`），所以不能只搬 elements：
   * 漏了它，正文里就只剩一个悬空 fileId —— 存盘之后那张图再也回不来。
   * 三个来源按优先级取：事件里带了就用它（承载页只在键集变化时才带，见承载页注释），
   * 否则沿用本地缓存；取到就顺手刷新缓存（缓存是按格式常驻的，不刷新会把上一份文档的附件带过来）。
   */
  function sceneToJson(msg, e) {
    try {
      if (msg.files && typeof msg.files === "object") e.files = msg.files;
      return JSON.stringify({
        type: "excalidraw",
        version: 2,
        source: "Diagramon",
        elements: msg.elements || [],
        appState: msg.appState || {},
        files: e.files || {},
      });
    } catch (err) {
      return null;
    }
  }

  function drain(format) {
    const win = winFor(format);
    if (!win) return;
    let queue;
    try {
      queue = win.__hostQueue;
    } catch (err) {
      return; // 未就绪
    }
    if (!queue || !queue.length) return;
    // 就地 splice（不要换数组引用：承载页持有同一个引用）
    const items = queue.splice(0, queue.length);
    for (const raw of items) {
      try {
        handleEvent(format, typeof raw === "string" ? JSON.parse(raw) : raw);
      } catch (err) {
        /* 非 JSON 载荷忽略 */
      }
    }
  }

  function startPolling() {
    if (pollTimer) return;
    pollTimer = window.setInterval(() => {
      for (const format of Object.keys(hosts)) {
        if (hosts[format].frame) drain(format);
      }
      if (activeFormat && DGM.shell && DGM.shell.renderStatus) {
        const z = hostZoom(activeFormat);
        if (z > 0 && state.ui.zoom !== z) {
          state.ui.zoom = z;
          const val = document.getElementById("zoom-val");
          if (val) val.textContent = Math.round(z * 100) + "%";
          DGM.shell.renderStatus();
        }
      }
    }, POLL_MS);
  }

  /* ------------------------------------------------------------------ 快捷键转发 */

  /**
   * 画布里的焦点在 iframe 内，本站的 window 级 keydown 收不到 ——
   * 承载页在捕获阶段先看一眼、命中应用级组合键就入队回传。
   *
   * **只转发应用级命令**：撤销/剪切这些编辑类留给画布自己（它有它自己的历史）。
   */
  function forwardHotkey(combo) {
    const shell = DGM.shell;
    if (!shell) return;
    switch (combo) {
      case "ctrl+s":
        return shell.saveActive();
      case "ctrl+shift+s":
        return shell.saveActive(true);
      case "ctrl+o":
        return shell.openFile();
      case "ctrl+w":
        return shell.closeActive();
      case "ctrl+n":
        return shell.runCommand && shell.runCommand("file.new");
      case "ctrl+q":
        return shell.quit();
      case "ctrl+0":
        return hostFit(activeFormat);
      case "ctrl+zoom-in":
        return hostZoomBy(activeFormat, 1.1);
      case "ctrl+zoom-out":
        return hostZoomBy(activeFormat, 1 / 1.1);
      default:
        return undefined;
    }
  }

  /* ------------------------------------------------------------------ 主题下发 */

  /**
   * 把当前主题的**画布底色**推进承载页。
   *
   * 取值直接用本站的 CSS 变量 `--canvas-bg`（亮 `#ffffff` / 暗 `#1a1e1f`），
   * 而不是各自硬编码两套颜色 —— 这样"画布底色"只有一处定义。
   *
   * 只改**背景**，不动图形本身的配色：drawio 的图形颜色是文档内容（要落盘、要可 diff），
   * 不该被界面主题改写。Excalidraw 那边走它自己的 `appState.theme`，由它决定。
   */
  function syncTheme(format) {
    const e = hosts[format];
    if (!e || !e.frame) return;
    const bg = getComputedStyle(document.documentElement).getPropertyValue("--canvas-bg").trim();
    if (!bg) return;
    if (format === "drawio") {
      const win = winFor(format);
      try {
        const doc = win && win.document;
        if (!doc || !doc.head) return;
        let style = doc.getElementById("diagramon-theme");
        if (!style) {
          style = doc.createElement("style");
          style.id = "diagramon-theme";
          doc.head.appendChild(style);
        }
        // 与 host.html 里藏缩放框同一个套路：注入样式而不是改 drawio 自己的文件
        //（改上游文件要走 fetch 脚本的补丁 + 清单指纹，只为换一个底色不值当）。
        style.textContent =
          ".geDiagramContainer,.geDiagramBackdrop,.mxGraph{background-color:" + bg + " !important;}";
      } catch (err) {
        /* iframe 还没建文档：load 时会再来一次 */
      }
    }
  }

  function syncThemeAll() {
    for (const format of Object.keys(hosts)) syncTheme(format);
  }

  /* ------------------------------------------------------------------ 对外 */

  /**
   * 让某份画布文档成为当前可见面，并把正文灌进画布。
   *
   * 已经在画布里的同一份文档**不重载** —— 否则每次 `doc:changed`
   *（包括画布自己回写的那些）都会重建画布，用户改一笔就丢一次撤销历史。
   */
  function show(doc) {
    if (!container) return false;
    const format = doc.format;
    if (!HOST_SRC[format]) return false;

    activeFormat = format;
    const e = ensureFrame(format);
    if (!e.frame) return false;

    // 切到另一份文档时，先把旧的藏起来（常驻但不叠着）
    for (const other of Object.keys(hosts)) {
      const f = hosts[other].frame;
      if (f) f.hidden = other !== format;
    }
    container.hidden = false;
    startPolling();
    syncTheme(format);

    if (e.loadedDoc === doc.id) return true;
    e.loadedDoc = doc.id;
    e.lastApplied = doc.body || "";
    e.ready = false; // 新文档要等新一轮 init
    e.pending.length = 0;

    // 转换：这次载入的不是正文，而是 Mermaid 源码（交给引擎自己的导入器）
    if (pendingConversion && pendingConversion.format === format) {
      const source = pendingConversion.source;
      const opts = pendingConversion.opts;
      pendingConversion = null;
      // 附件缓存是按格式常驻的单例：不归零，上一份文档的 files 会被写进这份新文档
      e.files = {};
      loadMermaid(format, source, opts);
      return true;
    }

    const body = doc.body || "";

    if (format === "drawio") {
      send(format, { action: "load", xml: body, autosave: 1 });
      return true;
    }

    // Excalidraw：正文就是场景 JSON，直接 setScene；顺带记住 files 段（回写要带上）
    let scene = null;
    try {
      scene = JSON.parse(body);
    } catch (err) {
      scene = null;
    }
    if (!scene) {
      // 空文档 / 尚未成形：给一个最小合法骨架，别把空字符串塞进去
      scene = { type: "excalidraw", version: 2, elements: [], appState: {}, files: {} };
      // 界面主题 = 画布主题（Excalidraw 自己认这个字段）
      if (document.documentElement.dataset.theme === "dark") scene.appState.theme = "dark";
    }
    e.files = scene.files || {};
    send(format, { action: "setScene", scene: JSON.stringify(scene) });
    return true;
  }

  function hide() {
    activeFormat = null;
    if (container) container.hidden = true;
  }

  /** 文档关闭：销毁它的画布实例（否则常驻 frame 会留着已关文档的内容）。 */
  function teardown(format) {
    const e = hosts[format];
    if (!e) return;
    if (e.frame && e.frame.parentNode) e.frame.parentNode.removeChild(e.frame);
    delete hosts[format];
    if (activeFormat === format) activeFormat = null;
  }

  /**
   * 落盘前取画布当前正文。
   *
   * * drawio：向画布要 XML（与 autosave 同源，只是不等 1.5s 去抖）
   * * Excalidraw：正文由 `scene` 事件持续回写，直接返回当前值（协议没有 XML 导出档）
   */
  function flush(format) {
    const e = hosts[format];
    if (!e || !e.frame || e.loadedDoc === null) return Promise.resolve(null);
    if (format !== "drawio") {
      // Excalidraw：`scene` 事件只在真实变更时推，外部载入（setScene / loadMermaid）
      // 之后被静默挡掉，所以这里**主动要一次**；等它回来再返回。
      return new Promise((resolve) => {
        e.waiters.push({ kind: "scene", resolve });
        send(format, { action: "getScene" });
        setTimeout(() => {
          const w = takeWaiter(format, "scene");
          if (w) w.resolve(e.lastApplied || null);
        }, FLUSH_TIMEOUT_MS);
      });
    }
    return new Promise((resolve) => {
      e.waiters.push({ kind: "xml", resolve });
      send(format, { action: "export", format: "xml" });
      setTimeout(() => {
        const w = takeWaiter(format, "xml");
        if (w) w.resolve(null);
      }, FLUSH_TIMEOUT_MS);
    });
  }

  /**
   * 等画布产出**与 `before` 不同**的正文。
   *
   * 转换用：把 Mermaid 源码交给引擎解析后要取回结果。不能固定 sleep ——
   * 解析耗时取决于图的大小；也不能只取一次 —— 引擎是异步的，早取会拿到空图。
   * 所以轮询 `flush()`，直到内容变了或试完为止（返回空串表示没等到）。
   */
  function waitForBody(format, before, tries) {
    const max = tries || 30;
    return new Promise((resolve) => {
      let i = 0;
      const tick = () => {
        flush(format)
          .then((body) => {
            if (typeof body === "string" && body.trim() && body !== before) return resolve(body);
            if (++i >= max) return resolve("");
            setTimeout(tick, 600);
          })
          .catch(() => resolve(""));
      };
      tick();
    });
  }

  /**
   * 等画布产出**与 `before` 不同、且连续两次相同**的正文（3.11.0 的转换链用它）。
   *
   * 为什么不能只看“变化了一次”：drawio 的导入是异步的，早取会拿到**半张图**
   * （第一帧可能只有部分 cell）。连续两次相同 = 引擎已经停手。8s 是硬上限：
   * 到点仍没稳定就返回最后那次（调用方按 `""` 处理失败），绝不无限等。
   */
  function waitForStable(format, before, budgetMs) {
    const budget = budgetMs || 8000;
    const step = 300;
    const started = Date.now();
    return new Promise((resolve) => {
      let last = "";
      const tick = () => {
        flush(format)
          .then((body) => {
            const text = typeof body === "string" ? body : "";
            if (text.trim() && text !== before) {
              if (text === last) return resolve(text);
              last = text;
            }
            if (Date.now() - started >= budget) {
              return resolve(text !== before && text.trim() ? text : "");
            }
            setTimeout(tick, step);
          })
          .catch(() => resolve(""));
      };
      tick();
    });
  }

  /** 页内导出位图（返回 data URI）。 */
  function exportPng(format, scale, transparent) {
    const e = hosts[format];
    if (!e || !e.frame || e.loadedDoc === null) return Promise.resolve(null);
    return new Promise((resolve) => {
      e.waiters.push({ kind: "png", resolve });
      send(format, { action: "export", format: "png", scale, transparent });
      setTimeout(() => {
        const w = takeWaiter(format, "png");
        if (w) w.resolve(null);
      }, PNG_TIMEOUT_MS);
    });
  }

  /** 把 Mermaid 源码交给画布解析（单向转换；第 3 步的转换中心用它）。
   *
   *  `opts.mermaid` 仅 Excalidraw 认：随 loadMermaid 消息发给承载页，
   *  由 convertMermaid(source, config) 平铺进 m2e 内置 mermaid 的 initialize。
   *  drawio 的 descriptor 协议没有配置位，不传。 */
  function loadMermaid(format, source, opts) {
    const e = entry(format);
    e.lastApplied = "";
    if (format === "drawio") {
      send(format, { action: "load", autosave: 1, descriptor: { format: "mermaid", data: source, wrap: true } });
    } else {
      send(format, { action: "loadMermaid", source, mermaid: (opts && opts.mermaid) || undefined });
    }
  }

  function hostZoom(format) {
    const win = format && winFor(format);
    if (!win || typeof win.__hostZoom !== "function") return 0;
    try {
      return win.__hostZoom() || 0;
    } catch (err) {
      return 0;
    }
  }

  /**
   * 应用级「适应视图」。
   *
   * 返回**承载面是否真的适配了**：承载页的钩子对"没东西可适配"（空文档、画布还没起来、
   * 图/场景还没建）如实回 false。这个裁决必须传出去 —— 否则调用方会把一次什么都没做的
   * 动作记成"已适配"，下次不再重试（见 preview.js::fit 的 fittedFor 记账）。
   */
  function hostFit(format) {
    const win = format && winFor(format);
    if (!win || typeof win.__hostFit !== "function") return false;
    try {
      return win.__hostFit() === true;
    } catch (err) {
      return false; // 画布还没起来：当成"没适配"，不要骗调用方
    }
  }

  function hostZoomBy(format, factor) {
    const win = format && winFor(format);
    if (!win || typeof win.__hostZoomBy !== "function") return;
    try {
      win.__hostZoomBy(factor);
    } catch (err) {
      /* 同上 */
    }
  }

  function init(opts) {
    container = opts.container;
  }

  DGM.canvas = {
    init,
    show,
    hide,
    teardown,
    flush,
    waitForBody,
    waitForStable,
    exportPng,
    loadMermaid,
    setPendingConversion,
    syncThemeAll,
    hostZoom,
    hostFit,
    hostZoomBy,
    isReady: (format) => Boolean(hosts[format] && hosts[format].ready),
    loadedDoc: (format) => (hosts[format] ? hosts[format].loadedDoc : null),
    supports: (format) => Boolean(HOST_SRC[format]),
  };

  DGM.bus.on("settings:changed", syncThemeAll);
})();

/* 内嵌画布承载（drawio / Excalidraw）：画布 ↔ 正文文本的搬运与协议翻译。
 *
 * **同源 iframe 是关键前提**：外壳页与承载页都在 `dgm` 自定义协议下（见
 * `crates/assets` 与 `src-tauri/src/lib.rs` 的 `webview_url`），因此可以直接读写
 * 承载页的 `window.__hostQueue`、直接调 `window.__apply` ——
 * 不需要脚本注入，也不需要就绪探测。
 *
 * 承载页的契约写在 `tools/drawio-host/host.html` 的注释里（那是它的真源）：
 *   画布 → 本站 : window.__hostQueue.push(str) + window.__hostEpochs.push(代际)
 *   本站 → 画布 : frame.contentWindow.__apply(str)
 * 外加三个可选钩子：`__hostZoom()`（当前缩放读数）/ `__hostFit()` / `__hostZoomBy(factor)`。
 * 三者的真源都在各自承载页里；`__hostFit` 返回**是否真的适配了**（false = 没内容可适配 /
 * 画布还没起来），别把它当"命令已发出"。
 *
 * **代际令牌**（`__hostEpoch` / `__hostEpochs`，审计 2026-11-03 M-27）解决"这条画布事件
 * 属于哪份文档"：`show()` 换文档时 +1，但**只在承载页回 `load`/`loaded` 之后**才把新值
 * 交给它（`confirmEpoch`）—— 提前给会把换图前产生、换图后才入队的旧内容标成新代际。
 * `drain` 丢掉"带旧代际的内容事件"，但放行生命周期事件（否则那条 ack 自己会被丢掉，
 * 代际永远翻不过来）。旧承载页没有 `__hostEpochs` ⇒ 代际 0 ⇒ 不按代际过滤，行为照旧。
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
        /**
         * 代际令牌（审计 2026-11-03 M-27）。每切一份文档 +1，随 `__hostEpoch` 交给承载页，
         * 承载页入队时把当时的代际记在同下标的 `__hostEpochs` 里。回传事件代际不匹配
         * 就是**上一份文档的迟到事件**，必须丢掉 —— 否则会写进新文档的正文。
         *
         * 两个真实窗口：① 120ms 轮询 tick 之前 `__hostQueue` 里已经躺着 A 的 autosave，
         * 用户切到同格式的 B，drain 时 `loadedDoc` 已经是 B；② drawio 的 1.5s autosave
         * 去抖在 `__apply(load B)` 之后、画布真正换文档之前到期。
         */
        epoch: 0,
        /** drawio：load 已发出、还没收到 `load/loaded` 确认（大图要几秒） */
        loading: false,
        loadWaiters: [],
        /** Excalidraw 的 `files` 段（图片等二进制附件），回写时必须原样带上 */
        files: {},
      };
    }
    return hosts[format];
  }

  /** 被代际过滤丢掉的事件数（诊断与探针用；正常应为 0）。 */
  let staleDropped = 0;
  /** ack 超时兜底的次数（诊断用；正常应为 0，非 0 说明某个承载页没回 ack）。 */
  let ackFallbacks = 0;
  /** 等承载页 ack 的上限。取 3s：足够慢机器完成一次换图，又不会让同步停太久。 */
  const EPOCH_ACK_TIMEOUT_MS = 3000;
  /** 这些是**生命周期/界面信号**，不是文档内容 —— 陈旧也不丢（否则换文档后就收不到确认了）。 */
  const LIFECYCLE_EVENTS = new Set(["init", "ready", "load", "loaded", "error"]);

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
      // 注意：**这里不改 `win.__hostEpoch`**（审计 2026-11-03 M-27）。
      // 代际只在承载页**确认换文档之后**才翻（见 confirmEpoch）——
      // 提前翻会把"换文档前产生、换文档后才入队"的旧内容标成新代际，
      // 那正是要堵的那个窗口。
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

  /** 承载页确认「这份文档已经载入」之后，才把代际交给它（见 send 处的说明）。 */
  function confirmEpoch(format) {
    const e = entry(format);
    if (e.ackTimer) {
      window.clearTimeout(e.ackTimer);
      e.ackTimer = 0;
    }
    const win = winFor(format);
    if (win) win.__hostEpoch = e.epoch;
  }

  /**
   * 等承载页的 ack；等不到就自己翻。
   *
   * 为什么要这条兜底：代际**只能**在确认后才翻，否则旧内容会被标成新代际。但如果某个
   * 承载页哪天不吭声（不改 `load`/`loaded` 事件名、或握手失败），代际就永远停在旧值，
   * 之后所有画布改动都会被当成"上一份文档的迟到事件"丢掉 —— 那是比污染更糟的失效
   * （画布永远存不进正文）。宁可偶尔漏一次防护，也不能把同步永久掐死。
   */
  function armEpochConfirm(format) {
    const e = entry(format);
    if (e.ackTimer) window.clearTimeout(e.ackTimer);
    e.ackTimer = window.setTimeout(() => {
      e.ackTimer = 0;
      confirmEpoch(format);
      ackFallbacks += 1;
    }, EPOCH_ACK_TIMEOUT_MS);
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

  // C5-①：画布大纲的极简请求/回调（不用 waiters 机制，单发单收）。
  // `getOutline(format)` 发 getOutline 前挂上这个回调，承载页回 report('outline') 时由
  // handleEvent 的 "outline" 分支取出并清空。
  let pendingOutline = null;

  function report(message, err) {
    const text = err && err.message ? `${message}：${err.message}` : message;
    state.pushOutput(text, "warn");    if (DGM.toast) DGM.toast({ icon: "alert", title: t("canvas.title"), sub: text, warn: true });
  }

  /* ------------------------------------------------------------------ 回收事件 */

  function handleEvent(format, msg) {
    const e = entry(format);
    switch (msg.event) {
      case "init":
      case "ready":
        e.ready = true;
        // 首次 init 也要把代际同步过去（此时 e.epoch 可能已经不是 0）
        confirmEpoch(format);
        flushPending(format);
        break;

      // 文档已载入：**不回写**，否则一打开就被标成「已修改」。
      // 同时这就是"换文档已完成"的**确认点**（审计 2026-11-03 M-27）：
      // 只有到这里才把代际交给承载页，之后它入队的事件才算新文档的。
      case "load":
      case "loaded":
        e.loading = false;
        for (const done of e.loadWaiters.splice(0)) done(true);
        confirmEpoch(format);
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

      // C5-①：承载页回的结构树（report('outline', {tree})），交给挂起的 getOutline 调用
      case "outline":
        if (pendingOutline) {
          const fn = pendingOutline;
          pendingOutline = null;
          fn(msg.tree || null);
        }
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
    let epochs;
    try {
      queue = win.__hostQueue;
      epochs = win.__hostEpochs;
    } catch (err) {
      return; // 未就绪
    }
    if (!queue || !queue.length) return;
    // 就地 splice（不要换数组引用：承载页持有同一个引用）
    const items = queue.splice(0, queue.length);
    // 代际令牌与队列**同下标并排**（审计 2026-11-03 M-27）。承载页把入队那一刻的
    // `__hostEpoch` 记在这里；旧承载页 / 探针桩没有这个数组时按 0 处理 = 不按代际过滤，
    // 行为与以前完全一致（前后兼容，不必同时升级两侧）。
    let tags = null;
    try {
      if (epochs && typeof epochs.splice === "function") {
        tags = epochs.splice(0, items.length);
      }
    } catch (err) {
      tags = null;
    }
    const e = entry(format);
    for (let i = 0; i < items.length; i++) {
      const raw = items[i];
      const tag = tags ? Number(tags[i]) || 0 : 0;
      let msg;
      try {
        msg = typeof raw === "string" ? JSON.parse(raw) : raw;
      } catch (err) {
        continue; // 非 JSON 载荷忽略
      }
      // 0 = 无版本信息（旧承载页 / 探针桩），照收；非 0 且 ≠ 当前代 = 上一份文档的迟到事件。
      // 例外是生命周期事件：它们不是文档内容，而且**换文档后的那条 ack 本身**就带着旧代际
      // —— 把 ack 也丢掉，代际就永远翻不过来（审计 2026-11-03 M-27）。
      const stale = tag !== 0 && tag !== e.epoch;
      if (stale && !(msg && LIFECYCLE_EVENTS.has(msg.event))) {
        staleDropped += 1;
        continue;
      }
      try {
        handleEvent(format, msg);
      } catch (err) {
        /* 单个事件处理失败不该拖垮整批 */
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

    // 换文档之前，先把**旧文档**已经躺在队列里的事件结清（审计 2026-11-03 M-27）。
    //
    // 为什么是"结清"而不是"丢掉"：那些事件是用户上一份文档最后 1.5s 的画布改动，
    // 丢掉就是丢用户的内容。此刻 `loadedDoc` 还是旧文档，drain 会把它们写回旧文档。
    // 之后（迟到的、跨过换文档那一刻的）事件由代际令牌丢弃 —— 那才是会污染新文档的。
    drain(format);

    // 代际 +1：这之后承载页入队的事件都带新代际。具体交付时机见 confirmEpoch ——
    // 不是现在，而是承载页回 `load`/`loaded` 的时候。
    e.epoch += 1;
    e.loadedDoc = doc.id;
    e.lastApplied = doc.body || "";
    // **不要把 `e.ready` 置回 false**：承载页的 `init`/`ready` 每个 iframe 只发一次
    // （drawio 是启动握手，Excalidraw 是 mount 完成），换文档**不会**重发。
    // 曾经的写法是"新文档要等新一轮 init"，结果第二次载入的指令全被塞进 `pending`
    // 再也没人 flush —— 表现就是「转第二个文件，画布还是第一个的图」。
    // 就绪状态只由 `init`/`ready` 事件置 true，`teardown` 删实例时随之丢失。
    e.pending.length = 0;
    // 开始等 ack（承载页确认换图后会回 load/loaded；等不到有兜底，见 armEpochConfirm）
    armEpochConfirm(format);

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
      e.loading = true;
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
    e.loading = false;
    for (const done of e.loadWaiters.splice(0)) done(false);
    delete hosts[format];
    if (activeFormat === format) activeFormat = null;
    // 待用的转换载荷是模块级单例、且按 format 匹配：实例都没了还留着它，
    // 下次新建的同格式文档会被当成"这次载入的是 Mermaid 源码"而误灌旧内容。
    if (pendingConversion && pendingConversion.format === format) pendingConversion = null;
  }

  /**
   * 等 drawio 的 load 确认（大图换文档时 load 是异步的，export 早取会拿到空图）。
   * 超时返回 false 并清掉 loading，让调用方按当前状态继续。
   */
  function whenLoaded(format, timeoutMs) {
    const e = hosts[format];
    if (!e || !e.frame) return Promise.resolve(false);
    if (!e.loading) return Promise.resolve(true);
    return new Promise((resolve) => {
      let done = false;
      const finish = (ok) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        const i = e.loadWaiters.indexOf(finish);
        if (i >= 0) e.loadWaiters.splice(i, 1);
        if (!ok) e.loading = false;
        resolve(ok);
      };
      e.loadWaiters.push(finish);
      const timer = setTimeout(() => finish(false), timeoutMs || 20000);
    });
  }

  /**
   * 落盘前取画布当前正文。
   *
   * * drawio：向画布要 XML（与 autosave 同源，只是不等 1.5s 去抖）
   * * Excalidraw：正文由 `scene` 事件持续回写，直接返回当前值（协议没有 XML 导出档）
   */
  function flush(format, force) {
    const e = hosts[format];
    if (!e || !e.frame || e.loadedDoc === null) return Promise.resolve(null);
    // 大 drawio 文件的 load 要几秒；load 还没确认时 export 会拿到残缺/空白图。
    // 等它加载完再取，超时则强制取一次（宁可拿当前状态，也不要把 flush 挂死）。
    if (format === "drawio" && !force && e.loading) {
      return whenLoaded(format, 20000).then(() => flush(format, true));
    }
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
   * 用文档里的新正文强制重载画布（配色等"改正文后要让承载页看到"的场景）。
   *
   * `show()` 对同一文档会刻意不重载（保护撤销历史）；这里必须绕过它。
   * 重载前先 `drain` 一次：flush 之后迟到的 autosave 仍应按旧文档结清，
   * 直接清 `loadedDoc` 会把这些事件当成无主内容丢掉。
   */
  function reload(doc) {
    if (!doc || !HOST_SRC[doc.format]) return false;
    const e = hosts[doc.format];
    if (!e || !e.frame) return false;
    drain(doc.format);
    e.loadedDoc = null;
    e.lastApplied = doc.body || "";
    return show(doc);
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
      // 与普通正文载入同一条等待链：descriptor 交给 drawio 后，`load`/`loaded`
      // 之前画布还是空图。这里不置 `loading` 的话，转换的 `flush()` 会立刻
      // export 出那张空图（host 属性与默认正文不同 ⇒ `waitForBody` 误判"已转换"），
      // 用户拿到的是一个没有节点的 drawio。
      e.loading = true;
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

  /**
   * C5-①：取画布结构树（供侧栏大纲渲染）。
   * 向承载页发 `{action:'getOutline'}`，等 `report('outline')` 回来解析成树。
   * 承载页未就绪时命令会被承载页入队、ready 后再重放；万一一直不 ready，
   * 由这里的超时兜底 resolve(null)（不让调用方的 Promise 永久挂起）。
   * @param {string} format
   * @param {number} [timeoutMs=5000]
   * @returns {Promise<object|null>} tree（{kind:'root', children:[...]}）或 null
   */
  function getOutline(format, timeoutMs) {
    const ms = typeof timeoutMs === "number" ? timeoutMs : 5000;
    return new Promise((resolve) => {
      let done = false;
      const finish = (tree) => {
        if (done) return;
        done = true;
        if (pendingOutline === finish) pendingOutline = null;
        resolve(tree);
      };
      // 并发重入：上一次还没回就再发，用新的回调覆盖旧的（画布大纲按需点开，几乎不会并发）
      pendingOutline = finish;
      try {
        send(format, { action: "getOutline" });
      } catch (err) {
        finish(null);
        return;
      }
      setTimeout(() => finish(null), ms);
    });
  }

  /**
   * C5-③：在画布上选中（并尽可能定位）指定元素。侧栏画布大纲点击叶子时调用。
   * 承载页未就绪时 send 会排队/丢弃，不抛错。
   * @param {string} format
   * @param {string[]} ids
   */
  function select(format, ids) {
    if (!Array.isArray(ids) || !ids.length) return;
    send(format, { action: "select", ids: ids });
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
    reload,
    whenLoaded,
    waitForBody,
    exportPng,
    loadMermaid,
    setPendingConversion,
    getOutline,
    select,
    syncThemeAll,
    hostZoom,
    hostFit,
    hostZoomBy,
    isReady: (format) => Boolean(hosts[format] && hosts[format].ready),
    loadedDoc: (format) => (hosts[format] ? hosts[format].loadedDoc : null),
    lastApplied: (format) => (hosts[format] ? hosts[format].lastApplied : ""),
    supports: (format) => Boolean(HOST_SRC[format]),
    /** 被代际过滤丢掉的事件数（探针断言「没丢正常事件」用；正常使用下应为 0）。 */
    staleDropped: () => staleDropped,
    /** ack 兜底次数（非 0 = 某个承载页没回 load/loaded，代际没能按时翻）。 */
    ackFallbacks: () => ackFallbacks,
    epoch: (format) => (hosts[format] ? hosts[format].epoch : 0),
    /**
     * 立刻处理一次承载页队列，**不等那 120ms 的轮询**。
     *
     * 给验收用（`tools/dev/ui_probe.py` 的 C-L4）：headless 的计时器会被节流到 ~1s/次，
     * 冷编译紧接其后时更糟 —— 断言"这条事件该不该落地"会变成"轮询有没有轮到"，
     * 于是同一份代码在单跑时全绿、在门禁里偶发红。排空是纯同步的，直接调它就没有这个歧义。
     * 也顺手是排障时的好用工具（"队列里现在到底堆着什么"）。
     */
    drainNow: (format) => drain(format),
  };

  DGM.bus.on("settings:changed", syncThemeAll);
})();

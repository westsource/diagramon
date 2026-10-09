// 内嵌画布承载（drawio / Excalidraw）。
//
// 与旧实现的关键差别：不再跨 WebView + 反射桥，而是**同源 iframe** —— 外壳页与承载页都在
// `dgm` 自定义协议 origin 下，因此可以直接读写承载页的 `window.__hostQueue` 与调用 `window.__apply`，
// 省掉整套脚本注入与就绪探测。
//
// 职责边界：本模块只负责「画布 ↔ 正文文本」的搬运与协议翻译；文件读写仍在 app.js。

(function () {
  const POLL_MS = 120;

  const state = {
    container: null,
    /** @type {Record<string, {frame: HTMLIFrameElement, ready: boolean, loadedTab: string|null, lastApplied: string, pending: string[], waiters: Array}>} */
    hosts: {},
    onContent: null,
    onError: null,
    onHotkey: null,
    onZoom: null,
    activeFormat: null,
  };

  function host(format) {
    if (state.hosts[format]) return state.hosts[format];
    const entry = { frame: null, ready: false, loadedTab: null, lastApplied: "", pending: [], waiters: [], files: {} };
    state.hosts[format] = entry;
    return entry;
  }

  function ensureFrame(format) {
    const entry = host(format);
    if (entry.frame) return entry;

    const frame = document.createElement("iframe");
    frame.className = `canvas-frame canvas-${format}`;
    frame.setAttribute("title", `${format} 画布`);
    frame.src = format === "drawio" ? "/drawio/host.html" : "/excalidraw/index.html";
    state.container.appendChild(frame);
    entry.frame = frame;
    return entry;
  }

  function winFor(format) {
    const entry = host(format);
    return entry.frame ? entry.frame.contentWindow : null;
  }

  /** 向承载页投递一个动作（未就绪先排队，drawio 的 init 是唯一同步点）。 */
  function send(format, action) {
    const entry = host(format);
    const payload = JSON.stringify(action);
    const win = winFor(format);
    if (!entry.ready || !win || typeof win.__apply !== "function") {
      entry.pending.push(payload);
      return;
    }
    win.__apply(payload);
  }

  function flushPending(format) {
    const entry = host(format);
    const win = winFor(format);
    if (!entry.ready || !win || typeof win.__apply !== "function") return;
    const queued = entry.pending.splice(0, entry.pending.length);
    for (const payload of queued) win.__apply(payload);
  }

  /** 取一个等待者（同一时刻只允许一个同类请求在飞）。 */
  function takeWaiter(format, kind) {
    const entry = host(format);
    const idx = entry.waiters.findIndex((w) => w.kind === kind);
    if (idx < 0) return null;
    return entry.waiters.splice(idx, 1)[0];
  }

  function settle(format, kind, payload) {
    const waiter = takeWaiter(format, kind);
    if (waiter) waiter.resolve(payload);
  }

  function handleEvent(format, msg) {
    const entry = host(format);
    switch (msg.event) {
      case "init":
      case "ready":
        entry.ready = true;
        flushPending(format);
        break;
      case "load":
        // 文档已载入：不写回，否则一打开就被标成"已修改"
        break;
      case "autosave":
      case "save":
        if (typeof msg.xml === "string" && msg.xml && msg.xml !== entry.lastApplied) {
          entry.lastApplied = msg.xml;
          if (state.onContent && entry.loadedTab) state.onContent(entry.loadedTab, msg.xml);
        }
        break;
      case "scene": {
        // Excalidraw：画布变更以 elements/appState 回传，这里还原成文件 JSON
        const json = sceneToJson(msg, entry);
        if (json && json !== entry.lastApplied) {
          entry.lastApplied = json;
          if (state.onContent && entry.loadedTab) state.onContent(entry.loadedTab, json);
        }
        break;
      }
      case "loaded":
        break;
      case "export":
        if (String(msg.format).toLowerCase() === "xml") {
          entry.lastApplied = msg.xml || "";
          settle(format, "xml", msg.xml || "");
        } else {
          settle(format, "png", msg.data || "");
        }
        break;
      case "error":
        if (state.onError) {
          const text = typeof msg.message === "string" ? msg.message : "画布报错";
          state.onError(text);
        }
        break;
      case "hotkey":
        if (state.onHotkey && msg.combo) state.onHotkey(msg.combo);
        break;
      default:
        break;
    }
  }

  /** 把 Excalidraw 的 scene 事件还原成 `.excalidraw` 文件正文（保留载入时的 files）。 */
  function sceneToJson(msg, entry) {
    try {
      return JSON.stringify({
        type: "excalidraw",
        version: 2,
        source: "Diagramon",
        elements: msg.elements || [],
        appState: msg.appState || {},
        files: entry.files || {},
      });
    } catch (e) {
      return null;
    }
  }

  function drain(format) {
    const win = winFor(format);
    if (!win) return;
    let queue;
    try {
      queue = win.__hostQueue;
    } catch (e) {
      return; // 跨源/未就绪
    }
    if (!queue || !queue.length) return;
    // 就地 splice（不要换数组引用：承载页持有同一个引用）
    const items = queue.splice(0, queue.length);
    for (const raw of items) {
      try {
        handleEvent(format, typeof raw === "string" ? JSON.parse(raw) : raw);
      } catch (e) {
        /* 非 JSON 载荷忽略 */
      }
    }
  }

  let pollTimer = 0;
  function startPolling() {
    if (pollTimer) return;
    pollTimer = window.setInterval(() => {
      for (const format of Object.keys(state.hosts)) {
        if (state.hosts[format].frame) drain(format);
      }
      if (state.activeFormat && state.onZoom) {
        const win = winFor(state.activeFormat);
        const z = win && typeof win.__hostZoom === "function" ? win.__hostZoom() : 0;
        if (z > 0) state.onZoom(z);
      }
    }, POLL_MS);
  }

  /** 让某个画布格式成为当前可见面，并把标签正文灌进画布。 */
  function show(tab, body) {
    const format = tab.format;
    state.activeFormat = format;
    ensureFrame(format);
    state.container.hidden = false;

    const entry = host(format);
    // 已载入同一标签页则不重载（保留画布内的撤销历史）
    if (entry.loadedTab === tab.id) return;
    entry.loadedTab = tab.id;
    entry.lastApplied = body;

    const conversion = state.pendingConversion;
    if (conversion && conversion.format === format) {
      state.pendingConversion = null;
      loadMermaid(format, conversion.source);
    } else if (format === "drawio") {
      send(format, { action: "load", xml: body, autosave: 1 });
    } else {
      // Excalidraw：正文就是场景 JSON，直接 setScene；顺带记住 files 段
      try {
        const scene = JSON.parse(body);
        entry.files = scene.files || {};
      } catch (e) {
        entry.files = {};
      }
      send(format, { action: "setScene", scene: body });
    }
    startPolling();
  }

  /** 登记一次"新建标签页并转换"：下一次 show() 改为载入 Mermaid 源码。 */
  function setPendingConversion(format, source) {
    state.pendingConversion = { format, source };
  }

  function hide() {
    state.activeFormat = null;
    if (state.container) state.container.hidden = true;
  }

  /** 落盘前取画布当前正文。
   *  drawio：向画布取 XML（与 autosave 同源，只是不等 1.5s 去抖）。
   *  Excalidraw：正文由 `scene` 事件持续回写，直接返回当前值（协议没有 XML 导出档）。 */
  function flush(format) {
    const entry = host(format);
    if (!entry.frame || entry.loadedTab === null) return Promise.resolve(null);
    if (format !== "drawio") return Promise.resolve(entry.lastApplied || null);
    return new Promise((resolve) => {
      entry.waiters.push({ kind: "xml", resolve });
      send(format, { action: "export", format: "xml" });
      setTimeout(() => {
        const w = takeWaiter(format, "xml");
        if (w) w.resolve(null);
      }, 4000);
    });
  }

  /** 页内导出位图（返回 data URI）。 */
  function exportPng(format, scale, transparent) {
    const entry = host(format);
    if (!entry.frame || entry.loadedTab === null) return Promise.resolve(null);
    return new Promise((resolve) => {
      entry.waiters.push({ kind: "png", resolve });
      send(format, { action: "export", format: "png", scale, transparent });
      setTimeout(() => {
        const w = takeWaiter(format, "png");
        if (w) w.resolve(null);
      }, 15000);
    });
  }

  /** 把 Mermaid 源码交给画布解析（单向转换，见方案 §3.2.2）。 */
  function loadMermaid(format, source) {
    const entry = host(format);
    entry.lastApplied = "";
    if (format === "drawio") {
      send(format, { action: "load", autosave: 1, descriptor: { format: "mermaid", data: source, wrap: true } });
    } else {
      send(format, { action: "loadMermaid", source });
    }
  }

  DGM.canvas = {
    init(opts) {
      state.container = opts.container;
      state.onContent = opts.onContent || null;
      state.onError = opts.onError || null;
      state.onHotkey = opts.onHotkey || null;
      state.onZoom = opts.onZoom || null;
    },
    show,
    hide,
    flush,
    exportPng,
    loadMermaid,
    setPendingConversion,
    isReady: (format) => Boolean(host(format).ready),
    /** 画布当前载入的标签页 id（未载入为 null）。 */
    loadedTab: (format) => host(format).loadedTab,
  };
})();

/* 应用状态：设置、会话（打开的文档）、派生数据（问题/大纲/作用域）、本地日志与用量。
 *
 * 设计取向：
 *   - 一份真源 + 一个事件总线（DGM.bus）。谁改了状态谁 emit，视图订阅后自渲染。
 *   - 与 Rust 的交互全部经 DGM.ipc；字段名以 app-ipc 契约为准。
 *   - 布局开关这类「界面偏好」存在 settings.panels 里（Rust 是唯一持久化方），
 *     瞬态状态（缩放、命令面板开合等）留在 ui.*。
 */
window.DGM = window.DGM || {};
(function () {
  "use strict";

  const ipc = DGM.ipc;
  const t = (k, v) => DGM.i18n.t(k, v);

  /* ------------------------------------------------------------------ 事件总线 */

  const handlers = new Map();
  function on(type, fn) {
    if (!handlers.has(type)) handlers.set(type, new Set());
    handlers.get(type).add(fn);
    return () => handlers.get(type).delete(fn);
  }
  function emit(type, data) {
    const set = handlers.get(type);
    if (!set) return;
    for (const fn of Array.from(set)) {
      try {
        fn(data);
      } catch (e) {
        console.error("[DGM] bus handler error (" + type + "):", e);
      }
    }
  }
  DGM.bus = { on, emit };

  /* ------------------------------------------------------------------ 状态 */

  const state = {
    appInfo: null,
    formats: {}, // id -> FormatInfo
    formatList: [],
    settings: null,
    docs: [],
    active: null,

    // 派生数据（按 docId 缓存）
    issuesByDoc: {},
    outlineByDoc: {},
    scopeByDoc: {},

    // 本地日志与用量（仅本机统计：调用次数与 tokens；信用点归云网关，未接入不伪造）
    logs: { output: [], convert: [] },
    usage: { calls: 0, prompt: 0, completion: 0, byModel: {} },

    // 瞬态界面状态
    ui: {
      zoom: 1,
      aiTab: "chat",
      aiAttachment: null,
      aiBusy: false,
      aiRequestId: null,
      zen: false,
      zenPrev: null,
      status: { text: "", kind: "" },
      dirtyPromptOpen: false,
    },

    /* ---------------- 查询helpers ---------------- */
    fmtById(id) {
      return state.formats[id] || state.formatList[0] || { id, name: id, exts: ["." + id], surface: "text", split_view: true, ai: true, convert_to: [], layouts: [], note: "", default_body: "" };
    },
    doc(id) {
      const want = id == null ? state.active : id;
      return state.docs.find((d) => d.id === want) || null;
    },
    activeDoc() {
      return state.doc(state.active);
    },
    docFmt(doc) {
      return state.fmtById(doc ? doc.format : (state.formatList[0] && state.formatList[0].id));
    },
    isTextDoc(doc) {
      return state.docFmt(doc).surface === "text";
    },
    isCanvasDoc(doc) {
      return state.docFmt(doc).surface === "canvas";
    },
    /** 当前视图模式（画布型恒为 preview）。 */
    mode(doc) {
      const d = doc || state.activeDoc();
      if (!d) return "split";
      if (state.isCanvasDoc(d)) return "preview";
      if (d.view_mode === "source" || d.view_mode === "preview" || d.view_mode === "split") return d.view_mode;
      return (state.settings && state.settings.editor.default_view) || "split";
    },
    panels() {
      return (state.settings && state.settings.panels) || {};
    },
    ai() {
      return (state.settings && state.settings.ai) || { models: [], default_model: "" };
    },
    hasModels() {
      const m = state.ai().models || [];
      return m.length > 0;
    },
    currentModel() {
      const ai = state.ai();
      const models = ai.models || [];
      if (!models.length) return null;
      return models.find((m) => m.id === ai.default_model) || models[0];
    },
  };
  DGM.state = state;

  /* ------------------------------------------------------------------ 启动加载 */

  async function load() {
    state.appInfo = await ipc.invoke("app_info");
    state.formatList = (state.appInfo && state.appInfo.formats) || [];
    state.formats = {};
    state.formatList.forEach((f) => (state.formats[f.id] = f));

    state.settings = await ipc.invoke("settings_get");
    const session = await ipc.invoke("session_get");
    state.docs = (session && session.docs) || [];
    state.active = session ? session.active : null;
    if (!state.active && state.docs.length) state.active = state.docs[0].id;

    applyThemeAttrs();
    emit("settings:changed");
    emit("session:changed");
  }

  /* ------------------------------------------------------------------ 设置 */

  function applyThemeAttrs() {
    const s = state.settings;
    if (!s) return;
    const html = document.documentElement;
    // 主题：auto 落到系统偏好（只在应用层解析，settings.theme 仍保存 auto）
    let theme = s.theme || "light";
    if (theme === "auto") {
      theme = window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
    }
    html.dataset.theme = theme === "dark" ? "dark" : "light";
    html.dataset.density = s.density || "normal";
    html.dataset.accent = s.accent || "pine";
  }

  async function patchSettings(patch) {
    // 本地先合并（让界面即时响应），再落盘并采用 Rust 返回的全量对象
    state.settings = await ipc.invoke("settings_patch", { patch });
    applyThemeAttrs();
    emit("settings:changed");
    return state.settings;
  }

  /* ------------------------------------------------------------------ 会话 / 文档 */

  function upsertDoc(doc) {
    if (!doc) return;
    const i = state.docs.findIndex((d) => d.id === doc.id);
    if (i >= 0) state.docs[i] = doc;
    else state.docs.push(doc);
  }

  /** 同时接受 Session 与 Doc（契约未固定返回值时的兜底）。 */
  function applyResult(res) {
    if (!res) return;
    if (res.docs) {
      state.docs = res.docs;
      state.active = res.active != null ? res.active : state.active;
      if (!state.active && state.docs.length) state.active = state.docs[0].id;
    } else if (res.id) {
      upsertDoc(res);
    }
  }

  function refreshRecent(doc) {
    if (!doc || !state.settings) return;
    const list = state.settings.recent || [];
    const i = list.findIndex((r) => r.path === doc.path);
    if (doc.path) {
      const entry = { path: doc.path, name: doc.name, format: doc.format, opened_at: Date.now() };
      if (i >= 0) list[i] = entry;
      else list.unshift(entry);
    }
  }

  async function newDoc(format) {
    const doc = await ipc.invoke("doc_new", { format });
    applyResult(doc);
    state.active = doc && doc.id ? doc.id : state.active;
    emit("session:changed");
    return doc;
  }

  async function openPaths(paths) {
    const res = await ipc.invoke("doc_open_paths", { paths });
    applyResult(res);
    emit("session:changed");
    return res;
  }

  async function saveDoc(id, as, path) {
    const payload = { id };
    if (as) payload.path = path || null;
    // mock / 未提供 path 时：让上层先弹保存对话框拿路径
    const doc = await ipc.invoke(as ? "doc_save_as" : "doc_save", payload);
    applyResult(doc);
    if (doc) refreshRecent(doc);
    emit("session:changed");
    return doc;
  }

  async function closeDoc(id) {
    const res = await ipc.invoke("doc_close", { id });
    applyResult(res);
    delete state.issuesByDoc[id];
    delete state.outlineByDoc[id];
    delete state.scopeByDoc[id];
    emit("session:changed");
    return res;
  }

  async function activateDoc(id) {
    if (state.active === id) return;
    const res = await ipc.invoke("doc_activate", { id });
    applyResult(res);
    state.active = id;
    emit("session:changed");
  }

  /** 编辑器改动：本地即时更新（脏标/预览/大纲立刻反映），落盘去抖。 */
  let bodyTimer = 0;
  const pendingBody = new Map();
  function setBody(id, body) {
    const d = state.doc(id);
    if (!d) return;
    if (d.body === body) return;
    d.body = body;
    d.dirty = true;
    emit("doc:changed");
    pendingBody.set(id, body);
    clearTimeout(bodyTimer);
    bodyTimer = setTimeout(flushBody, (state.settings && state.settings.editor.debounce_ms) || 350);
  }
  async function flushBody() {
    const entries = Array.from(pendingBody.entries());
    pendingBody.clear();
    for (const [id, body] of entries) {
      try {
        const doc = await ipc.invoke("doc_set_body", { id, body });
        if (doc) upsertDoc(doc);
      } catch (e) {
        console.warn("[DGM] doc_set_body 失败：", e && e.message);
      }
    }
    emit("session:changed");
    await refreshDerived(state.active);
  }

  /** AI 应用 / 回退等整块替换正文：立即落盘，不等去抖。 */
  async function setBodyNow(id, body) {
    const d = state.doc(id);
    if (!d) return;
    d.body = body;
    d.dirty = true;
    emit("doc:changed");
    const doc = await ipc.invoke("doc_set_body", { id, body });
    if (doc) upsertDoc(doc);
    emit("session:changed");
    await refreshDerived(id);
  }

  let caretTimer = 0;
  function setCaret(id, line, col) {
    const d = state.doc(id);
    if (!d) return;
    d.caret_line = line;
    d.caret_col = col;
    emit("doc:changed");
    clearTimeout(caretTimer);
    caretTimer = setTimeout(() => {
      ipc.invoke("doc_set_caret", { id, line, col }).catch(() => {});
      refreshScope(id);
    }, 160);
  }

  async function setViewMode(id, mode) {
    const d = state.doc(id);
    if (!d || state.isCanvasDoc(d)) return;
    d.view_mode = mode;
    emit("doc:changed");
    try {
      const doc = await ipc.invoke("doc_set_view_mode", { id, mode });
      if (doc) upsertDoc(doc);
    } catch (e) {
      /* 视图模式落盘失败不阻断交互 */
    }
    // 关闭「记住每个标签页视图模式」时，所有文本型标签页跟随
    if (state.settings && state.settings.editor && !state.settings.editor.per_doc_view) {
      for (const other of state.docs) {
        if (other.id !== id && state.isTextDoc(other)) other.view_mode = mode;
      }
    }
    emit("session:changed");
  }

  async function setLayout(id, layout) {
    const d = state.doc(id);
    if (!d) return;
    d.layout = layout;
    emit("doc:changed");
    try {
      const doc = await ipc.invoke("doc_set_layout", { id, layout });
      if (doc) upsertDoc(doc);
    } catch (e) {
      /* 布局落盘失败不阻断 */
    }
  }

  /* ------------------------------------------------------------------ 派生数据 */

  async function refreshDerived(id) {
    if (!id || !state.doc(id)) return;
    await Promise.all([refreshIssues(id), refreshOutline(id), refreshScope(id)]);
  }

  async function refreshIssues(id) {
    try {
      state.issuesByDoc[id] = (await ipc.invoke("doc_issues", { id })) || [];
    } catch (e) {
      state.issuesByDoc[id] = [];
    }
    emit("issues:changed");
  }

  async function refreshOutline(id) {
    try {
      state.outlineByDoc[id] = (await ipc.invoke("doc_outline", { id })) || [];
    } catch (e) {
      state.outlineByDoc[id] = [];
    }
    emit("outline:changed");
  }

  async function refreshScope(id) {
    try {
      state.scopeByDoc[id] = (await ipc.invoke("doc_scope", { id })) || "";
    } catch (e) {
      state.scopeByDoc[id] = "";
    }
    emit("scope:changed");
  }

  /** 打开的文档的问题总数（状态栏 / 面板 tab 角标用）。 */
  function issueTotals() {
    let err = 0;
    let warn = 0;
    for (const d of state.docs) {
      for (const i of state.issuesByDoc[d.id] || []) {
        if (i.severity === "error") err += 1;
        else warn += 1;
      }
    }
    return { err, warn, all: err + warn };
  }

  /* ------------------------------------------------------------------ 日志 / 用量 */

  function stamp() {
    const n = new Date();
    return [n.getHours(), n.getMinutes(), n.getSeconds()].map((x) => String(x).padStart(2, "0")).join(":");
  }

  function pushOutput(message, kind) {
    state.logs.output.push({ t: stamp(), message, kind: kind || "" });
    if (state.logs.output.length > 500) state.logs.output.shift();
    emit("logs:changed");
  }

  function pushConvert(entry) {
    state.logs.convert.unshift(
      Object.assign({ t: stamp(), ok: true }, entry),
    );
    if (state.logs.convert.length > 100) state.logs.convert.pop();
    emit("logs:changed");
  }

  function addUsage(done) {
    state.usage.calls += 1;
    state.usage.prompt += (done && done.prompt_tokens) || 0;
    state.usage.completion += (done && done.completion_tokens) || 0;
    const model = (done && done.model) || "—";
    const row = state.usage.byModel[model] || { calls: 0, prompt: 0, completion: 0 };
    row.calls += 1;
    row.prompt += (done && done.prompt_tokens) || 0;
    row.completion += (done && done.completion_tokens) || 0;
    state.usage.byModel[model] = row;
    emit("usage:changed");
  }

  function setStatus(text, kind) {
    state.ui.status = { text: text || "", kind: kind || "" };
    emit("status:changed");
  }

  /* ------------------------------------------------------------------ 导出 */

  async function exportWrite(path, base64) {
    return ipc.invoke("export_write", { path, base64 });
  }

  /* ------------------------------------------------------------------ 对外 */

  Object.assign(state, {
    on,
    emit,
    load,
    applyThemeAttrs,
    patchSettings,
    upsertDoc,
    applyResult,
    refreshRecent,
    newDoc,
    openPaths,
    saveDoc,
    closeDoc,
    activateDoc,
    setBody,
    setBodyNow,
    flushBody,
    setCaret,
    setViewMode,
    setLayout,
    refreshDerived,
    refreshIssues,
    refreshOutline,
    refreshScope,
    issueTotals,
    pushOutput,
    pushConvert,
    addUsage,
    setStatus,
    exportWrite,
  });

  // 系统主题变化时（未显式锁定）跟随
  if (window.matchMedia) {
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const handler = () => {
      if (state.settings && state.settings.theme === "auto") applyThemeAttrs();
    };
    if (mq.addEventListener) mq.addEventListener("change", handler);
    else if (mq.addListener) mq.addListener(handler);
  }
})();

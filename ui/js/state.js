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

    /* 工作区（真源在 Rust：结构对齐 app-ipc 的 WorkspaceInfo） */
    workspace: { root: null, name: "", tree: [], truncated: false, file_count: 0, dir_count: 0 },
    /** 外部改动与本地未保存撞上了，等着用户选 —— 每条 {path, docId, name} */
    conflicts: [],

    /* 全库搜索（结果由 Rust 经 search://hit 推进来） */
    search: {
      scope: "open", // workspace | open
      query: "",
      regex: false,
      caseSensitive: false,
      running: false,
      requestId: null,
      hits: [],
      done: null,
    },

    /* 云网关。账户与额度都是服务端给的；未登录就是未登录，不伪造（P6 原则） */
    cloud: {
      status: { signed_in: false, base_url: "", account: null },
      docs: null, // CloudDocList | null
      loading: false,
      lastError: "",
    },

    // 本地日志与用量。token 只累计**供应商实报**的（ai://done 的 usage_source），
    // 没回报的不估算 —— 本地估算和服务端实报混成一个数就没法对账了（P3 拍板）。
    logs: { output: [], convert: [] },
    usage: { calls: 0, reported: 0, prompt: 0, completion: 0, byModel: {} },

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

    await loadWorkspace();
    bindEvents();

    applyThemeAttrs();
    emit("settings:changed");
    emit("session:changed");
  }

  /* ------------------------------------------------------------------ 事件订阅 */

  let eventsBound = false;
  function bindEvents() {
    if (eventsBound) return;
    eventsBound = true;

    // 工作区文件被外部改动：干净的直接重载，脏的挂起来问用户
    ipc.on("fs://changed", (list) => handleFsChanges(list));

    // 全库搜索（Rust 流式）
    ipc.on("search://hit", (hit) => {
      if (!hit) return;
      state.search.hits.push(hit);
      emit("search:changed");
    });
    ipc.on("search://done", (done) => {
      state.search.running = false;
      state.search.done = done || null;
      state.search.requestId = null;
      emit("search:changed");
    });

    // autosave 落了盘：把标签页的脏标清掉
    ipc.on("doc://autosaved", (doc) => {
      if (!doc) return;
      upsertDoc(doc);
      emit("session:changed");
      setStatus(t("status.autosaved", { name: doc.name }), "ok");
    });

    // 第二个实例转交进来的文件（单实例）
    ipc.on("open://paths", (ev) => {
      const paths = (ev && ev.paths) || [];
      if (!paths.length) return;
      openPaths(paths).then(() => {
        if (DGM.editor && DGM.editor.loadActive) DGM.editor.loadActive();
        if (DGM.preview && DGM.preview.schedule) DGM.preview.schedule();
        refreshDerived(state.active);
        emit("open:paths", paths);
      });
    });
  }

  /* ------------------------------------------------------------------ 工作区 */

  async function loadWorkspace() {
    try {
      const info = await ipc.invoke("workspace_get");
      applyWorkspace(info);
    } catch (e) {
      applyWorkspace(null);
    }
  }

  function applyWorkspace(info) {
    state.workspace = info && info.root
      ? info
      : { root: null, name: "", tree: [], truncated: false, file_count: 0, dir_count: 0 };
    state.search.scope = state.workspace.root ? "workspace" : "open";
    emit("workspace:changed");
  }

  /** 打开一个目录（不传就弹系统目录选择框）。 */
  async function openFolder(path) {
    let dir = path || "";
    if (!dir) {
      const picked = await ipc.dialog.pickPaths({ directory: true, multiple: false });
      dir = (picked && picked[0]) || "";
    }
    if (!dir && ipc.isMock) dir = "E:/OpenCode/diagramon/docs"; // mock 没有目录对话框
    if (!dir) return null;
    const info = await ipc.invoke("workspace_open", { path: dir });
    applyWorkspace(info);
    setStatus(t("status.wsOpened", { name: info.name }), "ok");
    return info;
  }

  async function refreshWorkspace() {
    if (!state.workspace.root) return null;
    const info = await ipc.invoke("workspace_get");
    applyWorkspace(info);
    return info;
  }

  async function closeWorkspace() {
    const info = await ipc.invoke("workspace_close");
    applyWorkspace(info);
    state.search.hits = [];
    state.search.done = null;
    setStatus(t("status.wsClosed"), "");
  }

  /** 在文件管理器里显示（真机上由 opener 插件完成）。 */
  async function revealPath(path) {
    const T = window.__TAURI__;
    if (T && T.opener && typeof T.opener.open === "function") {
      // 打开所在目录（opener 没有 reveal 语义，退而求其次：打开父目录）
      const dir = String(path).replace(/\\/g, "/").replace(/\/[^/]*$/, "");
      try {
        await T.opener.open(dir || path);
        return true;
      } catch (e) {
        return false;
      }
    }
    return false;
  }

  /* ------------------------------------------------------------------ 外部改动 */

  function handleFsChanges(list) {
    if (!Array.isArray(list) || !list.length) return;
    let treeDirty = false;
    let touched = false;

    for (const c of list) {
      if (c.kind === "dir" || !c.doc_id) {
        treeDirty = true;
        continue;
      }
      const d = state.doc(c.doc_id);
      if (!d) {
        treeDirty = true;
        continue;
      }
      if (c.conflicts) {
        if (!state.conflicts.some((x) => x.docId === c.doc_id)) {
          state.conflicts.push({ path: c.path, docId: c.doc_id, name: d.name });
        }
        touched = true;
        continue;
      }
      if (c.kind === "removed") {
        setStatus(t("fs.removed", { name: d.name }), "warn");
        treeDirty = true;
        touched = true;
        continue;
      }
      // 干净 → 直接采用磁盘版本（不必打扰用户）
      reloadDoc(c.doc_id);
      touched = true;
    }

    if (treeDirty) refreshWorkspace();
    if (touched) emit("fs:changed");
  }

  /** 外部改动后"用磁盘版本"。 */
  async function reloadDoc(id) {
    try {
      const doc = await ipc.invoke("doc_reload", { id });
      applyResult(doc);
      if (state.active === id) {
        if (DGM.editor && DGM.editor.loadActive) DGM.editor.loadActive();
        if (DGM.preview && DGM.preview.schedule) DGM.preview.schedule();
        refreshDerived(id);
      }
      setStatus(t("fs.reloaded", { name: doc.name }), "ok");
      emit("session:changed");
    } catch (e) {
      setStatus(String((e && e.message) || e), "err");
    }
  }

  /** 冲突处理后收口（两种选择都从列表里摘掉）。 */
  function resolveConflict(docId) {
    state.conflicts = state.conflicts.filter((c) => c.docId !== docId);
    emit("fs:changed");
  }

  /* ------------------------------------------------------------------ 搜索 */

  /** 跑一次搜索：有工作区走 Rust 全库，没有就只搜已打开的文档。 */
  async function runSearch(query, opts) {
    const o = opts || {};
    state.search.query = query;
    if (o.regex != null) state.search.regex = !!o.regex;
    if (o.caseSensitive != null) state.search.caseSensitive = !!o.caseSensitive;
    state.search.hits = [];
    state.search.done = null;

    // 上一次还没跑完的先叫停
    if (state.search.requestId) {
      ipc.invoke("search_cancel", { id: state.search.requestId }).catch(() => {});
      state.search.requestId = null;
    }

    if (!query.trim()) {
      state.search.running = false;
      emit("search:changed");
      return;
    }
    if (!state.workspace.root) {
      searchOpenDocs(query);
      emit("search:changed");
      return;
    }

    const requestId = "s-" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    state.search.requestId = requestId;
    state.search.running = true;
    state.search.scope = "workspace";
    emit("search:changed");
    try {
      await ipc.invoke("search_run", {
        req: {
          request_id: requestId,
          query,
          regex: state.search.regex,
          case_sensitive: state.search.caseSensitive,
          max_results: 500,
        },
      });
    } catch (e) {
      state.search.running = false;
      state.search.done = { request_id: requestId, total: 0, files: 0, truncated: false, error: String((e && e.message) || e) };
      emit("search:changed");
    }
  }

  /** 没有工作区时的退路：只在已打开文档里找（老行为，保留）。 */
  function searchOpenDocs(query) {
    state.search.scope = "open";
    state.search.running = false;
    const hits = [];
    let re = null;
    if (state.search.regex) {
      try {
        re = new RegExp(query, state.search.caseSensitive ? "g" : "gi");
      } catch (e) {
        state.search.done = { total: 0, files: 0, truncated: false, error: String((e && e.message) || e) };
        state.search.hits = [];
        return;
      }
    }
    const needle = state.search.caseSensitive ? query : query.toLowerCase();
    let files = 0;
    for (const d of state.docs) {
      if (!state.isTextDoc(d) && !d.body) continue;
      let n = 0;
      const lines = String(d.body || "").split("\n");
      for (let i = 0; i < lines.length; i += 1) {
        const line = lines[i];
        let col = -1;
        if (re) {
          re.lastIndex = 0;
          const m = re.exec(line);
          if (m) col = m.index;
        } else {
          const idx = (state.search.caseSensitive ? line : line.toLowerCase()).indexOf(needle);
          if (idx >= 0) col = idx;
        }
        if (col < 0) continue;
        n += 1;
        hits.push({
          path: d.path || "",
          name: d.name,
          format: d.format,
          line: i + 1,
          column: col + 1,
          text: line.length > 240 ? line.slice(0, 240) + "…" : line,
          docId: d.id,
        });
        if (hits.length >= 500) break;
      }
      if (n) files += 1;
      if (hits.length >= 500) break;
    }
    state.search.hits = hits;
    state.search.done = { total: hits.length, files, truncated: hits.length >= 500, error: null };
  }

  async function cancelSearch() {
    if (!state.search.requestId) return;
    try {
      await ipc.invoke("search_cancel", { id: state.search.requestId });
    } catch (e) {
      /* 已经结束了 */
    }
    state.search.requestId = null;
    state.search.running = false;
    emit("search:changed");
  }

  /** 点一条搜索结果：已打开就激活并跳行，没打开就先打开。 */
  async function openSearchHit(hit) {
    let id = hit.docId || null;
    if (!id) {
      const found = state.docs.find((d) => hit.path && d.path === hit.path);
      if (found) id = found.id;
    }
    if (!id && hit.path) {
      await openPaths([hit.path]);
      const d = state.docs.find((x) => x.path === hit.path);
      id = d ? d.id : null;
    }
    if (!id) return null;
    await activateDoc(id);
    if (DGM.editor && DGM.editor.loadActive) DGM.editor.loadActive();
    if (DGM.editor && DGM.editor.gotoLine) DGM.editor.gotoLine(hit.line, hit.column);
    if (DGM.preview && DGM.preview.schedule) DGM.preview.schedule();
    refreshDerived(id);
    return id;
  }

  /** 单实例 / 文件关联转交后，把会话与界面重新对齐。 */
  async function syncSession() {
    const session = await ipc.invoke("session_get");
    applyResult(session);
    emit("session:changed");
  }

  /* ------------------------------------------------------------------ 工作区里的写操作 */
  //
  // 三条都**只**走 Rust 的 workspace_* 命令，路径在那边经 `resolve_in_root` 挡一次
  // （见 app-core::workspace）。前端不自己拼绝对路径，也就没有"绕过守卫"这条缝。

  async function newWorkspaceFile(dir, name, format) {
    const path = await ipc.invoke("workspace_new_file", { dir, name, format });
    await refreshWorkspace();
    await openPaths([path]);
    if (DGM.editor && DGM.editor.loadActive) DGM.editor.loadActive();
    if (DGM.preview && DGM.preview.schedule) DGM.preview.schedule();
    refreshDerived(state.active);
    return path;
  }

  async function renameWorkspaceEntry(path, name) {
    const next = await ipc.invoke("workspace_rename", { path, name });
    await refreshWorkspace();
    // 会话里开着的那个文档要跟着改路径，否则它下次保存会写回旧名字
    const open = state.docs.find((d) => d.path === path);
    if (open) {
      open.path = next;
      open.name = String(next).split("/").pop();
      emit("session:changed");
    }
    return next;
  }

  async function deleteWorkspaceEntry(path) {
    await ipc.invoke("workspace_delete", { path });
    await refreshWorkspace();
    emit("fs:changed");
  }

  /* ------------------------------------------------------------------ 云网关 */

  /** 拉云端状态（登录与否 + 账户快照）。掉线/未配置都如实落地，不伪造。 */
  async function cloudRefresh() {
    state.cloud.loading = true;
    emit("cloud:changed");
    try {
      state.cloud.status = (await ipc.invoke("cloud_status")) || { signed_in: false, base_url: "", account: null };
      state.cloud.lastError = "";
    } catch (e) {
      state.cloud.lastError = String((e && e.message) || e);
      state.cloud.status = { signed_in: false, base_url: "", account: null };
    }
    state.cloud.loading = false;
    emit("cloud:changed");
    if (state.cloud.status.signed_in) await cloudDocs();
    return state.cloud.status;
  }

  async function cloudLogin(email, password) {
    const account = await ipc.invoke("cloud_login", { email, password });
    state.cloud.status = { signed_in: true, base_url: (state.settings.cloud || {}).base_url || "", account };
    emit("cloud:changed");
    await cloudDocs();
    return account;
  }

  async function cloudLogout() {
    await ipc.invoke("cloud_logout");
    state.cloud.status = { signed_in: false, base_url: (state.settings.cloud || {}).base_url || "", account: null };
    state.cloud.docs = null;
    emit("cloud:changed");
  }

  async function cloudDocs() {
    if (!state.cloud.status.signed_in) return null;
    state.cloud.loading = true;
    emit("cloud:changed");
    try {
      state.cloud.docs = await ipc.invoke("cloud_docs_list");
      state.cloud.lastError = "";
    } catch (e) {
      state.cloud.lastError = String((e && e.message) || e);
    }
    state.cloud.loading = false;
    emit("cloud:changed");
    return state.cloud.docs;
  }

  /** 把当前文档存到云端。已在云端（记着 cloudId）就更新，否则新建并记下 id。 */
  async function cloudSaveActive() {
    const d = state.activeDoc();
    if (!d) return null;
    const saved = await ipc.invoke("cloud_doc_save", {
      id: d.cloudId || "",
      name: d.name,
      format: d.format,
      body: d.body,
    });
    // 服务端认下的 id 要记在会话里，下次保存才是"更新"而不是再建一份
    d.cloudId = saved.id;
    emit("session:changed");
    await cloudDocs();
    return saved;
  }

  async function cloudOpenDoc(id) {
    const body = await ipc.invoke("cloud_doc_open", { id });
    // 云文档没有磁盘路径：开成一个"无路径"的文档，cloudId 记着，保存时回写云端
    const doc = await ipc.invoke("doc_new", { format: body.format });
    if (doc) {
      doc.cloudId = body.id;
      doc.name = body.name || doc.name;
      doc.body = body.body;
      await ipc.invoke("doc_set_body", { id: doc.id, body: body.body });
      upsertDoc(doc);
      state.active = doc.id;
      emit("session:changed");
      if (DGM.editor && DGM.editor.loadActive) DGM.editor.loadActive();
      if (DGM.preview && DGM.preview.schedule) DGM.preview.schedule();
      await refreshDerived(doc.id);
      doc.cloudId = body.id;
    }
    return doc;
  }

  async function cloudDeleteDoc(id) {
    await ipc.invoke("cloud_doc_delete", { id });
    await cloudDocs();
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
    // 画布型：连同它的承载实例一起销毁，否则常驻 iframe 会一直留着已关文档的内容
    const closing = state.doc(id);
    const res = await ipc.invoke("doc_close", { id });
    if (closing && state.isCanvasDoc(closing) && DGM.canvas && DGM.canvas.supports(closing.format)) {
      const stillOpen = ((res && res.docs) || state.docs).some((d) => d.format === closing.format);
      if (!stillOpen) DGM.canvas.teardown(closing.format);
    }
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
    // usage_source === "server" 才算数；"none" 只记调用次数，token 不掺估算值
    const reported = !!done && done.usage_source === "server";
    const p = reported ? done.prompt_tokens || 0 : 0;
    const c = reported ? done.completion_tokens || 0 : 0;
    state.usage.calls += 1;
    state.usage.reported += reported ? 1 : 0;
    state.usage.prompt += p;
    state.usage.completion += c;
    const model = (done && done.model) || "—";
    const row = state.usage.byModel[model] || { calls: 0, reported: 0, prompt: 0, completion: 0 };
    row.calls += 1;
    row.reported += reported ? 1 : 0;
    row.prompt += p;
    row.completion += c;
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
    // 工作区 / 文件系统 / 搜索（第 4 步）
    bindEvents,
    loadWorkspace,
    applyWorkspace,
    openFolder,
    refreshWorkspace,
    closeWorkspace,
    revealPath,
    reloadDoc,
    resolveConflict,
    runSearch,
    cancelSearch,
    openSearchHit,
    syncSession,
    newWorkspaceFile,
    renameWorkspaceEntry,
    deleteWorkspaceEntry,
    cloudRefresh,
    cloudLogin,
    cloudLogout,
    cloudDocs,
    cloudSaveActive,
    cloudOpenDoc,
    cloudDeleteDoc,
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

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

  /** 云网关模型在 `ai.default_model` 里的 id 前缀，与 Rust 的 `GATEWAY_MODEL_PREFIX` 同值。
   *  两边靠它把"这次对话走网关还是走本地 BYOK"分流（见 `commands.rs::resolve_target`）。 */
  const GW_PREFIX = "gw:";

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

    /* 长期记忆（真源在 Rust：结构对齐 app-ipc 的 MemoryList）。
       只有 `state: "confirmed"` 的条目会进 prompt；`pending` 是模型提取的候选，等用户确认。 */
    memory: { items: [], doc: "" },

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

    /* 云网关。账户与额度都是服务端给的；未登录就是未登录，不伪造（P6 原则）。
     *
     * **全客户端唯一的一份登录状态**：「账户」与「云端文档」只是它的两个视图，
     * 不各自另存副本 —— 否则"在两处登录、只有一处生效"这类 bug 会反复出现。
     * 令牌不在前端（在凭据库），所以"已登录"是事实陈述，不是页面能伪造的状态。 */
    cloud: {
      status: { signed_in: false, base_url: "", account: null },
      /* **"查过了吗"必须与"查完是未登录"分开**：`status.signed_in=false` 既可能是
       * 真未登录，也可能是"启动那一查还没回来"。界面拿它当未登录用，就会出现
       * "启动后得手点一下账户才变登录"（2026-10-15 用户报的）。 */
      checked: false,
      docs: null, // CloudDocList | null
      folders: null, // CloudFolderList | null
      loading: false,
      lastError: "",
    },

    /* 云网关的**可用模型别名**。这是**服务端事实**（按账号权益过滤后的结果），不是本地设置，
     * 所以登出必须整体清掉 —— 留着上一次账号的别名，用户点下去必然 401。
     * 与 `cloud` 分两块：云文档是"我的文件"，模型别名是"我能用哪些模型"，生命周期一样但用途无关。 */
    aiGateway: {
      models: [], // GatewayModel[]
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
      // 附加的外部文件（AI 上下文）：拖进来 / 手填路径 / 选择文件都进这里。
      // **瞬态**（不落盘）：路径与内容都跟这次会话强相关，重启后重新指定更诚实。
      aiContextFiles: [],
      // 原生拖放是否接上了（Tauri 的文件拖放事件）。自检钉它，防 API 漂了没人发现。
      aiDragDrop: false,
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
    /** 云网关可用模型别名（未登录时恒为空 —— 服务端不给匿名账号别名）。 */
    gatewayModels() {
      return state.cloud.status.signed_in ? state.aiGateway.models || [] : [];
    },
    /** `ai.default_model` 里的网关标记，与 Rust 的 `GATEWAY_MODEL_PREFIX` 同值。 */
    isGatewayModel(id) {
      return String(id || "").startsWith(GW_PREFIX);
    },
    /** **合并后**的可选模型：网关在前、本地 BYOK 在后，各自带 `group` 标记。
     *
     *  两组形状刻意保持一致（id/name/group/has_key），这样两个选择器只需一次 map ——
     *  分组只决定"要不要画那条小标题"，不该让两处的取数逻辑分叉。 */
    modelChoices() {
      const gw = state.gatewayModels().map((m) => ({
        id: GW_PREFIX + m.id,
        name: m.display_name || m.id,
        group: "gateway",
        has_key: true, // 凭据由客户端自己带（当前 access token），不存在"没填密钥"
        // 识图能力只有网关这一组能确知（服务端按别名给）；本地那组是 null = 不知道。
        // **null 与 false 必须分开**：本地模型画个"不支持识图"是我们在替用户下结论。
        vision: !!m.supports_vision,
      }));
      const providers = state.ai().providers || [];
      const byId = {};
      providers.forEach((p) => (byId[p.id] = p));
      const local = (state.ai().models || []).map((m) => {
        const p = byId[m.provider_id];
        return {
          ...m,
          name: m.name || m.model,
          group: p ? "provider:" + p.id : "local",
          groupLabel: p ? p.name : t("ai.group.local"),
          has_key: p ? p.provider === "ollama" || p.has_key : !!m.has_key,
          vision: null,
        };
      });
      return gw.concat(local);
    },
    hasModels() {
      return state.modelChoices().length > 0;
    },
    currentModel() {
      const all = state.modelChoices();
      if (!all.length) return null;
      return all.find((m) => m.id === state.ai().default_model) || all[0];
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
    // 一次性迁移：旧默认 split_src=46 归一成新默认 33。**只能在载入时做** ——
    // 放进 applyLayoutVars 会把用户真拖到 46% 的值也抹掉（探针实测）。
    if (state.settings && state.settings.panels && state.settings.panels.split_src === 46) {
      state.settings.panels.split_src = 33;
      ipc.invoke("settings_patch", { patch: { panels: { split_src: 33 } } }).catch(() => {});
    }
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

  /** 进行中的那一次云状态检查。并发调用**共用同一个 promise** ——
   *  启动时那一查还没回来之前用户完全可能已经点了「账户」，再发一次不只是浪费：
   *  401 时还会多一次令牌轮换，而轮换是**轮换+家族吊销**制的（并发刷新有把用户
   *  所有设备踢下线的风险，见 src-tauri/src/cloud.rs::refresh_tokens）。 */
  let cloudCheck = null;

  /** 拉云端状态（登录与否 + 账户快照）。掉线/未配置都如实落地，不伪造。
   *
   *  结束时一定把 `cloud.checked` 置真（失败也算查过一轮，但留 `lastError`），
   *  这样界面能区分"还没查"与"查完是未登录"。 */
  async function cloudRefresh() {
    if (cloudCheck) return cloudCheck;
    cloudCheck = (async () => {
      state.cloud.loading = true;
      emit("cloud:changed");
      try {
        state.cloud.status = (await ipc.invoke("cloud_status")) || { signed_in: false, base_url: "", account: null };
        state.cloud.lastError = "";
      } catch (e) {
        state.cloud.lastError = String((e && e.message) || e);
        state.cloud.status = { signed_in: false, base_url: "", account: null };
      }
      state.cloud.checked = true;
      state.cloud.loading = false;
      emit("cloud:changed");
      if (state.cloud.status.signed_in) {
        await Promise.all([cloudDocs(), cloudFolders()]);
      }
      // 恢复已有会话时也把模型别名取回来 —— 否则重开应用后 AI 面板会说"没有模型"，
      // 直到用户重新登录一次（那正是这次要修的观感问题）。
      // 但这种场合**只补"空/悬空"的默认**，不覆盖用户上次挑的模型（见 autoPickGatewayModel）。
      await refreshGatewayModels("ifMissing");
      return state.cloud.status;
    })();
    try {
      return await cloudCheck;
    } finally {
      cloudCheck = null;
    }
  }

  async function cloudLogin(email, password) {
    const account = await ipc.invoke("cloud_login", { email, password });
    state.cloud.status = { signed_in: true, base_url: (state.settings.cloud || {}).base_url || "", account };
    state.cloud.checked = true; // 登录是"确知"的一条路，别再让界面停在"正在检查"
    emit("cloud:changed");
    await Promise.all([cloudDocs(), cloudFolders()]);
    // 登录这个动作明确要求：落到第一个网关模型为默认（用户拍板）。
    await refreshGatewayModels("always");
    return account;
  }

  async function cloudLogout() {
    await ipc.invoke("cloud_logout");
    state.cloud.status = { signed_in: false, base_url: (state.settings.cloud || {}).base_url || "", account: null };
    state.cloud.checked = true; // 登出是确定状态
    state.cloud.docs = null;
    state.cloud.folders = null;
    state.aiGateway.models = [];
    state.aiGateway.lastError = "";
    // 默认模型若指着网关别名，登出后它就不存在了：留着会让状态栏一直显示一个
    // 用户再也选不到的名字，所以清掉，交给 currentModel() 回落到可用的本地模型。
    if (state.isGatewayModel(state.ai().default_model)) {
      await patchSettings({ ai: { default_model: "" } });
    }
    emit("cloud:changed");
  }

  /** Rust 侧判定"会话死了"（令牌续期被服务端拒绝）时会广播 `cloud://changed`。
   *  这里立刻重查云状态，并做与登出一致的收尾（清掉指向网关的默认别名）——
   *  否则就是用户看到的怪象：侧栏还登录着，AI 一调就报 token 过期（2026-10-16）。 */
  ipc.on("cloud://changed", async () => {
    try {
      await cloudRefresh();
      if (!state.cloud.status.signed_in && state.isGatewayModel(state.ai().default_model)) {
        await patchSettings({ ai: { default_model: "" } });
      }
    } catch (e) {
      console.error("[DGM] cloud session refresh failed:", e);
    }
  });

  /** 拉云网关**可用模型别名**（`GET /v1/ai/models`）。
   *
   *  失败时**清空列表而不是留着旧的**：这份数据是"当前账号能用什么"，
   *  留旧的等于让用户对着一个已经被服务端拿掉的别名点半天。
   *  空列表是正常结果（无 AI 权益时服务端就是 `data: []` + 200），不是错误。
   *
   *  `autoPick` 见 `autoPickGatewayModel`：登录用 `"always"`，启动/回连用 `"ifMissing"`。
   */
  async function refreshGatewayModels(autoPick) {
    if (!state.cloud.status.signed_in) {
      state.aiGateway.models = [];
      state.aiGateway.lastError = "";
      emit("cloud:changed");
      return [];
    }
    state.aiGateway.loading = true;
    emit("cloud:changed");
    try {
      const res = await ipc.invoke("ai_gateway_models");
      state.aiGateway.models = (res && res.items) || [];
      state.aiGateway.lastError = "";
    } catch (e) {
      state.aiGateway.models = [];
      state.aiGateway.lastError = String((e && e.message) || e);
    }
    state.aiGateway.loading = false;
    emit("cloud:changed");
    await autoPickGatewayModel(autoPick);
    return state.aiGateway.models;
  }

  /** 把默认模型落到**第一个网关模型**上 —— 否则刚登录的用户打开 AI 面板仍然看到
   *  "还没有设置 AI 模型"，还得自己点一次才算能用。
   *
   *  `mode="always"`：登录这个动作要求如此（用户拍板）。
   *  `mode="ifMissing"`：只在默认**空或悬空**（指向已不存在的模型）时补一个。
   *    启动/回连属于这一类 —— 每次开应用都把用户上次挑的模型拽回第一个，是更烦人的 bug。
   *
   *  列表为空（没权益 / 拉取失败）就什么都不做，绝不硬塞一个不能用的 id。 */
  async function autoPickGatewayModel(mode) {
    const gw = state.gatewayModels();
    if (!gw.length) return;
    const first = GW_PREFIX + gw[0].id;
    const cur = state.ai().default_model || "";
    if (cur === first) return;
    if (mode !== "always") {
      const live = state.modelChoices().some((m) => m.id === cur);
      if (cur && live) return;
    }
    await patchSettings({ ai: { default_model: first } });
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

  /** 云目录全集（建树用）。与 cloudDocs 一起构成"云端文档"视图的两个数据面。 */
  async function cloudFolders() {
    if (!state.cloud.status.signed_in) return null;
    state.cloud.loading = true;
    emit("cloud:changed");
    try {
      state.cloud.folders = await ipc.invoke("cloud_folders");
      state.cloud.lastError = "";
    } catch (e) {
      state.cloud.lastError = String((e && e.message) || e);
    }
    state.cloud.loading = false;
    emit("cloud:changed");
    return state.cloud.folders;
  }

  /** 新建目录（可为空）。成功后重新拉目录全集与文档列表 —— 树要跟着长。 */
  async function cloudFolderCreate(path) {
    const created = await ipc.invoke("cloud_folder_create", { path });
    await Promise.all([cloudFolders(), cloudDocs()]);
    return created;
  }

  /** 把当前文档存到云端。
   *
   *  乐观锁三件套都在文档上记着：`cloudId`（服务端认的 id）、
   *  `cloudVersion`（上次存/取的版本号）。新建传 version=0（If-Match: 0 = 仅当不存在时创建）；
   *  更新必须带版本号 —— 服务端 If-Match 省略 = 仅当不存在时创建，会直接 409（联调实测）。
   *  存成功后把新版本号记回去，下次保存才是"更新"。
   *
   *  `path` / `name` 由「保存到云端」窗口给（不传 = 用文档自己的名字、落到根目录）——
   *  保存与改名一次请求搞定（服务端 PUT 的 name/path 就是入口），不必再多一次 PATCH。
   */
  async function cloudSaveActive(path, name) {
    const d = state.activeDoc();
    if (!d) return null;
    const saved = await ipc.invoke("cloud_doc_save", {
      id: d.cloudId || "",
      version: d.cloudVersion || 0,
      name: name || d.name,
      path: path == null ? "" : path,
      format: d.format,
      body: d.body,
    });
    d.cloudId = saved.id;
    d.cloudVersion = saved.version;
    if (name) d.name = name;
    emit("session:changed");
    await Promise.all([cloudDocs(), cloudFolders()]);
    return saved;
  }

  async function cloudOpenDoc(id) {
    const body = await ipc.invoke("cloud_doc_open", { id });
    // 云文档没有磁盘路径：开成一个"无路径"的文档，cloudId 记着，保存时回写云端
    const doc = await ipc.invoke("doc_new", { format: body.format });
    if (doc) {
      doc.cloudId = body.id;
      doc.cloudVersion = body.version; // 乐观锁起点：下次保存带这个版本号
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

  /** 把一份文档并进会话。
   *
   *  **要求 `id`，且**就地合并**（不换对象）：
   *   - 没有 `id` 的一律忽略 —— 真机上出过两类"塞垃圾进 state.docs"的事故：
   *     `doc_set_layout` 曾返回 `bool`，`upsertDoc(true)` 把 `true` 塞进去；
   *     `doc_set_view_mode` 返回的是 Session（`{docs, active}`）也照塞。两者现在都返回 Doc
   *     （见 Rust 侧注释），这道守卫是防止下一次再漂。
   *   - 就地合并是因为**别的模块抓着这些对象用**（渲染、对话框、自检的局部变量）：
   *     整对象替换会把它们的引用变成"过去的快照"，界面看着像没生效。
   */
  function upsertDoc(doc) {
    if (!doc || !doc.id) return;
    const i = state.docs.findIndex((d) => d.id === doc.id);
    if (i >= 0) Object.assign(state.docs[i], doc);
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

  /** 布局引擎（按文档）。合法值来自注册表（DOT 六种 / D2 三种 / Mermaid 两种）。
   *
   *  后端在 `render-opts.json` 里**按文件路径记住**这次选择，下次打开这个文件就恢复它；
   *  未保存的标签页没有路径，记不了（保存那一刻按新路径记上，见 `doc_save` 那条路）。
   *
   *  `doc_set_layout` 返回**文档**（契约：单文档变更 → Doc），所以 `upsertDoc` 收的是对象；
   *  早先它返回 bool，`if (doc) upsertDoc(doc)` 会把 `true` 当成文档塞进 `state.docs`
   *  （真机上多出一个空标签页；mock 后端返回的是 Doc，所以探针看不见这个 bug）。
   */
  async function setLayout(id, layout) {
    const d = state.doc(id);
    if (!d) return;
    const prev = d.layout;
    d.layout = layout;
    emit("doc:changed");
    try {
      const doc = await ipc.invoke("doc_set_layout", { id, layout });
      if (doc && doc.id) upsertDoc(doc);
    } catch (e) {
      // 后端不认这个值（注册表里没有 / 文档不在了）：把界面改回去 ——
      // 让控件显示一个没生效的选择，比看得见地回弹更糟。
      d.layout = prev;
      emit("doc:changed");
    }
  }

  /** Mermaid 外观模式（classic / neo / handDrawn / auto），按文档落盘且按文件记住 —— 与 setLayout 同一套约定。 */
  async function setLook(id, look) {
    const d = state.doc(id);
    if (!d) return;
    const prev = d.look;
    d.look = look;
    emit("doc:changed");
    try {
      const doc = await ipc.invoke("doc_set_look", { id, look });
      if (doc && doc.id) upsertDoc(doc);
    } catch (e) {
      d.look = prev;
      emit("doc:changed");
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

  function setMemory(list) {
    state.memory = { items: (list && list.items) || [], doc: (list && list.doc) || "" };
    emit("memory:changed");
    return state.memory;
  }

  /** 重新拉取长期记忆清单。
   *
   *  读失败时**如实呈现"空"**而不是保留上一次的缓存 —— 否则界面会显示一份
   *  已经不存在的记忆，用户点"删除"还会得到"条目不存在"这种莫名其妙的错。
   */
  async function memoryRefresh() {
    const d = state.activeDoc();
    try {
      setMemory(await ipc.invoke("ai_memory_list", { id: d ? d.id : "" }));
    } catch (e) {
      setMemory(null);
    }
    return state.memory;
  }

  /** 新增或更新一条（同 id 即更新）。失败会把错误抛给调用方 —— 上限/空内容要能说出来。 */
  async function memorySave(entry) {
    const d = state.activeDoc();
    return setMemory(await ipc.invoke("ai_memory_save", { id: d ? d.id : "", entry }));
  }

  async function memoryDelete(entry) {
    const d = state.activeDoc();
    return setMemory(await ipc.invoke("ai_memory_delete", { id: d ? d.id : "", entry }));
  }

  async function memoryClear(kind) {
    const d = state.activeDoc();
    return setMemory(await ipc.invoke("ai_memory_clear", { id: d ? d.id : "", kind: kind || "all" }));
  }

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
    setLook,
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
    memoryRefresh,
    memorySave,
    memoryDelete,
    memoryClear,
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
    cloudFolders,
    cloudFolderCreate,
    cloudSaveActive,
    cloudOpenDoc,
    cloudDeleteDoc,
    refreshGatewayModels,
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

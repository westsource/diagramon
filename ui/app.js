// Diagramon 前端外壳（阶段 1）：标签页 / 编辑器 / 预览 / 文件操作。
// 与 Rust 侧通过 Tauri `invoke` 通信；渲染资产走同源自定义协议 `/mermaid/`、`/graphviz/`。

const { invoke } = window.__TAURI__.core;

const RENDER_DEBOUNCE_MS = 350;

const state = {
  /** @type {Array<{id:string,path:(string|null),format:string,title:string,dirty:boolean}>} */
  tabs: [],
  activeId: null,
  formats: new Map(),
  /** @type {Map<string,string>} */ bodies: new Map(),
  renderToken: 0,
  renderTimer: 0,
};

const el = {
  tabs: document.getElementById("tabs"),
  editor: document.getElementById("editor"),
  previewContent: document.getElementById("preview-content"),
  previewScroll: document.getElementById("preview-scroll"),
  previewEmpty: document.getElementById("preview-empty"),
  statusMsg: document.getElementById("status-msg"),
  statusZoom: document.getElementById("status-zoom"),
  formatBadge: document.getElementById("format-badge"),
  newMenu: document.getElementById("new-menu"),
  btnNew: document.getElementById("btn-new"),
  btnOpen: document.getElementById("btn-open"),
  btnSave: document.getElementById("btn-save"),
  btnSaveAs: document.getElementById("btn-save-as"),
  splitter: document.getElementById("splitter"),
  workspace: document.getElementById("workspace"),
  paneEditor: document.getElementById("pane-editor"),
};

function status(msg, warn = false) {
  el.statusMsg.textContent = msg;
  el.statusMsg.classList.toggle("warn", warn);
}

function activeTab() {
  return state.tabs.find((t) => t.id === state.activeId) || null;
}

// ---------------------------------------------------------------- rendering

/** 预览视图的平移/缩放控制器（鼠标滚轮平移 / Ctrl+滚轮缩放 / 双击适配）。 */
const view = {
  scale: 1,
  x: 0,
  y: 0,
  apply() {
    el.previewContent.style.transform = `translate(${this.x}px, ${this.y}px) scale(${this.scale})`;
    el.statusZoom.textContent = `${Math.round(this.scale * 100)}%`;
  },
  reset() {
    this.scale = 1;
    this.x = 0;
    this.y = 0;
    this.apply();
  },
  /** 适配：让内容缩放到视口内并居中。 */
  fit() {
    const content = el.previewContent.firstElementChild;
    if (!content) return;
    const cw = content.scrollWidth || content.getBoundingClientRect().width;
    const ch = content.scrollHeight || content.getBoundingClientRect().height;
    if (!cw || !ch) return;
    const rect = el.previewScroll.getBoundingClientRect();
    const pad = 24;
    const s = Math.min((rect.width - pad) / cw, (rect.height - pad) / ch);
    this.scale = Math.max(0.05, Math.min(s, 8));
    this.x = (rect.width - cw * this.scale) / 2;
    this.y = (rect.height - ch * this.scale) / 2;
    this.apply();
  },
};

function setupPreviewGestures() {
  el.previewScroll.addEventListener(
    "wheel",
    (e) => {
      e.preventDefault();
      if (e.ctrlKey) {
        const rect = el.previewScroll.getBoundingClientRect();
        const cx = e.clientX - rect.left;
        const cy = e.clientY - rect.top;
        const factor = Math.exp(-e.deltaY * 0.0015);
        const next = Math.max(0.05, Math.min(view.scale * factor, 8));
        const k = next / view.scale;
        view.x = cx - (cx - view.x) * k;
        view.y = cy - (cy - view.y) * k;
        view.scale = next;
      } else if (e.shiftKey) {
        view.x -= e.deltaY;
      } else {
        view.x -= e.deltaX;
        view.y -= e.deltaY;
      }
      view.apply();
    },
    { passive: false },
  );

  let dragging = null;
  el.previewScroll.addEventListener("mousedown", (e) => {
    if (e.button !== 0) return;
    dragging = { x: e.clientX, y: e.clientY, ox: view.x, oy: view.y };
    el.previewScroll.classList.add("grabbing");
  });
  window.addEventListener("mousemove", (e) => {
    if (!dragging) return;
    view.x = dragging.ox + (e.clientX - dragging.x);
    view.y = dragging.oy + (e.clientY - dragging.y);
    view.apply();
  });
  window.addEventListener("mouseup", () => {
    dragging = null;
    el.previewScroll.classList.remove("grabbing");
  });

  el.previewScroll.addEventListener("dblclick", () => view.fit());
}

// ---------------------------------------------------------------- preview render

let mermaidReady = false;
function ensureMermaid() {
  if (mermaidReady) return true;
  if (typeof window.mermaid === "undefined") return false;
  window.mermaid.initialize({ startOnLoad: false, securityLevel: "strict" });
  mermaidReady = true;
  return true;
}

let graphvizInstance = null;
async function renderDot(src) {
  if (!graphvizInstance) {
    const mod = await import("/graphviz/graphviz.js");
    graphvizInstance = await mod.Graphviz.load();
  }
  return graphvizInstance.dot(src);
}

function showNote(text) {
  el.previewContent.innerHTML = "";
  const div = document.createElement("div");
  div.className = "preview-note";
  div.textContent = text;
  el.previewContent.appendChild(div);
  view.reset();
}

function showError(text) {
  el.previewContent.innerHTML = "";
  const pre = document.createElement("div");
  pre.className = "preview-error";
  pre.textContent = text;
  el.previewContent.appendChild(pre);
  view.reset();
}

async function renderPreview(tab, body) {
  const token = ++state.renderToken;
  if (!tab) {
    el.previewContent.innerHTML = "";
    el.previewEmpty.style.display = "grid";
    return;
  }
  el.previewEmpty.style.display = "none";

  if (tab.format === "drawio" || tab.format === "excalidraw") {
    showNote("图形画布（drawio / Excalidraw）在阶段 2 接入内嵌承载页；此处显示文件正文。");
    return;
  }

  const empty = body.trim().length === 0;
  if (empty) {
    showNote("（空文档）");
    return;
  }

  try {
    let svg;
    if (tab.format === "mermaid") {
      if (!ensureMermaid()) {
        showError("Mermaid 渲染器未加载：请确认资产目录包含 Assets/mermaid.min.js");
        return;
      }
      const res = await window.mermaid.render(`dgm-${token}`, body);
      svg = res.svg;
    } else {
      svg = await renderDot(body);
    }
    if (token !== state.renderToken) return; // 已有更新的渲染请求
    el.previewContent.innerHTML = svg;
    view.fit();
  } catch (err) {
    if (token !== state.renderToken) return;
    showError(String(err && err.message ? err.message : err));
  }
}

function scheduleRender() {
  window.clearTimeout(state.renderTimer);
  state.renderTimer = window.setTimeout(() => {
    const tab = activeTab();
    if (!tab) return;
    renderPreview(tab, el.editor.value);
  }, RENDER_DEBOUNCE_MS);
}

// ---------------------------------------------------------------- tabs UI

function formatOf(tab) {
  return state.formats.get(tab.format) || { id: tab.format, defaultExtension: tab.format };
}

function displayTitle(tab) {
  if (tab.title) return tab.title;
  return `未命名.${formatOf(tab).defaultExtension}`;
}

function renderTabs() {
  el.tabs.innerHTML = "";
  for (const tab of state.tabs) {
    const node = document.createElement("div");
    node.className = "tab" + (tab.id === state.activeId ? " active" : "");
    node.title = tab.path || displayTitle(tab);

    const title = document.createElement("span");
    title.className = "tab-title";
    title.textContent = displayTitle(tab);
    node.appendChild(title);

    if (tab.dirty) {
      const dot = document.createElement("span");
      dot.className = "tab-dirty";
      dot.textContent = "●";
      node.appendChild(dot);
    }

    const close = document.createElement("button");
    close.className = "tab-close";
    close.textContent = "×";
    close.title = "关闭 (Ctrl+W)";
    close.addEventListener("click", (e) => {
      e.stopPropagation();
      closeTab(tab.id);
    });
    node.appendChild(close);

    node.addEventListener("click", () => activateTab(tab.id));
    el.tabs.appendChild(node);
  }

  const tab = activeTab();
  el.formatBadge.innerHTML = "";
  if (tab) {
    const badge = document.createElement("span");
    badge.className = "format-badge";
    badge.textContent = tab.format;
    el.formatBadge.appendChild(badge);
  }
  const hasTab = Boolean(tab);
  for (const b of [el.btnSave, el.btnSaveAs]) b.disabled = !hasTab;
}

// ---------------------------------------------------------------- actions

async function refreshTabs() {
  state.tabs = await invoke("list_tabs");
  state.activeId = await invoke("active_tab");
  renderTabs();
}

async function activateTab(id) {
  state.activeId = id;
  await invoke("activate_tab", { id });
  const body = await invoke("read_document", { id });
  el.editor.value = body;
  state.bodies.set(id, body);
  renderTabs();
  const tab = activeTab();
  if (tab) renderPreview(tab, body);
}

async function newTab(format) {
  const opened = await invoke("new_tab", { format });
  upsertTab(opened.tab);
  state.activeId = opened.tab.id;
  state.bodies.set(opened.tab.id, opened.body);
  el.editor.value = opened.body;
  renderTabs();
  renderPreview(opened.tab, opened.body);
  el.editor.focus();
}

async function openFiles() {
  const opened = await invoke("open_dialog");
  if (!opened.length) return;
  for (const item of opened) {
    upsertTab(item.tab);
    state.bodies.set(item.tab.id, item.body);
  }
  const last = opened[opened.length - 1].tab;
  await refreshTabs();
  await activateTab(last.id);
  status(`已打开 ${opened.length} 个文件`);
}

function upsertTab(tab) {
  const i = state.tabs.findIndex((t) => t.id === tab.id);
  if (i >= 0) state.tabs[i] = tab;
  else state.tabs.push(tab);
}

async function save(as) {
  const tab = activeTab();
  if (!tab) return;
  const updated = await invoke(as ? "save_as" : "save", { id: tab.id });
  if (!updated) return; // 用户取消
  upsertTab(updated);
  renderTabs();
  status(`已保存 ${displayTitle(updated)}`);
}

async function closeTab(id) {
  const tab = state.tabs.find((t) => t.id === id);
  if (tab && tab.dirty && !window.confirm(`「${displayTitle(tab)}」有未保存的更改，仍要关闭吗？`)) {
    return;
  }
  const res = await invoke("close_tab", { id });
  state.tabs = res.tabs;
  state.activeId = res.active;
  state.bodies.delete(id);
  renderTabs();
  if (state.activeId) {
    await activateTab(state.activeId);
  } else {
    el.editor.value = "";
    renderPreview(null, "");
  }
}

// ---------------------------------------------------------------- editor events

let bodyTimer = 0;
el.editor.addEventListener("input", () => {
  const tab = activeTab();
  if (!tab) return;
  window.clearTimeout(bodyTimer);
  bodyTimer = window.setTimeout(async () => {
    const updated = await invoke("set_body", { id: tab.id, body: el.editor.value });
    upsertTab(updated);
    renderTabs();
  }, 200);
  scheduleRender();
});

// ---------------------------------------------------------------- shortcuts

window.addEventListener("keydown", (e) => {
  if (!e.ctrlKey) return;
  const k = e.key.toLowerCase();
  const map = {
    n: () => newTab("mermaid"),
    o: () => openFiles(),
    s: () => save(e.shiftKey),
    w: () => state.activeId && closeTab(state.activeId),
    q: () => invoke("quit"),
    0: () => view.fit(),
    "=": () => {
      view.scale = Math.min(view.scale * 1.2, 8);
      view.apply();
    },
    "-": () => {
      view.scale = Math.max(view.scale * 0.8, 0.05);
      view.apply();
    },
  };
  const fn = map[e.shiftKey && k === "s" ? "s" : k];
  if (fn) {
    e.preventDefault();
    fn();
  }
});

// ---------------------------------------------------------------- splitter drag

function setupSplitter() {
  let dragging = false;
  el.splitter.addEventListener("mousedown", () => {
    dragging = true;
    document.body.style.userSelect = "none";
  });
  window.addEventListener("mousemove", (e) => {
    if (!dragging) return;
    const rect = el.workspace.getBoundingClientRect();
    const ratio = ((e.clientX - rect.left) / rect.width) * 100;
    el.paneEditor.style.flexBasis = `${Math.max(15, Math.min(ratio, 85))}%`;
  });
  window.addEventListener("mouseup", () => {
    dragging = false;
    document.body.style.userSelect = "";
  });
}

// ---------------------------------------------------------------- new-file menu

function setupNewMenu() {
  const specs = [...state.formats.values()];
  for (const spec of specs) {
    const b = document.createElement("button");
    b.textContent = `新建 ${spec.id}`;
    b.addEventListener("click", () => {
      el.newMenu.classList.remove("open");
      newTab(spec.id);
    });
    el.newMenu.appendChild(b);
  }
  el.btnNew.addEventListener("click", (e) => {
    e.stopPropagation();
    el.newMenu.classList.toggle("open");
  });
  window.addEventListener("click", () => el.newMenu.classList.remove("open"));
}

// ---------------------------------------------------------------- boot

async function boot() {
  setupPreviewGestures();
  setupSplitter();

  const info = await invoke("app_info");
  const formats = await invoke("formats");
  for (const f of formats) state.formats.set(f.id, f);
  setupNewMenu();

  el.btnOpen.addEventListener("click", openFiles);
  el.btnSave.addEventListener("click", () => save(false));
  el.btnSaveAs.addEventListener("click", () => save(true));

  document.title = `${info.name} ${info.version}`;
  status(`${info.name} ${info.version} · ${info.platform}`);

  await refreshTabs();
  if (state.activeId) {
    await activateTab(state.activeId);
  } else {
    await newTab("mermaid");
  }
}

boot().catch((e) => status(`启动失败: ${e}`, true));

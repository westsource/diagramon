// 应用外壳：标签页、文件操作、菜单栏/工具栏/状态栏、快捷键，并把各模块接起来。

(function () {
  const RENDER_DEBOUNCE_MS = 350;
  const BODY_DEBOUNCE_MS = 200;

  const t = (key, vars) => DGM.i18n.t(key, vars);

  const state = {
    /** @type {Array<{id:string,path:(string|null),format:string,title:string,dirty:boolean}>} */
    tabs: [],
    activeId: null,
    /** @type {Map<string,{id:string,defaultExtension:string,layoutOptions:Array}>} */
    formats: new Map(),
    /** @type {Map<string,string>} */ bodies: new Map(),
    /** DOT 布局引擎（按标签页记忆）。 */
    engines: new Map(),
    renderTimer: 0,
    bodyTimer: 0,
    info: null,
    recent: [],
  };

  const el = {
    menubar: document.getElementById("menubar"),
    tabs: document.getElementById("tabs"),
    editorHost: document.getElementById("editor-host"),
    statusMsg: document.getElementById("status-msg"),
    statusZoom: document.getElementById("status-zoom"),
    formatBadge: document.getElementById("format-badge"),
    newMenu: document.getElementById("new-menu"),
    btnNew: document.getElementById("btn-new"),
    btnOpen: document.getElementById("btn-open"),
    btnSave: document.getElementById("btn-save"),
    btnSaveAs: document.getElementById("btn-save-as"),
    btnClose: document.getElementById("btn-close"),
    splitter: document.getElementById("splitter"),
    workspace: document.getElementById("workspace"),
    paneEditor: document.getElementById("pane-editor"),
    layoutWrap: document.getElementById("layout-wrap"),
    layoutSelect: document.getElementById("layout-select"),
    previewTools: document.getElementById("preview-tools"),
    previewCanvas: document.getElementById("preview-canvas"),
    previewEmpty: document.getElementById("preview-empty"),
  };

  function status(msg, warn = false) {
    el.statusMsg.textContent = msg;
    el.statusMsg.classList.toggle("warn", Boolean(warn));
  }

  const activeTab = () => state.tabs.find((t) => t.id === state.activeId) || null;
  const formatOf = (tab) =>
    state.formats.get(tab.format) || { id: tab.format, defaultExtension: tab.format, layoutOptions: [] };
  const isCanvasFormat = (format) => format === "drawio" || format === "excalidraw";

  function displayTitle(tab) {
    return tab.title || `${DGM.i18n.t("untitled")}.${formatOf(tab).defaultExtension}`;
  }

  function currentExportStem() {
    const tab = activeTab();
    if (!tab) return "diagram";
    const title = tab.title || `Untitled.${formatOf(tab).defaultExtension}`;
    return title.replace(/\.[^.]+$/, "") || "diagram";
  }

  function currentEngine(format) {
    const spec = state.formats.get(format);
    const options = (spec && spec.layoutOptions) || [];
    const saved = state.engines.get(format);
    if (saved && options.some((o) => o.id === saved)) return saved;
    const def = options.find((o) => o.isDefault) || options[0];
    return def ? def.id : "dot";
  }

  // ---------------------------------------------------------------- 渲染调度

  function scheduleRender() {
    window.clearTimeout(state.renderTimer);
    state.renderTimer = window.setTimeout(rerender, RENDER_DEBOUNCE_MS);
  }

  async function rerender() {
    const tab = activeTab();
    if (!tab) {
      await DGM.preview.render(null, "");
      el.layoutWrap.hidden = true;
      el.previewTools.hidden = true;
      el.previewCanvas.hidden = true;
      DGM.canvas.hide();
      return;
    }
    updateStatusBar();

    if (isCanvasFormat(tab.format)) {
      // 画布即编辑器：文本面与分割条让位（与既有客户端一致）
      el.paneEditor.hidden = true;
      el.splitter.hidden = true;
      await DGM.preview.render(null, "");
      DGM.preview.element.content.innerHTML = "";
      el.previewCanvas.hidden = false;
      DGM.canvas.show(tab, DGM.editor.getValue());
      el.previewTools.hidden = false;
      updateLayoutSelector();
      return;
    }

    el.paneEditor.hidden = false;
    el.splitter.hidden = false;
    DGM.canvas.hide();
    el.previewCanvas.hidden = true;
    updateLayoutSelector();
    await DGM.preview.render(tab, DGM.editor.getValue(), { engine: currentEngine(tab.format) });
    el.previewTools.hidden = !DGM.preview.hasContent();
  }

  function updateStatusBar() {
    const tab = activeTab();
    el.formatBadge.innerHTML = "";
    if (tab) {
      const badge = document.createElement("span");
      badge.className = "format-badge";
      badge.textContent = tab.format;
      el.formatBadge.appendChild(badge);
    }
    for (const b of [el.btnSave, el.btnSaveAs, el.btnClose]) b.disabled = !tab;
  }

  function updateLayoutSelector() {
    const tab = activeTab();
    const spec = tab ? state.formats.get(tab.format) : null;
    const options = (spec && spec.layoutOptions) || [];
    if (!tab || options.length === 0) {
      el.layoutWrap.hidden = true;
      el.layoutSelect.innerHTML = "";
      return;
    }
    el.layoutWrap.hidden = false;
    el.layoutSelect.innerHTML = "";
    for (const opt of options) {
      const node = document.createElement("option");
      node.value = opt.id;
      node.textContent = opt.label;
      el.layoutSelect.appendChild(node);
    }
    el.layoutSelect.value = currentEngine(tab.format);
  }

  // ---------------------------------------------------------------- 标签页 UI

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
      close.title = `${t("close")} (Ctrl+W)`;
      close.addEventListener("click", (e) => {
        e.stopPropagation();
        closeTab(tab.id);
      });
      node.appendChild(close);

      node.addEventListener("click", () => activateTab(tab.id));
      el.tabs.appendChild(node);
    }
    updateStatusBar();
    updateLayoutSelector();
  }

  // ---------------------------------------------------------------- 动作

  async function refreshTabs() {
    state.tabs = await DGM.invoke("list_tabs");
    state.activeId = await DGM.invoke("active_tab");
    renderTabs();
  }

  function upsertTab(tab) {
    const i = state.tabs.findIndex((x) => x.id === tab.id);
    if (i >= 0) state.tabs[i] = tab;
    else state.tabs.push(tab);
  }

  async function activateTab(id) {
    state.activeId = id;
    await DGM.invoke("activate_tab", { id });
    const body = await DGM.invoke("read_document", { id });
    state.bodies.set(id, body);
    const tab = activeTab();
    if (tab) DGM.editor.setLanguage(tab.format);
    DGM.editor.setValue(body);
    renderTabs();
    if (DGM.ai) await DGM.ai.onTabChanged(tab);
    await rerender();
  }

  async function newTab(format) {
    const opened = await DGM.invoke("new_tab", { format });
    upsertTab(opened.tab);
    state.activeId = opened.tab.id;
    state.bodies.set(opened.tab.id, opened.body);
    DGM.editor.setLanguage(opened.tab.format);
    DGM.editor.setValue(opened.body);
    renderTabs();
    await rerender();
    DGM.editor.focus();
  }

  async function openFiles() {
    try {
      const opened = await DGM.invoke("open_dialog");
      if (!opened.length) return;
      await adoptOpened(opened);
    } catch (e) {
      status(`${t("openFailed")}: ${e && e.message ? e.message : e}`, true);
    }
  }

  /** 载入一组已打开的文档（对话框、命令行、最近文件共用）。 */
  async function adoptOpened(opened) {
    for (const item of opened) {
      upsertTab(item.tab);
      state.bodies.set(item.tab.id, item.body);
    }
    const last = opened[opened.length - 1].tab;
    await refreshTabs();
    await activateTab(last.id);
    await refreshRecent();
    renderMenu();
    status(t("opened", { n: opened.length }));
  }

  async function openPath(path) {
    try {
      const opened = await DGM.invoke("open_paths_cmd", { paths: [path] });
      await adoptOpened(opened);
    } catch (e) {
      status(`${t("openFailed")}: ${e && e.message ? e.message : e}`, true);
    }
  }

  /** 画布格式落盘前先 flush：把画布当前内容取回正文。 */
  async function syncCanvasBody(tab) {
    if (!isCanvasFormat(tab.format)) return;
    const xml = await DGM.canvas.flush(tab.format);
    if (typeof xml === "string" && xml.length) {
      DGM.editor.setValue(xml);
      const updated = await DGM.invoke("set_body", { id: tab.id, body: xml });
      upsertTab(updated);
      renderTabs();
    }
  }

  async function save(as) {
    const tab = activeTab();
    if (!tab) return;
    try {
      await syncCanvasBody(tab);
      const updated = await DGM.invoke(as ? "save_as" : "save", { id: tab.id });
      if (!updated) return; // 用户取消
      upsertTab(updated);
      renderTabs();
      await refreshRecent();
      renderMenu();
      status(t("saved", { name: displayTitle(updated) }));
    } catch (e) {
      status(`${t("saveFailed")}: ${e && e.message ? e.message : e}`, true);
    }
  }

  async function closeTab(id) {
    const tab = state.tabs.find((x) => x.id === id);
    if (tab && tab.dirty) {
      const choice = await DGM.dialogs.saveChanges(displayTitle(tab));
      if (choice === "cancel") return;
      if (choice === "save") {
        state.activeId = id;
        const updated = await DGM.invoke("save", { id });
        if (!updated) return; // 另存为被取消
      }
    }
    const res = await DGM.invoke("close_tab", { id });
    state.tabs = res.tabs;
    state.activeId = res.active;
    state.bodies.delete(id);
    renderTabs();
    if (state.activeId) await activateTab(state.activeId);
    else {
      DGM.editor.setValue("");
      await rerender();
    }
  }

  // ---------------------------------------------------------------- 编辑器事件

  DGM.editor.mount(el.editorHost);
  DGM.editor.onChange((value) => {
    const tab = activeTab();
    if (!tab) return;
    window.clearTimeout(state.bodyTimer);
    state.bodyTimer = window.setTimeout(async () => {
      const updated = await DGM.invoke("set_body", { id: tab.id, body: value });
      upsertTab(updated);
      renderTabs();
    }, BODY_DEBOUNCE_MS);
    scheduleRender();
  });

  // ---------------------------------------------------------------- 快捷键

  function hotkeyAction(e) {
    const lower = e.key.toLowerCase();
    if (e.shiftKey && lower === "s") return "save-as";
    switch (lower) {
      case "n": return "new";
      case "o": return "open";
      case "s": return "save";
      case "w": return "close";
      case "q": return "quit";
      case "f": return "find";
      case "0": return "fit";
      case "=": case "+": return "zoom-in";
      case "-": case "_": return "zoom-out";
      default: break;
    }
    if (e.code === "Numpad0") return "fit";
    if (e.code === "NumpadAdd") return "zoom-in";
    if (e.code === "NumpadSubtract") return "zoom-out";
    return null;
  }

  function runAction(action) {
    switch (action) {
      case "new": newTab("mermaid"); break;
      case "open": openFiles(); break;
      case "save": save(false); break;
      case "save-as": save(true); break;
      case "close": if (state.activeId) closeTab(state.activeId); break;
      case "quit": quit(); break;
      case "find": if (DGM.editor.openSearch) DGM.editor.openSearch(); break;
      case "fit": DGM.preview.fit(); break;
      case "zoom-in": DGM.preview.zoomIn(); break;
      case "zoom-out": DGM.preview.zoomOut(); break;
      default: break;
    }
  }

  function setupShortcuts() {
    window.addEventListener("keydown", (e) => {
      if (!e.ctrlKey || e.altKey || e.metaKey) return;
      const action = hotkeyAction(e);
      if (!action) return;
      e.preventDefault();
      runAction(action);
    });
  }

  /** 画布内截下的应用级快捷键（画布持焦点时窗口快捷键收不到键）。 */
  function handleCanvasHotkey(combo) {
    const map = {
      "ctrl+s": "save",
      "ctrl+shift+s": "save-as",
      "ctrl+o": "open",
      "ctrl+n": "new",
      "ctrl+w": "close",
      "ctrl+q": "quit",
    };
    const action = map[combo];
    if (action) runAction(action);
  }

  async function quit() {
    const dirty = state.tabs.filter((x) => x.dirty);
    if (dirty.length) {
      const choice = await DGM.dialogs.confirmQuit(dirty.length);
      if (!choice) return;
    }
    if (DGM.settings) await DGM.settings.flush();
    await DGM.invoke("quit");
  }

  // ---------------------------------------------------------------- 布局 / 导出

  function setupLayoutSelector() {
    el.layoutSelect.addEventListener("change", () => {
      const tab = activeTab();
      if (!tab) return;
      state.engines.set(tab.format, el.layoutSelect.value);
      rerender();
    });
  }

  function setupExportButtons() {
    document.getElementById("btn-export-png").addEventListener("click", async () => {
      try {
        await exportCurrent(true);
      } catch (e) {
        status(`${t("exportFailed")}: ${e && e.message ? e.message : e}`, true);
      }
    });
    document.getElementById("btn-copy-png").addEventListener("click", async () => {
      try {
        await exportCurrent(false);
      } catch (e) {
        status(`${t("copyFailed")}: ${e && e.message ? e.message : e}`, true);
      }
    });
  }

  /** 导出当前标签页的位图；画布格式走画布内栅格化，文本格式走预览栅格化。 */
  async function exportCurrent(toFile) {
    const tab = activeTab();
    if (!tab) throw new Error(t("noDoc"));
    if (isCanvasFormat(tab.format)) {
      const dataUrl = await DGM.canvas.exportPng(tab.format, 3, true);
      if (!dataUrl) throw new Error(t("canvasNotReady"));
      const url = dataUrl.startsWith("data:") ? dataUrl : `data:image/png;base64,${dataUrl}`;
      if (toFile) {
        const path = await DGM.invoke("save_image", { dataUrl: url, fileName: `${currentExportStem()}.png` });
        if (path) status(t("savedImage", { path }));
      } else {
        await DGM.copyImageDataUrl(url);
        status(t("imageCopied"));
      }
      return;
    }
    if (toFile) await DGM.preview.saveImage();
    else await DGM.preview.copyImage();
  }

  // ---------------------------------------------------------------- 分隔条

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
      const clamped = Math.max(15, Math.min(ratio, 85));
      el.paneEditor.style.flexBasis = `${clamped}%`;
      if (DGM.settings) DGM.settings.setEditorRatio(clamped / 100);
    });
    window.addEventListener("mouseup", () => {
      dragging = false;
      document.body.style.userSelect = "";
    });
  }

  function applyEditorRatio() {
    const ratio = DGM.settings && DGM.settings.value.editorRatio;
    if (ratio) el.paneEditor.style.flexBasis = `${Math.round(ratio * 100)}%`;
  }

  // ---------------------------------------------------------------- 菜单

  async function refreshRecent() {
    if (!DGM.settings) return [];
    state.recent = await DGM.settings.recent();
    return state.recent;
  }

  function formatLabel(format) {
    return format;
  }

  function buildMenuModel() {
    const recentItems = state.recent.length
      ? state.recent.map((r) => ({
          label: r.title || r.path,
          onClick: () => openPath(r.path),
        }))
      : [{ label: t("recentEmpty"), disabled: true }];
    recentItems.push({ kind: "separator" });
    recentItems.push({ label: t("recentMore"), onClick: openHistory });
    recentItems.push({
      label: t("clearHistory"),
      onClick: async () => {
        await DGM.settings.recentClear();
        await refreshRecent();
        renderMenu();
      },
    });

    return [
      {
        label: t("file"),
        items: [
          {
            label: t("new"),
            kind: "submenu",
            items: [...state.formats.values()].map((f) => ({
              label: formatLabel(f.id),
              onClick: () => newTab(f.id),
            })),
          },
          { label: t("open"), accel: "Ctrl+O", onClick: openFiles },
          { label: t("save"), accel: "Ctrl+S", onClick: () => save(false) },
          { label: t("saveAs"), accel: "Ctrl+Shift+S", onClick: () => save(true) },
          { kind: "separator" },
          {
            label: t("convertTo"),
            kind: "submenu",
            items: [
              { label: "drawio", onClick: () => convertActiveTo("drawio").catch((e) => status(e.message, true)) },
              { label: "Excalidraw", onClick: () => convertActiveTo("excalidraw").catch((e) => status(e.message, true)) },
            ],
          },
          { kind: "separator" },
          { label: t("recentFiles"), kind: "submenu", items: recentItems },
          { kind: "separator" },
          { label: t("close"), accel: "Ctrl+W", onClick: () => state.activeId && closeTab(state.activeId) },
          { label: t("quit"), accel: "Ctrl+Q", onClick: quit },
        ],
      },
      {
        label: t("settings"),
        items: [
          {
            label: t("language"),
            kind: "submenu",
            items: DGM.i18n.languages.map((code) => ({
              label: code === "zh-CN" ? "中文" : "English",
              onClick: () => DGM.i18n.setLang(code),
            })),
          },
          { label: t("aiSettings"), onClick: () => DGM.ai.open() },
        ],
      },
      {
        label: t("help"),
        items: [
          { label: t("guide"), onClick: () => DGM.dialogs.guide() },
          { label: t("about"), onClick: () => DGM.dialogs.about(state.info || { name: "Diagramon", version: "?", platform: "?" }) },
        ],
      },
    ];
  }

  function renderMenu() {
    DGM.menu.setModel(buildMenuModel());
  }

  async function openHistory() {
    await refreshRecent();
    if (!state.recent.length) {
      status(t("recentEmpty"));
      return;
    }
    const path = await DGM.dialogs.history(state.recent);
    if (path) await openPath(path);
  }

  function setupNewMenu() {
    el.newMenu.innerHTML = "";
    for (const spec of state.formats.values()) {
      const b = document.createElement("button");
      b.textContent = `${t("new")} ${formatLabel(spec.id)}`;
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

  // ---------------------------------------------------------------- 转换

  /** Mermaid → 图形编辑器（单向：画布上的改动不回写 Mermaid 源码）。 */
  async function convertActiveTo(targetFormat) {
    const src = activeTab();
    if (!src) throw new Error(t("noDoc"));
    if (src.format !== "mermaid") throw new Error(t("onlyMermaidConvertible"));
    const source = DGM.editor.getValue();

    DGM.canvas.setPendingConversion(targetFormat, source);
    const opened = await DGM.invoke("new_tab", { format: targetFormat });
    upsertTab(opened.tab);
    state.activeId = opened.tab.id;
    DGM.editor.setLanguage(targetFormat);
    DGM.editor.setValue(opened.body);
    renderTabs();
    await rerender();
    status(t("converted", { format: targetFormat }));
    return opened.tab.id;
  }

  // ---------------------------------------------------------------- 启动

  async function boot() {
    DGM.preview.init({
      onZoom: (s) => (el.statusZoom.textContent = `${Math.round(s * 100)}%`),
      onStatus: status,
      onErrorLine: (line) => DGM.editor.revealLine(line),
      onRenderError: (text) => DGM.ai && DGM.ai.handleRenderError(text),
    });
    DGM.canvas.init({
      container: el.previewCanvas,
      onContent: async (tabId, body) => {
        if (tabId !== state.activeId) return;
        DGM.editor.setValue(body);
        const updated = await DGM.invoke("set_body", { id: tabId, body });
        upsertTab(updated);
        renderTabs();
      },
      onError: (msg) => status(msg, true),
      onHotkey: handleCanvasHotkey,
      onZoom: (z) => (el.statusZoom.textContent = `${Math.round(z * 100)}%`),
    });
    setupSplitter();
    setupShortcuts();
    setupLayoutSelector();
    setupExportButtons();
    DGM.dialogs.init();
    if (DGM.ai) DGM.ai.init();

    state.info = await DGM.invoke("app_info");
    const formats = await DGM.invoke("formats");
    for (const f of formats) state.formats.set(f.id, f);

    // 设置与语言：显式设置优先，否则按系统语言探测
    await DGM.settings.load();
    const lang = DGM.settings.value.language || DGM.i18n.detect();
    DGM.i18n.setLang(lang, { persist: false });
    DGM.i18n.apply();
    DGM.i18n.onChange(() => {
      renderMenu();
      setupNewMenu();
      renderTabs();
    });
    applyEditorRatio();

    await refreshRecent();
    DGM.menu.mount(el.menubar, buildMenuModel());
    setupNewMenu();

    el.btnOpen.addEventListener("click", openFiles);
    el.btnSave.addEventListener("click", () => save(false));
    el.btnSaveAs.addEventListener("click", () => save(true));
    el.btnClose.addEventListener("click", () => state.activeId && closeTab(state.activeId));

    document.title = `${state.info.name} ${state.info.version}`;
    status(`${state.info.name} ${state.info.version} · ${state.info.platform}`);

    // 命令行参数里的文件
    const cli = await DGM.invoke("cli_paths");
    if (cli.length) {
      await openPath(cli[cli.length - 1]);
    } else {
      await refreshTabs();
      if (state.activeId) await activateTab(state.activeId);
      else await newTab("mermaid");
    }
  }

  /** 由 AI 面板调用：整体替换当前标签正文（走与键入同一条落地链路）。 */
  function setActiveBody(body) {
    const tab = activeTab();
    if (!tab) return;
    DGM.editor.setValue(body);
    DGM.invoke("set_body", { id: tab.id, body }).then((updated) => {
      upsertTab(updated);
      renderTabs();
      rerender();
    });
  }

  DGM.app = {
    status,
    currentExportStem,
    rerender,
    activateTab,
    refreshTabs,
    upsertTab,
    newTab,
    openFiles,
    openPath,
    save,
    closeTab,
    convertActiveTo,
    exportCurrent,
    setActiveBody,
    isCanvasFormat,
    refreshRecent,
    renderMenu,
    state,
    el,
  };

  boot().catch((e) => status(t("startFailed") + `: ${e && e.message ? e.message : e}`, true));
})();

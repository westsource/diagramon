/* 应用外壳：标题栏 / 菜单栏 / 活动栏 / 侧栏容器 / 状态栏 / 主题 / 布局状态机 /
 * 命令注册表 / pop 菜单 / toast / 分隔条拖拽 / 全局快捷键。
 *
 * 这里不碰编辑器的内容渲染：源码归 editor.js，预览归 preview.js，AI 归 ai.js，
 * 侧栏五视图归 sidebar.js，底部面板归 panels.js，标签页归 tabs.js，对话框归 dialogs.js。
 */
window.DGM = window.DGM || {};
(function () {
  "use strict";

  const state = DGM.state;
  const ipc = DGM.ipc;
  const t = (k, v) => DGM.i18n.t(k, v);
  const icon = DGM.icon;

  /* ------------------------------------------------------------------ DOM helpers */

  const $ = (s, r) => (r || document).querySelector(s);
  const $$ = (s, r) => Array.from((r || document).querySelectorAll(s));
  const h = (tag, cls, html) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (html != null) n.innerHTML = html;
    return n;
  };
  // 审计 F-6：单引号也转义 —— 现有模板属性全是双引号包裹，这里补上是给未来代码上保险
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  DGM.dom = { $, $$, h, esc };

  /** 把纯文本写进系统剪贴板，返回**是否真的写成功**（调用方据此说真话）。
   *
   *  为什么不能只用 `navigator.clipboard.writeText`：WebView2 在窗口失焦、权限被拒、
   *  或页面不在前台时会直接 reject；旧调用是 `.then(done).catch(done)` ——
   *  失败也照弹"已复制"，用户粘出来是空的。次序：
   *  同步 `execCommand`（用户点击手势里最稳） → 异步 API → Tauri 剪贴板插件。
   */
  async function copyToClipboard(text) {
    const s = String(text == null ? "" : text);
    if (!s) return false;
    try {
      const prev = document.activeElement;
      const box = document.createElement("textarea");
      box.value = s;
      box.setAttribute("readonly", "");
      box.style.cssText = "position:fixed;left:-9999px;top:0;opacity:0";
      document.body.appendChild(box);
      box.select();
      const ok = document.execCommand("copy");
      box.remove();
      if (prev && prev.focus) prev.focus();
      if (ok) return true;
    } catch (e) {
      /* 落到下一级 */
    }
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(s);
        return true;
      }
    } catch (e) {
      /* 落到下一级 */
    }
    try {
      await ipc.invoke("plugin:clipboard-manager|write_text", { text: s, label: null });
      return true;
    } catch (e) {
      return false;
    }
  }
  DGM.clip = { write: copyToClipboard };

  const el = {
    titlebar: $("#titlebar"),
    brandVer: $("#brand-ver"),
    mockBadge: $("#mock-badge"),
    menubar: $("#menubar"),
    docTitle: $("#doc-title"),
    activitybar: $("#activitybar"),
    sidebar: $("#sidebar"),
    sideTitle: $("#side-title"),
    sideView: $("#side-view"),
    statusbar: $("#statusbar"),
    split: $("#split"),
    splitter: $("#splitter"),
    panelResizer: $("#panel-resizer"),
    sidebarGutter: $("#sidebar-gutter"),
    aiGutter: $("#ai-gutter"),
    bottomPanel: $("#bottom-panel"),
    bodyRow: $("#body-row"),
    toasts: $("#toasts"),
    pop: $("#pop"),
    popSub: $("#pop-sub"),
    editorCol: $("#editor-col"),
  };

  /* ------------------------------------------------------------------ 命令注册表 */

  // 每个命令：id / group / icon / kbd / label(取 i18n) / run(anchor) / avail()->bool|{why}
  const cmds = [];
  function cmd(def) {
    cmds.push(def);
    return def;
  }

  function cmdLabel(id) {
    const map = {
      "ai.generate": "mi.aiGenerate", "ai.vision": "mi.aiVision", "ai.review": "mi.aiReview",
      "ai.model": "mi.aiModel", "ai.apply": "mi.aiApply", "ai.history": "mi.aiHistory",
      "file.new": "mi.new", "file.open": "mi.open", "file.save": "mi.save", "file.saveAs": "mi.saveAs",
      "file.recent": "mi.openRecent", "file.cloud": "mi.cloudDocs",
      "file.openFolder": "mi.openFolder", "file.closeFolder": "mi.closeWorkspace",
      "file.searchWorkspace": "mi.searchWorkspace", "file.newFileHere": "mi.newFileHere",
      "view.mode.source": "mi.modeSource", "view.mode.split": "mi.modeSplit", "view.mode.preview": "mi.modePreview",
      "view.sidebar": "mi.sidebar", "view.ai": "mi.aiPanel", "view.panel": "mi.panel",
      "view.activitybar": "mi.activitybar", "view.fullscreen": "mi.fullscreen",
      "view.theme": "mi.toggleTheme", "view.zoom.fit": "mi.fit", "view.zoom.in": "mi.zoomIn", "view.zoom.out": "mi.zoomOut",
      "view.settings": "mi.appearance", "view.settings.ai": "mi.aiSettings", "view.settings.cloud": "mi.billing",
      "conv.center": "mi.convertCenter", "fmt.format": "mi.format", "fmt.layout": "set.convert.layouts",
      "exp.png": "exp.png", "exp.svg": "exp.svg", "exp.copy": "exp.copy",
      "help.keys": "mi.shortcuts", "help.guide": "mi.guide", "help.about": "mi.about", "help.update": "mi.checkUpdate",
      "palette": "mi.palette",
    };
    const c = cmds.find((x) => x.id === id);
    if (c && typeof c.label === "function") return c.label();
    if (c && c.label) return t(c.label);
    if (map[id]) return t(map[id]);
    return id;
  }
  function cmdKbd(id) {
    const c = cmds.find((x) => x.id === id);
    return (c && c.kbd) || "";
  }
  function cmdIcon(id) {
    const c = cmds.find((x) => x.id === id);
    return (c && c.icon) || "chevR";
  }
  function runCommand(id, anchor) {
    const c = cmds.find((x) => x.id === id);
    if (!c) {
      DGM.toast({ icon: "info", title: id, sub: t("common.none") });
      return;
    }
    const avail = c.avail ? c.avail() : true;
    if (avail === false || (avail && avail.ok === false)) {
      const why = avail && avail.why ? avail.why : t("common.none");
      DGM.toast({ icon: "alert", title: cmdLabel(id), sub: t("palette.unavail", { why }), warn: true });
      return;
    }
    c.run(anchor);
  }
  function commandList() {
    return cmds;
  }
  DGM.commands = { list: commandList, run: runCommand, label: cmdLabel, kbd: cmdKbd, icon: cmdIcon };

  /* ------------------------------------------------------------------ 转换方向
   * 可用方向 = 由 app_info.formats[].convert_to 推出（格式清单只有这一份真源）；
   * 不可用方向 = i18n 里有对应说明文案的方向（dot→mermaid 实验、两个画布 → Mermaid 计划中）。
   * 于是「不可用 ≠ 不存在」：六个方向全列，不可用给理由与计划版本。 */
  function directions() {
    const out = [];
    const list = state.formatList;
    for (const F of list) {
      for (const T of list) {
        if (F.id === T.id) continue;
        const key = `conv.dir.${F.id}.${T.id}.how`;
        const tagKey = `conv.dir.${F.id}.${T.id}.tag`;
        const ok = (F.convert_to || []).includes(T.id);
        if (ok) {
          out.push({ from: F.id, to: T.id, ok: true, how: t(key), tag: t(tagKey) });
        } else if (DGM.i18n.has(key)) {
          out.push({ from: F.id, to: T.id, ok: false, how: t(key), tag: t(tagKey) });
        }
      }
    }
    return out;
  }
  DGM.directions = directions;
  DGM.directionFor = (from, to) => directions().find((c) => c.from === from && c.to === to) || null;

  /* ------------------------------------------------------------------ 主题 */

  function setTheme(theme) {
    // theme: light | dark | auto
    state.patchSettings({ theme });
    const applied = document.documentElement.dataset.theme;
    DGM.toast({
      icon: applied === "dark" ? "moon" : "sun",
      title: t(applied === "dark" ? "theme.dark" : "theme.light"),
      sub: t("theme.switchedSub"),
    });
  }
  function toggleTheme() {
    const cur = document.documentElement.dataset.theme;
    setTheme(cur === "dark" ? "light" : "dark");
  }

  /* ------------------------------------------------------------------ toast */

  function toast(o) {
    const box = el.toasts;
    if (!box) return;
    const node = h("div", "toast" + (o.ai ? " ai" : "") + (o.warn ? " warn" : "") + (o.err ? " err" : ""));
    node.innerHTML =
      icon(o.icon || "info") +
      `<span class="bd"><b>${esc(o.title)}</b>${o.sub ? `<span>${esc(o.sub)}</span>` : ""}</span>` +
      (o.action ? `<button class="act">${esc(o.action.label)}</button>` : "");
    if (o.action && o.action.fn) {
      $(".act", node).addEventListener("click", () => {
        o.action.fn();
        node.remove();
      });
    }
    box.appendChild(node);
    const ttl = o.action ? 6000 : 3600;
    setTimeout(() => {
      node.style.transition = ".2s";
      node.style.opacity = "0";
      node.style.transform = "translateY(4px)";
      setTimeout(() => node.remove(), 220);
    }, ttl);
  }
  DGM.toast = toast;

  /* ------------------------------------------------------------------ 状态消息 */

  let statusTimer = 0;
  function status(text, kind) {
    state.setStatus(text, kind);
    clearTimeout(statusTimer);
    statusTimer = setTimeout(() => state.setStatus(t("common.ready"), ""), 4200);
  }
  DGM.status = status;

  /* ------------------------------------------------------------------ pop 菜单 */

  /** 弹出物（菜单 / 下拉）。
   *
   *  **调用方的锚点必须 `e.stopPropagation()`**：文档级有"点外面就把弹出物关掉"的监听，
   *  而锚点自己那次点击也在文档路径上 —— 不停传播的话，同一次点击里
   *  "刚开就被关"，表现是**点了没反应**（`#ai-model` 与 `#btn-export` 都踩过）。
   *  `#menubar` 的项早就这么做了，这里把它写成约定。
   */
  function showPop(items, pos, onPick, kind, container) {
    const p = $(container || "#pop");
    if (!p) return;
    p.hidden = false;
    p.innerHTML = "";
    p.className = "pop" + (kind === "menu" ? " menu" : "") + (kind === "submenu" ? " sub" : "");
    for (const it of items) {
      if (it.sep) {
        p.appendChild(h("div", "pop-sep"));
        continue;
      }
      if (it.label2) {
        p.appendChild(h("div", "pop-label", esc(it.label2)));
        continue;
      }
      const b = h("button", "pop-row" + (it.check ? " check" : "") + (it.on ? " on" : ""));
      b.innerHTML =
        (it.check ? "" : it.icon ? icon(it.icon, "ico-sm") : `<span class="ico-slot"></span>`) +
        `<span class="lbl">${esc(it.label)}</span>` +
        (it.children ? `<span class="kbd arrow-sub">${icon("chevR", "ico-sm")}</span>` : "") +
        (it.kbd && !it.children ? `<span class="kbd">${esc(it.kbd)}</span>` : "");
      if (it.disabled) b.disabled = true;
      b.addEventListener("click", (e) => {
        e.stopPropagation();
        if (!it.disabled) onPick(it, b);
      });
      if (it.children) b.addEventListener("mouseenter", () => onPick(it, b, true));
      p.appendChild(b);
    }
    const r = p.getBoundingClientRect();
    let x = pos.x;
    let y = pos.y;
    if (x + r.width > innerWidth - 8) x = innerWidth - r.width - 8;
    if (y + r.height > innerHeight - 8) y = Math.max(8, pos.y - r.height - (pos.flip || 28));
    if (x < 8) x = 8;
    p.style.left = x + "px";
    p.style.top = y + "px";
  }
  function hidePop() {
    if (el.pop) {
      el.pop.hidden = true;
      el.pop.innerHTML = "";
    }
    hideSub();
  }

  /** 在一个元素旁边弹出菜单（侧栏行尾的「更多」用它）。 */
  function popNear(items, anchor, onPick) {
    const r = anchor.getBoundingClientRect();
    showPop(items, { x: r.right - 160, y: r.bottom + 4 }, (it) => {
      hidePop();
      onPick(it);
    }, "menu");
  }

  /** 子菜单宽限期：真机上父菜单与子菜单之间有缝（字体度量与原型不同），
   *  从父菜单移向子菜单必然先"离开 #pop"—— 若立即 hideSub，子菜单在半路就被杀
   *  （真机踩过：二级菜单根本点不了）。正确做法是原生菜单的宽限：离开家族后
   *  等 220ms，期间指针进了任何菜单就取消；走投无路才算真的离开。 */
  let subGraceTimer = null;
  function scheduleSubHide() {
    clearTimeout(subGraceTimer);
    subGraceTimer = setTimeout(() => {
      subGraceTimer = null;
      hideSub();
    }, 220);
  }
  function cancelSubHide() {
    if (subGraceTimer) {
      clearTimeout(subGraceTimer);
      subGraceTimer = null;
    }
  }

  function hideSub() {
    cancelSubHide(); // 任何显式关闭（含"换一个子菜单"）都必须撤销在途的宽限定时器，
    const p = el.popSub; // 否则 220ms 后它会误杀刚打开的新子菜单
    if (p) {
      p.hidden = true;
      p.innerHTML = "";
    }
  }

  DGM.pop = { show: showPop, hide: hidePop, hideSub, near: popNear };

  /* ------------------------------------------------------------------ 菜单栏 */

  /**
   * 帮助菜单里的官方文档（一种格式一条，与注册表的顺序一致）。
   *
   * 地址放在这里而不是格式注册表里：注册表描述的是**格式能力**（能不能分屏 / 能不能转换），
   * 文档站是内容，两者寿命不同 —— 换文档站不该动 IPC 契约。点击才用系统浏览器打开，
   * 不打不开就把地址回显出来（静默失败等于"按了没反应"）。
   */
  const DOC_LINKS = [
    { label: "mi.mermaidDocs", url: "https://mermaid.js.org/intro/" },
    { label: "mi.dotDocs", url: "https://graphviz.org/doc/info/lang.html" },
    { label: "mi.d2Docs", url: "https://d2lang.com/tour/intro" },
  ];

  function buildMenus() {
    const panels = state.panels();
    const activeId = state.active;
    const recent = (state.settings && state.settings.recent) || [];
    // 模型子菜单：网关 + 本地合并后分组（形状与 AI 面板下拉一致）
    const modelChildren = DGM.ai && DGM.ai.modelItems
      ? DGM.ai.modelItems((m) => ({
          label: m.name,
          icon: "robot",
          act: "model:" + m.id,
          kbd: m.has_key ? "" : t("set.ai.keyMissing"),
        }))
      : [];
    const isText = state.isTextDoc(state.activeDoc());

    const recentItems = recent.slice(0, 6).map((r) => {
      const d = state.docs.find((x) => x.path === r.path);
      return d
        ? { label: r.name, icon: "file", act: "open:" + d.id, kbd: "" }
        : { label: r.name, icon: "file", act: "openpath:" + r.path, kbd: "" };
    });
    recentItems.push({ sep: true });
    recentItems.push({ label: t("mi.recentMore"), icon: "search", act: "cmd:file.recent" });

    return [
      {
        id: "file",
        label: t("menu.file"),
        items: [
          {
            label: t("mi.new"), kbd: "Ctrl+N", icon: "plus",
            children: state.formatList.map((f) => ({ label: f.name, icon: "file", act: "new:" + f.id, kbd: f.exts[0] })),
          },
          { label: t("mi.open"), kbd: "Ctrl+O", icon: "folderOpen", act: "cmd:file.open" },
          { label: t("mi.openFolder"), icon: "folderOpen", act: "cmd:file.openFolder" },
          { label: t("mi.closeWorkspace"), icon: "close", act: "cmd:file.closeFolder", disabled: !state.workspace.root },
          { label: t("mi.searchWorkspace"), kbd: "Ctrl+Shift+H", icon: "search", act: "cmd:file.searchWorkspace", disabled: !state.workspace.root },
          { label: t("mi.newFileHere"), icon: "plus", act: "cmd:file.newFileHere", disabled: !state.workspace.root },
          { label: t("mi.openRecent"), icon: "clock", kbd: "Ctrl+R", children: recentItems },
          { sep: true },
          { label: t("mi.cloudSave"), icon: "cloud", act: "cmd:file.cloudSave" },
          { label: t("mi.cloudDocs"), icon: "cloud", act: "cmd:file.cloud" },
          { sep: true },
          { label: t("mi.save"), kbd: "Ctrl+S", icon: "save", act: "cmd:file.save" },
          { label: t("mi.saveAs"), kbd: "Ctrl+Shift+S", icon: "save", act: "cmd:file.saveAs" },
          { sep: true },
          {
            label: t("mi.convertTo"), icon: "swap",
            children: (state.docFmt(state.activeDoc()).convert_to || []).map((to) => ({
              label: state.fmtById(to).name, icon: "swap", act: "conv:" + to, kbd: t("conv.tag.done"),
            })).concat([{ sep: true }, { label: t("mi.convertCenter"), icon: "swap", act: "cmd:conv.center" }]),
          },
          { sep: true },
          { label: t("mi.closeTab"), kbd: "Ctrl+W", icon: "close", act: "doc:close", disabled: !activeId },
          { label: t("mi.quit"), kbd: "Ctrl+Q", icon: "close", act: "app:quit" },
        ],
      },
      {
        id: "edit",
        label: t("menu.edit"),
        items: [
          { label: t("mi.undo"), kbd: "Ctrl+Z", icon: "undo", act: "tip:tip.undo" },
          { label: t("mi.redo"), kbd: "Ctrl+Y", icon: "undo", act: "tip:tip.redo" },
          { sep: true },
          { label: t("mi.find"), kbd: "Ctrl+F", icon: "search", act: "find" },
          { label: t("mi.format"), kbd: "Shift+Alt+F", icon: "wand", act: "cmd:fmt.format" },
          { sep: true },
          { label: t("mi.cut"), kbd: "Ctrl+X", act: "tip:tip.find" },
          { label: t("mi.copy"), kbd: "Ctrl+C", act: "tip:tip.find" },
          { label: t("mi.paste"), kbd: "Ctrl+V", act: "tip:tip.find" },
          { label: t("mi.selectAll"), kbd: "Ctrl+A", act: "tip:tip.find" },
        ],
      },
      {
        id: "view",
        label: t("menu.view"),
        items: [
          { label: t("mi.palette"), kbd: "Ctrl+Shift+P", icon: "bolt", act: "cmd:palette" },
          { sep: true },
          { label: t("mi.appearance"), icon: "palette", act: "cmd:view.settings" },
          { label: t("mi.toggleTheme"), kbd: "Ctrl+K Ctrl+T", icon: "moon", act: "cmd:view.theme" },
          { sep: true },
          { label: t("mi.sidebar"), kbd: "Ctrl+B", icon: "panelLeft", act: "cmd:view.sidebar", check: true },
          { label: t("mi.aiPanel"), kbd: "Ctrl+Shift+A", icon: "panelRight", act: "cmd:view.ai", check: true },
          { label: t("mi.panel"), kbd: "Ctrl+J", icon: "panelBottom", act: "cmd:view.panel", check: true },
          { label: t("mi.activitybar"), icon: "layers", act: "cmd:view.activitybar", check: true },
          { sep: true },
          { label: t("mi.modeSource"), kbd: "Ctrl+1", icon: "code", act: "mode:source", radio: "mode", disabled: !isText },
          { label: t("mi.modeSplit"), kbd: "Ctrl+2", icon: "splitV", act: "mode:split", radio: "mode", disabled: !isText },
          { label: t("mi.modePreview"), kbd: "Ctrl+3", icon: "eye", act: "mode:preview", radio: "mode", disabled: false },
          { label: t("mi.fullscreen"), kbd: "Ctrl+Shift+F", icon: "maximize", act: "cmd:view.fullscreen" },
          { sep: true },
          { label: t("mi.fit"), kbd: "Ctrl+0", icon: "fit", act: "cmd:view.zoom.fit" },
          { label: t("mi.zoomIn"), kbd: "Ctrl+=", act: "cmd:view.zoom.in" },
          { label: t("mi.zoomOut"), kbd: "Ctrl+-", act: "cmd:view.zoom.out" },
        ],
      },
      {
        id: "ai",
        label: t("menu.ai"),
        items: [
          { label: t("mi.aiGenerate"), kbd: "Ctrl+I", icon: "sparkles", act: "cmd:ai.generate" },
          { label: t("mi.aiVision"), kbd: "Ctrl+Shift+I", icon: "scan", act: "cmd:ai.vision" },
          { label: t("mi.aiReview"), icon: "wand", act: "cmd:ai.review" },
          { label: t("mi.aiApply"), icon: "check", act: "cmd:ai.apply" },
          { sep: true },
          {
            label: t("mi.aiModel"), icon: "robot",
            // 分组规则与 AI 面板的下拉**共用** DGM.ai.modelItems（见那边注释：
            // 网关与本地两组的凭据来源不同，混排会让人以为网关模型也要填 key）。
            children: modelChildren.length
              ? modelChildren
              : [{ label: t("ai.noModels.title"), icon: "alert", act: "cmd:view.settings.ai" }],
          },
          { label: t("mi.aiHistory"), icon: "history", act: "cmd:ai.history" },
          { sep: true },
          { label: t("mi.aiSettings"), icon: "settings", act: "cmd:view.settings.ai" },
        ],
      },
      {
        id: "help",
        label: t("menu.help"),
        items: [
          { label: t("mi.shortcuts"), kbd: "Ctrl+K Ctrl+S", icon: "keyboard", act: "cmd:help.keys" },
          { label: t("mi.guide"), icon: "info", act: "cmd:help.guide" },
          { sep: true },
          // 官方文档：点一下用系统浏览器打开（地址写死在 DOC_LINKS，不硬编码在菜单里）
          ...DOC_LINKS.map((d) => ({ label: t(d.label), icon: "globe", act: "link:" + d.url })),
          { sep: true },
          { label: t("mi.checkUpdate"), icon: "refresh", act: "cmd:help.update" },
          { label: t("mi.about"), icon: "info", act: "cmd:help.about" },
        ],
      },
    ];
  }

  function menuItems(items) {
    const panels = state.panels();
    const isText = state.isTextDoc(state.activeDoc());
    const activeDoc = state.activeDoc();
    return items.map((it) => {
      if (it.sep) return { sep: true };
      // `label2` 是**分组小标题**（不可点）：menuItems 要原样透传，
      // 否则模型子菜单里那两个组名会被当成普通按钮画出来。
      const out = { label: it.label, icon: it.icon, kbd: it.kbd, disabled: it.disabled, children: it.children, act: it.act, label2: it.label2 };
      if (it.check) {
        const which = {
          "cmd:view.sidebar": panels.sidebar,
          "cmd:view.ai": panels.ai,
          "cmd:view.panel": panels.bottom,
          "cmd:view.activitybar": panels.activitybar,
        }[it.act];
        out.check = true;
        out.on = !!which;
      }
      if (it.radio === "mode") {
        out.check = true;
        out.on = isText && state.mode(activeDoc) === it.act.split(":")[1];
        if (it.act === "mode:preview") out.disabled = false; // 仅预览对画布型也成立
      }
      if (String(it.act || "").startsWith("model:")) {
        out.check = true;
        out.on = state.ai().default_model === it.act.slice(6);
      }
      return out;
    });
  }

  function renderMenubar() {
    const bar = el.menubar;
    if (!bar) return;
    const menus = buildMenus();
    bar.innerHTML = "";
    for (const m of menus) {
      const b = h("button", "tb-item", esc(m.label));
      b.dataset.menu = m.id;
      b.addEventListener("click", (e) => {
        e.stopPropagation();
        if (bar.dataset.open === m.id) return closeMenu();
        openMenu(m, b);
      });
      b.addEventListener("mouseenter", () => {
        if (bar.dataset.open && bar.dataset.open !== m.id) openMenu(m, b);
      });
      bar.appendChild(b);
    }
  }

  function openMenu(menu, anchor) {
    const bar = el.menubar;
    bar.dataset.open = menu.id;
    $$(".tb-item", bar).forEach((b) => b.classList.toggle("open", b.dataset.menu === menu.id));
    const r = anchor.getBoundingClientRect();
    hideSub();
    showPop(menuItems(menu.items), { x: r.left, y: r.bottom + 4 }, pickMenu, "menu");
  }

  function pickMenu(it, row, hover) {
    if (it.children) {
      if (!row) return;
      const r = row.getBoundingClientRect();
      row.classList.add("has-sub");
      $$("#pop .pop-row").forEach((b) => {
        if (b !== row) b.classList.remove("has-sub");
      });
      showPop(
        menuItems(it.children),
        { x: r.right + 2, y: r.top - 5 },
        (sub) => {
          closeMenu();
          runAct(sub.act, sub);
        },
        "submenu",
        "#pop-sub",
      );
      return;
    }
    if (hover) return;
    closeMenu();
    runAct(it.act, it);
  }

  function closeMenu() {
    const bar = el.menubar;
    if (bar) bar.dataset.open = "";
    $$(".tb-item").forEach((b) => b.classList.remove("open"));
    hidePop();
    hideSub();
  }

  /* ------------------------------------------------------------------ act 分发 */

  function runAct(act, it) {
    if (!act) return;
    if (act === "todo") return;
    if (act.startsWith("tip:")) return toast({ icon: "info", title: it ? it.label : t("common.help"), sub: t(act.slice(4)) });
    if (act.startsWith("link:")) return openDocLink(act.slice(5), it ? it.label : "");
    if (act.startsWith("new:")) return DGM.dialogs.newDoc(act.slice(4));
    if (act.startsWith("open:")) return activateDocById(act.slice(5));
    if (act.startsWith("openpath:")) return openPath(act.slice(9));
    if (act.startsWith("conv:")) return DGM.dialogs.convertTo(act.slice(5));
    if (act.startsWith("model:")) return setModel(act.slice(6));
    if (act.startsWith("mode:")) return setMode(act.slice(5));
    if (act === "find") return DGM.editor.openSearch();
    if (act === "doc:close") return closeActive();
    if (act === "app:quit") return quit();
    if (act.startsWith("cmd:")) return runCommand(act.slice(4));
    return;
  }

  /**
   * 打开官方文档（帮助菜单那三条）。
   *
   * 走的是与「去官网注册」同一个通道（`tauri-plugin-opener`，能力位已放行 https）：
   * **用户点一下才开系统浏览器**，应用自己不发起任何网络请求 —— 离线优先说的是
   * "渲染与校验不依赖网络"，不是"点文档也不许跳"。
   * 打不开（装了精简版浏览器 / 无默认浏览器）就如实把地址回显在提示里，让人手工访问。
   */
  async function openDocLink(url, label) {
    let ok = false;
    try {
      ok = DGM.cloud && typeof DGM.cloud.openExternal === "function" ? await DGM.cloud.openExternal(url) : false;
    } catch (e) {
      ok = false;
    }
    if (ok) toast({ icon: "globe", title: label || t("common.help"), sub: url });
    else toast({ icon: "alert", title: label || t("common.help"), sub: t("tip.openFailed", { url }), warn: true });
  }

  function activateDocById(id) {
    if (id === state.active) return;
    state.activateDoc(id).catch((e) => status(String(e && e.message), "err"));
  }

  async function setModel(id) {
    await state.patchSettings({ ai: { default_model: id } });
    // 在**合并后**的列表里找名字：网关别名不在 settings.ai.models 里，
    // 只查本地那份会让"切到网关模型"静默无提示。
    const m = state.modelChoices().find((x) => x.id === id);
    if (m) toast({ icon: "robot", title: t("ai.model.switch"), sub: m.name, ai: true });
  }

  function setMode(mode) {
    const d = state.activeDoc();
    if (!d) return;
    if (state.isCanvasDoc(d)) {
      toast({ icon: "hand", title: t("status.canvasFormat"), sub: t("status.canvasFormatSub") });
      return;
    }
    state.setViewMode(d.id, mode);
    status(t("status.mode." + mode), "");
  }

  /* ------------------------------------------------------------------ 布局状态机 */

  function applyLayoutVars() {
    const p = state.panels();
    const root = document.documentElement;
    if (p.sidebar_w) root.style.setProperty("--sidebar-w", p.sidebar_w + "px");
    if (p.ai_w) root.style.setProperty("--ai-w", p.ai_w + "px");
    if (p.panel_h) root.style.setProperty("--panel-h", p.panel_h + "px");
    // 源码窗格宽度：默认 1/3，硬边界 1/4–1/2。
    // **旧默认 46 的归一化不在这里做** —— renderChrome 每次都跑本函数，
    // 用户真拖到 46% 会被立即抹回 33（探针实测）。迁移在 state.load() 一次性完成。
    const split = Math.max(25, Math.min(50, p.split_src || 33));
    el.split.style.setProperty("--split-src", split + "%");
    document.body.classList.toggle("no-sidebar", !p.sidebar);
    document.body.classList.toggle("no-ai", !p.ai);
    document.body.classList.toggle("no-activitybar", !p.activitybar);
    document.body.classList.toggle("no-panel", !p.bottom);
  }

  async function togglePanel(key, extra) {
    const p = state.panels();
    const patch = { panels: Object.assign({}, { [key]: !p[key] }, extra || {}) };
    await state.patchSettings(patch);
  }

  function setSidebarView(view) {
    state.patchSettings({ panels: { sidebar_view: view, sidebar: true } });
  }

  function zenMode() {
    const ui = state.ui;
    const on = !ui.zen;
    if (on) {
      ui.zenPrev = {
        sidebar: state.panels().sidebar,
        ai: state.panels().ai,
        bottom: state.panels().bottom,
        activitybar: state.panels().activitybar,
        view: state.mode(state.activeDoc()),
      };
      ui.zen = true;
      state.patchSettings({ panels: { sidebar: false, ai: false, bottom: false, activitybar: false } });
      const d = state.activeDoc();
      if (d && state.isTextDoc(d)) state.setViewMode(d.id, "preview");
      toast({ icon: "maximize", title: t("mi.fullscreen"), sub: t("layout.resetToastSub") });
    } else {
      const p = ui.zenPrev || {};
      ui.zen = false;
      state.patchSettings({
        panels: {
          sidebar: p.sidebar !== false,
          ai: p.ai !== false,
          bottom: p.bottom !== false,
          activitybar: p.activitybar !== false,
        },
      });
      const d = state.activeDoc();
      if (d && state.isTextDoc(d) && p.view) state.setViewMode(d.id, p.view);
    }
  }

  /* ------------------------------------------------------------------ 标题栏 / 文档标题 */

  function renderDocTitle() {
    const box = el.docTitle;
    if (!box) return;
    const d = state.activeDoc();
    if (!d) {
      box.innerHTML = `<span class="dot"></span><b>${esc(t("app.name"))}</b><span class="path">${esc(t("status.noDoc"))}</span>`;
      return;
    }
    // 只显示文件名：完整路径鼠标悬停在标签页头上就能看到（那才是它的位置）——
    // 标题栏摆一长串路径只会把窗口标题挤没（2026-10-15 用户要求）。
    box.innerHTML =
      `<span class="dot" style="background:var(--fmt-${d.format})"></span>` +
      `<b>${esc(d.name)}${d.dirty ? " ·" : ""}</b>`;
  }

  /* ------------------------------------------------------------------ 活动栏 */

  const ACTS = [
    { id: "explorer", icon: "explorer", label: "act.explorer", kbd: "Alt+1" },
    { id: "search", icon: "search", label: "act.search", kbd: "Alt+2" },
    { id: "convert", icon: "swap", label: "act.convert", kbd: "Alt+3" },
    { id: "cloud", icon: "cloud", label: "act.cloud", kbd: "Alt+4" },
    { id: "outline", icon: "outline", label: "act.outline", kbd: "Alt+5" },
  ];

  function renderActivity() {
    const bar = el.activitybar;
    if (!bar) return;
    const p = state.panels();
    bar.innerHTML = "";
    for (const a of ACTS) {
      const b = h("button", "act" + (p.sidebar_view === a.id && p.sidebar ? " on" : ""));
      b.innerHTML = icon(a.icon);
      b.title = `${t(a.label)}  ${a.kbd}`;
      b.addEventListener("click", () => {
        // 同上：现读，别拿 render 时的快照去判"再点一次就收起"
        if (state.panels().sidebar_view === a.id) togglePanel("sidebar");
        else setSidebarView(a.id);
      });
      bar.appendChild(b);
    }
    bar.appendChild(h("div", "act-sep"));
    const unread = DGM.ai && DGM.ai.unread ? DGM.ai.unread() : 0;
    const ai = h("button", "act is-ai" + (p.ai ? " on" : ""));
    ai.innerHTML = icon("sparkles") + (unread ? `<span class="badge">${unread > 9 ? "9+" : unread}</span>` : "");
    ai.title = t("mi.aiPanel") + "  Ctrl+Shift+A";
    ai.addEventListener("click", () => togglePanel("ai"));
    bar.appendChild(ai);

    bar.appendChild(h("div", "act-spacer"));
    // 账户：**独立视图**（只读账户信息），不再与「云端文档」共用同一个 cloud 视图。
    // title 也从「账户与云端」改成了「账户」——那块设置页仍叫「账户与云端」。
    // 未登录时点它**直接弹登录窗口**（用户明确要求的交互）；登录成功后落到账户视图 ——
    // 登录只是中途一站，不能把用户晾在他没点的地方。
    //
    // 判定一律**现读 state**，不要用 render 时的快照：活动栏不会因为登录/登出而重渲染
    // （`cloud:changed` 原本只喂侧栏），拿快照的按钮会卡在"未登录"那一支上 ——
    // 登录完再点它只弹一句「已登录」，怎么点都切不过去，
    // 直到别的原因（换个侧栏面板等）触发一次整屏重渲染才"又好了"。
    const acct = h("button", "act" + (p.sidebar_view === "account" && p.sidebar ? " on" : ""));
    acct.innerHTML = icon("user");
    acct.title = t("act.account");
    acct.addEventListener("click", async () => {
      const cur = state.panels();
      // **"还没查回来" ≠ "未登录"**：启动那一查是后台跑的，用户完全可能在它回来之前就点
      // 这一下。按未登录取值会直接把一个明明有效的会话丢进登录窗（2026-10-15 用户报的
      // "启动后要手点一下账户才变登录"，症状就是这一支被走错）。没查过 / 上次没查成，
      // 就先补一次；最多等 6s，等不到再按现状决定（真结果回来时 cloud:changed 还会再刷）。
      if (!state.cloud.checked || state.cloud.lastError) {
        await Promise.race([
          state.cloudRefresh(),
          new Promise((r) => setTimeout(r, 6000)),
        ]);
      }
      const signed = !!state.cloud.status.signed_in;
      const configured = !!((state.settings.cloud || {}).base_url || "").trim();
      if (configured && !signed) {
        return void DGM.cloud.openLogin({ onSuccess: () => setSidebarView("account") });
      }
      if (cur.sidebar_view === "account" && cur.sidebar) togglePanel("sidebar");
      else setSidebarView("account");
    });
    bar.appendChild(acct);
    const keys = h("button", "act");
    keys.innerHTML = icon("keyboard");
    keys.title = t("mi.shortcuts") + "  Ctrl+K Ctrl+S";
    keys.addEventListener("click", () => DGM.dialogs.keys());
    bar.appendChild(keys);
    const st = h("button", "act");
    st.innerHTML = icon("settings");
    st.title = t("common.settings");
    st.addEventListener("click", () => DGM.dialogs.settings("appearance"));
    bar.appendChild(st);
  }

  /* ------------------------------------------------------------------ 状态栏 */

  function renderStatus() {
    const bar = el.statusbar;
    if (!bar) return;
    const d = state.activeDoc();
    const panels = state.panels();
    const totals = state.issueTotals();
    const ui = state.ui;
    const aiModel = state.currentModel();
    const mode = d ? state.mode(d) : "split";
    const modeName = mode === "source" ? t("viewmode.source") : mode === "preview" ? t("viewmode.preview") : t("viewmode.split");
    const modeIcon = mode === "source" ? "code" : mode === "preview" ? "eye" : "splitV";
    const scope = d ? state.scopeByDoc[d.id] || "" : "";
    const zoomPct = Math.round(ui.zoom * 100);
    const statusText = ui.status.text || t("common.ready");

    const parts = [];
    parts.push(`<button class="st" data-a="panel" title="${esc(t("status.togglePanel"))}">${icon("panelBottom", "ico-sm")}</button>`);
    parts.push(
      `<button class="st ${totals.err ? "err" : totals.warn ? "warn" : ""}" data-a="problems" title="${esc(t("status.problemsTip"))}">` +
        icon(totals.err ? "err" : totals.warn ? "warn" : "ok", "ico-sm") +
        `<span class="st-num">${totals.err}</span><span class="st-num">${totals.warn}</span></button>`,
    );
    parts.push(`<button class="st" data-a="ai" title="${esc(t("status.aiTip"))}">${icon("sparkles", "ico-sm")}${esc(aiModel ? aiModel.name : t("ai.model.none"))}</button>`);
    parts.push(`<span class="st ro" title="${esc(t("status.usageTip"))}">${icon("bolt", "ico-sm")}${esc(t("status.calls", { n: state.usage.calls }))}</span>`);
    // 有新版本 / 正在下载 / 下载卡住：都体现在这一颗按钮上，点它**打开更新窗口**
    // （说明、进度、手动下载都在那个窗口里 —— 状态栏只负责"回到窗口"）。
    if (pendingUpdate || updateState !== "idle") {
      const cls = updateState === "stalled" ? "st warn" : "st accent";
      const ico = updateState === "stalled" ? "alert" : updateState === "finished" ? "check" : "download";
      parts.push(
        `<button class="${cls}" data-a="update" title="${esc(updateItemTip())}">` +
          icon(ico, "ico-sm") +
          esc(updateLabelText()) +
          `</button>`,
      );
    }
    parts.push(`<span class="st-spacer"></span>`);
    parts.push(`<span class="st ${ui.status.kind === "err" ? "err" : ui.status.kind === "warn" ? "warn" : ui.status.kind === "ok" ? "accent" : ""}" id="status-msg">${esc(statusText)}</span>`);
    parts.push(`<span class="st-spacer"></span>`);
    // 有布局引擎的格式才有这一格（DOT 六种、D2 三种；Mermaid / 画布型没有）
    const layouts = d ? state.docFmt(d).layouts || [] : [];
    if (layouts.length) {
      parts.push(`<button class="st" data-a="layout" title="${esc(t("status.layoutTip"))}">${icon("diagram", "ico-sm")}${esc(t("status.layout", { name: d.layout || layouts[0] }))}</button>`);
    }
    parts.push(`<span class="st ro" title="${esc(t("status.modeTip"))}">${icon(modeIcon, "ico-sm")}${esc(modeName)}</span>`);
    parts.push(`<button class="st" data-a="zoom" title="${esc(t("status.zoomTip"))}">${icon("zoomIn", "ico-sm")}${zoomPct}%</button>`);
    if (d && state.isTextDoc(d)) {
      parts.push(`<span class="st ro">${t("common.line")} ${d.caret_line}, ${t("common.col")} ${d.caret_col}</span>`);
    }
    if (scope) {
      parts.push(`<span class="st ro" title="${esc(t("status.scopeTip"))}">${icon("layers", "ico-sm")}${esc(scope)}</span>`);
    }
    parts.push(`<span class="st ro">${esc(t("status.encoding"))}</span>`);
    if (d && state.isTextDoc(d)) parts.push(`<span class="st ro">${esc(t("status.eol"))}</span>`);
    // 当前格式 = 「转换为」的近入口之一（另一处在标签条）：点它弹转换菜单。
    parts.push(`<button class="st accent" data-a="convert" title="${esc(t("status.formatConvertTip"))}">${esc(d ? state.docFmt(d).name : t("status.noDoc"))}</button>`);

    bar.innerHTML = parts.join("");
    bar.onclick = (e) => {
      const b = e.target.closest("[data-a]");
      if (!b) return;
      const a = b.dataset.a;
      if (a === "panel") togglePanel("bottom");
      else if (a === "problems") {
        if (!panels.bottom) togglePanel("bottom", { bottom_tab: "problems" });
        else state.patchSettings({ panels: { bottom_tab: "problems" } });
      } else if (a === "ai") togglePanel("ai");
      // 状态栏那一项只做一件事：打开更新窗口（说明 / 进度 / 手动下载都在那个窗口里）
      else if (a === "update") openUpdateDialog();
      else if (a === "zoom") DGM.preview.resetZoom();
      // 弹菜单的两个分支必须 stopPropagation：状态栏本身不用停（别的按钮还要让
      // 文档级监听关掉别处的弹出物），只停"弹菜单"这一次点击（showPop 的约定）。
      else if (a === "layout") { e.stopPropagation(); popLayouts(b); }
      else if (a === "convert") { e.stopPropagation(); popConvertMenu(b); }
    };
  }

  /* ------------------------------------------------------------------ pop 面板 */

  function popLayouts(anchor) {
    const d = state.activeDoc();
    if (!d) return;
    const fmt = state.docFmt(d);
    const layouts = fmt.layouts || [];
    const current = d.layout || layouts[0];
    const r = anchor.getBoundingClientRect();
    showPop(
      [{ label2: t("layout.engine") }].concat(
        layouts.map((l) => ({ label: l, icon: "diagram", on: current === l, lay: l })),
        [{ sep: true }, { label: t("layout.dotMore"), icon: "info", act: "more" }],
      ),
      { x: r.left - 120, y: r.top - 6, flip: r.height + 8 },
      (it) => {
        hidePop();
        if (it.act === "more") return DGM.dialogs.layout();
        state.setLayout(d.id, it.lay);
        // 这句话不写"未重载 WASM"之类的实现细节：DOT 是增量更新、D2 要重新编译，
        // 两种情形都由各自的渲染器负责，界面只报结果（写死一句就对另一种是假话）。
        status(t("layout.switched", { name: it.lay }), "ok");
        state.pushOutput(`${fmt.name} 布局切换 → ${it.lay}`, "ok");
      },
    );
  }

  /** 「转换为」下拉（标签条按钮与状态栏格式指示器共用）。
   *  转换是"针对当前文档的动作"，入口就该贴着工作区；侧栏的转换中心保留，
   *  职责降为全览矩阵（六方向表格 + 不可用理由）——菜单末尾留它的入口。
   *  锚点必须 stopPropagation（showPop 的约定），调用方负责。 */
  function popConvertMenu(anchor) {
    const d = state.activeDoc();
    if (!d) return;
    const fmt = state.docFmt(d);
    const items = (fmt.convert_to || [])
      .map((to) => ({ label: t("palette.convert", { from: fmt.name, to: state.fmtById(to).name }), icon: "swap", act: "conv:" + to }))
      .concat([{ sep: true }, { label: t("mi.convertCenter"), icon: "swap", act: "center" }]);
    const r = anchor.getBoundingClientRect();
    showPop(
      items,
      { x: r.left, y: r.bottom + 4 },
      (it) => {
        hidePop();
        if (it.act === "center") setSidebarView("convert");
        else DGM.dialogs.convertTo(it.act.slice(5));
      },
      "menu",
    );
  }

  function popLayoutPicker(anchor) {
    const p = state.panels();
    const isText = state.isTextDoc(state.activeDoc());
    const r = anchor.getBoundingClientRect();
    showPop(
      [
        { label2: t("layout.panels") },
        { label: t("layout.activitybar"), icon: "layers", check: true, on: p.activitybar, act: "act" },
        { label: t("layout.sidebar"), icon: "panelLeft", check: true, on: p.sidebar, kbd: "Ctrl+B", act: "side" },
        { label: t("layout.ai"), icon: "sparkles", check: true, on: p.ai, kbd: "Ctrl+Shift+A", act: "ai" },
        { label: t("layout.panel"), icon: "panelBottom", check: true, on: p.bottom, kbd: "Ctrl+J", act: "panel" },
        { sep: true },
        { label2: t("layout.modes") },
        { label: t("mi.modeSource"), icon: "code", check: true, on: state.mode(state.activeDoc()) === "source" && isText, act: "m-source", disabled: !isText },
        { label: t("mi.modeSplit"), icon: "splitV", check: true, on: state.mode(state.activeDoc()) === "split" && isText, act: "m-split", disabled: !isText },
        { label: t("mi.modePreview"), icon: "eye", check: true, on: state.mode(state.activeDoc()) === "preview", act: "m-preview" },
        { sep: true },
        { label: t("layout.zen"), icon: "maximize", kbd: "Ctrl+Shift+F", act: "zen" },
        { label: t("layout.reset"), icon: "refresh", act: "reset" },
        { label: document.documentElement.dataset.theme === "light" ? t("layout.themeLight") : t("layout.themeDark"), icon: document.documentElement.dataset.theme === "light" ? "moon" : "sun", kbd: "Ctrl+K Ctrl+T", act: "theme" },
        { label: t("layout.appearance"), icon: "settings", act: "settings" },
      ],
      { x: r.left - 300, y: r.bottom + 6 },
      (it) => {
        const reopen = ["act", "side", "ai", "panel", "m-source", "m-split", "m-preview"].includes(it.act);
        if (!reopen) hidePop();
        switch (it.act) {
          case "act": togglePanel("activitybar"); break;
          case "side": togglePanel("sidebar"); break;
          case "ai": togglePanel("ai"); break;
          case "panel": togglePanel("bottom"); break;
          case "m-source": setMode("source"); break;
          case "m-split": setMode("split"); break;
          case "m-preview": setMode("preview"); break;
          case "zen": return zenMode();
          case "theme": return toggleTheme();
          case "settings": return DGM.dialogs.settings("appearance");
          case "reset":
            BGM_RESET();
            return;
        }
        if (reopen) popLayoutPicker(anchor);
      },
      "menu",
    );
  }

  function BGM_RESET() {
    const defView = state.isTextDoc(state.activeDoc()) ? "split" : "preview";
    // 「恢复默认布局」要跟 PanelPrefs::default() 一致 —— 侧栏现在默认收起（画布优先）
    state.patchSettings({
      panels: { activitybar: true, sidebar: false, ai: true, bottom: true, sidebar_view: "explorer" },
    });
    const d = state.activeDoc();
    if (d && state.isTextDoc(d)) state.setViewMode(d.id, defView);
    toast({ icon: "refresh", title: t("layout.resetToast"), sub: t("layout.resetToastSub") });
  }

  /* ------------------------------------------------------------------ 文档动作 */

  function suggestedName(doc, ext) {
    const d = doc || state.activeDoc();
    let stem = d ? d.name.replace(/\.[^.]+$/, "") : t("common.untitled");
    return stem + (ext || (d ? state.docFmt(d).exts[0] : ".mmd"));
  }

  /**
   * 保存对话框的「文件类型」清单：**本标签页的格式排第一位**，其后才是「所有文件」。
   *
   * 顺序不是装饰 —— Win32 的保存对话框拿**第一个过滤器的第一个扩展名**当缺省后缀
   * （rfd 的 `add_filters` → `SetDefaultExtension`，见 rfd/…/win_cid/file_dialog/dialog_ffi.rs），
   * 排错了 drawio / DOT / Excalidraw 标签页会被系统补成 `.mmd`：后缀与内容对不上，
   * 下次打开按错格式解析（v2 客户端踩过这个坑，见其 FileService.SaveFileAsync 的注释）。
   *
   * 只列当前格式 + 所有文件：本应用的「保存」**不做跨格式转换**（要换格式走转换中心）。
   */
  function saveFilters(fmt) {
    const exts = (fmt.exts || []).map((e) => String(e).replace(/^\./, "")).filter(Boolean);
    const own = exts.length
      ? [{ name: `${fmt.name} (${exts.map((e) => "*." + e).join("; ")})`, extensions: exts }]
      : [];
    return own.concat([{ name: t("common.allFiles"), extensions: ["*"] }]);
  }

  /**
   * 补回规范扩展名：只有 Windows 的后端保证按过滤器的缺省后缀补（别的后端不保证），
   * 而用户把名字里的后缀删掉是常事 —— 存出一个没有后缀的文件，重新打开会按 Mermaid 兜底解析。
   * 已经写了后缀的（含用户自己敲的 `.txt`）原样保留：那是用户的决定。
   */
  function withCanonicalExt(path, fmt) {
    const s = String(path);
    const base = s.split(/[\\/]/).pop() || "";
    if (/\.[^./\\]+$/.test(base)) return s;
    return s.replace(/[.\s]+$/, "") + ((fmt.exts && fmt.exts[0]) || "");
  }

  async function saveActive(as) {
    const d = state.activeDoc();
    if (!d) return;

    // 画布型：落盘前先把画布里的最新内容取出来。
    // drawio 自己的 autosave 是 1.5s 去抖，用户「改完立刻按 Ctrl+S」时会输给它 ——
    // 这里主动要一次 XML，不让保存读到旧正文。
    if (state.isCanvasDoc(d) && DGM.canvas && DGM.canvas.supports(d.format)) {
      try {
        const body = await DGM.canvas.flush(d.format);
        if (typeof body === "string" && body && body !== d.body) {
          await state.setBodyNow(d.id, body);
        }
      } catch (e) {
        // 取不到就按当前正文存，但要让用户知道这次可能不是最新的
        state.pushOutput(`画布取正文失败，按当前正文保存：${(e && e.message) || e}`, "warn");
      }
    }

    let path = d.path;
    if (as || !path) {
      const fmt = state.docFmt(d);
      const picked = await ipc.dialog.pickSavePath({ defaultPath: suggestedName(d), filters: saveFilters(fmt) });
      if (picked) path = withCanonicalExt(picked, fmt);
      else if (ipc.isMock) path = d.path || "E:/OpenCode/diagramon/docs/" + suggestedName(d);
      else return; // 用户取消
    }
    try {
      const doc = await state.saveDoc(d.id, as || !d.path, path);
      if (doc) {
        status(t("status.saved", { name: doc.name }), "ok");
        state.pushOutput(`已保存 ${doc.name}（${state.docFmt(doc).name}）`, "ok");
        toast({ icon: "save", title: t("common.save"), sub: doc.path || doc.name });
      }
    } catch (e) {
      status(t("status.saveFailed") + ": " + (e && e.message), "err");
    }
  }

  async function openFile() {
    let paths = await ipc.dialog.pickPaths({
      filters: [{ name: "Diagram", extensions: ["mmd", "mermaid", "dot", "gv", "d2", "drawio", "excalidraw"] }],
    });
    if (!paths.length && ipc.isMock) {
      // mock：没有真实文件对话框，用示例路径演示「打开 → 落进会话」这条链路
      paths = ["E:/OpenCode/diagramon/docs/flows/支付回调.mmd"];
    }
    if (!paths.length) return;
    try {
      await state.openPaths(paths);
      const d = state.activeDoc();
      if (d) {
        state.refreshRecent(d);
        status(t("status.opened", { name: d.name }));
        DGM.editor.loadActive();
        DGM.preview.schedule();
        state.refreshDerived(d.id);
      }
    } catch (e) {
      status(t("status.openFailed") + ": " + (e && e.message), "err");
    }
  }

  async function openPath(path) {
    try {
      await state.openPaths([path]);
      DGM.editor.loadActive();
      DGM.preview.schedule();
      state.refreshDerived(state.active);
    } catch (e) {
      status(t("status.openFailed") + ": " + (e && e.message), "err");
    }
  }

  async function closeActive() {
    const d = state.activeDoc();
    if (!d) return;
    await closeDocWithConfirm(d.id);
  }

  async function closeDocWithConfirm(id) {
    const d = state.doc(id);
    if (!d) return;
    if (d.dirty) {
      const choice = await DGM.dialogs.unsaved(d.name);
      if (choice === "cancel") return;
      if (choice === "save") {
        await state.activateDoc(id);
        await saveActive(false);
        const after = state.doc(id);
        if (after && after.dirty) return; // 保存被取消（未落盘）→ 中止关闭
      }
    }
    const wasActive = state.active === id;
    await state.closeDoc(id);
    state.pushOutput(t("status.closed", { name: d.name }), "");
    if (wasActive) {
      DGM.editor.loadActive();
      DGM.preview.schedule();
      if (state.active) state.refreshDerived(state.active);
    }
    toast({ icon: "close", title: t("status.closed", { name: d.name }), sub: "" });
  }

  async function quit() {
    const dirty = state.docs.filter((d) => d.dirty);
    if (dirty.length) {
      const ok = await DGM.dialogs.quit(dirty.length);
      if (!ok) return;
    }
    await state.flushBody();
    // 显式退出必须走 app_exit（整个应用结束）：ipc.win.close() 只关窗口，
    // 会被后端按 close_to_tray 拦成"隐藏到托盘" —— 菜单里点退出却藏起来就错了。
    // mock 模式没有这个命令（返回 null 什么都不做），浏览器里本就没有进程可退。
    try {
      await DGM.ipc.invoke("app_exit");
    } catch (e) {
      ipc.win.close();
    }
  }

  function formatSource() {
    const d = state.activeDoc();
    if (!d) return;
    if (state.isCanvasDoc(d)) {
      toast({ icon: "wand", title: t("status.canvasFormat"), sub: t("status.canvasFormatSub") });
      return;
    }
    // 真实实现里格式化由 Rust 侧的格式器完成；这里只做一次无害的空格规整（原型同款行为）
    const body = d.body.split("\n").map((ln) => ln.replace(/\s+$/, "")).join("\n");
    if (body !== d.body) {
      state.setBodyNow(d.id, body).then(() => DGM.editor.setValue(body));
    }
    status(t("mi.format"), "ok");
    toast({ icon: "wand", title: t("mi.format"), sub: "" });
  }

  /* ------------------------------------------------------------------ 分隔条 / 面板高度拖拽 */

  function setupDrag() {
    // 源码 : 预览
    let dragging = false;
    el.splitter.addEventListener("mousedown", (e) => {
      const d = state.activeDoc();
      if (!d || !state.isTextDoc(d) || state.mode(d) !== "split") return;
      dragging = true;
      document.body.classList.add("resizing");
      el.splitter.classList.add("drag");
      e.preventDefault();
    });
    window.addEventListener("mousemove", (e) => {
      if (!dragging) return;
      const r = el.split.getBoundingClientRect();
      let pct = ((e.clientX - r.left) / r.width) * 100;
      // 源码窗格占工作区的比例：默认 1/3，夹在 1/4–1/2（用户拍板的硬边界）
      pct = Math.max(25, Math.min(50, pct));
      el.split.style.setProperty("--split-src", pct + "%");
    });
    window.addEventListener("mouseup", () => {
      if (!dragging) return;
      dragging = false;
      document.body.classList.remove("resizing");
      el.splitter.classList.remove("drag");
      const val = parseFloat(el.split.style.getPropertyValue("--split-src")) || 33;
      state.patchSettings({ panels: { split_src: Math.round(val) } });
      status(`源码 : 预览 = ${Math.round(val)} : ${100 - Math.round(val)}`, "");
    });
    el.splitter.addEventListener("dblclick", () => {
      el.split.style.setProperty("--split-src", "33%");
      state.patchSettings({ panels: { split_src: 33 } });
    });

    // 底部面板高度
    let rdrag = false;
    let startY = 0;
    let startH = 0;
    el.panelResizer.addEventListener("mousedown", (e) => {
      rdrag = true;
      startY = e.clientY;
      startH = el.bottomPanel.getBoundingClientRect().height;
      document.body.classList.add("resizing-v");
      e.preventDefault();
    });
    window.addEventListener("mousemove", (e) => {
      if (!rdrag) return;
      const hgt = Math.max(64, Math.min(innerHeight * 0.7, startH + (startY - e.clientY)));
      document.documentElement.style.setProperty("--panel-h", hgt + "px");
    });
    window.addEventListener("mouseup", () => {
      if (!rdrag) return;
      rdrag = false;
      document.body.classList.remove("resizing-v");
      const hgt = parseInt(document.documentElement.style.getPropertyValue("--panel-h"), 10);
      if (hgt) state.patchSettings({ panels: { panel_h: hgt } });
    });

    // 侧栏 / AI 面板宽度（竖向把手）。夹取范围给的是"日常可用"边界：
    // 侧栏 180–440（再宽就抢编辑区），AI 260–640（对话列表太窄没法读）。
    // 松手才落盘 —— 拖动过程只改 CSS 变量，不打扰设置持久化。
    let wdrag = null; // "side" | "ai" | null
    const clampW = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
    el.sidebarGutter.addEventListener("mousedown", (e) => {
      wdrag = "side";
      document.body.classList.add("resizing");
      e.preventDefault();
    });
    el.aiGutter.addEventListener("mousedown", (e) => {
      wdrag = "ai";
      document.body.classList.add("resizing");
      e.preventDefault();
    });
    window.addEventListener("mousemove", (e) => {
      if (!wdrag) return;
      if (wdrag === "side") {
        const left = el.activitybar.getBoundingClientRect().right;
        const w = clampW(e.clientX - left, 180, 440);
        document.documentElement.style.setProperty("--sidebar-w", w + "px");
      } else {
        const right = el.bodyRow.getBoundingClientRect().right;
        const w = clampW(right - e.clientX, 260, 640);
        document.documentElement.style.setProperty("--ai-w", w + "px");
      }
    });
    window.addEventListener("mouseup", () => {
      if (!wdrag) return;
      const which = wdrag;
      wdrag = null;
      document.body.classList.remove("resizing");
      const root = document.documentElement.style;
      if (which === "side") {
        const w = parseInt(root.getPropertyValue("--sidebar-w"), 10);
        if (w) state.patchSettings({ panels: { sidebar_w: w } });
      } else {
        const w = parseInt(root.getPropertyValue("--ai-w"), 10);
        if (w) state.patchSettings({ panels: { ai_w: w } });
      }
    });
  }

  /* ------------------------------------------------------------------ 全局快捷键 */

  function onKey(e) {
    const k = e.key.toLowerCase();
    const mod = e.ctrlKey || e.metaKey;
    const typing = /^(INPUT|TEXTAREA)$/.test(e.target.tagName) || e.target.isContentEditable;

    // 面板 / 布局（Ctrl 组合始终生效）
    if (mod && e.shiftKey && k === "p") { e.preventDefault(); return DGM.palette.open(); }
    if (e.key === "F1") { e.preventDefault(); return DGM.palette.open(); }
    if (mod && e.shiftKey && k === "a") { e.preventDefault(); return togglePanel("ai"); }
    if (mod && k === "b") { e.preventDefault(); return togglePanel("sidebar"); }
    if (mod && k === "j") { e.preventDefault(); return togglePanel("bottom"); }
    if (mod && e.shiftKey && k === "f") { e.preventDefault(); return zenMode(); }
    // 标签循环切换（编辑器里聚焦时也要能切 —— 放在 typing 拦截之前）
    if (mod && k === "tab") { e.preventDefault(); return DGM.tabs.cycle(e.shiftKey ? -1 : 1); }
    if (mod && (k === "pageup" || k === "pagedown")) {
      e.preventDefault();
      return DGM.tabs.cycle(k === "pageup" ? -1 : 1);
    }
    // Ctrl+Shift+H：工作区搜索（VS Code 的 Find in Files 位；Ctrl+Shift+F 被全屏占了）
    if (mod && e.shiftKey && k === "h") { e.preventDefault(); return runCommand("file.searchWorkspace"); }
    if (mod && k === "i" && !e.shiftKey) { e.preventDefault(); return DGM.ai.focus("chat"); }
    if (mod && e.shiftKey && k === "i") { e.preventDefault(); return DGM.dialogs.vision(); }
    if (mod && k === "s" && !e.shiftKey) { e.preventDefault(); return saveActive(false); }
    if (mod && e.shiftKey && k === "s") { e.preventDefault(); return saveActive(true); }
    if (mod && k === "n") { e.preventDefault(); return DGM.dialogs.newDoc(); }
    if (mod && k === "o") { e.preventDefault(); return openFile(); }
    if (mod && k === "w") { e.preventDefault(); return closeActive(); }
    if (mod && k === "q") { e.preventDefault(); return quit(); }
    if (mod && k === "f") { e.preventDefault(); return DGM.editor.openSearch(); }
    if (mod && k === "0") { e.preventDefault(); return DGM.preview.fit(); }
    if (mod && (k === "=" || k === "+")) { e.preventDefault(); return DGM.preview.zoomIn(); }
    if (mod && k === "-") { e.preventDefault(); return DGM.preview.zoomOut(); }
    if (mod && ["1", "2", "3"].includes(k)) { e.preventDefault(); return setMode(["source", "split", "preview"][+k - 1]); }
    if (mod && k === "t") { e.preventDefault(); return toggleTheme(); }
    // Ctrl+R = 「打开最近文件」= 文件打开历史窗口（与菜单里那条命令同一个落点）。
    // AI 的会话历史在 AI 面板的「历史会话」按钮与 AI 菜单里，不占这个键。
    if (mod && k === "r" && !e.shiftKey) { e.preventDefault(); return DGM.dialogs.fileHistory(); }
    if (mod && e.shiftKey && k === "c") { e.preventDefault(); return DGM.preview.copyImage(); }
    // Alt+Shift+C：转换为（弹目标选择对话框；鼠标近入口在标签条与状态栏格式项）
    if (e.altKey && e.shiftKey && k === "c") { e.preventDefault(); return DGM.dialogs.convertTo(); }

    if (e.altKey && ["1", "2", "3", "4", "5"].includes(k)) {
      e.preventDefault();
      const a = ACTS[+k - 1];
      if (a) setSidebarView(a.id);
      return;
    }

    if (e.key === "Escape") {
      if (!$("#overlay-palette").hidden) return DGM.palette.close();
      if (!$("#overlay-dialog").hidden) return DGM.dialogs.close();
      if (!el.pop.hidden) return hidePop();
      if (el.menubar.dataset.open) return closeMenu();
    }
    if (typing) return;
  }

  /* ------------------------------------------------------------------ 绑定 */

  function bind() {
    // 标题栏
    $("#btn-theme").addEventListener("click", toggleTheme);
    $("#btn-cmd").addEventListener("click", () => DGM.palette.open());
    $("#btn-layout").addEventListener("click", (e) => {
      e.stopPropagation(); // 同 showPop 的约定（此锚点一直是死的，2026-10-13 修）
      popLayoutPicker(e.currentTarget);
    });
    $("#win-min").addEventListener("click", () => ipc.win.minimize());
    $("#win-max").addEventListener("click", () => ipc.win.toggleMaximize());
    // 关闭按钮：设置了"关闭到托盘"就不弹未保存确认（autosave 有草稿兜底），
    // 直接关窗口交给后端隐藏；否则走完整退出流程
    $("#win-close").addEventListener("click", () => {
      if (state.settings && state.settings.close_to_tray) return ipc.win.close();
      quit();
    });

    // 侧栏
    $("#side-close").addEventListener("click", () => togglePanel("sidebar"));
    $("#side-more").addEventListener("click", (e) => {
      // 锚点要 stopPropagation（showPop 的约定）：不停的话同一次点击里
      // 文档级"点外就关"会把刚弹出的菜单杀掉 —— 2026-10-13 探针实测它一直是死的。
      e.stopPropagation();
      const r = e.currentTarget.getBoundingClientRect();
      const p = state.panels();
      showPop(
        ACTS.map((a) => ({ label: t(a.label), icon: a.icon, kbd: a.kbd, on: p.sidebar_view === a.id, view: a.id, check: true }))
          .concat([{ sep: true }, { label: t("mi.sidebar"), icon: "close", kbd: "Ctrl+B", act: "hide" }]),
        { x: r.left, y: r.bottom + 4 },
        (it) => {
          hidePop();
          if (it.act === "hide") togglePanel("sidebar");
          else setSidebarView(it.view);
        },
      );
    });

    // 活动栏也**显示**云状态（账户钮的高亮、以及"未登录→弹窗"那一支），
    // 登录 / 登出要跟着刷新。少了这条，活动栏会一直停在登录前的样子。
    DGM.bus.on("cloud:changed", renderActivity);
    // 状态栏那颗 AI 模型钮也吃云状态（网关别名是登录后才有的，`currentModel()` 拿不到
    // 就显示「未配置」）。少了这条，启动时那一帧会把它钉在「未配置」上再也不变
    // （2026-10-15 用户报的"启动后得手点一下账户才变登录"里就有它）。
    DGM.bus.on("cloud:changed", renderStatus);

    // 全局点击 / 悬浮收起
    document.addEventListener("click", (e) => {
      const inPop = e.target.closest("#pop") || e.target.closest("#pop-sub");
      if (!inPop) hidePop();
      if (!e.target.closest("#menubar")) closeMenu();
    });
    // 指针离开菜单 → 排定宽限关闭（见 scheduleSubHide）；去向他处菜单家族则不动。
    document.addEventListener(
      "mouseleave",
      (e) => {
        if (e.target.id !== "pop" && e.target.id !== "pop-sub") return;
        const to = e.relatedTarget;
        if (to && ((to.id === "pop" || to.id === "pop-sub") || (to.closest && to.closest("#pop, #pop-sub")))) return;
        scheduleSubHide();
      },
      true,
    );
    // 进了任何菜单 → 取消在途的宽限
    el.pop.addEventListener("mouseenter", cancelSubHide);
    el.popSub.addEventListener("mouseenter", cancelSubHide);

    document.addEventListener("keydown", onKey);

    // 拖拽系统：源码/预览分隔条、底部面板高度、侧栏与 AI 面板宽度。
    // **曾因从未调用而整体失效**（定义在、调用不在，语法检查/自检都发现不了）——
    // ui_probe 的真实鼠标序列断言就是为这类"接线缺失"准备的。
    setupDrag();

    // 标签条 / 视图模式切换器（tabs.js）
    if (DGM.tabs && DGM.tabs.bind) DGM.tabs.bind();
  }

  /* ------------------------------------------------------------------ 注册命令 */

  function registerCommands() {
    cmd({ id: "ai.generate", group: "ai", icon: "sparkles", kbd: "Ctrl+I", run: () => DGM.ai.focus("chat") });
    cmd({ id: "ai.vision", group: "ai", icon: "scan", kbd: "Ctrl+Shift+I", run: () => DGM.dialogs.vision() });
    cmd({ id: "ai.review", group: "ai", icon: "wand", run: () => DGM.ai.focus("review") });
    cmd({ id: "ai.model", group: "ai", icon: "robot", kbd: "", run: (a) => DGM.ai.popModels(a || $("#ai-model")) });
    cmd({ id: "ai.apply", group: "ai", icon: "check", run: () => DGM.ai.applyLast() });
    cmd({ id: "ai.history", group: "ai", icon: "history", run: () => DGM.dialogs.history() });

    cmd({ id: "file.new", group: "file", icon: "plus", kbd: "Ctrl+N", run: () => DGM.dialogs.newDoc() });
    cmd({ id: "file.open", group: "file", icon: "folderOpen", kbd: "Ctrl+O", run: () => openFile() });
    cmd({ id: "file.save", group: "file", icon: "save", kbd: "Ctrl+S", run: () => saveActive(false), avail: () => (state.activeDoc() ? true : { why: t("status.noDoc") }) });
    cmd({ id: "file.saveAs", group: "file", icon: "save", kbd: "Ctrl+Shift+S", run: () => saveActive(true), avail: () => (state.activeDoc() ? true : { why: t("status.noDoc") }) });
    cmd({ id: "file.recent", group: "file", icon: "clock", kbd: "Ctrl+R", run: () => DGM.dialogs.fileHistory() });
    cmd({ id: "file.cloud", group: "file", icon: "cloud", run: () => setSidebarView("cloud") });
    cmd({
      id: "file.cloudSave", group: "file", icon: "cloud",
      run: () => DGM.cloud.saveDoc(),
      avail: () => (state.activeDoc() ? true : { why: t("status.noDoc") }),
    });
    cmd({ id: "view.account", group: "view", icon: "user", run: () => setSidebarView("account") });
    // 工作区（第 4 步）：树/搜索/外部跟随都要先有一个根目录
    cmd({ id: "file.openFolder", group: "file", icon: "folderOpen", run: () => DGM.sidebar && DGM.sidebar.openFolderFlow && DGM.sidebar.openFolderFlow() });
    cmd({
      id: "file.closeFolder", group: "file", icon: "close",
      run: () => state.closeWorkspace(),
      avail: () => (state.workspace.root ? true : { why: t("side.ws.none") }),
    });
    cmd({
      id: "file.searchWorkspace", group: "file", icon: "search", kbd: "Ctrl+Shift+H",
      run: () => {
        setSidebarView("search");
        if (DGM.sidebar && DGM.sidebar.focusSearch) DGM.sidebar.focusSearch();
      },
      avail: () => (state.workspace.root ? true : { why: t("side.search.needWorkspace") }),
    });
    cmd({
      id: "file.newFileHere", group: "file", icon: "plus",
      run: () => DGM.sidebar && DGM.sidebar.newFileFlow && DGM.sidebar.newFileFlow(),
      avail: () => (state.workspace.root ? true : { why: t("side.ws.none") }),
    });

    cmd({ id: "view.mode.source", group: "view", icon: "code", kbd: "Ctrl+1", run: () => setMode("source"), avail: () => (state.isTextDoc(state.activeDoc()) ? true : { why: t("status.canvasFormatSub") }) });
    cmd({ id: "view.mode.split", group: "view", icon: "splitV", kbd: "Ctrl+2", run: () => setMode("split"), avail: () => (state.isTextDoc(state.activeDoc()) ? true : { why: t("status.canvasFormatSub") }) });
    cmd({ id: "view.mode.preview", group: "view", icon: "eye", kbd: "Ctrl+3", run: () => setMode("preview"), avail: () => (state.activeDoc() ? true : { why: t("status.noDoc") }) });
    cmd({ id: "view.sidebar", group: "view", icon: "panelLeft", kbd: "Ctrl+B", run: () => togglePanel("sidebar") });
    cmd({ id: "view.ai", group: "view", icon: "panelRight", kbd: "Ctrl+Shift+A", run: () => togglePanel("ai") });
    cmd({ id: "view.panel", group: "view", icon: "panelBottom", kbd: "Ctrl+J", run: () => togglePanel("bottom") });
    cmd({ id: "view.activitybar", group: "view", icon: "layers", run: () => togglePanel("activitybar") });
    cmd({ id: "view.fullscreen", group: "view", icon: "maximize", kbd: "Ctrl+Shift+F", run: () => zenMode() });
    cmd({ id: "view.theme", group: "view", icon: "moon", kbd: "Ctrl+K Ctrl+T", run: () => toggleTheme() });
    // 「适应视图」= 按画布大小适应（与画布浮动工具条的适应按钮 / 双击画布 同一条路）。
    // 顶栏那颗按钮已按用户要求移除（与浮动工具里的那颗重复）；这条路仍是 View 菜单、
    // Ctrl+0 与命令面板的落点，别一起删。
    // 状态栏那个「点击回到 100%」是另一回事，仍走 resetZoom。
    cmd({ id: "view.zoom.fit", group: "view", icon: "fit", kbd: "Ctrl+0", run: () => DGM.preview.fit() });
    cmd({ id: "view.zoom.in", group: "view", icon: "zoomIn", kbd: "Ctrl+=", run: () => DGM.preview.zoomIn() });
    cmd({ id: "view.zoom.out", group: "view", icon: "zoomOut", kbd: "Ctrl+-", run: () => DGM.preview.zoomOut() });
    cmd({ id: "view.settings", group: "view", icon: "palette", run: () => DGM.dialogs.settings("appearance") });
    cmd({ id: "view.settings.ai", group: "view", icon: "sparkles", run: () => DGM.dialogs.settings("ai") });
    cmd({ id: "view.settings.cloud", group: "view", icon: "cloud", run: () => DGM.dialogs.settings("cloud") });

    const convTargets = () => {
      const d = state.activeDoc();
      return d ? state.docFmt(d).convert_to || [] : [];
    };
    ["drawio", "excalidraw", "dot", "d2"].forEach((to) => {
      cmd({
        id: "conv." + to, group: "convert", icon: "swap",
        label: () => t("palette.convert", { from: state.docFmt(state.activeDoc()).name, to: state.fmtById(to).name }),
        run: () => DGM.dialogs.convertTo(to),
        avail: () => (convTargets().includes(to) ? true : { why: t("dlg.convert.unsupportedDesc", { list: convTargets().map((x) => state.fmtById(x).name).join(" / ") || t("common.none") }) }),
      });
    });
    cmd({ id: "conv.center", group: "convert", icon: "swap", run: () => setSidebarView("convert") });
    cmd({ id: "fmt.format", group: "format", icon: "wand", kbd: "Shift+Alt+F", run: () => formatSource() });
    // 布局菜单按**注册表**开放（DOT 六种、D2 三种），不在前端写第二份格式清单
    cmd({ id: "fmt.layout", group: "format", icon: "diagram", run: (a) => DGM.dialogs.layout(), avail: () => (state.activeDoc() && (state.docFmt(state.activeDoc()).layouts || []).length ? true : { why: t("status.formatTip") }) });
    cmd({ id: "exp.png", group: "format", icon: "download", run: () => DGM.preview.exportPng() });
    cmd({ id: "exp.svg", group: "format", icon: "download", run: () => DGM.preview.exportSvg() });
    cmd({ id: "exp.copy", group: "format", icon: "copy", kbd: "Ctrl+Shift+C", run: () => DGM.preview.copyImage() });

    cmd({ id: "help.keys", group: "help", icon: "keyboard", kbd: "Ctrl+K Ctrl+S", run: () => DGM.dialogs.keys() });
    cmd({ id: "help.guide", group: "help", icon: "info", run: () => DGM.dialogs.guide() });
    cmd({ id: "help.about", group: "help", icon: "info", run: () => DGM.dialogs.about() });
    cmd({ id: "help.update", group: "help", icon: "refresh", run: () => checkUpdate() });
  }

  /* ------------------------------------------------------------------ 外部改动横幅 */

  /**
   * 外部改动与本地未保存撞上了：只在编辑区顶上挂一条，让用户二选一。
   *
   * 为什么不用 toast：这是个**需要决策**的状态，不是一条通知 —— toast 会自己消失，
   * 而这个选择不做，下一次保存就会把磁盘上的东西覆盖掉。
   */
  function renderFsBanner() {
    const box = $("#fs-banner");
    if (!box) return;
    const list = state.conflicts || [];
    if (!list.length) {
      box.hidden = true;
      box.innerHTML = "";
      box.onclick = null;
      return;
    }
    const c = list[0];
    box.hidden = false;
    box.innerHTML =
      `${icon("warn")}<span class="fb-txt"><b>${esc(t("fs.conflict.title", { name: c.name }))}</b><span>${esc(t("fs.conflict.desc"))}</span></span>` +
      `<span class="sp"></span>` +
      (list.length > 1 ? `<span class="fb-more">+${list.length - 1}</span>` : "") +
      `<button class="btn sm ghost" data-a="theirs">${esc(t("fs.conflict.theirs"))}</button>` +
      `<button class="btn sm" data-a="keep">${esc(t("fs.conflict.keep"))}</button>`;
    box.onclick = async (e) => {
      const b = e.target.closest("button");
      if (!b) return;
      try {
        if (b.dataset.a === "theirs") {
          await state.reloadDoc(c.docId);
        }
        state.resolveConflict(c.docId);
      } catch (err) {
        status(String((err && err.message) || err), "err");
      }
      renderFsBanner();
    };
  }

  /* ------------------------------------------------------------------ 更新器 */

  /** 后台自动检查发现的可用更新；非空时状态栏出现入口，点它打开更新窗口。 */
  let pendingUpdate = null;
  /** 当前打开的更新窗口控制器（null = 没开）。**更新流程唯一的界面**。 */
  let updateDlg = null;
  /** 下载进度 `{got, total}`（字节）。状态栏那一项与更新窗口都读它，不许各写一套。 */
  let updateProgress = null;
  /** idle | downloading | stalled | finished */
  let updateState = "idle";
  let updateBusy = false;
  let updateWatchdog = null;
  let updateLastEvent = 0;
  let updateLastPct = -1;
  let updateLastRender = 0;
  /**
   * 超过这么久没有新数据就认为卡住了。**插件本身没有下载超时**（config 里没有 timeout 字段），
   * 而且 `Started` 只在**第一个数据块到达后**才发 —— 连接卡在建立阶段时连 Started 都没有，
   * 不自己检测就是"永远静默地卡着"（2026-10-12 用户实测报的就是"点了没反应"）。
   */
  const UPDATE_STALL_MS = 20000;

  function updateMb(bytes) { return ((bytes || 0) / 1048576).toFixed(1); }

  /** 进度文案（状态栏那一项与更新窗口共用同一份文字）。 */
  function updateLabelText() {
    if (updateState === "stalled") return t("update.stalledLabel", { mb: updateMb(updateProgress && updateProgress.got) });
    if (updateState === "idle") return pendingUpdate ? t("update.available", { version: pendingUpdate.version }) : "";
    const got = updateProgress ? updateProgress.got : 0;
    const total = updateProgress ? updateProgress.total : 0;
    if (total > 0) return t("update.downloadingPct", { pct: Math.min(100, Math.floor((got / total) * 100)) });
    return t("update.downloadingMb", { mb: updateMb(got) });
  }

  function updatePct() {
    if (updateState === "finished") return 100;
    const total = updateProgress ? updateProgress.total : 0;
    if (!total) return null;
    return Math.min(100, Math.floor((updateProgress.got / total) * 100));
  }

  /** 状态栏那一项的提示语：它只负责"回到更新窗口"，动作本身不再分叉。 */
  function updateItemTip() {
    if (updateState === "downloading" || updateState === "finished") return t("update.busyTip");
    if (updateState === "stalled") return t("update.manualBtn");
    return t("update.statusTip");
  }

  /**
   * Progress 事件是**逐块**来的（52MB 可能上千次）：重渲染要限流。
   *
   * ⚠️ 限流**必须补最后一帧**（trailing edge）：只做 leading-edge 会把最终值丢掉 ——
   * 实测就是进度条停在 0% 而状态栏已经是 25%（写完测试才发现的）。
   */
  let updatePaintTimer = null;

  function paintUpdate() {
    updateLastRender = Date.now();
    const label = updateLabelText();
    const pct = updatePct();
    const hint = updateState === "stalled" ? t("update.stalledHint", { mb: updateMb(updateProgress && updateProgress.got) }) : null;
    if (updateDlg && updateDlg.isOpen()) updateDlg.setProgress({ text: label, pct, hint });
    renderStatus();
  }

  /** 只刷状态栏那一项，**不碰更新窗口** —— 窗口有自己的终态（正在重启 / 更新失败）要留住。 */
  function paintStatusItem() {
    updateLastRender = Date.now();
    renderStatus();
  }

  function syncUpdateUI(force) {
    if (force) {
      if (updatePaintTimer) { clearTimeout(updatePaintTimer); updatePaintTimer = null; }
      return paintUpdate();
    }
    if (Date.now() - updateLastRender >= 150) return paintUpdate();
    if (!updatePaintTimer) updatePaintTimer = setTimeout(() => { updatePaintTimer = null; paintUpdate(); }, 160);
  }

  function stopUpdateWatchdog() {
    if (updateWatchdog) { clearInterval(updateWatchdog); updateWatchdog = null; }
  }

  function startUpdateWatchdog() {
    stopUpdateWatchdog();
    updateLastEvent = Date.now();
    updateWatchdog = setInterval(() => {
      if (updateState !== "downloading") return;
      if (Date.now() - updateLastEvent < UPDATE_STALL_MS) return;
      updateState = "stalled";
      const mb = updateMb(updateProgress && updateProgress.got);
      DGM.note(`update:stalled got=${mb}MB total=${updateProgress ? updateProgress.total : "?"}`);
      if (updateDlg && updateDlg.isOpen()) updateDlg.stalled({ text: updateLabelText(), pct: updatePct(), hint: t("update.stalledHint", { mb }) });
      paintStatusItem();
    }, 5000);
  }

  /**
   * 检查更新。走 tauri-plugin-updater（更新源与公钥在 tauri.conf.json）。
   *
   * **手动**（帮助 → 检查更新）与**自动**（启动后后台一次）共用这一条路径：
   *   手动 = 三种结果都如实呈现（已最新 / 有新版 / 出错），绝不装作"已最新"；
   *          查到新版**直接打开更新窗口**（说明 + 下载按钮都在里面）。
   *   自动 = 安静：出错与"已最新"都不打扰（网络抖动不该在每次启动时弹错），
   *          只有真发现新版才把状态栏那一项点亮。
   */
  async function checkUpdate({ quiet = false } = {}) {
    const T = window.__TAURI__;
    const up = T && T.updater;
    if (!up || typeof up.check !== "function") {
      if (!quiet) toast({ icon: "info", title: t("mi.checkUpdate"), sub: t("update.unavailable"), warn: true });
      return;
    }
    if (!quiet) status(t("update.checking"), "");
    let update = null;
    try {
      update = await up.check();
    } catch (e) {
      // 自动检查失败保持安静；手动必须报出来 —— 那是发布方/网络的问题，不是"已最新"
      if (quiet) {
        console.warn("[update] 自动检查失败：", e);
        return;
      }
      status(t("update.failed"), "err");
      toast({ icon: "alert", title: t("update.failed"), sub: String((e && e.message) || e), warn: true });
      return;
    }
    if (!update) {
      pendingUpdate = null;
      renderStatus();
      if (!quiet) {
        status(t("update.upToDate"), "ok");
        toast({ icon: "check", title: t("update.upToDate"), sub: "" });
      }
      return;
    }
    pendingUpdate = update;
    status(t("update.available", { version: update.version }), "warn");
    if (quiet) renderStatus();
    else openUpdateDialog();
  }

  /**
   * 打开更新窗口 —— **更新流程唯一的入口**：菜单查到新版走它、点状态栏那一项也走它。
   * 下载进行中再点，就把窗口开回进度那一屏（用户关过窗口也能回来）。
   */
  function openUpdateDialog() {
    if (!pendingUpdate) return checkUpdate();
    if (updateDlg && updateDlg.isOpen()) return;
    const running = updateState !== "idle";
    updateDlg = DGM.dialogs.updateDialog({
      version: pendingUpdate.version,
      notes: pendingUpdate.body,
      startPhase: running ? "prog" : "ask",
      onInstall: () => beginUpdateDownload(),
      onManual: () => openUpdatePage(),
      // 关窗**不清状态**：下载继续，状态栏那一项仍在报进度，点它还能回来
      onClose: () => { updateDlg = null; },
    });
    if (running) syncUpdateUI(true);
  }

  /** 卡住时的逃生口：用系统浏览器直接下安装包（`rawJson` 里就有本平台的 url）。 */
  function openUpdatePage() {
    const rj = pendingUpdate && pendingUpdate.rawJson;
    const p = rj && rj.platforms && (rj.platforms["windows-x86_64"] || rj.platforms.windows);
    const url = (p && p.url) || "";
    DGM.note(`update:manual-open url=${url || "(rawJson 里没找到 url)"}`);
    if (!url) {
      toast({ icon: "alert", title: t("update.manualBtn"), sub: t("update.stalledTitle"), warn: true });
      return;
    }
    if (DGM.cloud && DGM.cloud.openExternal) DGM.cloud.openExternal(url);
    else toast({ icon: "info", title: t("update.manualBtn"), sub: url });
  }

  /**
   * 真的开始下载并安装。由**更新窗口**里的「下载并安装」调用（不再有独立的确认框：
   * 说明与按钮就在同一个窗口里，点完就地变成进度）。
   */
  async function beginUpdateDownload() {
    const update = pendingUpdate;
    if (!update || updateBusy) return;
    updateBusy = true;
    updateState = "downloading";
    updateProgress = { got: 0, total: 0 };
    updateLastPct = -1;
    // 进度只落在状态栏左边的**更新按钮**与更新窗口里（状态栏消息区不再重复一份 —— 2026-10-16 用户反馈）
    DGM.note(`update:install-start version=${update.version}`);
    startUpdateWatchdog();
    syncUpdateUI(true);

    try {
      await update.downloadAndInstall((ev) => {
        // 复位之后飘进来的迟到事件一律忽略（写过测试才发现：不加这句会在 null 上取属性）
        if (updateState === "idle") return;
        updateLastEvent = Date.now();
        if (updateState === "stalled") updateState = "downloading"; // 又动了，撤掉"卡住"
        if (ev.event === "Started") {
          updateProgress = { got: 0, total: (ev.data && ev.data.contentLength) || 0 };
          DGM.note(`update:started total=${updateProgress.total || "?"}`);
          syncUpdateUI(true);
          return;
        }
        if (ev.event === "Progress") {
          updateProgress.got += (ev.data && ev.data.chunkLength) || 0;
          const total = updateProgress.total;
          if (total > 0) {
            const pct = Math.floor((updateProgress.got / total) * 100);
            if (pct >= updateLastPct + 10) { updateLastPct = pct - (pct % 10); DGM.note(`update:progress ${pct}%`); }
          }
          syncUpdateUI(false);
          return;
        }
        if (ev.event === "Finished") {
          updateState = "finished";
          stopUpdateWatchdog();
          // Finished 之后不会再有 Progress，把 got 补到 total，否则进度停在上一个整块上
          if (updateProgress) updateProgress.got = updateProgress.total || updateProgress.got;
          DGM.note("update:finished");
          status(t("update.restarting"), "ok");
          if (updateDlg && updateDlg.isOpen()) updateDlg.finish();
          paintStatusItem();
        }
      });
      // 装完自动重启（tauri-plugin-process）。注意：Windows 上插件**启动安装器后自己就 exit(0)**
      // （updater.rs:979），真正把应用拉起来的是 NSIS 的 /R —— 这一段通常走不到，留给其它平台与兜底。
      const T = window.__TAURI__;
      const proc = T && T.process;
      if (proc && typeof proc.relaunch === "function") await proc.relaunch();
      else toast({ icon: "refresh", title: t("update.installed"), sub: t("update.restartManual") });
      // 能走到这儿说明**没有** exit(0)（非 Windows，或安装器没起来）⇒ 复位状态，
      // 别让界面永远卡在"下载中"、连重试都点不动。
      stopUpdateWatchdog();
      updateState = "idle";
      updateProgress = null;
      updateBusy = false;
      paintStatusItem(); // 窗口保持 finish() 写下的"正在重启"，别刷回"有新版本"
    } catch (e) {
      stopUpdateWatchdog();
      updateState = "idle";
      updateProgress = null;
      updateBusy = false;
      DGM.note("update:failed " + String((e && e.message) || e));
      status(t("update.failed"), "err");
      if (updateDlg && updateDlg.isOpen()) updateDlg.fail(String((e && e.message) || e));
      toast({ icon: "alert", title: t("update.failed"), sub: String((e && e.message) || e), warn: true });
      paintStatusItem(); // 同上：窗口留"更新失败"，状态栏回到"有新版本"（可重试）
    }
  }

  /* ------------------------------------------------------------------ 渲染编排 */

  /** 把当前文档的视图模式落到 #split 的 class 上（CSS 用 .mode-* 决定哪一面隐藏）。 */
  function applySplitMode() {
    const split = el.split;
    if (!split) return;
    const d = state.activeDoc();
    const mode = d ? state.mode(d) : "split";
    split.className = "split mode-" + (mode === "source" || mode === "preview" ? mode : "split");
  }

  function renderChrome() {
    applySplitMode();
    // 布局类/变量（no-sidebar、no-ai、宽度）必须在每次重渲染时刷新 ——
    // togglePanel 只写设置，真正把 body 类换掉的是这里。
    // 曾因从不调用，侧栏/AI 面板的关闭按钮"点了没反应"（又一处接线缺失）。
    applyLayoutVars();
    renderDocTitle();
    renderMenubar();
    renderActivity();
    renderStatus();
    renderFsBanner();
    if (DGM.sidebar) DGM.sidebar.render();
    if (DGM.tabs) {
      DGM.tabs.render();
      DGM.tabs.renderViewModes();
    }
    if (DGM.panels) DGM.panels.render();
  }

  function applyMockBadge() {
    const badge = el.mockBadge;
    if (!badge) return;
    if (ipc.isMock) {
      badge.hidden = false;
      badge.textContent = t("mock.badge");
      badge.title = t("mock.title");
      document.body.classList.remove("no-mock");
    } else {
      badge.hidden = true;
      document.body.classList.add("no-mock");
    }
  }

  DGM.shell = {
    render: renderChrome,
    renderDocTitle,
    renderMenubar,
    renderActivity,
    renderStatus,
    renderFsBanner,
    /** 启动后由 main.js 调一次：安静模式的检查更新（失败/已最新都不打扰）。 */
    autoCheckUpdate: () => checkUpdate({ quiet: true }),
    /** 手动检查（帮助菜单 / 命令面板）。 */
    checkUpdate,
    applyLayoutVars,
    applyMockBadge,
    bind,
    registerCommands,
    setMode,
    setTheme,
    toggleTheme,
    setSidebarView,
    togglePanel,
    /** 「转换为」下拉（标签条 #tab-convert 也用它）。锚点调用方自己 stopPropagation。 */
    popConvertMenu,
    zenMode,
    saveActive,
    openFile,
    openPath,
    closeActive,
    closeDocWithConfirm,
    formatSource,
    quit,
    // 供画布承载转发来的快捷键用（见 ui/js/canvas.js 的 forwardHotkey）：
    // 画布里的焦点在 iframe 内，键不落本站的 window，只能由承载页入队带回组合名，
    // 这里再翻回命令 id。
    runCommand,
    el,
  };
  DGM.registerCommands = registerCommands; // main.js 在模块齐全后调用
})();

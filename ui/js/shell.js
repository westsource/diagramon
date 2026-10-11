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
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  DGM.dom = { $, $$, h, esc };

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

  function buildMenus() {
    const panels = state.panels();
    const activeId = state.active;
    const recent = (state.settings && state.settings.recent) || [];
    const models = state.ai().models || [];
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
          { label: t("mi.cloudSave"), icon: "cloud", act: "tip:side.cloud.gwOff", disabled: true },
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
            children: models.length
              ? models.map((m) => ({ label: m.name, icon: "robot", act: "model:" + m.id, kbd: m.has_key ? "" : t("set.ai.keyMissing") }))
              : [{ label: t("ai.noModels.title"), icon: "alert", act: "cmd:view.settings.ai" }],
          },
          { label: t("mi.aiHistory"), icon: "history", act: "cmd:ai.history" },
          { sep: true },
          { label: t("mi.aiSettings"), icon: "settings", act: "cmd:view.settings.ai" },
        ],
      },
      {
        id: "account",
        label: t("menu.account"),
        items: [
          { label: t("side.cloud.notSignedIn"), disabled: true, icon: "user" },
          { label: t("side.cloud.gwOff"), disabled: true, icon: "cloud" },
          { sep: true },
          { label: t("mi.billing"), icon: "bolt", act: "cmd:view.settings.cloud" },
          { label: t("mi.cloudDocs"), icon: "cloud", act: "cmd:file.cloud" },
        ],
      },
      {
        id: "help",
        label: t("menu.help"),
        items: [
          { label: t("mi.shortcuts"), kbd: "Ctrl+K Ctrl+S", icon: "keyboard", act: "cmd:help.keys" },
          { label: t("mi.guide"), icon: "info", act: "cmd:help.guide" },
          { sep: true },
          { label: t("mi.mermaidDocs"), icon: "globe", act: "tip:tip.noExternal" },
          { label: t("mi.dotDocs"), icon: "globe", act: "tip:tip.noExternal" },
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
      const out = { label: it.label, icon: it.icon, kbd: it.kbd, disabled: it.disabled, children: it.children, act: it.act };
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
        const ai = state.ai();
        out.on = ai.default_model === it.act.slice(6);
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

  function activateDocById(id) {
    if (id === state.active) return;
    state.activateDoc(id).catch((e) => status(String(e && e.message), "err"));
  }

  async function setModel(id) {
    await state.patchSettings({ ai: { default_model: id } });
    const m = (state.ai().models || []).find((x) => x.id === id);
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
    const f = state.docFmt(d);
    const path = d.path || t("tab.noPath");
    box.innerHTML =
      `<span class="dot" style="background:var(--fmt-${d.format})"></span>` +
      `<b>${esc(d.name)}${d.dirty ? " ·" : ""}</b>` +
      `<span class="path">${esc(path)}</span>`;
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
        if (p.sidebar_view === a.id) togglePanel("sidebar");
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
    parts.push(`<span class="st-spacer"></span>`);
    parts.push(`<span class="st ${ui.status.kind === "err" ? "err" : ui.status.kind === "warn" ? "warn" : ui.status.kind === "ok" ? "accent" : ""}" id="status-msg">${esc(statusText)}</span>`);
    parts.push(`<span class="st-spacer"></span>`);
    if (d && d.format === "dot") {
      parts.push(`<button class="st" data-a="layout" title="${esc(t("status.layoutTip"))}">${icon("diagram", "ico-sm")}${esc(t("status.layout", { name: d.layout || "dot" }))}</button>`);
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
    parts.push(`<span class="st accent" title="${esc(t("status.formatTip"))}">${esc(d ? state.docFmt(d).name : t("status.noDoc"))}</span>`);

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
      else if (a === "zoom") DGM.preview.resetZoom();
      else if (a === "layout") popLayouts(b);
    };
  }

  /* ------------------------------------------------------------------ pop 面板 */

  function popLayouts(anchor) {
    const d = state.activeDoc();
    if (!d) return;
    const layouts = state.docFmt(d).layouts || [];
    const r = anchor.getBoundingClientRect();
    showPop(
      [{ label2: t("layout.dotEngine") }].concat(
        layouts.map((l) => ({ label: l, icon: "diagram", on: (d.layout || "dot") === l, lay: l })),
        [{ sep: true }, { label: t("layout.dotMore"), icon: "info", act: "more" }],
      ),
      { x: r.left - 120, y: r.top - 6, flip: r.height + 8 },
      (it) => {
        hidePop();
        if (it.act === "more") return DGM.dialogs.layout();
        state.setLayout(d.id, it.lay);
        status(t("layout.switched", { name: it.lay }), "ok");
        state.pushOutput("DOT 布局切换 → " + it.lay + "（增量更新，未重载 WASM）", "ok");
      },
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
    state.patchSettings({
      panels: { activitybar: true, sidebar: true, ai: true, bottom: true, sidebar_view: "explorer" },
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
      const picked = await ipc.dialog.pickSavePath({ defaultPath: suggestedName(d) });
      if (picked) path = picked;
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
      filters: [{ name: "Diagram", extensions: ["mmd", "mermaid", "dot", "gv", "drawio", "excalidraw"] }],
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
    ipc.win.close();
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
    if (mod && k === "0") { e.preventDefault(); return DGM.preview.resetZoom(); }
    if (mod && (k === "=" || k === "+")) { e.preventDefault(); return DGM.preview.zoomIn(); }
    if (mod && k === "-") { e.preventDefault(); return DGM.preview.zoomOut(); }
    if (mod && ["1", "2", "3"].includes(k)) { e.preventDefault(); return setMode(["source", "split", "preview"][+k - 1]); }
    if (mod && k === "t") { e.preventDefault(); return toggleTheme(); }
    if (mod && k === "r" && !e.shiftKey) { e.preventDefault(); return DGM.dialogs.history(); }
    if (mod && e.shiftKey && k === "c") { e.preventDefault(); return DGM.preview.copyImage(); }

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
    $("#btn-layout").addEventListener("click", (e) => popLayoutPicker(e.currentTarget));
    $("#win-min").addEventListener("click", () => ipc.win.minimize());
    $("#win-max").addEventListener("click", () => ipc.win.toggleMaximize());
    $("#win-close").addEventListener("click", () => quit());

    // 侧栏
    $("#side-close").addEventListener("click", () => togglePanel("sidebar"));
    $("#side-more").addEventListener("click", (e) => {
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
    cmd({ id: "file.recent", group: "file", icon: "clock", kbd: "Ctrl+R", run: () => DGM.dialogs.history() });
    cmd({ id: "file.cloud", group: "file", icon: "cloud", run: () => setSidebarView("cloud") });
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
    cmd({ id: "view.zoom.fit", group: "view", icon: "fit", kbd: "Ctrl+0", run: () => DGM.preview.resetZoom() });
    cmd({ id: "view.zoom.in", group: "view", icon: "zoomIn", kbd: "Ctrl+=", run: () => DGM.preview.zoomIn() });
    cmd({ id: "view.zoom.out", group: "view", icon: "zoomOut", kbd: "Ctrl+-", run: () => DGM.preview.zoomOut() });
    cmd({ id: "view.settings", group: "view", icon: "palette", run: () => DGM.dialogs.settings("appearance") });
    cmd({ id: "view.settings.ai", group: "view", icon: "sparkles", run: () => DGM.dialogs.settings("ai") });
    cmd({ id: "view.settings.cloud", group: "view", icon: "cloud", run: () => DGM.dialogs.settings("cloud") });

    const convTargets = () => {
      const d = state.activeDoc();
      return d ? state.docFmt(d).convert_to || [] : [];
    };
    ["drawio", "excalidraw", "dot"].forEach((to) => {
      cmd({
        id: "conv." + to, group: "convert", icon: "swap",
        label: () => t("palette.convert", { from: state.docFmt(state.activeDoc()).name, to: state.fmtById(to).name }),
        run: () => DGM.dialogs.convertTo(to),
        avail: () => (convTargets().includes(to) ? true : { why: t("dlg.convert.unsupportedDesc", { list: convTargets().map((x) => state.fmtById(x).name).join(" / ") || t("common.none") }) }),
      });
    });
    cmd({ id: "conv.center", group: "convert", icon: "swap", run: () => setSidebarView("convert") });
    cmd({ id: "fmt.format", group: "format", icon: "wand", kbd: "Shift+Alt+F", run: () => formatSource() });
    cmd({ id: "fmt.layout", group: "format", icon: "diagram", run: (a) => DGM.dialogs.layout(), avail: () => (state.activeDoc() && state.activeDoc().format === "dot" ? true : { why: t("status.formatTip") }) });
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

  /* ------------------------------------------------------------------ 更新器（第 7 步） */

  /**
   * 检查更新。走 tauri-plugin-updater（更新源与公钥在 tauri.conf.json）。
   *
   * 三种结果都如实呈现：已是最新 / 有新版（确认后下载并重启）/ 出错。
   * 公钥没配或更新源不可达时 updater 会抛错 —— 那是发布方的问题，不要装作"已最新"。
   */
  async function checkUpdate() {
    const T = window.__TAURI__;
    const up = T && T.updater;
    if (!up || typeof up.check !== "function") {
      toast({ icon: "info", title: t("mi.checkUpdate"), sub: t("update.unavailable"), warn: true });
      return;
    }
    status(t("update.checking"), "");
    try {
      const update = await up.check();
      if (!update) {
        status(t("update.upToDate"), "ok");
        toast({ icon: "check", title: t("update.upToDate"), sub: "" });
        return;
      }
      const yes = await DGM.dialogs.confirm({
        title: t("update.available", { version: update.version }),
        body: esc((update.body || "").slice(0, 600)),
        ok: t("update.install"),
      });
      if (!yes) return;
      status(t("update.downloading"), "");
      await update.downloadAndInstall((ev) => {
        if (ev.event === "Started") status(t("update.downloading"), "");
        else if (ev.event === "Finished") status(t("update.restarting"), "ok");
      });
      // 装完自动重启（tauri-plugin-process）；杀不掉就提示用户手动开
      const proc = T.process;
      if (proc && typeof proc.relaunch === "function") await proc.relaunch();
      else toast({ icon: "refresh", title: t("update.installed"), sub: t("update.restartManual") });
    } catch (e) {
      status(t("update.failed"), "err");
      toast({ icon: "alert", title: t("update.failed"), sub: String((e && e.message) || e), warn: true });
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
    applyLayoutVars,
    applyMockBadge,
    bind,
    registerCommands,
    setMode,
    setTheme,
    toggleTheme,
    setSidebarView,
    togglePanel,
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

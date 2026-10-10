/* ============================================================================
 * Diagramon dev3.0 —— UI 原型交互脚本
 * 纯 DOM，无框架、无构建链、无外部依赖（与 client2/ui 的技术取向一致）
 *
 * 结构：
 *   1  状态            5  预览画布
 *   2  主题            6  AI 面板
 *   3  标题栏/菜单     7  底部面板 / 状态栏
 *   4  侧栏视图        8  命令面板 / 对话框 / 弹层 / toast
 *   9  快捷键与拖拽
 * ========================================================================== */
(function () {
  "use strict";

  const $ = (s, r) => (r || document).querySelector(s);
  const $$ = (s, r) => Array.from((r || document).querySelectorAll(s));
  const el = (tag, cls, html) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (html != null) n.innerHTML = html;
    return n;
  };
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const I = (name, cls) => `<svg class="ico ${cls || ""}" aria-hidden="true"><use href="#i-${name}"></use></svg>`;

  /* ---- 1. 状态 -------------------------------------------------------- */
  const S = {
    theme: "light",
    docId: "d1",
    sidebarView: "explorer", // explorer | search | cloud | convert | outline
    mode: "split",           // source | split | preview
    zoom: 100,
    aiTab: "chat",
    aiModel: "auto",
    panelTab: "problems",
    panelOpen: true,
    aiOpen: true,
    sidebarOpen: true,
    activityOpen: true,
    docTitleEditing: false,
    // AI 会话（深拷贝一份，可被交互修改）
    streams: JSON.parse(JSON.stringify(AI_STREAMS)),
    attachment: null,
    applied: { d1: true },
  };

  /** 可选强调色（设置 → 外观）：只换 --accent 一族，语义色与格式标识色不动。 */
  const ACCENTS = [["松绿", "pine"], ["黛蓝", "indigo"], ["藕紫", "lotus"], ["赭石", "ochre"], ["石墨", "graphite"]];

  const doc = () => DOCS.find((d) => d.id === S.docId);
  const fmt = () => FORMATS[doc().format];
  const isText = () => fmt().surface === "text";

  /* ---- 2. 主题 -------------------------------------------------------- */
  function setTheme(t) {
    S.theme = t;
    document.documentElement.dataset.theme = t;
    $("#btn-theme").innerHTML = I(t === "light" ? "moon" : "sun");
    $("#btn-theme").title = t === "light" ? "切换到暗色主题  Ctrl+K Ctrl+T" : "切换到亮色主题  Ctrl+K Ctrl+T";
    try { localStorage.setItem("dgm-proto-theme", t); } catch (e) {}
  }
  function toggleTheme() {
    setTheme(S.theme === "light" ? "dark" : "light");
    toast({ icon: S.theme === "dark" ? "moon" : "sun", title: S.theme === "dark" ? "暗色主题" : "亮色主题", sub: "所有颜色走 CSS 变量，一处切换全量生效" });
  }
  try {
    const saved = localStorage.getItem("dgm-proto-theme");
    if (saved) S.theme = saved;
    else if (window.matchMedia && matchMedia("(prefers-color-scheme: dark)").matches) S.theme = "dark";
  } catch (e) {}

  /* ---- 3. 标题栏与菜单 ------------------------------------------------ */
  function renderMenubar() {
    const bar = $("#menubar");
    bar.innerHTML = "";
    MENUS.forEach((m) => {
      const b = el("button", "tb-item", m.label);
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
    });
  }

  /** 把菜单项转成 pop 的 items；check/radio 的勾选态在渲染时实时求值。 */
  function menuItems(items) {
    return items.map((it) => {
      if (it.sep) return { sep: true };
      const out = { label: it.label, icon: it.icon, kbd: it.kbd, disabled: it.disabled, children: it.children, act: it.act };
      if (it.check) {
        const which = { "cmd:view.sidebar": S.sidebarOpen, "cmd:view.ai": S.aiOpen, "cmd:view.panel": S.panelOpen, "cmd:view.activitybar": S.activityOpen }[it.act];
        out.check = true;
        out.on = !!which;
      }
      if (it.radio === "mode") {
        out.check = true;
        out.on = isText() && S.mode === it.act.split(":")[1];
        out.disabled = !isText();
      }
      if (String(it.act || "").startsWith("model:")) {
        out.check = true;
        out.on = S.aiModel === it.act.slice(6);
      }
      return out;
    });
  }

  function openMenu(menu, anchor) {
    const bar = $("#menubar");
    bar.dataset.open = menu.id;
    $$(".tb-item", bar).forEach((b) => b.classList.toggle("open", b.dataset.menu === menu.id));
    const r = anchor.getBoundingClientRect();
    hideSub();
    showPop(menuItems(menu.items), { x: r.left, y: r.bottom + 4 }, pickMenu, "menu");
  }

  /** 菜单项被点/被 hover：有 children 就展开二级，否则关闭全部并执行。 */
  function pickMenu(it, row, hover) {
    if (it.children) {
      if (!row) return;
      const r = row.getBoundingClientRect();
      row.classList.add("has-sub");
      $$("#pop .pop-row").forEach((b) => { if (b !== row) b.classList.remove("has-sub"); });
      showPop(menuItems(it.children), { x: r.right + 2, y: r.top - 5 }, (sub) => {
        closeMenu();
        runAct(sub.act, sub);
      }, "submenu", "#pop-sub");
      return;
    }
    if (hover) return;
    closeMenu();
    runAct(it.act, it);
  }

  function hideSub() { const p = $("#pop-sub"); p.hidden = true; p.innerHTML = ""; }

  function closeMenu() {
    $("#menubar").dataset.open = "";
    $$(".tb-item").forEach((b) => b.classList.remove("open"));
    hidePop();
    hideSub();
  }

  /** 统一的 act 分发：菜单、命令面板、弹层都走这里。 */
  function runAct(act, it) {
    if (!act || act === "todo") return toast({ icon: "info", title: it ? it.label : "该操作", sub: "原型未接线：真实实现里由 Tauri 命令承接" });
    if (act.startsWith("tip:")) return toast({ icon: "info", title: it ? it.label : "提示", sub: act.slice(4) });
    if (act.startsWith("new:")) return newDoc(act.slice(4));
    if (act.startsWith("open:")) return activate(act.slice(5));
    if (act.startsWith("conv:")) return pickConvert(act.slice(5));
    if (act.startsWith("model:")) {
      S.aiModel = act.slice(6);
      renderAI(); renderStatus();
      const m = AI_MODELS.find((x) => x.id === S.aiModel);
      return toast({ icon: "robot", title: "已切换到 " + m.name, sub: m.sub, ai: true });
    }
    if (act.startsWith("mode:")) return setMode(act.slice(5));
    if (act === "doc:close") return doc() ? closeDoc(S.docId) : null;
    if (act === "app:quit") return toast({ icon: "close", title: "退出 Diagramon", sub: "会逐个确认未保存的标签页（原型不真退）" });
    if (act.startsWith("cmd:")) return runCommand(act.slice(4));
    return toast({ icon: "info", title: it ? it.label : act, sub: "原型未接线" });
  }

  function renderDocTitle() {
    const d = doc();
    if (!d) {
      $("#doc-title").innerHTML = `<span class="dot"></span><b>Diagramon</b><span class="path">没有打开的文档</span>`;
      return;
    }
    const f = FORMATS[d.format];
    $("#doc-title").innerHTML =
      `<span class="dot" data-fmt="${d.format}"></span>` +
      `<b>${esc(d.name)}${d.dirty ? " ·" : ""}</b>` +
      `<span class="path">${esc(d.path)}</span>`;
    const dot = $("#doc-title .dot");
    dot.style.background = f.color;
  }

  /* ---- 4. 活动栏与侧栏 ------------------------------------------------ */
  const ACTS = [
    { id: "explorer", icon: "explorer", label: "资源管理器", kbd: "Alt+1" },
    { id: "search", icon: "search", label: "全局搜索", kbd: "Alt+2" },
    { id: "convert", icon: "swap", label: "转换中心", kbd: "Alt+3" },
    { id: "cloud", icon: "cloud", label: "云端文档", kbd: "Alt+4" },
    { id: "outline", icon: "outline", label: "当前图大纲", kbd: "Alt+5" },
  ];
  const ACT_TITLES = { explorer: "资源管理器", search: "搜索", convert: "转换中心", cloud: "云端", outline: "大纲" };

  function renderActivity() {
    const bar = $("#activitybar");
    bar.innerHTML = "";
    ACTS.forEach((a, i) => {
      const b = el("button", "act" + (S.sidebarView === a.id && S.sidebarOpen ? " on" : ""));
      b.innerHTML = I(a.icon);
      b.title = `${a.label}  ${a.kbd}`;
      b.addEventListener("click", () => {
        if (S.sidebarView === a.id) toggleSidebar();
        else { S.sidebarView = a.id; S.sidebarOpen = true; syncLayout(); }
      });
      bar.appendChild(b);
    });
    bar.appendChild(el("div", "act-sep"));
    const ai = el("button", "act is-ai" + (S.aiOpen ? " on" : ""));
    ai.innerHTML = I("sparkles") + `<span class="badge">2</span>`;
    ai.title = "AI 面板（第一公民）  Ctrl+Shift+A";
    ai.addEventListener("click", () => toggleAI());
    bar.appendChild(ai);

    bar.appendChild(el("div", "act-spacer"));
    const keys = el("button", "act");
    keys.innerHTML = I("keyboard");
    keys.title = "键盘快捷键总表  Ctrl+K Ctrl+S";
    keys.addEventListener("click", () => dialogKeys());
    bar.appendChild(keys);
    const st = el("button", "act");
    st.innerHTML = I("settings");
    st.title = "设置";
    st.addEventListener("click", () => dialogSettings());
    bar.appendChild(st);
  }

  function renderSidebar() {
    $("#side-title").textContent = ACT_TITLES[S.sidebarView] || "";
    const v = $("#side-view");
    v.innerHTML = "";
    if (S.sidebarView === "explorer") v.appendChild(viewExplorer());
    else if (S.sidebarView === "search") v.appendChild(viewSearch());
    else if (S.sidebarView === "convert") v.appendChild(viewConvert());
    else if (S.sidebarView === "cloud") v.appendChild(viewCloud());
    else if (S.sidebarView === "outline") v.appendChild(viewOutline());
  }

  /* 资源管理器：工作区树 */
  function viewExplorer() {
    const wrap = el("div", "side-section");
    const h = el("h4", "", `${I("chevD", "ico-sm chev")}打开的编辑器`);
    const list = el("div", "side-list");
    DOCS.forEach((d) => list.appendChild(docRow(d, d.id === S.docId)));
    h.addEventListener("click", () => wrap.classList.toggle("collapsed"));
    wrap.append(h, list);

    const wrap2 = el("div", "side-section");
    const h2 = el("h4", "", `${I("chevD", "ico-sm chev")}${esc(WORKSPACE.root)}`);
    const tree = el("div", "side-list");
    WORKSPACE.nodes.forEach((n) => tree.appendChild(treeNode(n, 0)));
    h2.addEventListener("click", () => wrap2.classList.toggle("collapsed"));
    wrap2.append(h2, tree);

    const rec = el("div", "side-section");
    const h3 = el("h4", "", `${I("chevD", "ico-sm chev")}最近打开`);
    const rl = el("div", "side-list");
    RECENT.slice(0, 6).forEach((r) => {
      const d = r.doc ? DOCS.find((x) => x.id === r.doc) : null;
      const name = d ? d.name : r.name;
      const format = d ? d.format : r.format;
      const row = el("button", "tree-row");
      row.innerHTML = `<span class="fmt-dot" data-fmt="${format}"></span><span class="nm">${esc(name)}</span><span class="meta">${esc(r.when)}</span>`;
      $(".fmt-dot", row).style.background = FORMATS[format].color;
      row.addEventListener("click", () => {
        if (d) activate(d.id);
        else toast({ icon: "clock", title: name, sub: "原型未接线：真实实现会直接打开该文件" });
      });
      rl.appendChild(row);
    });
    h3.addEventListener("click", () => rec.classList.toggle("collapsed"));
    rec.append(h3, rl);

    const box = el("div");
    box.append(wrap, wrap2, rec);
    return box;
  }

  function docRow(d, on) {
    const f = FORMATS[d.format];
    const row = el("button", "tree-row" + (on ? " on" : ""));
    row.innerHTML =
      `<span class="fmt-dot"></span><span class="nm">${esc(d.name)}</span>` +
      (d.dirty ? `<span class="meta" title="未保存">·</span>` : "") +
      `<button class="x-row" title="关闭">${I("close", "ico-sm")}</button>`;
    $(".fmt-dot", row).style.background = f.color;
    row.addEventListener("click", (e) => {
      if (e.target.closest(".x-row")) return closeDoc(d.id);
      activate(d.id);
    });
    return row;
  }

  function treeNode(n, depth) {
    if (n.kind === "dir") {
      const wrap = el("div", "side-node");
      const row = el("button", "tree-row" + (depth ? " indent-" + Math.min(depth, 1) : ""));
      row.innerHTML = `${I("chevD", "ico-sm chev")}${I(n.open ? "folderOpen" : "folder", "ico-sm")}<span class="nm">${esc(n.name)}</span>`;
      const kids = el("div");
      row.addEventListener("click", () => {
        n.open = !n.open;
        row.querySelector(".chev").style.transform = n.open ? "" : "rotate(-90deg)";
        row.querySelector("use").setAttribute("href", n.open ? "#i-folderOpen" : "#i-folder");
        kids.hidden = !n.open;
      });
      n.children.forEach((c) => kids.appendChild(treeNode(c, depth + 1)));
      kids.hidden = !n.open;
      wrap.append(row, kids);
      return wrap;
    }
    const d = n.doc ? DOCS.find((x) => x.id === n.doc) : null;
    const name = d ? d.name : n.name;
    const format = d ? d.format : n.format;
    const row = el("button", "tree-row indent-1" + (d && d.id === S.docId ? " on" : ""));
    row.innerHTML = `<span class="fmt-dot"></span><span class="nm">${esc(name)}</span>`;
    const dot = $(".fmt-dot", row);
    dot.style.background = format ? FORMATS[format].color : "var(--faint)";
    row.addEventListener("click", () => {
      if (d) activate(d.id);
      else toast({ icon: "file", title: name, sub: "原型只接了 4 个示例文档" });
    });
    return row;
  }

  /* 搜索 */
  function viewSearch() {
    const box = el("div");
    const f = el("div", "field");
    f.innerHTML = `<input type="text" placeholder="在工作区中搜索…" value="验证码"><span class="hint">支持正则 · 匹配源码文本，不匹配渲染结果</span>`;
    box.appendChild(f);
    const hits = [
      { doc: "登录流程.mmd", lines: [[9, "    F --> G[请求图形<mark>验证码</mark>]"], [11, "    H -- 否 --> I[刷新<mark>验证码</mark>]"], [24, "    G[请求图形<mark>验证码</mark> · 风控分支]"]] },
      { doc: "支付回调.mmd", lines: [[3, "    A --> B{签名与<mark>验证码</mark>校验}"]] },
    ];
    hits.forEach((h) => {
      const sec = el("div", "side-section");
      const head = el("h4", "", `${I("chevD", "ico-sm chev")}${I("file", "ico-sm")}<span class="nm">${esc(h.doc)}</span><span class="meta">${h.lines.length}</span>`);
      const list = el("div", "side-list");
      h.lines.forEach((ln) => {
        const row = el("button", "tree-row indent-1");
        row.innerHTML = `<span class="meta" data-ln="${ln[0]}">${ln[0]}</span><span class="nm hit">${ln[1]}</span>`;
        row.addEventListener("click", () => {
          const d = DOCS.find((x) => x.name === h.doc);
          if (d) { activate(d.id); gotoLine(ln[0]); }
          else toast({ icon: "search", title: "跳到 " + h.doc + ":" + ln[0], sub: "原型只接了 4 个示例文档" });
        });
        list.appendChild(row);
      });
      head.addEventListener("click", () => sec.classList.toggle("collapsed"));
      sec.append(head, list);
      box.appendChild(sec);
    });
    const tip = el("div", "side-tip");
    tip.innerHTML = `${I("info", "ico-sm")}<span>共 4 个结果，分布在 2 个文件。点击结果会打开文档并定位到该行。</span>`;
    box.appendChild(tip);
    return box;
  }

  /* 转换中心：矩阵 + 逐条转换卡 */
  function viewConvert() {
    const box = el("div");
    const head = el("div", "conv-head");
    head.innerHTML = `<span>从当前文档出发</span><span class="chip ${fmt().id}">${esc(fmt().name)}</span>`;
    box.appendChild(head);

    const fromHere = CONVERSIONS.filter((c) => c.from === doc().format);
    if (fromHere.length) {
      fromHere.forEach((c) => box.appendChild(convCard(c)));
    } else {
      const none = el("div", "side-tip");
      none.innerHTML = `${I("info", "ico-sm")}<span>${esc(fmt().name)} 目前只能作为转换的<b>目标</b>：它是画布型格式，语义要从几何反推，计划 v3.1。</span>`;
      box.appendChild(none);
    }

    const all = el("div", "side-section");
    const h = el("h4", "", `${I("chevD", "ico-sm chev")}全部转换能力`);
    const list = el("div", "side-list");
    const SHORT = { mermaid: "Mmd", dot: "DOT", drawio: "Drw", excalidraw: "Exc" };
    const tbl = el("div", "conv-matrix");
    tbl.innerHTML =
      `<div class="mx-row mx-head"><span class="mx-src" title="源 ↓ / 目标 →"></span>${["drawio", "excalidraw", "dot", "mermaid"].map((d) => `<span title="${esc(FORMATS[d].name)}">${SHORT[d]}</span>`).join("")}</div>` +
      ["mermaid", "dot", "drawio", "excalidraw"].map((src) => {
        const cells = ["drawio", "excalidraw", "dot", "mermaid"].map((dst) => {
          if (src === dst) return `<span class="mx-c self">—</span>`;
          const c = CONVERSIONS.find((x) => x.from === src && x.to === dst);
          if (!c) return `<span class="mx-c no" title="未规划">·</span>`;
          return `<span class="mx-c ${c.ok ? "yes" : "plan"}" title="${esc(FORMATS[src].name)} → ${esc(FORMATS[dst].name)}：${esc(c.how)}">${c.ok ? "✓" : "…"}</span>`;
        }).join("");
        return `<div class="mx-row"><span class="mx-src" title="${esc(FORMATS[src].name)}">${SHORT[src]}</span>${cells}</div>`;
      }).join("");
    list.appendChild(tbl);
    CONVERSIONS.forEach((c) => {
      if (c.from === doc().format) return;
      list.appendChild(convCard(c, true));
    });
    h.addEventListener("click", () => all.classList.toggle("collapsed"));
    all.append(h, list);
    box.appendChild(all);

    const note = el("div", "side-tip");
    note.innerHTML = `${I("info", "ico-sm")}<span>所有转换都是<b>单向</b>的：结果另开新标签页，原文件保持不动，画布上的后续改动不回写源码。</span>`;
    box.appendChild(note);
    return box;
  }

  function convCard(c, muted) {
    const src = FORMATS[c.from], dst = FORMATS[c.to];
    const b = el("button", "conv-card");
    if (!c.ok) b.disabled = true;
    b.innerHTML =
      `<span class="conv-flow"><span class="chip ${src.id}">${esc(src.name)}</span><span class="arrow">${I("chevR", "ico-sm")}</span><span class="chip ${dst.id}">${esc(dst.name)}</span><span class="conv-tag ${c.ok ? "ok" : "off"}">${esc(c.tag)}</span></span>` +
      `<span class="conv-note">${esc(c.how)}</span>`;
    b.addEventListener("click", () => dialogConvert(c));
    if (muted) b.classList.add("is-other");
    return b;
  }

  /* 云端 */
  function viewCloud() {
    const box = el("div");
    const me = el("div", "cloud-me");
    me.innerHTML =
      `<span class="avatar">道</span><span class="who"><b>道荣</b><small>westsource@126.com · Pro 会员</small></span>`;
    box.appendChild(me);
    const quota = el("div", "quota");
    const pct = Math.round((USAGE.used / USAGE.total) * 100);
    quota.innerHTML =
      `<div class="quota-head"><span>本周期信用点</span><span class="num">${USAGE.used} / ${USAGE.total}</span></div>` +
      `<div class="meter"><span data-pct="${pct}"></span></div>` +
      `<div class="quota-note">已用 ${pct}% · 周期 ${esc(USAGE.period)} · 在途预留 ${USAGE.reserved}</div>`;
    $(".meter span", quota).style.width = pct + "%";
    box.appendChild(quota);

    const sec = el("div", "side-section");
    const h = el("h4", "", `${I("chevD", "ico-sm chev")}${I("cloud", "ico-sm")}云文档`);
    const list = el("div", "side-list");
    [
      { name: "登录流程.mmd", when: "2 分钟前", sync: "本地更新未上传" },
      { name: "服务拓扑.drawio", when: "昨天", sync: "已同步" },
      { name: "支付回调.mmd", when: "3 天前", sync: "已同步" },
      { name: "组织架构图.excalidraw", when: "上周", sync: "云端较新" },
    ].forEach((f) => {
      const row = el("button", "tree-row");
      const format = f.name.split(".").pop();
      row.innerHTML = `<span class="fmt-dot"></span><span class="nm">${esc(f.name)}</span><span class="meta">${esc(f.when)}</span>`;
      $(".fmt-dot", row).style.background = FORMATS[format] ? FORMATS[format].color : "var(--faint)";
      row.title = f.sync;
      row.addEventListener("click", () => toast({ icon: "cloud", title: f.name, sub: "云端状态：" + f.sync + "（原型未接线）" }));
      list.appendChild(row);
    });
    h.addEventListener("click", () => sec.classList.toggle("collapsed"));
    sec.append(h, list);
    box.appendChild(sec);

    const acts = el("div", "side-acts");
    acts.innerHTML = `<button class="btn sm" data-a="up">${I("cloud")}保存到云端</button><button class="btn sm" data-a="down">${I("download")}拉取云端版本</button>`;
    acts.addEventListener("click", (e) => {
      const b = e.target.closest("button");
      if (!b) return;
      toast({ icon: "cloud", title: b.dataset.a === "up" ? "已保存到云端" : "已拉取云端版本", sub: "带 If-Match 乐观锁；冲突时提示 version_conflict 并让你选保留哪一份" });
    });
    box.appendChild(acts);
    return box;
  }

  /* 大纲 */
  function viewOutline() {
    const d = doc();
    const box = el("div");
    const tip = el("div", "side-tip");
    tip.innerHTML = `${I("info", "ico-sm")}<span>由当前源码解析得到，点击可定位到行。画布型格式按图元分组。</span>`;
    box.appendChild(tip);
    const items = outlineFor(d);
    items.forEach((g) => {
      const sec = el("div", "side-section");
      const h = el("h4", "", `${I("chevD", "ico-sm chev")}${esc(g.title)}<span class="meta">${g.rows.length}</span>`);
      const list = el("div", "side-list");
      g.rows.forEach((r) => {
        const row = el("button", "outline-row");
        row.innerHTML = `${I(r.icon, "ico-sm")}<span class="nm">${esc(r.name)}</span><span class="kind">L${r.line}</span>`;
        row.addEventListener("click", () => gotoLine(r.line));
        list.appendChild(row);
      });
      h.addEventListener("click", () => sec.classList.toggle("collapsed"));
      sec.append(h, list);
      box.appendChild(sec);
    });
    return box;
  }

  function outlineFor(d) {
    if (d.format === "mermaid") {
      const nodes = [], edges = [], subs = [];
      d.src.split("\n").forEach((ln, i) => {
        const t = ln.trim();
        if (t.startsWith("subgraph")) subs.push({ icon: "layers", name: t.replace("subgraph ", ""), line: i + 1 });
        else if (/-->|--x|-\.->|==>|&/.test(t) && !t.startsWith("%%")) edges.push({ icon: "swap", name: t.slice(0, 34), line: i + 1 });
        else if (/\[[({]/.test(t) && !t.startsWith("%%") && !t.startsWith("class")) nodes.push({ icon: "diagram", name: (t.match(/\[([^\]]*)\]|\(\(([^)]*)\)\)|\(([^)]*)\)|\{([^}]*)\}/) || [])[0]?.replace(/[[\](){ }]/g, "") || t.slice(0, 24), line: i + 1 });
      });
      return [
        { title: "子图 subgraph", rows: subs },
        { title: "节点", rows: nodes },
        { title: "边", rows: edges.slice(0, 14) },
      ];
    }
    if (d.format === "dot") {
      const nodes = [], edges = [], subs = [];
      d.src.split("\n").forEach((ln, i) => {
        const t = ln.trim();
        if (t.startsWith("subgraph")) subs.push({ icon: "layers", name: t.replace(/subgraph\s*/, "").replace(/[{;]$/, ""), line: i + 1 });
        else if (/->|--/.test(t)) edges.push({ icon: "swap", name: t.slice(0, 34), line: i + 1 });
        else if (/^\w+\s*\[/.test(t)) nodes.push({ icon: "diagram", name: t.split(/\s*\[/)[0], line: i + 1 });
      });
      return [
        { title: "子图 cluster", rows: subs },
        { title: "节点", rows: nodes },
        { title: "边", rows: edges },
      ];
    }
    if (d.format === "drawio") {
      const cells = [];
      d.src.split("\n").forEach((ln, i) => {
        const m = ln.match(/<mxCell id="([^"]+)"\s+value="([^"]*)"/);
        if (m) cells.push({ icon: "diagram", name: m[2].replace(/&#10;/g, " "), line: i + 1 });
      });
      return [{ title: "图元 mxCell", rows: cells }];
    }
    const els = [];
    d.src.split("\n").forEach((ln, i) => {
      const m = ln.match(/"type":\s*"(\w+)"/);
      if (m) els.push({ icon: "layers", name: m[1], line: i + 1 });
    });
    return [{ title: "场景元素", rows: els }];
  }

  /* ---- 5. 标签页 / 面包屑 / 源码 / 预览 ------------------------------ */
  function renderTabs() {
    const box = $("#tabs");
    box.innerHTML = "";
    DOCS.forEach((d) => {
      const f = FORMATS[d.format];
      const t = el("div", "tab" + (d.id === S.docId ? " on" : ""));
      t.innerHTML =
        `<span class="fmt-dot"></span><span class="nm">${esc(d.name)}</span>` +
        (d.dirty ? `<span class="dirty" title="未保存的更改"></span>` : "") +
        `<button class="x" title="关闭">${I("close", "ico-sm")}</button>`;
      $(".fmt-dot", t).style.background = f.color;
      t.style.setProperty("--tab-accent", f.color);
      t.title = d.path;
      t.addEventListener("click", (e) => {
        if (e.target.closest(".x")) return closeDoc(d.id);
        activate(d.id);
      });
      t.addEventListener("auxclick", (e) => { if (e.button === 1) closeDoc(d.id); });
      box.appendChild(t);
    });
  }

  const MODE_BTNS = [
    { m: "source", icon: "code", label: "源码", tip: "仅源码，隐藏预览  Ctrl+1" },
    { m: "split", icon: "splitV", label: "分屏", tip: "源码与预览分屏  Ctrl+2" },
    { m: "preview", icon: "eye", label: "预览", tip: "仅预览，隐藏源码窗口  Ctrl+3" },
  ];

  /**
   * 视图模式切换器。
   * 文本型格式（Mermaid / DOT）给三态；画布型格式（drawio / Excalidraw）
   * 没有源码分屏 —— 这里不藏起控件，而是明确说明"画布即编辑器"。
   */
  function renderViewModes() {
    const d = doc();
    const wrap = $("#viewmodes");
    const text = FORMATS[d.format].splitView;
    wrap.innerHTML = "";
    wrap.hidden = false;
    wrap.classList.toggle("canvas-mode", !text);
    if (!text) {
      wrap.innerHTML = `<span class="vm-canvas" title="drawio / Excalidraw 的画布即编辑器；磁盘上仍是可 diff 的文本">${I("hand", "ico-sm")}画布即编辑器</span>`;
    } else {
      MODE_BTNS.forEach((b) => {
        const n = el("button", S.mode === b.m ? "on" : "");
        n.dataset.mode = b.m;
        n.title = b.tip;
        n.innerHTML = `${I(b.icon, "ico-sm")}<span>${b.label}</span>`;
        wrap.appendChild(n);
      });
    }
    $("#btn-hide-source").hidden = !text;
    $("#btn-show-source").hidden = !text;
    $("#btn-format").hidden = !text;
    $("#btn-src-ai").hidden = !text;
  }

  /* 语法上色：单遍 tokenizer。
   * 关键：先按原文 tokenize、逐段转义，绝不在"已经插好 markup 的字符串"上再跑正则
   * （早期实现顺序替换，`class` 关键字会命中自己插进去的 class="tk-…"，整行花掉）。
   * 真实实现走 CodeMirror 6 的语言包，这里只为原型"看上去像编辑器"。
   */
  const HL = {
    mermaid: {
      re: /(%%.*$)|(\[[^\]]*\]|\([^)]*\)|\{[^}]*\})|\b(flowchart|graph|sequenceDiagram|classDiagram|stateDiagram-v2|stateDiagram|erDiagram|gantt|pie|journey|mindmap|timeline|gitGraph|subgraph|end|classDef|class|style|linkStyle|direction|participant|actor|note|over|autonumber)\b|(--+>|==+>|-\.+-+>|-\.->|--x)|\b(\d+(?:\.\d+)?)\b|(^[ \t]*[A-Za-z_][\w-]*(?=[ \t]*(?:-->|\[|\(|\{|$)))/gm,
      cls: ["tk-com", "tk-str", "tk-key", "tk-edge", "tk-num", "tk-id"],
    },
    dot: {
      re: /(\/\/.*$|#[^\n]*$)|(\/"[\s\S]*?"\/)|("[^"]*")|\b(digraph|graph|subgraph|node|edge|strict|rankdir|rank|label|shape|style|fillcolor|color|fontname|fontsize|dir|arrowsize|constraint|splines|compound|labelloc)\b|(->|--)|\b(\d+(?:\.\d+)?)\b|(^[ \t]*[A-Za-z_]\w*(?=[ \t]*\[))/gm,
      cls: ["tk-com", "tk-com", "tk-str", "tk-key", "tk-edge", "tk-num", "tk-id"],
    },
    xml: {
      re: /(<\!--[\s\S]*?-->)|(<\/?)([A-Za-z_][\w:.-]*)|([A-Za-z_][\w:.-]*)(=)("[^"]*")/g,
      cls: ["tk-com", "tk-punc", "tk-tag", "tk-attr", "tk-punc", "tk-str"],
      // xml 的替换需要"跨组拼接"，单独走 fn
      fn: (m) => {
        if (m[1]) return `<span class="tk-com">${esc(m[1])}</span>`;
        if (m[2]) return `<span class="tk-punc">${esc(m[2])}</span><span class="tk-tag">${esc(m[3])}</span>`;
        return `<span class="tk-attr">${esc(m[4])}</span><span class="tk-punc">${esc(m[5])}</span><span class="tk-str">${esc(m[6])}</span>`;
      },
    },
    json: {
      re: /("(?:[^"\\]|\\.)*")(?=\s*:)|("(?:[^"\\]|\\.)*")|\b(true|false|null)\b|(-?\b\d+(?:\.\d+)?(?:[eE][+-]?\d+)?\b)/g,
      cls: ["tk-attr", "tk-str", "tk-key", "tk-num"],
    },
  };

  function highlight(src, lang) {
    const spec = HL[lang];
    return src.split("\n").map((line, i) => ({ n: i + 1, h: spec ? tokenizeLine(line, spec) : esc(line) }));
  }

  /** 单遍：exec 循环，未命中区间原样转义，命中区间按组上类。 */
  function tokenizeLine(line, spec) {
    const re = new RegExp(spec.re.source, spec.re.flags.replace("m", ""));
    let out = "", last = 0, m;
    while ((m = re.exec(line))) {
      if (m.index > last) out += esc(line.slice(last, m.index));
      if (spec.fn) {
        out += spec.fn(m);
      } else {
        let cls = "";
        for (let g = 1; g < m.length; g++) if (m[g] != null) { cls = spec.cls[g - 1]; break; }
        out += `<span class="${cls}">${esc(m[0])}</span>`;
      }
      last = m.index + m[0].length;
      if (m[0].length === 0) re.lastIndex++;
    }
    if (last < line.length) out += esc(line.slice(last));
    return out;
  }

  function renderCode() {
    const d = doc();
    const f = FORMATS[d.format];
    const lines = highlight(d.src, f.lang);
    const caret = d.caret.line;
    $("#code").innerHTML = lines.map((l) => {
      const cur = l.n === caret ? " current" : "";
      return `<span class="ln${cur}" data-ln="${l.n}">${l.n}</span><span class="cl${cur}" data-ln="${l.n}">${l.h || " "}</span>`;
    }).join("");
    $("#src-lang").textContent = f.name;

    // 错误标注（对应"问题"面板 + 编辑器行内提示）
    const bad = d.issues.find((i) => i.sev === "err");
    const old = $("#code-error");
    if (old) old.remove();
    if (bad && S.mode !== "preview") {
      const box = el("div", "code-error");
      box.id = "code-error";
      box.innerHTML = `${I("alert", "ico-sm")}<span><b>第 ${bad.line} 行：</b>${esc(bad.msg)}<br><span data-fix>建议：${esc(bad.hint)}　<button class="lnk-btn" id="fix-ai">让 AI 修一下</button></span></span>`;
      $("#code-scroll").appendChild(box);
      const b = $("#fix-ai");
      if (b) b.addEventListener("click", () => { focusAI("chat"); aiSay("bot", "把第 " + bad.line + " 行的 `>=` 转义成 `&gt;=` 即可。要我直接改吗？", { actions: ["apply", "revert"] }); });
    }
  }

  function renderPreview() {
    const d = doc();
    const f = FORMATS[d.format];
    const stage = $("#canvas-stage");
    stage.innerHTML = SVG_BY_KEY[d.svgKey] || "";
    stage.style.transform = `scale(${S.zoom / 100})`;
    $("#zoom-val").textContent = S.zoom + "%";

    let sub = "";
    if (d.format === "dot") sub = `　·　布局 ${d.layout || "dot"}`;
    else if (d.format === "drawio") sub = "　·　画布可编辑，改动自动回写正文";
    else if (d.format === "excalidraw") sub = "　·　手绘风画布";
    else sub = "　·　页内渲染，零外部请求";
    $("#preview-sub").textContent = sub;

    // 画布型格式的浮动工具条不同（drawio/excalidraw 有自己的画布 UI）
    $("#canvas-tools").classList.toggle("is-canvas", f.surface === "canvas");
    $("#btn-convert").disabled = !CONVERSIONS.some((c) => c.from === d.format && c.ok);
    $("#btn-convert").title = $("#btn-convert").disabled
      ? `${f.name} 目前不能作为转换源（详见转换中心）`
      : "转换到其他格式";
  }

  const SVG_BY_KEY = { flow: SVG_FLOW, deps: SVG_DEPS, topo: SVG_TOPO, sketch: SVG_SKETCH };

  /* ---- 6. AI 面板 ----------------------------------------------------- */
  function renderAI() {
    const stream = $("#ai-stream");
    stream.innerHTML = "";
    const msgs = S.streams[S.aiTab];
    $$("#ai-tabs .ai-tab").forEach((b) => b.classList.toggle("on", b.dataset.ai === S.aiTab));

    if (!msgs.length) {
      stream.appendChild(aiEmpty());
    } else {
      msgs.forEach((m) => stream.appendChild(msgNode(m)));
    }

    $("#ai-hint").textContent =
      S.aiTab === "vision" ? "识图档 · 图片不落盘" :
      S.aiTab === "review" ? `上下文：${doc().name}` :
      `${FORMATS[doc().format].name} 输出`;

    const ta = $("#ai-input");
    ta.placeholder =
      S.aiTab === "vision" ? "描述这张图要转成什么格式，Enter 发送" :
      S.aiTab === "review" ? "例如：把异常分支补全 / 精简节点 / 换成时序图" :
      "描述你想要的图，Enter 发送 / Shift+Enter 换行";

    // 建议词只在对话 tab 出现
    const sug = $("#ai-suggest");
    if (S.aiTab === "chat") {
      sug.hidden = false;
      sug.innerHTML = "";
      AI_SUGGEST.forEach((t) => {
        const b = el("button", "sug", esc(t));
        b.addEventListener("click", () => { ta.value = t; ta.focus(); syncSend(); });
        sug.appendChild(b);
      });
    } else sug.hidden = true;

    const m = AI_MODELS.find((x) => x.id === S.aiModel);
    $("#ai-model-name").textContent = m.name;
    $("#ai-model .dot").style.background = m.dot;

    renderAttachment();
    syncSend();
    stream.scrollTop = stream.scrollHeight;
  }

  function aiEmpty() {
    const box = el("div", "ai-empty");
    box.innerHTML =
      `<div><div class="hero">${I("sparkles", "ico-lg")}</div>` +
      `<h3>让 AI 画第一版</h3>` +
      `<p>AI 是这个客户端的第一公民：描述一句话即可出图，也可以截一张图让它逆向成代码。</p>` +
      `<div class="acts">` +
      `<button class="btn ai block" data-a="gen">${I("sparkles")}描述需求生成图</button>` +
      `<button class="btn block" data-a="vision">${I("scan")}识图：截图 → 代码</button>` +
      `<button class="btn ghost block" data-a="ctx">${I("diagram")}解释当前这张图</button>` +
      `</div></div>`;
    box.addEventListener("click", (e) => {
      const b = e.target.closest("button");
      if (!b) return;
      if (b.dataset.a === "vision") dialogVision();
      else if (b.dataset.a === "ctx") { setAITab("review"); }
      else { $("#ai-input").focus(); }
    });
    return box;
  }

  function msgNode(m) {
    const n = el("div", "msg " + (m.role === "user" ? "user" : m.role === "sys" ? "sys" : m.role === "err" ? "err" : "bot"));
    if (m.role === "sys") {
      n.innerHTML = `<div class="bubble">${I("info", "ico-sm")} ${esc(m.text)}</div>`;
      return n;
    }
    const head = m.role === "user"
      ? `<div class="msg-head"><span class="who">你</span></div>`
      : `<div class="msg-head">${I("robot", "ico-sm")}<span class="who">Diagramon AI</span>${m.used ? `<span class="badge-used">${esc(m.used.model)} · ${esc(m.used.tokens)} tok · ${esc(m.used.credits)} 点</span>` : ""}</div>`;
    n.innerHTML = head;

    if (m.image) {
      const th = el("div", "thumb");
      th.innerHTML = `<span class="pic">${I("image", "ico-lg")}</span><span class="meta"><b>${esc(m.image.name)}</b><span>${esc(m.image.size)}</span></span>`;
      n.appendChild(th);
    }
    if (m.text) n.appendChild(el("div", "bubble", esc(m.text)));

    if (m.list) {
      const ul = el("ul", "ai-list");
      m.list.forEach((li) => ul.appendChild(el("li", "", `${I("chevR", "ico-sm")}<span>${esc(li)}</span>`)));
      n.appendChild(ul);
    }

    if (m.conf) {
      const cf = el("div", "conf");
      m.conf.forEach((c) => {
        const row = el("div", "conf-row");
        row.innerHTML = `<span class="lb">${esc(c.label)}</span><span class="bar"><span data-v="${c.v}"></span></span><span class="vv">${c.v}%</span>`;
        $(".bar span", row).style.width = c.v + "%";
        $(".bar span", row).classList.add(c.v >= 85 ? "hi" : c.v >= 70 ? "mid" : "lo");
        cf.appendChild(row);
      });
      n.appendChild(cf);
    }

    if (m.code) {
      const card = el("div", "code-card");
      card.innerHTML =
        `<div class="code-card-head">${I("file", "ico-sm")}<span class="chip ${m.code.format}">${esc(FORMATS[m.code.format].name)}</span><span>${m.code.lines} 行</span><span class="sp"></span><button class="mini-btn" data-a="copy">${I("copy", "ico-sm")}复制</button></div>` +
        `<pre>${esc(m.code.preview)}</pre>`;
      const acts = el("div", "code-card-actions");
      (m.actions || []).forEach((a) => {
        const b = el("button", "btn sm" + (a === "apply" || a === "apply-first" ? " primary" : a === "apply-drawio" ? " ai" : " ghost"));
        b.innerHTML =
          a === "apply" ? `${I("check")}应用到编辑器` :
          a === "apply-first" ? `${I("check")}应用第 1 条` :
          a === "apply-drawio" ? `${I("swap")}应用为 drawio` :
          a === "revert" ? `${I("undo")}回退` : `${I("copy")}复制代码`;
        b.addEventListener("click", () => aiAction(a, m));
        acts.appendChild(b);
      });
      if (m.applied) {
        const done = el("span", "applied-tag");
        done.innerHTML = `${I("check", "ico-sm")}已应用`;
        acts.appendChild(done);
      }
      card.appendChild(acts);
      card.addEventListener("click", (e) => {
        if (e.target.closest('[data-a="copy"]')) {
          copyText(m.code.preview);
          toast({ icon: "copy", title: "代码已复制", sub: `${m.code.lines} 行 ${FORMATS[m.code.format].name}` });
        }
      });
      n.appendChild(card);
    }

    if (m.fixNote) n.appendChild(el("div", "fix-note", `${I("refresh", "ico-sm")}<span>${esc(m.fixNote)}</span>`));
    return n;
  }

  function aiAction(a, m) {
    if (a === "apply" || a === "apply-first") {
      const d = doc();
      d.dirty = true;
      m.applied = true;
      renderAI(); renderTabs(); renderDocTitle(); renderCode();
      status("已应用到 " + d.name, "ok");
      toast({ icon: "check", title: "已应用到编辑器", sub: "可用 Ctrl+Z 撤销；「回退」按钮也会还原到生成前的正文", ai: true });
      pushOutput(`AI 生成结果已应用（${FORMATS[m.code.format].name} · ${m.code.lines} 行）`, "ok");
    } else if (a === "apply-drawio") {
      runConvert({ from: doc().format, to: "drawio", ok: true, how: "drawio 自带解析器接管", tag: "已实现" }, m.code);
    } else if (a === "revert") {
      doc().dirty = false;
      m.applied = false;
      renderAI(); renderTabs(); renderDocTitle();
      status("已回退到生成前的正文", "");
      toast({ icon: "undo", title: "已回退", sub: "编辑器恢复到本次生成之前的内容" });
    }
  }

  function aiSay(role, text, extra) {
    const m = Object.assign({ role, text }, extra || {});
    S.streams[S.aiTab].push(m);
    renderAI();
    return m;
  }

  function renderAttachment() {
    const box = $("#ai-attachments");
    if (!S.attachment) { box.hidden = true; box.innerHTML = ""; return; }
    box.hidden = false;
    const a = S.attachment;
    box.innerHTML =
      `<div class="thumb"><span class="pic">${I("image", "ico-lg")}</span>` +
      `<span class="meta"><b>${esc(a.name)}</b><span>${esc(a.size)}</span></span>` +
      `<button class="rm" id="att-rm" title="移除图片">${I("close", "ico-sm")}</button></div>`;
    $("#att-rm").addEventListener("click", () => { S.attachment = null; renderAttachment(); syncSend(); });
  }

  function syncSend() {
    const v = $("#ai-input").value.trim();
    $("#ai-send").disabled = !v && !S.attachment;
  }

  function aiSend() {
    const ta = $("#ai-input");
    const text = ta.value.trim();
    if (!text && !S.attachment) return;
    const tab = S.aiTab;
    const msg = { role: "user", text: text || "（只发图片）" };
    if (S.attachment) { msg.image = S.attachment; S.attachment = null; }
    S.streams[tab].push(msg);
    ta.value = "";
    renderAI();

    // 模拟一次真实调用：先出"生成中"，再出结果
    const pending = { role: "bot", pending: true };
    S.streams[tab].push(pending);
    renderPending();
    status("AI 生成中…", "");

    setTimeout(() => {
      const i = S.streams[tab].indexOf(pending);
      if (i >= 0) S.streams[tab].splice(i, 1);
      const d = doc();
      if (tab === "vision") {
        S.streams[tab].push({
          role: "bot",
          text: "识别出图形结构与文字，已转成 " + FORMATS[d.format].name + "。置信度较低的节点我标出来了，请核对。",
          code: { format: d.format, preview: d.src.split("\n").slice(0, 12).join("\n"), lines: 12 },
          used: { model: "diagram-vision", tokens: "2.7k", credits: "2.0" },
          conf: [{ label: "整体结构", v: 90 }, { label: "节点文字", v: 74 }, { label: "连线方向", v: 83 }],
          actions: ["apply", "apply-drawio", "copy"],
        });
      } else if (tab === "review") {
        S.streams[tab].push({
          role: "bot",
          text: "按你的要求改好了。改动集中在 3 处，其余节点与边保持原样（不会重写整张图）。",
          code: { format: d.format, preview: d.src.split("\n").slice(0, 10).join("\n"), lines: 10 },
          used: { model: "diagram-pro", tokens: "1.1k", credits: "1.2" },
          actions: ["apply", "revert", "copy"],
        });
      } else {
        S.streams[tab].push({
          role: "bot",
          text: `已生成 ${FORMATS[d.format].name}。共 14 个节点、17 条边；分支处用了菱形判定，异常路径归到 subgraph 里。`,
          code: { format: d.format, preview: d.src.split("\n").slice(0, 14).join("\n"), lines: 14 },
          used: { model: S.aiModel === "auto" ? "diagram-fast" : AI_MODELS.find((m) => m.id === S.aiModel).name, tokens: "1.3k", credits: "0.3" },
          actions: ["apply", "apply-drawio", "revert", "copy"],
        });
      }
      renderAI();
      status("AI 生成完成", "ok");
      pushOutput(`AI 调用完成（${tab === "vision" ? "识图档" : "生成档"}）· 1.3k tokens`, "ok");
      USAGE.used = Math.round((USAGE.used + (tab === "vision" ? 2.0 : 0.3)) * 10) / 10;
      if (S.panelTab === "usage") renderPanel();
    }, 900);
  }

  function renderPending() {
    const stream = $("#ai-stream");
    const n = el("div", "msg bot");
    n.id = "ai-pending";
    n.innerHTML = `<div class="msg-head">${I("robot", "ico-sm")}<span class="who">Diagramon AI</span></div><div class="bubble typing"><span></span><span></span><span></span></div>`;
    stream.appendChild(n);
    stream.scrollTop = stream.scrollHeight;
  }

  function setAITab(t) {
    S.aiTab = t;
    if (!S.aiOpen) toggleAI();
    renderAI();
  }
  function focusAI(tab) {
    if (tab) setAITab(tab);
    else if (!S.aiOpen) toggleAI();
    const ta = $("#ai-input");
    ta.focus();
    // 面板刚由布局过渡展开时，个别浏览器要一帧后才接受焦点
    requestAnimationFrame(() => ta.focus());
  }

  /* ---- 7. 底部面板与状态栏 ------------------------------------------- */
  function renderPanelTabs() {
    const box = $("#bp-tabs");
    box.innerHTML = "";
    PANEL_TABS.forEach((t) => {
      const b = el("button", "bp-tab" + (S.panelTab === t.id ? " on" : ""));
      let n = "";
      if (t.countFrom === "issues") {
        const all = DOCS.reduce((a, d) => a + d.issues.length, 0);
        const errs = DOCS.reduce((a, d) => a + d.issues.filter((i) => i.sev === "err").length, 0);
        n = all ? `<span class="n ${errs ? "err" : "warn"}">${all}</span>` : `<span class="n">0</span>`;
      }
      b.innerHTML = `${I(t.icon, "ico-sm")}<span>${esc(t.label)}</span>${n}`;
      b.addEventListener("click", () => { S.panelTab = t.id; renderPanel(); });
      box.appendChild(b);
    });
    const sp = el("span", "sp");
    box.appendChild(sp);
    const cls = el("button", "icon-btn");
    cls.innerHTML = I("close", "ico-sm");
    cls.title = "隐藏面板  Ctrl+J";
    cls.addEventListener("click", () => togglePanel());
    box.appendChild(cls);
  }

  function renderPanel() {
    renderPanelTabs();
    const body = $("#bp-body");
    body.innerHTML = "";
    if (S.panelTab === "problems") {
      const list = el("div", "bp-issues");
      const all = [];
      DOCS.forEach((d) => d.issues.forEach((i) => all.push({ d, i })));
      if (!all.length) {
        list.appendChild(el("div", "bp-empty", `${I("ok")}<span>没有发现问题。四种格式的语法校验都在本机完成。</span>`));
      }
      all.forEach(({ d, i }) => {
        const row = el("button", "issue");
        row.innerHTML =
          `<span class="sev">${I(i.sev === "err" ? "err" : "warn", "ico-sm")}</span>` +
          `<span class="txt"><b>${esc(i.msg)}</b><span>${esc(d.name)} · 第 ${i.line} 行 · ${esc(i.hint)}</span></span>` +
          `<span class="go">转到 ${I("chevR", "ico-sm")}</span>`;
        row.classList.add(i.sev);
        row.addEventListener("click", () => { activate(d.id); gotoLine(i.line); });
        list.appendChild(row);
      });
      body.appendChild(list);
    } else if (S.panelTab === "output") {
      OUTPUT_LOG.forEach((l) => body.appendChild(el("div", "bp-line " + l.k, `<span class="t">${l.t}</span><span class="m">${esc(l.m)}</span>`)));
    } else if (S.panelTab === "convert") {
      CONVERT_LOG.forEach((c) => {
        const row = el("div", "conv-log");
        row.innerHTML =
          `<span class="t">${esc(c.t)}</span>` +
          `<span class="pair"><span class="chip ${c.from}">${esc(FORMATS[c.from].name)}</span>${I("chevR", "ico-sm")}<span class="chip ${c.to}">${esc(FORMATS[c.to].name)}</span></span>` +
          `<span class="st ${c.ok ? "ok" : "bad"}">${I(c.ok ? "check" : "alert", "ico-sm")}${c.ok ? "成功" : "部分成功"}</span>` +
          `<span class="doc">${esc(c.doc)}</span>` +
          `<span class="note">${esc(c.note)}</span>`;
        body.appendChild(row);
      });
    } else if (S.panelTab === "usage") {
      body.appendChild(usageNode());
    }
  }

  function usageNode() {
    const pct = Math.min(100, Math.round((USAGE.used / USAGE.total) * 100));
    const tone = pct >= USAGE.badRatio * 100 ? "bad" : pct >= USAGE.warnRatio * 100 ? "warn" : "ok";
    const box = el("div", "usage");
    box.innerHTML =
      `<div class="usage-head">` +
      `<div class="usage-kpi"><span class="lb">本周期已用</span><span class="num">${USAGE.used}</span><span class="unit">信用点</span></div>` +
      `<div class="usage-kpi"><span class="lb">剩余可用</span><span class="num">${(USAGE.total - USAGE.used - USAGE.reserved).toFixed(1)}</span><span class="unit">含预留 ${USAGE.reserved}</span></div>` +
      `<div class="usage-kpi"><span class="lb">还能画</span><span class="num">${Math.floor((USAGE.total - USAGE.used) / 0.3)}</span><span class="unit">张（按 diagram-fast 0.3 点/次）</span></div>` +
      `</div>` +
      `<div class="meter lg ${tone}"><span data-pct="${pct}"></span><i data-warn="${USAGE.warnRatio * 100}"></i><i data-bad="${USAGE.badRatio * 100}"></i></div>` +
      `<div class="usage-note">周期 ${esc(USAGE.period)} · 阈值：${USAGE.warnRatio * 100}% 转黄、${USAGE.badRatio * 100}% 转红 · BYOK 直连不计信用点</div>` +
      `<table class="usage-table"><thead><tr><th>档位</th><th class="n">调用次数</th><th class="n">信用点</th><th class="n">单次均价</th></tr></thead><tbody>` +
      USAGE.rows.map((r) => `<tr><td>${esc(r.model)}</td><td class="n">${r.calls}</td><td class="n">${r.credits}</td><td class="n">${esc(r.avg)}</td></tr>`).join("") +
      `</tbody></table>`;
    $(".meter span", box).style.width = pct + "%";
    $$("i", box).forEach((i) => { i.style.left = (i.dataset.warn || i.dataset.bad) + "%"; });
    return box;
  }

  function pushOutput(msg, kind) {
    const now = new Date();
    const t = [now.getHours(), now.getMinutes(), now.getSeconds()].map((n) => String(n).padStart(2, "0")).join(":");
    OUTPUT_LOG.push({ t, m: msg, k: kind || "" });
    if (S.panelOpen && S.panelTab === "output") renderPanel();
  }

  /** 当前行所在的作用域：mermaid 的 subgraph / DOT 的 cluster。
   *  面包屑删掉后，这是它唯一不重复的信息，挪到状态栏行列号旁边。 */
  function currentScope(d) {
    const lines = d.src.split("\n").slice(0, d.caret.line);
    const stack = [];
    for (const ln of lines) {
      const t = ln.trim();
      if (d.format === "mermaid") {
        if (/^subgraph\b/.test(t)) stack.push(t.replace(/^subgraph\s*/, "") || "(匿名)");
        else if (/^end\s*$/.test(t)) stack.pop();
      } else if (d.format === "dot") {
        if (/^subgraph\b/.test(t)) stack.push((t.match(/subgraph\s+(\S+)/) || [])[1] || "(匿名)");
        else if (/^}\s*$/.test(t)) stack.pop();
      }
    }
    return stack.length ? stack[stack.length - 1] : "";
  }

  function renderStatus() {
    const d = doc();
    const f = FORMATS[d.format];
    const bar = $("#statusbar");
    const errs = d.issues.filter((i) => i.sev === "err").length;
    const warns = d.issues.filter((i) => i.sev === "warn").length;
    const branch = S.mode === "source" ? "仅源码" : S.mode === "preview" ? "仅预览" : "分屏";
    const scope = isText() ? currentScope(d) : "";
    bar.innerHTML =
      `<button class="st" data-a="panel" title="切换底部面板  Ctrl+J">${I("panelBottom", "ico-sm")}</button>` +
      `<button class="st ${errs ? "err" : warns ? "warn" : ""}" data-a="problems" title="点击查看问题面板">${I(errs ? "err" : warns ? "warn" : "ok", "ico-sm")}<span class="st-num">${errs}</span><span class="st-num">${warns}</span></button>` +
      `<button class="st" data-a="ai" title="AI 面板  Ctrl+Shift+A">${I("sparkles", "ico-sm")}${esc(AI_MODELS.find((m) => m.id === S.aiModel).name)}</button>` +
      `<span class="st" title="本周期信用点">${I("bolt", "ico-sm")}${USAGE.used} / ${USAGE.total}</span>` +
      `<span class="st-spacer"></span>` +
      `<span class="st" id="status-msg">${esc($("#status-msg") ? $("#status-msg").textContent : "就绪")}</span>` +
      `<span class="st-spacer"></span>` +
      (d.format === "dot" ? `<button class="st" data-a="layout" title="DOT 布局引擎">${I("diagram", "ico-sm")}布局 ${esc(d.layout || "dot")}</button>` : "") +
      `<span class="st" title="当前视图模式">${I(S.mode === "source" ? "code" : S.mode === "preview" ? "eye" : "splitV", "ico-sm")}${branch}</span>` +
      `<button class="st" data-a="zoom" title="点击回到 100%">${I("zoomIn", "ico-sm")}${S.zoom}%</button>` +
      `<span class="st">行 ${d.caret.line}, 列 ${d.caret.col}</span>` +
      (scope ? `<span class="st" title="当前行所在作用域（源码窗口里光标所在的 subgraph / cluster）">${I("layers", "ico-sm")}${esc(scope)}</span>` : "") +
      `<span class="st">UTF-8</span><span class="st">LF</span>` +
      `<span class="st accent" title="当前格式">${esc(f.name)}</span>`;
    $$(".fmt-dot", bar).forEach((x) => (x.style.background = f.color));
    bar.onclick = (e) => {
      const b = e.target.closest("[data-a]");
      if (!b) return;
      const a = b.dataset.a;
      if (a === "panel") togglePanel();
      else if (a === "problems") { if (!S.panelOpen) togglePanel(); S.panelTab = "problems"; renderPanel(); }
      else if (a === "ai") toggleAI();
      else if (a === "zoom") setZoom(100);
      else if (a === "layout") popLayouts(b);
    };
  }

  let statusTimer = 0;
  function status(text, kind) {
    const n = $("#status-msg");
    if (!n) return;
    n.textContent = text;
    n.className = "st" + (kind ? " " + kind : "");
    clearTimeout(statusTimer);
    statusTimer = setTimeout(() => { n.textContent = "就绪"; n.className = "st"; }, 4200);
  }

  /* ---- 8. 布局开关 ---------------------------------------------------- */
  function syncLayout() {
    document.body.classList.toggle("no-sidebar", !S.sidebarOpen);
    document.body.classList.toggle("no-ai", !S.aiOpen);
    document.body.classList.toggle("no-activitybar", !S.activityOpen);
    document.body.classList.toggle("no-panel", !S.panelOpen);
    renderActivity();
    renderSidebar();
    renderPanel();
    renderStatus();
  }
  function toggleSidebar() { S.sidebarOpen = !S.sidebarOpen; syncLayout(); }
  function toggleAI() { S.aiOpen = !S.aiOpen; syncLayout(); }
  function togglePanel() { S.panelOpen = !S.panelOpen; syncLayout(); }
  function toggleActivity() { S.activityOpen = !S.activityOpen; syncLayout(); }
  function zenMode() {
    const on = document.body.dataset.zen !== "1";
    if (on) {
      document.body.dataset.zen = "1";
      document.body.dataset.prev = JSON.stringify({ s: S.sidebarOpen, a: S.aiOpen, p: S.panelOpen, act: S.activityOpen, m: S.mode });
      S.sidebarOpen = S.aiOpen = S.panelOpen = S.activityOpen = false;
      setMode("preview", true);
      toast({ icon: "maximize", title: "全屏预览", sub: "所有面板已隐藏，再按 Ctrl+Shift+F 恢复" });
    } else {
      const p = JSON.parse(document.body.dataset.prev || "{}");
      document.body.dataset.zen = "";
      S.sidebarOpen = p.s !== false; S.aiOpen = p.a !== false; S.panelOpen = p.p !== false; S.activityOpen = p.act !== false;
      setMode(p.m || "split", true);
    }
    syncLayout();
  }

  function setMode(m, silent) {
    const d = doc();
    if (!FORMATS[d.format].splitView) {
      if (!silent) toast({ icon: "hand", title: "这是画布型格式", sub: "drawio / Excalidraw 的画布即编辑器，没有源码分屏；正文仍以文本形式保存" });
      return;
    }
    S.mode = m;
    d.mode = m;
    $("#split").className = "split mode-" + m;
    renderViewModes();
    renderStatus();
    if (!silent) {
      const names = { source: "仅源码（预览已隐藏）", split: "源码与预览分屏", preview: "仅预览（源码窗口已隐藏）" };
      status(names[m], "");
    }
  }

  function setZoom(z) {
    S.zoom = Math.max(20, Math.min(400, z));
    $("#canvas-stage").style.transform = `scale(${S.zoom / 100})`;
    $("#zoom-val").textContent = S.zoom + "%";
    renderStatus();
  }

  /* ---- 文档操作 ------------------------------------------------------- */
  function activate(id) {
    const d = DOCS.find((x) => x.id === id);
    if (!d) return;
    S.docId = id;
    S.zoom = 100;
    S.mode = FORMATS[d.format].splitView ? (d.mode || "split") : "preview";
    $("#split").className = "split mode-" + S.mode;
    $("#split").style.removeProperty("--split-src");
    renderAll();
  }

  function closeDoc(id) {
    const i = DOCS.findIndex((d) => d.id === id);
    if (i < 0) return;
    const d = DOCS[i];
    if (d.dirty) {
      dialogUnsaved(d, (act) => {
        if (act === "cancel") return;
        if (act === "save") { d.dirty = false; pushOutput("已保存 " + d.name, "ok"); }
        reallyClose(i);
      });
      return;
    }
    reallyClose(i);
  }

  function reallyClose(i) {
    const d = DOCS.splice(i, 1)[0];
    pushOutput(`已关闭标签页 ${d.name}`, "");
    if (!DOCS.length) { S.docId = null; renderAll(); return; }
    const nx = DOCS[Math.min(i, DOCS.length - 1)];
    S.docId = nx.id;
    S.mode = FORMATS[nx.format].splitView ? nx.mode || "split" : "preview";
    $("#split").className = "split mode-" + S.mode;
    renderAll();
    toast({ icon: "close", title: "已关闭 " + d.name, sub: "Ctrl+Z 可撤销关闭（真实实现）" });
  }

  function doSave() {
    const d = doc();
    if (!d) return;
    d.dirty = false;
    renderTabs(); renderDocTitle(); renderStatus(); renderSidebar();
    status("已保存 " + d.name, "ok");
    pushOutput(`已保存 ${d.name}（${FORMATS[d.format].name}）`, "ok");
    toast({ icon: "save", title: "已保存", sub: d.path });
  }

  function doFormat() {
    const d = doc();
    if (!FORMATS[d.format].splitView) return toast({ icon: "wand", title: "画布型格式不需要格式化", sub: "drawio / Excalidraw 的正文由画布生成" });
    d.dirty = true;
    renderCode(); renderTabs(); renderDocTitle();
    status("已格式化源码", "ok");
    toast({ icon: "wand", title: "已格式化", sub: "统一缩进为 4 空格，边标签对齐" });
  }

  function gotoLine(n) {
    const d = doc();
    d.caret.line = n;
    d.caret.col = 1;
    renderCode(); renderStatus();
    const target = $(`#code .cl[data-ln="${n}"]`);
    if (target) target.scrollIntoView({ block: "center", behavior: "smooth" });
    if (S.mode === "preview") setMode("split");
  }

  function renderAll() {
    if (!DOCS.length) {
      $("#split").hidden = true;
      $("#tabbar").hidden = true;
      $("#bottom-panel").hidden = true;
      $("#welcome").hidden = false;
      renderWelcome();
      renderDocTitle();
      renderTabs();
      renderStatus();
      renderSidebar();
      renderActivity();
      renderAI();
      return;
    }
    $("#split").hidden = false;
    $("#tabbar").hidden = false;
    $("#bottom-panel").hidden = !S.panelOpen;
    $("#welcome").hidden = true;
    renderDocTitle();
    renderTabs();
    renderViewModes();
    renderCode();
    renderPreview();
    renderStatus();
    renderSidebar();
    renderActivity();
    renderAI();
    renderPanel();
  }

  function renderWelcome() {
    const w = $("#welcome");
    w.innerHTML = `<div class="welcome-inner">
      <h2>Diagramon</h2>
      <p class="sub">本地优先的多格式图表编辑器 · AI 是第一公民</p>
      <div class="ai-hero">
        <span class="ico-wrap">${I("sparkles", "ico-lg")}</span>
        <span class="hero-txt"><b>不知道从哪开始？直接说给 AI 听</b><span>描述一句话生成图表，或者截一张图让它逆向成代码；当前没有文档时，AI 会顺手建一个</span></span>
        <button class="btn ai" id="w-ai">${I("sparkles")}开始</button>
      </div>
      <div class="cols">
        <div>
          <h4>新建</h4>
          ${Object.values(FORMATS).map((f) => `<button class="lnk" data-new="${f.id}"><span class="fmt-dot"></span>${esc(f.name)}<span class="kbd">${f.exts[0]}</span></button>`).join("")}
        </div>
        <div>
          <h4>最近</h4>
          ${RECENT.slice(0, 4).map((r) => {
            const d = r.doc ? DOCS.find((x) => x.id === r.doc) : null;
            return `<button class="lnk" data-recent="${d ? d.id : ""}"><span class="fmt-dot" data-fmt="${r.format}"></span>${esc(r.name)}<span class="kbd">${esc(r.when)}</span></button>`;
          }).join("")}
        </div>
      </div>
      <div class="fmts mt">
        <span class="chip mermaid">Mermaid · 支持分屏</span>
        <span class="chip dot">DOT · 支持分屏 + 六种布局</span>
        <span class="chip drawio">drawio · 画布即编辑器</span>
        <span class="chip excalidraw">Excalidraw · 手绘风</span>
      </div>
    </div>`;
    $$(".lnk", w).forEach((b) => {
      const dot = $(".fmt-dot", b);
      if (!dot) return;
      const f = FORMATS[b.dataset.new || dot.dataset.fmt];
      dot.style.background = f ? f.color : "var(--faint)";
    });
    $("#w-ai").addEventListener("click", () => focusAI("chat"));
    $$("[data-new]", w).forEach((b) => b.addEventListener("click", () => newDoc(b.dataset.new)));
    $$("[data-recent]", w).forEach((b) => b.addEventListener("click", () => { if (b.dataset.recent) activate(b.dataset.recent); }));
  }

  function newDoc(formatId) {
    const f = FORMATS[formatId];
    const n = DOCS.filter((d) => d.format === formatId).length + 1;
    const d = {
      id: "n" + Date.now(),
      name: `未命名-${n}${f.exts[0]}`,
      path: `（未保存）未命名-${n}${f.exts[0]}`,
      format: formatId,
      dirty: true,
      mode: f.splitView ? "split" : "preview",
      src: DEFAULT_SRC[formatId],
      svgKey: formatId === "mermaid" ? "flow" : formatId === "dot" ? "deps" : formatId === "drawio" ? "topo" : "sketch",
      caret: { line: 1, col: 1 },
      issues: [],
    };
    DOCS.push(d);
    S.docId = d.id;
    S.mode = d.mode;
    $("#split").className = "split mode-" + S.mode;
    renderAll();
    pushOutput(`新建 ${f.name} 文档`, "");
    toast({ icon: "plus", title: "已新建 " + f.name, sub: f.note });
  }

  const DEFAULT_SRC = {
    mermaid: "flowchart TD\n    A([开始]) --> B[第一步]\n    B --> C{判断}\n    C -- 是 --> D([结束])\n    C -- 否 --> B\n",
    dot: "digraph G {\n    rankdir=LR;\n    node [shape=box];\n    A -> B -> C;\n}\n",
    drawio: '<?xml version="1.0" encoding="UTF-8"?>\n<mxfile host="Diagramon">\n  <diagram name="Page-1" id="p1">\n    <mxGraphModel dx="800" dy="600" grid="1" page="1">\n      <root>\n        <mxCell id="0" />\n        <mxCell id="1" parent="0" />\n      </root>\n    </mxGraphModel>\n  </diagram>\n</mxfile>\n',
    excalidraw: '{\n  "type": "excalidraw",\n  "version": 2,\n  "source": "https://diagramon.app",\n  "elements": [],\n  "appState": { "viewBackgroundColor": "#ffffff" }\n}\n',
  };

  /* ---- 转换 ----------------------------------------------------------- */
  function runConvert(c, codeOverride) {
    if (!c.ok) {
      toast({ icon: "alert", title: `${FORMATS[c.from].name} → ${FORMATS[c.to].name} 还不能用`, sub: c.how, warn: true });
      return;
    }
    const dst = FORMATS[c.to];
    const srcName = codeOverride ? "AI 生成的代码" : doc().name;
    const outName = srcName.replace(/\.[^.]+$/, "") + dst.exts[0];
    const out = codeOverride ? codeOverride.preview : (c.to === "dot" ? CONV_DOT_OUT : c.to === "excalidraw" ? CONV_EXCALIDRAW_OUT : CONV_DRAWIO_OUT);
    const nd = {
      id: "c" + Date.now(),
      name: outName,
      path: `（转换生成，未保存）${outName}`,
      format: c.to,
      dirty: true,
      mode: dst.splitView ? "split" : "preview",
      src: out,
      svgKey: c.to === "drawio" ? "topo" : c.to === "excalidraw" ? "sketch" : c.to === "dot" ? "deps" : "flow",
      caret: { line: 1, col: 1 },
      issues: [],
    };
    DOCS.push(nd);
    CONVERT_LOG.unshift({ t: "刚刚", from: c.from, to: c.to, doc: srcName, ok: true, note: c.how });
    pushOutput(`转换：${FORMATS[c.from].name} → ${dst.name} 完成，另开标签页「${outName}」`, "ok");
    S.docId = nd.id;
    S.mode = nd.mode;
    $("#split").className = "split mode-" + S.mode;
    renderAll();
    toast({
      icon: "swap", title: `已转换为 ${dst.name}`,
      sub: `结果另开标签页「${outName}」，原文件保持不动（单向）`,
      action: { label: "查看", fn: () => activate(nd.id) },
    });
  }

  /* ---- 弹层：命令面板 ------------------------------------------------- */
  let palIdx = 0, palItems = [];

  function openPalette() {
    $("#overlay-palette").hidden = false;
    const inp = $("#palette-input");
    inp.value = "";
    filterPalette("");
    setTimeout(() => inp.focus(), 20);
  }
  function closePalette() { $("#overlay-palette").hidden = true; }

  function filterPalette(q) {
    const list = $("#palette-list");
    list.innerHTML = "";
    const query = q.trim().toLowerCase();
    const isCmd = query.startsWith(">");
    const kw = isCmd ? query.slice(1).trim() : query;

    palItems = [];
    if (!isCmd) {
      // 直接问 AI（第一公民：不需要前缀也能问）
      if (kw) {
        palItems.push({ kind: "ask", label: `问 AI：${q}`, icon: "sparkles", ai: true, kbd: "Enter" });
        palItems.push({ kind: "vision", label: `用这句话去识图/生成`, icon: "scan", ai: true });
      }
      // 打开文档
      DOCS.forEach((d) => {
        if (!kw || d.name.toLowerCase().includes(kw)) palItems.push({ kind: "doc", label: d.name, sub: d.path, icon: "file", docId: d.id });
      });
      // 新建
      Object.values(FORMATS).forEach((f) => {
        if (!kw || f.name.toLowerCase().includes(kw) || f.id.includes(kw)) palItems.push({ kind: "new", label: `新建 ${f.name}`, sub: f.exts.join(" "), icon: "plus", formatId: f.id });
      });
      // 转换
      CONVERSIONS.forEach((c) => {
        const label = `转换：${FORMATS[c.from].name} → ${FORMATS[c.to].name}`;
        if (!kw || label.toLowerCase().includes(kw)) palItems.push({ kind: "conv", label, sub: c.ok ? c.tag : c.how, icon: "swap", conv: c, disabled: !c.ok });
      });
    }
    COMMANDS.forEach((c) => {
      if (!kw || c.label.toLowerCase().includes(kw) || c.group.includes(kw)) palItems.push({ kind: "cmd", label: c.label, icon: c.icon, kbd: c.kbd, cmd: c, ai: c.group === "ai", disabled: false });
    });

    if (!palItems.length) {
      list.appendChild(el("div", "palette-empty", `${I("search")}<span>没有匹配的命令或文档。直接按 Enter 会把「${esc(q)}」交给 AI。</span>`));
      palItems.push({ kind: "ask", label: `问 AI：${q}`, icon: "sparkles", ai: true });
    }

    let lastGroup = null;
    palItems.slice(0, 60).forEach((it, i) => {
      if (it.kind === "cmd" && it.cmd.group !== lastGroup) {
        lastGroup = it.cmd.group;
        list.appendChild(el("div", "palette-group", GROUP_LABEL[it.cmd.group] || it.cmd.group));
      }
      const b = el("button", "palette-item" + (it.ai ? " ai" : "") + (it.disabled ? " dis" : "") + (i === palIdx ? " sel" : ""));
      b.innerHTML = `${I(it.icon || "chevR")}<span class="lbl">${esc(it.label)}</span>${it.sub ? `<span class="sub">${esc(it.sub)}</span>` : ""}${it.kbd ? `<span class="kbd">${esc(it.kbd)}</span>` : ""}`;
      b.addEventListener("mouseenter", () => { palIdx = i; markSel(); });
      b.addEventListener("click", () => runPalette(it));
      list.appendChild(b);
    });
    $("#palette-count").textContent = `${Math.min(60, palItems.length)} / ${palItems.length} 项`;
  }

  function markSel() {
    $$("#palette-list .palette-item").forEach((b, i) => b.classList.toggle("sel", i === palIdx));
    const s = $("#palette-list .palette-item.sel");
    if (s) s.scrollIntoView({ block: "nearest" });
  }

  function runPalette(it) {
    if (!it || it.disabled) {
      if (it && it.disabled) toast({ icon: "alert", title: it.label, sub: it.conv ? it.conv.how : "不可用", warn: true });
      return;
    }
    closePalette();
    if (it.kind === "ask") { S.aiTab = "chat"; if (!S.aiOpen) toggleAI(); $("#ai-input").value = it.label.replace(/^问 AI：/, ""); syncSend(); aiSend(); return; }
    if (it.kind === "vision") { S.aiTab = "chat"; if (!S.aiOpen) toggleAI(); $("#ai-input").value = it.label; syncSend(); return; }
    if (it.kind === "doc") return activate(it.docId);
    if (it.kind === "new") return newDoc(it.formatId);
    if (it.kind === "conv") return runConvert(it.conv);
    runCommand(it.cmd.id);
  }

  function runCommand(id) {
    const map = {
      "palette": () => openPalette(),
      "ai.generate": () => focusAI("chat"),
      "ai.vision": () => dialogVision(),
      "ai.review": () => focusAI("review"),
      "ai.model": () => popModels($("#ai-model")),
      "ai.history": () => dialogHistory(),
      "ai.apply": () => { const m = lastWithCode(); if (m) aiAction("apply", m); else toast({ icon: "info", title: "还没有可应用的生成结果", sub: "先让 AI 生成一段代码" }); },
      "file.new": () => dialogNew(),
      "file.open": () => toast({ icon: "folderOpen", title: "打开文件", sub: "原型里从侧栏「资源管理器」点开" }),
      "file.save": () => doSave(),
      "file.saveAs": () => toast({ icon: "save", title: "另存为", sub: "文件类型跟随当前标签页格式，不恒为 .mmd" }),
      "file.recent": () => { S.sidebarView = "explorer"; S.sidebarOpen = true; syncLayout(); toast({ icon: "clock", title: "最近文件", sub: "侧栏「最近打开」一节，含搜索过滤（Ctrl+R）" }); },
      "file.cloud": () => { S.sidebarView = "cloud"; S.sidebarOpen = true; syncLayout(); },
      "view.settings": () => dialogSettings(),
      "view.settings.ai": () => dialogSettings("ai"),
      "view.settings.cloud": () => dialogSettings("cloud"),
      "view.mode.source": () => setMode("source"),
      "view.mode.split": () => setMode("split"),
      "view.mode.preview": () => setMode("preview"),
      "view.sidebar": () => toggleSidebar(),
      "view.ai": () => toggleAI(),
      "view.panel": () => togglePanel(),
      "view.activitybar": () => toggleActivity(),
      "view.fullscreen": () => zenMode(),
      "view.theme": () => toggleTheme(),
      "view.zoom.fit": () => setZoom(100),
      "view.zoom.in": () => setZoom(S.zoom + 10),
      "view.zoom.out": () => setZoom(S.zoom - 10),
      "conv.drawio": () => pickConvert("drawio"),
      "conv.excalidraw": () => pickConvert("excalidraw"),
      "conv.dot": () => pickConvert("dot"),
      "conv.center": () => { S.sidebarView = "convert"; S.sidebarOpen = true; syncLayout(); },
      "fmt.format": () => doFormat(),
      "fmt.layout": () => dialogLayout(),
      "exp.png": () => doExport("PNG"),
      "exp.svg": () => doExport("SVG"),
      "exp.copy": () => doExport("剪贴板"),
      "help.keys": () => dialogKeys(),
      "help.guide": () => dialogGuide(),
      "help.about": () => dialogAbout(),
      "help.update": () => toast({ icon: "refresh", title: "已是最新版本", sub: "v3.0.261010.0 · 24 小时冷却" }),
    };
    (map[id] || (() => toast({ icon: "info", title: id, sub: "原型未接线" })))();
  }

  function pickConvert(to) {
    const c = CONVERSIONS.find((x) => x.from === doc().format && x.to === to);
    if (!c) {
      toast({ icon: "alert", title: `${fmt().name} → ${FORMATS[to].name} 不支持`, sub: `当前只有 ${fmt().convertTo.length ? fmt().convertTo.join(" / ") : "无"} 这几个目标；详见转换中心`, warn: true });
      return;
    }
    runConvert(c);
  }

  function lastWithCode() {
    const arr = S.streams[S.aiTab];
    for (let i = arr.length - 1; i >= 0; i--) if (arr[i].code) return arr[i];
    return null;
  }

  function doExport(kind) {
    const d = doc();
    pushOutput(`导出 ${kind}：${d.name}（按元素数量自适应倍率 2.5x）`, "ok");
    toast({ icon: "download", title: kind === "剪贴板" ? "图片已复制到剪贴板" : `已导出 ${kind}`, sub: kind === "剪贴板" ? `${d.name} · 2.5x · 透明底` : `E:/Pictures/${d.name.replace(/\.[^.]+$/, "")}.png · 2.5x` });
    status(kind === "剪贴板" ? "图片已复制到剪贴板" : "已导出 " + kind, "ok");
  }

  /* ---- 弹层：对话框 --------------------------------------------------- */
  function openDialog(html, wide) {
    const d = $("#dialog");
    d.className = "dialog" + (wide ? " wide" : "");
    d.innerHTML = html;
    $("#overlay-dialog").hidden = false;
    return d;
  }
  function closeDialog() { $("#overlay-dialog").hidden = true; $("#dialog").innerHTML = ""; }

  function dialogHead(title, icon) {
    return `<div class="dialog-head">${I(icon || "info")}<h2>${esc(title)}</h2><span class="sp"></span><button class="icon-btn" data-close>${I("close", "ico-sm")}</button></div>`;
  }
  function dialogFoot(note, buttons) {
    return `<div class="dialog-foot">${note ? `<span class="note">${esc(note)}</span>` : ""}<span class="sp"></span>${buttons}</div>`;
  }
  function wireDialog(onPick) {
    const d = $("#dialog");
    d.addEventListener("click", (e) => {
      if (e.target.closest("[data-close]")) return closeDialog();
      const b = e.target.closest("[data-act]");
      if (b && onPick) onPick(b.dataset.act, b, d);
    });
  }

  /* 新建：按格式选，四种格式的能力一眼可比 */
  function dialogNew() {
    const cards = Object.values(FORMATS).map((f) => `
      <button class="new-card" data-act="new:${f.id}">
        <span class="nc-head"><span class="fmt-dot" data-fmt="${f.id}"></span><b>${esc(f.name)}</b><span class="chip ${f.id}">${f.surface === "canvas" ? "画布型" : "文本型"}</span></span>
        <span class="nc-ext">${f.exts.join(" · ")}</span>
        <span class="nc-note">${esc(f.note)}</span>
        <span class="nc-caps">
          ${f.splitView ? `<span class="cap on">${I("splitV", "ico-sm")}分屏</span>` : `<span class="cap off">${I("splitV", "ico-sm")}无分屏</span>`}
          ${f.ai ? `<span class="cap on">${I("sparkles", "ico-sm")}AI 直出</span>` : `<span class="cap">${I("swap", "ico-sm")}由 Mermaid 转换</span>`}
          ${f.layouts ? `<span class="cap on">${I("diagram", "ico-sm")}${f.layouts.length} 种布局</span>` : ""}
        </span>
      </button>`).join("");
    const d = openDialog(
      dialogHead("新建图表", "plus") +
      `<div class="dialog-body"><div class="new-grid">${cards}</div>
       <div class="callout mt">${I("sparkles")}<span><b>也可以让 AI 建：</b>按 <span class="kbd-inline">Ctrl+I</span> 描述你要的图，AI 会按当前格式生成代码；画布型格式则先生成 Mermaid 再一键转换。</span></div></div>` +
      dialogFoot("未保存的新文档在关闭时会提示保存", `<button class="btn ghost" data-close>取消</button>`),
      true
    );
    $$(".fmt-dot", d).forEach((x) => (x.style.background = FORMATS[x.dataset.fmt].color));
    wireDialog((act) => {
      if (act.startsWith("new:")) { closeDialog(); newDoc(act.slice(4)); }
    });
  }

  /* 转换对话框：源 → 目标 + 预览 + 单向说明 */
  function dialogConvert(preset) {
    const d = doc();
    const avail = CONVERSIONS.filter((c) => c.from === d.format);
    if (!avail.length) {
      return openDialog(
        dialogHead("转换", "swap") +
        `<div class="dialog-body"><div class="callout warn">${I("alert")}<span><b>${esc(FORMATS[d.format].name)} 目前不能作为转换源。</b><br>它是画布型格式：语义要从几何反推（矩形/箭头 → 节点/边），计划 v3.1 提供 drawio → Mermaid。当前可行的路子是让 AI 按这张图重新生成一份 Mermaid。</span></div>
        <div class="btn-row mt"><button class="btn ai" data-act="ai">${I("sparkles")}让 AI 生成 Mermaid</button><button class="btn ghost" data-act="center">${I("swap")}打开转换中心</button></div></div>` +
        dialogFoot("", `<button class="btn ghost" data-close>关闭</button>`)
      ) && wireDialog((a) => { closeDialog(); if (a === "ai") focusAI("chat"); else { S.sidebarView = "convert"; S.sidebarOpen = true; syncLayout(); } });
    }
    const sel = preset && preset.from === d.format ? preset : avail.find((c) => c.ok) || avail[0];
    const targets = avail.map((c) => `
      <button class="tgt ${c.to === sel.to ? "on" : ""} ${c.ok ? "" : "off"}" data-act="sel:${c.to}" ${c.ok ? "" : ""}>
        <span class="fmt-dot" data-fmt="${c.to}"></span>
        <b>${esc(FORMATS[c.to].name)}</b>
        <span class="tg-tag ${c.ok ? "ok" : "off"}">${esc(c.tag)}</span>
        <small>${esc(c.how)}</small>
      </button>`).join("");
    const out = sel.to === "dot" ? CONV_DOT_OUT : sel.to === "excalidraw" ? CONV_EXCALIDRAW_OUT : CONV_DRAWIO_OUT;
    const html =
      dialogHead(`转换：${FORMATS[sel.from].name} → ${FORMATS[sel.to].name}`, "swap") +
      `<div class="dialog-body">
        <div class="conv-flowline">
          <span class="chip ${sel.from}">${esc(FORMATS[sel.from].name)}</span>
          <span class="src-doc">${I("file", "ico-sm")}${esc(d.name)}</span>
          <span class="arrow">${I("chevR")} </span>
          <span class="chip ${sel.to}">${esc(FORMATS[sel.to].name)}</span>
          <span class="src-doc new">${esc(d.name.replace(/\.[^.]+$/, "") + FORMATS[sel.to].exts[0])}</span>
        </div>
        <div class="conv-cols">
          <div class="conv-col">
            <h4>选择目标格式</h4>
            <div class="tgts">${targets}</div>
          </div>
          <div class="conv-col">
            <h4>转换结果预览 <span class="meta">前 ${out.split("\n").length} 行</span></h4>
            <pre class="conv-pre">${esc(out)}</pre>
          </div>
        </div>
        <div class="callout warn">${I("alert")}<span><b>单向转换。</b>结果另开新标签页，<b>${esc(d.name)}</b> 保持不动；新标签页上的后续改动不会回写源文件。想反向同步请重新生成一次。</span></div>
       </div>` +
      dialogFoot(sel.ok ? "" : "该方向尚未实现，仅供查看计划",
        `<button class="btn ghost" data-close>取消</button><button class="btn primary" data-act="go" ${sel.ok ? "" : "disabled"}>${I("swap")}转换并打开新标签页</button>`);
    const dd = openDialog(html, true);
    $$(".fmt-dot", dd).forEach((x) => (x.style.background = FORMATS[x.dataset.fmt].color));
    wireDialog((act) => {
      if (act.startsWith("sel:")) { closeDialog(); dialogConvert(CONVERSIONS.find((c) => c.from === d.format && c.to === act.slice(4))); return; }
      if (act === "go") { closeDialog(); runConvert(sel); }
    });
  }

  /* 识图：截图 / 选文件 / 粘贴 + 目标格式 + 告知 */
  function dialogVision() {
    const d = doc();
    const html =
      dialogHead("识图：图片 → 图表代码", "scan") +
      `<div class="dialog-body">
        <div class="dropzone" data-act="pick">
          ${I("image", "ico-lg")}
          <b>拖入图片、点击选择，或直接 Ctrl+V 粘贴截图</b>
          <small>PNG / JPG / WebP · 大于 1568px 会自动压缩后再上传 · 图片只在内存里，不落盘、不进会话记录</small>
        </div>
        <div class="field-row mt">
          <div class="field"><label>输出格式</label>
            <select id="v-fmt">${Object.values(FORMATS).map((f) => `<option value="${f.id}" ${f.id === d.format ? "selected" : ""} ${f.ai ? "" : "disabled"}>${esc(f.name)}${f.ai ? "" : "（画布型，需先转 Mermaid）"}</option>`).join("")}</select>
            <span class="hint">画布型格式没有直出：先生成 Mermaid，再一键「应用为 drawio / Excalidraw」</span>
          </div>
          <div class="field"><label>模型档位</label>
            <select id="v-model">${AI_MODELS.map((m) => `<option value="${m.id}" ${m.id === "diagram-vision" ? "selected" : ""}>${esc(m.name)} · ${esc(m.sub)}</option>`).join("")}</select>
            <span class="hint">识图必须用视觉档；BYOK 需上游模型支持图片输入</span>
          </div>
        </div>
        <div class="field"><label>附加要求（可选）</label>
          <textarea id="v-note" rows="2" placeholder="例如：保留原图的分组框；把纵向改成横向；节点文字用中文"></textarea></div>
        <div class="callout">${I("info")}<span><b>识图上传告知。</b>选择图片后，该图片会发送到模型服务用于生成代码（BYOK 走你自己的上游，会员走 Diagramon 云网关）。本功能默认只在你主动点击时发生。</span></div>
       </div>` +
      dialogFoot("按 Esc 关闭", `<button class="btn ghost" data-close>取消</button><button class="btn ai" data-act="shot">${I("scan")}截取屏幕区域</button><button class="btn primary" data-act="go">${I("sparkles")}识别并生成</button>`);
    const dd = openDialog(html, true);
    let picked = null;
    $(".dropzone", dd).addEventListener("click", () => {
      picked = { name: "screenshot-1142.png", size: "612 KB · 1568×982（已压缩）" };
      $(".dropzone", dd).innerHTML = `<span class="pic">${I("image", "ico-lg")}</span><b>${esc(picked.name)}</b><small>${esc(picked.size)} · 点击可重新选择</small>`;
      $(".dropzone", dd).classList.add("picked");
    });
    wireDialog((act) => {
      if (act === "shot") {
        closeDialog();
        toast({ icon: "scan", title: "已进入区域截图", sub: "框选后自动回填到 AI 面板（原型里直接模拟结果）" });
        picked = { name: "屏幕区域截图.png", size: "318 KB · 1180×640" };
        setTimeout(() => {
          S.aiTab = "vision"; S.attachment = picked; S.aiOpen = true; syncLayout(); renderAI();
          $("#ai-input").value = "把这张截图转成 " + FORMATS[doc().format].name;
          syncSend();
          aiSend();
        }, 700);
        return;
      }
      if (act === "go") {
        closeDialog();
        S.aiTab = "vision";
        S.aiOpen = true;
        S.attachment = picked || { name: "示例图片.png", size: "486 KB · 1440×900（已压缩）" };
        syncLayout();
        renderAI();
        $("#ai-input").value = ($("#v-note") && $("#v-note").value) || "把这张图转成 " + FORMATS[doc().format].name;
        syncSend();
        aiSend();
      }
    });
  }

  /* 设置：外观（主题）/ 编辑器与视图 / AI / 转换 / 云端 */
  function dialogSettings(tab) {
    const t = tab || "appearance";
    const html =
      dialogHead("设置", "settings") +
      `<div class="dialog-body has-tabs">
        <div class="dlg-tabs">${SETTINGS_TABS.map((x) => `<button class="dlg-tab ${x.id === t ? "on" : ""}" data-act="tab:${x.id}">${I(x.icon, "ico-sm")}${esc(x.label)}</button>`).join("")}</div>
        <div class="dlg-pane">${settingsPane(t)}</div>
       </div>` +
      dialogFoot("设置写入 settings.json；API Key 走系统凭据库（Windows DPAPI），不进 settings.json",
        `<button class="btn ghost" data-close>关闭</button><button class="btn primary" data-act="save">${I("check")}保存</button>`);
    const dd = openDialog(html, true);
    wireDialog((act) => {
      if (act.startsWith("tab:")) { closeDialog(); dialogSettings(act.slice(4)); return; }
      if (act === "save") {
        closeDialog();
        toast({ icon: "check", title: "设置已保存", sub: "布局比例、面板开合状态与主题都会记住" });
      }
    });
    // 主题卡片实时预览
    $$("[data-theme-pick]", dd).forEach((b) => b.addEventListener("mouseenter", () => {
      $$("[data-theme-pick]", dd).forEach((x) => x.classList.toggle("on", x === b));
    }));
    $$("[data-density]", dd).forEach((b) => b.addEventListener("click", () => {
      $$("[data-density]", dd).forEach((x) => x.classList.toggle("on", x === b));
      document.body.dataset.density = b.dataset.density;
    }));
    $$("[data-theme-pick]", dd).forEach((b) => b.addEventListener("click", () => {
      $$("[data-theme-pick]", dd).forEach((x) => x.classList.toggle("on", x === b));
      const v = b.dataset.themePick;
      if (v === "auto") {
        setTheme(matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
        toast({ icon: "palette", title: "跟随系统", sub: "当前系统偏好：" + (matchMedia("(prefers-color-scheme: dark)").matches ? "暗色" : "亮色") });
      } else setTheme(v);
    }));
    $$("[data-accent]", dd).forEach((b) => b.addEventListener("click", () => {
      $$("[data-accent]", dd).forEach((x) => x.classList.toggle("on", x === b));
      document.documentElement.dataset.accent = b.dataset.accent;
    }));
    $$("[data-pct]", dd).forEach((n) => { n.style.width = n.dataset.pct + "%"; });
    $$("[data-act^=mode:]", dd).forEach((b) => b.addEventListener("click", () => {
      $$("[data-act^=mode:]", dd).forEach((x) => x.classList.toggle("on", x === b));
      setMode(b.dataset.act.slice(5));
    }));
  }

  function settingsPane(t) {
    if (t === "appearance") return `
      <div class="field"><label>主题</label>
        <div class="theme-picks">
          <button class="theme-pick ${S.theme === "light" ? "on" : ""}" data-theme-pick="light">
            <span class="tp-prev light"><i class="a"></i><i class="b"></i><i class="c"></i></span><b>亮色</b><small>淡雅冷灰白 + 松绿</small>
          </button>
          <button class="theme-pick ${S.theme === "dark" ? "on" : ""}" data-theme-pick="dark">
            <span class="tp-prev dark"><i class="a"></i><i class="b"></i><i class="c"></i></span><b>暗色</b><small>深灰底 + 提亮的松绿</small>
          </button>
          <button class="theme-pick" data-theme-pick="auto">
            <span class="tp-prev auto"><i class="a"></i><i class="b"></i><i class="c"></i></span><b>跟随系统</b><small>prefers-color-scheme</small>
          </button>
        </div>
        <span class="hint">真实实现里，主题变量还要下发给四个渲染页（mermaid / graphviz / drawio / excalidraw），让画布跟着一起换色。</span>
      </div>
      <div class="field"><label>界面密度</label>
        <div class="seg">${["紧凑", "标准", "宽松"].map((x, i) => `<button data-density="${["compact", "normal", "roomy"][i]}" class="${i === 1 ? "on" : ""}">${x}</button>`).join("")}</div>
        <span class="hint">影响字号、行高与控件高度；原型里改的是 body[data-density]</span>
      </div>
      <div class="field"><label>强调色</label>
        <div class="swatch-row">
          ${ACCENTS.map(([n, key], i) => `<button class="swatch ${i === 0 ? "on" : ""}" data-accent="${key}" title="${n}"><i class="sw-${key}"></i></button>`).join("")}
        </div>
        <span class="hint">只换 --accent 一族变量，语义色（成功/警告/错误）与格式标识色不动</span>
      </div>
      ${switchRow(true, "画布显示点阵背景", "关掉后是纯色底，导出图片时总是纯色")}
      ${switchRow(true, "标签页显示格式色圆点", "四种格式一眼可分")}
      ${switchRow(false, "减少动效", "面板开合与抽屉过渡改为瞬时")}
    `;
    if (t === "editor") return `
      <div class="field"><label>默认视图模式（文本型格式）</label>
        <div class="seg">${[["仅源码", "source"], ["分屏", "split"], ["仅预览", "preview"]].map(([n, v], i) => `<button class="${i === 1 ? "on" : ""}" data-act="mode:${v}">${n}</button>`).join("")}</div>
        <span class="hint">Mermaid 与 DOT 支持三态；drawio / Excalidraw 恒为「画布即编辑器」</span>
      </div>
      <div class="field-row">
        <div class="field"><label>源码与预览的比例</label><input type="text" value="46 : 54" readonly><span class="hint">拖动分隔条即时生效并记住</span></div>
        <div class="field"><label>渲染防抖</label><input type="text" value="350 ms" readonly><span class="hint">停止输入后触发渲染</span></div>
      </div>
      ${switchRow(true, "记住每个标签页各自的视图模式", "关掉后所有标签页共用一个模式")}
      ${switchRow(true, "编辑器行号与当前行高亮", "")}
      ${switchRow(true, "语法校验（本机完成）", "报错会进「问题」面板并标出行号")}
      ${switchRow(false, "自动保存", "失焦或停止输入 2 秒后写入磁盘")}
      <div class="field"><label>字体</label>
        <div class="field-row">
          <div class="field"><input type="text" value="Cascadia Code, JetBrains Mono" readonly></div>
          <div class="field narrow"><input type="text" value="13 px" readonly></div>
        </div>
      </div>
      <div class="callout">${I("keyboard")}<span>面板与视图的快捷键见<b>帮助 → 键盘快捷键总表</b>；这套沿用 VS Code 的肌肉记忆（Ctrl+B / Ctrl+J / Ctrl+1~3 / Ctrl+Shift+P）。</span></div>
    `;
    if (t === "ai") return `
      <div class="field"><label>接入方式</label>
        <div class="seg"><button class="on">Diagramon 云网关（会员）</button><button>BYOK 直连自己的上游</button></div>
        <span class="hint">云网关：凭据是当前 access token，每次现取、不落盘；额度按信用点计。BYOK：Key 存进系统凭据库</span>
      </div>
      <div class="field-row">
        <div class="field"><label>本周期额度</label><input type="text" value="${USAGE.used} / ${USAGE.total} 信用点" readonly><span class="hint">${esc(USAGE.period)}</span></div>
        <div class="field"><label>默认档位</label><select>${AI_MODELS.map((m) => `<option>${esc(m.name)}</option>`).join("")}</select><span class="hint">选「自动选档」时由服务端按请求内容选档</span></div>
      </div>
      ${switchRow(true, "把当前图表源码作为上下文", "AI 面板顶部会显示上下文来自哪个文件")}
      ${switchRow(true, "渲染失败时把报错原文发回模型修正一次", "这是第二次真实调用，会计入用量")}
      ${switchRow(true, "识图前显示上传告知", "首次使用后不再重复弹")}
      ${switchRow(false, "生成后自动应用到编辑器", "默认要你点「应用」，避免覆盖未保存的改动")}
      <div class="field"><label>模型档位与单价</label>
        <table class="kv">${AI_MODELS.map((m) => `<tr><td><span class="chip ai">${esc(m.name)}</span></td><td>${esc(m.sub)}</td></tr>`).join("")}</table>
      </div>
      <div class="field"><label>对话历史</label>
        <div class="field-row"><div class="field"><input type="text" value="%APPDATA%/Diagramon/Conversations" readonly></div><button class="btn sm">浏览…</button><button class="btn sm ghost">打开目录</button></div>
        <span class="hint">按文档稳定身份（路径 SHA256）保存，支持连续多轮</span>
      </div>
    `;
    if (t === "convert") return `
      <div class="field"><label>格式注册表（单一真源：crates/app-core/src/format.rs）</label>
        <table class="kv">${Object.values(FORMATS).map((f) => `<tr>
          <td><span class="chip ${f.id}">${esc(f.name)}</span></td>
          <td>${f.exts.join(" ")}</td>
          <td>${f.surface === "canvas" ? "画布承载" : "页内渲染"}</td>
          <td>${f.splitView ? "支持分屏" : "—"}</td>
          <td>${f.convertTo.length ? "→ " + f.convertTo.join(" / ") : "不作为源"}</td>
        </tr>`).join("")}</table>
      </div>
      ${switchRow(true, "转换结果另开新标签页", "关掉会替换当前标签页（不推荐：原文件就丢了视图）")}
      ${switchRow(true, "转换后自动做一次语法校验", "有报错会在「问题」面板列出")}
      ${switchRow(false, "保留源文件里的注释", "Mermaid → DOT 时把 %% 注释转成 // 注释")}
      <div class="callout warn">${I("alert")}<span><b>关于反向转换。</b>drawio / Excalidraw → Mermaid 需要几何反推语义，计划 v3.1；在此之前，转换中心会把不可用方向<b>列出来并给理由</b>，而不是藏起来。</span></div>
      <div class="field"><label>DOT 布局引擎</label>
        <div class="seg">${FORMATS.dot.layouts.map((l, i) => `<button class="${i === 0 ? "on" : ""}">${l}</button>`).join("")}</div>
        <span class="hint">切换走增量更新，不重载 WASM；仅对 DOT 标签页显示</span>
      </div>
    `;
    return `
      <div class="field"><label>账户</label>
        <div class="acct"><span class="avatar">道</span><span class="who"><b>道荣</b><small>westsource@126.com</small></span><span class="chip">Pro 会员 · 2026-11-03 到期</span><span class="sp grow"></span><button class="btn sm ghost">退出登录</button></div>
      </div>
      <div class="field"><label>本周期用量</label>
        <div class="meter lg ok mb"><span data-pct="${Math.round((USAGE.used / USAGE.total) * 100)}"></span></div>
        <span class="hint">${USAGE.used} / ${USAGE.total} 信用点 · 周期 ${esc(USAGE.period)} · 在途预留 ${USAGE.reserved}（不计入已用，但计入可用余额）</span>
      </div>
      ${switchRow(true, "启动时检查更新（24 小时冷却）", "")}
      ${switchRow(true, "离线守卫：拦截非本机 origin 的外发请求", "每次拦截都会显示到状态栏，避免上游偷偷联网")}
      ${switchRow(false, "把匿名使用统计发给 Diagramon", "不含图表内容")}
      <div class="field"><label>数据与迁移</label>
        <table class="kv">
          <tr><td>settings.json</td><td>%APPDATA%/Diagramon/settings.json</td></tr>
          <tr><td>secure.config</td><td>API Key（DPAPI 加密，按当前用户）</td></tr>
          <tr><td>crash.log</td><td>%LOCALAPPDATA%/Diagramon/crash.log</td></tr>
          <tr><td>旧版迁移</td><td>Mermaider → Diagramon（启动首句执行）</td></tr>
        </table>
      </div>
    `;
  }

  function switchRow(on, label, sub) {
    return `<div class="switch ${on ? "on" : ""}" data-switch><span class="track"></span><span class="txt">${esc(label)}${sub ? `<small>${esc(sub)}</small>` : ""}</span></div>`;
  }

  /* 快捷键总表 */
  function dialogKeys() {
    const html = dialogHead("键盘快捷键", "keyboard") +
      `<div class="dialog-body">${SHORTCUTS.map((g) => `
        <h4 class="keys-g">${esc(g.g)}</h4>
        <table class="kv keys">${g.rows.map(([k, v]) => `<tr><td class="kcell"><span class="kbd-inline">${esc(k)}</span></td><td>${esc(v)}</td></tr>`).join("")}</table>`).join("")}
       </div>` +
      dialogFoot("这套键位沿用 VS Code 的肌肉记忆；画布手势四种格式一致", `<button class="btn ghost" data-close>关闭</button>`);
    openDialog(html, true);
    wireDialog(() => {});
  }

  function dialogGuide() {
    openDialog(
      dialogHead("操作说明", "info") +
      `<div class="dialog-body prose">
        <h4>AI 是第一公民</h4>
        <p>任何时候按 <span class="kbd-inline">Ctrl+I</span> 唤起 AI，当前图表的源码会自动作为上下文。三件事最常见：描述一句话生成、截一张图逆向成代码（<span class="kbd-inline">Ctrl+Shift+I</span>）、让它审查并局部改当前图。生成结果永远要你点「应用」，不会直接覆盖未保存的正文。</p>
        <h4>四种格式，两种承载</h4>
        <p><b>Mermaid</b> 与 <b>Graphviz DOT</b> 是文本型：左侧源码、右侧预览，可分屏，也可以把源码窗口整个隐藏只看图（<span class="kbd-inline">Ctrl+3</span>）。DOT 另有六种布局引擎，在状态栏切换。<b>drawio</b> 与 <b>Excalidraw</b> 是画布型：画布即编辑器，没有源码分屏，但磁盘上仍是可 diff 的 XML / JSON 文本，保存与最近文件走同一条链路。</p>
        <h4>画布手势（四处一致）</h4>
        <p>滚轮平移 · Shift+滚轮横向平移 · Ctrl+滚轮以光标为中心缩放 · 拖拽平移 · 双击或 <span class="kbd-inline">Ctrl+0</span> 适应视图。</p>
        <h4>格式转换是单向的</h4>
        <p>Mermaid → drawio / Excalidraw / DOT。结果另开新标签页，原文件不动，画布上的后续改动不回写源码。转换中心会把不可用的方向也列出来并说明原因，不藏。</p>
        <h4>面板</h4>
        <p>沿用 VS Code：<span class="kbd-inline">Ctrl+B</span> 侧栏、<span class="kbd-inline">Ctrl+J</span> 底部面板、<span class="kbd-inline">Ctrl+Shift+A</span> AI 面板、<span class="kbd-inline">Ctrl+Shift+P</span> 命令面板、<span class="kbd-inline">Ctrl+Shift+F</span> 全屏预览（一次隐藏所有面板）。所有开合状态与比例都会记住。</p>
        <h4>本地优先</h4>
        <p>渲染与语法检查全在本机完成，随包分发运行时，零外部请求。只有你主动使用 AI 时，相关代码或图片才会发到模型服务。</p>
       </div>` +
      dialogFoot("", `<button class="btn ghost" data-close>关闭</button>`),
      true
    );
    wireDialog(() => {});
  }

  function dialogAbout() {
    openDialog(
      dialogHead("关于 Diagramon", "logo") +
      `<div class="dialog-body about">
        <div class="ab-hero"><span class="ab-logo">${I("logo", "ico-lg")}</span><div><h3>Diagramon</h3><p>多格式图表编辑器 · 本地优先 · AI 第一公民</p></div></div>
        <table class="kv">
          <tr><td>版本</td><td>dev3.0 原型（v3.0.261010.0）</td></tr>
          <tr><td>技术栈</td><td>Rust + Tauri 2 + 系统 WebView（Windows: WebView2 / macOS: WKWebView / Linux: WebKitGTK 4.1）</td></tr>
          <tr><td>格式</td><td>Mermaid · Graphviz DOT · drawio · Excalidraw</td></tr>
          <tr><td>渲染</td><td>mermaid.js · @hpcc-js/wasm-graphviz · drawio（自托管）· Excalidraw（库型集成），均随包分发</td></tr>
          <tr><td>编辑器</td><td>CodeMirror 6（行号、语法高亮、查找替换）</td></tr>
          <tr><td>作者</td><td>道荣 &amp; 黄超</td></tr>
          <tr><td>许可</td><td>Apache-2.0</td></tr>
        </table>
        <div class="callout">${I("info")}<span>这个窗口是<b>界面原型</b>：数据、图形与调用结果都是示意，不连真实渲染引擎与网络。</span></div>
       </div>` +
      dialogFoot("", `<button class="btn ghost" data-close>关闭</button><button class="btn primary" data-act="ok">确定</button>`)
    );
    wireDialog((a) => { if (a === "ok") closeDialog(); });
  }

  function dialogHistory() {
    const rows = [
      { t: "今天 11:43", doc: "登录流程.mmd", n: 6, last: "把「失败次数 +1」改成直接锁定…" },
      { t: "今天 10:12", doc: "渲染管线.dot", n: 3, last: "把缓存节点画成圆柱体" },
      { t: "昨天 18:20", doc: "支付回调.mmd", n: 11, last: "补上对账失败的补偿分支" },
      { t: "昨天 09:05", doc: "白板照片 → mermaid", n: 2, last: "识图：手写节点「风控复核」" },
    ];
    openDialog(
      dialogHead("历史会话", "history") +
      `<div class="dialog-body"><div class="hist-list">${rows.map((r) => `
        <button class="hist-row" data-act="open">
          <span class="hr-main"><b>${esc(r.doc)}</b><span>${esc(r.last)}</span></span>
          <span class="hr-side"><span>${r.n} 轮</span><span>${esc(r.t)}</span></span>
        </button>`).join("")}</div>
        <div class="callout mt">${I("info")}<span>对话按文档稳定身份（路径 SHA256）持久化，路径可在设置里改。清空只影响当前文档。</span></div>
       </div>` +
      dialogFoot("", `<button class="btn ghost" data-act="clear">${I("trash")}清空当前文档的对话</button><span class="sp"></span><button class="btn ghost" data-close>关闭</button>`)
    );
    wireDialog((a) => {
      if (a === "open") { closeDialog(); focusAI("chat"); }
      if (a === "clear") { S.streams.chat = []; closeDialog(); renderAI(); toast({ icon: "trash", title: "对话已清空", sub: "只清了当前文档的会话" }); }
    });
  }

  function dialogLayoutEngine() { return dialogLayout(); }
  function dialogLayout() {
    const d = doc();
    openDialog(
      dialogHead("DOT 布局引擎", "diagram") +
      `<div class="dialog-body"><div class="seg seg-lg">${FORMATS.dot.layouts.map((l) => `<button data-act="lay:${l}" class="${(d.layout || "dot") === l ? "on" : ""}">${l}</button>`).join("")}</div>
      <p class="lay-note">切换走增量更新，<b>不重载 WASM</b>。仅 DOT 标签页显示该选择器；状态栏右侧也能直接切。</p>
      <table class="kv">${[["dot", "分层有向图（默认，最常用）"], ["neato", "弹簧模型，无向图更自然"], ["fdp", "力导向，适合网状"], ["sfdp", "大规模力导向（多分辨率）"], ["twopi", "径向布局，以根为中心"], ["circo", "环形布局，适合有环依赖"]].map(([k, v]) => `<tr><td class="kcell"><span class="kbd-inline">${k}</span></td><td>${v}</td></tr>`).join("")}</table>
      </div>` + dialogFoot("", `<button class="btn ghost" data-close>关闭</button>`)
    );
    wireDialog((a) => {
      if (a.startsWith("lay:")) { d.layout = a.slice(4); closeDialog(); renderPreview(); renderStatus(); status("布局已切换为 " + d.layout, "ok"); pushOutput("DOT 布局切换 → " + d.layout + "（增量更新，未重载 WASM）", "ok"); }
    });
  }

  function dialogUnsaved(d, cb) {
    openDialog(
      dialogHead("未保存的更改", "alert") +
      `<div class="dialog-body"><p class="dlg-p">「<b>${esc(d.name)}</b>」有未保存的更改。要保存吗？</p><p class="dlg-sub">不保存的话，这些更改会丢失。</p></div>` +
      `<div class="dialog-foot"><button class="btn ghost" data-act="cancel">取消</button><span class="sp"></span><button class="btn ghost" data-act="dont">不保存</button><button class="btn primary" data-act="save">${I("save")}保存</button></div>`
    );
    wireDialog((a) => { closeDialog(); cb(a); });
  }

  /* ---- 弹出菜单（pop） ------------------------------------------------ */
  function showPop(items, pos, onPick, id, container) {
    const p = $(container || "#pop");
    p.hidden = false;
    p.innerHTML = "";
    p.className = "pop" + (id === "menu" ? " menu" : "") + (id === "submenu" ? " sub" : "");
    items.forEach((it) => {
      if (it.sep) { p.appendChild(el("div", "pop-sep")); return; }
      if (it.label2) { p.appendChild(el("div", "pop-label", it.label2)); return; }
      const b = el("button", "pop-row" + (it.check ? " check" : "") + (it.on ? " on" : ""));
      b.innerHTML =
        (it.check ? "" : it.icon ? I(it.icon, "ico-sm") : `<span class="ico-slot"></span>`) +
        `<span class="lbl">${esc(it.label)}</span>` +
        (it.children ? `<span class="kbd arrow-sub">${I("chevR", "ico-sm")}</span>` : "") +
        (it.kbd && !it.children ? `<span class="kbd">${esc(it.kbd)}</span>` : "");
      if (it.disabled) b.disabled = true;
      b.addEventListener("click", (e) => { e.stopPropagation(); if (!it.disabled) onPick(it, b); });
      if (it.children) {
        // 悬停即展开二级（Windows 桌面菜单的习惯），点击也可展开
        b.addEventListener("mouseenter", () => onPick(it, b, true));
      }
      p.appendChild(b);
    });
    // 定位（避免溢出视口）
    const r = p.getBoundingClientRect();
    let x = pos.x, y = pos.y;
    if (x + r.width > innerWidth - 8) x = innerWidth - r.width - 8;
    if (y + r.height > innerHeight - 8) y = Math.max(8, pos.y - r.height - (pos.flip || 28));
    p.style.left = x + "px";
    p.style.top = y + "px";
  }
  function hidePop() {
    const p = $("#pop"); p.hidden = true; p.innerHTML = "";
    hideSub();
  }

  function popModels(anchor) {
    const r = anchor.getBoundingClientRect();
    showPop(
      [{ label2: "选择模型档位" }].concat(
        AI_MODELS.map((m) => ({ label: m.name, sub: m.id === S.aiModel ? "当前" : "", icon: "robot", model: m.id })),
        [{ sep: true }, { label: "AI 设置…", icon: "settings", act: "settings" }]
      ),
      { x: r.left - 160, y: r.bottom + 6, flip: 0 },
      (it) => {
        hidePop();
        if (it.act === "settings") return dialogSettings("ai");
        S.aiModel = it.model;
        renderAI(); renderStatus();
        const m = AI_MODELS.find((x) => x.id === S.aiModel);
        toast({ icon: "robot", title: "已切换到 " + m.name, sub: m.sub, ai: true });
      }
    );
  }

  function popLayouts(anchor) {
    const d = doc();
    const r = anchor.getBoundingClientRect();
    showPop(
      [{ label2: "DOT 布局引擎（增量更新，不重载 WASM）" }].concat(
        FORMATS.dot.layouts.map((l) => ({ label: l, icon: "diagram", on: (d.layout || "dot") === l, lay: l })),
        [{ sep: true }, { label: "布局说明…", icon: "info", act: "more" }]
      ),
      { x: r.left - 120, y: r.top - 6, flip: r.height + 8 },
      (it) => {
        hidePop();
        if (it.act === "more") return dialogLayout();
        d.layout = it.lay;
        renderPreview(); renderStatus();
        status("布局已切换为 " + it.lay, "ok");
        pushOutput("DOT 布局切换 → " + it.lay, "ok");
      }
    );
  }

  /** 「自定义布局」：VS Code 那个右上角的开关面板。 */
  function popLayoutPicker(anchor) {
    const r = anchor.getBoundingClientRect();
    showPop(
      [
        { label2: "面板" },
        { label: "活动栏", icon: "layers", check: true, on: S.activityOpen, act: "act" },
        { label: "侧栏（资源管理器 / 搜索 / 转换 / 云端 / 大纲）", icon: "panelLeft", check: true, on: S.sidebarOpen, kbd: "Ctrl+B", act: "side" },
        { label: "AI 面板", icon: "sparkles", check: true, on: S.aiOpen, kbd: "Ctrl+Shift+A", act: "ai" },
        { label: "底部面板（问题 / 输出 / 转换记录 / 用量）", icon: "panelBottom", check: true, on: S.panelOpen, kbd: "Ctrl+J", act: "panel" },
        { sep: true },
        { label2: "视图模式" },
        { label: "仅源码", icon: "code", check: true, on: S.mode === "source" && isText(), act: "m-source" },
        { label: "源码与预览分屏", icon: "splitV", check: true, on: S.mode === "split" && isText(), act: "m-split" },
        { label: "仅预览（隐藏源码窗口）", icon: "eye", check: true, on: S.mode === "preview", act: "m-preview" },
        { sep: true },
        { label: "全屏预览（隐藏所有面板）", icon: "maximize", kbd: "Ctrl+Shift+F", act: "zen" },
        { label: "恢复默认布局", icon: "refresh", act: "reset" },
        { label: S.theme === "light" ? "切换到暗色主题" : "切换到亮色主题", icon: S.theme === "light" ? "moon" : "sun", kbd: "Ctrl+K Ctrl+T", act: "theme" },
        { label: "外观与设置…", icon: "settings", act: "settings" },
      ],
      { x: r.left - 300, y: r.bottom + 6 },
      (it) => {
        const reopen = it.act.startsWith("act") || it.act === "side" || it.act === "ai" || it.act === "panel" || it.act.startsWith("m-");
        if (!reopen) hidePop();
        switch (it.act) {
          case "act": toggleActivity(); break;
          case "side": toggleSidebar(); break;
          case "ai": toggleAI(); break;
          case "panel": togglePanel(); break;
          case "m-source": setMode("source"); break;
          case "m-split": setMode("split"); break;
          case "m-preview": setMode("preview"); break;
          case "zen": return zenMode();
          case "theme": return toggleTheme();
          case "settings": return dialogSettings("appearance");
          case "reset":
            S.activityOpen = S.sidebarOpen = S.aiOpen = S.panelOpen = true;
            setMode(isText() ? "split" : "preview", true);
            syncLayout();
            return toast({ icon: "refresh", title: "已恢复默认布局", sub: "活动栏 + 侧栏 + 分屏 + AI 面板 + 底部面板" });
        }
        if (reopen) { syncLayout(); popLayoutPicker(anchor); }
      },
      "menu"
    );
  }

  /* ---- toast ---------------------------------------------------------- */
  function toast(o) {
    const box = $("#toasts");
    const t = el("div", "toast" + (o.ai ? " ai" : "") + (o.warn ? " warn" : "") + (o.err ? " err" : ""));
    t.innerHTML = `${I(o.icon || "info")}<span class="bd"><b>${esc(o.title)}</b>${o.sub ? `<span>${esc(o.sub)}</span>` : ""}</span>` +
      (o.action ? `<button class="act">${esc(o.action.label)}</button>` : "");
    if (o.action) $(".act", t).addEventListener("click", () => { o.action.fn(); t.remove(); });
    box.appendChild(t);
    setTimeout(() => { t.style.opacity = "0"; t.style.transform = "translateY(4px)"; t.style.transition = ".2s"; setTimeout(() => t.remove(), 220); }, o.action ? 6000 : 3600);
  }

  function copyText(s) {
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(s);
      else {
        const ta = el("textarea");
        ta.value = s; document.body.appendChild(ta); ta.select(); document.execCommand("copy"); ta.remove();
      }
    } catch (e) {}
  }

  /* ---- 9. 快捷键、拖拽、事件接线 ------------------------------------ */
  function bind() {
    // 主题
    $("#btn-theme").addEventListener("click", toggleTheme);
    $("#btn-cmd").addEventListener("click", openPalette);
    $("#btn-layout").addEventListener("click", (e) => popLayoutPicker(e.currentTarget));

    // 侧栏
    $("#side-close").addEventListener("click", toggleSidebar);
    $("#side-more").addEventListener("click", (e) => {
      const r = e.currentTarget.getBoundingClientRect();
      showPop(
        ACTS.map((a) => ({ label: a.label, icon: a.icon, kbd: a.kbd, on: S.sidebarView === a.id, view: a.id, check: true }))
          .concat([{ sep: true }, { label: "隐藏侧栏", icon: "close", kbd: "Ctrl+B", act: "hide" }]),
        { x: r.left, y: r.bottom + 4 },
        (it) => { hidePop(); if (it.act === "hide") toggleSidebar(); else { S.sidebarView = it.view; S.sidebarOpen = true; syncLayout(); } }
      );
    });

    // 标签
    $("#tab-add").addEventListener("click", () => dialogNew());
    $("#tab-more").addEventListener("click", (e) => {
      const r = e.currentTarget.getBoundingClientRect();
      showPop([
        { label: "关闭", icon: "close", kbd: "Ctrl+W", act: "close" },
        { label: "关闭其他", icon: "close", act: "others" },
        { label: "关闭全部", icon: "close", act: "all" },
        { sep: true },
        { label: "复制路径", icon: "copy", act: "path" },
        { label: "在资源管理器中显示", icon: "folderOpen", act: "reveal" },
        { sep: true },
        { label: "转换为…", icon: "swap", act: "conv" },
      ], { x: r.left - 170, y: r.bottom + 4 }, (it) => {
        hidePop();
        if (it.act === "close") closeDoc(S.docId);
        else if (it.act === "conv") dialogConvert();
        else if (it.act === "path") { copyText(doc().path); toast({ icon: "copy", title: "路径已复制", sub: doc().path }); }
        else if (it.act === "others") { DOCS.slice().forEach((d) => { if (d.id !== S.docId) { d.dirty = false; reallyClose(DOCS.indexOf(d)); } }); }
        else if (it.act === "all") { DOCS.slice().forEach((d) => { d.dirty = false; reallyClose(0); }); }
        else toast({ icon: "info", title: it.label, sub: "原型未接线" });
      });
    });

    // 视图模式
    $("#viewmodes").addEventListener("click", (e) => {
      const b = e.target.closest("button[data-mode]");
      if (b) setMode(b.dataset.mode);
    });
    $("#btn-hide-source").addEventListener("click", () => setMode("preview"));
    $("#btn-show-source").addEventListener("click", () => setMode("source"));
    $("#btn-format").addEventListener("click", doFormat);
    $("#btn-find").addEventListener("click", () => toast({ icon: "search", title: "查找替换", sub: "Ctrl+F · CodeMirror SearchPanel" }));
    $("#btn-src-ai").addEventListener("click", () => focusAI("review"));
    $("#btn-fit").addEventListener("click", () => setZoom(100));
    $("#btn-convert").addEventListener("click", () => dialogConvert());
    $("#zoom-in").addEventListener("click", () => setZoom(S.zoom + 10));
    $("#zoom-out").addEventListener("click", () => setZoom(S.zoom - 10));
    $("#zoom-fit").addEventListener("click", () => setZoom(100));
    $("#btn-export").addEventListener("click", (e) => {
      const r = e.currentTarget.getBoundingClientRect();
      showPop([
        { label: "导出 PNG（自适应倍率）", icon: "download", act: "png" },
        { label: "导出 PNG（固定倍率…）", icon: "download", act: "fix" },
        { label: "导出 SVG", icon: "download", act: "svg" },
        { sep: true },
        { label: "复制图片到剪贴板", icon: "copy", kbd: "Ctrl+Shift+C", act: "clip" },
      ], { x: r.left - 190, y: r.top - 6, flip: r.height + 8 }, (it) => {
        hidePop();
        if (it.act === "fix") return toast({ icon: "download", title: "固定倍率导出", sub: "设置 → 图片倍率：1.5x ~ 5.0x" });
        doExport(it.act === "clip" ? "剪贴板" : it.act.toUpperCase());
      });
    });
    $("#btn-copy-img").addEventListener("click", () => doExport("剪贴板"));

    // 画布手势（原型：滚轮缩放、拖拽平移示意）
    const vp = $("#canvas-viewport");
    vp.addEventListener("wheel", (e) => {
      if (!e.ctrlKey) return;
      e.preventDefault();
      setZoom(S.zoom + (e.deltaY < 0 ? 10 : -10));
    }, { passive: false });
    vp.addEventListener("dblclick", () => setZoom(100));

    // AI
    $("#ai-close").addEventListener("click", toggleAI);
    $("#ai-clear").addEventListener("click", () => {
      S.streams[S.aiTab] = [];
      renderAI();
      toast({ icon: "trash", title: "对话已清空", sub: "只清了「" + $("#ai-tabs .ai-tab.on").textContent + "」这一路" });
    });
    $("#ai-history").addEventListener("click", dialogHistory);
    $("#ai-model").addEventListener("click", (e) => popModels(e.currentTarget));
    $("#ai-tabs").addEventListener("click", (e) => { const b = e.target.closest("[data-ai]"); if (b) setAITab(b.dataset.ai); });
    $("#ai-send").addEventListener("click", aiSend);
    $("#ai-input").addEventListener("input", syncSend);
    $("#ai-input").addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); aiSend(); }
    });
    $("#ai-attach").addEventListener("click", () => {
      S.attachment = { name: "IMG_20261010_1145.png", size: "1.2 MB · 2048×1536 → 已压到 1568px" };
      if (S.aiTab !== "vision") S.aiTab = "vision";
      renderAI();
      toast({ icon: "image", title: "已添加图片", sub: "图片只在内存里，不落盘、不进会话记录", ai: true });
    });
    $("#ai-screenshot").addEventListener("click", dialogVision);
    $("#ai-context").addEventListener("click", () => {
      setAITab("review");
      toast({ icon: "diagram", title: "已把当前图作为上下文", sub: doc().name + " · " + doc().src.split("\n").length + " 行", ai: true });
    });

    // 底部面板 tab 上的「问题」直接跳
    // 命令面板输入
    $("#palette-input").addEventListener("input", (e) => { palIdx = 0; filterPalette(e.target.value); });
    $("#palette-input").addEventListener("keydown", (e) => {
      if (e.key === "ArrowDown") { e.preventDefault(); palIdx = Math.min(palItems.length - 1, palIdx + 1); markSel(); }
      else if (e.key === "ArrowUp") { e.preventDefault(); palIdx = Math.max(0, palIdx - 1); markSel(); }
      else if (e.key === "Enter") { e.preventDefault(); runPalette(palItems[palIdx]); }
      else if (e.key === "Escape") closePalette();
    });
    $("#overlay-palette").addEventListener("mousedown", (e) => { if (e.target.id === "overlay-palette") closePalette(); });
    $("#overlay-dialog").addEventListener("mousedown", (e) => { if (e.target.id === "overlay-dialog") closeDialog(); });

    // 全局点击关闭弹层
    document.addEventListener("click", (e) => {
      const inPop = e.target.closest("#pop") || e.target.closest("#pop-sub");
      if (!inPop) { hidePop(); }
      if (!e.target.closest("#menubar")) closeMenu();
    });
    // 鼠标离开菜单区域后收起二级（避免残留）
    document.addEventListener("mouseleave", (e) => {
      if (e.target.id === "pop" || e.target.id === "pop-sub") hideSub();
    }, true);

    // 开关（设置对话框里的 switch 行）
    document.addEventListener("click", (e) => {
      const s = e.target.closest("[data-switch]");
      if (s) s.classList.toggle("on");
      const sw = e.target.closest(".swatch");
      if (sw) { $$(".swatch").forEach((x) => x.classList.toggle("on", x === sw)); }
    });

    // 分隔条拖动
    dragSplitter();
    dragPanelResizer();

    // 快捷键
    document.addEventListener("keydown", onKey);
  }

  function onKey(e) {
    const k = e.key.toLowerCase();
    const mod = e.ctrlKey || e.metaKey;
    const typing = /^(INPUT|TEXTAREA)$/.test(e.target.tagName) && !e.target.closest(".palette-input");
    if (mod && e.shiftKey && k === "p") { e.preventDefault(); openPalette(); return; }
    if (e.key === "F1") { e.preventDefault(); openPalette(); return; }
    if (mod && k === "p" && !e.shiftKey) { e.preventDefault(); openPalette(); return; }
    if (mod && e.shiftKey && k === "a") { e.preventDefault(); toggleAI(); return; }
    if (mod && k === "b") { e.preventDefault(); toggleSidebar(); return; }
    if (mod && k === "j") { e.preventDefault(); togglePanel(); return; }
    if (mod && e.shiftKey && k === "f") { e.preventDefault(); zenMode(); return; }
    if (mod && k === "i" && !e.shiftKey) { e.preventDefault(); focusAI("chat"); return; }
    if (mod && e.shiftKey && k === "i") { e.preventDefault(); dialogVision(); return; }
    if (mod && k === "s" && !e.shiftKey) { e.preventDefault(); doSave(); return; }
    if (mod && k === "n") { e.preventDefault(); dialogNew(); return; }
    if (mod && k === "w") { e.preventDefault(); if (doc()) closeDoc(S.docId); return; }
    if (mod && k === "0") { e.preventDefault(); setZoom(100); return; }
    if (mod && (k === "=" || k === "+")) { e.preventDefault(); setZoom(S.zoom + 10); return; }
    if (mod && k === "-") { e.preventDefault(); setZoom(S.zoom - 10); return; }
    if (mod && ["1", "2", "3"].includes(k)) { e.preventDefault(); setMode(["source", "split", "preview"][+k - 1]); return; }
    if (mod && k === "t" && e.shiftKey) { e.preventDefault(); toggleTheme(); return; }
    if (mod && k === "t") { e.preventDefault(); toggleTheme(); return; }
    if (e.altKey && ["1", "2", "3", "4", "5"].includes(k)) {
      e.preventDefault();
      const a = ACTS[+k - 1];
      S.sidebarView = a.id; S.sidebarOpen = true; syncLayout();
      return;
    }
    if (e.key === "Escape") {
      if (!$("#overlay-palette").hidden) return closePalette();
      if (!$("#overlay-dialog").hidden) return closeDialog();
      if (!$("#pop").hidden) return hidePop();
      if ($("#menubar").dataset.open) return closeMenu();
    }
    if (typing) return;
  }

  function dragSplitter() {
    const sp = $("#splitter");
    const split = $("#split");
    let dragging = false;
    sp.addEventListener("mousedown", (e) => {
      if (!isText() || S.mode !== "split") return;
      dragging = true;
      document.body.classList.add("resizing");
      sp.classList.add("drag");
      e.preventDefault();
    });
    window.addEventListener("mousemove", (e) => {
      if (!dragging) return;
      const r = split.getBoundingClientRect();
      let pct = ((e.clientX - r.left) / r.width) * 100;
      pct = Math.max(18, Math.min(82, pct));
      split.style.setProperty("--split-src", pct + "%");
    });
    window.addEventListener("mouseup", () => {
      if (!dragging) return;
      dragging = false;
      document.body.classList.remove("resizing");
      sp.classList.remove("drag");
      status("源码 : 预览 = " + (split.style.getPropertyValue("--split-src") || "46%"), "");
    });
    sp.addEventListener("dblclick", () => { split.style.setProperty("--split-src", "46%"); });
  }

  function dragPanelResizer() {
    const rz = $("#panel-resizer");
    let dragging = false, startY = 0, startH = 0;
    rz.addEventListener("mousedown", (e) => {
      dragging = true; startY = e.clientY;
      startH = $("#bottom-panel").getBoundingClientRect().height;
      document.body.classList.add("resizing-v");
      e.preventDefault();
    });
    window.addEventListener("mousemove", (e) => {
      if (!dragging) return;
      const h = Math.max(64, Math.min(innerHeight * 0.7, startH + (startY - e.clientY)));
      document.documentElement.style.setProperty("--panel-h", h + "px");
    });
    window.addEventListener("mouseup", () => {
      if (!dragging) return;
      dragging = false;
      document.body.classList.remove("resizing-v");
    });
  }

  /* ---- 启动 ----------------------------------------------------------- */
  /**
   * URL 状态（原型便利，也方便截图与评审链接）：
   *   ?theme=dark&doc=d3&mode=preview&panel=usage&ai=vision&view=convert
   *   &open=palette|convert|vision|settings|keys|new|history|guide|about
   *   &zen=1&nosidebar=1&noai=1&nopanel=1
   */
  function applyUrlState() {
    let q;
    try { q = new URLSearchParams(location.search); } catch (e) { return; }
    if (q.get("theme")) setTheme(q.get("theme") === "dark" ? "dark" : "light");
    if (q.get("doc") && DOCS.some((d) => d.id === q.get("doc"))) {
      S.docId = q.get("doc");
      S.mode = FORMATS[doc().format].splitView ? doc().mode || "split" : "preview";
    }
    if (q.get("mode") && isText()) S.mode = q.get("mode");
    if (q.get("view")) { S.sidebarView = q.get("view"); S.sidebarOpen = true; }
    if (q.get("panel")) { S.panelTab = q.get("panel"); S.panelOpen = true; }
    if (q.get("ai")) S.aiTab = q.get("ai");
    if (q.get("nosidebar")) S.sidebarOpen = false;
    if (q.get("noai")) S.aiOpen = false;
    if (q.get("nopanel")) S.panelOpen = false;
    if (q.get("close") === "all") { DOCS.length = 0; S.docId = null; }
    if (q.get("notoast")) document.body.classList.add("no-boot-toast");
    if (q.get("zen")) { S.sidebarOpen = S.aiOpen = S.panelOpen = S.activityOpen = false; S.mode = "preview"; document.body.dataset.zen = "1"; }
    $("#split").className = "split mode-" + S.mode;
    syncLayout(); // URL 改的面板开关要落到 body 的 no-* 类上
    const open = q.get("open");
    if (open) {
      setTimeout(() => {
        if (open === "palette") openPalette();
        else if (open === "convert") dialogConvert();
        else if (open === "vision") dialogVision();
        else if (open === "settings") dialogSettings(q.get("tab") || "appearance");
        else if (open === "keys") dialogKeys();
        else if (open === "new") dialogNew();
        else if (open === "history") dialogHistory();
        else if (open === "guide") dialogGuide();
        else if (open === "about") dialogAbout();
      }, 60);
    }
  }

  function boot() {
    setTheme(S.theme);
    renderMenubar();
    bind();
    const d0 = doc();
    S.mode = d0 ? (FORMATS[d0.format].splitView ? d0.mode || "split" : "preview") : "split";
    applyUrlState(); // URL 状态覆盖默认值（theme/doc/mode/view/panel/ai/open/zen）
    $("#split").className = "split mode-" + S.mode;
    renderAll();
    if (!document.body.classList.contains("no-boot-toast")) {
      setTimeout(() => {
        toast({ icon: "sparkles", title: "这是 dev3.0 界面原型", sub: "Ctrl+Shift+P 打开命令面板 · 所有交互都能点，数据是示意", ai: true });
      }, 500);
    }
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();

  // 暴露给控制台调试（原型便利，不进生产）
  window.DGM_PROTO = { S, DOCS, FORMATS, CONVERSIONS, toast, runCommand, setTheme, setMode, activate, dialogConvert, dialogVision, dialogSettings };
})();

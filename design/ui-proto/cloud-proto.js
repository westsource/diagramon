/* ============================================================================
 * Diagramon dev3.0 —— 「账户 / 云端文档 / 保存到云端 / 登录」原型交互
 *
 * 纯静态、无依赖、file:// 可直接打开。只负责把这四个新界面渲染出来，
 * 其余区域（编辑器、AI 面板、命令面板…）不做，见主原型 app.html。
 *
 * 数据是示意值；字段名与 crates/app-ipc 的 CloudAccount / CloudDoc / CloudDocList
 * 对齐，方便实施时直接换成 cloud_status / cloud_docs_list 的真实返回。
 *
 * ★ 实施时把本文件逻辑并入 client2/ui/js/state.js + ui/js/sidebar.js + ui/js/shell.js，
 *   并把这里的 mock 数据换成 IPC 调用，然后删除本文件。
 * ========================================================================== */
(function () {
  "use strict";

  /* ---------------------------------------------------------------- 工具 -- */
  const $ = (s, r) => (r || document).querySelector(s);
  const $$ = (s, r) => Array.from((r || document).querySelectorAll(s));
  const ico = window.ico;
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  function h(tag, cls, html) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (html != null) n.innerHTML = html;
    return n;
  }

  /* ---------------------------------------------------------------- 数据 -- */
  const FMT = {
    mermaid: { name: "Mermaid", v: "--fmt-mermaid" },
    dot: { name: "DOT", v: "--fmt-dot" },
    drawio: { name: "draw.io", v: "--fmt-drawio" },
    excalidraw: { name: "Excalidraw", v: "--fmt-excalidraw" },
  };

  const DATA = {
    account: {
      email: "westsource@126.com",
      display_name: "道荣",
      role: "user",
      plan_name: "会员",
      plan_expires: "2026-12-31",
      email_verified: true,
      used_bytes: 13_631_488,     // ≈ 13 MB
      quota_bytes: 104_857_600,   // 100 MB
      // AI 权益（对齐服务端 membership.ai）：额度是**整数微信用点**（1e-6），不锚定货币 —— 所以页面上写"信用点"，不写 ¥
      ai: {
        enabled: true,
        credit_monthly_micros: 20000000, // 20 信用点
        credit_used_micros: 3200000, // 3.2 信用点
        period_start: "2026-10-01T00:00:00+00:00",
        period_end: "2026-11-01T00:00:00+00:00",
      },
    },
    // 目录（扁平列表，等价于服务端 GET /v1/folders 的显式行）
    folders: ["架构", "架构/后端", "架构/前端", "架构/数据库", "流程", "归档"],
    // 文档（path 是所在目录，"" = 根）
    docs: [
      { name: "系统总览.mermaid", path: "", format: "mermaid", size: 4211, updated: "2026-10-11 09:20" },
      { name: "快速开始.mmd", path: "", format: "mermaid", size: 1880, updated: "2026-10-03 14:02" },
      { name: "系统架构.drawio", path: "架构", format: "drawio", size: 88210, updated: "2026-10-10 22:41" },
      { name: "服务分层.mermaid", path: "架构", format: "mermaid", size: 6022, updated: "2026-10-09 11:30" },
      { name: "网关时序.mermaid", path: "架构/后端", format: "mermaid", size: 3320, updated: "2026-10-08 16:12" },
      { name: "数据模型.dot", path: "架构/后端", format: "dot", size: 2450, updated: "2026-10-07 10:05" },
      { name: "组件树.excalidraw", path: "架构/前端", format: "excalidraw", size: 45210, updated: "2026-10-06 20:33" },
      { name: "交互流程.excalidraw", path: "架构/前端", format: "excalidraw", size: 61800, updated: "2026-10-05 09:15" },
      { name: "发布流程.dot", path: "流程", format: "dot", size: 1990, updated: "2026-10-04 18:20" },
      { name: "故障处理.mermaid", path: "流程", format: "mermaid", size: 2860, updated: "2026-10-02 13:44" },
      { name: "发布检查单.mermaid", path: "流程", format: "mermaid", size: 1502, updated: "2026-09-28 08:09" },
    ],
  };

  /* -------------------------------------------------------------- 状态机 -- */
  const S = {
    view: "account",             // account | cloud
    signedIn: true,
    configured: true,
    baseUrl: "https://www.diagramon.com",  // 服务根地址（设置 → 账户与云端 里的那个）
    open: new Set(["架构"]),      // 展开的目录路径
    filter: "",
    unverified: false,           // 演示：邮箱未激活（错误码 email_not_verified）
    pick: "架构/后端",            // 保存对话框选中的目标目录
    docName: "系统架构.drawio",
    dialog: null,                // "login" | "save" | null
  };

  /* ---------------------------------------------------------- 树与格式化 -- */
  let TREE = null;
  function buildTree() {
    const root = { name: "根目录", path: "", children: [], docs: [] };
    const idx = { "": root };
    const ensure = (path) => {
      if (!path) return root;
      if (idx[path]) return idx[path];
      const i = path.lastIndexOf("/");
      const parent = ensure(i < 0 ? "" : path.slice(0, i));
      const node = { name: i < 0 ? path : path.slice(i + 1), path, children: [], docs: [] };
      parent.children.push(node);
      idx[path] = node;
      return node;
    };
    DATA.folders.forEach(ensure);
    DATA.docs.forEach((d) => ensure(d.path).docs.push(d));
    const nameCmp = (a, b) => a.name.localeCompare(b.name, "zh");
    const sort = (n) => {
      n.children.sort(nameCmp);
      n.docs.sort(nameCmp);
      n.children.forEach(sort);
      n.total = n.docs.length + n.children.reduce((s, c) => s + c.total, 0);
    };
    sort(root);
    return root;
  }

  function fmtBytes(n) {
    n = Number(n) || 0;
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
    return `${(n / 1024 / 1024).toFixed(1)} MB`;
  }
  const fmtDot = (id) => `<span class="fmt-dot" style="background:var(${(FMT[id] || {}).v || "--faint"})"></span>`;
  const hl = (text, q) => (q ? esc(text).replace(new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "ig"), (m) => `<mark>${m}</mark>`) : esc(text));

  function subtreeMatch(node, q) {
    if (node.name.toLowerCase().includes(q)) return true;
    if (node.docs.some((d) => d.name.toLowerCase().includes(q))) return true;
    return node.children.some((c) => subtreeMatch(c, q));
  }

  /* ------------------------------------------------------------ Toast/顶栏 -- */
  function toast(o) {
    const box = $("#toasts");
    const t = h("div", "toast" + (o.warn ? " warn" : "") + (o.err ? " err" : ""));
    t.innerHTML = `${ico(o.icon || "info", "ico-sm")}<div class="bd"><b>${esc(o.title || "")}</b>${o.sub ? `<span>${esc(o.sub)}</span>` : ""}</div>`;
    box.appendChild(t);
    setTimeout(() => { t.style.opacity = "0"; setTimeout(() => t.remove(), 250); }, 3600);
  }

  /* ============================================================ 活动栏 ==== */
  const ACTS = [
    { id: "explorer", icon: "explorer", label: "资源管理器", kbd: "Alt+1" },
    { id: "search", icon: "search", label: "全局搜索", kbd: "Alt+2" },
    { id: "convert", icon: "swap", label: "转换中心", kbd: "Alt+3" },
    { id: "cloud", icon: "cloud", label: "云端文档", kbd: "Alt+4" },   // ← 只做查找/打开
    { id: "outline", icon: "outline", label: "当前图大纲", kbd: "Alt+5" },
  ];

  function renderActivity() {
    const bar = $("#activitybar");
    bar.innerHTML = "";
    for (const a of ACTS) {
      const b = h("button", "act" + (S.view === a.id ? " on" : ""));
      b.innerHTML = ico(a.icon);
      b.title = `${a.label}  ${a.kbd}`;
      b.addEventListener("click", () => {
        if (a.id === "account") return;
        if (a.id !== "cloud" && a.id !== "account") {
          return toast({ icon: a.icon, title: a.label, sub: "原型只做「账户 / 云端文档」两块，其余见主原型 app.html" });
        }
        setView(a.id);
      });
      bar.appendChild(b);
    }
    bar.appendChild(h("div", "act-sep"));

    const ai = h("button", "act is-ai");
    ai.innerHTML = ico("sparkles");
    ai.title = "切换 AI 面板  Ctrl+Shift+A";
    ai.addEventListener("click", () => toast({ icon: "sparkles", title: "AI 面板", sub: "本原型不展示，见主原型 app.html" }));
    bar.appendChild(ai);

    bar.appendChild(h("div", "act-spacer"));

    // 账户：原来叫「账户与云端」，也原样复用云端视图 —— 现在拆成独立视图，
    // 未登录时点它直接弹登录窗口（需求 1）。
    const acct = h("button", "act" + (S.view === "account" ? " on" : ""));
    acct.innerHTML = ico("user");
    acct.title = "账户";
    acct.addEventListener("click", () => {
      if (S.configured && !S.signedIn) return openLogin();
      setView("account");
    });
    bar.appendChild(acct);

    const keys = h("button", "act");
    keys.innerHTML = ico("keyboard");
    keys.title = "键盘快捷键总表  Ctrl+K Ctrl+S";
    keys.addEventListener("click", () => toast({ icon: "keyboard", title: "快捷键总表", sub: "原型不展示" }));
    bar.appendChild(keys);

    const st = h("button", "act");
    st.innerHTML = ico("settings");
    st.title = "设置";
    st.addEventListener("click", () => toast({ icon: "settings", title: "设置", sub: "云网关地址在 设置 → 账户与云端 里填" }));
    bar.appendChild(st);
  }

  function setView(v) {
    S.view = v;
    S.dialog = null;
    render();
  }

  /* ============================================================ 侧栏 ====== */
  const TITLES = { account: "账户", cloud: "云端文档" };

  function renderSidebar() {
    $("#side-title").textContent = TITLES[S.view] || S.view;
    const host = $("#side-view");
    host.innerHTML = "";
    host.appendChild(S.view === "cloud" ? viewCloud() : viewAccount());
  }

  /* ---- 账户视图（只读） -------------------------------------------------- */
  function viewAccount() {
    const box = h("div");

    if (!S.configured) {
      box.appendChild(tip(`<b>云网关未配置</b><br>在 设置 → 账户与云端 填入服务地址后，这里才会显示账户与额度。`));
      const acts = h("div", "side-acts");
      acts.innerHTML = `<button class="btn sm" data-a="cfg">${ico("settings")}去配置</button>`;
      acts.addEventListener("click", () => toast({ icon: "settings", title: "设置 → 账户与云端", sub: "原型未接线" }));
      box.appendChild(acts);
      return box;
    }

    if (!S.signedIn) {
      box.appendChild(card(null));
      const acts = h("div", "side-acts");
      acts.innerHTML = `<button class="btn sm primary" data-a="login">${ico("cloud")}登录</button>`;
      acts.addEventListener("click", () => openLogin());
      box.appendChild(acts);
      box.appendChild(tip("账户信息只在登录后显示。本机不保存密码，也不伪造余额。"));
      return box;
    }

    const a = DATA.account;
    box.appendChild(card(a));

    const rows = h("div", "acct-rows");
    // AI 权益：null = "服务端没给这个字段"（旧后端）→ 显示"—"；
    // enabled=false 才是"确实没开通"。两者不能混。
    const ai = a.ai || null;
    const lines = [
      ["套餐", esc(a.plan_name)],
      ["会员到期", esc(a.plan_expires)],
      ["角色", a.role === "admin" ? "管理员" : "普通用户"],
      [
        "AI 服务",
        ai == null
          ? `<span class="acct-unknown">—</span>`
          : `<span class="acct-badge ${ai.enabled ? "acct-ai-on" : "acct-ai-off"}">${ai.enabled ? "已开通" : "未开通"}</span>`,
      ],
      ["邮箱状态", a.email_verified ? `<span style="color:var(--ok)">已验证</span>` : `<span style="color:var(--warn)">未验证</span>`],
    ];
    lines.forEach(([k, v]) => {
      const r = h("div", "acct-row");
      r.innerHTML = `<span class="k">${k}</span><span class="v">${v}</span>`;
      rows.appendChild(r);
    });
    box.appendChild(rows);

    box.appendChild(quotaBlock("存储用量", a.used_bytes, a.quota_bytes, fmtBytes(a.used_bytes), fmtBytes(a.quota_bytes)));
    if (ai && ai.enabled) {
      // 额度一律**信用点**（1 信用点 = 1e6 微信用点），不是人民币 —— 服务端不把信用点锚定货币。
      // 服务端给"总额 + 已用"而不是"剩余"，所以剩余是这里减出来的（充值加在总额上，减法恒成立）。
      const monthly = ai.credit_monthly_micros;
      const used = ai.credit_used_micros;
      const extra =
        `<div class="line"><span>剩余 ${fmtCredits(monthly - used)} 信用点</span></div>` +
        `<div class="line"><span>周期至 ${fmtDate(ai.period_end)} 重置</span></div>`;
      box.appendChild(quotaBlock("AI 额度（本周期）", used, monthly, fmtCredits(used), fmtCredits(monthly), "", extra));
    }

    const acts = h("div", "side-acts");
    acts.innerHTML =
      `<button class="btn sm" data-a="refresh">${ico("refresh")}刷新</button>` +
      `<button class="btn sm ghost" data-a="out">${ico("close")}退出登录</button>`;
    acts.addEventListener("click", (e) => {
      const b = e.target.closest("button");
      if (!b) return;
      if (b.dataset.a === "refresh") return toast({ icon: "refresh", title: "已刷新账户信息", sub: "cloud_status" });
      if (b.dataset.a === "out") {
        S.signedIn = false;
        render();
        toast({ icon: "close", title: "已退出登录", sub: "本机保存的令牌已清除" });
      }
    });
    box.appendChild(acts);

    box.appendChild(h("div", "acct-note", "账户信息由云端只读提供。改昵称、改密码、充值请到官网账户页。"));
    return box;
  }

  function card(a) {
    const c = h("div", "acct-card");
    if (a) {
      c.innerHTML =
        `<span class="avatar">${ico("user")}</span>` +
        `<span class="who"><b>${esc(a.display_name)}</b><small>${esc(a.email)}</small></span>`;
    } else {
      c.innerHTML =
        `<span class="avatar">${ico("user")}</span>` +
        `<span class="who"><b>未登录</b><small>登录后查看账户与额度</small></span>`;
    }
    return c;
  }

  function quotaBlock(title, used, total, usedText, totalText, unit, extra) {
    const pct = total > 0 ? Math.min(100, Math.max(0, Math.round((used / total) * 100))) : 0;
    const box = h("div", "acct-quota");
    box.innerHTML =
      `<h5>${ico("db", "ico-sm")}${esc(title)}<span class="sp"></span><span class="pct">${pct}%</span></h5>` +
      `<progress max="100" value="${pct}"></progress>` +
      `<div class="line"><span class="used">${esc(usedText)}</span><span>/ ${esc(totalText)}</span><span class="sp"></span><span>${esc(unit || "")}</span></div>` +
      (extra || "");
    box.title = `${usedText} / ${totalText}（${pct}%）`;
    return box;
  }

  /** 微信用点 → 人话（1 信用点 = 1e6 微信用点，最多两位小数）。 */
  function fmtCredits(micros) {
    const n = (Number(micros) || 0) / 1e6;
    if (n === 0) return "0";
    const r = Math.round(n * 100) / 100;
    return r === 0 ? "<0.01" : String(r);
  }

  /** ISO 串 → 本地短日期；解析不出来留空（别把原始串怼给用户）。 */
  function fmtDate(iso) {
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? "" : d.toLocaleDateString();
  }

  /* ---- 云端文档视图（单栏统一树：目录 + 文档） --------------------------- */
  function viewCloud() {
    const box = h("div");

    if (!S.configured) {
      box.appendChild(tip(`<b>云网关未配置</b><br>填好服务地址后才能列出云端文档。`));
      return box;
    }
    if (!S.signedIn) {
      box.appendChild(tip("云端文档需要先登录。登录后这里会显示你的云端目录树，点一下就能打开。"));
      const acts = h("div", "side-acts");
      acts.innerHTML = `<button class="btn sm primary" data-a="login">${ico("cloud")}登录</button>`;
      acts.addEventListener("click", () => openLogin());
      box.appendChild(acts);
      return box;
    }

    const bar = h("div", "ct-toolbar ct-top");
    const filter = h("div", "ct-filter");
    filter.innerHTML = `${ico("search", "ico-sm")}<input id="ct-q" type="text" placeholder="筛选云端文档…" value="${esc(S.filter)}" spellcheck="false">`;
    const input = $("#ct-q", filter);
    input.addEventListener("input", () => { S.filter = input.value; renderSidebarKeepFocus("ct-q"); });
    bar.appendChild(filter);

    // 三个动作做成图标钮：236px 的侧栏放不下三个带字按钮（会溢出），
    // 与资源管理器标题栏的图标钮同一套做法。
    const acts = h("div", "ct-iconacts");
    acts.innerHTML =
      `<button class="icon-btn" data-a="refresh" title="刷新（cloud_docs_list）">${ico("refresh", "ico-sm")}</button>` +
      `<button class="icon-btn" data-a="mkdir" title="新建目录">${ico("plus", "ico-sm")}</button>` +
      `<button class="icon-btn" data-a="save" title="把当前文档保存到云端…">${ico("save", "ico-sm")}</button>`;
    acts.addEventListener("click", (e) => {
      const b = e.target.closest("button");
      if (!b) return;
      if (b.dataset.a === "refresh") return toast({ icon: "refresh", title: "已刷新云端文档", sub: "cloud_docs_list" });
      if (b.dataset.a === "mkdir") return toast({ icon: "plus", title: "新建目录", sub: "在服务端建一个可以是空的目录（原型未接线）" });
      if (b.dataset.a === "save") return openSave();
    });
    bar.appendChild(acts);
    box.appendChild(bar);

    const q = S.filter.trim().toLowerCase();
    const tree = (TREE = TREE || buildTree());
    const tree_ = h("div", "ct-tree");
    renderChildren(tree_, tree, 0, q);
    box.appendChild(tree_);

    box.appendChild(summaryLine(tree, q));
    // 这里**不放存储用量**：额度是"账户"视图的事（同一份服务端数据）。
    // 相邻两个视图各显示一遍同一个数字，只会让人怀疑哪个才是真的。
    return box;
  }

  function renderChildren(host, node, depth, q) {
    for (const c of node.children) {
      if (q && !subtreeMatch(c, q)) continue;
      const open = !!q || S.open.has(c.path);
      const empty = c.total === 0;
      const row = h("button", "ct-row" + (open ? "" : " closed") + (empty ? " empty" : ""));
      row.style.setProperty("--depth", depth);
      row.innerHTML =
        `${ico("chevD", "ico-sm caret")}${ico(open ? "folderOpen" : "folder", "ico-sm fld")}` +
        `<span class="nm">${hl(c.name, q)}</span>` +
        `<span class="cnt${empty ? " zero" : ""}">${empty ? "空" : c.total + " 个文档"}</span>`;
      row.title = c.path;
      row.addEventListener("click", () => {
        if (S.open.has(c.path)) S.open.delete(c.path); else S.open.add(c.path);
        render();
      });
      host.appendChild(row);
      if (open) renderChildren(host, c, depth + 1, q);
    }
    for (const d of node.docs) {
      if (q && !d.name.toLowerCase().includes(q)) continue;
      host.appendChild(docRow(d, depth, q));
    }
  }

  function docRow(d, depth, q) {
    const row = h("button", "ct-row");
    row.style.setProperty("--depth", depth);
    row.innerHTML =
      `<span class="caret hidden"></span>${fmtDot(d.format)}` +
      `<span class="nm">${hl(d.name, q)}</span>` +
      `<span class="sz">${fmtBytes(d.size)}</span>`;
    row.title = `${d.path || "/"} · ${(FMT[d.format] || {}).name || d.format} · ${fmtBytes(d.size)} · ${d.updated}`;
    row.addEventListener("click", () =>
      toast({ icon: "cloud", title: "打开云端文档", sub: d.name + "（真实走 cloud_doc_open，开成无路径标签页）" }),
    );
    return row;
  }

  function summaryLine(tree, q) {
    const line = h("div", "side-sub");
    if (q) {
      let folders = 0, docs = 0;
      const walk = (n) => {
        for (const c of n.children) { if (subtreeMatch(c, q)) { folders++; walk(c); } }
        for (const d of n.docs) if (d.name.toLowerCase().includes(q)) docs++;
      };
      walk(tree);
      line.innerHTML = `筛选「${esc(S.filter)}」：命中 <b>${docs}</b> 个文档 · <b>${folders}</b> 个目录`;
      return line;
    }
    let folders = 0, docs = 0;
    const walk = (n) => { docs += n.docs.length; n.children.forEach((c) => { folders++; walk(c); }); };
    walk(tree);
    line.innerHTML = `共 <b>${docs}</b> 个文档 · <b>${folders}</b> 个目录`;
    return line;
  }

  function tip(html) {
    const n = h("div", "side-tip");
    n.innerHTML = `${ico("info", "ico-sm")}<span>${html}</span>`;
    return n;
  }

  function renderSidebarKeepFocus(id) {
    renderSidebar();
    const el = document.getElementById(id);
    if (el) { el.focus(); const v = el.value; try { el.setSelectionRange(v.length, v.length); } catch (e) {} }
  }

  /* ============================================================ 对话框 ==== */
  function openDialog(kind) {
    S.dialog = kind;
    const ov = $("#overlay-dialog");
    const d = $("#dialog");
    d.className = "dialog" + (kind === "login" ? " login-win" : "");
    d.innerHTML = "";
    d.appendChild(kind === "login" ? loginBody() : saveBody());
    ov.hidden = false;
    // 未激活提示必须**挂进文档之后**再写：loginBody 里构造时 #lg-msg 还在游离树上，
    // document.querySelector 找不到它，写了也是白写（踩过）。
    if (kind === "login" && S.unverified) {
      msg("err", "这个邮箱还没激活。先去邮件里点激活链接，再回来登录；没收到可以「重发激活邮件」。");
    }
    const first = $("input", d);
    if (first) setTimeout(() => first.focus(), 0);
  }
  const openLogin = () => openDialog("login");
  const openSave = () => openDialog("save");
  function closeDialog() { S.dialog = null; $("#overlay-dialog").hidden = true; }

  /* ---- 登录窗口（参考 client/Views/LoginDialog.cs） ----------------------
   * ★ 只做登录，不做注册。
   * 旧客户端是刻意这么定的：注册、邮箱激活、条款/隐私文案都在网页端，
   * 客户端再实现一份就是**第三个要同步的地方**（服务端 / 网页 / 桌面端）——
   * 邮箱激活、重发、密码规则任意一处改动都会两端漂移。
   * 所以「没有账号？去官网注册」是个**导航动作**（不是第三个按钮，免得看起来
   * 像点它能在这里完成注册），点了让系统浏览器打开官网注册页。
   * 注册地址由**配置的服务端根地址**推导，不硬编码域名 —— 联调 / 私有部署自动跟着走；
   * 打不开浏览器时把地址显示出来让用户自己复制（静默失败等于按了没反应）。
   * -------------------------------------------------------------------- */

  /** 注册页地址：{服务根地址}/register —— 与旧客户端 AuthService.ServiceSiteUrl 同一口径。 */
  function registerUrl() {
    const base = (S.baseUrl || "").trim().replace(/\/+$/, "");
    return base ? `${base}/register` : "";
  }

  function openRegister() {
    const url = registerUrl();
    if (!url) return msg("err", "还没配置服务端地址，打不开注册页（设置 → 账户与云端）。");
    try { window.open(url, "_blank"); } catch (e) { /* 被拦下也没关系，下面把地址给出来 */ }
    toast({ icon: "globe", title: "已交给系统浏览器打开", sub: url });
    // 地址要**可复制**：浏览器被拦、或用户想把地址贴到别处时，光看得到没用。
    fillRegisterUrl(url);
    msg("ok", "浏览器没打开？复制下面的注册地址手动访问：");
  }

  /** 把注册地址填进只读输入框并展开（用输入框而不是纯文本：天然可选中、可 Ctrl+C）。 */
  function fillRegisterUrl(url) {
    const box = $("#lg-url");
    const input = $("#lg-url-input");
    if (!box || !input) return;
    input.value = url;
    box.hidden = false;
    try { input.focus(); input.select(); } catch (e) { /* ignore */ }
  }

  /** 复制注册地址。execCommand 先试（同步、不要权限），失败再退回异步 clipboard API。 */
  function copyRegisterUrl() {
    const input = $("#lg-url-input");
    if (!input || !input.value) return;
    try { input.focus(); input.select(); } catch (e) { /* ignore */ }
    let ok = false;
    try { ok = document.execCommand("copy"); } catch (e) { ok = false; }
    if (ok) return msg("ok", "注册地址已复制到剪贴板");
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(input.value).then(
        () => msg("ok", "注册地址已复制到剪贴板"),
        () => msg("err", "复制失败：请手动选中地址后按 Ctrl+C"),
      );
      return;
    }
    msg("err", "复制失败：请手动选中地址后按 Ctrl+C");
  }

  function loginBody() {
    const wrap = h("div");
    const head = h("div", "dialog-head");
    head.innerHTML =
      `<span class="brand-mini" style="width:22px;height:22px;border-radius:6px;display:grid;place-items:center;color:var(--accent-ink);background:linear-gradient(140deg,var(--accent),var(--ai))">` +
      `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:12px;height:12px"><use href="#i-logo"></use></svg></span>` +
      `<h2>登录 Diagramon</h2><span class="sp"></span>` +
      `<button class="icon-btn" data-close title="关闭">${ico("close", "ico-sm")}</button>`;
    wrap.appendChild(head);

    const body = h("div", "dialog-body");
    body.appendChild(loginForm());
    wrap.appendChild(body);

    // 页脚一行要同时装下「去注册链接 + 重发（仅未激活时）+ 登录 + 取消」而窗口只有 400 宽：
    // 谁都不设 MinWidth，一切按内容自适应 —— 定了最小值就会在"邮箱未激活"那一态把取消挤出窗口。
    const foot = h("div", "dialog-foot");
    foot.innerHTML =
      `<span class="link-btn" data-register title="${esc(registerUrl() || "未配置服务端地址")}">没有账号？去官网注册</span>` +
      `<span class="sp"></span>` +
      `<button class="btn ghost sm" data-resend${S.unverified ? "" : " hidden"}>重发激活邮件</button>` +
      `<button class="btn ghost" data-close>取消</button>` +
      `<button class="btn primary" data-ok>登录</button>`;
    wrap.appendChild(foot);

    wrap.addEventListener("click", (e) => {
      if (e.target.closest("[data-close]")) return closeDialog();
      if (e.target.closest("[data-register]")) return openRegister();
      if (e.target.closest("[data-copy]")) return copyRegisterUrl();
      if (e.target.closest("[data-ok]")) return submitLoginForm();
      if (e.target.closest("[data-resend]")) {
        // 服务端恒返回 204：成功只代表"请求已受理"，不代表邮件确实发出去了
        return msg("ok", "激活邮件已重新发送（服务端不承诺送达，也不透露账号是否存在）");
      }
    });

    // 邮箱未激活的提示由 openDialog 在节点挂进文档后再写（见那里注释）：
    // 它是**可以自救**的失败 —— 密码没错，只是没点邮件里的链接，所以页脚要给重发入口。
    return wrap;
  }

  function loginForm() {
    const f = h("div");
    f.innerHTML =
      `<div class="field"><label>邮箱</label><input id="lg-email" type="text" placeholder="you@example.com" spellcheck="false" autocomplete="off"></div>` +
      `<div class="field"><label>密码</label><input id="lg-pass" type="password" placeholder="密码" autocomplete="off"></div>` +
      `<div class="login-msg" id="lg-msg"></div>` +
      // 注册地址回显区（默认隐藏）：只在"浏览器没打开"时才需要，所以不占常态版面
      `<div class="login-url" id="lg-url" hidden>` +
      `<label>注册地址（可直接复制）</label>` +
      `<div class="login-url-row"><input id="lg-url-input" type="text" readonly spellcheck="false">` +
      `<button class="btn sm" data-copy>${ico("copy", "ico-sm")}复制</button></div>` +
      `</div>`;
    const p = $("#lg-pass", f);
    p.addEventListener("keydown", (e) => { if (e.key === "Enter") submitLoginForm(); });
    return f;
  }

  /** 空输入直接禁用提示、不做任何前置校验：客户端拦一次就多一条会与服务端漂移的规则。 */
  function submitLoginForm() {
    const emailEl = $("#lg-email");
    const passEl = $("#lg-pass");
    const email = emailEl ? emailEl.value.trim() : "";
    const pass = passEl ? passEl.value : "";
    if (!email || !pass) return msg("err", "邮箱和密码都要填");
    // 演示：任何输入都登录成功（真实走 cloud_login → 200/401）
    S.unverified = false;
    S.signedIn = true;
    S.view = "account";
    closeDialog();
    render();
    toast({ icon: "cloud", title: "已登录", sub: email });
  }

  function msg(kind, text) {
    const m = $("#lg-msg");
    if (!m) return;
    m.className = "login-msg " + kind;
    m.textContent = text;
  }

  /* ---- 保存到云端窗口（左选目录树 + 文档名） ---------------------------- */
  function saveBody() {
    const wrap = h("div");
    const head = h("div", "dialog-head");
    head.innerHTML = `<h2>保存到云端</h2><span class="sp"></span><button class="icon-btn" data-close title="关闭">${ico("close", "ico-sm")}</button>`;
    wrap.appendChild(head);

    const body = h("div", "dialog-body");
    body.innerHTML =
      `<div class="field"><label>文档名</label><input id="sv-name" type="text" value="${esc(S.docName)}" spellcheck="false">` +
      `<span class="hint">保存与改名一起走；层级由下面选中的目录表达，名字里不要再写 「/」。</span></div>`;

    const lbl = h("div", "field", `<label>保存到哪个目录</label>`);
    body.appendChild(lbl);

    const tree = (TREE = TREE || buildTree());
    const pk = h("div", "pk-tree");
    renderPick(pk, tree, 0);
    body.appendChild(pk);

    const nf = h("div", "newfolder");
    nf.innerHTML = `<input id="sv-folder" type="text" placeholder="在当前目录下新建子目录（可留空）"><button class="btn sm ghost" data-mk>新建</button>`;
    body.appendChild(nf);
    wrap.appendChild(body);

    const foot = h("div", "dialog-foot");
    foot.innerHTML = `<span class="note" id="sv-sel">目标目录：${esc(S.pick || "根目录")}</span><span class="sp"></span><button class="btn ghost" data-close>取消</button><button class="btn primary" data-ok>保存</button>`;
    wrap.appendChild(foot);

    wrap.addEventListener("click", (e) => {
      if (e.target.closest("[data-close]")) return closeDialog();
      if (e.target.closest("[data-mk]")) {
        const name = ($("#sv-folder").value || "").trim();
        if (!name) return toast({ icon: "alert", title: "目录名不能为空", sub: "", warn: true });
        toast({ icon: "plus", title: "已新建目录", sub: (S.pick ? S.pick + "/" : "") + name + "（原型未真正写入）" });
        $("#sv-folder").value = "";
        return;
      }
      if (e.target.closest("[data-ok]")) {
        const name = ($("#sv-name").value || "").trim();
        if (!name) return toast({ icon: "alert", title: "文档名不能为空", sub: "", warn: true });
        closeDialog();
        toast({ icon: "cloud", title: "已保存到云端", sub: `${S.pick ? S.pick + "/" : ""}${name}` });
      }
    });
    return wrap;
  }

  function renderPick(host, node, depth) {
    // 根目录也是合法目标（落到库里最外层）——不补这一行，用户就没法把文档存到根。
    // 根目录也是合法目标（落到库里最外层）——不补这一行，用户就没法把文档存到根。
    if (node.path === "") {
      const onRoot = S.pick === "";
      const root = h("label", "pk-row" + (onRoot ? " on" : ""));
      root.style.setProperty("--depth", 0);
      root.innerHTML =
        `<span class="rad"></span>${ico("folderOpen", "ico-sm fld")}` +
        `<span class="nm">根目录</span><span class="cnt">${node.total} 个文档</span>`;
      root.addEventListener("click", () => { S.pick = ""; openDialog("save"); });
      host.appendChild(root);
      renderPick(host, { children: node.children }, 1); // 只把根的子目录铺下去，根行本身不再重复
      return;
    }
    for (const c of node.children) {
      const empty = c.total === 0;
      const on = S.pick === c.path;
      const row = h("label", "pk-row" + (on ? " on" : "") + (empty ? " empty" : ""));
      row.style.setProperty("--depth", depth);
      row.innerHTML =
        `<span class="rad"></span>${ico(empty ? "folder" : "folderOpen", "ico-sm fld")}` +
        `<span class="nm">${esc(c.name)}</span>` +
        `<span class="cnt">${empty ? "空" : c.total + " 个文档"}</span>`;
      row.addEventListener("click", () => { S.pick = c.path; openDialog("save"); });
      host.appendChild(row);
      renderPick(host, c, depth + 1);
    }
  }

  /* ============================================================ 菜单 ====== */
  const MENUS = [
    { id: "file", label: "文件", items: [
      { icon: "plus", label: "新建图表…", kbd: "Ctrl+N" },
      { icon: "folderOpen", label: "打开文件…", kbd: "Ctrl+O" },
      { icon: "folderOpen", label: "打开文件夹…" },
      { sep: true },
      { icon: "cloud", label: "保存到云端…", act: "save" },     // ← 需求 3
      { icon: "cloud", label: "云端文档…", act: "openCloud" },
      { sep: true },
      { icon: "save", label: "保存", kbd: "Ctrl+S" },
      { icon: "save", label: "另存为…", kbd: "Ctrl+Shift+S" },
      { sep: true },
      { icon: "close", label: "关闭标签页", kbd: "Ctrl+W" },
      { icon: "close", label: "退出", kbd: "Ctrl+Q" },
    ] },
    { id: "edit", label: "编辑", items: [{ icon: "undo", label: "撤销", kbd: "Ctrl+Z" }, { icon: "undo", label: "重做", kbd: "Ctrl+Y" }] },
    { id: "view", label: "视图", items: [{ icon: "bolt", label: "命令面板…", kbd: "Ctrl+Shift+P" }, { icon: "panelLeft", label: "切换侧栏", kbd: "Ctrl+B" }] },
    { id: "ai", label: "AI", items: [{ icon: "sparkles", label: "生成图表…", kbd: "Ctrl+I" }] },
    { id: "help", label: "帮助", items: [{ icon: "info", label: "关于 Diagramon" }] },
  ];

  function renderMenubar() {
    const bar = $("#menubar");
    bar.innerHTML = "";
    MENUS.forEach((m) => {
      const b = h("button", "tb-item", m.label);
      b.addEventListener("click", (e) => { e.stopPropagation(); openMenu(m, b); });
      bar.appendChild(b);
    });
  }

  function openMenu(menu, anchor) {
    closeMenu();
    const r = anchor.getBoundingClientRect();
    const pop = h("div", "pop menu");
    menu.items.forEach((it) => {
      if (it.sep) return void pop.appendChild(h("div", "pop-sep"));
      const row = h("button", "pop-row" + (it.act === "save" ? "" : ""));
      row.innerHTML = `<span class="ico-slot">${it.icon ? ico(it.icon, "ico-sm") : ""}</span><span class="lbl">${esc(it.label)}</span>${it.kbd ? `<span class="kbd">${esc(it.kbd)}</span>` : ""}`;
      if (it.act === "save") row.style.color = "var(--accent)";
      row.addEventListener("click", () => {
        closeMenu();
        if (it.act === "save") return openSave();
        if (it.act === "openCloud") return setView("cloud");
        toast({ icon: "info", title: it.label, sub: "原型未接线" });
      });
      pop.appendChild(row);
    });
    pop.style.left = r.left + "px";
    pop.style.top = r.bottom + 4 + "px";
    document.body.appendChild(pop);
    anchor.classList.add("open");
    document.body.dataset.menuOpen = "1";
  }
  function closeMenu() {
    $$(".pop.menu").forEach((n) => n.remove());
    $$(".tb-item.open").forEach((n) => n.classList.remove("open"));
    delete document.body.dataset.menuOpen;
  }

  /* ============================================================ 主题 ====== */
  function setTheme(t) {
    document.documentElement.dataset.theme = t;
    $("#btn-theme").innerHTML = ico(t === "light" ? "moon" : "sun");
  }

  /* ====================================================== 原型控制条 ===== */
  function renderProtoCtl() {
    const bar = $("#proto-ctl");
    bar.innerHTML =
      `<span class="badge">${ico("bug", "ico-sm")}原型脚手架 · 不随产品发布</span>` +
      `<span class="lbl">登录</span>` +
      `<span class="seg"><button data-s="in" class="${S.signedIn ? "on" : ""}">已登录</button><button data-s="out" class="${!S.signedIn ? "on" : ""}">未登录</button></span>` +
      `<span class="lbl">网关</span>` +
      `<span class="seg"><button data-c="1" class="${S.configured ? "on" : ""}">已配置</button><button data-c="0" class="${!S.configured ? "on" : ""}">未配置</button></span>` +
      `<span class="vline"></span>` +
      `<button class="btn sm" data-open="login">${ico("user")}登录窗口</button>` +
      `<button class="btn sm" data-open="save">${ico("save")}保存到云端</button>` +
      `<button class="close" data-hide title="收起控制条（?nocontrol=1 也可以）">${ico("close", "ico-sm")}</button>`;
    // 用 onclick 赋值（不是 addEventListener）：这个容器在多次 render 之间是同一个节点，
    // addEventListener 会一层层叠加，点一下触发好几遍。
    bar.onclick = (e) => {
      if (e.target.closest("[data-hide]")) { document.body.classList.add("no-ctl"); return; }
      const b = e.target.closest("button"); if (!b) return;
      if (b.dataset.s) S.signedIn = b.dataset.s === "in";
      if (b.dataset.c) S.configured = b.dataset.c === "1";
      if (b.dataset.open === "login") return openLogin();
      if (b.dataset.open === "save") return openSave();
      if (b.dataset.s || b.dataset.c) render();
    };
  }

  /* ============================================================ 渲染 ===== */
  function render() {
    renderActivity();
    renderSidebar();
    renderProtoCtl();
  }

  /* ============================================================ 启动 ===== */
  let booted = false;
  function boot() {
    if (booted) return;
    booted = true;

    // URL 状态：直达任意评审状态，例：
    //   ?view=cloud              云端文档视图
    //   ?dialog=login            直接打开登录窗口
    //   ?dialog=login&state=unverified  登录窗口的「邮箱未激活」态（带重发按钮）
    //   ?dialog=login&state=url         登录窗口的「注册地址可复制」块
    //   ?dialog=save             直接打开「保存到云端」
    //   ?signed=0                未登录态
    //   ?gateway=0               云网关未配置态
    const qs = new URLSearchParams(location.search);
    if (qs.get("view")) S.view = qs.get("view");
    if (qs.get("signed") === "0") S.signedIn = false;
    if (qs.get("gateway") === "0") S.configured = false;
    if (qs.get("filter")) S.filter = qs.get("filter");
    // 纯评审脚手架，?nocontrol=1 收起（截图 / 给对方看"产品长什么样"时用）
    if (qs.get("nocontrol") === "1") document.body.classList.add("no-ctl");

    renderMenubar();
    $("#btn-theme").addEventListener("click", () => setTheme(document.documentElement.dataset.theme === "light" ? "dark" : "light"));
    $("#side-close").addEventListener("click", () => toast({ icon: "panelLeft", title: "隐藏侧栏", sub: "Ctrl+B" }));
    $("#side-more").addEventListener("click", () => toast({ icon: "more", title: "侧栏更多操作", sub: "原型不展示" }));

    document.addEventListener("click", (e) => {
      if (!e.target.closest("#menubar") && !e.target.closest(".pop.menu")) closeMenu();
    });
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape") { if (S.dialog) closeDialog(); else closeMenu(); }
    });
    $("#overlay-dialog").addEventListener("mousedown", (e) => { if (e.target.id === "overlay-dialog") closeDialog(); });

    render();

    const dlg = qs.get("dialog");
    if (dlg === "login" || dlg === "save") {
      if (dlg === "login" && qs.get("state") === "unverified") S.unverified = true;
      openDialog(dlg);
      // 评审用：直接展开"注册地址可复制"那一块（不真去开浏览器）
      if (dlg === "login" && qs.get("state") === "url") {
        fillRegisterUrl(registerUrl());
        msg("ok", "浏览器没打开？复制下面的注册地址手动访问：");
      }
    }
    if (qs.get("menu")) {
      const m = MENUS.find((x) => x.id === qs.get("menu"));
      const btn = m && $$("#menubar .tb-item")[MENUS.indexOf(m)];
      if (btn) openMenu(m, btn);
    }
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
})();

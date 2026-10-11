/* 云网关的三个界面：**登录窗口**、**保存到云端窗口**、**云端目录树**。
 *
 * 拆出来的理由：这三件事以前挤在 `sidebar.js::viewCloud` 里（账户头 + 内联登录表单 + 扁平文档列表），
 * 而且活动栏的「云端文档」与底部的「账户」指向同一个视图。现在：
 *   - 账户        → `sidebar.js::viewAccount`（只读，不在这里）
 *   - 云端文档    → `sidebar.js::viewCloudDocs`（树；模型来自本文件的 `treeOf`）
 *   - 登录 / 保存 → 本文件的两个窗口
 *
 * 三条硬约定：
 *   1) **登录状态只有一份**：`state.cloud.status`（真源是 Rust 侧的 `cloud_status`，
 *      令牌在凭据库、永不回前端）。本文件不另存任何 signedIn 副本 —— 登录成功后只
 *      `emit("cloud:changed")`，两个视图自己重渲染。
 *   2) **注册不在客户端做**：只放「没有账号？去官网注册」链接，按 `{服务根地址}/register`
 *      打开系统浏览器；打不开时把地址回显成**可复制的只读输入框**。
 *   3) **不计内容、只读服务端**：目录/文档/配额全部来自 IPC，界面上不推算、不伪造。
 */
window.DGM = window.DGM || {};
(function () {
  "use strict";

  const state = DGM.state;
  const t = (k, v) => DGM.i18n.t(k, v);
  const icon = DGM.icon;
  const { $, $$, h, esc } = DGM.dom;

  const overlayEl = () => $("#overlay-dialog");

  /** 单一 onclick（与 dialogs.js 同款）：避免同一个 #dialog 上监听器越挂越多。
   *  关闭走 DGM.dialogs.close()（它会把 onclick 一并清掉，不留悬挂处理器）。 */
  function wire(onPick) {
    const d = $("#dialog");
    d.onclick = (e) => {
      if (e.target.closest("[data-close]")) return DGM.dialogs.close();
      const b = e.target.closest("[data-act]");
      if (b && !b.disabled && onPick) onPick(b.dataset.act, b, d);
    };
    overlayEl().onclick = (e) => {
      if (e.target === overlayEl()) DGM.dialogs.close();
    };
  }

  function head(title, ic) {
    return `<div class="dialog-head">${icon(ic || "info")}<h2>${esc(title)}</h2><span class="sp"></span><button class="icon-btn" data-close>${icon("close", "ico-sm")}</button></div>`;
  }

  function foot(note, buttons) {
    return `<div class="dialog-foot">${note ? `<span class="note">${note}</span>` : ""}<span class="sp"></span>${buttons}</div>`;
  }

  /* ------------------------------------------------------------------ 字节数 */

  /** 人类可读的字节数。0 就是 0，不猜。 */
  function fmtBytes(n) {
    n = Number(n) || 0;
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
    if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
    return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
  }

  /** 微信用点 → 人话。1 信用点 = 1e6 微信用点；最多两位小数、去尾随零。 */
  function fmtCredits(micros) {
    const n = (Number(micros) || 0) / 1e6;
    if (n === 0) return "0";
    const r = Math.round(n * 100) / 100;
    // 有少量用量但四舍五入成 0 时别显示成"没用过"—— 那是在说谎
    return r === 0 ? "<0.01" : String(r);
  }

  /** ISO 串 → 本地短日期。解析不出来留空（把原始串怼给用户比空白更糟）。 */
  function fmtDate(iso) {
    if (!iso) return "";
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return "";
    try {
      return d.toLocaleDateString();
    } catch (e) {
      return "";
    }
  }

  /* ------------------------------------------------------------------ 目录树 */

  /** 路径归一化：去首尾 `/`、折掉重复段（与服务端 `normalize_document_path` 同口径地"看"）。 */
  function normPath(p) {
    return String(p == null ? "" : p)
      .split("/")
      .filter((s) => s.length > 0)
      .join("/");
  }

  /**
   * 扁平目录列表 + 扁平文档列表 → 一棵带根的树。
   *
   * 服务端 `GET /v1/folders` 回的是**平铺**、**不含根**的目录列表；文档来自 `cloud_docs_list`
   * （只在文档项里带 `path`）。这里把两者合成树，并且：
   *   - 根节点由本函数补（服务端不返回根）；
   *   - 中间层缺了就按需补一个空壳节点（只信"列出来的"，不假设顺序完整）；
   *   - `total` = **子孙**文档总数（目录行显示它，比只显示直属数有用）。
   */
  function treeOf(folders, docs) {
    const root = { path: "", name: t("dlg.cloudSave.root"), children: [], docs: [], total: 0, hasChildren: false };
    const index = Object.create(null);
    index[""] = root;

    function ensure(path) {
      path = normPath(path);
      if (index[path]) return index[path];
      const i = path.lastIndexOf("/");
      const parent = ensure(i < 0 ? "" : path.slice(0, i));
      const node = { path, name: i < 0 ? path : path.slice(i + 1), children: [], docs: [], total: 0, hasChildren: false };
      parent.children.push(node);
      index[path] = node;
      return node;
    }

    for (const f of (folders && folders.items) || []) {
      const node = ensure(f.path);
      // 服务端给了更准的名字/子目录标记就用它的（名字可能含扩展名等我们推不出来的东西）
      if (f.name) node.name = f.name;
      node.reportedChildren = !!f.has_children;
      node.documentCount = f.document_count || 0;
      node.isExplicit = !!f.is_explicit;
    }

    for (const d of (docs && docs.items) || []) {
      ensure(d.path).docs.push(d);
    }

    const nameCmp = (a, b) => String(a.name).localeCompare(String(b.name), "zh");
    (function sortAndCount(node) {
      node.children.sort(nameCmp);
      node.docs.sort(nameCmp);
      let total = node.docs.length;
      for (const c of node.children) total += sortAndCount(c);
      node.total = total;
      node.hasChildren = node.children.length > 0 || !!node.reportedChildren;
      return total;
    })(root);

    return { root, index, find: (p) => index[normPath(p)] || root };
  }

  /** 子树里有没有命中这个词（自己命中、任一文档命中、或任一后代目录命中）。 */
  function subtreeMatches(node, q) {
    if (!q) return true;
    if (String(node.name).toLowerCase().includes(q)) return true;
    if (node.docs.some((d) => String(d.name).toLowerCase().includes(q))) return true;
    return node.children.some((c) => subtreeMatches(c, q));
  }

  /** 高亮命中片段（纯文本 → 带 <mark> 的 HTML；先 esc 再替换，不引 HTML 注入）。 */
  function mark(text, q) {
    const s = esc(String(text));
    if (!q) return s;
    const re = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "ig");
    return s.replace(re, (m) => `<mark>${m}</mark>`);
  }

  function fmtDot(format) {
    return `<span class="fmt-dot" style="background:var(--fmt-${format || "mermaid"})"></span>`;
  }

  /**
   * 「保存到云端」的目录单选树（仅目录；文档不进这里 —— 目标必须是目录）。
   * 根目录也是合法目标，所以第一行永远是它。
   */
  function pickTree(node, selected, depth) {
    depth = depth || 0;
    let html = "";
    if (depth === 0) {
      html += pickRow(node, selected, 0, true);
    }
    for (const c of node.children) {
      html += pickRow(c, selected, depth + 1, false);
      html += pickTree(c, selected, depth + 1);
    }
    return html;
  }

  function pickRow(node, selected, depth, isRoot) {
    const empty = node.total === 0;
    const on = normPath(selected) === node.path;
    const count = empty ? t("cloud.tree.empty") : t("cloud.tree.docsN", { n: node.total });
    return (
      `<label class="pk-row${on ? " on" : ""}${empty ? " empty" : ""}" style="--depth:${depth}">` +
      `<input type="radio" name="cloud-target" value="${esc(node.path)}"${on ? " checked" : ""} data-pick="${esc(node.path)}">` +
      `${icon(empty ? "folder" : "folderOpen", "ico-sm fld")}` +
      `<span class="nm">${esc(isRoot ? t("dlg.cloudSave.root") : node.name)}</span>` +
      `<span class="cnt">${count}</span>` +
      `</label>`
    );
  }

  /* ------------------------------------------------------------------ 登录窗口 */

  /** 注册页地址：{服务根地址}/register —— 与旧客户端 AuthService.ServiceSiteUrl 同一口径。 */
  function registerUrl() {
    const base = normBase((state.settings.cloud || {}).base_url || "");
    return base ? `${base}/register` : "";
  }

  function normBase(u) {
    return String(u || "").trim().replace(/\/+$/, "");
  }

  /** 登录窗口。成功与否都不影响本地功能；成功后只广播 `cloud:changed`。
   *
   *  `opts.onSuccess` = **登录之后接着要做的事**。登录往往只是一个动作的中途停顿
   *  （点「账户」是想看账户面板、点「保存到云端」是想存文件），登录完却不接着做，
   *  用户就得把刚才那步再点一遍 —— 所以由入口把"然后呢"传进来，这里负责续上。
   *  已经登录时**直接执行**它（不弹窗），调用方不必自己先判一次。
   */
  function openLogin(opts) {
    const onSuccess = (opts && opts.onSuccess) || null;
    if (state.cloud.status.signed_in) {
      if (onSuccess) return void onSuccess();
      DGM.toast({ icon: "cloud", title: t("side.cloud.signedIn"), sub: (state.cloud.status.account || {}).email || "" });
      return;
    }
    openLoginDialog(onSuccess);
  }

  function openLoginDialog(onSuccess) {
    const html =
      head(t("dlg.login.title"), "cloud") +
      `<div class="dialog-body">
         <label class="field"><span>${esc(t("dlg.login.email"))}</span>
           <input id="lg-email" type="text" spellcheck="false" autocomplete="off" placeholder="${esc(t("dlg.login.emailPlaceholder"))}"></label>
         <label class="field"><span>${esc(t("dlg.login.password"))}</span>
           <input id="lg-pass" type="password" autocomplete="off" placeholder="${esc(t("dlg.login.passwordPlaceholder"))}"></label>
         <div class="login-msg" id="lg-msg"></div>
         <div class="login-url" id="lg-url" hidden>
           <span class="lurl-label">${esc(t("dlg.login.registerUrlLabel"))}</span>
           <div class="lurl-row">
             <input id="lg-url-input" type="text" readonly spellcheck="false">
             <button class="btn sm" data-act="copyurl">${icon("copy", "ico-sm")}${esc(t("common.copy"))}</button>
           </div>
         </div>
       </div>` +
      foot(
        "",
        `<button class="btn ghost" data-close>${esc(t("common.cancel"))}</button>` +
          `<button class="btn primary" data-act="login" id="lg-ok">${esc(t("dlg.login.submit"))}</button>`,
      );

    const d = DGM.dialogs.open(html);
    // 页脚左侧的「去官网注册」是个**导航动作**（不是第三个按钮：那样看起来像点它能在这里完成注册）
    const footEl = $(".dialog-foot", d);
    if (footEl) {
      const link = h("button", "link-btn", esc(t("dlg.login.registerOnWeb")));
      link.dataset.act = "register";
      link.title = registerUrl() || t("dlg.login.noBaseUrl");
      footEl.insertBefore(link, footEl.firstChild);
    }
    // 重发激活邮件只在"邮箱未激活"时出现（默认隐藏）—— 它是唯一一种用户能自救的失败
    const okBtn = $("#lg-ok", d);
    if (okBtn) {
      const resend = h("button", "btn ghost sm", esc(t("dlg.login.resend")));
      resend.dataset.act = "resend";
      resend.hidden = true;
      footEl.insertBefore(resend, okBtn);
    }

    // 续做动作只挂在**这次对话的闭包**里：模块级变量会被下一次打开覆盖，
    // 而「取消/关闭」没有可靠的钩子去清它（点 × 走的是对话框自己的关闭路径）。
    const submit = () => submitLogin(onSuccess);

    const pass = $("#lg-pass", d);
    if (pass) {
      pass.addEventListener("keydown", (e) => {
        if (e.key === "Enter") submit();
      });
    }

    wire((act) => {
      if (act === "login") return submit();
      if (act === "register") return openRegister();
      if (act === "copyurl") return copyRegisterUrl();
      if (act === "resend") {
        // 服务端恒 204：成功只代表"请求已受理"，不代表邮件确实发出去了
        return loginMsg("ok", t("dlg.login.resent"));
      }
    });

    const first = $("#lg-email", d);
    if (first) setTimeout(() => first.focus(), 0);
  }

  function loginMsg(kind, text) {
    const m = $("#lg-msg");
    if (!m) return;
    m.className = "login-msg " + kind;
    m.textContent = text;
  }

  /** 空输入只给一句提示 —— **不做任何前置校验**：客户端拦一次就多一条会与服务端漂移的规则。 */
  async function submitLogin(afterLogin) {
    const emailEl = $("#lg-email");
    const passEl = $("#lg-pass");
    const email = emailEl ? emailEl.value.trim() : "";
    const password = passEl ? passEl.value : "";
    if (!email || !password) return loginMsg("err", t("side.cloud.needBoth"));

    const btn = $("#lg-ok");
    if (btn) {
      btn.disabled = true;
      btn.textContent = t("side.cloud.signingIn");
    }
    loginMsg("", "");
    try {
      const account = await state.cloudLogin(email, password);
      DGM.dialogs.close();
      DGM.toast({ icon: "cloud", title: t("side.cloud.signedIn"), sub: (account && account.email) || email });
      // 先关窗再续做：续做可能自己也要开窗（如「保存到云端」），
      // 顺序反了会被后开的窗口顶掉，或者两个窗口叠在一起。
      if (afterLogin) afterLogin();
    } catch (e) {
      const text = String((e && e.message) || e);
      // 邮箱未激活是**可以自救**的失败（密码没错，只是没点邮件里的链接）⇒ 给重发入口
      if (/email_not_verified|未激活|not_verified/i.test(text)) {
        const resend = $('[data-act="resend"]');
        if (resend) resend.hidden = false;
        loginMsg("err", t("dlg.login.unverified"));
      } else {
        loginMsg("err", text);
      }
    } finally {
      if (btn) {
        btn.disabled = false;
        btn.textContent = t("dlg.login.submit");
      }
    }
  }

  /**
   * 「没有账号？去官网注册」→ 系统浏览器打开官网注册页。
   *
   * 注册**不在客户端做**：邮箱激活、重发、条款/隐私文案都在网页端，客户端再实现一份
   * 就是第三个要同步的地方。地址**由配置的服务端根地址推导**，不硬编码域名。
   * 打不开浏览器时把地址回显成**可复制的只读输入框** —— 静默失败等于按了没反应。
   */
  function openRegister() {
    const url = registerUrl();
    if (!url) return loginMsg("err", t("dlg.login.noBaseUrl"));
    DGM.toast({ icon: "globe", title: t("dlg.login.opened"), sub: url });
    fillRegisterUrl(url);
    loginMsg("ok", t("dlg.login.openFailed"));
  }

  function fillRegisterUrl(url) {
    const box = $("#lg-url");
    const input = $("#lg-url-input");
    if (!box || !input) return;
    input.value = url;
    box.hidden = false;
    try {
      input.focus();
      input.select();
    } catch (e) {
      /* 某些环境不支持 select，忽略 */
    }
  }

  /** 复制注册地址：同步的 execCommand 先试，失败再退回异步 clipboard API。 */
  function copyRegisterUrl() {
    const input = $("#lg-url-input");
    if (!input || !input.value) return;
    try {
      input.focus();
      input.select();
    } catch (e) {
      /* ignore */
    }
    let ok = false;
    try {
      ok = document.execCommand("copy");
    } catch (e) {
      ok = false;
    }
    if (ok) return loginMsg("ok", t("dlg.login.copied"));
    const clip = navigator.clipboard;
    if (clip && clip.writeText) {
      clip.writeText(input.value).then(
        () => loginMsg("ok", t("dlg.login.copied")),
        () => loginMsg("err", t("dlg.login.copyFailed")),
      );
      return;
    }
    loginMsg("err", t("dlg.login.copyFailed"));
  }

  /* ------------------------------------------------------- 保存到云端窗口 */

  /** 入口：把**当前文档**保存到云端（选目录 + 定名字）。文件菜单与侧栏的快捷入口都走它。 */
  async function saveDoc() {
    if (!state.cloud.status.signed_in) {
      DGM.toast({ icon: "cloud", title: t("side.cloud.notSignedIn"), sub: t("acct.needLogin"), warn: true });
      // 登录成功后**把这次保存接着做完** —— 否则用户登完回来还得再点一次「保存到云端」
      return openLogin({ onSuccess: () => saveDoc() });
    }
    const doc = state.activeDoc();
    if (!doc) {
      DGM.toast({ icon: "info", title: t("status.noDoc"), sub: "", warn: true });
      return;
    }
    await ensureTree();
    openSaveDialog(doc);
  }

  /** 树要两份数据面（目录全集 + 文档列表）。缺哪份补哪份；失败就如实报错，不拿空树糊弄。 */
  async function ensureTree() {
    const tasks = [];
    if (!state.cloud.folders) tasks.push(state.cloudFolders());
    if (!state.cloud.docs) tasks.push(state.cloudDocs());
    if (tasks.length) {
      try {
        await Promise.all(tasks);
      } catch (e) {
        DGM.toast({ icon: "alert", title: t("side.cloud.error"), sub: String((e && e.message) || e), warn: true });
      }
    }
  }

  function openSaveDialog(doc) {
    const initialPath = normPath(doc.cloudPath || "");
    const initialName = doc.name || "";
    const html =
      head(t("dlg.cloudSave.title"), "cloud") +
      `<div class="dialog-body">
         <label class="field"><span>${esc(t("dlg.cloudSave.name"))}</span>
           <input id="cs-name" type="text" value="${esc(initialName)}" spellcheck="false"></label>
         <p class="field-hint">${esc(t("dlg.cloudSave.nameHint"))}</p>
         <span class="lurl-label">${esc(t("dlg.cloudSave.folder"))}</span>
         <div class="pk-tree" id="cs-tree"></div>
         <div class="newfolder">
           <input id="cs-new-folder" type="text" placeholder="${esc(t("dlg.cloudSave.newFolder"))}" spellcheck="false">
           <button class="btn sm ghost" data-act="mkdir">${esc(t("dlg.cloudSave.create"))}</button>
         </div>
       </div>` +
      foot(
        t("dlg.cloudSave.target", { path: initialPath || t("dlg.cloudSave.root") }),
        `<button class="btn ghost" data-close>${esc(t("common.cancel"))}</button>` +
          `<button class="btn primary" data-act="save">${esc(t("common.save"))}</button>`,
      );

    const d = DGM.dialogs.open(html, true);
    let pick = initialPath;

    const renderTree = () => {
      const host = $("#cs-tree", d);
      if (!host) return;
      const tree = treeOf(state.cloud.folders, state.cloud.docs);
      host.innerHTML = pickTree(tree.root, pick, 0);
      const note = $(".dialog-foot .note", d);
      if (note) note.textContent = t("dlg.cloudSave.target", { path: pick || t("dlg.cloudSave.root") });
    };
    renderTree();

    // 选目录：radio 的 change 事件（label 点击也会冒泡到这里）
    d.addEventListener("change", (e) => {
      const r = e.target.closest("[data-pick]");
      if (!r) return;
      pick = normPath(r.value);
      renderTree();
    });

    wire(async (act, btn) => {
      if (act === "mkdir") {
        const name = normPath(($("#cs-new-folder", d) || {}).value || "");
        if (!name) return DGM.toast({ icon: "alert", title: t("cloud.tree.folderNameRequired"), sub: "", warn: true });
        if (name.includes("/") || name.includes("\\")) {
          return DGM.toast({ icon: "alert", title: t("cloud.tree.folderNameInvalid"), sub: "", warn: true });
        }
        const path = pick ? `${pick}/${name}` : name;
        btn.disabled = true;
        try {
          await state.cloudFolderCreate(path);
          pick = path;
          const box = $("#cs-new-folder", d);
          if (box) box.value = "";
          renderTree();
          DGM.toast({ icon: "plus", title: t("cloud.tree.folderCreated"), sub: path });
        } catch (e) {
          // 409 name_taken / 422 路径不合法：服务端文案原样给用户（客户端不复刻它的路径规则）
          DGM.toast({ icon: "alert", title: t("cloud.tree.folderCreateFailed"), sub: String((e && e.message) || e), warn: true });
        } finally {
          btn.disabled = false;
        }
        return;
      }
      if (act === "save") {
        const name = (($("#cs-name", d) || {}).value || "").trim();
        if (!name) return DGM.toast({ icon: "alert", title: t("dlg.cloudSave.needName"), sub: "", warn: true });
        if (name.includes("/") || name.includes("\\")) {
          return DGM.toast({ icon: "alert", title: t("dlg.cloudSave.needName"), sub: t("dlg.cloudSave.nameHint"), warn: true });
        }
        btn.disabled = true;
        try {
          const saved = await state.cloudSaveActive(pick, name);
          DGM.dialogs.close();
          DGM.toast({ icon: "cloud", title: t("side.cloud.saved"), sub: `${pick ? pick + "/" : ""}${name || (saved && saved.name) || ""}` });
        } catch (e) {
          DGM.toast({ icon: "alert", title: t("side.cloud.error"), sub: String((e && e.message) || e), warn: true });
        } finally {
          btn.disabled = false;
        }
      }
    });
  }

  DGM.cloud = {
    openLogin,
    saveDoc,
    fmtBytes,
    fmtCredits,
    fmtDate,
    treeOf,
    subtreeMatches,
    mark,
    fmtDot,
    normPath,
    registerUrl,
    ensureTree,
  };
})();

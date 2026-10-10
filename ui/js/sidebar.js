/* 侧栏五视图：资源管理器 / 搜索 / 转换中心 / 云端 / 大纲。
 *
 * 设计取向：
 *   - 侧栏只读 state 与 app_info，不自己维护格式清单（一律 state.formatList）。
 *   - 「工作区树」现在是**真的**：树来自 Rust 的 `workspace_get`（扫盘结果），
 *     不是从前端把已打开文档的路径拼出来的赝品。没打开工作区时如实说没打开。
 *   - 写操作（新建 / 重命名 / 删除）一律经 state 的 workspace_* 命令，
 *     路径守卫在 Rust 侧（`resolve_in_root`）—— 前端不自己拼绝对路径。
 *   - 转换中心六方向全列（可用来自 app_info.formats[].convert_to，不可用来自
 *     i18n 里的说明文案），不可用方向给理由，不做「藏起来」。
 *   - 云端为未登录态：明确写「云网关未接入」，不伪造余额。
 *   - 大纲来自 Rust 侧 doc_outline。
 */
window.DGM = window.DGM || {};
(function () {
  "use strict";

  const state = DGM.state;
  const t = (k, v) => DGM.i18n.t(k, v);
  const icon = DGM.icon;
  const { $, h, esc } = DGM.dom;

  const el = DGM.shell.el;

  /* 折叠状态与搜索词都留在模块里：重渲染时用它们恢复现场。 */
  const collapsed = new Set();
  let searchQuery = "";

  /* ------------------------------------------------------------------ 打开文档 */

  async function openDocAt(id, line) {
    await state.activateDoc(id);
    if (DGM.editor && DGM.editor.loadActive) DGM.editor.loadActive();
    if (DGM.editor && DGM.editor.gotoLine && line) DGM.editor.gotoLine(line);
    if (DGM.preview && DGM.preview.schedule) DGM.preview.schedule();
    state.refreshDerived(id);
  }

  /* ------------------------------------------------------------------ 通用小件 */

  function section(key, titleHtml, rows, opts) {
    const wrap = h("div", "side-section" + (collapsed.has(key) ? " collapsed" : ""));
    const head = h("h4", "", `${icon("chevD", "ico-sm chev")}${titleHtml}`);
    const list = h("div", "side-list");
    rows.forEach((r) => list.appendChild(r));
    head.addEventListener("click", () => {
      wrap.classList.toggle("collapsed");
      if (collapsed.has(key)) collapsed.delete(key);
      else collapsed.add(key);
    });
    wrap.append(head, list);
    if (opts && opts.after) wrap.appendChild(opts.after);
    return wrap;
  }

  function tip(textHtml) {
    const n = h("div", "side-tip");
    n.innerHTML = `${icon("info", "ico-sm")}<span>${textHtml}</span>`;
    return n;
  }

  function fmtDot(format) {
    const span = h("span", "fmt-dot");
    const f = format ? state.fmtById(format) : null;
    span.style.background = f ? `var(--fmt-${f.id})` : "var(--faint)";
    return span;
  }

  /* ------------------------------------------------------------------ 资源管理器 */

  async function openFolderFlow() {
    try {
      const info = await state.openFolder();
      if (info) {
        state.pushOutput(t("status.wsOpened", { name: info.name }), "ok");
        if ((state.panels().sidebar_view || "explorer") !== "explorer") {
          DGM.shell.setSidebarView("explorer");
        }
      }
    } catch (e) {
      DGM.toast({ icon: "alert", title: t("status.wsFailed"), sub: String((e && e.message) || e), warn: true });
    }
  }

  function wsHeader() {
    const box = h("div", "ws-head");
    const root = state.workspace.root;
    const name = h("div", "ws-name");
    name.innerHTML = `${icon("folderOpen", "ico-sm")}<span class="nm">${esc(root ? state.workspace.name : t("side.workspace"))}</span>`;
    if (root) name.title = root;
    box.appendChild(name);

    const acts = h("div", "ws-acts");
    if (root) {
      acts.innerHTML =
        `<button class="icon-btn" data-a="new" title="${esc(t("side.ws.newFile"))}">${icon("plus", "ico-sm")}</button>` +
        `<button class="icon-btn" data-a="refresh" title="${esc(t("side.ws.refresh"))}">${icon("refresh", "ico-sm")}</button>` +
        `<button class="icon-btn" data-a="close" title="${esc(t("side.ws.closeWs"))}">${icon("close", "ico-sm")}</button>`;
    } else {
      acts.innerHTML = `<button class="icon-btn" data-a="open" title="${esc(t("side.ws.openFolder"))}">${icon("folderOpen", "ico-sm")}</button>`;
    }
    acts.addEventListener("click", async (e) => {
      const b = e.target.closest("button");
      if (!b) return;
      e.stopPropagation();
      const a = b.dataset.a;
      try {
        if (a === "open") return void openFolderFlow();
        if (a === "refresh") {
          await state.refreshWorkspace();
          return void DGM.status(t("side.ws.refresh"), "");
        }
        if (a === "close") {
          await state.closeWorkspace();
          return;
        }
        if (a === "new") return void newFileFlow();
      } catch (err) {
        DGM.status(t("status.wsFailed") + ": " + String((err && err.message) || err), "err");
      }
    });
    box.appendChild(acts);
    return box;
  }

  async function newFileFlow() {
    if (!state.workspace.root) return;
    const name = await DGM.dialogs.input({
      title: t("side.ws.newFile"),
      icon: "plus",
      label: t("side.ws.newPrompt"),
      placeholder: "architecture",
      hint: t("side.ws.newPrompt"),
    });
    if (!name) return;
    await state.newWorkspaceFile(state.workspace.root, name, "mermaid");
  }

  function isOpenPath(p) {
    return state.docs.some((d) => d.path && d.path === p);
  }

  function wsNode(node, depth) {
    const wrap = h("div", "side-node");
    const indent = depth ? " indent-" + Math.min(depth, 2) : "";

    if (node.dir) {
      const key = "ws:" + node.path;
      const open = !collapsed.has(key);
      const row = h("button", "tree-row ws-dir" + indent);
      row.innerHTML = `${icon("chevD", "ico-sm chev")}${icon(open ? "folderOpen" : "folder", "ico-sm")}<span class="nm">${esc(node.name)}</span>`;
      if (!open) row.querySelector(".chev").style.transform = "rotate(-90deg)";
      const kids = h("div", "ws-kids");
      kids.hidden = !open;
      node.children.forEach((c) => kids.appendChild(wsNode(c, depth + 1)));
      row.addEventListener("click", () => {
        if (collapsed.has(key)) collapsed.delete(key);
        else collapsed.add(key);
        kids.hidden = !kids.hidden;
        row.querySelector(".chev").style.transform = kids.hidden ? "rotate(-90deg)" : "";
        row.querySelector("use").setAttribute("href", kids.hidden ? "#i-folder" : "#i-folderOpen");
      });
      wrap.title = node.path;
      wrap.append(row, kids);
      return wrap;
    }

    const row = h("button", "tree-row ws-file" + indent + (isOpenPath(node.path) ? " on" : ""));
    row.append(fmtDot(node.format), h("span", "nm", esc(node.name)));
    row.title = node.path;
    const more = h("button", "x-row", icon("more", "ico-sm"));
    more.title = t("side.ws.rowMore");
    more.addEventListener("click", (e) => {
      e.stopPropagation();
      fileMenu(node, more);
    });
    row.appendChild(more);
    row.addEventListener("click", () => openWorkspaceFile(node));
    wrap.appendChild(row);
    return wrap;
  }

  function fileMenu(node, anchor) {
    const open = state.docs.find((d) => d.path === node.path);
    DGM.pop.near(
      [
        { label: t("side.ws.openFile"), icon: "file", act: "open", disabled: !!open },
        { sep: true },
        { label: t("side.ws.rename"), icon: "wand", act: "rename" },
        { label: t("side.ws.delete"), icon: "trash", act: "delete" },
        { sep: true },
        { label: t("side.ws.reveal"), icon: "folderOpen", act: "reveal" },
      ],
      anchor,
      (it) => runFileAct(it.act, node),
    );
  }

  async function runFileAct(act, node) {
    try {
      if (act === "open") return void openWorkspaceFile(node);
      if (act === "reveal") {
        const ok = await state.revealPath(node.path);
        if (!ok) DGM.toast({ icon: "info", title: t("side.ws.reveal"), sub: node.path });
        return;
      }
      if (act === "rename") {
        const name = await DGM.dialogs.input({
          title: t("side.ws.rename"),
          icon: "wand",
          label: t("side.ws.renamePrompt"),
          value: node.name,
        });
        if (!name || name === node.name) return;
        await state.renameWorkspaceEntry(node.path, name);
        return;
      }
      if (act === "delete") {
        const yes = await DGM.dialogs.confirm({
          title: t("common.delete"),
          ok: t("common.delete"),
          danger: true,
          body: esc(t("side.ws.deleteConfirm", { name: node.name })),
          warn: t("side.ws.deleteWarn"),
        });
        if (!yes) return;
        await state.deleteWorkspaceEntry(node.path);
      }
    } catch (e) {
      DGM.status(t("status.wsFailed") + ": " + String((e && e.message) || e), "err");
    }
  }

  async function openWorkspaceFile(node) {
    const open = state.docs.find((d) => d.path === node.path);
    if (open) return void openDocAt(open.id);
    try {
      await state.openPaths([node.path]);
      if (DGM.editor && DGM.editor.loadActive) DGM.editor.loadActive();
      if (DGM.preview && DGM.preview.schedule) DGM.preview.schedule();
      state.refreshDerived(state.active);
    } catch (e) {
      DGM.status(t("status.openFailed") + ": " + String((e && e.message) || e), "err");
    }
  }

  function docRow(d, on) {
    const row = h("button", "tree-row" + (on ? " on" : ""));
    row.append(fmtDot(d.format), h("span", "nm", esc(d.name)));
    if (d.dirty) row.appendChild(h("span", "meta", "·"));
    const x = h("button", "x-row", icon("close", "ico-sm"));
    x.title = t("common.close");
    x.addEventListener("click", (e) => {
      e.stopPropagation();
      if (DGM.shell.closeDocWithConfirm) DGM.shell.closeDocWithConfirm(d.id);
      else state.closeDoc(d.id);
    });
    row.appendChild(x);
    row.addEventListener("click", () => openDocAt(d.id));
    return row;
  }

  function statsLine() {
    const ws = state.workspace;
    const box = h("div", "ws-stats");
    box.append(h("span", "", esc(t("side.ws.count", { n: ws.file_count, m: ws.dir_count }))));
    if (ws.truncated) {
      const warn = h("span", "warn", `${icon("warn", "ico-sm")}${esc(t("side.ws.truncated", { n: ws.file_count }))}`);
      box.appendChild(warn);
    }
    return box;
  }

  function viewExplorer() {
    const box = h("div");
    const activeId = state.active;

    box.appendChild(wsHeader());

    if (!state.workspace.root) {
      box.appendChild(tip(esc(t("side.ws.none"))));
      const acts = h("div", "side-acts");
      acts.innerHTML = `<button class="btn sm" data-a="open">${icon("folderOpen")}${esc(t("side.ws.openFolder"))}</button>`;
      acts.addEventListener("click", () => openFolderFlow());
      box.appendChild(acts);
    } else {
      const tree = state.workspace.tree || [];
      if (!tree.length) {
        box.appendChild(tip(esc(t("side.ws.emptyDir"))));
      } else {
        box.appendChild(section("wsTree", esc(state.workspace.name), tree.map((n) => wsNode(n, 0))));
      }
      box.appendChild(statsLine());
    }

    // 打开的编辑器
    const docRows = state.docs.length
      ? state.docs.map((d) => docRow(d, d.id === activeId))
      : [tip(t("status.noDoc"))];
    box.appendChild(section("open", esc(t("side.openEditors")), docRows));

    // 最近打开（settings.recent）
    const recent = (state.settings && state.settings.recent) || [];
    const rows = recent.length
      ? recent.slice(0, 8).map((r) => {
          const openDoc = state.docs.find((d) => d.path && d.path === r.path);
          const row = h("button", "tree-row" + (openDoc && openDoc.id === activeId ? " on" : ""));
          row.append(fmtDot(r.format), h("span", "nm", esc(r.name)), h("span", "meta", esc(recentWhen(r.opened_at))));
          row.title = r.path;
          row.addEventListener("click", () => {
            if (openDoc) openDocAt(openDoc.id);
            else if (DGM.shell.openPath) DGM.shell.openPath(r.path);
          });
          return row;
        })
      : [tip(esc(t("side.recentEmpty")))];
    box.appendChild(section("recent", esc(t("side.recent")), rows));
    return box;
  }

  function recentWhen(ts) {
    if (!ts) return t("side.recentEmpty").replace(/[（）()]/g, "");
    const diff = Date.now() - ts;
    const m = Math.round(diff / 60000);
    if (m < 1) return t("common.justNow") || "now";
    if (m < 60) return t("common.minutesAgo", { n: m }) || m + "m";
    const hh = Math.round(m / 60);
    if (hh < 24) return t("common.hoursAgo", { n: hh }) || hh + "h";
    return t("common.daysAgo", { n: Math.round(hh / 24) }) || Math.round(hh / 24) + "d";
  }

  /* ------------------------------------------------------------------ 搜索 */

  function highlight(text, query, useRegex, caseSensitive) {
    if (!query) return esc(text);
    const flags = caseSensitive ? "g" : "gi";
    let re = null;
    if (useRegex) {
      try {
        re = new RegExp(query, flags);
      } catch (e) {
        return esc(text);
      }
    } else {
      re = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), flags);
    }
    return esc(text).replace(re, (m) => `<mark>${m}</mark>`);
  }

  function renderSearchResults(box) {
    box.innerHTML = "";
    const q = state.search.query.trim();
    if (!q) {
      box.appendChild(tip(esc(t("side.search.hint"))));
      return;
    }
    const hits = state.search.hits || [];
    const done = state.search.done;

    // 按文件分组（结果本来就是按文件顺序推过来的，用 Map 保序）
    const groups = new Map();
    for (const hit of hits) {
      const key = hit.path || hit.name;
      if (!groups.has(key)) groups.set(key, { name: hit.name, format: hit.format, path: hit.path, rows: [] });
      groups.get(key).rows.push(hit);
    }

    for (const [, g] of groups) {
      const f = state.fmtById(g.format);
      const head = h("h4", "", `${icon("chevD", "ico-sm chev")}${icon("file", "ico-sm")}<span class="nm">${esc(g.name)}</span><span class="meta">${g.rows.length}</span>`);
      head.title = g.path || g.name;
      const list = h("div", "side-list");
      g.rows.slice(0, 200).forEach((hit) => {
        const row = h("button", "tree-row indent-1");
        row.innerHTML = `<span class="meta">${hit.line}:${hit.column}</span><span class="nm hit">${highlight(hit.text, q, state.search.regex, state.search.caseSensitive)}</span>`;
        row.title = g.path ? `${g.path}:${hit.line}:${hit.column}` : `L${hit.line}`;
        row.addEventListener("click", () => state.openSearchHit(hit));
        list.appendChild(row);
      });
      const sec = h("div", "side-section");
      head.addEventListener("click", () => sec.classList.toggle("collapsed"));
      sec.append(head, list);
      sec.dataset.fmt = f.name;
      box.appendChild(sec);
    }

    if (done && done.error) {
      box.appendChild(tip(`${esc(t("side.search.regexError"))}: <code>${esc(done.error)}</code>`));
      return;
    }
    if (state.search.running) {
      box.appendChild(tip(esc(t("side.search.searching"))));
      return;
    }
    if (!hits.length) {
      box.appendChild(tip(esc(t("side.search.empty"))));
      return;
    }
    box.appendChild(tip(esc(t("side.search.summary", { n: done.total, m: done.files }))));
    if (done.truncated) box.appendChild(tip(esc(t("side.search.truncated", { n: done.total }))));
  }

  let searchTimer = 0;

  function viewSearch() {
    const box = h("div");
    const ws = state.workspace.root;
    const scope = h("div", "search-scope");
    scope.innerHTML = ws
      ? `${icon("folderOpen", "ico-sm")}<span>${esc(t("side.search.scopeWorkspace"))}</span>`
      : `${icon("file", "ico-sm")}<span>${esc(t("side.search.scopeOpen"))}</span>`;
    box.appendChild(scope);

    const field = h("div", "field");
    field.innerHTML =
      `<input id="side-search-input" type="text" placeholder="${esc(t("side.search.placeholder"))}" spellcheck="false">` +
      `<label class="search-regex"><input type="checkbox" id="side-search-regex"${state.search.regex ? " checked" : ""}>.*</label>` +
      `<label class="search-regex" title="Aa"><input type="checkbox" id="side-search-case"${state.search.caseSensitive ? " checked" : ""}>Aa</label>`;
    const input = $("input", field);
    input.value = searchQuery || state.search.query || "";
    const results = h("div", "search-results");

    input.addEventListener("input", () => {
      searchQuery = input.value;
      clearTimeout(searchTimer);
      // 去抖：全库搜索有真实 IO，别每敲一个字就扫一遍
      searchTimer = setTimeout(() => state.runSearch(searchQuery), 220);
    });
    $("input[type=checkbox]", field).addEventListener("change", (e) => {
      state.runSearch(searchQuery, { regex: e.target.checked });
    });
    $("#side-search-case", field).addEventListener("change", (e) => {
      state.runSearch(searchQuery, { caseSensitive: e.target.checked });
    });

    if (!ws) box.appendChild(tip(esc(t("side.search.needWorkspace"))));

    const stop = h("div", "side-acts");
    stop.hidden = !state.search.running;
    stop.innerHTML = `<button class="btn sm ghost" data-a="stop">${icon("close")}${esc(t("side.search.stop"))}</button>`;
    stop.addEventListener("click", () => state.cancelSearch());

    box.append(field, stop, results);
    renderSearchResults(results);
    return box;
  }

  /* ------------------------------------------------------------------ 转换中心 */

  function convCard(dir, muted) {
    const src = state.fmtById(dir.from);
    const dst = state.fmtById(dir.to);
    const b = h("button", "conv-card" + (muted ? " is-other" : ""));
    if (!dir.ok) b.disabled = true;
    b.innerHTML =
      `<span class="conv-flow">` +
      `<span class="chip ${src.id}">${esc(src.name)}</span>` +
      `<span class="arrow">${icon("chevR", "ico-sm")}</span>` +
      `<span class="chip ${dst.id}">${esc(dst.name)}</span>` +
      `<span class="conv-tag ${dir.ok ? "ok" : "off"}">${esc(dir.tag)}</span>` +
      `</span>` +
      `<span class="conv-note">${esc(dir.how)}</span>`;
    b.addEventListener("click", () => DGM.dialogs.convertTo(dir.to));
    return b;
  }

  function convMatrix(dirs) {
    const list = state.formatList;
    const find = (from, to) => dirs.find((c) => c.from === from && c.to === to);
    const grid = h("div", "conv-matrix");
    const head = h("div", "mx-row mx-head");
    head.innerHTML =
      `<span class="mx-src" title="${esc(t("side.convert.matrixHead"))}"></span>` +
      list.map((d) => `<span title="${esc(d.name)}">${esc(d.short || d.name)}</span>`).join("");
    grid.appendChild(head);
    for (const src of list) {
      const row = h("div", "mx-row");
      const cells = list
        .map((dst) => {
          if (src.id === dst.id) return `<span class="mx-c self" title="${esc(t("side.convert.self"))}">—</span>`;
          const c = find(src.id, dst.id);
          if (!c) return `<span class="mx-c no" title="${esc(t("side.convert.unplanned"))}">·</span>`;
          return `<span class="mx-c ${c.ok ? "yes" : "plan"}" title="${esc(src.name)} → ${esc(dst.name)}：${esc(c.how)}">${c.ok ? "✓" : "…"}</span>`;
        })
        .join("");
      row.innerHTML = `<span class="mx-src" title="${esc(src.name)}">${esc(src.short || src.name)}</span>${cells}`;
      grid.appendChild(row);
    }
    return grid;
  }

  function viewConvert() {
    const box = h("div");
    const d = state.activeDoc();
    const dirs = DGM.directions();

    if (!d) {
      box.appendChild(tip(esc(t("status.noDoc"))));
      return box;
    }
    const fmt = state.docFmt(d);
    const head = h("div", "conv-head");
    head.innerHTML = `<span>${esc(t("side.convert.from"))}</span><span class="chip ${fmt.id}">${esc(fmt.name)}</span>`;
    box.appendChild(head);

    const fromHere = dirs.filter((c) => c.from === fmt.id);
    if (fromHere.length) {
      fromHere.forEach((c) => box.appendChild(convCard(c, false)));
    } else {
      box.appendChild(tip(t("side.convert.targetOnly", { name: esc(fmt.name) })));
    }

    const all = h("div", "side-section" + (collapsed.has("conv-all") ? " collapsed" : ""));
    const hd = h("h4", "", `${icon("chevD", "ico-sm chev")}${esc(t("side.convert.all"))}`);
    const list = h("div", "side-list");
    list.appendChild(convMatrix(dirs));
    dirs.forEach((c) => {
      if (c.from === fmt.id) return;
      list.appendChild(convCard(c, true));
    });
    hd.addEventListener("click", () => {
      all.classList.toggle("collapsed");
      if (collapsed.has("conv-all")) collapsed.delete("conv-all");
      else collapsed.add("conv-all");
    });
    all.append(hd, list);
    box.appendChild(all);

    box.appendChild(tip(t("side.convert.note")));
    return box;
  }

  /* ------------------------------------------------------------------ 云端（真实数据） */

  /** 云端视图。三态如实呈现：未配置 / 未登录 / 已登录，一个都不伪造。 */
  function viewCloud() {
    const box = h("div");
    const cloud = state.cloud;
    const configured = !!((state.settings.cloud || {}).base_url || "").trim();

    if (!configured) {
      const me = h("div", "cloud-me");
      me.innerHTML =
        `<span class="avatar">${icon("user", "ico-sm")}</span>` +
        `<span class="who"><b>${esc(t("side.cloud.notSignedIn"))}</b><small>${esc(t("set.cloud.account"))}</small></span>`;
      box.appendChild(me);
      box.appendChild(tip(`<b>${esc(t("side.cloud.noBaseUrl"))}</b><br>${esc(t("side.cloud.noBaseUrlDesc"))}`));
      const acts = h("div", "side-acts");
      acts.innerHTML = `<button class="btn sm" data-a="cfg">${icon("settings")}${esc(t("side.cloud.configure"))}</button>`;
      acts.addEventListener("click", () => DGM.dialogs.settings("cloud"));
      box.appendChild(acts);
      return box;
    }

    // ── 账户头 ──
    const me = h("div", "cloud-me");
    if (cloud.status.signed_in && cloud.status.account) {
      const a = cloud.status.account;
      me.innerHTML =
        `<span class="avatar">${icon("user", "ico-sm")}</span>` +
        `<span class="who"><b>${esc(a.email || t("side.cloud.signedIn"))}</b>` +
        `<small>${esc(a.plan_name || "")}${a.quota_bytes ? ` · ${fmtBytes(a.used_bytes)} / ${fmtBytes(a.quota_bytes)}` : ""}</small></span>`;
    } else {
      me.innerHTML =
        `<span class="avatar">${icon("user", "ico-sm")}</span>` +
        `<span class="who"><b>${esc(t("side.cloud.notSignedIn"))}</b><small>${esc(t("side.cloud.accountSub"))}</small></span>`;
    }
    box.appendChild(me);

    // ── 未登录：内联登录表单 ──
    if (!cloud.status.signed_in) {
      const form = h("div", "cloud-login");
      form.innerHTML =
        `<label><span>${esc(t("side.cloud.email"))}</span><input id="cloud-email" type="text" spellcheck="false" autocomplete="off"></label>` +
        `<label><span>${esc(t("side.cloud.password"))}</span><input id="cloud-pass" type="password" autocomplete="off"></label>` +
        `<div class="cloud-login-acts">` +
        `<button class="btn sm primary" id="cloud-go">${icon("cloud")}${esc(t("side.cloud.signIn"))}</button>` +
        `<span class="hint" id="cloud-err">${esc(cloud.lastError || "")}</span></div>`;
      const go = () => {
        const email = form.querySelector("#cloud-email").value.trim();
        const pass = form.querySelector("#cloud-pass").value;
        const err = form.querySelector("#cloud-err");
        if (!email || !pass) {
          err.textContent = t("side.cloud.needBoth");
          return;
        }
        err.textContent = t("side.cloud.signingIn");
        state
          .cloudLogin(email, pass)
          .then(() => DGM.toast({ icon: "cloud", title: t("side.cloud.signedIn"), sub: email }))
          .catch((e) => (err.textContent = String((e && e.message) || e)));
      };
      form.querySelector("#cloud-go").addEventListener("click", go);
      form.querySelector("#cloud-pass").addEventListener("keydown", (e) => {
        if (e.key === "Enter") go();
      });
      box.appendChild(form);
      return box;
    }

    // ── 已登录：文档列表 + 动作 ──
    const acts = h("div", "side-acts");
    acts.innerHTML =
      `<button class="btn sm" data-a="save">${icon("save")}${esc(t("side.cloud.saveUp"))}</button>` +
      `<button class="btn sm ghost" data-a="refresh">${icon("refresh")}${esc(t("side.ws.refresh"))}</button>` +
      `<button class="btn sm ghost" data-a="out">${icon("close")}${esc(t("side.cloud.signOut"))}</button>`;
    acts.addEventListener("click", async (e) => {
      const b = e.target.closest("button");
      if (!b) return;
      try {
        if (b.dataset.a === "save") {
          const d = state.activeDoc();
          if (!d) return void DGM.toast({ icon: "info", title: t("status.noDoc"), sub: "", warn: true });
          const saved = await state.cloudSaveActive();
          DGM.toast({ icon: "cloud", title: t("side.cloud.saved"), sub: saved.name });
        } else if (b.dataset.a === "refresh") {
          await state.cloudDocs();
        } else if (b.dataset.a === "out") {
          await state.cloudLogout();
        }
      } catch (err) {
        DGM.toast({ icon: "alert", title: t("status.wsFailed"), sub: String((err && err.message) || err), warn: true });
      }
    });
    box.appendChild(acts);

    if (cloud.lastError) box.appendChild(tip(`${esc(t("side.cloud.error"))}: <code>${esc(cloud.lastError)}</code>`));

    const sec = h("div", "side-section");
    const docs = cloud.docs;
    const n = docs && docs.items ? docs.items.length : 0;
    const hd = h("h4", "", `${icon("chevD", "ico-sm chev")}${icon("cloud", "ico-sm")}${esc(t("side.cloud.docs"))}<span class="meta">${n}</span>`);
    const list = h("div", "side-list");
    if (cloud.loading) {
      list.appendChild(tip(esc(t("common.loading"))));
    } else if (!docs) {
      list.appendChild(tip(esc(t("side.cloud.docsEmpty"))));
    } else if (!n) {
      list.appendChild(tip(esc(t("side.cloud.docsEmpty"))));
    } else {
      docs.items.forEach((doc) => {
        const row = h("button", "tree-row indent-1");
        row.append(fmtDot(doc.format), h("span", "nm", esc(doc.name)));
        const x = h("button", "x-row", icon("trash", "ico-sm"));
        x.title = t("side.ws.delete");
        x.addEventListener("click", async (e) => {
          e.stopPropagation();
          const yes = await DGM.dialogs.confirm({
            title: t("common.delete"),
            ok: t("common.delete"),
            danger: true,
            body: esc(t("side.cloud.deleteConfirm", { name: doc.name })),
          });
          if (yes) state.cloudDeleteDoc(doc.id).catch((err) => DGM.status(String((err && err.message) || err), "err"));
        });
        row.appendChild(x);
        row.title = `${doc.path || "/"} · ${fmtBytes(doc.size)}`;
        row.addEventListener("click", () =>
          state.cloudOpenDoc(doc.id).catch((err) => DGM.status(String((err && err.message) || err), "err")),
        );
        list.appendChild(row);
      });
    }
    hd.addEventListener("click", () => sec.classList.toggle("collapsed"));
    sec.append(hd, list);
    box.appendChild(sec);

    if (docs && docs.quota_bytes) {
      const bar = h("div", "cloud-quota");
      bar.title = `${fmtBytes(docs.used_bytes)} / ${fmtBytes(docs.quota_bytes)}`;
      bar.innerHTML =
        `<progress max="100" value="${Math.min(100, Math.round((docs.used_bytes / docs.quota_bytes) * 100))}"></progress>` +
        `<span class="hint">${esc(fmtBytes(docs.used_bytes))} / ${esc(fmtBytes(docs.quota_bytes))}</span>`;
      box.appendChild(bar);
    }
    return box;
  }

  /** 字节数的人话形式。0 就是 0，不猜。 */
  function fmtBytes(n) {
    n = Number(n) || 0;
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
    return `${(n / 1024 / 1024).toFixed(1)} MB`;
  }

  /* ------------------------------------------------------------------ 大纲 */

  const KIND_ICON = { node: "diagram", edge: "swap", cluster: "layers", element: "layers" };

  function viewOutline() {
    const box = h("div");
    const d = state.activeDoc();
    if (!d) {
      box.appendChild(tip(esc(t("status.noDoc"))));
      return box;
    }
    box.appendChild(tip(esc(t("side.outline.tip"))));
    if (state.isCanvasDoc(d)) {
      box.appendChild(tip(esc(t("side.outline.canvas"))));
      return box;
    }
    const groups = state.outlineByDoc[d.id];
    if (!groups || !groups.length) {
      box.appendChild(tip(esc(t("side.outline.empty"))));
      return box;
    }
    groups.forEach((g, gi) => {
      if (!g || !g.rows || !g.rows.length) return;
      const sec = h("div", "side-section" + (collapsed.has("ol:" + gi) ? " collapsed" : ""));
      const hd = h("h4", "", `${icon("chevD", "ico-sm chev")}${esc(g.title)}<span class="meta">${g.rows.length}</span>`);
      const list = h("div", "side-list");
      g.rows.forEach((r) => {
        const row = h("button", "outline-row");
        const ic = KIND_ICON[r.kind] || "layers";
        row.innerHTML = `${icon(ic, "ico-sm")}<span class="nm">${esc(r.name)}</span><span class="kind">L${r.line}</span>`;
        row.title = `${t("side.outline.kind." + r.kind) || r.kind} · L${r.line}`;
        row.addEventListener("click", () => openDocAt(d.id, r.line));
        list.appendChild(row);
      });
      hd.addEventListener("click", () => {
        sec.classList.toggle("collapsed");
        if (collapsed.has("ol:" + gi)) collapsed.delete("ol:" + gi);
        else collapsed.add("ol:" + gi);
      });
      sec.append(hd, list);
      box.appendChild(sec);
    });
    return box;
  }

  /* ------------------------------------------------------------------ 渲染 */

  const VIEWS = { explorer: viewExplorer, search: viewSearch, convert: viewConvert, cloud: viewCloud, outline: viewOutline };

  function render() {
    const view = state.panels().sidebar_view || "explorer";
    if (el.sideTitle) el.sideTitle.textContent = t("side." + view) || t("act." + view) || view;
    const host = el.sideView;
    if (!host) return;

    // 折叠起来时不渲染（省事，也让面板隐藏时无需占位）
    if (!state.panels().sidebar) return;

    // 记住搜索框现场，重建后恢复
    const prev = document.activeElement;
    const restoreSearch = prev && prev.id === "side-search-input";
    const caret = restoreSearch ? prev.selectionStart : 0;

    host.innerHTML = "";
    const fn = VIEWS[view] || viewExplorer;
    host.appendChild(fn());

    if (restoreSearch) {
      const input = $("#side-search-input");
      if (input) {
        input.focus();
        try {
          input.setSelectionRange(caret, caret);
        } catch (e) {
          /* 某些类型不支持 setSelectionRange，忽略 */
        }
      }
    }
  }

  function focusSearch() {
    state.patchSettings({ panels: { sidebar_view: "search", sidebar: true } });
    setTimeout(() => {
      const input = $("#side-search-input");
      if (input) input.focus();
    }, 0);
  }

  /* 视图变化时重渲染；正文改动（session:changed）也要刷新打开列表与搜索命中。 */
  DGM.bus.on("session:changed", render);
  DGM.bus.on("settings:changed", render);
  DGM.bus.on("outline:changed", () => {
    if ((state.panels().sidebar_view || "explorer") === "outline") render();
  });
  DGM.bus.on("issues:changed", () => {
    /* 问题不直接进侧栏，但打开列表的脏标会随会话刷新，这里不重复渲染 */
  });
  // 工作区与搜索（第 4 步）：只在对应的视图里重渲染，免得在转换中心时白刷一遍
  DGM.bus.on("workspace:changed", () => {
    const v = state.panels().sidebar_view || "explorer";
    if (v === "explorer" || v === "search") render();
  });
  DGM.bus.on("search:changed", () => {
    if ((state.panels().sidebar_view || "explorer") === "search") render();
  });
  DGM.bus.on("fs:changed", () => {
    const v = state.panels().sidebar_view || "explorer";
    if (v === "explorer") render();
  });
  DGM.bus.on("cloud:changed", () => {
    if ((state.panels().sidebar_view || "explorer") === "cloud") render();
  });

  DGM.sidebar = { render, focusSearch, openDocAt, openFolderFlow, newFileFlow };
})();

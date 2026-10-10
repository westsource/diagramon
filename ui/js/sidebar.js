/* 侧栏五视图：资源管理器 / 搜索 / 转换中心 / 云端 / 大纲。
 *
 * 设计取向：
 *   - 侧栏只读 state 与 app_info，不自己维护格式清单（一律 state.formatList）。
 *   - 「工作区树」没有独立 IPC：把真实会话里打开文档的 path 归并成一棵树，
 *     如实标注「完整工作区扫描尚未接入」，不伪造目录。
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
  let searchUseRegex = false;

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

  /** 把真实会话里文档的 path 归并成目录树。返回 {label, children}。 */
  function buildTree(docs) {
    const withPath = docs.filter((d) => d.path);
    if (!withPath.length) return null;
    const dirOf = (p) => p.replace(/\\/g, "/").split("/").slice(0, -1).filter(Boolean);

    // 共同前缀目录
    let common = dirOf(withPath[0].path);
    for (const d of withPath.slice(1)) {
      const parts = dirOf(d.path);
      let i = 0;
      while (i < common.length && i < parts.length && common[i] === parts[i]) i += 1;
      common = common.slice(0, i);
    }

    const root = { name: common.length ? common[common.length - 1] : t("side.openEditors"), dirs: new Map(), files: [] };
    for (const d of withPath) {
      const parts = d.path.replace(/\\/g, "/").split("/").filter(Boolean);
      let node = root;
      for (const seg of parts.slice(common.length, parts.length - 1)) {
        if (!node.dirs.has(seg)) node.dirs.set(seg, { name: seg, dirs: new Map(), files: [] });
        node = node.dirs.get(seg);
      }
      node.files.push({ doc: d, name: parts[parts.length - 1] || d.name });
    }
    return root;
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

  function treeNode(node, depth, activeId) {
    const wrap = h("div", "side-node");
    const row = h("button", "tree-row" + (depth ? " indent-" + Math.min(depth, 2) : ""));
    const open = !collapsed.has("tree:" + node.name + ":" + depth);
    row.innerHTML = `${icon("chevD", "ico-sm chev")}${icon(open ? "folderOpen" : "folder", "ico-sm")}<span class="nm">${esc(node.name)}</span>`;
    if (!open) row.querySelector(".chev").style.transform = "rotate(-90deg)";
    const kids = h("div");
    kids.hidden = !open;
    for (const [, sub] of node.dirs) kids.appendChild(treeNode(sub, depth + 1, activeId));
    for (const f of node.files) {
      const d = f.doc;
      const r = h("button", "tree-row indent-" + Math.min(depth + 1, 2) + (d.id === activeId ? " on" : ""));
      r.append(fmtDot(d.format), h("span", "nm", esc(d.name)));
      r.addEventListener("click", () => openDocAt(d.id));
      kids.appendChild(r);
    }
    row.addEventListener("click", () => {
      const key = "tree:" + node.name + ":" + depth;
      if (collapsed.has(key)) collapsed.delete(key);
      else collapsed.add(key);
      kids.hidden = !kids.hidden;
      row.querySelector(".chev").style.transform = kids.hidden ? "rotate(-90deg)" : "";
      row.querySelector("use").setAttribute("href", kids.hidden ? "#i-folder" : "#i-folderOpen");
    });
    wrap.append(row, kids);
    return wrap;
  }

  function viewExplorer() {
    const box = h("div");
    const activeId = state.active;

    // 打开的编辑器
    const docRows = state.docs.length
      ? state.docs.map((d) => docRow(d, d.id === activeId))
      : [tip(t("status.noDoc"))];
    box.appendChild(section("open", esc(t("side.openEditors")), docRows));

    // 工作区（真实会话路径归并 + 诚实标注）
    const tree = buildTree(state.docs);
    if (tree) {
      box.appendChild(section("ws", esc(tree.name), [treeNode(tree, 0, activeId)]));
    } else {
      box.appendChild(section("ws", esc(t("side.openEditors")), [tip(esc(t("side.noWorkspace")))]));
    }

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

  function matchLines(body, query, useRegex) {
    const lines = body.split("\n");
    const out = [];
    let re = null;
    if (useRegex) {
      try {
        re = new RegExp(query, "gi");
      } catch (e) {
        return { error: String(e && e.message), hits: [] };
      }
    }
    const needle = query.toLowerCase();
    lines.forEach((ln, i) => {
      if (re) {
        re.lastIndex = 0;
        if (re.test(ln)) out.push({ line: i + 1, text: ln });
      } else if (needle && ln.toLowerCase().indexOf(needle) >= 0) {
        out.push({ line: i + 1, text: ln });
      }
    });
    return { error: null, hits: out };
  }

  function highlight(text, query, useRegex) {
    if (!query) return esc(text);
    if (useRegex) {
      try {
        const re = new RegExp(query, "gi");
        return esc(text).replace(re, (m) => `<mark>${m}</mark>`);
      } catch (e) {
        return esc(text);
      }
    }
    const idx = text.toLowerCase().indexOf(query.toLowerCase());
    if (idx < 0) return esc(text);
    // 逐处高亮（保留大小写）
    const re = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi");
    return esc(text).replace(re, (m) => `<mark>${m}</mark>`);
  }

  function renderSearchResults(box) {
    box.innerHTML = "";
    const q = searchQuery.trim();
    if (!q) {
      box.appendChild(tip(esc(t("side.search.hint"))));
      return;
    }
    const textDocs = state.docs.filter((d) => state.isTextDoc(d));
    let total = 0;
    let files = 0;
    let regexError = null;
    for (const d of textDocs) {
      const res = matchLines(d.body || "", q, searchUseRegex);
      if (res.error) {
        regexError = res.error;
        break;
      }
      if (!res.hits.length) continue;
      files += 1;
      total += res.hits.length;
      const f = state.docFmt(d);
      const head = h("h4", "", `${icon("chevD", "ico-sm chev")}${icon("file", "ico-sm")}<span class="nm">${esc(d.name)}</span><span class="meta">${res.hits.length}</span>`);
      const list = h("div", "side-list");
      res.hits.slice(0, 40).forEach((hit) => {
        const row = h("button", "tree-row indent-1");
        row.innerHTML = `<span class="meta">${hit.line}</span><span class="nm hit">${highlight(hit.text, q, searchUseRegex)}</span>`;
        row.addEventListener("click", () => openDocAt(d.id, hit.line));
        list.appendChild(row);
      });
      const sec = h("div", "side-section");
      head.addEventListener("click", () => sec.classList.toggle("collapsed"));
      sec.append(head, list);
      sec.title = f.name;
      box.appendChild(sec);
    }
    if (regexError) {
      box.appendChild(tip(`${esc(t("side.search.regexError"))}: <code>${esc(regexError)}</code>`));
      return;
    }
    box.appendChild(total ? tip(esc(t("side.search.summary", { n: total, m: files }))) : tip(esc(t("side.search.empty"))));
  }

  function viewSearch() {
    const box = h("div");
    const field = h("div", "field");
    field.innerHTML =
      `<input id="side-search-input" type="text" placeholder="${esc(t("side.search.placeholder"))}">` +
      `<label class="search-regex"><input type="checkbox" id="side-search-regex"${searchUseRegex ? " checked" : ""}>.*</label>` +
      `<span class="hint">${esc(t("side.search.hint"))}</span>`;
    const input = $("input", field);
    input.value = searchQuery;
    const results = h("div", "search-results");
    input.addEventListener("input", () => {
      searchQuery = input.value;
      renderSearchResults(results);
    });
    $("input[type=checkbox]", field).addEventListener("change", (e) => {
      searchUseRegex = e.target.checked;
      renderSearchResults(results);
    });
    box.append(field, results);
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

  /* ------------------------------------------------------------------ 云端（未登录） */

  function viewCloud() {
    const box = h("div");
    const me = h("div", "cloud-me");
    me.innerHTML =
      `<span class="avatar">${icon("user", "ico-sm")}</span>` +
      `<span class="who"><b>${esc(t("side.cloud.notSignedIn"))}</b><small>${esc(t("side.cloud.account"))}</small></span>`;
    box.appendChild(me);

    box.appendChild(tip(`<b>${esc(t("side.cloud.gwOff"))}</b><br>${esc(t("side.cloud.gwOffDesc"))}`));

    const sec = h("div", "side-section");
    const hd = h("h4", "", `${icon("chevD", "ico-sm chev")}${icon("cloud", "ico-sm")}${esc(t("side.cloud.docs"))}`);
    const list = h("div", "side-list");
    list.appendChild(tip(esc(t("side.cloud.docsEmpty"))));
    hd.addEventListener("click", () => sec.classList.toggle("collapsed"));
    sec.append(hd, list);
    box.appendChild(sec);

    const acts = h("div", "side-acts");
    acts.innerHTML =
      `<button class="btn sm" data-a="up" disabled>${icon("cloud")}${esc(t("side.cloud.saveUp"))}</button>` +
      `<button class="btn sm" data-a="down" disabled>${icon("download")}${esc(t("side.cloud.pull"))}</button>`;
    acts.addEventListener("click", (e) => {
      const b = e.target.closest("button");
      if (b && b.disabled) {
        DGM.toast({ icon: "cloud", title: t("side.cloud.gwOff"), sub: t("side.cloud.gwOffDesc"), warn: true });
      }
    });
    box.appendChild(acts);
    return box;
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

  DGM.sidebar = { render, focusSearch, openDocAt, buildTree };
})();

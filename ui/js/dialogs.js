/* 对话框：新建 / 转换 / 识图 / 设置（五页签）/ 快捷键 / 历史 / 说明 / 关于 / 未保存 / 退出 / 布局。
 *
 * 取向：
 *   - 一律经 state + settings_patch 落盘；密钥走 cred_set/cred_delete，永不回显。
 *   - 「不可用 ≠ 不存在」：不可用的转换方向照样列出并给理由。
 *   - 转换执行：契约里没有 convert 命令，前端只对能忠实本地预演的 mermaid → dot
 *     提供"预演 + 另开标签页"；其余方向明确写"执行由 Rust 侧提供，本步未接线"，
 *     不伪造转换结果。
 *   - 云网关未接入：账户页只显示说明，不伪造账号或余额。
 */
window.DGM = window.DGM || {};
(function () {
  "use strict";

  const state = DGM.state;
  const t = (k, v) => DGM.i18n.t(k, v);
  const icon = DGM.icon;
  const { $, $$, h, esc } = DGM.dom;

  /* 打开中的对话框若有未完成的输入（AI tab 的草稿模型），存这里 */
  let draftAi = null;

  /* ------------------------------------------------------------------ 外壳 */

  function overlay() {
    return $("#overlay-dialog");
  }

  function openDialog(html, wide) {
    const d = $("#dialog");
    d.className = "dialog" + (wide ? " wide" : "");
    d.innerHTML = html;
    overlay().hidden = false;
    return d;
  }

  function close() {
    overlay().hidden = true;
    $("#dialog").innerHTML = "";
    $("#dialog").onclick = null;
  }

  function head(title, ic) {
    return `<div class="dialog-head">${icon(ic || "info")}<h2>${esc(title)}</h2><span class="sp"></span><button class="icon-btn" data-close>${icon("close", "ico-sm")}</button></div>`;
  }

  function foot(note, buttons) {
    return `<div class="dialog-foot">${note ? `<span class="note">${esc(note)}</span>` : ""}<span class="sp"></span>${buttons}</div>`;
  }

  /** 单一 onclick（不用 addEventListener，避免同一 #dialog 上监听器越挂越多）。 */
  function wire(onPick) {
    const d = $("#dialog");
    d.onclick = (e) => {
      if (e.target.closest("[data-close]")) return close();
      const b = e.target.closest("[data-act]");
      if (b && !b.disabled && onPick) onPick(b.dataset.act, b, d);
    };
    overlay().onclick = (e) => {
      if (e.target === overlay()) close();
    };
  }

  /* ================================================================== 新建 */

  function newDoc(format) {
    const cards = state.formatList
      .map(
        (f) => `
      <button class="new-card" data-act="new:${f.id}">
        <span class="nc-head"><span class="fmt-dot" style="background:var(--fmt-${f.id})"></span><b>${esc(f.name)}</b><span class="chip ${f.id}">${esc(t(f.surface === "canvas" ? "dlg.new.surface.canvas" : "dlg.new.surface.text"))}</span></span>
        <span class="nc-ext">${esc((f.exts || []).join(" · "))}</span>
        <span class="nc-note">${esc(f.note || "")}</span>
        <span class="nc-caps">
          ${f.split_view ? `<span class="cap on">${icon("splitV", "ico-sm")}${esc(t("dlg.new.cap.split"))}</span>` : `<span class="cap off">${icon("splitV", "ico-sm")}${esc(t("dlg.new.cap.nosplit"))}</span>`}
          ${f.ai ? `<span class="cap on">${icon("sparkles", "ico-sm")}${esc(t("dlg.new.cap.ai"))}</span>` : `<span class="cap">${icon("swap", "ico-sm")}${esc(t("dlg.new.cap.viaMermaid"))}</span>`}
          ${f.layouts && f.layouts.length ? `<span class="cap on">${icon("diagram", "ico-sm")}${esc(t("dlg.new.cap.layouts", { n: f.layouts.length }))}</span>` : ""}
        </span>
      </button>`,
      )
      .join("");
    openDialog(
      head(t("dlg.new.title"), "plus") +
        `<div class="dialog-body"><div class="new-grid">${cards}</div>
         <div class="callout mt">${icon("sparkles")}<span>${t("dlg.new.aiHint")}</span></div></div>` +
        foot(t("dlg.new.foot"), `<button class="btn ghost" data-close>${esc(t("common.cancel"))}</button>`),
      true,
    );
    wire((act) => {
      if (act.startsWith("new:")) {
        close();
        create(act.slice(4));
      }
    });
  }

  async function create(format) {
    const doc = await state.newDoc(format);
    DGM.editor.loadActive();
    DGM.preview.schedule();
    if (doc) state.refreshDerived(doc.id);
    DGM.toast({ icon: "plus", title: state.fmtById(format).name, sub: doc ? doc.name : "" });
  }

  /* ================================================================== 转换 */
  /* 契约无 convert 命令：只对 mermaid → dot 做忠实本地预演；其余方向不伪造。 */

  function mermaidToDot(src) {
    const lines = src.split("\n");
    let graphName = "Converted";
    const nodes = new Map();
    const edges = [];
    const subs = [];
    const styleOf = (body) => {
      const m = body.match(/^\[([^\]]*)\]$/) || body.match(/^\(\(([^)]*)\)\)$/) || body.match(/^\(([^)]*)\)$/) || body.match(/^\{([^}]*)\}$/);
      return m ? m[1] : body.replace(/[[\](){}\s]/g, "");
    };
    const decl = (id, body) => {
      if (id && !nodes.has(id)) nodes.set(id, { label: styleOf(body), shape: body.includes("{") ? "diamond" : body.includes("(") ? "ellipse" : "box" });
    };
    for (const raw of lines) {
      const s = raw.trim();
      if (!s || s.startsWith("%%")) continue;
      let m;
      if ((m = /^(?:flowchart|graph)\s+(\w+)/i.exec(s))) {
        graphName = m[1].toUpperCase().includes("LR") ? "H" : "V";
        continue;
      }
      if (/^subgraph\b/i.test(s)) {
        subs.push({ name: s.replace(/^subgraph\s*/i, "").trim(), start: true });
        continue;
      }
      if (/^end$/i.test(s)) {
        subs.push({ end: true });
        continue;
      }
      if (/^(classDef|class|click|style|linkStyle|direction)\b/i.test(s)) continue;
      // A[..] --> B{..}
      const re = /([A-Za-z_][\w-]*)\s*(\[[^\]]*\]|\(\([^)]*\)\)|\([^)]*\)|\{[^}]*\})?/g;
      const parts = [];
      let mm;
      while ((mm = re.exec(s))) parts.push({ id: mm[1], body: mm[2] || "" });
      const arrow = /(-->|---|==>|-\.->|--x)/.test(s);
      if (arrow && parts.length >= 2) {
        decl(parts[0].id, parts[0].body);
        decl(parts[parts.length - 1].id, parts[parts.length - 1].body);
        const label = (s.match(/-{1,2}[->]?\s*\|([^|]*)\|/) || [])[1] || "";
        edges.push({ from: parts[0].id, to: parts[parts.length - 1].id, label });
      } else if (parts.length && parts[0].body) {
        decl(parts[0].id, parts[0].body);
      }
    }
    const escDot = (x) => String(x).replace(/"/g, '\\"');
    let out = `// 由 Mermaid 本地预演得到（前端 best-effort；最终以 Rust 侧转换器为准）\ndigraph ${graphName === "V" ? "Converted" : "Converted"} {\n    rankdir=TB;\n    node [shape=box, style="rounded"];\n`;
    const subOf = (id) => {
      // 不做精确归属：subgraph 的成员声明在原型源码里是裸边，这里保守地不归类
      return null;
    };
    for (const [id, n] of nodes) {
      const shape = n.shape === "diamond" ? "diamond" : n.shape === "ellipse" ? "ellipse" : "box";
      out += `    ${id} [label="${escDot(n.label)}", shape=${shape}];\n`;
    }
    for (const e of edges) {
      out += `    ${e.from} -> ${e.to}${e.label ? ` [label="${escDot(e.label)}"]` : ""};\n`;
    }
    out += "}\n";
    return out;
  }

  function localPreview(from, to, src) {
    if (from === "mermaid" && to === "dot") return { text: mermaidToDot(src), local: true };
    return { text: "", local: false };
  }

  function convertTo(presetTo) {
    const d = state.activeDoc();
    if (!d) {
      DGM.toast({ icon: "info", title: t("dlg.convert.title"), sub: t("status.noDoc") });
      return;
    }
    const dirs = DGM.directions().filter((c) => c.from === d.format);
    if (!dirs.length) {
      openDialog(
        head(t("dlg.convert.title"), "swap") +
          `<div class="dialog-body"><div class="callout warn">${icon("alert")}<span><b>${esc(t("dlg.convert.noSource", { name: state.docFmt(d).name }))}</b><br>${esc(t("dlg.convert.noSourceDesc", { name: state.docFmt(d).name }))}</span></div>
          <div class="btn-row mt"><button class="btn ai" data-act="ai">${icon("sparkles")}${esc(t("dlg.convert.letAI"))}</button><button class="btn ghost" data-act="center">${icon("swap")}${esc(t("dlg.convert.center"))}</button></div></div>` +
          foot("", `<button class="btn ghost" data-close>${esc(t("common.close"))}</button>`),
      );
      wire((a) => {
        close();
        if (a === "ai") DGM.ai.focus("chat");
        else DGM.shell.setSidebarView("convert");
      });
      return;
    }

    let sel = presetTo ? dirs.find((c) => c.to === presetTo) : null;
    if (!sel) sel = dirs.find((c) => c.ok) || dirs[0];

    const targets = dirs
      .map(
        (c) => `
      <button class="tgt ${c.to === sel.to ? "on" : ""} ${c.ok ? "" : "off"}" data-act="sel:${c.to}">
        <span class="fmt-dot" style="background:var(--fmt-${c.to})"></span>
        <b>${esc(state.fmtById(c.to).name)}</b>
        <span class="tg-tag ${c.ok ? "ok" : "off"}">${esc(c.tag)}</span>
        <small>${esc(c.how)}</small>
      </button>`,
      )
      .join("");

    const prev = localPreview(sel.from, sel.to, d.body);
    const previewHtml = prev.text
      ? `<pre class="conv-pre">${esc(prev.text)}</pre>`
      : `<div class="callout">${icon("info")}<span>${esc(t("dlg.convert.noPreview"))}</span></div>`;
    const meta = prev.text ? t("dlg.convert.previewMeta", { n: prev.text.split("\n").length }) : "";
    const newName = d.name.replace(/\.[^.]+$/, "") + (state.fmtById(sel.to).exts[0] || "." + sel.to);

    openDialog(
      head(t("dlg.convert.titleTo", { from: state.docFmt(d).name, to: state.fmtById(sel.to).name }), "swap") +
        `<div class="dialog-body">
          <div class="conv-flowline">
            <span class="chip ${sel.from}">${esc(state.docFmt(d).name)}</span>
            <span class="src-doc">${icon("file", "ico-sm")}${esc(d.name)}</span>
            <span class="arrow">${icon("chevR")}</span>
            <span class="chip ${sel.to}">${esc(state.fmtById(sel.to).name)}</span>
            <span class="src-doc new">${esc(newName)}</span>
          </div>
          <div class="conv-cols">
            <div class="conv-col"><h4>${esc(t("dlg.convert.pickTarget"))}</h4><div class="tgts">${targets}</div></div>
            <div class="conv-col"><h4>${esc(t("dlg.convert.preview"))} <span class="meta">${esc(meta)}</span></h4>${previewHtml}</div>
          </div>
          <div class="callout warn">${icon("alert")}<span>${t("dlg.convert.oneway", { name: esc(d.name) })}</span></div>
        </div>` +
        foot(sel.ok && prev.text ? "" : sel.ok ? t("dlg.convert.noPreview") : t("dlg.convert.notImpl"), 
          `<button class="btn ghost" data-close>${esc(t("common.cancel"))}</button>` +
          `<button class="btn primary" data-act="go"${sel.ok && prev.text ? "" : " disabled"}>${icon("swap")}${esc(t("dlg.convert.go"))}</button>`),
      true,
    );
    wire((act) => {
      if (act.startsWith("sel:")) {
        close();
        convertTo(act.slice(4));
        return;
      }
      if (act === "go") {
        close();
        runConvert(d, sel);
      }
    });
  }

  async function runConvert(srcDoc, dir) {
    const prev = localPreview(dir.from, dir.to, srcDoc.body);
    if (!prev.text) {
      DGM.toast({ icon: "alert", title: t("dlg.convert.notImpl"), sub: dir.how, warn: true });
      return;
    }
    const created = await state.newDoc(dir.to);
    if (!created) return;
    await state.setBodyNow(created.id, prev.text);
    DGM.editor.loadActive();
    DGM.preview.schedule();
    state.refreshDerived(created.id);
    state.pushConvert({
      from: dir.from,
      to: dir.to,
      doc: srcDoc.name,
      ok: true,
      note: dir.how,
    });
    state.pushOutput(t("dlg.convert.done", { name: state.fmtById(dir.to).name }) + " ← " + srcDoc.name, "ok");
    DGM.toast({ icon: "swap", title: t("dlg.convert.done", { name: state.fmtById(dir.to).name }), sub: t("dlg.convert.doneSub", { file: created.name }) });
  }

  /* ================================================================== 识图 */

  function vision() {
    const d = state.activeDoc();
    const fmtId = d ? d.format : "mermaid";
    let picked = null;
    const fmtOpts = state.formatList
      .map((f) => `<option value="${f.id}" ${f.id === fmtId ? "selected" : ""} ${f.ai ? "" : "disabled"}>${esc(f.name)}${f.ai ? "" : " " + esc(t("dlg.vision.canvasDisabled"))}</option>`)
      .join("");
    const modelOpts = state.hasModels()
      ? state.ai().models.map((m) => `<option value="${m.id}" ${m.id === (state.currentModel() || {}).id ? "selected" : ""}>${esc(m.name)}${m.has_key ? "" : " · " + esc(t("ai.model.none"))}</option>`).join("")
      : `<option value="">${esc(t("ai.model.none"))}</option>`;

    openDialog(
      head(t("dlg.vision.title"), "scan") +
        `<div class="dialog-body">
          <div class="dropzone" data-act="pick">${icon("image", "ico-lg")}<b>${esc(t("dlg.vision.drop"))}</b><small>${esc(t("dlg.vision.dropMeta"))}</small></div>
          <div class="field-row mt">
            <div class="field"><label>${esc(t("dlg.vision.fmt"))}</label><select id="v-fmt">${fmtOpts}</select><span class="hint">${esc(t("dlg.vision.fmtHint"))}</span></div>
            <div class="field"><label>${esc(t("dlg.vision.model"))}</label><select id="v-model">${modelOpts}</select><span class="hint">${esc(t("dlg.vision.modelHint"))}</span></div>
          </div>
          <div class="field"><label>${esc(t("dlg.vision.note"))}</label><textarea id="v-note" rows="2" placeholder="${esc(t("dlg.vision.notePlaceholder"))}"></textarea></div>
          <div class="callout">${icon("info")}<span>${t("dlg.vision.notice")}</span></div>
        </div>` +
        foot(t("dlg.vision.escap"),
          `<button class="btn ghost" data-close>${esc(t("common.cancel"))}</button>` +
          `<button class="btn" data-act="shot">${icon("scan")}${esc(t("dlg.vision.shot"))}</button>` +
          `<button class="btn ai" data-act="go">${icon("sparkles")}${esc(t("dlg.vision.go"))}</button>`),
      true,
    );

    const dz = $(".dropzone");
    dz.addEventListener("click", async () => {
      const img = await DGM.ai.pickImage();
      if (!img) return;
      picked = state.ui.aiAttachment;
      if (picked) {
        dz.classList.add("picked");
        dz.innerHTML = `<span class="pic">${picked.dataUrl ? `<img src="${picked.dataUrl}" alt="">` : icon("image", "ico-lg")}</span><b>${esc(picked.name)}</b><small>${esc(picked.meta || "")} · ${esc(t("dlg.vision.rePick"))}</small>`;
      }
    });

    wire((act) => {
      if (act === "shot") {
        close();
        DGM.toast({ icon: "scan", title: t("dlg.vision.shotToast"), sub: t("dlg.vision.shotToastSub") });
        return;
      }
      if (act === "go") {
        const fmtSel = $("#v-fmt");
        const modelSel = $("#v-model");
        const note = $("#v-note");
        const outFmt = (fmtSel && fmtSel.value) || fmtId;
        const modelId = modelSel && modelSel.value;
        if (!state.hasModels()) {
          close();
          DGM.toast({ icon: "key", title: t("ai.needModel"), sub: "", warn: true });
          DGM.dialogs.settings("ai");
          return;
        }
        close();
        DGM.ai.focus("vision");
        if (modelId) state.patchSettings({ ai: { default_model: modelId } });
        DGM.ai.prefill(note && note.value ? note.value : t("ai.input.vision"), false);
        if (picked) state.ui.aiAttachment = picked;
        DGM.ai.render();
        if (outFmt && outFmt !== fmtId && d) {
          DGM.toast({ icon: "info", title: state.fmtById(outFmt).name, sub: t("dlg.vision.fmtHint") });
        }
      }
    });
  }

  /* ================================================================== 设置 */

  const TABS = [
    { id: "appearance", label: "set.tab.appearance", icon: "palette" },
    { id: "editor", label: "set.tab.editor", icon: "code" },
    { id: "ai", label: "set.tab.ai", icon: "sparkles" },
    { id: "convert", label: "set.tab.convert", icon: "swap" },
    { id: "cloud", label: "set.tab.cloud", icon: "cloud" },
  ];

  function switchRow(on, label, subKey, act) {
    return `<div class="switch${on ? " on" : ""}" data-switch="${act}"><span class="track"></span><span class="txt">${esc(label)}${subKey ? `<small>${esc(t(subKey))}</small>` : ""}</span></div>`;
  }

  function pAppearance() {
    const s = state.settings || {};
    const themes = [
      { id: "light", label: "set.theme.light", desc: "set.theme.lightDesc" },
      { id: "dark", label: "set.theme.dark", desc: "set.theme.darkDesc" },
      { id: "auto", label: "set.theme.auto", desc: "set.theme.autoDesc" },
    ];
    const densities = ["compact", "normal", "roomy"];
    const accents = ["pine", "indigo", "lotus", "ochre", "graphite"];
    return `
      <div class="field"><label>${esc(t("set.appearance.theme"))}</label>
        <div class="theme-picks">${themes.map((x) => `<button class="theme-pick ${s.theme === x.id ? "on" : ""}" data-act="theme:${x.id}"><span class="tp-prev ${x.id}"><i class="a"></i><i class="b"></i><i class="c"></i></span><b>${esc(t(x.label))}</b><small>${esc(t(x.desc))}</small></button>`).join("")}</div></div>
      <div class="field"><label>${esc(t("set.appearance.density"))}</label>
        <div class="seg">${densities.map((x) => `<button class="${s.density === x ? "on" : ""}" data-act="density:${x}">${esc(t("set.density." + x))}</button>`).join("")}</div></div>
      <div class="field"><label>${esc(t("set.appearance.accent"))}</label>
        <div class="swatch-row">${accents.map((x) => `<button class="swatch ${s.accent === x ? "on" : ""}" data-act="accent:${x}" title="${esc(t("set.accent." + x))}"><i class="sw-${x}"></i></button>`).join("")}</div>
        <span class="hint">${esc(t("set.accent.hint"))}</span></div>`;
  }

  function pEditor() {
    const s = state.settings || {};
    const e = s.editor || {};
    const views = [
      { id: "source", label: "viewmode.source" },
      { id: "split", label: "viewmode.split" },
      { id: "preview", label: "viewmode.preview" },
    ];
    return `
      <div class="field"><label>${esc(t("set.editor.defaultView"))}</label>
        <div class="seg">${views.map((x) => `<button class="${e.default_view === x.id ? "on" : ""}" data-act="dview:${x.id}">${esc(t(x.label))}</button>`).join("")}</div>
        <span class="hint">${esc(t("set.editor.defaultViewHint"))}</span></div>
      <div class="field-row">
        <div class="field narrow"><label>${esc(t("set.editor.fontSize"))}</label><input type="number" min="10" max="22" value="${e.font_size || 13}" id="e-fs"></div>
        <div class="field"><label>${esc(t("set.editor.ratio"))}</label><input type="range" min="20" max="80" value="${(s.panels && s.panels.split_src) || 46}" id="e-split"><span class="hint">${esc(t("set.editor.ratioHint"))}</span></div>
      </div>
      <div class="field"><label>${esc(t("set.editor.debounce"))}</label><input type="number" min="0" max="2000" step="50" value="${e.debounce_ms || 350}" id="e-debounce"><span class="hint">${esc(t("set.editor.debounceHint"))}</span></div>
      ${switchRow(!!e.lint, t("set.editor.lint"), "set.editor.lintHint", "lint")}
      ${switchRow(!!e.per_doc_view, t("set.editor.perDocView"), null, "perdoc")}
      <div class="callout">${icon("keyboard")}<span>${t("set.editor.keysCallout")}</span></div>`;
  }

  function pAI() {
    const ai = state.ai();
    const models = ai.models || [];
    const rows = models.length
      ? models
          .map(
            (m) => `
      <div class="model-row" data-id="${esc(m.id)}">
        <div class="mr-head"><b>${esc(m.name)}</b><span class="chip">${esc(m.provider)}</span>
          <span class="key-tag ${m.has_key ? "ok" : "off"}">${m.has_key ? esc(t("set.ai.keyStored", { hint: m.key_hint })) : esc(t("set.ai.keyMissing"))}</span>
          <span class="sp"></span>
          <button class="icon-btn" data-act="del:${esc(m.id)}" title="${esc(t("set.ai.removeModel"))}">${icon("trash", "ico-sm")}</button>
        </div>
        <div class="mr-grid">
          <label>${esc(t("set.ai.modelName"))}<input type="text" data-f="name" value="${esc(m.name)}"></label>
          <label>${esc(t("set.ai.provider"))}<input type="text" data-f="provider" value="${esc(m.provider)}" title="${esc(t("set.ai.providerHint"))}"></label>
          <label>${esc(t("set.ai.baseUrl"))}<input type="text" data-f="base_url" value="${esc(m.base_url)}"></label>
          <label>${esc(t("set.ai.modelId"))}<input type="text" data-f="model" value="${esc(m.model)}" placeholder="${esc(t("set.ai.modelIdPh"))}"></label>
          <label>${esc(t("set.ai.maxTokens"))}<input type="number" data-f="max_tokens" value="${m.max_tokens}"></label>
          <label>${esc(t("set.ai.temperature"))}<input type="number" step="0.1" data-f="temperature" value="${m.temperature}"></label>
          <label class="wide">${esc(t("set.ai.apiKey"))}<input type="password" data-f="__key" placeholder="${m.has_key ? esc(t("set.ai.keyStored", { hint: m.key_hint })) : esc(t("set.ai.keyMissing"))}"></label>
        </div>
      </div>`,
          )
          .join("")
      : `<div class="callout warn">${icon("key")}<span>${esc(t("set.ai.gatewayOff"))}<br>${esc(t("set.ai.noModels"))}</span></div>`;

    const defaultOpts = models.map((m) => `<option value="${esc(m.id)}" ${m.id === ai.default_model ? "selected" : ""}>${esc(m.name)}</option>`).join("");
    return `
      <div class="field"><label>${esc(t("set.ai.models"))}</label>
        <div class="model-list" id="model-list">${rows}</div>
        <div class="btn-row mt"><button class="btn sm" data-act="add">${icon("plus")}${esc(t("set.ai.addModel"))}</button><span class="hint">${esc(t("set.ai.addModelHint"))}</span></div></div>
      <div class="field"><label>${esc(t("set.ai.defaultModel"))}</label><select data-act="noop" id="ai-default">${defaultOpts}</select><span class="hint">${esc(t("set.ai.defaultModelHint"))}</span></div>
      ${switchRow(!!ai.context_from_doc, t("set.ai.contextFromDoc"), null, "ctxdoc")}
      ${switchRow(!!ai.render_retry, t("set.ai.renderRetry"), "set.ai.renderRetryHint", "retry")}
      ${switchRow(!!ai.vision_notice_accepted, t("set.ai.visionNotice"), null, "vnotice")}`;
  }

  function pConvert() {
    const rows = state.formatList
      .map(
        (f) => `<tr><td><span class="chip ${f.id}">${esc(f.name)}</span></td><td>${esc((f.exts || []).join(" "))}</td><td>${esc(f.surface)}</td><td>${f.split_view ? "✓" : "—"}</td><td>${f.ai ? "✓" : "—"}</td><td>${esc((f.convert_to || []).map((x) => state.fmtById(x).short || x).join(" ") || "—")}</td><td>${esc((f.layouts || []).join(" ") || "—")}</td></tr>`,
      )
      .join("");
    const dirs = DGM.directions();
    const mx = dirs
      .map((c) => `<div class="mx-line"><span class="chip ${c.from}">${esc(state.fmtById(c.from).short || c.from)}</span>${icon("chevR", "ico-sm")}<span class="chip ${c.to}">${esc(state.fmtById(c.to).short || c.to)}</span><span class="mx-tag ${c.ok ? "ok" : "off"}">${esc(c.tag)}</span><span class="mx-how">${esc(c.how)}</span></div>`)
      .join("");
    return `
      <div class="field"><label>${esc(t("set.convert.registry"))}</label>
        <div class="reg-wrap"><table class="reg-table"><thead><tr><th>Name</th><th>ext</th><th>surface</th><th>split</th><th>ai</th><th>→</th><th>layouts</th></tr></thead><tbody>${rows}</tbody></table></div></div>
      <div class="field"><label>${esc(t("conv.title"))}</label><div class="mx-list">${mx}</div>
        <div class="callout warn">${icon("info")}<span>${t("set.convert.reverseWarn")}</span></div></div>`;
  }

  function pCloud() {
    return `
      <div class="cloud-me"><span class="avatar">${icon("user", "ico-sm")}</span><span class="who"><b>${esc(t("side.cloud.notSignedIn"))}</b><small>${esc(t("set.cloud.account"))}</small></span></div>
      <div class="callout warn">${icon("cloud")}<span><b>${esc(t("set.cloud.offTitle"))}</b><br>${esc(t("set.cloud.offDesc"))}</span></div>
      <div class="switch on ro"><span class="track"></span><span class="txt">${esc(t("set.cloud.offlineGuard"))}<small>${esc(t("set.cloud.offlineGuardHint"))}</small></span></div>
      <div class="switch ro"><span class="track"></span><span class="txt">${esc(t("set.cloud.telemetry"))}</span></div>`;
  }

  const PANES = { appearance: pAppearance, editor: pEditor, ai: pAI, convert: pConvert, cloud: pCloud };

  function settings(tab) {
    const cur = tab || "appearance";
    draftAi = JSON.parse(JSON.stringify(state.ai()));
    openDialog(
      head(t("dlg.settings.title"), "settings") +
        `<div class="dialog-body has-tabs">
          <div class="dlg-tabs">${TABS.map((x) => `<button class="dlg-tab ${x.id === cur ? "on" : ""}" data-act="tab:${x.id}">${icon(x.icon, "ico-sm")}${esc(t(x.label))}</button>`).join("")}</div>
          <div class="dlg-pane">${(PANES[cur] || pAppearance)()}</div>
        </div>` +
        foot(t("dlg.settings.foot"),
          `<button class="btn ghost" data-close>${esc(t("common.close"))}</button>` +
          `<button class="btn primary" data-act="save">${icon("check")}${esc(t("common.save"))}</button>`),
      true,
    );

    const pane = $(".dlg-pane");

    // 即时生效的开关（不等保存，直接落盘）
    $$(".switch[data-switch]", pane).forEach((sw) => {
      sw.addEventListener("click", () => {
        const a = sw.dataset.switch;
        const on = sw.classList.toggle("on");
        if (a === "lint") state.patchSettings({ editor: { lint: on } });
        else if (a === "perdoc") state.patchSettings({ editor: { per_doc_view: on } });
        else if (a === "ctxdoc") state.patchSettings({ ai: { context_from_doc: on } });
        else if (a === "retry") state.patchSettings({ ai: { render_retry: on } });
        else if (a === "vnotice") state.patchSettings({ ai: { vision_notice_accepted: on } });
      });
    });

    const split = $("#e-split");
    if (split) split.addEventListener("input", () => state.patchSettings({ panels: { split_src: Number(split.value) } }));

    wire((act, btn) => {
      if (act.startsWith("tab:")) {
        close();
        settings(act.slice(4));
        return;
      }
      if (act.startsWith("theme:")) {
        const v = act.slice(6);
        state.patchSettings({ theme: v });
        if (btn) {
          $$(".theme-pick", pane).forEach((x) => x.classList.toggle("on", x === btn));
        }
        return;
      }
      if (act.startsWith("density:")) {
        const v = act.slice(8);
        state.patchSettings({ density: v });
        $$(".seg button", pane).forEach((x) => x.classList.toggle("on", x === btn));
        return;
      }
      if (act.startsWith("accent:")) {
        const v = act.slice(7);
        state.patchSettings({ accent: v });
        $$(".swatch", pane).forEach((x) => x.classList.toggle("on", x === btn));
        return;
      }
      if (act.startsWith("dview:")) {
        const v = act.slice(6);
        state.patchSettings({ editor: { default_view: v } });
        $$(".seg button", pane).forEach((x) => x.classList.toggle("on", x === btn));
        return;
      }
      if (act === "add") return addModel();
      if (act.startsWith("del:")) return removeModel(act.slice(4));
      if (act === "save") return saveSettings(cur);
      if (act === "noop") return;
    });
  }

  function addModel() {
    if (!draftAi) draftAi = JSON.parse(JSON.stringify(state.ai()));
    const id = "m" + Date.now().toString(36);
    draftAi.models = draftAi.models || [];
    draftAi.models.push({ id, name: t("common.new") + " " + (draftAi.models.length + 1), provider: "openai", base_url: "", model: "", max_tokens: 4096, temperature: 0.2, has_key: false, key_hint: "" });
    if (!draftAi.default_model) draftAi.default_model = id;
    close();
    settings("ai");
    // 重新渲染后滚动到新条目
    setTimeout(() => {
      const list = $("#model-list");
      if (list && list.lastElementChild) list.lastElementChild.scrollIntoView({ block: "nearest" });
    }, 0);
  }

  function removeModel(id) {
    if (!draftAi) draftAi = JSON.parse(JSON.stringify(state.ai()));
    draftAi.models = (draftAi.models || []).filter((m) => m.id !== id);
    if (draftAi.default_model === id) draftAi.default_model = (draftAi.models[0] || {}).id || "";
    close();
    settings("ai");
  }

  /** 收集 AI 页签里手改的字段 + 需要写凭据库的密钥，然后一次性落盘。 */
  async function saveSettings(cur) {
    const pane = $(".dlg-pane");
    if (cur === "ai" && pane) {
      draftAi = draftAi || JSON.parse(JSON.stringify(state.ai()));
      const byId = {};
      (draftAi.models || []).forEach((m) => (byId[m.id] = m));
      const keyWrites = [];
      $$(".model-row", pane).forEach((row) => {
        const id = row.dataset.id;
        const m = byId[id];
        if (!m) return;
        $$("[data-f]", row).forEach((inp) => {
          const f = inp.dataset.f;
          if (f === "__key") {
            if (inp.value) keyWrites.push({ id, secret: inp.value });
            return;
          }
          if (f === "max_tokens") m.max_tokens = Number(inp.value) || m.max_tokens;
          else if (f === "temperature") m.temperature = Number(inp.value) || 0;
          else m[f] = inp.value;
        });
      });
      const def = $("#ai-default");
      if (def && def.value) draftAi.default_model = def.value;

      // 先写密钥（失败不阻断保存其它设置）
      for (const w of keyWrites) {
        try {
          await DGM.ipc.invoke("cred_set", { key: w.id, secret: w.secret });
        } catch (e) {
          DGM.toast({ icon: "alert", title: t("set.ai.apiKey"), sub: (e && e.message) || String(e), warn: true });
        }
      }
      await state.patchSettings({ ai: draftAi });
    }
    close();
    DGM.toast({ icon: "check", title: t("dlg.settings.saved"), sub: "" });
    DGM.shell.render();
  }

  /* ================================================================== 快捷键 */

  function keys() {
    const groups = [
      { g: "keys.g.ai", rows: [["Ctrl+I", "keys.ai.i0"], ["Ctrl+Shift+I", "keys.ai.i1"], ["Ctrl+Shift+A", "keys.ai.i2"], ["Enter / Shift+Enter", "keys.ai.i3"], ["Ctrl+Enter", "keys.ai.i4"]] },
      { g: "keys.g.panels", rows: [["Ctrl+B", "keys.panels.i0"], ["Ctrl+J", "keys.panels.i1"], ["Ctrl+Shift+P 或 F1", "keys.panels.i2"], ["Ctrl+1 / Ctrl+2 / Ctrl+3", "keys.panels.i3"], ["Ctrl+Shift+F", "keys.panels.i4"], ["Ctrl+K Ctrl+T", "keys.panels.i5"], ["Alt+1…Alt+5", "keys.panels.i6"]] },
      { g: "keys.g.file", rows: [["Ctrl+N / Ctrl+O / Ctrl+S", "keys.file.i0"], ["Ctrl+Shift+S", "keys.file.i1"], ["Ctrl+W", "keys.file.i2"], ["Ctrl+F", "keys.file.i3"], ["Shift+Alt+F", "keys.file.i4"]] },
      { g: "keys.g.canvas", rows: [["滚轮 / Shift+滚轮", "keys.canvas.i0"], ["Ctrl+滚轮", "keys.canvas.i1"], ["拖拽", "keys.canvas.i2"], ["双击 或 Ctrl+0", "keys.canvas.i3"], ["Ctrl+= / Ctrl+-", "keys.canvas.i4"]] },
    ];
    const html = groups
      .map(
        (g) => `<div class="keys-group"><h4>${esc(t(g.g))}</h4><div class="keys-rows">${g.rows.map(([k, d]) => `<div class="keys-row"><span class="kbd-inline">${esc(k)}</span><span class="ks-d">${esc(t(d))}</span></div>`).join("")}</div></div>`,
      )
      .join("");
    openDialog(head(t("dlg.keys.title"), "keyboard") + `<div class="dialog-body">${html}</div>` + foot(t("dlg.keys.foot"), `<button class="btn ghost" data-close>${esc(t("common.close"))}</button>`), true);
    wire(() => {});
  }

  /* ================================================================== 说明 */

  function guide() {
    const secs = ["local", "formats", "convert", "ai", "panels", "canvas"];
    const html = secs.map((s) => `<div class="guide-sec"><h4>${esc(t("guide." + s + ".h"))}</h4><p>${t("guide." + s + ".p")}</p></div>`).join("");
    openDialog(head(t("dlg.guide.title"), "info") + `<div class="dialog-body">${html}</div>` + foot("", `<button class="btn ghost" data-close>${esc(t("common.close"))}</button>`), true);
    wire(() => {});
  }

  /* ================================================================== 关于 */

  function about() {
    const info = state.appInfo || { version: "?", platform: "?" };
    const fmtRows = state.formatList
      .map((f) => `<tr><td><span class="chip ${f.id}">${esc(f.name)}</span></td><td>${esc((f.exts || []).join(" "))}</td><td>${esc(f.note || "")}</td></tr>`)
      .join("");
    const body = `
      <div class="about-top"><span class="hero">${icon("logo", "ico-lg")}</span>
        <div><b>Diagramon</b><small>${esc(t("dlg.about.version"))} ${esc(info.version)} · ${esc(info.platform)}</small></div></div>
      <div class="callout">${icon("info")}<span>${t(DGM.ipc.isMock ? "dlg.about.mock" : "dlg.about.real")}</span></div>
      <table class="about-table">
        <tr><th>${esc(t("dlg.about.editor"))}</th><td>CodeMirror 6</td></tr>
        <tr><th>${esc(t("dlg.about.render"))}</th><td>Mermaid (page) · Graphviz WASM (page)</td></tr>
        <tr><th>${esc(t("dlg.about.formats"))}</th><td>${state.formatList.map((f) => esc(f.name)).join(" · ")}</td></tr>
      </table>
      <h4 class="mt">${esc(t("dlg.about.formats"))}</h4>
      <table class="reg-table"><thead><tr><th>Name</th><th>ext</th><th>note</th></tr></thead><tbody>${fmtRows}</tbody></table>`;
    openDialog(head(t("dlg.about.title"), "info") + `<div class="dialog-body">${body}</div>` + foot("", `<button class="btn ghost" data-close>${esc(t("common.close"))}</button>`), true);
    wire(() => {});
  }

  /* ================================================================== 历史 */

  function history() {
    const recent = (state.settings && state.settings.recent) || [];
    const rows = recent.length
      ? recent
          .map((r) => `<button class="hist-row" data-act="open:${esc(r.path)}"><span class="fmt-dot" style="background:var(--fmt-${r.format})"></span><b>${esc(r.name)}</b><span class="meta">${esc(r.path)}</span></button>`)
          .join("")
      : `<div class="callout">${icon("clock")}<span>${esc(t("side.recentEmpty"))}</span></div>`;
    const rounds = state.usage.calls;
    const body = `
      <div class="callout">${icon("info")}<span>${esc(t("dlg.history.note"))}</span></div>
      <h4>${esc(t("side.recent"))} <span class="meta">${esc(t("dlg.history.rounds", { n: rounds }))}</span></h4>
      <div class="hist-list">${rows}</div>`;
    openDialog(
      head(t("dlg.history.title"), "history") +
        `<div class="dialog-body">${body}</div>` +
        foot("", `<button class="btn ghost" data-close>${esc(t("common.close"))}</button><button class="btn ghost" data-act="clear">${icon("trash")}${esc(t("dlg.history.clear"))}</button>`),
      true,
    );
    wire(async (act) => {
      if (act === "clear") {
        DGM.ai.clear();
        close();
        return;
      }
      if (act.startsWith("open:")) {
        const p = act.slice(5);
        close();
        DGM.shell.openPath(p);
      }
    });
  }

  /* ================================================================== 未保存 / 退出 */

  function unsaved(name) {
    return new Promise((resolve) => {
      let done = false;
      const finish = (v) => {
        if (done) return;
        done = true;
        resolve(v);
      };
      openDialog(
        head(t("dlg.unsaved.title"), "alert") +
          `<div class="dialog-body"><div class="callout warn">${icon("warn")}<span>${t("dlg.unsaved.body", { name: esc(name) })}<br>${esc(t("dlg.unsaved.sub"))}</span></div></div>` +
          foot("",
            `<button class="btn ghost" data-act="cancel">${esc(t("common.cancel"))}</button>` +
            `<button class="btn ghost" data-act="dont">${esc(t("common.dontSave"))}</button>` +
            `<button class="btn primary" data-act="save">${esc(t("common.save"))}</button>`),
      );
      wire((act) => {
        // 三个分支都必须关闭对话框后再 resolve
        close();
        if (act === "save") finish("save");
        else if (act === "dont") finish("dontSave");
        else finish("cancel");
      });
      overlay().onclick = (e) => {
        if (e.target === overlay()) {
          close();
          finish("cancel");
        }
      };
    });
  }

  function quit(n) {
    return new Promise((resolve) => {
      let done = false;
      const finish = (v) => {
        if (done) return;
        done = true;
        resolve(v);
      };
      openDialog(
        head(t("dlg.quit.title"), "alert") +
          `<div class="dialog-body"><div class="callout warn">${icon("warn")}<span>${esc(t("dlg.quit.body", { n }))}</span></div></div>` +
          foot("", `<button class="btn ghost" data-act="no">${esc(t("common.cancel"))}</button><button class="btn primary" data-act="yes">${esc(t("common.quit"))}</button>`),
      );
      wire((act) => {
        close();
        finish(act === "yes");
      });
      overlay().onclick = (e) => {
        if (e.target === overlay()) {
          close();
          finish(false);
        }
      };
    });
  }

  /* ================================================================== DOT 布局 */

  function layout() {
    const d = state.activeDoc();
    if (!d || d.format !== "dot") return;
    const layouts = state.docFmt(d).layouts || [];
    const items = layouts.map((l) => ({ label: l, check: true, on: (d.layout || "dot") === l, l }));
    DGM.pop.show(items, { x: innerWidth / 2 - 90, y: 120 }, (it) => {
      DGM.pop.hide();
      if (it.l) {
        state.setLayout(d.id, it.l);
        DGM.preview.schedule();
      }
    });
  }

  /* ================================================================== 对外 */

  DGM.dialogs = {
    newDoc,
    convertTo,
    runConvert,
    vision,
    settings,
    keys,
    guide,
    about,
    history,
    unsaved,
    quit,
    layout,
    close,
    open: openDialog,
    _mermaidToDot: mermaidToDot,
  };
})();

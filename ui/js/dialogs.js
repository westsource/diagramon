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

  /**
   * 新建入口（方案 A，消除了"菜单选完还要在对话框里再选一次"的重复）：
   *   - 带 `format` = **直达创建**：文件→新建→子菜单、欢迎页格式快捷卡片。
   *     点了就建（编辑器/预览/派生数据就位 + toast），不经过对话框。
   *   - 无参 = 打开"新建"对话框：Ctrl+N、标签条 ＋、命令面板 ——
   *     面向"不知道选哪个"的浏览比较场景（格式说明 + 能力标签）。
   */
  function newDoc(format) {
    if (format) return create(format);
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

  /**
   * 问后端「这个方向谁来做」，纯 Rust 方向顺便把结果拿回来。
   *
   * 契约回的是**结构化的 `engine`**（`rust` / `drawio` / `excalidraw` / `none`），
   * 前端按它分支 —— 不去解析错误文案猜引擎（文案一改就崩）。
   *
   * 上一版这里是一段前端 best-effort 的 mermaid→dot 实现（正则拼 DOT），
   * 它会把 subgraph 当作"不精确归属"直接不管、把 classDef 丢掉，而且和 Rust 侧
   * 将来任何改进都不会同步。现在只有一处实现：`crates/app-core/src/convert.rs`。
   */
  async function requestConversion(from, to, source) {
    return DGM.ipc.invoke("convert_text", { req: { from, to, source } });
  }

  /** 归一化的方向查询结果：引擎给谁、正文（rust 才有）、保真度说明、错误。 */
  async function planOf(from, to, source) {
    try {
      const out = await requestConversion(from, to, source);
      return {
        engine: out.engine,
        text: out.body || "",
        notes: out.notes || [],
        error: "",
      };
    } catch (e) {
      return { engine: "none", text: "", notes: [], error: (e && e.message) || String(e) };
    }
  }

  /**
   * 引擎方向：建目标格式的新文档 → 把 Mermaid 源码交给承载页 → 取回引擎产出写进正文。
   *
   * 为什么不自己解析：这两个目标格式的上游解析器是 JS 库
   * （drawio 的 `drawio-mermaid`、Excalidraw 的 `mermaid-to-excalidraw`），
   * 重新实现一遍只会得到两个不一致的解析器（见 index.html §9.1）。
   */
  async function convertViaEngine(to, source, srcDoc, dir) {
    const doc = await state.newDoc(to);
    if (!doc) return null;
    DGM.canvas.setPendingConversion(to, source);
    await DGM.preview.render(); // 触发 show → 把源码交给引擎
    const body = await DGM.canvas.waitForBody(to, doc.body || "");
    if (!body) {
      // 取不到就**留着这个标签页**让用户自己看画布，别静默关掉
      state.pushConvert({ from: dir.from, to, doc: srcDoc.name, ok: false, note: t("conv.engineEmpty") });
      DGM.toast({ icon: "alert", title: t("dlg.convert.title"), sub: t("conv.engineEmpty"), warn: true });
      return null;
    }
    await state.setBodyNow(doc.id, body);
    return doc;
  }

  /** 转换成功后统一收尾：刷新界面、记转换记录、提示。 */
  function finishConvert(created, dir, srcDoc, notes) {
    DGM.editor.loadActive();
    DGM.preview.schedule();
    state.refreshDerived(created.id);
    state.pushConvert({
      from: dir.from,
      to: dir.to,
      doc: srcDoc.name,
      ok: true,
      note: dir.how + (notes && notes.length ? " · " + notes.join("；") : ""),
    });
    state.pushOutput(t("dlg.convert.done", { name: state.fmtById(dir.to).name }) + " ← " + srcDoc.name, "ok");
    DGM.toast({
      icon: "swap",
      title: t("dlg.convert.done", { name: state.fmtById(dir.to).name }),
      sub: t("dlg.convert.doneSub", { file: created.name }),
    });
  }

  async function convertTo(presetTo) {
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

    // 后端说这个方向谁来做（一次询问，弹窗与执行都用它，避免两处判断不一致）
    const plan = await planOf(sel.from, sel.to, d.body);

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

    const isRust = plan.engine === "rust";
    const canGo = !plan.error && (isRust ? !!plan.text : plan.engine !== "none");
    const notesHtml = plan.notes.length
      ? `<div class="callout">${icon("info")}<span><b>${esc(t("conv.notes"))}</b><br>${plan.notes.map(esc).join("<br>")}</span></div>`
      : "";

    const previewHtml = plan.error
      ? `<div class="callout warn">${icon("alert")}<span>${esc(plan.error)}</span></div>`
      : isRust
        ? `<pre class="conv-pre">${esc(plan.text)}</pre>${notesHtml}`
        : `<div class="callout">${icon("info")}<span>${esc(plan.notes[0] || t("dlg.convert.noPreview"))}</span></div>`;

    const meta = isRust && plan.text ? t("dlg.convert.previewMeta", { n: plan.text.split("\n").length }) : "";
    const newName = d.name.replace(/\.[^.]+$/, "") + (state.fmtById(sel.to).exts[0] || "." + sel.to);
    const hint = plan.error
      ? plan.error
      : isRust
        ? ""
        : t("conv.viaEngine", { engine: state.fmtById(sel.to).name });

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
        foot(hint,
          `<button class="btn ghost" data-close>${esc(t("common.cancel"))}</button>` +
          `<button class="btn primary" data-act="go"${canGo ? "" : " disabled"}>${icon("swap")}${esc(t("dlg.convert.go"))}</button>`),
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
        runConvert(d, sel, plan);
      }
    });
  }

  /** 真正执行转换。`plan` 是弹窗里那次询问的结果（复用，不重复问）。 */
  async function runConvert(srcDoc, dir, plan) {
    const p = plan || (await planOf(dir.from, dir.to, srcDoc.body));
    if (p.error) {
      DGM.toast({ icon: "alert", title: t("dlg.convert.notImpl"), sub: p.error, warn: true });
      return;
    }

    let created = null;
    if (p.engine === "rust") {
      created = await state.newDoc(dir.to);
      if (created) await state.setBodyNow(created.id, p.text);
    } else if (p.engine !== "none") {
      created = await convertViaEngine(dir.to, srcDoc.body, srcDoc, dir);
    } else {
      DGM.toast({ icon: "alert", title: t("dlg.convert.notImpl"), sub: dir.how, warn: true });
      return;
    }
    if (!created) return;
    finishConvert(created, dir, srcDoc, p.notes);
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
      ? state
          .modelChoices()
          .map((m) => {
            // 网关那组知道谁不支持识图（服务端按别名给），顺手标出来 ——
            // 否则用户会挑一个明确不支持图片的模型，然后在提交时才吃一个报错。
            // 本地那组是 null（不知道），就什么都不说。
            const noVision = m.vision === false ? ` · ${esc(t("dlg.vision.noVision"))}` : "";
            const noKey = m.has_key ? "" : " · " + esc(t("ai.model.none"));
            return `<option value="${m.id}" ${m.id === (state.currentModel() || {}).id ? "selected" : ""}>${esc(m.name)}${noVision}${noKey}</option>`;
          })
          .join("")
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
        <div class="field"><label>${esc(t("set.editor.ratio"))}</label><input type="range" min="25" max="50" value="${(s.panels && s.panels.split_src) || 33}" id="e-split"><span class="hint">${esc(t("set.editor.ratioHint"))}</span></div>
      </div>
      <div class="field"><label>${esc(t("set.editor.debounce"))}</label><input type="number" min="0" max="2000" step="50" value="${e.debounce_ms || 350}" id="e-debounce"><span class="hint">${esc(t("set.editor.debounceHint"))}</span></div>
      ${switchRow(!!e.lint, t("set.editor.lint"), "set.editor.lintHint", "lint")}
      ${switchRow(!!e.per_doc_view, t("set.editor.perDocView"), null, "perdoc")}
      <div class="field-row">
        ${switchRow(e.autosave !== false, t("set.autosave"), null, "autosave")}
        <div class="field narrow"><label>${esc(t("set.autosave.interval"))}</label><input type="number" min="500" max="60000" step="500" value="${e.autosave_ms || 5000}" id="e-autosave"></div>
      </div>
      <div class="callout">${icon("save")}<span>${t("set.autosave.desc")}</span></div>
      ${switchRow(!!e.restrict_to_workspace, t("set.restrict"), null, "restrict")}
      <div class="callout">${icon("folder")}<span>${t("set.restrict.desc")}</span></div>
      <div class="callout">${icon("keyboard")}<span>${t("set.editor.keysCallout")}</span></div>`;
  }

  function pAI() {
    const ai = state.ai();
    const models = ai.models || [];
    // 「本地一个模型都没有」时那句提示要**跟着云状态走**：云网关接好之后，
    // "本版本只能用 BYOK" 就成了假话（会把已登录用户当成没登录）。
    const gwN = state.gatewayModels().length;
    const gwTip = state.cloud.status.signed_in
      ? gwN
        ? t("set.ai.gatewayOn", { n: gwN })
        : t("set.ai.gatewayNoEntitlement")
      : t("set.ai.gatewaySignedOut");
    const gwTipWarn = !state.cloud.status.signed_in || gwN === 0;
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
      : `<div class="callout${gwTipWarn ? " warn" : ""}">${icon("key")}<span>${esc(gwTip)}<br>${esc(t("set.ai.noModelsLocal"))}</span></div>`;

    // 「默认模型」要**把网关别名也列出来**：它可能正指向某个别名，
    // 只列本地那份会让这个 select 空着选不中 —— 而这一页是按表单值回写的，
    // 一旦保存就会把用户的默认静默改成列表里的第一个本地模型。
    const choices = state.modelChoices();
    const groupOpts = (g, label) => {
      const list = choices.filter((m) => m.group === g);
      return list.length
        ? `<optgroup label="${esc(label)}">${list.map((m) => `<option value="${esc(m.id)}" ${m.id === ai.default_model ? "selected" : ""}>${esc(m.name)}</option>`).join("")}</optgroup>`
        : "";
    };
    const defaultOpts = groupOpts("gateway", t("ai.group.gateway")) + groupOpts("local", t("ai.group.local"));
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
    const c = (state.settings && state.settings.cloud) || {};
    const signed = !!(state.cloud && state.cloud.status && state.cloud.status.signed_in);
    const acct = signed && state.cloud.status.account;
    return `
      <div class="field"><label>${esc(t("set.cloud.baseUrl"))}</label>
        <input type="text" id="c-baseurl" value="${esc(c.base_url || "")}" placeholder="https://api.example.com/v1" spellcheck="false">
        <span class="hint">${esc(t("set.cloud.baseUrlHint"))}</span></div>
      <div class="cloud-me"><span class="avatar">${icon("user", "ico-sm")}</span><span class="who"><b>${signed && acct ? esc(acct.email || t("side.cloud.signedIn")) : esc(t("side.cloud.notSignedIn"))}</b><small>${signed && acct ? esc(acct.plan_name || "") : esc(t("set.cloud.account"))}</small></span></div>
      <div class="callout ${signed ? "" : "warn"}">${icon("cloud")}<span>${signed ? esc(t("set.cloud.signedInDesc")) : esc(t("set.cloud.offDesc"))}</span></div>
      <div class="callout">${icon("info")}<span>${t("set.cloud.offlineGuard")}<br>${esc(t("set.cloud.offlineGuardHint"))}</span></div>`;
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
        else if (a === "autosave") state.patchSettings({ editor: { autosave: on } });
        else if (a === "restrict") state.patchSettings({ editor: { restrict_to_workspace: on } });
        else if (a === "ctxdoc") state.patchSettings({ ai: { context_from_doc: on } });
        else if (a === "retry") state.patchSettings({ ai: { render_retry: on } });
        else if (a === "vnotice") state.patchSettings({ ai: { vision_notice_accepted: on } });
      });
    });

    const split = $("#e-split");
    if (split) split.addEventListener("input", () => state.patchSettings({ panels: { split_src: Number(split.value) } }));

    const auto = $("#e-autosave");
    if (auto) {
      auto.addEventListener("change", () => {
        const ms = Math.min(60000, Math.max(500, Number(auto.value) || 5000));
        auto.value = String(ms);
        state.patchSettings({ editor: { autosave_ms: ms } });
      });
    }

    const baseUrl = $("#c-baseurl");
    if (baseUrl) {
      baseUrl.addEventListener("change", async () => {
        await state.patchSettings({ cloud: { base_url: baseUrl.value.trim() } });
        await state.cloudRefresh();
      });
    }

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
      { g: "keys.g.file", rows: [["Ctrl+N / Ctrl+O / Ctrl+S", "keys.file.i0"], ["Ctrl+Shift+S", "keys.file.i1"], ["Ctrl+W", "keys.file.i2"], ["Ctrl+F", "keys.file.i3"], ["Shift+Alt+F", "keys.file.i4"], ["Ctrl+Shift+H", "keys.file.i5"]] },
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
      <div class="callout">${icon("info")}<span>${t("dlg.about.desc")}</span></div>
      ${DGM.ipc.isMock ? `<div class="callout warn">${icon("alert")}<span>${t("dlg.about.mock")}</span></div>` : ""}
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

  /* ================================================================== 通用输入 / 确认 */

  /**
   * 单行输入。返回去空格后的字符串；取消或留空返回 `null`。
   *
   * 为什么不直接用 `window.prompt`：WebView2 对它的支持在各版本间不一致，
   * 而且样式与整站无关。这里用同一套对话框外壳。
   */
  function input(opts) {
    const o = opts || {};
    return new Promise((resolve) => {
      let done = false;
      const finish = (v) => {
        if (done) return;
        done = true;
        resolve(v);
      };
      openDialog(
        head(o.title || t("common.new"), o.icon || "wand") +
          `<div class="dialog-body"><div class="field">
             ${o.label ? `<label>${esc(o.label)}</label>` : ""}
             <input id="dlg-input" type="text" value="${esc(o.value || "")}" placeholder="${esc(o.placeholder || "")}" spellcheck="false" autocomplete="off">
             ${o.hint ? `<small>${esc(o.hint)}</small>` : ""}
           </div></div>` +
          foot("", `<button class="btn ghost" data-act="cancel">${esc(t("common.cancel"))}</button><button class="btn primary" data-act="ok">${esc(t("dlg.input.ok"))}</button>`),
      );
      const box = $("#dlg-input");
      const take = () => {
        const v = box ? box.value.trim() : "";
        if (!v) return false; // 空名不给过，停在原地
        close();
        finish(v);
        return true;
      };
      wire((act) => {
        if (act === "ok") take();
        else {
          close();
          finish(null);
        }
      });
      overlay().onclick = (e) => {
        if (e.target === overlay()) {
          close();
          finish(null);
        }
      };
      if (box) {
        box.addEventListener("keydown", (e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            take();
          } else if (e.key === "Escape") {
            e.preventDefault();
            close();
            finish(null);
          }
        });
        box.focus();
        try {
          box.select();
        } catch (err) {
          /* 某些输入类型不支持 select */
        }
      }
    });
  }

  /** 二选一确认。返回 true / false。 */
  function confirm(opts) {
    const o = opts || {};
    return new Promise((resolve) => {
      let done = false;
      const finish = (v) => {
        if (done) return;
        done = true;
        resolve(v);
      };
      openDialog(
        head(o.title || t("common.confirm"), o.icon || "alert") +
          `<div class="dialog-body"><div class="callout ${o.danger ? "warn" : ""}">${icon(o.danger ? "warn" : "info")}<span>${o.body || ""}${o.danger && o.warn ? `<br>${esc(o.warn)}` : ""}</span></div></div>` +
          foot("", `<button class="btn ghost" data-act="no">${esc(t("common.cancel"))}</button><button class="btn ${o.danger ? "danger" : "primary"}" data-act="yes">${esc(o.ok || t("common.confirm"))}</button>`),
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
    input,
    confirm,
    keys,
    guide,
    about,
    history,
    unsaved,
    quit,
    layout,
    close,
    open: openDialog,
  };
})();

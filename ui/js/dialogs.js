/* 对话框：新建 / 转换 / 识图 / 设置（五页签）/ 快捷键 / 历史 / 说明 / 关于 / 未保存 / 退出 / 布局。
 *
 * 取向：
 *   - 一律经 state + settings_patch 落盘；密钥走 ai_model_key_set / ai_model_key_delete，永不回显。
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
  let draftKeys = {};
  let providerForm = null;
  let refreshingProvider = "";
  let removedProviders = new Set();

  /* ------------------------------------------------------------------ 外壳 */

  function overlay() {
    return $("#overlay-dialog");
  }

  function openDialog(html, wide) {
    const d = $("#dialog");
    // `wide` 可以是 true（.wide）或一个类名（如 "settings"：比 .wide 更宽的那一档）
    d.className = "dialog" + (wide === true ? " wide" : wide ? ` ${wide}` : "");
    d.innerHTML = html;
    overlay().hidden = false;
    return d;
  }

  function close() {
    overlay().hidden = true;
    $("#dialog").innerHTML = "";
    $("#dialog").onclick = null;
  }

  function head(title, ic, sub) {
    return (
      `<div class="dialog-head">${icon(ic || "info")}<h2>${esc(title)}</h2>` +
      (sub ? `<small>${esc(sub)}</small>` : "") +
      `<span class="sp"></span><button class="icon-btn" data-close>${icon("close", "ico-sm")}</button></div>`
    );
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
      // 第 4 个参数是事件本身：**弹菜单**的动作要在回调里 stopPropagation()，
      // 否则文档级"点外面就关"会在同一次点击里把它刚弹出的菜单关掉（showPop 的约定）。
      if (b && !b.disabled && onPick) onPick(b.dataset.act, b, d, e);
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
   *
   * 返回值是 `{ doc, notes }`：`notes` 是**这次转换的保真度说明**（与 Rust 方向共用同一套展示），
   * 目前只有一条 —— 上游把整张图兜底成了一块位图（见 `bitmapFallbackNote`）。
   */
  async function convertViaEngine(to, source, srcDoc, dir) {
    const doc = await state.newDoc(to);
    if (!doc) return null;
    // 文档级外观（look）只对 Excalidraw 链有效：m2e 的 config 会平铺进内置 mermaid 的
    // initialize。drawio 的内置导入器不可配置（descriptor 协议没有配置位），opts 传了也
    // 拿不到 —— 所以 drawio 不传、notes 里如实说明。布局（elk）两条链都不透传：
    // layout-elk 是 mermaid ^12 的包，引擎内置的 mermaid 版本不配，一律按默认 dagre。
    const look = DGM.preview && DGM.preview.effectiveLook ? DGM.preview.effectiveLook(srcDoc) : null;
    const opts = to === "excalidraw" && look && look !== "auto" ? { mermaid: { look } } : null;
    DGM.canvas.setPendingConversion(to, source, opts);
    await DGM.preview.render(); // 触发 show → 把源码交给引擎
    const body = await DGM.canvas.waitForBody(to, doc.body || "");
    if (!body) {
      // 取不到就**留着这个标签页**让用户自己看画布，别静默关掉
      state.pushConvert({ from: dir.from, to, doc: srcDoc.name, ok: false, note: t("conv.engineEmpty") });
      DGM.toast({ icon: "alert", title: t("dlg.convert.title"), sub: t("conv.engineEmpty"), warn: true });
      return null;
    }
    await state.setBodyNow(doc.id, body);
    const note = bitmapFallbackNote(to, body);
    if (note) state.pushOutput(note, "warn");
    const notes = note ? [note] : [];
    // 保真度说明：渲染配置沿用了多少，逐条如实写（转换记录里展示）
    if (to === "excalidraw") {
      notes.push(
        opts && opts.mermaid
          ? t("conv.lookCarried", { look: opts.mermaid.look })
          : t("conv.lookDefault"),
      );
      notes.push(t("conv.layoutNotCarried"));
    } else if (to === "drawio") {
      notes.push(t("conv.drawioFixedConfig"));
    }
    return { doc: doc, notes: notes };
  }

  /**
   * 引擎给的产物是不是「一整张位图」。
   *
   * 为什么要在界面层判而不是当成失败：这是**上游的兜底行为**，不算错 ——
   * `mermaid-to-excalidraw` 碰到它不支持的语法（实测 `subgraph` 必现）会把整张图渲染成一张
   * PNG，形状就没了。位图本身完整可看，所以转换仍然算成功，但必须**如实说明**
   * 「这图在画布上是张图片、不能单独编辑」，否则用户会以为转换丢了东西、或者对着空白猜。
   *
   * 判据取**真正落进正文的那份场景**（也就是最终会存盘的东西），而不是某个中间状态。
   * 只在 Excalidraw 侧判：drawio 的导入器支持 subgraph，不适用。
   */
  function bitmapFallbackNote(to, body) {
    if (to !== "excalidraw") return "";
    try {
      const els = (JSON.parse(body) || {}).elements || [];
      if (els.length && els.every((e) => e && e.type === "image")) return t("conv.bitmapFallback");
    } catch (err) {
      // 不是 JSON 就别猜（编排由引擎负责，界面不做第二套解析）
    }
    return "";
  }

  /**
   * D2 → drawio：**只能在前端做**（几何要 wasm 算），所以走 `engine === "d2wasm"` 这条支线。
   *
   * 为什么不用 `convertViaEngine`：那条路是「把 Mermaid 源码交给承载页、由承载页的
   * Mermaid 导入器解析」，而 D2 的产物**已经是一份完整的 mxfile**了（`DGM.d2.toDrawio`
   * 把 `compile()` 的绝对几何映射成 mxGraph）。于是它就是一份普通的 drawio 文档：
   * 建标签页 → 写正文 → 承载页照常 `load` 它，用户能接着拖拽编辑。
   *
   * `notes` 由 `toDrawio` 逐条给出（形状退化 / 主题 / 多板 / icon），在转换记录里展示。
   */
  async function convertViaD2Wasm(source, srcDoc, dir) {
    if (!DGM.d2) {
      DGM.toast({ icon: "alert", title: t("dlg.convert.title"), sub: t("preview.d2.unavailable", { msg: "ui/js/d2.js 未加载" }), warn: true });
      return null;
    }
    let made = null;
    try {
      made = await DGM.d2.toDrawio(source, srcDoc.layout || "");
    } catch (e) {
      const raw = (e && e.message) || String(e);
      const parsed = DGM.d2.describeError(raw);
      state.pushConvert({ from: dir.from, to: dir.to, doc: srcDoc.name, ok: false, note: parsed ? parsed.text : raw });
      DGM.toast({ icon: "alert", title: t("dlg.convert.title"), sub: parsed ? parsed.text : raw, warn: true });
      return null;
    }
    const doc = await state.newDoc(dir.to);
    if (!doc) return null;
    await state.setBodyNow(doc.id, made.xml);
    return { doc, notes: made.notes };
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
    // 成功必须有 `ok: true`：`applyAsCanvas` 用 `res.ok` 判成败，旧返回里没这个字段 ⇒
    // 画布明明落地了，界面却弹"转换失败：…"（reason 还是空的）。
    return { ok: true, doc: created };
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
    let extraNotes = [];
    if (p.engine === "rust") {
      created = await state.newDoc(dir.to);
      if (created) await state.setBodyNow(created.id, p.text);
    } else if (p.engine === "d2wasm") {
      // D2 → drawio：几何在前端由 wasm 算，产物是一份完整的 mxfile
      const via = await convertViaD2Wasm(srcDoc.body, srcDoc, dir);
      created = via && via.doc;
      extraNotes = (via && via.notes) || [];
    } else if (p.engine !== "none") {
      const via = await convertViaEngine(dir.to, srcDoc.body, srcDoc, dir);
      created = via && via.doc;
      extraNotes = (via && via.notes) || [];
    } else {
      DGM.toast({ icon: "alert", title: t("dlg.convert.notImpl"), sub: dir.how, warn: true });
      return;
    }
    if (!created) return;
    finishConvert(created, dir, srcDoc, (p.notes || []).concat(extraNotes));
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
        <span class="hint">${esc(t("set.accent.hint"))}</span></div>
      ${switchRow(!!s.close_to_tray, t("set.general.closeToTray"), "set.general.closeToTrayHint", "closetray")}`;
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
      <div class="field"><label>${esc(t("set.editor.mermaidLook"))}</label>
        <div class="seg" id="seg-mlook">${["auto", "classic", "neo", "handDrawn"].map((x) => `<button class="${((s.mermaid && s.mermaid.look) || "auto") === x ? "on" : ""}" data-act="mlook:${x}">${esc(t("preview.look." + x))}</button>`).join("")}</div>
        <span class="hint">${esc(t("set.editor.mermaidLookHint"))}</span></div>
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
    // 渲染必须读**草稿**：新增/删除改的是 draftAi，而这一页按表单值回写。
    const ai = draftAi || state.ai();
    ensureDraftProviders(ai);
    const providers = ai.providers || [];
    const models = ai.models || [];
    const gwN = state.gatewayModels().length;
    const gwTip = state.cloud.status.signed_in
      ? gwN
        ? t("set.ai.gatewayOn", { n: gwN })
        : t("set.ai.gatewayNoEntitlement")
      : t("set.ai.gatewaySignedOut");
    const gwTipWarn = !state.cloud.status.signed_in || gwN === 0;

    const rows = providers.length
      ? providers
          .map((p, pi) => {
            const list = models.filter((m) => m.provider_id === p.id);
            const pendingKey = !!draftKeys[p.id];
            const keyLabel = pendingKey
              ? t("set.ai.keyPending")
              : p.provider === "ollama"
                ? t("set.ai.keyNotNeeded")
                : p.has_key
                  ? t("set.ai.keyStored", { hint: p.key_hint })
                  : t("set.ai.keyMissing");
            const keyOk = pendingKey || p.provider === "ollama" || p.has_key;
            const chips = list.length
              ? list
                  .map(
                    (m) => `<span class="ai-model-chip" title="${esc(m.model)}"><code>${esc(m.model)}</code><button class="ai-chip-x" data-act="delmodel:${esc(m.id)}" title="${esc(t("set.ai.removeModel"))}">×</button></span>`,
                  )
                  .join("")
              : `<span class="hint">${esc(t("set.ai.noProviderModels"))}</span>`;
            return `
      <div class="ai-prov" data-pid="${esc(p.id)}">
        <div class="ai-prov-head">
          <span class="ai-prov-logo">${esc(providerInitials(p.name))}</span>
          <div class="ai-prov-main"><b>${esc(p.name)}</b><small>${esc(p.base_url)}</small></div>
          <span class="key-tag ${keyOk ? "ok" : "off"}">${esc(keyLabel)}</span>
          <span class="ai-prov-order">
            <button class="icon-btn" data-act="pmove:${esc(p.id)}:-1" title="${esc(t("set.ai.moveUp"))}" ${pi === 0 ? "disabled" : ""}>${icon("up", "ico-sm")}</button>
            <button class="icon-btn" data-act="pmove:${esc(p.id)}:1" title="${esc(t("set.ai.moveDown"))}" ${pi === providers.length - 1 ? "disabled" : ""}>${icon("down", "ico-sm")}</button>
          </span>
          <button class="btn sm" data-act="refresh:${esc(p.id)}" ${refreshingProvider === p.id ? "disabled" : ""}>${icon("refresh", "ico-sm")}${esc(refreshingProvider === p.id ? t("set.ai.refreshing") : t("set.ai.refreshModels"))}</button>
          <button class="icon-btn" data-act="delprov:${esc(p.id)}" title="${esc(t("set.ai.removeProvider"))}">${icon("trash", "ico-sm")}</button>
        </div>
        <div class="ai-prov-models">${chips}</div>
        <div class="ai-prov-key">
          <input type="password" data-key="${esc(p.id)}" placeholder="${esc(t("set.ai.keyReplace", { state: keyState(p) }))}" spellcheck="false">
          <span class="hint">${esc(t("set.ai.keyReplaceHint"))}</span>
        </div>
        <details class="ai-prov-adv">
          <summary>${esc(t("set.ai.advanced"))}</summary>
          <div class="ai-prov-adv-grid">
            <label title="${esc(t("set.ai.maxTokensHint"))}">${esc(t("set.ai.maxTokens"))}<input type="number" min="1" max="1000000" data-pmax="${esc(p.id)}" value="${p.max_tokens == null ? "" : p.max_tokens}" placeholder="${esc(t("set.ai.maxTokensAuto"))}"></label>
            <label>${esc(t("set.ai.temperature"))}<input type="number" min="0" max="2" step="0.1" data-ptemp="${esc(p.id)}" value="${p.temperature}"></label>
            <label title="${esc(t("set.ai.idleTimeoutHint"))}">${esc(t("set.ai.idleTimeout"))}<input type="number" min="15" max="1800" step="5" data-pidle="${esc(p.id)}" value="${p.idle_timeout_s == null ? "" : p.idle_timeout_s}" placeholder="${esc(t("set.ai.idleTimeoutAuto"))}"></label>
          </div>
          <span class="hint">${esc(t("set.ai.maxTokensHint"))}</span>
        </details>
      </div>`;
          })
          .join("")
      : `<div class="callout${gwTipWarn ? " warn" : ""}">${icon("key")}<span>${esc(gwTip)}<br>${esc(t("set.ai.noProviders"))}</span></div>`;

    const gwChoices = state.modelChoices().filter((m) => m.group === "gateway");
    const opt = (m) => `<option value="${esc(m.id)}" ${m.id === ai.default_model ? "selected" : ""}>${esc(m.name)}</option>`;
    const defaultOpts =
      (gwChoices.length ? `<optgroup label="${esc(t("ai.group.gateway"))}">${gwChoices.map(opt).join("")}</optgroup>` : "") +
      providers
        .map((p) => {
          const list = models.filter((m) => m.provider_id === p.id);
          return list.length ? `<optgroup label="${esc(p.name)}">${list.map(opt).join("")}</optgroup>` : "";
        })
        .join("") +
      (ai.default_model && !models.some((m) => m.id === ai.default_model) && !gwChoices.some((m) => m.id === ai.default_model)
        ? `<option value="${esc(ai.default_model)}" selected>${esc(ai.default_model)}</option>`
        : "");

    return `
      <div class="field">
        <div class="row-head"><label>${esc(t("set.ai.providers"))}</label><span class="sp"></span>
          <button class="btn sm" data-act="addprov">${icon("plus", "ico-sm")}${esc(t("set.ai.addProvider"))}</button></div>
        <div class="staging-note">${icon("info", "ico-sm")}<span>${t("set.ai.stagingHint")}</span></div>
        <div class="callout${gwTipWarn ? " warn" : ""}">${icon("cloud")}<span>${esc(gwTip)}</span></div>
        <div class="ai-prov-list">${rows}</div>
      </div>
      ${providerForm ? providerFormHTML() : ""}
      <div class="field"><label>${esc(t("set.ai.defaultModel"))}</label><select data-act="noop" id="ai-default">${defaultOpts}</select><span class="hint">${esc(t("set.ai.defaultModelHint"))}</span></div>
      ${switchRow(!!ai.context_from_doc, t("set.ai.contextFromDoc"), null, "ctxdoc")}
      ${switchRow(!!ai.render_retry, t("set.ai.renderRetry"), "set.ai.renderRetryHint", "retry")}
      ${switchRow(!!ai.tools_enabled, t("set.ai.tools"), "set.ai.toolsHint", "tools")}
      ${switchRow(!!ai.vision_notice_accepted, t("set.ai.visionNotice"), null, "vnotice")}
      ${switchRow(!!ai.memory_enabled, t("set.ai.memoryOn"), "set.ai.memoryOnHint", "memory")}
      ${switchRow(!!ai.memory_auto, t("set.ai.memoryAuto"), "set.ai.memoryAutoHint", "memoryauto")}
      <div class="field"><label>${esc(t("set.ai.memory"))}</label>
        <div class="btn-row"><button class="btn sm" data-act="memory">${icon("sparkles")}${esc(t("set.ai.memoryManage"))}</button>
        <span class="hint">${esc(t("set.ai.memoryManageHint"))}</span></div></div>`;
  }

  /** 兼容旧设置 / mock：没有 providers 时按 `(provider, base_url)` 现场分组。 */
  function ensureDraftProviders(ai) {
    ai.providers = ai.providers || [];
    ai.models = ai.models || [];
    if (!ai.models.length) return;
    let next = ai.providers.length + 1;
    for (const m of ai.models) {
      if (m.provider_id && ai.providers.some((p) => p.id === m.provider_id)) continue;
      if (!m.provider || !m.base_url) continue;
      let p = ai.providers.find((x) => x.provider === m.provider && x.base_url === m.base_url);
      if (!p) {
        const meta = providerMeta(m.base_url);
        p = {
          id: "p-legacy-" + next++,
          name: meta.name,
          provider: m.provider,
          base_url: m.base_url,
          max_tokens: m.max_tokens || null,
          temperature: m.temperature || 0.2,
          idle_timeout_s: m.idle_timeout_s == null ? null : m.idle_timeout_s,
          session_header: !!meta.session_header,
          has_key: !!m.has_key,
          key_hint: m.key_hint || "",
        };
        ai.providers.push(p);
      }
      m.provider_id = p.id;
    }
  }

  function providerMeta(baseUrl) {
    let host = "";
    let port = "";
    try {
      const u = new URL(baseUrl);
      host = (u.hostname || "").toLowerCase();
      port = u.port || "";
    } catch (_) {
      /* 半截输入：留给用户改 */
    }
    const ollama = (host === "localhost" || host === "127.0.0.1") && (port === "11434" || !port);
    const known = {
      "api.openai.com": "OpenAI",
      "api.deepseek.com": "DeepSeek",
      "api.siliconflow.cn": "SiliconFlow",
      "api.anthropic.com": "Anthropic",
      "opencode.ai": "OpenCode",
    };
    if (ollama) return { provider: "ollama", name: "Ollama (local)", session_header: false };
    const name =
      known[host] ||
      (host
        ? host
            .replace(/^www\./, "")
            .replace(/^api\./, "")
            .split(".")[0]
            .replace(/^./, (c) => c.toUpperCase())
        : "Custom");
    // OpenCode Go 要求每个请求带 x-opencode-session；UI 自动勾选，用户仍可取消。
    const session_header = host === "opencode.ai" || host.endsWith(".opencode.ai");
    return { provider: "openai", name, session_header };
  }

  function providerInitials(name) {
    const chars = Array.from(String(name || "?").trim());
    return (chars.slice(0, 2).join("") || "?").toUpperCase();
  }

  function keyState(p) {
    return p.provider === "ollama"
      ? t("set.ai.keyNotNeeded")
      : p.has_key
        ? t("set.ai.keyConfigured")
        : t("set.ai.keyMissing");
  }

  function providerFormHTML() {
    const f = providerForm;
    const models = f.models || [];
    const list = models.length
      ? `<div class="ai-add-models" id="ap-models">${models
          .map(
            (id) => `<label class="ai-add-model"><input type="checkbox" data-mid="${esc(id)}" checked><code>${esc(id)}</code></label>`,
          )
          .join("")}</div>`
      : "";
    const status = f.busy
      ? `<div class="callout">${icon("refresh", "ico-sm")}<span>${esc(t("set.ai.fetching"))}</span></div>`
      : f.err
        ? `<div class="callout warn">${icon("alert", "ico-sm")}<span>${esc(f.err)}</span></div>`
        : models.length
          ? `<div class="callout">${icon("check", "ico-sm")}<span>${esc(t("set.ai.fetchOk", { n: models.length }))}</span></div>`
          : "";
    return `<div class="ai-add-mask">
      <div class="ai-add" role="dialog" aria-label="${esc(t("set.ai.addProvider"))}">
        <div class="ai-add-head">${icon("sparkles", "ico-sm")}<b>${esc(t("set.ai.addProvider"))}</b><span class="sp"></span><button class="icon-btn" data-act="pcancel">${icon("close", "ico-sm")}</button></div>
        <div class="ai-add-body">
          <label class="field"><span>${esc(t("set.ai.providerName"))}</span><input id="ap-name" value="${esc(f.name || "")}" spellcheck="false" placeholder="${esc(providerMeta(f.base).name)}"><span class="hint">${esc(t("set.ai.providerNameHint"))}</span></label>
          <label class="field"><span>${esc(t("set.ai.baseUrl"))}</span><input id="ap-base" value="${esc(f.base)}" spellcheck="false" placeholder="https://api.example.com/v1"><span class="hint">${esc(t("set.ai.baseUrlHint"))}</span></label>
          <label class="field"><span>${esc(t("set.ai.apiKey"))}</span><input id="ap-key" type="password" value="${esc(f.key)}" spellcheck="false" placeholder="${esc(t("set.ai.keyOptional"))}"><span class="hint">${esc(t("set.ai.keyHint"))}</span></label>
          <label class="field check"><input id="ap-session" type="checkbox" ${f.sessionHeader || providerMeta(f.base).session_header ? "checked" : ""}><span>${esc(t("set.ai.sessionHeader"))}</span><span class="hint">${esc(t("set.ai.sessionHeaderHint"))}</span></label>
          <div class="staging-note">${icon("info", "ico-sm")}<span>${t("set.ai.saveTiming")}</span></div>
          ${status}
          ${list}
        </div>
        <div class="ai-add-foot">
          <button class="btn ghost" data-act="pcancel">${esc(t("common.cancel"))}</button>
          <span class="sp"></span>
          <button class="btn" data-act="pfetch" ${f.busy ? "disabled" : ""}>${esc(f.busy ? t("set.ai.fetching") : t("set.ai.fetchModels"))}</button>
          <button class="btn primary" data-act="padd" ${models.length ? "" : "disabled"}>${esc(t("set.ai.addToList"))}</button>
        </div>
      </div>
    </div>`;
  }

  function openProviderForm() {
    providerForm = { base: "https://api.openai.com/v1", name: "", key: "", models: null, busy: false, err: "", sessionHeader: false };
    renderSettings("ai");
  }

  async function fetchProviderForm() {
    if (!providerForm) return;
    const base = ($("#ap-base") || {}).value || "";
    const name = ($("#ap-name") || {}).value || "";
    const key = ($("#ap-key") || {}).value || "";
    providerForm = { ...providerForm, base: base.trim(), name: name.trim(), key, busy: true, err: "" };
    renderSettings("ai");
    try {
      const meta = providerMeta(providerForm.base);
      const models = await DGM.ipc.invoke("ai_provider_models", {
        provider: meta.provider,
        baseUrl: providerForm.base,
        apiKey: providerForm.key || null,
      });
      providerForm = { ...providerForm, busy: false, models };
    } catch (e) {
      providerForm = { ...providerForm, busy: false, err: String((e && e.message) || e) };
    }
    renderSettings("ai");
  }

  function addProviderFromForm() {
    if (!providerForm || !providerForm.models) return;
    const ai = draftAi || state.ai();
    const base = providerForm.base.trim().replace(/\/+$/, "");
    if (ai.providers.some((p) => p.base_url.replace(/\/+$/, "") === base)) {
      providerForm = { ...providerForm, err: t("set.ai.providerExists") };
      renderSettings("ai");
      return;
    }
    const picked = $$("#ap-models input:checked").map((x) => x.dataset.mid);
    if (!picked.length) {
      providerForm = { ...providerForm, err: t("set.ai.pickOneModel") };
      renderSettings("ai");
      return;
    }
    const meta = providerMeta(base);
    const typedName = (($("#ap-name") || {}).value || providerForm.name || "").trim();
    const displayName = typedName || meta.name;
    const id = "p" + Date.now().toString(36);
    ai.providers.push({
      id, name: displayName, provider: meta.provider, base_url: base,
      max_tokens: null, temperature: 0.2, idle_timeout_s: null,
      session_header: !!($("#ap-session") || {}).checked,
      has_key: false, key_hint: "",
    });
    for (const model of picked) {
      ai.models.push({ id: id + ":" + model, provider_id: id, model, name: model, has_key: false, key_hint: "" });
    }
    if (providerForm.key.trim()) draftKeys[id] = providerForm.key.trim();
    if (!ai.default_model) ai.default_model = id + ":" + picked[0];
    providerForm = null;
    renderSettings("ai");
  }

  async function refreshProvider(id) {
    const ai = draftAi || state.ai();
    const p = (ai.providers || []).find((x) => x.id === id);
    if (!p || refreshingProvider) return;
    refreshingProvider = id;
    renderSettings("ai");
    try {
      const ids = await DGM.ipc.invoke("ai_provider_models", {
        provider: p.provider, baseUrl: p.base_url, providerId: p.id,
      });
      const old = ai.models.filter((m) => m.provider_id === id);
      const next = ids.map(
        (model) =>
          old.find((m) => m.model === model) || {
            id: id + ":" + model, provider_id: id, model, name: model, has_key: p.has_key, key_hint: p.key_hint,
          },
      );
      ai.models = ai.models.filter((m) => m.provider_id !== id).concat(next);
      if (!ai.models.some((m) => m.id === ai.default_model) && next.length) ai.default_model = next[0].id;
      p.has_key = p.provider === "ollama" || p.has_key;
    } catch (e) {
      DGM.toast({ icon: "alert", title: t("set.ai.refreshFailed"), sub: String((e && e.message) || e), warn: true });
    }
    refreshingProvider = "";
    renderSettings("ai");
  }

  function removeProvider(id) {
    const ai = draftAi || state.ai();
    const p = (ai.providers || []).find((x) => x.id === id);
    if (!p) return;
    if (!window.confirm(t("set.ai.removeProviderConfirm", { name: p.name }))) return;
    ai.providers = ai.providers.filter((x) => x.id !== id);
    ai.models = ai.models.filter((m) => m.provider_id !== id);
    delete draftKeys[id];
    removedProviders.add(id);
    if (!ai.models.some((m) => m.id === ai.default_model)) ai.default_model = (ai.models[0] || {}).id || "";
    renderSettings("ai");
  }

  /** 调整供应商次序（上移 / 下移一位）。
   *
   *  次序**就是** `ai.providers` 的数组序 —— 不另立名次字段：设置页的卡片、
   *  AI 面板与菜单栏的模型下拉分组、「默认模型」下拉都按这个序排，移动一次三处一起变。
   *  端点处按钮直接 disabled（`pi` 由渲染时给），所以这里只需再挡一次越界。
   */
  function moveProvider(id, dir) {
    const ai = draftAi || state.ai();
    const list = ai.providers || [];
    const i = list.findIndex((x) => x.id === id);
    const j = i + dir;
    if (!dir || i < 0 || j < 0 || j >= list.length) return;
    const [moved] = list.splice(i, 1);
    list.splice(j, 0, moved);
    renderSettings("ai");
  }

  function removeDraftModel(id) {
    const ai = draftAi || state.ai();
    ai.models = ai.models.filter((m) => m.id !== id);
    if (ai.default_model === id) ai.default_model = (ai.models[0] || {}).id || "";
    renderSettings("ai");
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
    draftKeys = {};
    removedProviders = new Set();
    providerForm = null;
    refreshingProvider = "";
    renderSettings(cur);
  }

  /** 用现有 draftAi 重画设置窗口（add/remove 改完草稿后调它，草稿不丢）。 */
  function renderSettings(cur) {
    const pane0 = $(".dlg-pane");
    if (cur === "ai" && pane0) {
      $$("[data-key]", pane0).forEach((inp) => {
        const v = String(inp.value || "").trim();
        if (v) draftKeys[inp.dataset.key] = v;
      });
    }
    openDialog(
      head(t("dlg.settings.title"), "settings") +
        `<div class="dialog-body has-tabs">
          <div class="dlg-tabs">${TABS.map((x) => `<button class="dlg-tab ${x.id === cur ? "on" : ""}" data-act="tab:${x.id}">${icon(x.icon, "ico-sm")}${esc(t(x.label))}</button>`).join("")}</div>
          <div class="dlg-pane">${(PANES[cur] || pAppearance)()}</div>
        </div>` +
        foot(t("dlg.settings.foot"),
          `<button class="btn ghost" data-close>${esc(t("common.close"))}</button>` +
          `<button class="btn primary" data-act="save">${icon("check")}${esc(t("common.save"))}</button>`),
      "settings",
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
        else if (a === "closetray") state.patchSettings({ close_to_tray: on });
        else if (a === "ctxdoc") state.patchSettings({ ai: { context_from_doc: on } });
        else if (a === "retry") state.patchSettings({ ai: { render_retry: on } });
        else if (a === "tools") state.patchSettings({ ai: { tools_enabled: on } });
        else if (a === "vnotice") state.patchSettings({ ai: { vision_notice_accepted: on } });
        else if (a === "memory") state.patchSettings({ ai: { memory_enabled: on } });
        else if (a === "memoryauto") state.patchSettings({ ai: { memory_auto: on } });
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
        // 只翻自己这个 seg：编辑器页里现有两组 seg（默认视图 / Mermaid 外观），
        // 全 pane 扫 .seg button 会把另一组的选中态抹掉
        const seg = btn && btn.closest(".seg");
        if (seg) $$(".seg button", seg).forEach((x) => x.classList.toggle("on", x === btn));
        return;
      }
      if (act.startsWith("mlook:")) {
        const v = act.slice(6);
        state.patchSettings({ mermaid: { look: v } });
        const seg = btn && btn.closest(".seg");
        if (seg) $$(".seg button", seg).forEach((x) => x.classList.toggle("on", x === btn));
        return;
      }
      if (act === "addprov") return openProviderForm();
      if (act === "pfetch") { fetchProviderForm(); return; }
      if (act === "pcancel") { providerForm = null; renderSettings("ai"); return; }
      if (act === "padd") return addProviderFromForm();
      if (act.startsWith("refresh:")) { refreshProvider(act.slice(8)); return; }
      if (act.startsWith("pmove:")) {
        const [, pid, dir] = act.split(":");
        return moveProvider(pid, Number(dir) || 0);
      }
      if (act.startsWith("delprov:")) return removeProvider(act.slice(8));
      if (act.startsWith("delmodel:")) return removeDraftModel(act.slice(9));
      if (act === "memory") {
        close();
        DGM.dialogs.memory();
        return;
      }
      if (act === "save") return saveSettings(cur);
      if (act === "noop") return;
    });
  }

  /** 收集供应商密钥 + 默认模型，然后一次性落盘（密钥写凭据库，其余写设置）。 */
  async function saveSettings(cur) {
    const pane = $(".dlg-pane");
    if (cur === "ai" && pane) {
      draftAi = draftAi || JSON.parse(JSON.stringify(state.ai()));
      $$("[data-key]", pane).forEach((inp) => {
        const v = String(inp.value || "").trim();
        if (v) draftKeys[inp.dataset.key] = v;
      });
      const def = $("#ai-default");
      if (def && def.value) draftAi.default_model = def.value;
      $$("[data-pmax]", pane).forEach((inp) => {
        const p = (draftAi.providers || []).find((x) => x.id === inp.dataset.pmax);
        if (!p) return;
        const raw = String(inp.value == null ? "" : inp.value).trim();
        // 留空 = 不发这个键：交给上游按所选模型自己的默认/上限决定。
        // 各家上限不同、`/v1/models` 又不回上限，客户端填不出一个"对所有模型都对"的数；
        // 填大了严格型上游会 400 拒掉整轮（对话那条路会自愈一次，这里不该再制造这种请求）。
        if (!raw) {
          p.max_tokens = null;
          return;
        }
        const n = Math.round(Number(raw));
        if (!Number.isFinite(n) || n < 1 || n > 1_000_000) {
          DGM.toast({ icon: "alert", title: t("set.ai.maxTokensBad"), sub: "", warn: true });
          return; // 保留原值，不静默夹取
        }
        p.max_tokens = n;
      });
      $$("[data-ptemp]", pane).forEach((inp) => {
        const p = (draftAi.providers || []).find((x) => x.id === inp.dataset.ptemp);
        if (p) p.temperature = Math.min(2, Math.max(0, Number(inp.value) || 0));
      });
      $$("[data-pidle]", pane).forEach((inp) => {
        const p = (draftAi.providers || []).find((x) => x.id === inp.dataset.pidle);
        const v = String(inp.value || "").trim();
        const n = Math.round(Number(v));
        if (p) p.idle_timeout_s = v && Number.isFinite(n) && n > 0 ? n : null;
      });
      // 旧字段仍写回模型：设置文件保持自描述。
      for (const m of draftAi.models || []) {
        const p = (draftAi.providers || []).find((x) => x.id === m.provider_id);
        if (!p) continue;
        m.provider = p.provider;
        m.base_url = p.base_url;
        m.max_tokens = p.max_tokens;
        m.temperature = p.temperature;
        m.idle_timeout_s = p.idle_timeout_s;
      }
      for (const [id, secret] of Object.entries(draftKeys)) {
        try {
          await DGM.ipc.invoke("ai_provider_key_set", { providerId: id, secret });
        } catch (e) {
          DGM.toast({ icon: "alert", title: t("set.ai.apiKey"), sub: (e && e.message) || String(e), warn: true });
        }
      }
      for (const id of removedProviders) {
        await DGM.ipc.invoke("ai_provider_key_delete", { providerId: id }).catch(() => {});
      }
      draftKeys = {};
      removedProviders = new Set();
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
      { g: "keys.g.panels", rows: [["Ctrl+B", "keys.panels.i0"], ["Ctrl+J", "keys.panels.i1"], ["keys.key.k1", "keys.panels.i2"], ["Ctrl+1 / Ctrl+2 / Ctrl+3", "keys.panels.i3"], ["Ctrl+Shift+F", "keys.panels.i4"], ["Ctrl+K Ctrl+T", "keys.panels.i5"], ["Alt+1…Alt+5", "keys.panels.i6"]] },
      { g: "keys.g.file", rows: [["Ctrl+N / Ctrl+O / Ctrl+S", "keys.file.i0"], ["Ctrl+Shift+S", "keys.file.i1"], ["Ctrl+W", "keys.file.i2"], ["Ctrl+F", "keys.file.i3"], ["Shift+Alt+F", "keys.file.i4"], ["Ctrl+Shift+H", "keys.file.i5"], ["Alt+Shift+C", "keys.file.i6"], ["Tab / Shift+Tab", "keys.file.i7"]] },
      { g: "keys.g.canvas", rows: [["keys.key.k2", "keys.canvas.i0"], ["keys.key.k3", "keys.canvas.i1"], ["keys.key.k4", "keys.canvas.i2"], ["keys.key.k5", "keys.canvas.i3"], ["Ctrl+= / Ctrl+-", "keys.canvas.i4"]] },
    ];
    const html = groups
      .map(
        (g) => `<div class="keys-group"><h4>${esc(t(g.g))}</h4><div class="keys-rows">${g.rows.map(([k, d]) => `<div class="keys-row"><span class="kbd-inline">${esc(k.startsWith("keys.key.") ? t(k) : k)}</span><span class="ks-d">${esc(t(d))}</span></div>`).join("")}</div></div>`,
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

  /* 「对话历史」的两个页签：doc = 本文档（现有心智），all = 全部（按《AI会话找回方案》§4） */
  let histTab = "doc";
  let histQuery = "";
  let histCache = null; // 最近一次 conversation_list（搜索在本地过滤，不再打 IPC）

  /** 一行会话属于哪一类：文档 / 草稿（还活着）/ 已失联。判定与 Rust 的 list() 一致。 */
  function histKind(m) {
    if (m.path) return m.missing ? "orphan" : "doc";
    return m.live_draft ? "draft" : "orphan";
  }

  function histKindLabel(kind) {
    return kind === "doc" ? t("dlg.history.kindDoc") : kind === "draft" ? t("dlg.history.kindDraft") : t("dlg.history.kindOrphan");
  }

  function histBadge(kind) {
    const ic = kind === "doc" ? "file" : kind === "draft" ? "clock" : "alert";
    return `<span class="badge ${kind}">${icon(ic, "ico-sm")}${esc(histKindLabel(kind))}</span>`;
  }

  function histFmt(m) {
    const f = state.fmtById(m.format || "");
    return (f && f.name) || m.format || "";
  }

  /** 相对时间（复用文件历史的同一套措辞：刚刚 / N 分钟前 / N 小时前 / N 天前）。 */
  function histWhen(ts) {
    return openedWhen(ts);
  }

  /**
   * 「对话历史」：**两个页签**。
   *
   * - 本文档：当前文档的真实轮次（原有内容，未保存文档给"已按草稿保存"的说明）；
   * - 全部：本机所有会话（文档 / 草稿 / 已失联），按更新时间倒序 —— 数据来自
   *   `conversation_list`（只读 meta，不解析全文）。三种归属三种主动作：
   *   打开（文档）/ 恢复（草稿 → 那个标签页）/ 恢复为新标签页（已失联）。
   *
   * 入口沿用 AI 面板标题栏那颗时钟（`#ai-history`）与 Ctrl+R —— 不新增入口，
   * 否则"我该点哪个"会变成新问题（方案 §4.1）。
   */
  async function history(openTab) {
    if (openTab && openTab !== histTab) {
      histTab = openTab;
      histQuery = "";
    }
    if (histTab === "all") {
      try {
        histCache = await DGM.ipc.invoke("conversation_list");
      } catch (e) {
        histCache = null;
        DGM.toast({ icon: "alert", title: t("dlg.history.title"), sub: String((e && e.message) || e), warn: true });
      }
    }
    renderHistory();
  }

  function renderHistory() {
    const seg =
      `<div class="seg">` +
      `<button data-act="tab:doc" class="${histTab === "doc" ? "on" : ""}">${esc(t("dlg.history.tabDoc"))}</button>` +
      `<button data-act="tab:all" class="${histTab === "all" ? "on" : ""}">${esc(t("dlg.history.tabAll"))}</button>` +
      `</div>`;

    const body = histTab === "doc" ? histDocBody() : histAllBody();
    const footHtml =
      histTab === "doc"
        ? foot("", `<button class="btn ghost" data-close>${esc(t("common.close"))}</button><button class="btn ghost" data-act="clear">${icon("trash")}${esc(t("dlg.history.clear"))}</button>`)
        : foot(t("dlg.history.footHint"), `<button class="btn ghost" data-close>${esc(t("common.close"))}</button>`);

    openDialog(
      head(t("dlg.history.title"), "history", t("dlg.history.subtitle")) +
        `<div class="dialog-body">${seg}${body}</div>` +
        footHtml,
      true,
    );

    wire(async (act, _btn, _dlg, e) => {
      if (act === "tab:doc" || act === "tab:all") {
        histTab = act.slice(4);
        histQuery = "";
        await history();
        return;
      }
      if (act === "clear") {
        await DGM.ai.clear();
        close();
        return;
      }
      if (act === "prune") {
        const yes = await confirm({
          title: t("dlg.history.prune"),
          body: t("dlg.history.pruneConfirm"),
          ok: t("dlg.history.prune"),
          danger: true,
        });
        if (!yes) return history();
        let n = 0;
        try {
          n = await DGM.ipc.invoke("conversation_prune", { days: 30 });
        } catch (e) {
          DGM.toast({ icon: "alert", title: t("dlg.history.prune"), sub: String((e && e.message) || e), warn: true });
        }
        DGM.toast({ icon: "trash", title: t("dlg.history.pruned", { n }) });
        await history();
        return;
      }
      if (act.startsWith("open:")) return histOpen(act.slice(5));
      if (act.startsWith("more:")) {
        // 锚点点击不能进文档级"点外面就关"（见 showPop 的约定），否则菜单刚开就被关掉
        if (e && e.stopPropagation) e.stopPropagation();
        return histMore(act.slice(5), _btn);
      }
    });

    // 「全部」页签的搜索：本地过滤（名称 / 路径 / 首条提问），不打 IPC
    const q = $("#hist-q");
    if (q) {
      q.value = histQuery;
      q.addEventListener("input", () => {
        histQuery = q.value;
        renderHistList();
      });
    }
    if (histTab === "all") renderHistList();
  }

  /** 「本文档」页签的正文：原有轮次列表 + 未保存说明。 */
  function histDocBody() {
    const d = state.activeDoc();
    const turns = DGM.ai && DGM.ai.turnsFor ? DGM.ai.turnsFor() : [];
    const persisted = !!(d && d.path);
    const rows = turns.length
      ? turns
          .map((tn) => {
            const who = tn.role === "assistant" ? t("ai.assistant") : t("ai.you");
            const tabKey = tn.tab === "vision" ? "ai.tab.vision" : tn.tab === "review" ? "ai.tab.review" : "ai.tab.chat";
            const meta = [t(tabKey), tn.model, tn.at ? new Date(tn.at).toLocaleTimeString() : ""].filter(Boolean).join(" · ");
            const shown = tn.text.length > 160 ? tn.text.slice(0, 160) + "…" : tn.text;
            // 只有思考、没有正文的那一轮（思考型模型把整轮预算花在推理上）：正文格子空着
            // 会像一条坏记录，如实标出"这一轮只有思考"比留白清楚。
            const cell = shown
              ? esc(shown)
              : `<i>${esc(t("dlg.history.thinkOnly", { n: (tn.thinking || "").length }))}</i>`;
            return (
              `<div class="hist-row hist-turn ${tn.role === "assistant" ? "bot" : "user"}">` +
              `<span class="who">${esc(who)}</span>` +
              `<span class="txt">${cell}</span>` +
              `<span class="meta">${esc(meta)}</span></div>`
            );
          })
          .join("")
      : `<div class="callout">${icon("clock")}<span>${esc(t("dlg.history.empty"))}</span></div>`;
    return `
      <div class="callout${persisted ? "" : " warn"}">${icon("info")}<span>${esc(persisted ? t("dlg.history.note") : t("dlg.history.unsaved"))}</span></div>
      <h4>${esc(d ? d.name : t("common.none"))} ${persisted ? "" : histBadge("draft")} <span class="meta">${esc(t("dlg.history.rounds", { n: turns.length }))}</span></h4>
      <div class="hist-list">${rows}</div>`;
  }

  /** 「全部」页签的骨架：搜索 + 汇总 + 列表容器 + 隐私说明。列表本体由 `renderHistList` 填。 */
  function histAllBody() {
    return `
      <div class="hist-toolbar">
        <div class="hist-search">${icon("search", "ico-sm")}<input id="hist-q" type="text" spellcheck="false"
          data-i18n-placeholder="dlg.history.searchPh" placeholder="${esc(t("dlg.history.searchPh"))}"></div>
      </div>
      <div class="sumline" id="hist-sum"></div>
      <div class="n-list" id="hist-all-list"></div>
      <div class="callout" style="margin-top:10px">${icon("info", "ico-sm")}<span>${esc(t("dlg.history.privacy"))}</span></div>`;
  }

  /** 重新渲染「全部」的列表与汇总（搜索只走到这里，不重开对话框）。 */
  function renderHistList() {
    const box = $("#hist-all-list");
    const sum = $("#hist-sum");
    if (!box) return;
    if (histCache === null) {
      box.innerHTML = `<div class="callout warn">${icon("alert")}<span>${esc(t("dlg.history.listFailed"))}</span></div>`;
      return;
    }
    const q = histQuery.trim().toLowerCase();
    const hit = (m) =>
      !q ||
      String(m.name || "").toLowerCase().includes(q) ||
      String(m.path || "").toLowerCase().includes(q) ||
      String(m.first_prompt || "").toLowerCase().includes(q);
    const rows = histCache.filter(hit);
    const drafts = histCache.filter((m) => histKind(m) === "draft").length;
    const orphan = histCache.filter((m) => histKind(m) === "orphan").length;
    if (sum) {
      sum.innerHTML =
        `<span>${esc(t("dlg.history.summary", { n: histCache.length, draft: drafts, orphan }))}</span>` +
        `<span class="sp"></span><a href="#" data-act="prune">${esc(t("dlg.history.prune"))}</a>`;
    }
    box.innerHTML = rows.length
      ? rows.map(histRow).join("")
      : `<div class="callout">${icon("clock")}<span>${esc(q ? t("dlg.history.noMatch") : t("dlg.history.allEmpty"))}</span></div>`;
  }

  function histRow(m) {
    const kind = histKind(m);
    const base = m.path ? String(m.path).split(/[\\/]/).pop() : "";
    const name = m.name || base || (m.format ? t("dlg.history.draftName", { fmt: histFmt(m) }) : m.key);
    const sub = m.path
      ? `<span class="path" title="${esc(m.path)}">${esc(m.path)}</span>`
      : `<span>${esc(kind === "draft" ? t("dlg.history.draftHint") : t("dlg.history.orphanHint"))}</span>`;
    const q = m.first_prompt ? `<span class="q"> · 「${esc(m.first_prompt)}」</span>` : "";
    const primary = kind === "doc" ? t("dlg.history.actionOpen") : t("dlg.history.actionRestore");
    // 整行可点：列表行看起来就是"一条可打开的历史"，只让右侧小按钮生效等于"点了没反应"
    // （文件打开历史那边整行就是按钮）。行上的 data-act 与主动作同一个键，`wire()` 用
    // closest 取动作，所以行内的 [打开]/[⋯] 仍然各走各的。
    return (
      `<div class="n-row" data-act="open:${esc(m.key)}" title="${esc(primary)}">` +
      `<span class="b">${histBadge(kind)}</span>` +
      `<div class="t1"><span class="nm">${esc(name)}</span>` +
      `<span class="meta">${esc(t("dlg.history.rounds", { n: m.turns }))} · ${esc(histWhen(m.updated_at))}</span></div>` +
      `<div class="t2">${sub}${q}</div>` +
      `<div class="act">` +
      `<button class="mini-btn primary" data-act="open:${esc(m.key)}">${esc(primary)}</button>` +
      `<button class="mini-btn" data-act="more:${esc(m.key)}" title="${esc(t("dlg.history.actionMore"))}">${icon("more", "ico-sm")}</button>` +
      `</div></div>`
    );
  }

  /** 打开 / 恢复：文档 → 打开文件；草稿 → 那个标签页；已失联 → 新标签页 + 搬会话。 */
  async function histOpen(key) {
    let doc = null;
    try {
      doc = await DGM.ipc.invoke("conversation_open", { key });
    } catch (e) {
      DGM.toast({ icon: "alert", title: t("dlg.history.title"), sub: String((e && e.message) || e), warn: true });
      return history();
    }
    if (!doc || !doc.id) return history();
    const payload = await DGM.ipc.invoke("doc_activate", { id: doc.id });
    state.applyResult(payload);
    if (DGM.editor && DGM.editor.loadActive) DGM.editor.loadActive();
    if (DGM.preview && DGM.preview.schedule) DGM.preview.schedule();
    DGM.ai.ensureConversation(doc.id, true);
    close();
    DGM.toast({
      icon: "history",
      title: t("dlg.history.opened", { name: doc.name || "" }),
      sub: doc.path ? "" : t("dlg.history.restored"),
    });
  }

  /** 行尾的「⋯」：在文件夹显示 / 导出 Markdown / 删除（原型 §4.4 动作矩阵）。 */
  function histMore(key, anchor) {
    const m = (histCache || []).find((x) => x.key === key);
    if (!m) return;
    const kind = histKind(m);
    const items = [];
    if (kind === "doc") items.push({ label: t("dlg.history.actionReveal"), icon: "folder", act: "reveal" });
    items.push({ label: t("dlg.history.actionExportMd"), icon: "download", act: "export" });
    items.push({ sep: true }, { label: t("dlg.history.actionDelete"), icon: "trash", act: "delete" });
    const r = (anchor || $("#dialog")).getBoundingClientRect();
    DGM.pop.show(items, { x: Math.max(8, r.right - 200), y: r.bottom + 4 }, async (it) => {
      DGM.pop.hide();
      if (it.act === "reveal") {
        const ok = await state.revealPath(m.path);
        if (!ok) DGM.toast({ icon: "alert", title: t("dlg.history.actionReveal"), sub: t("common.notWired"), warn: true });
        return;
      }
      if (it.act === "export") {
        await histExport(m);
        return;
      }
      if (it.act === "delete") {
        const yes = await confirm({
          title: t("dlg.history.actionDelete"),
          body: t("dlg.history.deleteConfirm"),
          ok: t("dlg.history.actionDelete"),
          danger: true,
        });
        if (!yes) return history();
        try {
          await DGM.ipc.invoke("conversation_delete", { key: m.key });
        } catch (e) {
          DGM.toast({ icon: "alert", title: t("dlg.history.actionDelete"), sub: String((e && e.message) || e), warn: true });
        }
        // 删掉的若正是当前文档的会话：让 AI 面板从磁盘重读（现在是空的）
        const a = state.activeDoc();
        if (a) DGM.ai.ensureConversation(a.id, true);
        DGM.toast({ icon: "trash", title: t("dlg.history.deleted") });
        histCache = null;
        await history("all");
      }
    });
  }

  /** 导出这段会话为 Markdown（只含对话与生成内容；图片本来就不落盘）。 */
  async function histExport(m) {
    let conv = null;
    try {
      conv = await DGM.ipc.invoke("conversation_read", { key: m.key });
    } catch (e) {
      DGM.toast({ icon: "alert", title: t("dlg.history.actionExportMd"), sub: String((e && e.message) || e), warn: true });
      return;
    }
    const stem = String(m.name || m.key).replace(/\.[^.]*$/, "") || "conversation";
    const path = await DGM.ipc.dialog.pickSavePath({
      defaultPath: stem + ".md",
      filters: [{ name: "Markdown", extensions: ["md"] }],
    });
    if (!path) return;
    const lines = [`# ${m.name || m.key}`, ""];
    lines.push(m.path ? `\`${m.path}\`` : t("dlg.history.kindDraft") + (m.format ? ` · ${histFmt(m)}` : ""));
    lines.push("");
    for (const tn of (conv && conv.turns) || []) {
      const who = tn.role === "assistant" ? tn.model || t("ai.assistant") : t("ai.you");
      lines.push(`## ${who}${tn.at ? " · " + new Date(tn.at).toLocaleString() : ""}`);
      lines.push("");
      if (tn.thinking) {
        lines.push(`> ${t("dlg.history.exportThinking", { n: (tn.thinking || "").length })}`, "");
      }
      lines.push(tn.text || "", "");
    }
    const b64 = btoa(unescape(encodeURIComponent(lines.join("\n"))));
    try {
      await state.exportWrite(path, b64);
      DGM.toast({ icon: "download", title: t("dlg.history.actionExportMd"), sub: path });
    } catch (e) {
      DGM.toast({ icon: "alert", title: t("dlg.history.actionExportMd"), sub: String((e && e.message) || e), warn: true });
    }
  }

  /**
   * 「文件打开历史」：`settings.recent` 的**完整列表**（打开时间倒序 + 过滤框）。
   *
   * 为什么单开一个窗口：欢迎页（5 条）、「打开最近文件」子菜单（6 条）、侧栏（8 条）都是
   * **短名单**，想看更早的得有地方可去。而这个入口以前是错的 —— 菜单里的
   * 「更多…（含搜索过滤）」与 Ctrl+R 打开的是 `history()`，那是 **AI 会话历史**
   * （用户 2026-10-18 报的）。
   *
   * 行的点击复用 `DGM.shell.openPath`（欢迎页 / 侧栏同一个入口）：已在标签页里的文档会
   * 切过去，没打开的从磁盘读进来 —— 不另开第二条打开路径。
   */
  function fileHistory() {
    const all = ((state.settings && state.settings.recent) || []).slice();
    const rowsHtml = (list) =>
      list.length
        ? list
            .map((r) => {
              const fmt = (r.format || "").toString();
              return (
                `<button class="hist-row" data-act="open" data-path="${esc(r.path)}" title="${esc(r.path)}">` +
                `<span class="fmt-dot" style="background:var(--fmt-${esc(fmt)})"></span>` +
                `<span class="hr-main"><b>${esc(r.name)}</b><span>${esc(r.path)}</span></span>` +
                `<span class="hr-side">${esc(openedWhen(r.opened_at))}</span></button>`
              );
            })
            .join("")
        : `<div class="callout">${icon("clock")}<span>${esc(t("mi.recentEmpty"))}</span></div>`;
    openDialog(
      head(t("dlg.recent.title"), "clock") +
        `<div class="dialog-body">` +
        `<div class="field"><input type="text" id="recent-filter" placeholder="${esc(t("dlg.recent.search"))}"></div>` +
        `<div class="hist-list" id="recent-rows">${rowsHtml(all)}</div>` +
        `</div>` +
        foot(t("dlg.recent.note"), `<button class="btn ghost" data-close>${esc(t("common.close"))}</button>`),
      true,
    );
    const box = $("#recent-filter");
    const rows = $("#recent-rows");
    if (box && rows) {
      box.addEventListener("input", () => {
        const q = box.value.trim().toLowerCase();
        // 只换列表、不重绘输入框：整块重绘会把光标踢出过滤框
        rows.innerHTML = rowsHtml(
          q
            ? all.filter(
                (r) => (r.name || "").toLowerCase().includes(q) || (r.path || "").toLowerCase().includes(q),
              )
            : all,
        );
      });
      box.focus();
    }
    wire((act, el) => {
      if (act !== "open" || !el.dataset.path) return;
      const path = el.dataset.path;
      close();
      DGM.shell.openPath(path);
    });
  }

  /** 「多久以前打开」——与侧栏最近列表同一套说法（`common.*Ago`），日期本身不显示。 */
  function openedWhen(ts) {
    if (!ts) return "";
    const m = Math.round((Date.now() - ts) / 60000);
    if (m < 1) return t("common.justNow");
    if (m < 60) return t("common.minutesAgo", { n: m });
    const hh = Math.round(m / 60);
    if (hh < 24) return t("common.hoursAgo", { n: hh });
    return t("common.daysAgo", { n: Math.round(hh / 24) });
  }

  /* ================================================================== 记忆 */

  /** 正在编辑的条目 id（null = 没有）。编辑器是**行内**的：点「编辑」把那一行换成输入框。 */
  let memEditing = null;

  function memNewId() {
    return "mem-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 7);
  }

  /** 记忆管理：列出全部条目（含待确认），可新增 / 编辑 / 停用 / 删除 / 清空。
   *
   *  为什么做成**独立对话框**而不是塞进设置页：设置页有一套"草稿 + 保存"的语义
   *  （改到一半关掉不该生效），而记忆的每次增删改都是**立即落盘**的。两种语义混在
   *  一个表单里，用户会分不清"我改的到底生效没有"。这里没有保存按钮，就是明确信号。
   */
  function memory() {
    memEditing = null;
    DGM.state.memoryRefresh().then(renderMemory).catch(() => renderMemory());
  }

  function renderMemory() {
    const mem = DGM.state.memory || { items: [], doc: "" };
    const items = mem.items || [];
    const confirmed = items.filter((e) => e.state === "confirmed");
    const pending = items.filter((e) => e.state === "pending");

    const row = (e) => {
      const isPending = e.state === "pending";
      const scopeLabel = e.scope === "doc" ? t("dlg.memory.scope.doc") : t("dlg.memory.scope.global");
      const tags =
        `<span class="mem-tag${isPending ? " pending" : ""}">${esc(isPending ? t("dlg.memory.pending") : t("dlg.memory.confirmed"))}</span>` +
        `<span class="mem-tag">${esc(scopeLabel)}</span>` +
        (e.enabled === false ? `<span class="mem-tag off">${esc(t("dlg.memory.disabled"))}</span>` : "");

      if (memEditing === e.id) {
        return (
          `<div class="mem-row${isPending ? " pending" : ""}">` +
          `<span class="mem-txt"><input type="text" id="mem-edit" value="${esc(e.text)}" maxlength="200"></span>` +
          `<span class="mem-acts">` +
          `<button class="mini-btn" data-act="savedit:${esc(e.id)}">${esc(t("common.save"))}</button>` +
          `<button class="mini-btn" data-act="canceledit">${esc(t("common.cancel"))}</button>` +
          `</span></div>`
        );
      }

      const acts =
        (isPending
          ? `<button class="mini-btn" data-act="confirm:${esc(e.id)}">${icon("check", "ico-sm")}${esc(t("dlg.memory.confirm"))}</button>`
          : "") +
        `<button class="mini-btn" data-act="toggle:${esc(e.id)}">${esc(e.enabled === false ? t("dlg.memory.enable") : t("dlg.memory.disable"))}</button>` +
        `<button class="mini-btn" data-act="edit:${esc(e.id)}">${esc(t("dlg.memory.edit"))}</button>` +
        `<button class="mini-btn" data-act="del:${esc(e.id)}">${esc(t("dlg.memory.delete"))}</button>`;

      return (
        `<div class="mem-row${isPending ? " pending" : ""}">` +
        `<span class="mem-txt">${esc(e.text)}</span>` +
        `<span class="mem-tags">${tags}</span>` +
        `<span class="mem-acts">${acts}</span></div>`
      );
    };

    const section = (arr, titleKey) =>
      arr.length
        ? `<h4>${esc(t(titleKey))} <span class="meta">${arr.length}</span></h4><div class="hist-list">${arr.map(row).join("")}</div>`
        : "";

    const body = `
      <div class="callout">${icon("info")}<span>${esc(t("dlg.memory.note"))}</span></div>
      <div class="mem-head-acts">
        <input type="text" id="mem-new" placeholder="${esc(t("dlg.memory.addPh"))}" maxlength="200">
        <button class="btn sm" data-act="add">${icon("plus")}${esc(t("dlg.memory.add"))}</button>
        <span class="sp"></span>
        ${pending.length ? `<button class="btn sm ghost" data-act="clearpending">${esc(t("dlg.memory.clearPending"))}</button>` : ""}
        ${items.length ? `<button class="btn sm ghost" data-act="clearall">${esc(t("dlg.memory.clear"))}</button>` : ""}
      </div>
      ${items.length ? "" : `<div class="callout">${icon("sparkles")}<span>${esc(t("dlg.memory.empty"))}</span></div>`}
      ${section(pending, "dlg.memory.pendingTitle")}
      ${section(confirmed, "dlg.memory.confirmedTitle")}`;

    openDialog(
      head(t("dlg.memory.title"), "sparkles") +
        `<div class="dialog-body">${body}</div>` +
        foot(
          t("dlg.memory.foot", { n: items.length, max: 200 }),
          `<button class="btn ghost" data-close>${esc(t("common.close"))}</button>`,
        ),
      true,
    );

    const fail = (e) =>
      DGM.toast({ icon: "info", title: String((e && e.message) || e || ""), sub: "", warn: true });
    const byId = (id) => items.find((x) => x.id === id);

    wire(async (act) => {
      if (act === "add") {
        const box = $("#mem-new");
        const text = box ? box.value.trim() : "";
        if (!text) return;
        try {
          await DGM.state.memorySave({
            id: memNewId(),
            text,
            scope: "global",
            doc: "",
            state: "confirmed",
            source: "user",
            enabled: true,
            at: Date.now(),
          });
        } catch (e) {
          fail(e);
          return;
        }
        renderMemory();
        return;
      }
      if (act.startsWith("confirm:")) {
        const e = byId(act.slice(8));
        if (!e) return;
        try {
          await DGM.state.memorySave({ ...e, state: "confirmed", source: "user", at: Date.now() });
        } catch (err) {
          fail(err);
          return;
        }
        renderMemory();
        return;
      }
      if (act.startsWith("toggle:")) {
        const e = byId(act.slice(7));
        if (!e) return;
        try {
          await DGM.state.memorySave({ ...e, enabled: e.enabled === false });
        } catch (err) {
          fail(err);
          return;
        }
        renderMemory();
        return;
      }
      if (act.startsWith("del:")) {
        try {
          await DGM.state.memoryDelete(act.slice(4));
        } catch (err) {
          fail(err);
          return;
        }
        memEditing = null;
        renderMemory();
        return;
      }
      if (act.startsWith("edit:")) {
        memEditing = act.slice(5);
        renderMemory();
        return;
      }
      if (act === "canceledit") {
        memEditing = null;
        renderMemory();
        return;
      }
      if (act.startsWith("savedit:")) {
        const e = byId(act.slice(8));
        const box = $("#mem-edit");
        const text = box ? box.value.trim() : "";
        if (!e || !text) return;
        try {
          await DGM.state.memorySave({ ...e, text });
        } catch (err) {
          fail(err);
          return;
        }
        memEditing = null;
        renderMemory();
        return;
      }
      if (act === "clearpending") {
        try {
          await DGM.state.memoryClear("pending");
        } catch (err) {
          fail(err);
          return;
        }
        renderMemory();
        return;
      }
      if (act === "clearall") {
        try {
          await DGM.state.memoryClear("all");
        } catch (err) {
          fail(err);
          return;
        }
        memEditing = null;
        renderMemory();
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

  /* ================================================================== 更新 */

  /**
   * 更新窗口：在**同一个窗口**里走完「看更新说明 → 下载 → 安装」，中途不关窗。
   *
   *   ask     ：版本 + 更新说明 + [取消] [下载并安装]
   *   prog    ：进度条 + 「正在下载 42%」+ 关窗不中断的说明 + [关闭]
   *   stalled ：卡住时多给一个 [用浏览器手动下载]
   *
   * 它是**更新流程唯一的界面**：菜单「检查更新」查到新版、以及点状态栏那一项，都走到这里。
   * 调用方（shell.js 的更新器）用返回的控制器推进：
   *
   *   const d = DGM.dialogs.updateDialog({ version, notes, startPhase, onInstall, onManual, onClose });
   *   d.setProgress({ text, pct, hint });   // 下载中反复调（内部 150ms 限流，免得每块都重排）
   *   d.stalled({ mb });  d.finish();  d.fail(msg);
   */
  function updateDialog(opts) {
    const o = opts || {};
    const version = String(o.version || "?");
    const notes = String(o.notes || "").slice(0, 600);
    let phase = o.startPhase === "prog" ? "prog" : "ask";
    let closed = false;

    function render() {
      if (closed) return;
      const isAsk = phase === "ask";
      const body = isAsk
        ? `<div class="callout">${icon("info")}<span>${esc(notes || t("update.available", { version }))}</span></div>`
        : `<div class="upd-prog">
             <p class="upd-text" id="upd-text">${esc(t("update.downloading"))}</p>
             <progress id="upd-bar" max="100" value="0"></progress>
             <p class="upd-hint" id="upd-hint">${esc(t("update.closeKeepsDownloading"))}</p>
           </div>`;
      const footHtml = isAsk
        ? `<button class="btn ghost" data-act="later">${esc(t("common.cancel"))}</button>` +
          `<button class="btn primary" data-act="go">${esc(t("update.install"))}</button>`
        : (phase === "stalled" ? `<button class="btn" data-act="manual">${esc(t("update.manualBtn"))}</button>` : "") +
          `<button class="btn ghost" data-act="hide">${esc(t("common.close"))}</button>`;
      openDialog(head(isAsk ? t("update.available", { version }) : t("update.downloading"), "download") +
        `<div class="dialog-body">${body}</div>` + foot("", footHtml), false);
      wire((act) => {
        if (act === "go") { phase = "prog"; render(); if (o.onInstall) o.onInstall(); return; }
        if (act === "manual") { if (o.onManual) o.onManual(); return; }
        closeDialog();
      });
    }
    function closeDialog() {
      if (closed) return;
      closed = true;
      close();
      if (o.onClose) o.onClose();
    }
    render();

    return {
      isOpen: () => !closed,
      phase: () => phase,
      /**
       * 就地更新进度（调用方负责限流 —— shell.js 那边有带 trailing-edge 的节流，
       * 所以这里**不再自己丢帧**：这里再丢一次就会把最终值吃掉）。
       */
      setProgress(p) {
        if (closed || phase === "ask") return;
        const el = $("#upd-text");
        if (el && p && p.text != null) el.textContent = p.text;
        const bar = $("#upd-bar");
        if (bar && p && p.pct != null) bar.value = Math.max(0, Math.min(100, p.pct));
        const hint = $("#upd-hint");
        if (hint && p && p.hint != null) hint.textContent = p.hint;
      },
      /** 卡住：换说明 + 把「用浏览器手动下载」按钮加出来（需要重画尾部按钮）。 */
      stalled(p) {
        if (closed) return;
        phase = "stalled";
        render();
        this.setProgress(p);
      },
      finish() {
        if (closed || phase === "ask") return;
        const el = $("#upd-text");
        if (el) el.textContent = t("update.restarting");
        const bar = $("#upd-bar");
        if (bar) bar.value = 100;
        const hint = $("#upd-hint");
        if (hint) hint.textContent = t("update.willClose");
      },
      fail(msg) {
        if (closed || phase === "ask") return;
        const el = $("#upd-text");
        if (el) el.textContent = t("update.failed") + (msg ? "：" + msg : "");
        const hint = $("#upd-hint");
        if (hint) hint.textContent = "";
      },
      close: closeDialog,
    };
  }

  /* ================================================================== 布局引擎 */

  function layout() {
    const d = state.activeDoc();
    if (!d) return;
    const layouts = state.docFmt(d).layouts || [];
    // 没有布局引擎的格式（Mermaid / 画布型）什么都不弹：命令的 avail 已经拦过一次，
    // 这里是第二道 —— 别给一个空列表的菜单。
    if (!layouts.length) return;
    const items = layouts.map((l) => ({ label: l, check: true, on: (d.layout || layouts[0]) === l, l }));
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
    updateDialog,
    keys,
    guide,
    about,
    history,
    fileHistory,
    memory,
    unsaved,
    quit,
    layout,
    close,
    open: openDialog,
  };
})();

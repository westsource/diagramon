/* AI 右栏：对话生成 / 识图 / 改图 三 tab。
 *
 * - 请求走 ai_chat，接受结果走事件 ai://delta / ai://done / ai://failed；
 *   mock 后端在同一条事件通道上假流式，界面无需区分。
 * - 模型来自 settings.ai.models（唯一真源）；没有模型时给明确引导，不假装能用。
 * - 识图：图片先压到 ≤1568px 再转 dataURL，只在内存里，不落盘。
 * - 「改图」把当前文档正文作为 context；「对话」可选把当前图作为上下文。
 */
window.DGM = window.DGM || {};
(function () {
  "use strict";

  const state = DGM.state;
  const ipc = DGM.ipc;
  const t = (k, v) => DGM.i18n.t(k, v);
  const icon = DGM.icon;
  const { $, $$, h, esc } = DGM.dom;

  const MAX_EDGE = 1568;

  // 每个 tab 各存一份消息
  const msgs = { chat: [], vision: [], review: [] };
  let unreadCount = 0;
  let selectionCtx = null; // 来自「让 AI 改这段」的选区
  let bound = false;

  function tab() {
    return state.ui.aiTab || "chat";
  }

  /* ------------------------------------------------------------------ 文本 / 代码块 */

  /** 把正文里的 ``` 围栏拆出来：返回 {text, blocks:[{lang, code}]}。 */
  function splitFences(text) {
    const blocks = [];
    const re = /```([a-zA-Z0-9-]*)\r?\n([\s\S]*?)```/g;
    let m;
    let out = "";
    let last = 0;
    while ((m = re.exec(text))) {
      out += text.slice(last, m.index);
      blocks.push({ lang: (m[1] || "").toLowerCase(), code: m[2].replace(/\s+$/, "") });
      last = m.index + m[0].length;
    }
    out += text.slice(last);
    return { text: out.trim(), blocks };
  }

  function langToFormat(lang) {
    if (lang === "dot" || lang === "graphviz") return "dot";
    if (lang === "xml") return "drawio";
    if (lang === "json") return "excalidraw";
    return "mermaid";
  }

  /* ------------------------------------------------------------------ 渲染 */

  function bubbleNode(m) {
    const roleCls = m.role === "user" ? "user" : m.role === "sys" ? "sys" : m.err ? "err" : "bot";
    const n = h("div", "msg " + roleCls);
    if (m.role === "sys") {
      n.innerHTML = `<div class="bubble">${icon("info", "ico-sm")} ${esc(m.text)}</div>`;
      return n;
    }
    const head =
      m.role === "user"
        ? `<div class="msg-head"><span class="who">${esc(t("ai.you"))}</span></div>`
        : `<div class="msg-head">${icon("robot", "ico-sm")}<span class="who">${esc(t("ai.assistant"))}</span>` +
          (m.used ? `<span class="badge-used">${esc(m.used.model)} · ${esc(m.used.tokens)} tok</span>` : "") +
          `</div>`;
    n.innerHTML = head;
    if (m.image) {
      const th = h("div", "thumb");
      th.innerHTML =
        `<span class="pic">${m.image.dataUrl ? `<img src="${m.image.dataUrl}" alt="">` : icon("image", "ico-lg")}</span>` +
        `<span class="meta"><b>${esc(m.image.name)}</b><span>${esc(m.image.meta || "")}</span></span>`;
      n.appendChild(th);
    }

    const parsed = splitFences(m.text || "");
    if (parsed.text) {
      const b = h("div", "bubble" + (m.streaming ? " streaming" : ""), esc(parsed.text).replace(/\n/g, "<br>"));
      b.dataset.req = m.req || "";
      n.appendChild(b);
    } else if (m.streaming) {
      const b = h("div", "bubble streaming");
      b.dataset.req = m.req || "";
      n.appendChild(b);
    }

    for (const blk of parsed.blocks) {
      n.appendChild(codeCard(blk, m));
    }
    if (m.applied) {
      const done = h("span", "applied-tag", `${icon("check", "ico-sm")}${esc(t("ai.applied"))}`);
      n.appendChild(done);
    }
    return n;
  }

  function codeCard(blk, m) {
    const fmt = langToFormat(blk.lang);
    const lines = blk.code.split("\n").length;
    const card = h("div", "code-card");
    card.innerHTML =
      `<div class="code-card-head">${icon("file", "ico-sm")}` +
      `<span class="chip ${fmt}">${esc(state.fmtById(fmt).name)}</span><span>${lines} ${esc(t("common.line"))}</span>` +
      `<span class="sp"></span>` +
      `<button class="mini-btn" data-a="copy">${icon("copy", "ico-sm")}${esc(t("common.copy"))}</button></div>` +
      `<pre>${esc(blk.code)}</pre>`;
    const acts = h("div", "code-card-actions");
    const applyBtn = h("button", "btn sm primary", `${icon("check")}${esc(t("ai.apply"))}`);
    applyBtn.addEventListener("click", () => applyBlock(blk, m));
    const revertBtn = h("button", "btn sm ghost", `${icon("undo")}${esc(t("common.revert"))}`);
    revertBtn.addEventListener("click", () => DGM.ai.revertLast());
    acts.append(applyBtn, revertBtn);
    card.appendChild(acts);
    card.addEventListener("click", (e) => {
      if (e.target.closest('[data-a="copy"]')) copyText(blk.code);
    });
    return card;
  }

  function emptyNode() {
    const box = h("div", "ai-empty");
    box.innerHTML =
      `<div><div class="hero">${icon("sparkles", "ico-lg")}</div>` +
      `<h3>${esc(t("ai.empty.title"))}</h3>` +
      `<p>${esc(t("ai.empty.desc"))}</p>` +
      `<div class="acts">` +
      `<button class="btn ai block" data-a="gen">${icon("sparkles")}${esc(t("ai.empty.gen"))}</button>` +
      `<button class="btn block" data-a="vision">${icon("scan")}${esc(t("ai.empty.vision"))}</button>` +
      `<button class="btn ghost block" data-a="ctx">${icon("diagram")}${esc(t("ai.empty.ctx"))}</button>` +
      `</div></div>`;
    box.addEventListener("click", (e) => {
      const b = e.target.closest("button");
      if (!b) return;
      if (b.dataset.a === "vision") DGM.ai.focus("vision");
      else if (b.dataset.a === "ctx") DGM.ai.focus("review");
      else input().focus();
    });
    return box;
  }

  function noModelsNode() {
    const box = h("div", "ai-empty");
    box.innerHTML =
      `<div><div class="hero">${icon("key", "ico-lg")}</div>` +
      `<h3>${esc(t("ai.noModels.title"))}</h3>` +
      `<p>${esc(t("ai.noModels.desc"))}</p>` +
      `<div class="acts"><button class="btn ai block" data-a="go">${icon("settings")}${esc(t("ai.noModels.cta"))}</button></div></div>`;
    box.addEventListener("click", (e) => {
      if (e.target.closest("button")) DGM.dialogs.settings("ai");
    });
    return box;
  }

  function input() {
    return $("#ai-input");
  }

  function render() {
    const cur = tab();
    state.ui.aiTab = cur;
    const stream = $("#ai-stream");
    if (!stream) return;

    $$("#ai-tabs .ai-tab").forEach((b) => b.classList.toggle("on", b.dataset.ai === cur));

    stream.innerHTML = "";
    if (!state.hasModels()) {
      stream.appendChild(noModelsNode());
    } else if (!msgs[cur].length) {
      stream.appendChild(emptyNode());
    } else {
      msgs[cur].forEach((m) => stream.appendChild(bubbleNode(m)));
    }

    // 输入框占位与提示
    const ta = input();
    if (ta) ta.placeholder = t("ai.input." + cur);
    const hint = $("#ai-hint");
    const d = state.activeDoc();
    if (hint) {
      hint.textContent =
        cur === "vision"
          ? t("ai.hint.vision")
          : cur === "review"
            ? t("ai.hint.review", { name: d ? d.name : t("status.noDoc") })
            : t("ai.hint.chat", { name: d ? state.docFmt(d).name : t("status.noDoc") });
    }

    // 建议词只在对话 tab
    const sug = $("#ai-suggest");
    if (sug) {
      if (cur === "chat") {
        sug.hidden = false;
        sug.innerHTML = "";
        ["ai.suggest.1", "ai.suggest.2", "ai.suggest.3", "ai.suggest.4", "ai.suggest.5"].forEach((k) => {
          const b = h("button", "sug", esc(t(k)));
          b.addEventListener("click", () => {
            if (ta) {
              ta.value = t(k);
              ta.focus();
              syncSend();
            }
          });
          sug.appendChild(b);
        });
      } else {
        sug.hidden = true;
      }
    }

    syncModel();
    renderAttachment();
    syncSend();
    stream.scrollTop = stream.scrollHeight;
  }

  function syncModel() {
    const name = $("#ai-model-name");
    const dot = $("#ai-model .dot");
    const m = state.currentModel();
    if (name) name.textContent = m ? m.name : t("ai.model.none");
    if (dot) dot.style.background = m ? (m.has_key ? "var(--ok)" : "var(--warn)") : "var(--faint)";
  }

  function syncSend() {
    const btn = $("#ai-send");
    if (!btn) return;
    const busy = state.ui.aiBusy;
    btn.disabled = !busy && (!state.hasModels() || !(input() || {}).value?.trim());
    btn.title = busy ? t("ai.cancelled") : t("common.send");
    btn.innerHTML = busy ? icon("close", "ico-sm") : icon("send", "ico-sm");
    btn.classList.toggle("stop", busy);
  }

  /* ------------------------------------------------------------------ 附件 / 选区 */

  function renderAttachment() {
    const box = $("#ai-attachments");
    if (!box) return;
    box.innerHTML = "";
    const att = state.ui.aiAttachment;
    if (att) {
      const chip = h("div", "thumb");
      chip.innerHTML =
        `<span class="pic">${att.dataUrl ? `<img src="${att.dataUrl}" alt="">` : icon("image")}</span>` +
        `<span class="meta"><b>${esc(att.name)}</b><span>${esc(att.meta || "")}</span></span>`;
      const x = h("button", "icon-btn", icon("close", "ico-sm"));
      x.title = t("ai.removeImage");
      x.addEventListener("click", () => {
        state.ui.aiAttachment = null;
        render();
      });
      chip.appendChild(x);
      box.appendChild(chip);
    }
    if (selectionCtx) {
      const chip = h("div", "ai-chip", `${icon("code", "ico-sm")}<span>${esc(t("src.ai"))}</span>`);
      const x = h("button", "icon-btn", icon("close", "ico-sm"));
      x.addEventListener("click", () => {
        selectionCtx = null;
        render();
      });
      chip.appendChild(x);
      box.appendChild(chip);
    }
    box.hidden = !box.children.length;
  }

  function attachSelection(text) {
    selectionCtx = text || null;
    render();
    if (text) DGM.toast({ icon: "code", title: t("src.ai"), sub: t("ai.ctxSet") });
  }

  /* ------------------------------------------------------------------ 图片压缩 */

  function compressImage(src) {
    return new Promise((resolve) => {
      const img = new Image();
      img.onload = () => {
        let { width: w, height: h } = img;
        const scale = Math.min(1, MAX_EDGE / Math.max(w, h));
        w = Math.round(w * scale);
        h = Math.round(h * scale);
        const canvas = document.createElement("canvas");
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext("2d");
        ctx.drawImage(img, 0, 0, w, h);
        resolve({ dataUrl: canvas.toDataURL("image/png"), w, h, compressed: scale < 1 });
      };
      img.onerror = () => resolve(null);
      img.src = src;
    });
  }

  async function pickImage() {
    const picked = await ipc.dialog.pickImage();
    if (!picked || !picked.dataUrl) return;
    const out = await compressImage(picked.dataUrl);
    if (!out) {
      DGM.toast({ icon: "alert", title: t("ai.attach"), sub: t("exp.rasterFail"), warn: true });
      return;
    }
    state.ui.aiAttachment = {
      name: picked.name,
      dataUrl: out.dataUrl,
      meta: t("ai.vision.compress", { w: out.w, h: out.h }),
    };
    if (tab() !== "vision") state.ui.aiTab = "vision";
    render();
    DGM.toast({ icon: "image", title: t("ai.attached"), sub: t("ai.attachedDesc") });
  }

  /* ------------------------------------------------------------------ 发送 / 流式 */

  function newId() {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    return "req-" + Date.now() + "-" + Math.random().toString(36).slice(2, 8);
  }

  function curDocForReq() {
    const d = state.activeDoc();
    return d || null;
  }

  async function sendNow() {
    if (state.ui.aiBusy) return cancel();
    const ta = input();
    const prompt = ta ? ta.value.trim() : "";
    if (!state.hasModels()) {
      DGM.toast({ icon: "key", title: t("ai.needModel"), sub: "", warn: true });
      DGM.dialogs.settings("ai");
      return;
    }
    const cur = tab();
    const d = curDocForReq();
    const fmtId = d ? d.format : "mermaid";
    const att = state.ui.aiAttachment;

    if (cur === "vision" && !att) {
      DGM.toast({ icon: "image", title: t("ai.vision.pick"), sub: "", warn: true });
      return;
    }
    const text = prompt || (cur === "vision" ? t("ai.tab.vision") : "");
    if (!text) {
      ta && ta.focus();
      return;
    }

    // 上下文：改图用整篇正文；选择区优先；对话按设置决定
    const ai = state.ai();
    let context = null;
    if (selectionCtx) context = selectionCtx;
    else if (cur === "review") context = d ? d.body : null;
    else if (cur === "chat" && ai.context_from_doc && d && state.isTextDoc(d)) context = d.body;

    const req = {
      request_id: newId(),
      model_id: state.currentModel() ? state.currentModel().id : "",
      intent: cur === "vision" ? "vision" : cur === "review" ? "review" : "generate",
      prompt: text,
      format: fmtId,
      context: context || null,
      image_data_url: cur === "vision" && att ? att.dataUrl : null,
    };

    if (ta) ta.value = "";
    if (cur === "vision" && att) state.ui.aiAttachment = null;
    selectionCtx = null;

    msgs[cur].push({ id: newId(), role: "user", text, image: cur === "vision" && att ? att : null });
    const bot = { id: newId(), role: "assistant", text: "", streaming: true, req: req.request_id, m: cur };
    msgs[cur].push(bot);
    state.ui.aiBusy = true;
    state.ui.aiRequestId = req.request_id;
    render();

    try {
      await ipc.invoke("ai_chat", { req });
    } catch (e) {
      bot.streaming = false;
      bot.err = true;
      bot.text = (e && e.message) || String(e);
      state.ui.aiBusy = false;
      render();
    }
  }

  function cancel() {
    const id = state.ui.aiRequestId;
    if (id) ipc.invoke("ai_cancel", { request_id: id }).catch(() => {});
    const m = findMsg(id);
    if (m) {
      m.streaming = false;
      m.text = m.text || t("ai.cancelled");
    }
    state.ui.aiBusy = false;
    state.ui.aiRequestId = null;
    render();
  }

  function findMsg(reqId) {
    for (const k of Object.keys(msgs)) {
      const m = msgs[k].find((x) => x.req === reqId);
      if (m) return m;
    }
    return null;
  }

  function onDelta(ev) {
    const m = findMsg(ev && ev.request_id);
    if (!m) return;
    m.text = (m.text || "") + (ev.delta || "");
    // 只更新那块流式气泡，避免整栏重排
    const node = $(`#ai-stream .bubble[data-req="${ev.request_id}"]`);
    if (node) {
      const parsed = splitFences(m.text).text;
      node.innerHTML = esc(parsed).replace(/\n/g, "<br>");
    }
  }

  function onDone(ev) {
    const m = findMsg(ev && ev.request_id);
    state.ui.aiBusy = false;
    state.ui.aiRequestId = null;
    if (!m) {
      render();
      return;
    }
    m.streaming = false;
    m.text = ev.text || m.text;
    m.used = {
      model: ev.model || "",
      tokens: (ev.prompt_tokens || 0) + (ev.completion_tokens || 0),
    };
    state.addUsage(ev);
    if (!state.panels().ai) unreadCount += 1; // 面板收起时的未读角标
    state.pushOutput(t("ai.used", { model: m.used.model, tokens: m.used.tokens, credits: "—" }), "ok");
    render();
    if (DGM.shell && DGM.shell.renderActivity) DGM.shell.renderActivity();
    if (state.ui.aiSendThenApply) {
      state.ui.aiSendThenApply = false;
      applyLast();
    }
  }

  function onFailed(ev) {
    const m = findMsg(ev && ev.request_id);
    state.ui.aiBusy = false;
    state.ui.aiRequestId = null;
    if (m) {
      m.streaming = false;
      m.err = true;
      m.text = (ev && ev.message) || t("ai.fail");
    }
    render();
  }

  /* ------------------------------------------------------------------ 应用 */

  let lastApplied = null; // {id, body}

  async function applyBlock(blk, m) {
    const fmt = langToFormat(blk.lang);
    let d = state.activeDoc();
    if (!d || (state.isTextDoc(d) && d.format !== fmt && blk.lang)) {
      // 目标格式不一致或当前是画布型：另开一个对应格式的新标签页再落正文
      if (!d || state.isCanvasDoc(d) || d.format !== fmt) {
        const created = await state.newDoc(fmt);
        if (created) {
          DGM.editor.loadActive();
          d = created;
        }
      }
    }
    if (!d) return;
    lastApplied = { id: d.id, body: d.body };
    await DGM.editor.applyBody(blk.code);
    if (m) m.applied = true;
    render();
    DGM.toast({ icon: "check", title: t("ai.appliedToast"), sub: t("ai.appliedToastSub") });
  }

  async function applyLast() {
    const cur = tab();
    const list = msgs[cur];
    for (let i = list.length - 1; i >= 0; i -= 1) {
      const m = list[i];
      if (m.role !== "assistant") continue;
      const { blocks } = splitFences(m.text || "");
      if (blocks.length) return applyBlock(blocks[0], m);
    }
    DGM.toast({ icon: "info", title: t("ai.apply"), sub: t("exp.noContent") });
  }

  async function revertLast() {
    if (!lastApplied) {
      DGM.toast({ icon: "undo", title: t("ai.reverted"), sub: t("common.none") });
      return;
    }
    const d = state.doc(lastApplied.id);
    if (d) {
      await DGM.editor.applyBody(lastApplied.body);
      render();
      DGM.toast({ icon: "undo", title: t("ai.reverted"), sub: t("ai.revertedSub") });
    }
    lastApplied = null;
  }

  function copyText(text) {
    const done = () => DGM.toast({ icon: "copy", title: t("ai.copied"), sub: "" });
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(done).catch(done);
    else done();
  }

  /* ------------------------------------------------------------------ 模型下拉 */

  function popModels(anchor) {
    const ai = state.ai();
    const models = ai.models || [];
    const a = anchor || $("#ai-model");
    const r = a ? a.getBoundingClientRect() : { left: innerWidth - 320, bottom: 60 };
    if (!models.length) {
      DGM.pop.show([{ label: t("ai.model.settings"), icon: "settings", act: "settings" }], { x: r.left, y: r.bottom + 4 }, () => {
        DGM.pop.hide();
        DGM.dialogs.settings("ai");
      });
      return;
    }
    const items = models.map((m) => ({
      label: m.name + (m.has_key ? "" : `  (${t("ai.model.none")})`),
      icon: "robot",
      check: true,
      on: m.id === ai.default_model,
      id: m.id,
    }));
    items.push({ sep: true }, { label: t("ai.model.settings"), icon: "settings", act: "settings" });
    DGM.pop.show(items, { x: r.left, y: r.bottom + 4 }, (it) => {
      DGM.pop.hide();
      if (it.act === "settings") return DGM.dialogs.settings("ai");
      if (it.id) {
        state.patchSettings({ ai: { default_model: it.id } });
        render();
      }
    });
  }

  /* ------------------------------------------------------------------ 焦点 / 预填 */

  function focus(which) {
    if (which) state.ui.aiTab = which;
    if (!state.panels().ai) state.patchSettings({ panels: { ai: true } });
    unreadCount = 0;
    render();
    const ta = input();
    if (ta) setTimeout(() => ta.focus(), 0);
    if (DGM.shell && DGM.shell.renderActivity) DGM.shell.renderActivity();
  }

  function prefill(text, send) {
    const ta = input();
    if (ta) ta.value = text || "";
    syncSend();
    if (send) sendNow();
  }

  function unread() {
    return unreadCount;
  }

  function clear() {
    msgs[tab()] = [];
    render();
    DGM.toast({ icon: "trash", title: t("ai.clearToast"), sub: "" });
  }

  /* ------------------------------------------------------------------ 绑定 */

  function bind() {
    if (bound) return;
    bound = true;

    $$("#ai-tabs .ai-tab").forEach((b) =>
      b.addEventListener("click", () => {
        state.ui.aiTab = b.dataset.ai;
        render();
        const ta = input();
        ta && ta.focus();
      }),
    );

    const ta = input();
    if (ta) {
      ta.addEventListener("input", syncSend);
      ta.addEventListener("keydown", (e) => {
        if (e.key === "Enter" && e.ctrlKey) {
          e.preventDefault();
          state.ui.aiSendThenApply = true;
          sendNow();
        } else if (e.key === "Enter" && !e.shiftKey) {
          e.preventDefault();
          sendNow();
        }
      });
    }

    const send = $("#ai-send");
    if (send) send.addEventListener("click", sendNow);
    const att = $("#ai-attach");
    if (att) att.addEventListener("click", pickImage);
    const shot = $("#ai-screenshot");
    if (shot) shot.addEventListener("click", () => DGM.toast({ icon: "scan", title: t("ai.screenshot"), sub: t("common.notWired") }));
    const ctx = $("#ai-context");
    if (ctx) {
      ctx.addEventListener("click", () => {
        const d = state.activeDoc();
        if (!d) return;
        state.ui.aiTab = "review";
        render();
        DGM.toast({ icon: "diagram", title: t("ai.ctxSet"), sub: d.name });
      });
    }
    const model = $("#ai-model");
    if (model) model.addEventListener("click", (e) => popModels(e.currentTarget));
    const hist = $("#ai-history");
    if (hist) hist.addEventListener("click", () => DGM.dialogs.history());
    const clr = $("#ai-clear");
    if (clr) clr.addEventListener("click", clear);
    const close = $("#ai-close");
    if (close) close.addEventListener("click", () => DGM.shell.togglePanel("ai"));

    ipc.on("ai://delta", onDelta);
    ipc.on("ai://done", onDone);
    ipc.on("ai://failed", onFailed);
  }

  DGM.bus.on("settings:changed", render);
  DGM.bus.on("session:changed", render);

  DGM.ai = {
    render,
    bind,
    focus,
    prefill,
    attachSelection,
    unread,
    clear,
    send: sendNow,
    cancel,
    applyLast,
    revertLast,
    popModels,
    pickImage,
    compressImage,
  };
})();

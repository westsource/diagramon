/* AI 右栏：对话生成 / 识图 / 改图 三 tab。
 *
 * - 请求走 ai_chat，接受结果走事件 ai://delta / ai://done / ai://failed；
 *   mock 后端在同一条事件通道上假流式，界面无需区分。
 * - 模型来自两处合并（`state.modelChoices()`）：登录云网关后的**服务端别名**，
 *   以及「AI 设置」里的本地 BYOK 模型。两处分开分组显示，没有可用模型时给明确引导，
 *   不假装能用。
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

  /** 一条消息 = 微信式的「头像 + 气泡」：用户在右（绿气泡），AI 在左（白气泡）。
   *
   *  结构上多包了一层 `.msg-body`：头像要跟"这一条的全部内容"（气泡、附件缩略图、
   *  代码卡、思考块）整体对齐，气泡本身还得是让宽度跟着文字走的那个 flex 项 ——
   *  直接把头像塞进气泡行，代码卡就会被压成气泡那么窄，而 AI 的正文就是代码。
   */
  function bubbleNode(m) {
    const roleCls = m.role === "user" ? "user" : m.role === "sys" ? "sys" : m.err ? "err" : "bot";
    const n = h("div", "msg " + roleCls);
    if (m.role === "sys") {
      n.innerHTML = `<div class="bubble">${icon("info", "ico-sm")} ${esc(m.text)}</div>`;
      return n;
    }
    const mine = m.role === "user";
    const ava = h("div", "ava" + (mine ? " me" : ""));
    ava.innerHTML = icon(mine ? "user" : "robot", "ico-sm");
    const body = h("div", "msg-body");
    body.innerHTML =
      `<div class="msg-head"><span class="who">${esc(t(mine ? "ai.you" : "ai.assistant"))}</span>` +
      (!mine && m.used ? `<span class="badge-used">${esc(m.used.model)} · ${esc(m.used.tokens)} tok</span>` : "") +
      `</div>`;
    n.append(ava, body);
    if (m.image) {
      const th = h("div", "thumb");
      th.innerHTML =
        `<span class="pic">${m.image.dataUrl ? `<img src="${m.image.dataUrl}" alt="">` : icon("image", "ico-lg")}</span>` +
        `<span class="meta"><b>${esc(m.image.name)}</b><span>${esc(m.image.meta || "")}</span></span>`;
      body.appendChild(th);
    }

    // 思考块：思考型模型（GLM/DeepSeek/Qwen）在正文之前会连推几十上百帧 reasoning —
    // 没有这一块，用户就只能对着空气等（2026-10-14 的 bug：token 记了 2000+，一个字没显示）。
    // 流式期间摆思考原文（看得到在干活）；结束后缩成一行摘要；**没有正文**时原文留着给人读。
    const thinking = (m.thinking || "").trim();
    const hasText = !!(m.text || "").trim();
    if (m.role !== "user" && (thinking || m.streaming)) {
      const line = h("div", "think");
      line.dataset.req = m.req || "";
      line.innerHTML = thinking
        ? `${icon("sparkles", "ico-sm")}<span>${esc(t("ai.think.live", { n: thinking.length }))}</span>`
        : `${icon("refresh", "ico-sm")}<span>${esc(t("ai.waiting"))}</span>`;
      body.appendChild(line);
      if (thinking && (m.streaming || !hasText)) {
        const tb = h("div", "think-body");
        tb.dataset.req = m.req || "";
        tb.innerHTML = esc(thinking.length > 800 ? "…" + thinking.slice(-800) : thinking).replace(/\n/g, "<br>");
        body.appendChild(tb);
      }
    }

    const parsed = splitFences(m.text || "");
    if (parsed.text) {
      const b = h("div", "bubble" + (m.streaming ? " streaming" : ""), esc(parsed.text).replace(/\n/g, "<br>"));
      b.dataset.req = m.req || "";
      body.appendChild(b);
    } else if (m.streaming) {
      const b = h("div", "bubble streaming");
      b.dataset.req = m.req || "";
      body.appendChild(b);
    }

    // 没有正文的收尾必须说清为什么，别留一个空气泡（token 是真花了）
    if (m.notice) {
      const w = h("div", "bubble notice", esc(m.notice));
      body.appendChild(w);
    }

    for (const blk of parsed.blocks) {
      body.appendChild(codeCard(blk, m));
    }
    if (m.applied) {
      const done = h("span", "applied-tag", `${icon("check", "ico-sm")}${esc(t("ai.applied"))}`);
      body.appendChild(done);
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

  /** 「一个可用的模型都没有」时的引导。
   *
   *  **必须分登录/未登录两种说法**：它决定了用户下一步该做什么。原来只有一句
   *  "这个版本不内置任何默认模型"，在云网关接好之后就成了半句假话 —— 已登录用户
   *  照着它去「AI 设置」填 base URL，而其实他只需要重新登录/开通权益。
   */
  function noModelsNode() {
    const signedIn = state.cloud.status.signed_in;
    const box = h("div", "ai-empty");
    box.innerHTML =
      `<div><div class="hero">${icon(signedIn ? "key" : "cloud", "ico-lg")}</div>` +
      `<h3>${esc(t("ai.noModels.title"))}</h3>` +
      `<p>${esc(signedIn ? t("ai.noModels.descSignedIn") : t("ai.noModels.descSignedOut"))}</p>` +
      `<div class="acts"><button class="btn ai block" data-a="${signedIn ? "go" : "login"}">` +
      `${icon(signedIn ? "settings" : "cloud")}${esc(signedIn ? t("ai.noModels.cta") : t("ai.noModels.ctaLogin"))}</button></div></div>`;
    box.addEventListener("click", (e) => {
      const b = e.target.closest("button");
      if (!b) return;
      if (b.dataset.a === "login") return DGM.cloud.openLogin();
      DGM.dialogs.settings("ai");
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
    await attachDataUrl(picked.dataUrl, picked.name);
    DGM.toast({ icon: "image", title: t("ai.attached"), sub: t("ai.attachedDesc") });
  }

  /** 把一张图（dataURL）挂到识图输入上。截屏与选文件共用这一条路。 */
  async function attachDataUrl(dataUrl, name) {
    const out = await compressImage(dataUrl);
    if (!out) {
      DGM.toast({ icon: "alert", title: t("ai.attach"), sub: t("exp.rasterFail"), warn: true });
      return null;
    }
    state.ui.aiAttachment = {
      name: name || "image.png",
      dataUrl: out.dataUrl,
      meta: t("ai.vision.compress", { w: out.w, h: out.h }),
    };
    if (tab() !== "vision") state.ui.aiTab = "vision";
    render();
    return state.ui.aiAttachment;
  }

  /** 框选屏幕一块区域 → 直接进识图 tab（Rust 冻结帧 + overlay，见 vision.rs）。 */
  async function startCapture() {
    try {
      await ipc.invoke("vision_capture_start");
    } catch (e) {
      DGM.toast({ icon: "alert", title: t("ai.screenshot"), sub: String((e && e.message) || e), warn: true });
    }
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
    if (id) ipc.invoke("ai_cancel", { id }).catch(() => {});
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

  /**
   * 模型的**思考**增量（GLM/DeepSeek/Qwen 的 `reasoning_content`）。
   *
   * 这些帧以前被整包丢掉：思考型模型把整段推理逐帧推过来、正文最后才来，于是一整轮
   * "token 记了 2000+、界面上一个字都没有"（2026-10-14 用户报的 bug）。现在实时显示进度，
   * 让用户看得见"它在干活"，也看得见钱花在哪。
   */
  function onThinking(ev) {
    const m = findMsg(ev && ev.request_id);
    if (!m) return;
    const before = (m.thinking || "").length;
    m.thinking = (m.thinking || "") + (ev.delta || "");
    const txt = m.thinking.trim();
    const line = $(`#ai-stream .think[data-req="${ev.request_id}"] span`);
    if (!line) {
      // 这一轮的第一帧思考：整栏重排一次，把思考块挂上去（之后都走增量更新）
      if (m.m === tab()) render();
      return;
    }
    line.textContent = t("ai.think.live", { n: txt.length });
    const body = $(`#ai-stream .think-body[data-req="${ev.request_id}"]`);
    if (body) body.innerHTML = esc(txt.length > 800 ? "…" + txt.slice(-800) : txt).replace(/\n/g, "<br>");
    if (!before && m.m === tab()) render(); // 摘要行 + 原文块一起出现
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
    const reasoningTokens = ev.reasoning_tokens || 0;
    m.used = {
      model: ev.model || "",
      tokens: (ev.prompt_tokens || 0) + (ev.completion_tokens || 0),
      reasoning: reasoningTokens,
    };
    state.addUsage(ev);
    // **没有正文就必须说清为什么**，别留一个空气泡：token 是真花了。
    // 思考型模型把本轮预算全花在推理上时，正文可以一个字都没有（真机实测：整条流 104 帧
    // 全是 reasoning_content）；供应商漏报正文时也一样。
    if (!(m.text || "").trim()) {
      const chars = (m.thinking || "").trim().length;
      m.notice =
        chars > 0 || reasoningTokens > 0
          ? t("ai.noContent.thinking", { tokens: reasoningTokens || m.used.tokens, chars })
          : t("ai.noContent", { tokens: m.used.tokens });
    }
    // 面板收起、或回复落在**别的页签**里（用户正看着当前页签）——两种情况都要给未读角标，
    // 否则就是"花了钱、界面上什么都没有"。
    if (!state.panels().ai || m.m !== tab()) unreadCount += 1;
    state.pushOutput(
      t("ai.used", { model: m.used.model, tokens: m.used.tokens, credits: "—" }) +
        (reasoningTokens ? " · " + t("ai.used.thinking", { n: reasoningTokens }) : ""),
      "ok",
    );
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

  /** 合并模型 → **分组菜单项**（两个选择器共用同一套分组规则）。
   *
   *  为什么分组而不是混一列：两组的"凭据从哪来"完全不同 —— 网关用的是当前登录令牌
   *  （用户没填过任何东西），本地那组是用户自己填的密钥。混着排会让人以为
   *  网关模型也要去 AI 设置里填个 key。
   *
   *  每项的动作字段由调用方给（面板下拉用 `id`、菜单栏用 `act`），所以传一个 `toItem`。
   *  `DGM.pop.show` 已经支持 `label2` 作分组小标题（不可点），这里直接用它。
   */
  function groupModelItems(toItem) {
    const all = state.modelChoices();
    const groups = [
      ["gateway", t("ai.group.gateway")],
      ["local", t("ai.group.local")],
    ];
    const out = [];
    for (const [key, title] of groups) {
      const list = all.filter((m) => (m.group === "gateway" ? "gateway" : "local") === key);
      if (!list.length) continue;
      out.push({ label2: title });
      list.forEach((m) => out.push(toItem(m)));
    }
    return out;
  }

  function popModels(anchor) {
    const all = state.modelChoices();
    const a = anchor || $("#ai-model");
    const r = a ? a.getBoundingClientRect() : { left: innerWidth - 320, bottom: 60 };
    if (!all.length) {
      DGM.pop.show([{ label: t("ai.model.settings"), icon: "settings", act: "settings" }], { x: r.left, y: r.bottom + 4 }, () => {
        DGM.pop.hide();
        DGM.dialogs.settings("ai");
      });
      return;
    }
    const cur = state.ai().default_model;
    const items = groupModelItems((m) => ({
      label: m.name + (m.has_key ? "" : `  (${t("ai.model.none")})`),
      icon: "robot",
      check: true,
      on: m.id === cur,
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
    if (shot) shot.addEventListener("click", startCapture);
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
    // stopPropagation 不能省：见 shell.js::showPop 的约定 ——
    // 否则文档级"点外面就关"会在同一次点击里把它刚弹出的下拉关掉（点了没反应）。
    if (model)
      model.addEventListener("click", (e) => {
        e.stopPropagation();
        popModels(e.currentTarget);
      });
    const hist = $("#ai-history");
    if (hist) hist.addEventListener("click", () => DGM.dialogs.history());
    const clr = $("#ai-clear");
    if (clr) clr.addEventListener("click", clear);
    const close = $("#ai-close");
    if (close) close.addEventListener("click", () => DGM.shell.togglePanel("ai"));

    ipc.on("ai://delta", onDelta);
    ipc.on("ai://thinking", onThinking);
    ipc.on("ai://done", onDone);
    ipc.on("ai://failed", onFailed);
    // 截屏框选完成（Rust 发来 dataURL；取消时是 null）
    ipc.on("vision://picked", (dataUrl) => {
      if (!dataUrl) return;
      attachDataUrl(dataUrl, "screen.png").then(() => {
        DGM.toast({ icon: "scan", title: t("ai.attached"), sub: t("ai.attachedDesc") });
      });
    });
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
    modelItems: groupModelItems,
    pickImage,
    compressImage,
  };
})();

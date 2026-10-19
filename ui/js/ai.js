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

  /** 流**不是正常收尾**时的提示文案（值的真源：Rust 侧 `ai::Finish::as_str`）。
   *
   *  三种已知值都意味着"上面那段正文是不完整的"，而旧界面在这种时候一声不吭 ——
   *  2026-10-18 线上实录就是这么发生的（正文被 `finish_reason=length` 切在半句上，
   *  用户只看到一个 token 徽标，原话"没有任何提示"）。
   *  表里没有的值（含 `stop` / `other` / 空串）一律不提示：提示要有据可依。
   */
  const CUT_NOTICE = {
    length: "ai.cut.length",
    interrupted: "ai.cut.interrupted",
    missing: "ai.cut.missing",
  };

  /** 对话**按文档**分开：会话就是按文档身份持久化的（`conversations/`）。
   *
   *  曾经只有一份 `msgs`、三个页签共用 —— 那样切文档会把上一份的对话带过来，
   *  与"会话按文档持久化"直接矛盾。结构：`docId -> { chat, vision, review }`。
   *
   *  未保存文档**也有桶**（用 docId 作键），只是它落不了盘（Rust 侧按"没有稳定身份"
   *  直接拒绝）。界面上那句"本文档尚未保存，对话只在本次运行内有效"是如实说法。
   */
  const msgsByDoc = new Map();

  function bucket(docId) {
    const key = docId || "__none__";
    let b = msgsByDoc.get(key);
    if (!b) {
      b = { chat: [], vision: [], review: [] };
      msgsByDoc.set(key, b);
    }
    return b;
  }

  /** 当前文档某个页签的消息数组（省略 `which` 即当前页签）。 */
  function msgs(which) {
    const d = state.activeDoc();
    return bucket(d && d.id)[which || tab()];
  }

  /** 已经尝试过从磁盘读会话的文档 —— 每份只读一次，别在每次渲染里重读。 */
  const convLoaded = new Set();
  let unreadCount = 0;
  let selectionCtx = null; // 来自「让 AI 改这段」的选区
  let bound = false;

  function tab() {
    return state.ui.aiTab || "chat";
  }

  /** 待确认的记忆候选条。
   *
   *  为什么必须有这一条：自动提取的候选**不注入 prompt**，如果界面上完全看不见，
   *  用户永远不知道 AI 提议记了什么，"确认"这个动作也就无从发生 —— 那这套机制
   *  等于白做（而且用户会以为 AI 什么都没记住）。
   */
  function renderMemoryBar() {
    const bar = $("#ai-memory-bar");
    if (!bar) return;
    const items = (state.memory && state.memory.items) || [];
    const pending = items.filter((e) => e.state === "pending" && e.enabled !== false).length;
    if (!pending || !state.ai().memory_enabled) {
      bar.hidden = true;
      bar.innerHTML = "";
      return;
    }
    bar.hidden = false;
    bar.innerHTML =
      `${icon("sparkles", "ico-sm")}<span>${esc(t("ai.memory.pending", { n: pending }))}</span>` +
      `<span class="sp"></span><span>${esc(t("ai.memory.review"))}</span>`;
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
    if (lang === "d2") return "d2";
    if (lang === "xml") return "drawio";
    if (lang === "json") return "excalidraw";
    return "mermaid";
  }

  /* ------------------------------------------------------------------ 思考块（可折叠） */

  /** 思考原文的展示片段。
   *
   *  流式期间**只留尾部**：每一帧都要重写这一整块，而用户关心的是"现在想到哪"，
   *  留尾部就不必反复重排几万个字符。收尾后文本不再增长 —— 那时给**完整原文**：
   *  折叠的意义就是"想读的时候读得到"，只给尾部等于没给。
   */
  function thinkHtml(text, streaming) {
    const shown = streaming && text.length > 800 ? "…" + text.slice(-800) : text;
    return esc(shown).replace(/\n/g, "<br>");
  }

  /** 思考块是否展开。三处状态按优先级合起来决定：
   *  1. 用户点过（`thinkTouched`）—— 他说了算，之后的自动行为都不再改他的选择；
   *  2. 流式期间 —— 展开：正文最后才来，这段推理是"它在干活"的唯一证据；
   *  3. 收尾之后 —— 有正文就收起（要读的是正文），**没有正文就留着**：那一轮推理是
   *     唯一的产出（见 `ai.noContent.thinking`）。
   */
  function thinkOpen(m, hasText) {
    if (m.thinkTouched) return m.thinkOpen !== false;
    return m.streaming ? true : !hasText;
  }

  /** 思考块 = 一行摘要（可点、可键盘操作的折叠开关）+ 原文块。
   *
   *  原文块**始终留在 DOM 里**、收尾只是把它收起来：以前有正文的那一轮收尾会把原文
   *  整个丢掉，用户事后永远读不到推理过程（那是花了 token 换来的）。展开状态挂在消息上
   *  （`m.thinkTouched` / `m.thinkOpen`），所以整栏重排、切页签、切文档回来都还在。
   *  切换**就地改 DOM、不整栏重排** —— 重排会把长对话滚到底，用户刚点开的那块就跑掉了。
   */
  function thinkNodes(m, thinking) {
    if (!thinking) {
      // 一帧还没到：只有一行"正在等待模型…"，没有可折叠的东西
      const wait = h("div", "think");
      wait.dataset.req = m.req || "";
      wait.innerHTML = `${icon("refresh", "ico-sm")}<span>${esc(t("ai.waiting"))}</span>`;
      return [wait];
    }
    const open = thinkOpen(m, !!(m.text || "").trim());
    const line = h("div", "think");
    line.dataset.req = m.req || "";
    line.setAttribute("role", "button");
    line.tabIndex = 0;
    line.setAttribute("aria-expanded", open ? "true" : "false");
    line.title = t(open ? "ai.think.collapse" : "ai.think.expand");
    line.innerHTML =
      `${icon("chevD", "ico-sm chev")}${icon("sparkles", "ico-sm")}` +
      `<span>${esc(t(m.streaming ? "ai.think.live" : "ai.think.done", { n: thinking.length }))}</span>`;
    const tb = h("div", "think-body");
    tb.dataset.req = m.req || "";
    tb.innerHTML = thinkHtml(thinking, m.streaming);
    tb.hidden = !open;
    const flip = (e) => {
      if (e) {
        e.preventDefault();
        e.stopPropagation();
      }
      const next = line.getAttribute("aria-expanded") !== "true";
      m.thinkTouched = true; // 之后 render() / ai://done 不再自动改
      m.thinkOpen = next;
      line.setAttribute("aria-expanded", next ? "true" : "false");
      line.title = t(next ? "ai.think.collapse" : "ai.think.expand");
      tb.hidden = !next;
    };
    line.addEventListener("click", flip);
    line.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") flip(e);
    });
    return [line, tb];
  }

  /* ------------------------------------------------------------------ 渲染 */

  /** 一条消息 = 微信式的「头像 + 气泡」：用户在右（绿气泡），AI 在左（白气泡）。
   *
   *  结构上多包了一层 `.msg-body`：头像要跟"这一条的全部内容"（气泡、附件缩略图、
   *  代码卡、思考块）整体对齐，气泡本身还得是让宽度跟着文字走的那个 flex 项 ——
   *  直接把头像塞进气泡行，代码卡就会被压成气泡那么窄，而 AI 的正文就是代码。
   */
  function msgList(m) {
    const docId = m.doc || (state.activeDoc() || {}).id || "";
    return bucket(docId)[m.m || tab()];
  }

  function turnsBefore(list, upto) {
    const out = [];
    for (const x of list.slice(0, upto)) {
      if (x.role !== "user" && x.role !== "assistant") continue;
      if (x.err) continue;
      const text = (x.text || "").trim();
      if (text) out.push({ role: x.role, text });
    }
    return out;
  }

  function baseReq(intent, prompt, format, history, scene) {
    return {
      request_id: newId(),
      model_id: state.currentModel() ? state.currentModel().id : "",
      intent,
      prompt,
      format,
      context: null,
      files: ctxFiles().map((f) => ({ path: f.path, name: f.name, text: f.text, truncated: !!f.truncated })),
      image_data_url: null,
      history,
      scene: scene || "",
    };
  }

  /** 单条消息操作：重新生成 / 编辑重发 / 删除 / 派生（新标签页）。 */
  async function messageMenu(m, rect) {
    const list = msgList(m);
    const i = list.findIndex((x) => x.id === m.id);
    if (i < 0) return;
    const items = [];
    if (m.role === "assistant") items.push({ label: t("ai.op.regen"), v: "regen" });
    if (m.role === "user") items.push({ label: t("ai.op.edit"), v: "edit" });
    items.push({ label: t("ai.op.branch"), v: "branch" });
    items.push({ sep: true }, { label: t("ai.op.delete"), v: "del" });
    DGM.pop.show(items, { x: rect.left, y: rect.bottom + 4 }, async (it) => {
      DGM.pop.hide();
      const d = state.doc(m.doc) || state.activeDoc();
      const fmt = m.format || (d && d.format) || "mermaid";
      const history = turnsBefore(list, i);
      if (it.v === "del") {
        // 删用户消息时连同紧随其后的助手回复一起删（否则留下一条无主回复）
        const take = m.role === "user" && list[i + 1] && list[i + 1].role === "assistant" ? 2 : 1;
        list.splice(i, take);
        render();
        persistConversation(m.doc);
        return;
      }
      if (it.v === "regen" || it.v === "edit") {
        let prompt = m.role === "user" ? m.text : "";
        let histEnd = i;
        let userMsg = { id: newId(), role: "user", text: m.text || "" };
        if (it.v === "edit") {
          const v = await DGM.dialogs.input({
            title: t("ai.op.edit"),
            icon: "wand",
            value: prompt,
            label: t("ai.op.editLabel"),
          });
          if (!v) return;
          prompt = v;
          userMsg.text = v;
        } else {
          // 重新生成：保留前面的用户消息，只删这条回复及其之后的内容
          let j = i - 1;
          while (j >= 0 && list[j].role !== "user") j -= 1;
          if (j < 0) return;
          prompt = list[j].text;
          histEnd = j;
          userMsg = null;
        }
        const history = turnsBefore(list, histEnd);
        list.splice(i);
        const intent = m.m === "review" ? "review" : "generate";
        const context = d && state.isTextDoc(d) && fmt === d.format ? d.body : null;
        const req = baseReq(intent, prompt, fmt, history, "regenerate");
        req.context = context;
        dispatch(req, m.m || tab(), userMsg, m.doc, m.landing || "editor");
        persistConversation(m.doc);
        return;
      }
      if (it.v === "branch") {
        if (!d) return;
        const created = await state.newDoc(d.format);
        if (!created) return;
        await state.setBodyNow(created.id, d.body);
        const copy = list.slice(0, i + 1).map((x) => Object.assign({}, x, { doc: created.id }));
        bucket(created.id)[m.m || tab()] = copy;
        await persistConversation(created.id);
        await state.activateDoc(created.id);
        if (DGM.editor && DGM.editor.loadActive) DGM.editor.loadActive();
        DGM.toast({ icon: "plus", title: t("ai.op.branch"), sub: created.name });
      }
    });
  }

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
      (!m.streaming ? `<button class="mini-btn msg-ops" data-msg="${esc(m.id || "")}" title="${esc(t("ai.ops"))}">${icon("more", "ico-sm")}</button>` : "") +
      `</div>`;
    n.append(ava, body);
    n.addEventListener("click", (e) => {
      const b = e.target.closest("[data-msg]");
      if (!b) return;
      const r = b.getBoundingClientRect();
      messageMenu(m, r);
    });
    if (m.image) {
      const th = h("div", "thumb");
      th.innerHTML =
        `<span class="pic">${m.image.dataUrl ? `<img src="${esc(m.image.dataUrl)}" alt="">` : icon("image", "ico-lg")}</span>` +
        `<span class="meta"><b>${esc(m.image.name)}</b><span>${esc(m.image.meta || "")}</span></span>`;
      body.appendChild(th);
    }

    // 思考块（可折叠，见 thinkNodes）：思考型模型（GLM/DeepSeek/Qwen）在正文之前会连推
    // 几十上百帧 reasoning — 没有这一块，用户就只能对着空气等（2026-10-14 的 bug：
    // token 记了 2000+，一个字没显示）。
    const thinking = (m.thinking || "").trim();
    if (m.role !== "user" && (thinking || m.streaming)) {
      body.append(...thinkNodes(m, thinking));
    }

    // 工具活动行：每一条就是一次真实的工具执行。失败的也要如实显示 ——
    // 模型会拿到同样的失败并自己纠正，界面不该替它遮掩。
    for (const s of m.steps || []) {
      const line = h("div", "agent-step" + (s.ok ? "" : " bad"));
      line.innerHTML =
        `${icon(s.ok ? "bolt" : "alert", "ico-sm")}<b>${esc(s.tool)}</b><span>${esc(s.summary)}</span>`;
      body.appendChild(line);
    }

    // 解释意图**不产代码**：即便模型不听话塞了围栏，也不渲染代码卡/应用按钮。
    const parsed = m.intent === "explain" ? { text: m.text || "", blocks: [] } : splitFences(m.text || "");
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

  /** 哪种格式的产物能落到哪个画布格式（读 `FormatInfo.ai_via`，不另立表）。 */
  function canvasTargetFor(fmt) {
    const list = state.formatList.filter((f) => (f.ai_via || []).includes(fmt));
    return list.find((f) => f.id === "drawio") || list[0] || null;
  }

  /** 把一段 AI 产物转成画布（复用 `dialogs.runConvert`，不复制转换逻辑）。 */
  async function applyAsCanvas(blk, m) {
    const fmt = langToFormat(blk.lang);
    const target = canvasTargetFor(fmt);
    if (!target) {
      DGM.toast({ icon: "info", title: t("ai.toCanvas.failed", { reason: t("ai.toCanvas.noTarget", { fmt }) }), warn: true });
      return;
    }
    const dir = DGM.directionFor ? DGM.directionFor(fmt, target.id) : null;
    if (!dir) {
      DGM.toast({ icon: "alert", title: t("ai.toCanvas.failed", { reason: `${fmt} → ${target.id}` }), warn: true });
      return;
    }
    const d = state.activeDoc();
    // 合成的“源文档”：转换器只需要 format/body/name/layout/look
    const src = {
      id: "ai-artifact",
      name: t("ai.artifactName", { fmt: state.fmtById(fmt).name }),
      format: fmt,
      body: blk.code,
      layout: d && d.layout,
      look: d && d.look,
    };
    m.converting = true;
    m.convertError = "";
    render();
    let res = null;
    try {
      res = await DGM.dialogs.runConvert(src, dir, null, {
        layout: (d && d.layout) || null,
        look: (d && d.look) || null,
        theme: document.documentElement.dataset.theme || null,
        // AI 落地要稳定 id（后续元素级操作能回指）；手动转换保持默认关
        normalize: true,
        cluster_as_container: true,
      });
    } catch (e) {
      res = { ok: false, error: (e && e.message) || String(e) };
    }
    m.converting = false;
    if (res && res.ok) {
      m.landed = (res.doc && res.doc.name) || true;
      m.convertTried = false;
      DGM.toast({ icon: "check", title: t("ai.toCanvas.done"), sub: m.landed === true ? "" : m.landed });
    } else {
      m.convertError = (res && res.error) || t("ai.toCanvas.failed", { reason: "" });
    }
    render();
  }

  /** 转换失败后的“让 AI 修一次”：**每块产物只允许一次**（防死循环与烧钱）。 */
  function fixConvert(blk, m) {
    if (m.convertTried) return;
    m.convertTried = true;
    const fmt = langToFormat(blk.lang);
    const d = state.activeDoc();
    const req = {
      request_id: newId(),
      model_id: state.currentModel() ? state.currentModel().id : "",
      intent: "review",
      prompt: t("ai.fixConvert.prompt", { err: m.convertError || "" }),
      format: fmt,
      context: blk.code,
      files: ctxFiles().map((f) => ({ path: f.path, name: f.name, text: f.text, truncated: !!f.truncated })),
      image_data_url: null,
      history: historyFor(tab(), d && d.id),
      // 场景口径：服务端按它归因（`convert.retry` 是一次真实计费的修复调用）
      scene: "convert.retry",
    };
    dispatch(req, tab(), { id: newId(), role: "sys", text: t("ai.fixConvert.sys") }, undefined, "editor");
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
    const target = canvasTargetFor(fmt);
    if (target && m.intent !== "explain") {
      const toCanvas = h(
        "button",
        "btn sm" + (m.landed ? " ghost" : " ai"),
        m.converting
          ? `${icon("swap")}${esc(t("ai.toCanvas.busy"))}`
          : m.landed
            ? `${icon("check")}${esc(t("ai.toCanvas.landed"))}`
            : `${icon("swap")}${esc(t("ai.toCanvas"))}`,
      );
      toCanvas.disabled = !!m.converting || !!m.landed;
      toCanvas.addEventListener("click", () => applyAsCanvas(blk, m));
      acts.append(toCanvas);
    }
    card.appendChild(acts);
    if (m.convertError) {
      const err = h("div", "code-card-err");
      err.innerHTML = `${icon("alert", "ico-sm")}<span>${esc(m.convertError)}</span>`;
      card.appendChild(err);
      const fix = h("button", "btn sm ghost", `${icon("sparkles")}${esc(t("ai.fixConvert"))}`);
      fix.disabled = !!m.convertTried;
      fix.addEventListener("click", () => fixConvert(blk, m));
      card.appendChild(fix);
    }
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
      else if (b.dataset.a === "ctx") explainCurrent();
      else input().focus();
    });
    return box;
  }

  /** 空态「解释当前这张图」：真的发一轮 **explain** 请求。
   *
   *  以前这个按钮只是切到「改图」页签，点下去什么都不发生 —— 按钮写着“解释”，
   *  行为却是“换个输入框”。解释意图单独存在：只出自然语言，不出代码卡、不出 apply。
   */
  function explainCurrent() {
    const d = state.activeDoc();
    if (!d || !state.isTextDoc(d)) {
      DGM.toast({ icon: "info", title: t("ai.explain.empty"), sub: "" });
      return;
    }
    focus("chat");
    const prompt = t("ai.explain.prompt");
    const req = {
      request_id: newId(),
      model_id: state.currentModel() ? state.currentModel().id : "",
      intent: "explain",
      prompt,
      format: d.format,
      context: d.body || null,
      files: ctxFiles().map((f) => ({ path: f.path, name: f.name, text: f.text, truncated: !!f.truncated })),
      image_data_url: null,
      history: historyFor("chat", d.id),
    };
    if (ta) ta.value = "";
    dispatch(req, "chat", { id: newId(), role: "user", text: prompt });
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

  /** 「产物 / 落点」段控：按文档记忆（`state.ui.aiDeliver[docId]`）。 */
  const ARTIFACTS = [
    ["mermaid", "Mermaid"],
    ["dot", "DOT"],
    ["d2", "D2"],
  ];

  function deliverOf(d) {
    if (!state.ui.aiDeliver) state.ui.aiDeliver = {};
    const key = (d && d.id) || "_";
    const saved = state.ui.aiDeliver[key] || {};
    const fallback = d && ARTIFACTS.some(([id]) => id === d.format) ? d.format : "mermaid";
    return { artifact: saved.artifact || fallback, landing: saved.landing || "editor" };
  }

  function setDeliver(key, value) {
    const d = state.activeDoc();
    if (!state.ui.aiDeliver) state.ui.aiDeliver = {};
    const id = (d && d.id) || "_";
    state.ui.aiDeliver[id] = Object.assign({}, deliverOf(d), { [key]: value });
    render();
  }

  function renderDeliver() {
    const box = $("#ai-deliver");
    if (!box) return;
    const d = state.activeDoc();
    if (!d) {
      box.hidden = true;
      return;
    }
    box.hidden = false;
    const cur = deliverOf(d);
    const seg = (kind, items) =>
      `<div class="seg" data-kind="${kind}">` +
      items
        .map(
          ([id, label]) =>
            `<button class="seg-btn${cur[kind] === id ? " on" : ""}" data-deliver="${kind}:${id}">${esc(label)}</button>`,
        )
        .join("") +
      `</div>`;
    box.innerHTML =
      `<span class="seg-lb">${esc(t("ai.artifact"))}</span>` +
      seg("artifact", ARTIFACTS) +
      `<span class="seg-lb">${esc(t("ai.landing"))}</span>` +
      seg("landing", [
        ["editor", t("ai.landing.editor")],
        ["canvas", t("ai.landing.canvas")],
      ]);
  }

  function deliverClick(e) {
    const b = e.target.closest("[data-deliver]");
    if (!b) return;
    const [kind, value] = b.dataset.deliver.split(":");
    setDeliver(kind, value);
  }

  function render() {
    const cur = tab();
    state.ui.aiTab = cur;
    const stream = $("#ai-stream");
    if (!stream) return;

    $$("#ai-tabs .ai-tab").forEach((b) => b.classList.toggle("on", b.dataset.ai === cur));
    renderMemoryBar();
    renderDeliver();

    stream.innerHTML = "";
    if (!state.hasModels()) {
      stream.appendChild(noModelsNode());
    } else if (!msgs(cur).length) {
      stream.appendChild(emptyNode());
    } else {
      msgs(cur).forEach((m) => stream.appendChild(bubbleNode(m)));
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
    // 上下文预算：上限由 Rust 的 `AiLimits` 推下来（前端不另写 8 / 6000）
    const budget = $("#ai-budget");
    if (budget) {
      const lim = (state.appInfo && state.appInfo.ai_limits) || { history_turns: 8, history_chars: 6000 };
      const hist = historyFor(cur, d && d.id);
      const chars = hist.reduce((n, turn) => n + (turn.text || "").length, 0);
      const capped = hist.length > lim.history_turns || chars > lim.history_chars;
      budget.textContent = t("ai.budget", { turns: hist.length, chars, max: lim.history_chars });
      budget.classList.toggle("capped", capped);
      if (capped) budget.textContent += " · " + t("ai.budget.capped");
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
    btn.title = busy ? t("ai.stop") : t("common.send");
    btn.innerHTML = busy ? icon("stop", "ico-sm") : icon("send", "ico-sm");
    btn.classList.toggle("stop", busy);
  }

  /* ---------------------------------------------------------- 外部文件作为上下文 */

  /** 附加上限：8 份 / 每次请求（再多也只是把提示词预算吃光，见 ai::prompt::FILES_MAX_CHARS）。 */
  const MAX_CTX_FILES = 8;

  function ctxFiles() {
    if (!Array.isArray(state.ui.aiContextFiles)) state.ui.aiContextFiles = [];
    return state.ui.aiContextFiles;
  }

  /** 规范化用户给的路径：去空白、去成对引号（Windows"复制为路径"会带引号）、反斜杠转正斜杠。 */
  function normPath(p) {
    return String(p || "")
      .trim()
      .replace(/^"(.*)"$/, "$1")
      .replace(/\\/g, "/");
  }

  /**
   * 把一个**外部文件**读成上下文并挂上。拖拽、手填路径、选择文件三条入口都走这里。
   *
   * 读盘与判定全在 Rust（`file_read_text` → `app_core::context_file`：256 KiB 上限、
   * 二进制与编码校验）。这里只做去重、上限与提示 —— 失败一律出声，不静默吞。
   */
  async function addContextFile(path) {
    const p = normPath(path);
    if (!p) return false;
    const list = ctxFiles();
    if (list.some((f) => f.path.toLowerCase() === p.toLowerCase())) {
      DGM.toast({ icon: "file", title: t("ai.fileCtx"), sub: t("ai.fileDup") });
      return false;
    }
    if (list.length >= MAX_CTX_FILES) {
      DGM.toast({ icon: "alert", title: t("ai.fileCtx"), sub: t("ai.fileTooMany", { n: MAX_CTX_FILES }), warn: true });
      return false;
    }
    const prev = tab();
    try {
      const f = await ipc.invoke("file_read_text", { path: p });
      if (!f || !f.path) throw new Error(t("ai.fileFail"));
      list.push({ path: f.path, name: f.name, text: f.text, truncated: !!f.truncated });
    } catch (e) {
      DGM.toast({ icon: "alert", title: t("ai.fileCtx"), sub: (e && e.message) || String(e), warn: true });
      return false;
    }
    // 只更新 chips，不改用户正在看的 tab
    if (tab() === prev) render();
    const last = list[list.length - 1];
    DGM.toast({
      icon: "file",
      title: t("ai.fileAdded", { name: last.name }),
      sub: last.truncated ? t("ai.fileTruncated") : t("ai.fileChars", { n: last.text.length }),
    });
    return true;
  }

  function removeContextFile(path) {
    const p = normPath(path);
    state.ui.aiContextFiles = ctxFiles().filter((f) => f.path.toLowerCase() !== p.toLowerCase());
    render();
  }

  /** `.ai-pane` 是否被包含在（物理像素）坐标点里 —— 拖放事件给的是物理坐标。 */
  function insideAiPane(pos) {
    const pane = $("#ai-pane");
    if (!pane || pane.classList.contains("hidden-pane")) return false;
    if (!pos || typeof pos.x !== "number") return true; // 拿不到坐标就别拦（宁可多接一次）
    const r = pane.getBoundingClientRect();
    const s = window.devicePixelRatio || 1;
    const x = pos.x / s;
    const y = pos.y / s;
    return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
  }

  /**
   * 原生拖放落点（Tauri `tauri://drag-drop`）。
   *
   * 为什么不用 HTML5 的 drop：WebView2 下 Tauri 默认**接管**文件拖放，页面拿不到
   * `dataTransfer.files`；而原生事件里带的正是我们要的东西 —— **真实路径**
   * （附件按路径去重、按路径读盘、chip 上显示全路径）。
   *
   * 落在 AI 面板之外的一律不动：拖到画布上的手势不该被这里吞掉。
   */
  async function handleDrop(payload) {
    const type = String((payload && payload.type) || "drop");
    const inside = insideAiPane(payload && payload.position);
    // 拖到面板上方时高亮输入区（enter/over）；离开或落下就撤掉
    const pane = $("#ai-pane");
    if (pane) pane.classList.toggle("drag-over", inside && type !== "drop" && type !== "leave");
    if (type !== "drop") return false;
    const paths = (payload && payload.paths) || [];
    if (!paths.length || !inside) return false;
    let n = 0;
    for (const p of paths) {
      if (await addContextFile(p)) n += 1;
    }
    return n > 0;
  }

  /* ------------------------------------------------------------------ 附件 / 选区 */

  function renderAttachment() {
    const box = $("#ai-attachments");
    if (!box) return;
    box.innerHTML = "";
    const att = state.ui.aiAttachment;
    // 附加的外部文件（AI 上下文）：一行一个 chip，标题里给出**全路径**，
    // 截断过的如实标出来（别让用户以为模型看到了全文）。
    for (const f of ctxFiles()) {
      const chip = h("div", "ai-chip file");
      chip.title = f.path;
      chip.innerHTML =
        icon("file", "ico-sm") +
        `<span>${esc(f.name)}</span>` +
        `<span class="dim">${esc(f.truncated ? t("ai.fileTruncated") : t("ai.fileChars", { n: f.text.length }))}</span>`;
      const x = h("button", "icon-btn", icon("close", "ico-sm"));
      x.title = t("ai.removeImage");
      x.addEventListener("click", () => {
        removeContextFile(f.path);
      });
      chip.appendChild(x);
      box.appendChild(chip);
    }
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

  /** Ctrl+V 直接贴图进识图（WebView 的 paste 事件里 `items` 就是剪贴板图片）。 */
  function onPaste(e) {
    if (!state.panels().ai) return;
    const tgt = e.target;
    if (tgt && tgt.closest && (tgt.closest("#editor-col") || tgt.closest(".canvas-wrap"))) return;
    const items = (e.clipboardData && e.clipboardData.items) || [];
    for (const item of items) {
      if (!item.type || !item.type.startsWith("image/")) continue;
      const file = item.getAsFile();
      if (!file) continue;
      e.preventDefault();
      const reader = new FileReader();
      reader.onload = () => {
        attachDataUrl(reader.result, "pasted.png").then(() => {
          DGM.toast({ icon: "image", title: t("ai.attached"), sub: t("ai.attachedDesc") });
        });
      };
      reader.readAsDataURL(file);
      return;
    }
  }

  /** 「让 AI 修这一行」：请求体只含该行 ±N（结构上保证只改勾中的行要等 patch，见计划）。 */
  function fixLine(docId, line) {
    const d = state.doc(docId) || state.activeDoc();
    if (!d || !state.isTextDoc(d)) return;
    const lines = String(d.body || "").split("\n");
    const n = Math.max(1, Math.min(lines.length || 1, Number(line) || 1));
    const from = Math.max(0, n - 1 - 10);
    const to = Math.min(lines.length, n + 10);
    const snippet = lines.slice(from, to).join("\n");
    const req = baseReq(
      "review",
      t("ai.fixLine.prompt", { line: n }),
      d.format,
      historyFor(tab(), d.id),
      "review",
    );
    req.context = snippet;
    focus("review");
    dispatch(req, tab(), { id: newId(), role: "sys", text: t("ai.fixLine.sys", { line: n }) }, d.id, "editor");
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

  /** 取某个 tab 的**前序轮次**（不含本轮）。
   *
   *  只取文本，且只取 `user` / `assistant` 两种角色：
   *  - **图片不进历史**。它只在内存里、不落盘，也不该在每个后续请求里重复上行 ——
   *    否则一次识图会让之后每一轮都背上几百 KB 的 base64（服务端 body 上限会先炸）。
   *  - **`sys` 提示与错误气泡不进历史**：它们是界面上的旁白，不是对话内容。
   *
   *  轮数与体积的裁剪在 Rust 侧做（`crates/ai::fit_history`，带单测）—— 这里只如实交出，
   *  不各自猜一套策略；前端猜一份、Rust 再裁一次，两边迟早漂移。
   */
  function historyFor(cur, docId) {
    const out = [];
    // 归属优先：渲染回环那轮的对话可能不属于当前活动文档（用户中途切过标签页），
    // 这时 `msgs(cur)` 会拿错桶 —— 显式传 docId 的调用方都是知道归属的。
    const list = docId ? bucket(docId)[cur] : msgs(cur);
    for (const m of list || []) {
      if (m.role !== "user" && m.role !== "assistant") continue;
      if (m.err) continue;
      const text = (m.text || "").trim();
      if (!text) continue;
      out.push({ role: m.role, text });
    }
    return out;
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
    const deliver = deliverOf(d);
    // 改图必须产出当前文档的格式；其余两种页签服从「产物」段控。
    const fmtId = cur === "review" ? (d ? d.format : "mermaid") : deliver.artifact;
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

    // 上下文：改图用整篇正文；选择区优先；对话按设置决定。
    // 产物与当前文档格式不同时**不把这份正文当上下文**（提示词会误以为要改它）。
    const ai = state.ai();
    const sameFormat = !d || fmtId === d.format;
    let context = null;
    if (selectionCtx && sameFormat) context = selectionCtx;
    else if (cur === "review") context = d ? d.body : null;
    else if (cur === "chat" && ai.context_from_doc && d && state.isTextDoc(d) && sameFormat) context = d.body;

    const req = {
      request_id: newId(),
      model_id: state.currentModel() ? state.currentModel().id : "",
      intent: cur === "vision" ? "vision" : cur === "review" ? "review" : "generate",
      prompt: text,
      format: fmtId,
      context: context || null,
      // 附加的外部文件（参考资料）：与 context（当前图表源码）分开两个字段，
      // 提示词里措辞不同 —— 别让模型把参考文件当成要重写的正文。
      files: ctxFiles().map((f) => ({ path: f.path, name: f.name, text: f.text, truncated: !!f.truncated })),
      image_data_url: cur === "vision" && att ? att.dataUrl : null,
      // 前序轮次：**在本轮 push 进 msgs 之前取**，所以天然不含本轮（见 historyFor）
      history: historyFor(cur, d && d.id),
    };

    if (ta) ta.value = "";
    if (cur === "vision" && att) state.ui.aiAttachment = null;
    selectionCtx = null;

    await dispatch(
      req,
      cur,
      { id: newId(), role: "user", text, image: cur === "vision" && att ? att : null },
      undefined,
      deliver.landing,
    );
  }

  /** 把一个请求挂进某个 tab 并发出去：用户消息 + 占位气泡 + busy 标记 + 调 `ai_chat`。
   *
   *  `sendNow`（走输入框）与「渲染校验回环」（自动重试，不经过输入框）共用它 ——
   *  回环必须能自己造请求，否则用户得手动把报错粘进去，那就不叫自动修正了。
   *
   *  `docId`（可选）= 这轮对话**归属**的文档。发送时它就是活动文档；渲染回环要显式传
   *  （见 `retryCtx.convDoc`）—— 用户中途切了标签页的话，回复必须落回原来的桶，
   *  否则落盘时（S3：按归属落盘）会写错文档、丢这一轮。
   */
  async function dispatch(req, cur, userMsg, docId, landing) {
    const owner = docId || (state.activeDoc() || {}).id || "";
    // `at` 落在这条消息上：会话持久化要按它排跨页签的展示顺序，
    // 落盘时再取 `Date.now()` 会让所有历史轮次挤在同一毫秒上。
    if (userMsg) {
      userMsg.at = Date.now();
      userMsg.doc = owner;
      bucket(owner)[cur].push(userMsg);
    }
    const bot = {
      id: newId(),
      role: "assistant",
      text: "",
      streaming: true,
      req: req.request_id,
      m: cur,
      at: Date.now(),
      doc: owner,
      // 记下这一轮的**来源与模型 id**：记忆提取要用它们（`m.used.model` 是展示名，不是 id）
      prompt: (userMsg && userMsg.text) || "",
      modelId: req.model_id || "",
      intent: req.intent || "",
      landing: landing || "editor",
    };
    bucket(owner)[cur].push(bot);
    state.ui.aiBusy = true;
    state.ui.aiRequestId = req.request_id;
    render();

    // 受控工具循环：开关开着且**不是识图**时改走 `ai_agent_run`（非流式多步 +
    // 工具活动事件）。识图那一路永远直连 —— 工具是为"画对图"设计的，看图用不上。
    const cmd =
      state.settings && state.settings.ai && state.settings.ai.tools_enabled && cur !== "vision" && req.intent !== "explain"
        ? "ai_agent_run"
        : "ai_chat";

    try {
      await ipc.invoke(cmd, { req });
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

  /** 按请求 id 找消息。**要遍历所有文档的桶**：请求发出后用户可能已切到别的文档，
   *  而 `ai://delta` 依然按 request_id 送回 —— 只查当前文档会把这些增量整包丢掉
   *  （表现就是"切走再切回来，回复不见了"）。 */
  function findMsg(reqId) {
    for (const b of msgsByDoc.values()) {
      for (const k of Object.keys(b)) {
        const m = b[k].find((x) => x.req === reqId);
        if (m) return m;
      }
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
   * 工具循环里的一次工具执行（`ai://agent`）。
   *
   * 摘要行直接挂在气泡上（`m.steps`），随 `ai://done` 一起成为会话历史的一部分 ——
   * 工具活动是"这一轮 AI 做了什么"的事实，落盘时一并持久化（图片除外）。
   */
  function onAgent(ev) {
    const m = findMsg(ev && ev.request_id);
    if (!m) return;
    if (!m.steps) m.steps = [];
    m.steps.push({ tool: ev.tool || "", summary: ev.summary || "", ok: ev.ok !== false });
    // 工具活动低频（每轮最多几次），整栏重排的代价可以接受
    render();
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
    if (body) body.innerHTML = thinkHtml(txt, true);
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
    } else if (CUT_NOTICE[ev.finish]) {
      // 有正文、但这条流**不是正常收尾的**：必须说出来。
      //
      // 2026-10-18 线上实录（云网关 `mermaid-default`，member 档）：上游把 4096 的
      // completion 预算里 2866 花在思考，剩下 1230 token 的正文切在 `classDef … :#D`，
      // `finish_reason=length` 一路转发到客户端 —— 而界面只看正文空不空，于是用户
      // 看到的是一个「5906 tok」徽标和半张图，原话是"突然中断了，没有任何提示"。
      // 只对**已知值**动作：空串（工具循环那条非流式路径）什么都不提示。
      m.notice = t(CUT_NOTICE[ev.finish]);
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
    // 自动修正的那一轮：**直接把结果落回文档**，不再要求用户点一次「应用」——
    // 用户本来就只是想要一张能渲染出来的图。
    // 用 `m` 自己的代码块而不是 `applyLast()`：后者按「当前页签」找消息，
    // 用户中途切了页签就会把别处的回复落进来。
    if (retryCtx && retryCtx.reqId && ev.request_id === retryCtx.reqId) {
      const { blocks } = splitFences(m.text || "");
      if (blocks.length) applyBlock(blocks[0], m);
    }
    if (state.ui.aiSendThenApply) {
      state.ui.aiSendThenApply = false;
      applyLast();
    }
    // 落点 = 转成画布：一轮结束就自动落地一次（用户已经明确选了落点）。
    // 失败不自动重试；卡上会出现「让 AI 修」，那是**用户决定**的一次真实调用。
    if (m.landing === "canvas" && m.intent !== "explain" && !m.applied && !m.landed && !m.converting) {
      const { blocks } = splitFences(m.text || "");
      if (blocks.length) setTimeout(() => applyAsCanvas(blocks[0], m), 0);
    }
    // 一轮结束就落盘（不 await：落盘失败不该挡住界面）。
    // **按归属落盘**（S3）：这一轮属于哪个文档是发送时定下的（`m.doc`），
    // 不看"现在活动的是哪个文档" —— 用户中途切标签页的话，按活动文档写盘会丢这一轮。
    persistConversation(m && m.doc);
    maybeExtractMemory(ev, m);
  }

  /** 一轮对话结束后提取候选记忆。
   *
   *  三道判定：
   *  1. `memory_enabled` ∧ `memory_auto` —— 这是**额外一次真实计费**的调用，用户有权拒绝；
   *  2. **只在 `chat` 页签** —— 识图/改图是针对某一张图的一次性任务，从那里"学长期偏好"
   *     基本全是噪音；
   *  3. 自动修正（渲染回环）那一轮不参与 —— 它是机器造的批评与答，不是用户偏好。
   *
   *  提取本身在 Rust 侧做；失败一律静默：记忆是锦上添花，不该让用户以为对话出了问题。
   */
  function maybeExtractMemory(ev, m) {
    const ai = state.ai();
    if (!ai.memory_enabled || !ai.memory_auto) return;
    if (!m || m.m !== "chat") return;
    if (retryCtx && retryCtx.reqId && m.req === retryCtx.reqId) return;
    const prompt = (m.prompt || "").trim();
    const reply = (ev.text || m.text || "").trim();
    if (!prompt || !reply) return;
    const d = state.activeDoc();
    const modelId = m.modelId || (state.currentModel() ? state.currentModel().id : "");
    ipc
      .invoke("ai_memory_extract", { id: (m && m.doc) || (d ? d.id : ""), model_id: modelId, prompt, reply })
      .then(() => state.memoryRefresh())
      .catch(() => {});
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
    // 失败也要落盘：**用户那一轮是真实存在的**（`persistConversation` 会跳过错误气泡，
    // 所以不会把报错本身写进历史）。同样按归属（`m.doc`），不按活动文档。
    persistConversation(m && m.doc);
  }

  /**
   * 渲染校验回环：刚应用到文档的代码**渲染失败**时，把报错原文 + 行号回喂模型修正一次。
   *
   * 零件都是现成的（`preview.js` 本来就有"先 parse 再 render + 抠行号"、诊断面板也在收），
   * 之前缺的只是"把这条链路接起来"——设置里那个开关因此一直是个空开关：UI 上是开的，
   * 行为上什么都不做。
   *
   * 四道闸一个都不能少：
   *   1. 设置开关（第二次是**真实调用**，用户有权拒绝）；
   *   2. 只认本次刚应用的那份文档（见 `retryCtx`）；
   *   3. **只认 AI 刚落的这一版**（`sameBody(cur.body, ctx.code)`）—— 用户在这之后自己改过正文，
   *      那次失败就不是 AI 的改动引起的；
   *   4. 每轮最多一次（`tried`）——这是防死循环的唯一硬闸。
   */
  function onRenderError(ev) {
    const e = ev || {};
    const ctx = retryCtx;
    if (!ctx || ctx.tried) return;
    if (ctx.docId !== e.docId) return;
    if (!state.ai().render_retry) return;
    // ③ 正文已经不是 AI 落的那一版 ⇒ 这是**用户自己改出来的**渲染失败（或者别人改的），
    //    绝不能让 AI 主动去改用户正在写的东西。原先只看"布防状态"，于是：AI 落一版（布防）→
    //    用户接着手写成语法错 → 自动修正把用户的编辑整块覆盖掉（2026-10-19 用户报的就是这个）。
    //    布防不清，比较就够了：用户改回去（或者撤销回那一版）之后仍然算 AI 的版本。
    const cur = state.doc(ctx.docId);
    if (!cur || !sameBody(cur.body, ctx.code)) return;
    ctx.tried = true;

    const where = e.line ? t("ai.retry.line", { n: e.line }) : "";
    const req = {
      request_id: newId(),
      model_id: state.currentModel() ? state.currentModel().id : "",
      // 走 review：系统提示词对它已是"只做局部修改、不重写整张图"，正合修正语法的语义
      intent: "review",
      prompt: t("ai.retry.prompt", { where, err: e.raw || "" }),
      format: ctx.format,
      // 把刚应用的那版当上下文（就是它渲染失败了）
      context: ctx.code || null,
      // 自动修正那一轮同样带上附加文件：它是同一条对话的延续
      files: ctxFiles().map((f) => ({ path: f.path, name: f.name, text: f.text, truncated: !!f.truncated })),
      image_data_url: null,
      // 自动修正也是这条对话的延续，同样带上前序轮次
      history: historyFor(ctx.tab, ctx.convDoc),
    };
    ctx.reqId = req.request_id;
    // 在这一轮原本所在的 tab 里追加，用户看到的是"同一条对话里它自己修了一次"。
    // 归属也要带回原对话所在文档（S3）：中途切了标签页的话，这轮不能写进别的文档。
    dispatch(req, ctx.tab, { id: newId(), role: "sys", text: t("ai.retry.sys", { where }) }, ctx.convDoc);
  }

  /* ------------------------------------------------------------------ 应用 */

  /** 两版正文算不算"同一版"。只给"这一版还是不是我刚落的那一版"用：
   *  归一化行尾（CRLF）与**末尾空白**——编辑器与 Rust 的换行规整可能差一个尾换行，
   *  那不该让判断失真（否则自动修正会静默失效）。 */
  function sameBody(a, b) {
    const norm = (s) => String(s == null ? "" : s).replace(/\r\n/g, "\n").trimEnd();
    return norm(a) === norm(b);
  }

  let lastApplied = null; // {id, body}

  /** 「渲染校验回环」的布防状态。
   *
   *  `applyBlock` 每落一版就重新布防（刚进文档的这一版渲染失败就值得修正一次），
   *  但**重试自身产出的那一版不再布防** —— 否则"失败 → 重试 → 又失败"会无限循环，
   *  而每一轮都是**真实计费**的调用（设置项里也如实写着"会计入用量"）。
   *
   *  `docId` 只认本次刚应用的那份文档：用户在别的文档里手改出语法错，不该让 AI 去背锅。
   */
  let retryCtx = null; // { docId, format, code, tab, tried, reqId }

  async function applyBlock(blk, m) {
    const fmt = langToFormat(blk.lang);
    const fromId = (state.activeDoc() || {}).id || "";
    let d = state.activeDoc();
    if (!d || (state.isTextDoc(d) && d.format !== fmt && blk.lang)) {
      // 目标格式不一致或当前是画布型：另开一个对应格式的新标签页再落正文
      if (!d || state.isCanvasDoc(d) || d.format !== fmt) {
        const created = await state.newDoc(fmt);
        if (created) {
          // 会话过继（S2）：产物落进新标签页，这段对话就该跟着它走 —— 否则"从无到有"
          // 生成完，对话留在旧文档（多半还是未保存的），关掉就没了。
          // 必须在 loadActive() **之前**复制：切换后 render() 读的是新文档的桶。
          if (fromId && fromId !== created.id) adoptConversation(fromId, created.id);
          DGM.editor.loadActive();
          d = created;
        }
      }
    }
    if (!d) return;
    lastApplied = { id: d.id, body: d.body };
    await DGM.editor.applyBody(blk.code);
    if (m) m.applied = true;
    // 布防：这一版渲染失败就自动修正一次（开关见「AI 设置 → 渲染失败时…」）。
    const selfRetry = !!(m && retryCtx && retryCtx.reqId && m.req === retryCtx.reqId);
    if (!selfRetry) {
      retryCtx = {
        docId: d.id,
        format: fmt,
        code: blk.code,
        tab: m && m.m ? m.m : tab(),
        // 这轮对话归属的文档（S3）：修正轮要写回同一个桶，而不是"当时活动"的文档
        convDoc: (m && m.doc) || (d && d.id) || "",
        tried: false,
        reqId: null,
      };
    }
    render();
    DGM.toast({ icon: "check", title: t("ai.appliedToast"), sub: t("ai.appliedToastSub") });
  }

  async function applyLast() {
    const cur = tab();
    const list = msgs(cur);
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

  /* ------------------------------------------------------------------ 会话持久化 */

  /** 把该文档的会话从磁盘读进来（每份只读一次；`force` 时以磁盘为准重载）。
   *
   *  读失败（文件坏了、目录权限不对）**不该让面板起不来** —— 会话是锦上添花，
   *  不是 AI 能不能用的前提。所以这里吞掉异常，只丢了历史。
   *
   *  `force` 的用途是"以磁盘为准重新加载"：外部恢复过 `conversations/` 文件、
   *  或诊断需要时用。此时**替换**该文档的桶，而不是往后追加（追加会把同一轮显示两遍）。
   */
  async function ensureConversation(docId, force) {
    if (!docId) return;
    if (convLoaded.has(docId) && !force) return;
    convLoaded.add(docId);
    let conv = null;
    try {
      conv = await ipc.invoke("conversation_load", { id: docId });
    } catch (e) {
      return;
    }
    const turns = (conv && conv.turns) || [];
    if (!turns.length && !force) return;
    const b = force ? { chat: [], vision: [], review: [] } : bucket(docId);
    if (force) msgsByDoc.set(docId, b);
    for (const tn of turns) {
      const which = tn.tab === "vision" || tn.tab === "review" ? tn.tab : "chat";
      const assistant = tn.role === "assistant";
      b[which].push({
        id: newId(),
        role: assistant ? "assistant" : "user",
        text: tn.text || "",
        // 思考原文一起还原（3.5.3 起思考块可折叠，但推理以前只在内存里 —— 重启后
        // 那一轮连块都没有，"随时点开重读"就成了空话）。收不到就是空串（旧文件）。
        thinking: tn.thinking || "",
        at: tn.at || 0,
        // 还原 assistant 的用量徽标（没有模型名就不挂 used，别显示一个空徽标）
        used: assistant && tn.model ? { model: tn.model, tokens: tn.tokens | 0, reasoning: 0 } : undefined,
        restored: true,
      });
    }
    render();
  }

  /** 该轮的**落盘口径**：正文或思考原文有一项非空就值得存。
   *
   *  为什么把"只有思考、没有正文"的轮次也存上：那正是真机上最需要留档的一轮
   *  （思考型模型把整轮预算花在推理上，正文一个字都没有 —— 推理是唯一的产出，
   *  见 `ai.noContent.thinking`）。以前这种轮次整轮不落盘，重启后连"它想过什么"都没了。
   *  `persistConversation` 与 `turnsFor` 必须共用这一个判据：两处口径一旦分家，
   *  就会出现"对话框里的条数和落盘条数对不上"。
   */
  function turnKeep(m) {
    if (m.role !== "user" && m.role !== "assistant") return false;
    if (m.err) return false;
    return !!((m.text || "").trim() || (m.thinking || "").trim());
  }

  /** 把该文档的会话落盘。3.8.0 起未保存文档也有身份（草稿键），Rust 侧照常落盘；
   *  `false` 只表示**真写盘失败** —— 提示一次，不静默（以前这个 false 被整个忽略，
   *  用户以为存了，其实"未保存文档"这一类从来就没落过盘）。
   *
   *  `docId`（可选）= 这段会话归属的文档。不传则按活动文档（兼容旧调用）。
   *  按归属而不是按活动文档落盘（S3）：流式过程中用户切了标签页的话，
   *  按"当前活动"写盘会把这一轮写进别的文档、从原来的文档里丢掉。
   *
   *  只交**文本**：图片是 dataURL、只在内存，永不落盘（对外承诺的"图片不落盘"）；
   *  思考原文是文本，跟着一起存（见 `ConversationTurn::thinking`）。
   */
  let convSaveWarned = false;
  function warnSaveFailed() {
    if (convSaveWarned) return;
    convSaveWarned = true;
    DGM.toast({ icon: "alert", title: t("ai.convSaveFail"), sub: "", warn: true });
  }

  async function persistConversation(docId) {
    const d = docId ? state.doc(docId) : state.activeDoc();
    if (!d) return;
    const b = bucket(d.id);
    const turns = [];
    for (const which of ["chat", "vision", "review"]) {
      for (const m of b[which]) {
        if (!turnKeep(m)) continue;
        turns.push({
          role: m.role,
          text: (m.text || "").trim(),
          at: m.at || 0,
          model: m.role === "assistant" && m.used ? m.used.model || "" : "",
          tokens: m.role === "assistant" && m.used ? m.used.tokens | 0 : 0,
          tab: which,
          thinking: m.role === "assistant" ? (m.thinking || "").trim() : "",
        });
      }
    }
    try {
      const ok = await ipc.invoke("conversation_save", { id: d.id, turns });
      if (!ok) warnSaveFailed();
    } catch (e) {
      /* 存不上不该打断对话；下次落盘会再试 */
    }
  }

  /** 把 `fromId` 的会话**复制**给 `toId`（AI 应用产物另开标签页时调用，S2）。
   *
   *  为什么复制而不是移动：旧文档里那段提问仍然是它的上下文，历史不该凭空消失；
   *  文本很小，重复一份比"猜用户想去哪"安全。消息对象要逐个浅拷贝 ——
   *  两个桶共享同一批对象的话，之后任何一边的改动（比如 `applied` 标记）都会串场。
   *
   *  时机：必须在 `editor.loadActive()` **之前**调用 —— 切换后 `render()` 读的就是
   *  新文档的桶，先切后复制会闪一帧空对话。
   */
  function adoptConversation(fromId, toId) {
    const src = msgsByDoc.get(fromId);
    if (!src || !toId || fromId === toId) return;
    const copy = { chat: [], vision: [], review: [] };
    for (const k of Object.keys(copy)) copy[k] = src[k].map((x) => ({ ...x }));
    msgsByDoc.set(toId, copy);
    convLoaded.add(toId); // 已就绪：别让 ensureConversation 再拿磁盘上的空会话覆盖它
    persistConversation(toId);
  }

  /** 清空**当前文档**的会话（三个页签一起，与按钮文案"清空当前文档的对话"一致），
   *  并同步删掉磁盘上那份。 */
  async function clear() {
    const d = state.activeDoc();
    if (!d) return;
    msgsByDoc.set(d.id, { chat: [], vision: [], review: [] });
    render();
    DGM.toast({ icon: "trash", title: t("ai.clearToast"), sub: "" });
    try {
      await ipc.invoke("conversation_clear", { id: d.id });
    } catch (e) {
      /* 删不掉不影响本地已清空；下次落盘会重写一份空的 */
    }
  }

  /** 当前文档的轮次（**按时间序、跨页签**），供「历史会话」对话框渲染。
   *
   *  与 `persistConversation` 共用 `turnKeep` 判据（正文或思考原文有一项非空）——
   *  两处口径必须一样，否则会出现"对话框里的条数和落盘条数对不上"这种看着像 bug 的东西。
   */
  function turnsFor() {
    const d = state.activeDoc();
    if (!d) return [];
    const b = bucket(d.id);
    const out = [];
    for (const which of ["chat", "vision", "review"]) {
      for (const m of b[which]) {
        if (!turnKeep(m)) continue;
        out.push({
          role: m.role,
          text: (m.text || "").trim(),
          thinking: m.role === "assistant" ? (m.thinking || "").trim() : "",
          at: m.at || 0,
          tab: which,
          model: m.used ? m.used.model || "" : "",
        });
      }
    }
    out.sort((a, b2) => a.at - b2.at);
    return out;
  }

  function turnCount() {
    return turnsFor().length;
  }

  function unread() {
    return unreadCount;
  }

  /* ------------------------------------------------------------------ 绑定 */

  function bind() {
    if (bound) return;
    bound = true;

    // 首次绑定时当前文档可能已经打开了（`bind` 的调用时机晚于首次 `session:changed`），
    // 补一次读取 —— `ensureConversation` 自带去重，重复调用是安全的。
    const first = state.activeDoc();
    if (first) ensureConversation(first.id);
    // 记忆清单也要在启动时拉一次，否则第一条待确认提示要等到用户发一轮才出现
    state.memoryRefresh();

    $$("#ai-tabs .ai-tab").forEach((b) =>
      b.addEventListener("click", () => {
        state.ui.aiTab = b.dataset.ai;
        render();
        const ta = input();
        ta && ta.focus();
      }),
    );

    const deliver = $("#ai-deliver");
    if (deliver) deliver.addEventListener("click", deliverClick);
    document.addEventListener("paste", onPaste);

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
    /* 选文件加入上下文（也可以把文件直接拖进面板，见 handleDrop） */
    const fpick = $("#ai-file-pick");
    if (fpick)
      fpick.addEventListener("click", async () => {
        const picked = await ipc.dialog.pickPaths({ multiple: true });
        const list = Array.isArray(picked) ? picked : picked ? [picked] : [];
        for (const p of list) await addContextFile(p);
      });
    // 原生文件拖放（Tauri 事件；WebView2 下页面拿不到 dataTransfer.files）。
    // 返回 null = 这个环境没有原生拖放（mock / 老 API），界面照常可用，只是不能拖。
    state.ui.aiDragDrop = !!ipc.onDragDrop((payload) => handleDrop(payload));

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
    const mbar = $("#ai-memory-bar");
    if (mbar) mbar.addEventListener("click", () => DGM.dialogs.memory());
    const clr = $("#ai-clear");
    if (clr) clr.addEventListener("click", clear);
    const close = $("#ai-close");
    if (close) close.addEventListener("click", () => DGM.shell.togglePanel("ai"));

    ipc.on("ai://delta", onDelta);
    ipc.on("ai://thinking", onThinking);
    ipc.on("ai://agent", onAgent);
    ipc.on("ai://done", onDone);
    ipc.on("ai://failed", onFailed);
    // 只有用量、没有消息的一轮（记忆提取）：单独入账，否则这笔钱在用量页上看不见
    ipc.on("ai://usage", (ev) => {
      if (!ev) return;
      state.addUsage(Object.assign({}, ev, { usage_source: ev.reported ? "server" : "none" }));
    });
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
  // 云状态一变就重渲染：网关模型别名、以及「一个模型都没有」时的引导文案（未登录 →
  // 引导去登录，已登录 → 引导去 AI 设置）都取决于登录与否。少了这条，启动那一帧
  // （云状态还没回来）会把 AI 面板钉在"未登录 / 没有模型"上，之后再也不会自己变。
  DGM.bus.on("cloud:changed", render);
  // 渲染失败 → 自动修正一次（真正的判定在 `onRenderError` 里，这里只负责订阅）。
  DGM.bus.on("doc:render-error", onRenderError);
  // 切文档就把该文档的会话读进来（每份只读一次）。与 `render` 分开订阅：
  // 读是异步的，读到了它自己会再 render 一次。
  // 记忆也要重拉：文档级记忆的作用域取决于当前文档，换文档就该换那一份。
  DGM.bus.on("session:changed", () => {
    const d = state.activeDoc();
    if (d) ensureConversation(d.id);
    state.memoryRefresh();
  });
  DGM.bus.on("memory:changed", render);

  DGM.ai = {
    render,
    bind,
    focus,
    prefill,
    attachSelection,
    unread,
    clear,
    send: sendNow,
    explain: explainCurrent,
    applyAsCanvas,
    fixLine,
    cancel,
    applyLast,
    revertLast,
    popModels,
    modelItems: groupModelItems,
    pickImage,
    compressImage,
    // 外部文件作为上下文（拖拽 / 手填路径 / 选择文件）：导出让自检与探针能直接驱动，
    // 不必去模拟操作系统的拖放事件。
    addContextFile,
    removeContextFile,
    handleDrop,
    contextFiles: ctxFiles,
    // 会话持久化：`ensureConversation` 供启动与「历史会话」对话框用；
    // `turnCount` 让对话框显示**真实**轮次数（以前拿 `state.usage.calls` 冒充，
    // 那是本次运行内的调用计数，重启归零）。
    ensureConversation,
    persistConversation,
    turnCount,
    turnsFor,
  };
})();

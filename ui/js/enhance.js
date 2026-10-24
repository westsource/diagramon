/* AI 增强转换：确定性转换「有损或校验失败」时的显式兜底，最多 3 轮回灌。
 *
 * 红线（本文件守的三条）：
 *   1. **AI 不产几何**：目标只允许是文本格式（mermaid/dot/d2）。drawio/Excalidraw 由引擎
 *      从文本生成 —— 所以画布目标在 v1 里不给入口（`canvas-target`），不是"忘了"。
 *   2. **默认关**：`ai.enhance_enabled` 为假时一律不动，用户不点就没有任何请求。
 *   3. **不静默失败**：失败时按这个顺序落：
 *      ① 本地有确定性结果（`plan.engine === "rust"` 且无 error）→ 开目标格式标签页写本地结果；
 *      ② 本地不可用、但有 AI 产物 → 开目标格式标签页保留最后一次产物（标明未通过校验）；
 *      ③ 两边都没有 → 不开新标签页，只如实说明。
 *      **绝不把目标格式正文写进源格式标签页**（3.9.2 的缺陷，2026-10-24 修复）。
 *
 * 判定链：`DGM.validate`（能不能用）+ `DGM.reconcile`（有没有少东西）。
 * 两者都"数不出来"时按通过处理（degraded/unknown），**绝不把没校验当成有问题**。
 *
 * 取消：走 AI 面板既有的取消（`DGM.ai.cancel()` 会把挂起的调用 reject 掉，
 * 这里据此收手）；取消不生成新标签页。
 */
(function () {
  const DGM = (window.DGM = window.DGM || {});
  const state = DGM.state;
  const t = (k, v) => DGM.i18n.t(k, v);

  const TEXT_OUT = { mermaid: true, dot: true, d2: true };

  let job = null; // { canceled, status }

  function aiPrefs() {
    return (state.ai && state.ai()) || (state.settings && state.settings.ai) || {};
  }

  function status(text, kind) {
    if (text) state.pushOutput(text, kind || "info");
  }

  /** 是否配置了本地模型（文案要改口：不是"外发"，是发给本机）。 */
  function usesLocalModel() {
    const m = state.currentModel && state.currentModel();
    const prov = m && m.provider_id ? (state.ai().providers || []).find((p) => p.id === m.provider_id) : null;
    const base = String((prov && prov.base_url) || "").toLowerCase();
    return /localhost|127\.0\.0\.1|\[::1\]|0\.0\.0\.0/.test(base);
  }

  /** 入口是否该出现：有损或校验失败 + 模型已配 + 开关打开 + 目标是文本格式。 */
  function eligible(srcDoc, to, lossy) {
    if (!srcDoc) return { ok: false, why: "no-doc" };
    if (!aiPrefs().enhance_enabled) return { ok: false, why: "disabled" };
    if (!state.hasModels()) return { ok: false, why: "no-model" };
    if (!TEXT_OUT[String(to || "")]) return { ok: false, why: "canvas-target" };
    if (!lossy) return { ok: false, why: "not-lossy" };
    return { ok: true };
  }

  function buildPrompt(opt) {
    const lines = [];
    lines.push(
      t("enh.prompt.head", { from: opt.fromName, to: opt.toName }),
    );
    lines.push(t("enh.prompt.keep"));
    lines.push(t("enh.prompt.only"));
    lines.push(t("enh.prompt.noExtra"));
    if (opt.notes && opt.notes.length) {
      lines.push("");
      lines.push(t("enh.prompt.notesHead"));
      for (const n of opt.notes.slice(0, 8)) lines.push("- " + n);
    }
    if (opt.errors && opt.errors.length) {
      lines.push("");
      lines.push(t("enh.prompt.errHead"));
      for (const e of opt.errors.slice(0, 6)) {
        lines.push("- " + (e.line != null ? t("enh.prompt.errLine", { n: e.line, c: e.column || "-" }) : "") + e.text);
      }
    }
    if (opt.diff) {
      lines.push("");
      lines.push(t("enh.prompt.diffHead", { diff: opt.diff }));
    }
    return lines.join("\n");
  }

  /** 从回复里取第一个代码块（没代码块就整段当正文——模型有时直接给裸语法）。 */
  function extractBody(text) {
    const s = String(text || "");
    const m = /```[a-zA-Z0-9_-]*\s*\n([\s\S]*?)```/.exec(s);
    return (m ? m[1] : s).trim();
  }

  /** 开一个目标格式标签页并写入正文；失败返回 null（调用方负责如实说明）。 */
  async function openResult(format, body) {
    const created = await state.newDoc(format);
    if (!created) return null;
    await state.setBodyNow(created.id, body);
    DGM.editor.loadActive();
    DGM.preview.schedule();
    return created;
  }

  async function run(opt) {
    const o = opt || {};
    const srcDoc = o.srcDoc || state.activeDoc();
    const to = o.to;
    // `plan` 来自转换对话框的 `planOf()`：`{ engine, text, notes, error }`。
    // 失败兜底必须用它里面的**本地确定性结果**，不能自己猜。
    const plan = o.plan || null;
    const gate = eligible(srcDoc, to, o.lossy !== false);
    if (!gate.ok) return { ok: false, reason: gate.why };
    if (job) return { ok: false, reason: "busy" };

    // 先定上限：外发提示、进度文案、记录都用同一个 max，不能在运行中被设置改动。
    const max = Math.max(1, Math.min(3, Number(aiPrefs().retry_max) || 3));

    // 首次外发提示：只弹一次，记住选择（合规底线，不做"默认同意"）
    if (!aiPrefs().enhance_notice_seen) {
      const local = usesLocalModel();
      const yes = await DGM.dialogs.confirm({
        title: t("enh.notice.title"),
        body: t(local ? "enh.notice.local" : "enh.notice.cloud", { calls: max + 1 }),
        ok: t("enh.notice.ok"),
      });
      if (!yes) return { ok: false, reason: "declined" };
      state.patchSettings({ ai: { enhance_notice_seen: true } });
    }

    job = { canceled: false };
    const fromName = state.docFmt(srcDoc).name;
    const toName = state.fmtById(to).name;
    let lastSig = null;
    let feedback = null;
    let lastBody = "";
    /** `canceled` / `call-failed` / `empty` / `same-error` / `exhausted` / `open-failed` */
    let stopReason = "exhausted";
    /** 实际发出的模型请求数（取消发生在请求前时不计）。 */
    let calls = 0;
    /** 第一轮的账本 id；后续修正用它填 Retry-Of。 */
    let retryOf = null;

    /** 一次增强 run 只记一条转换记录；过程轮次已经在 AI 会话面板里。 */
    const record = (ok, outcome, created, fallback) => {
      const rounds = Math.max(0, calls - 1);
      state.pushConvert({
        kind: "ai-enhance",
        from: srcDoc.format,
        to,
        doc: created ? `${srcDoc.name} → ${created.name}` : srcDoc.name,
        ok,
        state: outcome,
        rounds,
        calls,
        max,
        fallback: fallback || "none",
        docId: created ? created.id : null,
        note: t("conv.ai.meta", { calls, max, rounds }),
      });
    };

    // 第 1 轮 + 最多 max 轮修正 ⇒ 真实调用 ≤ 1 + max（forceChat：每轮一次，不进工具循环）
    for (let n = 1; n <= max + 1; n += 1) {
      if (job.canceled) {
        stopReason = "canceled";
        break;
      }
      if (n > 1) status(t("enh.status.retry", { n: n - 1, left: max + 1 - n }));
      calls += 1;
      let reply = "";
      try {
        reply = await DGM.ai.askOnce({
          prompt: buildPrompt({
            fromName,
            toName,
            notes: o.notes || [],
            errors: feedback && feedback.errors,
            diff: feedback && feedback.diff,
          }),
          format: to,
          context: srcDoc.body,
          docId: srcDoc.id,
          // 一轮一次调用：不进入 agent 工具循环，保证 1+max 的额度承诺与用量口径。
          forceChat: true,
          scene: "convert.enhance",
          retryOf,
        });
      } catch (e) {
        const msg = String((e && e.message) || e);
        const canceled = /cancel/i.test(msg);
        if (canceled) {
          stopReason = "canceled";
          break;
        }
        state.pushOutput(t("enh.status.callFailed", { msg }), "warn");
        stopReason = "call-failed";
        break;
      }
      const replyText = reply && typeof reply === "object" ? String(reply.text || "") : String(reply || "");
      const ledger = reply && typeof reply === "object" ? String(reply.ledgerId || "") : "";
      if (!retryOf && ledger) retryOf = ledger;
      const body = extractBody(replyText);
      if (!body) {
        state.pushOutput(t("enh.status.empty"), "warn");
        stopReason = "empty";
        break;
      }
      lastBody = body;

      const v = await DGM.validate.run(to, body);
      const rc = await DGM.reconcile.run({
        srcFormat: srcDoc.format,
        srcBody: srcDoc.body,
        dstFormat: to,
        dstBody: body,
      });
      const missing = (rc.missingNodes || 0) + (rc.missingEdges || 0);
      const passed = v.ok && (rc.judge === "pass" || rc.judge === "unknown" || missing === 0);

      if (passed) {
        const created = await openResult(to, body);
        if (created) {
          record(true, "ok", created, "none");
          state.pushOutput(t("enh.status.ok", { rounds: n - 1 }), "ok");
          DGM.toast({
            icon: "sparkles",
            title: t("enh.status.okTitle", { name: toName }),
            sub: t("enh.status.okSub", { file: created.name }),
          });
          job = null;
          return { ok: true, doc: created, rounds: n - 1 };
        }
        // 连新标签页都开不出来：不再重试模型，走统一的收手逻辑
        stopReason = "open-failed";
        break;
      }

      // 同一处错误连着两轮 = 模型在原地打转，继续烧调用没有意义
      const sig = [
        v.degraded ? "deg" : DGM.validate.signature(v),
        rc.judge,
        String(rc.missingNodes || 0),
        String(rc.missingEdges || 0),
      ].join("|");
      if (lastSig !== null && sig === lastSig) {
        state.pushOutput(t("enh.status.sameError"), "warn");
        stopReason = "same-error";
        break;
      }
      lastSig = sig;
      feedback = { errors: v.issues || [], diff: DGM.reconcile.describe(rc) };
    }

    // 收手：不静默、也不把目标格式正文写进源格式标签页。
    // 取消：用户已经明确不要结果，不生成新标签页。
    if (stopReason === "canceled") {
      record(false, "canceled", null, "none");
      status(t("enh.status.canceled"), "warn");
      job = null;
      return { ok: false, reason: stopReason, doc: null };
    }

    // ① 本地有确定性结果（Rust 方向）：开目标格式标签页写本地结果。
    const localText =
      plan && plan.engine === "rust" && !plan.error ? String(plan.text || "") : "";
    if (localText.trim()) {
      const created = await openResult(to, localText);
      if (created) {
        record(false, stopReason, created, "local");
        status(t("enh.status.fallbackLocal", { file: created.name }), "warn");
        job = null;
        return { ok: false, reason: stopReason, doc: created };
      }
      record(false, stopReason, null, "none");
      status(t("enh.status.noTab"), "warn");
      job = null;
      return { ok: false, reason: stopReason, doc: null };
    }

    // ② 本地不可用、但有 AI 产物：开**目标格式**标签页保留最后一次产物，并标明未通过校验。
    if (lastBody) {
      const created = await openResult(to, lastBody);
      if (created) {
        record(false, stopReason, created, "attempt");
        status(t("enh.status.fallbackAttempt", { file: created.name }), "warn");
        job = null;
        return { ok: false, reason: stopReason, doc: created };
      }
    }

    // ③ 两边都没有：不开空标签页，如实说明。
    record(false, stopReason, null, "none");
    status(t("enh.status.noTab"), "warn");
    job = null;
    return { ok: false, reason: stopReason, doc: null };
  }

  function cancel() {
    if (job) job.canceled = true;
  }

  DGM.enhance = {
    eligible,
    run,
    cancel,
    isRunning: () => !!job,
  };
})();

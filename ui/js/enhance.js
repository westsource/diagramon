/* AI 增强转换：确定性转换「有损或校验失败」时的显式兜底，最多 3 轮回灌。
 *
 * 红线（本文件守的三条）：
 *   1. **AI 不产几何**：目标只允许是文本格式（mermaid/dot/d2）。drawio/Excalidraw 由引擎
 *      从文本生成 —— 所以画布目标在 v1 里不给入口（`canvas-target`），不是"忘了"。
 *   2. **默认关**：`ai.enhance_enabled` 为假时一律不动，用户不点就没有任何请求。
 *   3. **不静默失败**：要么开新标签给出结果，要么回本地确定性结果 + 如实说为什么。
 *
 * 判定链：`DGM.validate`（能不能用）+ `DGM.reconcile`（有没有少东西）。
 * 两者都"数不出来"时按通过处理（degraded/unknown），**绝不把没校验当成有问题**。
 *
 * 取消：走 AI 面板既有的取消（`DGM.ai.cancel()` 会把挂起的调用 reject 掉，
 * 这里据此收手），这样不必再造一个取消按钮和一套状态。
 */
(function () {
  const DGM = (window.DGM = window.DGM || {});

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

  async function run(opt) {
    const o = opt || {};
    const srcDoc = o.srcDoc || state.activeDoc();
    const to = o.to;
    const gate = eligible(srcDoc, to, o.lossy !== false);
    if (!gate.ok) return { ok: false, reason: gate.why };
    if (job) return { ok: false, reason: "busy" };

    // 首次外发提示：只弹一次，记住选择（合规底线，不做"默认同意"）
    if (!aiPrefs().enhance_notice_seen) {
      const local = usesLocalModel();
      const yes = await DGM.dialogs.confirm({
        title: t("enh.notice.title"),
        body: t(local ? "enh.notice.local" : "enh.notice.cloud"),
        ok: t("enh.notice.ok"),
      });
      if (!yes) return { ok: false, reason: "declined" };
      state.patchSettings({ ai: { enhance_notice_seen: true } });
    }

    const max = Math.max(1, Math.min(3, Number(aiPrefs().retry_max) || 3));
    job = { canceled: false };
    const fromName = state.docFmt(srcDoc).name;
    const toName = state.fmtById(to).name;
    let lastSig = null;
    let feedback = null;
    let lastBody = "";

    // 第 1 轮 + 最多 max 轮修正 ⇒ 真实调用 ≤ 1 + max
    for (let n = 1; n <= max + 1; n += 1) {
      if (job.canceled) break;
      if (n > 1) status(t("enh.status.retry", { n: n - 1, left: max + 1 - n }));
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
        });
      } catch (e) {
        const msg = String((e && e.message) || e);
        const canceled = /cancel/i.test(msg);
        if (canceled) break;
        state.pushOutput(t("enh.status.callFailed", { msg }), "warn");
        break;
      }
      const body = extractBody(reply);
      if (!body) {
        state.pushOutput(t("enh.status.empty"), "warn");
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
        const created = await state.newDoc(to);
        if (created) {
          await state.setBodyNow(created.id, body);
          DGM.editor.loadActive();
          DGM.preview.schedule();
          state.pushOutput(t("enh.status.ok", { rounds: n - 1 }), "ok");
          DGM.toast({
            icon: "sparkles",
            title: t("enh.status.okTitle", { name: toName }),
            sub: t("enh.status.okSub", { file: created.name }),
          });
          job = null;
          return { ok: true, doc: created, rounds: n - 1 };
        }
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
        break;
      }
      lastSig = sig;
      feedback = { errors: v.issues || [], diff: DGM.reconcile.describe(rc) };
    }

    // 收手：如实说清，不静默、也不给空标签
    const created = await state.newDoc(srcDoc.format);
    if (created) {
      await state.setBodyNow(created.id, lastBody || srcDoc.body);
      DGM.editor.loadActive();
      DGM.preview.schedule();
    }
    status(t("enh.status.giveUp", { max }), "warn");
    job = null;
    return { ok: false, reason: "exhausted", doc: created };
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

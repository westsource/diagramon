/* 底部面板：问题 / 输出 / 转换记录 / AI 用量。
 *
 * - 问题：来自 state.issuesByDoc（Rust 侧 doc_issues），点击跳到出问题的行。
 * - 输出：本会话的本地日志（state.logs.output，由各模块 pushOutput 写入）。
 * - 转换记录：state.logs.convert（转换完成后 pushConvert）。
 * - AI 用量：只统计本机发出的调用次数与 token（state.usage）。
 *   信用点/余额需要云网关，未接入，所以这里**不展示任何余额**。
 */
window.DGM = window.DGM || {};
(function () {
  "use strict";

  const state = DGM.state;
  const t = (k, v) => DGM.i18n.t(k, v);
  const icon = DGM.icon;
  const { $, $$, h, esc } = DGM.dom;

  const el = DGM.shell.el;

  const TABS = [
    { id: "problems", icon: "alert", label: "panel.problems" },
    { id: "output", icon: "term", label: "panel.output" },
    { id: "convert", icon: "swap", label: "panel.convert" },
    { id: "usage", icon: "bolt", label: "panel.usage" },
  ];

  function goto(id, line) {
    state.activateDoc(id).then(() => {
      if (DGM.editor && DGM.editor.loadActive) DGM.editor.loadActive();
      if (DGM.editor && DGM.editor.gotoLine && line) DGM.editor.gotoLine(line);
      state.refreshDerived(id);
    });
  }

  /* ------------------------------------------------------------------ tabs */

  function renderTabs() {
    const host = $("#bp-tabs");
    if (!host) return;
    const cur = state.panels().bottom_tab || "problems";
    const totals = state.issueTotals();
    host.innerHTML = "";
    for (const tab of TABS) {
      const b = h("button", "bp-tab" + (tab.id === cur ? " on" : ""));
      let badge = "";
      if (tab.id === "problems") {
        const cls = totals.err ? "err" : totals.warn ? "warn" : "";
        badge = `<span class="n ${cls}">${totals.all}</span>`;
      } else if (tab.id === "convert" && state.logs.convert.length) {
        badge = `<span class="n">${state.logs.convert.length}</span>`;
      }
      b.innerHTML = `${icon(tab.icon, "ico-sm")}<span>${esc(t(tab.label))}</span>${badge}`;
      b.addEventListener("click", () => state.patchSettings({ panels: { bottom_tab: tab.id } }));
      host.appendChild(b);
    }
    host.appendChild(h("span", "sp"));
    const x = h("button", "icon-btn", icon("close", "ico-sm"));
    x.title = t("panel.hide");
    x.addEventListener("click", () => DGM.shell.togglePanel("bottom"));
    host.appendChild(x);
  }

  /* ------------------------------------------------------------------ 各页签 */

  function viewProblems() {
    const box = h("div", "bp-issues");
    const rows = [];
    for (const d of state.docs) {
      for (const i of state.issuesByDoc[d.id] || []) rows.push({ d, i });
    }
    if (!rows.length) {
      box.appendChild(h("div", "bp-empty", `${icon("ok")}<span>${esc(t("panel.problems.empty"))}</span>`));
      return box;
    }
    for (const { d, i } of rows) {
      const sev = i.severity === "error" ? "err" : "warn";
      const row = h("button", "issue " + sev);
      row.innerHTML =
        `<span class="sev">${icon(sev === "err" ? "err" : "warn", "ico-sm")}</span>` +
        `<span class="txt"><b>${esc(i.message)}</b>` +
        `<span>${esc(d.name)} · ${esc(t("common.line"))} ${i.line} · ${esc(i.hint)}</span></span>` +
        `<span class="go">${esc(t("panel.issues.goto"))} ${icon("chevR", "ico-sm")}</span>`;
      row.addEventListener("click", () => goto(d.id, i.line));
      box.appendChild(row);
    }
    return box;
  }

  function viewOutput() {
    const box = h("div");
    if (!state.logs.output.length) {
      box.appendChild(h("div", "bp-empty", `${icon("term")}<span>${esc(t("panel.output.empty"))}</span>`));
      return box;
    }
    for (const l of state.logs.output) {
      box.appendChild(h("div", "bp-line " + (l.kind || ""), `<span class="t">${esc(l.t)}</span><span class="m">${esc(l.message)}</span>`));
    }
    return box;
  }

  function viewConvert() {
    const box = h("div");
    if (!state.logs.convert.length) {
      box.appendChild(h("div", "bp-empty", `${icon("swap")}<span>${esc(t("panel.convert.empty"))}</span>`));
      return box;
    }
    for (const c of state.logs.convert) {
      const src = state.fmtById(c.from);
      const dst = state.fmtById(c.to);
      const row = h("div", "conv-log");
      row.innerHTML =
        `<span class="t">${esc(c.t)}</span>` +
        `<span class="pair"><span class="chip ${src.id}">${esc(src.name)}</span>${icon("chevR", "ico-sm")}<span class="chip ${dst.id}">${esc(dst.name)}</span></span>` +
        `<span class="st ${c.ok ? "ok" : "bad"}">${icon(c.ok ? "check" : "alert", "ico-sm")}${esc(c.ok ? t("panel.convert.ok") : t("panel.convert.partial"))}</span>` +
        `<span class="doc">${esc(c.doc || "")}</span>` +
        `<span class="note">${esc(c.note || "")}</span>`;
      box.appendChild(row);
    }
    return box;
  }

  function viewUsage() {
    const u = state.usage;
    const box = h("div", "usage");
    const models = Object.keys(u.byModel);
    const rows = models.length
      ? models
          .map((m) => {
            const r = u.byModel[m];
            return `<tr><td>${esc(m)}</td><td class="n">${r.calls}</td><td class="n">${r.prompt}</td><td class="n">${r.completion}</td></tr>`;
          })
          .join("")
      : `<tr><td colspan="4" class="n">${esc(t("panel.output.empty"))}</td></tr>`;
    box.innerHTML =
      `<div class="usage-head">` +
      `<div class="usage-kpi"><span class="lb">${esc(t("panel.usage.calls"))}</span><span class="num">${u.calls}</span><span class="unit">${esc(t("panel.usage.localTitle"))}</span></div>` +
      `<div class="usage-kpi"><span class="lb">${esc(t("panel.usage.prompt"))}</span><span class="num">${u.prompt}</span><span class="unit">tokens</span></div>` +
      `<div class="usage-kpi"><span class="lb">${esc(t("panel.usage.completion"))}</span><span class="num">${u.completion}</span><span class="unit">tokens</span></div>` +
      `</div>` +
      `<div class="usage-note">${esc(t("panel.usage.creditNote"))}</div>` +
      `<table class="usage-table"><thead><tr>` +
      `<th>${esc(t("set.ai.models"))}</th>` +
      `<th class="n">${esc(t("panel.usage.calls"))}</th>` +
      `<th class="n">${esc(t("panel.usage.prompt"))}</th>` +
      `<th class="n">${esc(t("panel.usage.completion"))}</th>` +
      `</tr></thead><tbody>${rows}</tbody></table>`;
    return box;
  }

  /* ------------------------------------------------------------------ 渲染 */

  function render() {
    renderTabs();
    const body = $("#bp-body");
    if (!body) return;
    const cur = state.panels().bottom_tab || "problems";
    body.innerHTML = "";
    if (cur === "output") body.appendChild(viewOutput());
    else if (cur === "convert") body.appendChild(viewConvert());
    else if (cur === "usage") body.appendChild(viewUsage());
    else body.appendChild(viewProblems());
  }

  DGM.bus.on("issues:changed", render);
  DGM.bus.on("logs:changed", render);
  DGM.bus.on("usage:changed", render);
  DGM.bus.on("session:changed", render);
  DGM.bus.on("settings:changed", render);

  DGM.panels = { render, goto };
})();

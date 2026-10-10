/* 命令面板（Ctrl+Shift+P / F1）。
 *
 * 无前缀：可搜文档 / 新建 / 转换 / 命令 / 直接问 AI；
 * ">" 前缀：只搜命令；"?" 前缀：帮助类命令。
 * 不可用项置灰并给理由（转换方向、需要文档的操作等）。
 */
window.DGM = window.DGM || {};
(function () {
  "use strict";
  const state = DGM.state;
  const t = (k, v) => DGM.i18n.t(k, v);
  const icon = DGM.icon;
  const { $, $$, h, esc } = DGM.dom;

  const el = {
    overlay: $("#overlay-palette"),
    input: $("#palette-input"),
    list: $("#palette-list"),
    count: $("#palette-count"),
  };

  let items = [];
  let idx = 0;
  let open = false;

  const GROUP_LABEL = () => ({
    ai: t("palette.group.ai"),
    file: t("palette.group.file"),
    view: t("palette.group.view"),
    convert: t("palette.group.convert"),
    format: t("palette.group.format"),
    help: t("palette.group.help"),
  });

  function build(q) {
    const query = q.trim().toLowerCase();
    const isCmd = query.startsWith(">");
    const isHelp = query.startsWith("?");
    const kw = isCmd || isHelp ? query.slice(1).trim() : query;
    const res = [];

    if (!isCmd && !isHelp) {
      if (kw) {
        res.push({ kind: "ask", label: t("palette.askAI", { q: q.trim() }), icon: "sparkles", ai: true, kbd: "Enter" });
        res.push({ kind: "vision", label: t("palette.vision"), icon: "scan", ai: true });
      }
      // 文档
      for (const d of state.docs) {
        if (!kw || d.name.toLowerCase().includes(kw)) {
          res.push({ kind: "doc", label: d.name, sub: d.path || t("tab.noPath"), icon: "file", docId: d.id });
        }
      }
      // 新建
      for (const f of state.formatList) {
        if (!kw || f.name.toLowerCase().includes(kw) || f.id.includes(kw)) {
          res.push({ kind: "new", label: t("palette.new", { name: f.name }), sub: f.exts.join(" "), icon: "plus", formatId: f.id });
        }
      }
      // 转换
      for (const c of DGM.directions()) {
        const from = state.fmtById(c.from).name;
        const to = state.fmtById(c.to).name;
        const label = t("palette.convert", { from, to });
        if (!kw || label.toLowerCase().includes(kw)) {
          res.push({ kind: "conv", label, sub: c.ok ? c.tag : c.how, icon: "swap", conv: c, disabled: !c.ok, why: c.how });
        }
      }
    }

    // 命令
    for (const c of DGM.commands.list()) {
      if (isHelp && c.group !== "help") continue;
      const label = DGM.commands.label(c.id);
      if (kw && !label.toLowerCase().includes(kw) && !c.id.toLowerCase().includes(kw) && !(c.group || "").includes(kw)) continue;
      const avail = c.avail ? c.avail() : true;
      const disabled = avail === false || (avail && avail.ok === false);
      res.push({ kind: "cmd", label, icon: c.icon, kbd: c.kbd, cmd: c, ai: c.group === "ai", disabled, why: disabled && avail && avail.why ? avail.why : "" });
    }

    if (res.length === 0) {
      res.push({ kind: "ask", label: t("palette.askAI", { q: q.trim() }), icon: "sparkles", ai: true, empty: true });
    }
    return res;
  }

  function render() {
    const q = el.input.value;
    items = build(q);
    if (idx >= items.length) idx = 0;
    const labels = GROUP_LABEL();
    let lastGroup = null;
    const shown = items.slice(0, 60);
    el.list.innerHTML = "";
    shown.forEach((it, i) => {
      if (it.kind === "cmd" && it.cmd.group !== lastGroup) {
        lastGroup = it.cmd.group;
        el.list.appendChild(h("div", "palette-group", esc(labels[it.cmd.group] || it.cmd.group)));
      }
      const b = h("button", "palette-item" + (it.ai ? " ai" : "") + (it.disabled ? " dis" : "") + (i === idx ? " sel" : ""));
      b.innerHTML =
        icon(it.icon || "chevR") +
        `<span class="lbl">${esc(it.label)}</span>` +
        (it.sub ? `<span class="sub">${esc(it.sub)}</span>` : "") +
        (it.kbd ? `<span class="kbd">${esc(it.kbd)}</span>` : "");
      if (it.disabled && it.why) b.title = t("palette.unavail", { why: it.why });
      b.addEventListener("mouseenter", () => {
        idx = i;
        markSel();
      });
      b.addEventListener("click", () => run(items[i]));
      el.list.appendChild(b);
    });
    el.count.textContent = t("palette.count", { shown: Math.min(60, items.length), total: items.length });
  }

  function markSel() {
    $$("#palette-list .palette-item").forEach((b, i) => b.classList.toggle("sel", i === idx));
    const s = $("#palette-list .palette-item.sel");
    if (s) s.scrollIntoView({ block: "nearest" });
  }

  function run(it) {
    if (!it) return;
    if (it.disabled) {
      DGM.toast({ icon: "alert", title: it.label, sub: it.why ? t("palette.unavail", { why: it.why }) : "", warn: true });
      return;
    }
    close();
    if (it.kind === "ask") {
      const text = it.label.replace(/^.*?[:：]\s*/, "");
      DGM.ai.focus("chat");
      DGM.ai.prefill(text, true);
      return;
    }
    if (it.kind === "vision") {
      DGM.ai.focus("chat");
      DGM.ai.prefill(it.label, false);
      return;
    }
    if (it.kind === "doc") return void state.activateDoc(it.docId).then(() => { DGM.editor.loadActive(); DGM.preview.schedule(); state.refreshDerived(it.docId); });
    if (it.kind === "new") return DGM.dialogs.newDoc(it.formatId);
    if (it.kind === "conv") return DGM.dialogs.convertTo(it.conv.to);
    if (it.kind === "cmd") return DGM.commands.run(it.cmd.id);
  }

  function openPalette() {
    open = true;
    el.overlay.hidden = false;
    el.input.value = "";
    idx = 0;
    render();
    setTimeout(() => el.input.focus(), 20);
  }
  function close() {
    open = false;
    el.overlay.hidden = true;
    el.list.innerHTML = "";
  }

  function bind() {
    el.input.addEventListener("input", () => {
      idx = 0;
      render();
    });
    el.input.addEventListener("keydown", (e) => {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        idx = Math.min(items.length - 1, idx + 1);
        markSel();
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        idx = Math.max(0, idx - 1);
        markSel();
      } else if (e.key === "Enter") {
        e.preventDefault();
        run(items[idx]);
      } else if (e.key === "Escape") {
        e.preventDefault();
        close();
      }
    });
    el.overlay.addEventListener("mousedown", (e) => {
      if (e.target.id === "overlay-palette") close();
    });
  }

  DGM.palette = { open: openPalette, close, isOpen: () => open, render, bind };
})();

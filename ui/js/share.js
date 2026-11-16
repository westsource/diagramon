/* 只读分享：客户端入口与两个窗口（创建链接 / 管理链接）。
 *
 * 设计口径（2026-11-16 与产品确认）：
 *   - **分享整份图**（不做子图提取），链接指向云端文档，看的时候由对方浏览器现渲染，
 *     所以永远是最新版本；
 *   - **看的人不需要登录**：链接就是凭据；所有者才要登录（文档在云端，需配额与撤销权）；
 *   - 未上传的本地文件 / 草稿：先明确确认再上传，**绝不静默上传**；上传的是当前正文，
 *     本地文件不动。之后本地改动不会自动同步（分享的是云端副本）。
 */
window.DGM = window.DGM || {};
(function () {
  "use strict";

  const state = DGM.state;
  const t = (k, v) => DGM.i18n.t(k, v);
  const icon = DGM.icon;
  const { $, esc, h } = DGM.dom;

  // 哪些云端文档已经有进行中的链接：标签条的「共享」按钮据此点亮。
  // 只存 documentId（= 前端 doc.cloudId），不进 settings、不落盘。
  const activeDocs = new Set();
  async function refreshMarks() {
    if (!signedIn()) { activeDocs.clear(); return; }
    try {
      const list = await DGM.ipc.invoke("share_list");
      activeDocs.clear();
      for (const s of (list && list.items) || []) {
        if (!s.expired && !s.revoked) activeDocs.add(s.documentId);
      }
    } catch (_) {
      /* 拉不到列表就不点亮：宁可少提示，也不假装已分享 */
    }
    if (DGM.tabs && DGM.tabs.renderViewModes) DGM.tabs.renderViewModes();
  }
  if (DGM.bus && DGM.bus.on) DGM.bus.on("cloud:changed", () => { refreshMarks(); });
  setTimeout(refreshMarks, 800);

  function close() {
    DGM.dialogs.close();
  }

  function wire(d, onAct) {
    d.onclick = (e) => {
      if (e.target.closest("[data-close]")) return close();
      const b = e.target.closest("[data-act]");
      if (b && !b.disabled && onAct) onAct(b.dataset.act, b, e);
    };
    const ov = $("#overlay-dialog");
    if (ov) ov.onclick = (e) => { if (e.target === ov) close(); };
  }

  function head(title, sub) {
    return (
      `<div class="dialog-head">${icon("share")}<h2>${esc(title)}</h2>` +
      (sub ? `<small>${esc(sub)}</small>` : "") +
      `<span class="sp"></span><button class="icon-btn" data-close title="${esc(t("common.close"))}">${icon("close", "ico-sm")}</button></div>`
    );
  }

  function foot(left, right) {
    return `<div class="dialog-foot"><span class="note">${left || ""}</span><span class="sp"></span>${right || ""}</div>`;
  }

  function signedIn() {
    return !!(state.cloud && state.cloud.status && state.cloud.status.signed_in);
  }

  function fmtWhen(iso) {
    if (!iso) return "";
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return "";
    try { return d.toLocaleDateString(DGM.i18n.lang); } catch (_) { return ""; }
  }

  /* ------------------------------------------------------- 创建：三态入口 */

  async function open(docId) {
    const d = state.doc(docId) || state.activeDoc();
    if (!d) {
      DGM.toast({ icon: "info", title: t("share.noDoc"), sub: "", warn: true });
      return;
    }
    if (!signedIn()) {
      // 登录后**接着做这次共享**：登录只是中途一站
      return DGM.cloud.openLogin({ onSuccess: () => open(d.id) });
    }
    if (!d.cloudId) return askUpload(d);
    return createDialog(d);
  }

  function askUpload(d) {
    const html =
      head(t("share.needUploadTitle"), t("share.subLocal", { name: d.name })) +
      `<div class="dialog-body">
         <div class="callout warn">${icon("warn")}<span>${t("share.needUploadBody")}</span></div>
         <div class="callout">${icon("info")}<span>${t("share.needUploadNote")}</span></div>
       </div>` +
      foot(t("share.uploadFootnote"), `<button class="btn ghost" data-close>${esc(t("common.cancel"))}</button>
        <button class="btn primary" data-act="upload">${icon("cloud")}${esc(t("share.upload"))}</button>`);
    const dlg = DGM.dialogs.open(html);
    wire(dlg, async (act, btn) => {
      if (act !== "upload") return;
      btn.disabled = true;
      close();
      try {
        await state.activateDoc(d.id);
        const saved = await DGM.cloud.saveDoc(); // 复用「保存到云端」窗口（目录/名字/冲突处理）
        const again = state.doc(d.id);
        if (saved && again && again.cloudId) {
          DGM.toast({ icon: "cloud", title: t("share.uploaded"), sub: again.name });
          return createDialog(again);
        }
        // 用户取消或保存失败：saveDoc 自己已提示，这里不重复
      } catch (e) {
        DGM.toast({ icon: "alert", title: t("share.failed"), sub: String((e && e.message) || e), warn: true });
      }
    });
  }

  function createDialog(d) {
    const html =
      head(t("share.title"), t("share.subCloud", { name: d.name })) +
      `<div class="dialog-body">
         <div class="choice">
           <div class="opt on"><span class="rd"></span><div><b>${esc(t("share.whole"))}</b><small>${esc(t("share.wholeHint"))}</small></div></div>
         </div>
         <div class="field"><label>${esc(t("share.expiry"))}</label>
           <div class="seg" data-exp>
             <button data-days="7">${esc(t("share.days", { n: 7 }))}</button>
             <button data-days="30" class="on">${esc(t("share.days", { n: 30 }))}</button>
             <button data-days="never">${esc(t("share.never"))}</button>
           </div>
           <span class="hint">${esc(t("share.expiryHint"))}</span>
         </div>
         <label class="opt" data-pass style="align-items:center">
           <span class="rd"></span><div style="flex:1"><b>${esc(t("share.password"))}</b><small>${esc(t("share.passwordHint"))}</small></div>
         </label>
         <div class="field" data-pass-field hidden><input class="input" id="share-pass" placeholder="${esc(t("share.passwordPlaceholder"))}"></div>
         <div class="callout info">${icon("info")}<span>${t("share.anonNote")}</span></div>
       </div>` +
      foot(t("share.footNote"), `<button class="btn ghost" data-close>${esc(t("common.cancel"))}</button>
        <button class="btn primary" data-act="create">${icon("link")}${esc(t("share.create"))}</button>`);
    const dlg = DGM.dialogs.open(html);

    let days = 30; // null = 永久
    let pass = false;
    wire(dlg, async (act, btn) => {
      if (act === "day") {
        days = btn.dataset.days === "never" ? null : Number(btn.dataset.days);
        dlg.querySelectorAll("[data-days]").forEach((x) => x.classList.toggle("on", x === btn));
        return;
      }
      if (act === "create") {
        btn.disabled = true;
        btn.textContent = t("share.creating");
        try {
          const info = await DGM.ipc.invoke("share_create", {
            documentId: d.cloudId,
            expiresDays: days,
            password: pass ? ($("#share-pass") || {}).value || "" : "",
            // 把"我现在看到的布局/外观"一起带过去：分享页按同一套参数渲染。
            layout: d.layout || null,
            look: d.look || null,
          });
          DGM.toast({ icon: "share", title: t("share.created"), sub: "" });
          refreshMarks();
          showLink(info);
        } catch (e) {
          btn.disabled = false;
          btn.innerHTML = `${icon("link")}${esc(t("share.create"))}`;
          DGM.toast({ icon: "alert", title: t("share.failed"), sub: String((e && e.message) || e), warn: true });
        }
      }
    });
    // 分段 / 密码开关：与 data-act 分开绑（它们是纯本地状态）
    dlg.querySelectorAll("[data-days]").forEach((b) => (b.dataset.act = "day"));
    const passRow = dlg.querySelector("[data-pass]");
    if (passRow) {
      passRow.addEventListener("click", () => {
        pass = !pass;
        passRow.classList.toggle("on", pass);
        const f = dlg.querySelector("[data-pass-field]");
        if (f) f.hidden = !pass;
        if (pass) setTimeout(() => { const i = $("#share-pass"); if (i) i.focus(); }, 0);
      });
    }
  }

  function showLink(info) {
    const html =
      head(t("share.created")) +
      `<div class="dialog-body">
         <div class="field"><label>${esc(t("share.link"))}</label>
           <div class="link-row"><input class="input" readonly id="share-url" value="${esc(info.url)}">
             <button class="btn sm" data-act="copy">${icon("copy", "ico-sm")}${esc(t("share.copy"))}</button></div>
           <span class="hint">${esc(t("share.linkHint"))}</span>
         </div>
         <div class="callout info">${icon("info")}<span>${t("share.anonNote")}</span></div>
       </div>` +
      foot("", `<button class="btn ghost" data-act="manage">${esc(t("share.manage"))}</button>
        <button class="btn primary" data-close>${esc(t("common.close"))}</button>`);
    const dlg = DGM.dialogs.open(html);
    wire(dlg, (act) => {
      if (act === "copy") {
        DGM.dialogs.copyText(info.url);
        DGM.toast({ icon: "copy", title: t("share.copied"), sub: "" });
      } else if (act === "manage") {
        manage();
      }
    });
    setTimeout(() => {
      const u = $("#share-url");
      if (u) { u.focus(); u.select(); }
    }, 0);
  }

  /* ------------------------------------------------------------- 管理列表 */

  async function manage() {
    if (!signedIn()) return DGM.cloud.openLogin({ onSuccess: () => manage() });
    let list = { items: [] };
    try {
      list = await DGM.ipc.invoke("share_list");
    } catch (e) {
      DGM.toast({ icon: "alert", title: t("share.failed"), sub: String((e && e.message) || e), warn: true });
    }
    const rows = (list.items || []).map((s) => {
      const when = s.expiresAt ? t("share.expires", { d: fmtWhen(s.expiresAt) }) : t("share.never");
      return `<div class="share-row" data-id="${esc(s.id)}">
        <div class="t"><b>${esc(s.name)}</b><small>${esc(when)} · ${esc(t("share.views", { n: s.viewCount }))}</small></div>
        <div class="acts"><button class="btn sm ghost" data-act="copy" data-url="${esc(s.url)}">${icon("copy", "ico-sm")}${esc(t("share.copy"))}</button>
          <button class="btn sm ghost danger" data-act="revoke">${esc(t("share.revoke"))}</button></div>
      </div>`;
    }).join("");
    const html =
      head(t("share.manageTitle")) +
      `<div class="dialog-body">
         ${rows || `<div class="callout">${icon("info")}<span>${esc(t("share.manageEmpty"))}</span></div>`}
       </div>` +
      foot("", `<button class="btn ghost" data-close>${esc(t("common.close"))}</button>`);
    const dlg = DGM.dialogs.open(html);
    wire(dlg, async (act, btn) => {
      if (act === "copy") {
        DGM.dialogs.copyText(btn.dataset.url || "");
        DGM.toast({ icon: "copy", title: t("share.copied"), sub: "" });
        return;
      }
      if (act === "revoke") {
        const row = btn.closest(".share-row");
        const id = row && row.dataset.id;
        if (!id) return;
        btn.disabled = true;
        try {
          await DGM.ipc.invoke("share_revoke", { id });
          DGM.toast({ icon: "close", title: t("share.revoked"), sub: "" });
          refreshMarks();
          manage();
        } catch (e) {
          btn.disabled = false;
          DGM.toast({ icon: "alert", title: t("share.failed"), sub: String((e && e.message) || e), warn: true });
        }
      }
    });
  }

  DGM.share = {
    open,
    manage,
    /** 当前云端文档是否有进行中的分享（标签条据此点亮） */
    isActive: (cloudId) => !!(cloudId && activeDocs.has(cloudId)),
    refreshMarks,
  };
})();

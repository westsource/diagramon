/* 图标精灵：全部内联 SVG，不引任何图标库 / 字体文件。
 *
 * 用法：<svg class="ico"><use href="#i-save"></use></svg>
 * 或   DGM.icon("save", "ico-sm")  →  直接拿一段 <svg> 字符串
 *
 * 统一 24x24 viewBox、stroke 1.7、currentColor，颜色跟随文字色，明暗主题自动适配。
 * 这里就是 design/ui-proto/proto-icons.js 的移植，唯一的差别是收进 DGM 命名空间。
 */
window.DGM = window.DGM || {};
(function () {
  "use strict";

  const P = {
    // 品牌
    logo: '<path d="M4 6.5h5.5v5H4z"/><path d="M14.5 12.5H20v5h-5.5z"/><path d="M6.75 11.5v3.2a1.8 1.8 0 0 0 1.8 1.8h4.2"/>',
    // 文件与文档
    file: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/>',
    folder: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2.5h8a2 2 0 0 1 2 2V18a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
    folderOpen: '<path d="M3 8V6a1 1 0 0 1 1-1h4.6l2 2.4H19a1 1 0 0 1 1 1V10"/><path d="M3.6 10h17.8l-2.1 8.2a1 1 0 0 1-1 .8H5.4a1 1 0 0 1-1-.8z"/>',
    save: '<path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><path d="M17 21v-8H7v8M7 3v5h8"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    close: '<path d="M18 6 6 18M6 6l12 12"/>',
    chevR: '<path d="m9 6 6 6-6 6"/>',
    chevD: '<path d="m6 9 6 6 6-6"/>',
    // 侧栏视图
    explorer: '<path d="M4 5.5A1.5 1.5 0 0 1 5.5 4h4L11 6h7.5A1.5 1.5 0 0 1 20 7.5v10A1.5 1.5 0 0 1 18.5 19h-13A1.5 1.5 0 0 1 4 17.5z"/><path d="M8 12h8M8 15.5h5"/>',
    search: '<circle cx="11" cy="11" r="6.5"/><path d="m16 16 4.5 4.5"/>',
    cloud: '<path d="M17.5 19H7a4 4 0 0 1-.6-7.96 5.5 5.5 0 0 1 10.6-1.4A3.75 3.75 0 0 1 17.5 19z"/>',
    swap: '<path d="M4 8h13l-3.2-3.2M20 16H7l3.2 3.2"/>',
    outline: '<path d="M5 5h6M5 10h10M5 15h7M5 20h4"/><circle cx="18.5" cy="15" r="2.5"/>',
    settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.6 1.6 0 0 0 .32 1.77l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.6 1.6 0 0 0-1.77-.32 1.6 1.6 0 0 0-1 1.47V21a2 2 0 1 1-4 0v-.1A1.6 1.6 0 0 0 9.1 19.4a1.6 1.6 0 0 0-1.77.32l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.6 1.6 0 0 0 4.82 15a1.6 1.6 0 0 0-1.47-1H3a2 2 0 1 1 0-4h.1A1.6 1.6 0 0 0 4.6 9.1a1.6 1.6 0 0 0-.32-1.77l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.6 1.6 0 0 0 9 4.82a1.6 1.6 0 0 0 1-1.47V3a2 2 0 1 1 4 0v.1a1.6 1.6 0 0 0 1 1.47 1.6 1.6 0 0 0 1.77-.32l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.6 1.6 0 0 0 19.18 9v0a1.6 1.6 0 0 0 1.47 1H21a2 2 0 1 1 0 4h-.1a1.6 1.6 0 0 0-1.5 1z"/>',
    // AI
    sparkles: '<path d="m12 3 1.9 4.9L18.8 9.8 13.9 11.7 12 16.6l-1.9-4.9L5.2 9.8l4.9-1.9z"/><path d="M18.5 15.5l.8 2 2 .8-2 .8-.8 2-.8-2-2-.8 2-.8z"/><path d="M5.5 15l.6 1.5 1.5.6-1.5.6L5.5 19.2l-.6-1.5-1.5-.6 1.5-.6z"/>',
    image: '<rect x="3" y="4.5" width="18" height="15" rx="2"/><circle cx="8.5" cy="10" r="1.7"/><path d="m4 17 4.8-4.4a1.6 1.6 0 0 1 2.2 0L20 20"/>',
    scan: '<path d="M4 8V6a2 2 0 0 1 2-2h2M16 4h2a2 2 0 0 1 2 2v2M20 16v2a2 2 0 0 1-2 2h-2M8 20H6a2 2 0 0 1-2-2v-2"/><path d="M4 12h16"/>',
    send: '<path d="M4.5 12 20 4.5 15 20l-3.4-6.1z"/><path d="m11.6 13.9 8.4-9.4"/>',
    robot: '<rect x="4" y="8" width="16" height="11" rx="2.5"/><path d="M12 4v4M8.5 13v1.5M15.5 13v1.5M9.5 17h5"/><circle cx="12" cy="3" r="1.2"/>',
    wand: '<path d="m5 19 9.5-9.5M15.8 4.2l1 1M19 7l1.4.6M13 3l.6 1.4M17.5 8.5 19 9M12.5 6.5 14 5"/>',
    check: '<path d="M20 6 9 17l-5-5"/>',
    undo: '<path d="M4 9h10a5 5 0 0 1 0 10H8"/><path d="m8 5-4 4 4 4"/>',
    trash: '<path d="M4 7h16M9.5 7V5.2A1.2 1.2 0 0 1 10.7 4h2.6a1.2 1.2 0 0 1 1.2 1.2V7M6.5 7l.9 12.1A1.9 1.9 0 0 0 9.3 21h5.4a1.9 1.9 0 0 0 1.9-1.9L17.5 7"/>',
    copy: '<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M6 15H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v1"/>',
    history: '<path d="M3.5 12a8.5 8.5 0 1 0 2.6-6.1L3 9"/><path d="M3 4.5V9h4.5M12 7.5V12l3 1.8"/>',
    // 视图与面板
    panelLeft: '<rect x="3" y="4.5" width="18" height="15" rx="2"/><path d="M9.5 4.5v15"/>',
    panelRight: '<rect x="3" y="4.5" width="18" height="15" rx="2"/><path d="M14.5 4.5v15"/>',
    panelBottom: '<rect x="3" y="4.5" width="18" height="15" rx="2"/><path d="M3 14.5h18"/>',
    splitV: '<rect x="3" y="4.5" width="18" height="15" rx="2"/><path d="M12 4.5v15"/>',
    code: '<path d="m9 7-5 5 5 5M15 7l5 5-5 5"/>',
    eye: '<path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z"/><circle cx="12" cy="12" r="3"/>',
    layout: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 9h18M9 9v11"/>',
    maximize: '<path d="M4 9V5.5A1.5 1.5 0 0 1 5.5 4H9M15 4h3.5A1.5 1.5 0 0 1 20 5.5V9M20 15v3.5a1.5 1.5 0 0 1-1.5 1.5H15M9 20H5.5A1.5 1.5 0 0 1 4 18.5V15"/>',
    minimize: '<path d="M5 12h14"/>',
    sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2.5v2M12 19.5v2M2.5 12h2M19.5 12h2M5.2 5.2l1.4 1.4M17.4 17.4l1.4 1.4M18.8 5.2l-1.4 1.4M6.6 17.4l-1.4 1.4"/>',
    moon: '<path d="M20 14.5A8.5 8.5 0 0 1 9.5 4a8.5 8.5 0 1 0 10.5 10.5z"/>',
    // 画布与导出
    zoomIn: '<circle cx="11" cy="11" r="6.5"/><path d="M11 8.5v5M8.5 11h5M16 16l4.5 4.5"/>',
    zoomOut: '<circle cx="11" cy="11" r="6.5"/><path d="M8.5 11h5M16 16l4.5 4.5"/>',
    fit: '<path d="M4 9V5.5A1.5 1.5 0 0 1 5.5 4H9M15 4h3.5A1.5 1.5 0 0 1 20 5.5V9M20 15v3.5a1.5 1.5 0 0 1-1.5 1.5H15M9 20H5.5A1.5 1.5 0 0 1 4 18.5V15"/><rect x="8.5" y="8.5" width="7" height="7" rx="1"/>',
    download: '<path d="M12 3.5v11M7.5 10.5 12 15l4.5-4.5M4.5 19.5h15"/>',
    hand: '<path d="M8 12V6.2a1.6 1.6 0 0 1 3.2 0V11M11.2 10.6V5.4a1.6 1.6 0 0 1 3.2 0V11M14.4 11V7.4a1.6 1.6 0 0 1 3.2 0V14a6.5 6.5 0 0 1-6.5 6.5h-.6a5 5 0 0 1-3.9-1.9L4 14.6a1.6 1.6 0 0 1 2.5-2l1.5 1.8"/>',
    // 图形语义
    diagram: '<rect x="9" y="3" width="6" height="4.5" rx="1"/><rect x="3" y="16.5" width="6" height="4.5" rx="1"/><rect x="15" y="16.5" width="6" height="4.5" rx="1"/><path d="M12 7.5v4M6 16.5v-2.2a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v2.2"/>',
    flow: '<rect x="3" y="4" width="7" height="5" rx="1.2"/><path d="M13.5 15.5h7.5v-8h-4"/><rect x="3" y="15.5" width="7" height="5" rx="1.2"/>',
    seq: '<path d="M6 4v16M18 4v16M6 8h12M6 14h12"/><path d="m15 6 3 2-3 2"/>',
    db: '<ellipse cx="12" cy="6" rx="7" ry="3"/><path d="M5 6v12c0 1.7 3.1 3 7 3s7-1.3 7-3V6M5 12c0 1.7 3.1 3 7 3s7-1.3 7-3"/>',
    // 状态与提示
    info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5.5M12 7.8v.4"/>',
    alert: '<path d="M10.3 4.3 2.6 17.5A2 2 0 0 0 4.3 20.5h15.4a2 2 0 0 0 1.7-3L13.7 4.3a2 2 0 0 0-3.4 0z"/><path d="M12 9.5v4M12 17v.2"/>',
    err: '<circle cx="12" cy="12" r="9"/><path d="m9 9 6 6M15 9l-6 6"/>',
    warn: '<circle cx="12" cy="12" r="9"/><path d="M12 7.5v5.5M12 16.4v.2"/>',
    ok: '<circle cx="12" cy="12" r="9"/><path d="m8 12.3 2.7 2.7L16.2 9.5"/>',
    bug: '<rect x="7.5" y="7" width="9" height="12" rx="4.5"/><path d="M9.5 5.2 8 3.5M14.5 5.2 16 3.5M3 11h4.5M16.5 11H21M3.5 17h4M16.5 17h4M12 10v6"/>',
    term: '<rect x="3" y="4.5" width="18" height="15" rx="2"/><path d="m7.5 10 2.5 2.2-2.5 2.2M12.5 15h4"/>',
    bolt: '<path d="M13.5 3 5 13.5h5.5L10 21l8.5-10.5H13z"/>',
    key: '<circle cx="8" cy="12" r="4"/><path d="M12 12h9M17.5 12v3M20 12v2.2"/>',
    globe: '<circle cx="12" cy="12" r="9"/><path d="M3.5 9.5h17M3.5 14.5h17M12 3a15 15 0 0 1 0 18 15 15 0 0 1 0-18z"/>',
    user: '<circle cx="12" cy="8.5" r="3.8"/><path d="M4.8 20a7.4 7.4 0 0 1 14.4 0"/>',
    more: '<circle cx="12" cy="5.5" r="1.4"/><circle cx="12" cy="12" r="1.4"/><circle cx="12" cy="18.5" r="1.4"/>',
    filter: '<path d="M3.5 5.5h17l-6.6 7.6v5.6l-3.8 2v-7.6z"/>',
    refresh: '<path d="M20 11.5A8 8 0 0 0 6.3 6.3L3.5 9"/><path d="M4 12.5a8 8 0 0 0 13.7 5.2l2.8-2.7M3.5 4.5V9H8M20.5 19.5V15H16"/>',
    clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5.3l3.3 2"/>',
    branch: '<circle cx="7" cy="5.5" r="2.5"/><circle cx="7" cy="18.5" r="2.5"/><circle cx="17" cy="9" r="2.5"/><path d="M7 8v8M17 11.5a5.5 5.5 0 0 1-5.5 5.5H9.5"/>',
    layers: '<path d="m12 3.5 8.5 4.3L12 12 3.5 7.8z"/><path d="m3.5 12.2 8.5 4.3 8.5-4.3M3.5 16.4l8.5 4.3 8.5-4.3"/>',
    drag: '<circle cx="9" cy="6" r="1.3"/><circle cx="15" cy="6" r="1.3"/><circle cx="9" cy="12" r="1.3"/><circle cx="15" cy="12" r="1.3"/><circle cx="9" cy="18" r="1.3"/><circle cx="15" cy="18" r="1.3"/>',
    palette: '<path d="M12 3.5a8.5 8.5 0 0 0 0 17c1.4 0 2-.9 2-1.8 0-1.5-1.3-1.8-1.3-3 0-.9.7-1.7 1.8-1.7h1.8A4.2 4.2 0 0 0 20.5 10c0-3.6-3.8-6.5-8.5-6.5z"/><circle cx="7.8" cy="11" r="1.1"/><circle cx="10" cy="7.4" r="1.1"/><circle cx="14.6" cy="7.8" r="1.1"/>',
    keyboard: '<rect x="2.5" y="6" width="19" height="12" rx="2"/><path d="M6.5 10h.01M10 10h.01M13.5 10h.01M17 10h.01M8 14h8"/>',
    chip: '<rect x="7" y="7" width="10" height="10" rx="2"/><path d="M10 7V4M14 7V4M10 20v-3M14 20v-3M7 10H4M7 14H4M20 10h-3M20 14h-3"/><rect x="10.5" y="10.5" width="3" height="3" rx=".5"/>',
  };

  const NS = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(NS, "svg");
  svg.setAttribute("style", "position:absolute;width:0;height:0;overflow:hidden");
  svg.setAttribute("aria-hidden", "true");
  svg.innerHTML = Object.entries(P)
    .map(([k, d]) => `<symbol id="i-${k}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">${d}</symbol>`)
    .join("");

  function mountSprite() {
    if (!document.getElementById("dgm-icons")) {
      svg.id = "dgm-icons";
      (document.body || document.documentElement).appendChild(svg);
    }
  }
  if (document.body) mountSprite();
  else document.addEventListener("DOMContentLoaded", mountSprite);

  /** 生成 <svg class="ico ..."><use href="#i-name"></use></svg> */
  function icon(name, cls) {
    const known = Object.prototype.hasOwnProperty.call(P, name);
    const n = known ? name : "info";
    return `<svg class="ico ${cls || ""}" aria-hidden="true"><use href="#i-${n}"></use></svg>`;
  }

  /** 同 icon，但返回真实 DOM 节点（用于安全拼接场景）。 */
  function iconNode(name, cls) {
    const wrap = document.createElement("span");
    wrap.innerHTML = icon(name, cls);
    return wrap.firstElementChild;
  }

  DGM.icon = icon;
  DGM.iconNode = iconNode;
  DGM.iconNames = Object.keys(P);
})();

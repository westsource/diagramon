// Stage 1d 验收：Excalidraw 内嵌画布 —— 载入 / 变更回写 / 导出 / Mermaid 转换。

async function waitFor(cdp, expr, { timeout = 15000, interval = 200 } = {}) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await cdp.evaluate(`(async () => { try { return !!(${expr}); } catch (e) { return false; } })()`)) return true;
    await new Promise((r) => setTimeout(r, interval));
  }
  return false;
}

const IF = "document.querySelector('#preview-canvas iframe')";

export default async function ({ cdp, check, skip, sleep, log }) {
  await cdp.evaluate("window.DGM.app.newTab('excalidraw')");
  check("Excalidraw 承载 iframe 出现", await waitFor(cdp, `${IF}`, { timeout: 20000 }));

  const ready = await waitFor(cdp, `window.DGM.canvas.isReady('excalidraw') === true`, { timeout: 90000 });
  check("Excalidraw 回 ready（挂载完成）", ready === true);
  if (!ready) {
    skip("Excalidraw 后续断言", "未收到 ready");
    return;
  }

  const mounted = await waitFor(
    cdp,
    `(() => { const w = ${IF}.contentWindow; return !!(w.ExcalidrawApp && w.__excalidrawApi); })()`,
    { timeout: 30000 },
  );
  check("Excalidraw 实例已挂载", mounted === true);

  const domOk = await cdp.evaluate(
    `(() => { const d = ${IF}.contentDocument; return !!d.querySelector('.excalidraw, #root canvas, canvas.excalidraw__canvas'); })()`,
  );
  check("Excalidraw 画布 DOM 已渲染", domOk === true);

  // ---- 打开文件不产生回写（回声抑制）----
  const dirtyAtOpen = await cdp.evaluate(
    "window.DGM.app.state.tabs.find(t => t.id === window.DGM.app.state.activeId).dirty",
  );
  check("刚打开时标签页不脏（回声被抑制）", dirtyAtOpen === false, `dirty=${dirtyAtOpen}`);

  // ---- 画布变更 → 回写正文（走 Excalidraw 自己的 onChange 通路）----
  // 必须等过承载页的回声抑制窗口（挂载/外部载入后 ~900ms 内的事件会被吞掉），
  // 否则这次 updateScene 产生的 onChange 会被当成回声丢弃。
  await sleep(1500);
  const rect = {
    id: "e2e-rect",
    type: "rectangle",
    x: 120,
    y: 120,
    width: 240,
    height: 140,
    angle: 0,
    strokeColor: "#1e1e1e",
    backgroundColor: "transparent",
    fillStyle: "solid",
    strokeWidth: 2,
    strokeStyle: "solid",
    roughness: 1,
    opacity: 100,
    groupIds: [],
    frameId: null,
    roundness: { type: 3 },
    seed: 1,
    version: 1,
    versionNonce: 1,
    isDeleted: false,
    boundElements: null,
    updated: 1,
    link: null,
    locked: false,
  };
  await cdp.evaluate(
    `(() => {
       const w = ${IF}.contentWindow;
       w.__excalidrawApi.updateScene({ elements: [${JSON.stringify(rect)}] });
       return true;
     })()`,
  );

  const wroteBack = await waitFor(
    cdp,
    `(async () => {
       const t = window.DGM.app.state.activeId;
       const b = await DGM.invoke('read_document', { id: t });
       return b.includes('e2e-rect');
     })()`,
    { timeout: 15000, interval: 400 },
  );
  check("画布变更回写到标签正文", wroteBack === true);

  const dirtyAfterEdit = await waitFor(
    cdp,
    "window.DGM.app.state.tabs.find(t => t.id === window.DGM.app.state.activeId).dirty === true",
    { timeout: 8000 },
  );
  check("变更后标签页变脏", dirtyAfterEdit === true);

  // ---- 导出 PNG ----
  const png = await cdp.evaluate("window.DGM.canvas.exportPng('excalidraw', 2, true)");
  check(
    "Excalidraw 页内导出 PNG",
    typeof png === "string" && png.startsWith("data:image/png;base64,") && png.length > 1000,
    `len=${png ? png.length : 0}`,
  );

  // ---- Mermaid → Excalidraw 转换 ----
  const mermaidTabId = await cdp.evaluate("window.DGM.app.state.tabs.find(t => t.format === 'mermaid').id");
  await cdp.evaluate(`window.DGM.app.activateTab(${JSON.stringify(mermaidTabId)})`);
  await sleep(400);
  const newTabId = await cdp.evaluate("window.DGM.app.convertActiveTo('excalidraw')");
  const converted = await waitFor(
    cdp,
    `(async () => {
       const b = await DGM.invoke('read_document', { id: ${JSON.stringify(newTabId)} });
       return b.includes('"elements"') && b.length > 200;
     })()`,
    { timeout: 40000, interval: 500 },
  );
  check("Mermaid 已转换为 Excalidraw 场景", converted === true);

  await cdp.screenshot("target/e2e-stage1d.png");
  log("screenshot -> target/e2e-stage1d.png");
}

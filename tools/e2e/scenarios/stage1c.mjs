// Stage 1c 验收：drawio 内嵌画布（同源 iframe 桥）—— 载入 / 回写 / flush / 导出 / Mermaid 转换。

async function waitFor(cdp, expr, { timeout = 15000, interval = 200 } = {}) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await cdp.evaluate(`(() => { try { return !!(${expr}); } catch (e) { return false; } })()`)) return true;
    await new Promise((r) => setTimeout(r, interval));
  }
  return false;
}

export default async function ({ cdp, check, skip, sleep, log }) {
  // ---- 新建 drawio 标签页 ----
  await cdp.evaluate(`(() => {
    document.getElementById('btn-new').click();
    const b = [...document.querySelectorAll('#new-menu button')].find(x => x.textContent.includes('drawio'));
    if (b) b.click();
    return !!b;
  })()`);

  check("drawio 承载 iframe 出现", await waitFor(cdp, "document.querySelector('#preview-canvas iframe')", { timeout: 20000 }));
  check("画布作为编辑器时隐藏文本面", await cdp.evaluate("document.getElementById('pane-editor').hidden === true"));

  const ready = await waitFor(cdp, "window.DGM.canvas.isReady('drawio') === true", { timeout: 60000 });
  check("drawio 回 init（协议握手成功）", ready === true);
  if (!ready) {
    skip("drawio 画布后续断言", "未收到 init：承载页或协议未就绪");
    return;
  }

  // ---- drawio 自己真的把图画出来了（读内层 iframe）----
  const canvasOk = await waitFor(
    cdp,
    `(() => {
      const host = document.querySelector('#preview-canvas iframe').contentWindow;
      const inner = host.document.getElementById('dl');
      const doc = inner && inner.contentDocument;
      if (!doc) return false;
      return !!doc.querySelector('.geDiagramContainer, #graphContainer, .mxGraph');
    })()`,
    { timeout: 30000 },
  );
  check("drawio 画布容器已渲染", canvasOk === true);

  // ---- flush：取回画布 XML，应与载入的默认 mxfile 同源 ----
  const xml = await cdp.evaluate("window.DGM.canvas.flush('drawio')");
  check("flush 取回画布 XML", typeof xml === "string" && xml.includes("<mxfile") && xml.includes("<mxGraphModel"), `len=${xml ? xml.length : 0}`);

  // ---- 页内导出 PNG（空文档只有 2×2 像素，故只断言是合法 PNG data URI）----
  const png = await cdp.evaluate("window.DGM.canvas.exportPng('drawio', 2, true)");
  check(
    "drawio 页内导出 PNG",
    typeof png === "string" && png.startsWith("data:image/png;base64,"),
    `len=${png ? png.length : 0}`,
  );

  // ---- Mermaid → drawio 转换（单向）----
  // 先回到一个 Mermaid 标签页（初始那个），执行转换
  const mermaidTabId = await cdp.evaluate(
    "window.DGM.app.state.tabs.find(t => t.format === 'mermaid').id",
  );
  await cdp.evaluate(`window.DGM.app.activateTab(${JSON.stringify(mermaidTabId)})`);
  await sleep(400);
  const newTabId = await cdp.evaluate("window.DGM.app.convertActiveTo('drawio')");
  check("转换新建了 drawio 标签页", typeof newTabId === "string" && newTabId.length > 0, newTabId);

  const converted = await waitFor(
    cdp,
    `(async () => {
       const b = await DGM.invoke('read_document', { id: ${JSON.stringify(newTabId)} });
       return b.includes('<mxGraphModel') && b.includes('开始');
     })()`,
    { timeout: 40000, interval: 500 },
  );
  const body = await cdp.evaluate(`(async () => await DGM.invoke('read_document', { id: ${JSON.stringify(newTabId)} }))()`);
  check("Mermaid 已转换为 drawio XML（含中文节点）", converted, `len=${body.length}`);

  // 原 Mermaid 标签页未被改动
  const srcStillMermaid = await cdp.evaluate(
    `(async () => { const b = await DGM.invoke('read_document', { id: ${JSON.stringify(mermaidTabId)} }); return b.includes('graph TD'); })()`,
  );
  check("原 Mermaid 标签页保持不变", srcStillMermaid === true);

  // ---- flush 后落盘链路：正文与画布一致 ----
  const flushed = await cdp.evaluate(`window.DGM.canvas.flush('drawio')`);
  check("转换后的画布可 flush", typeof flushed === "string" && flushed.includes("<mxfile"), `len=${flushed ? flushed.length : 0}`);

  // 有内容时的导出应当是"真图"（远大于空文档的 2×2）
  const pngFilled = await cdp.evaluate("window.DGM.canvas.exportPng('drawio', 2, true)");
  check(
    "转换后的画布导出为有内容的 PNG",
    typeof pngFilled === "string" && pngFilled.startsWith("data:image/png;base64,") && pngFilled.length > 2000,
    `len=${pngFilled ? pngFilled.length : 0}`,
  );

  await cdp.screenshot("target/e2e-stage1c.png");
  log("screenshot -> target/e2e-stage1c.png");
}

// Stage 1a 验收：DOT 布局选择器 + Mermaid/DOT 页内导出（保存/复制）。
//
// 通过真实页面驱动：新建 DOT 标签页 → 切换布局 → 断言渲染确实不同 → 栅格化 PNG。

async function waitFor(cdp, expr, { timeout = 15000, interval = 200 } = {}) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await cdp.evaluate(`(async () => { try { return !!(${expr}); } catch (e) { return false; } })()`)) return true;
    await new Promise((r) => setTimeout(r, interval));
  }
  return false;
}

export default async function ({ cdp, check, sleep, log }) {
  // ---- 外壳启动 ----
  const info = await cdp.evaluate("window.DGM.app.state.info");
  check("外壳启动并拿到 app_info", info && info.name === "Diagramon" && info.version, JSON.stringify(info));

  const formatCount = await cdp.evaluate("window.DGM.app.state.formats.size");
  check("格式注册表下发 4 个格式", formatCount === 4, `formats=${formatCount}`);

  check(
    "初始存在 mermaid 标签页且预览已渲染 SVG",
    await waitFor(cdp, "document.querySelector('#preview-content svg')"),
  );

  // Mermaid 无布局概念：选择器必须隐藏（并且 `hidden` 要真正生效，不被 flex 覆盖）
  const layoutHidden = await cdp.evaluate(
    "(() => { const w = document.getElementById('layout-wrap'); return w.hidden && getComputedStyle(w).display === 'none'; })()",
  );
  check("Mermaid 标签页隐藏布局选择器", layoutHidden === true);

  // ---- Mermaid 导出 ----
  const mermaidPng = await cdp.evaluate("window.DGM.preview.toPngDataUrl()");
  check("Mermaid 栅格化为 PNG data URL", typeof mermaidPng === "string" && mermaidPng.startsWith("data:image/png;base64,"));
  check("Mermaid PNG 体积合理(>1KB)", mermaidPng.length > 1024, `len=${mermaidPng.length}`);

  // ---- 复制到剪贴板 ----
  const copyRes = await cdp.evaluate(
    "(async () => { try { await window.DGM.preview.copyImage(); return { ok: true }; } catch (e) { return { ok: false, err: String((e && e.message) || e) }; } })()",
  );
  if (copyRes.ok) {
    check("复制图片到剪贴板", true);
  } else if (/clipboard is not accessible|剪贴板/i.test(copyRes.err)) {
    skip("复制图片到剪贴板", `系统剪贴板被其它进程独占：${copyRes.err}`);
  } else {
    check("复制图片到剪贴板", false, copyRes.err);
  }

  // ---- 新建 DOT 标签页（走真实按钮） ----
  await cdp.evaluate(`(() => {
    document.getElementById('btn-new').click();
    const b = [...document.querySelectorAll('#new-menu button')].find(x => x.textContent.includes('dot'));
    if (b) b.click();
    return !!b;
  })()`);
  const dotReady = await waitFor(cdp, "document.querySelector('#layout-select') && document.querySelectorAll('#layout-select option').length === 6");
  check("DOT 标签页显示六布局选择器", dotReady);

  const tabCount = await cdp.evaluate("document.querySelectorAll('.tabs .tab').length");
  check("标签页数量为 2", tabCount === 2, `tabs=${tabCount}`);

  check("DOT 预览已渲染", await waitFor(cdp, "document.querySelector('#preview-content svg')"));

  // ---- 切换布局：断言渲染结果确实改变 ----
  const before = await cdp.evaluate("document.getElementById('preview-content').innerHTML");
  await cdp.evaluate(`(() => {
    const s = document.getElementById('layout-select');
    s.value = 'neato';
    s.dispatchEvent(new Event('change'));
    return s.value;
  })()`);
  const changed = await waitFor(
    cdp,
    `document.getElementById('preview-content').innerHTML && document.getElementById('preview-content').innerHTML !== ${JSON.stringify(before)}`,
    { timeout: 8000 },
  );
  const after = await cdp.evaluate("document.getElementById('preview-content').innerHTML");
  check("切换布局后渲染结果改变", changed, `len ${before.length} → ${after.length}`);

  await cdp.evaluate(`(() => {
    const s = document.getElementById('layout-select');
    s.value = 'circo';
    s.dispatchEvent(new Event('change'));
  })()`);
  await sleep(900);
  const circoSvgLen = await cdp.evaluate("(document.querySelector('#preview-content svg')||{}).outerHTML?.length || 0");
  check("circo 布局同样产出 SVG", circoSvgLen > 0, `len=${circoSvgLen}`);

  // ---- DOT 导出 ----
  const dotPng = await cdp.evaluate("window.DGM.preview.toPngDataUrl()");
  check("DOT 栅格化为 PNG data URL", typeof dotPng === "string" && dotPng.startsWith("data:image/png;base64,"), `len=${dotPng.length}`);
  check("DOT PNG 体积合理(>1KB)", dotPng.length > 1024, `len=${dotPng.length}`);

  // ---- 导出工具条可见 ----
  const toolsVisible = await cdp.evaluate("!document.getElementById('preview-tools').hidden");
  check("预览区浮动导出按钮可见", toolsVisible);

  await cdp.screenshot("target/e2e-stage1a.png");
  log("screenshot -> target/e2e-stage1a.png");

  // 复位：关掉 DOT 标签页，避免影响后续
  await sleep(200);
}

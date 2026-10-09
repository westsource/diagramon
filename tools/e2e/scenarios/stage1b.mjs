// Stage 1b 验收：CodeMirror 编辑器（语法高亮 + 行号 + 查找面板）+ 真实键入回到文档模型。

async function waitFor(cdp, expr, { timeout = 15000, interval = 150 } = {}) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await cdp.evaluate(`(() => { try { return !!(${expr}); } catch (e) { return false; } })()`)) return true;
    await new Promise((r) => setTimeout(r, interval));
  }
  return false;
}

export default async function ({ cdp, check, skip, sleep, log }) {
  // ---- 编辑器后端 ----
  const usingCM = await cdp.evaluate("window.DGM.editor.usingCodeMirror()");
  check("编辑器使用 CodeMirror 后端", usingCM === true);
  if (!usingCM) {
    skip("语法高亮/查找面板", "vendor 产物缺失，退回 textarea");
    return;
  }

  check("CodeMirror 已挂载（.cm-editor）", await waitFor(cdp, "document.querySelector('.cm-editor')"));
  check("显示行号（.cm-gutters）", await waitFor(cdp, "document.querySelector('.cm-gutters')"));
  check(
    "默认 Mermaid 正文已载入编辑器",
    await waitFor(cdp, "document.querySelector('.cm-content') && document.querySelector('.cm-content').textContent.includes('graph')"),
  );

  // ---- 语法高亮：断言 token 跨度存在且着色与非高亮文本不同 ----
  await waitFor(cdp, "document.querySelectorAll('.cm-content .cm-line span').length >= 5");
  const hl = await cdp.evaluate(`(() => {
    const spans = [...document.querySelectorAll('.cm-content .cm-line span')];
    const colors = new Set(spans.map(s => getComputedStyle(s).color));
    return { count: spans.length, colors: colors.size };
  })()`);
  check("存在语法 token 跨度", hl.count >= 5, JSON.stringify(hl));
  check("token 使用了多种颜色（高亮生效）", hl.colors >= 2, `colors=${hl.colors}`);

  // ---- 查找/替换面板 ----
  const opened = await cdp.evaluate("window.DGM.editor.openSearch()");
  check("查找面板可打开", opened === true && (await waitFor(cdp, "document.querySelector('.cm-search')")));

  // 面板里确实能做查找：向真实输入框键入，断言命中高亮
  await cdp.evaluate(
    "(() => { const i = document.querySelector('.cm-search input[name=search]'); if (!i) return false; i.focus(); i.select(); return true; })()",
  );
  // 输入查询词后补一次真实 keyUp：CM 的查找面板在 onkeyup 里提交查询
  // （`type:'char'` 不会产生 keyup，所以这里分开做）。
  await cdp.send("Input.insertText", { text: "判断" });
  await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key: "a", code: "KeyA" });
  const hit = await waitFor(cdp, "document.querySelectorAll('.cm-searchMatch').length >= 1", { timeout: 6000 });
  const searchValue = await cdp.evaluate("document.querySelector('.cm-search input[name=search]').value");
  const matches = await cdp.evaluate("document.querySelectorAll('.cm-searchMatch').length");
  check("查找命中高亮", hit && matches >= 1, `query=${JSON.stringify(searchValue)} matches=${matches}`);

  await cdp.evaluate("window.DGM.editor.closeSearch && window.DGM.editor.closeSearch()");

  // ---- 真实键入 → 文档模型变脏 → 预览重渲 ----
  const bodyBefore = await cdp.evaluate(
    "(async () => await DGM.invoke('read_document', { id: DGM.app.state.activeId }))()",
  );
  await cdp.evaluate("window.DGM.editor.focus()");
  await cdp.send("Input.insertText", { text: "%% typed-by-e2e\n" });
  const dirty = await waitFor(cdp, "document.querySelector('.tabs .tab.active .tab-dirty')");
  check("键入后标签页变脏", dirty);

  const bodyAfter = await cdp.evaluate(
    "(async () => await DGM.invoke('read_document', { id: DGM.app.state.activeId }))()",
  );
  check(
    "键入内容进入文档模型",
    bodyAfter.includes("typed-by-e2e") && bodyAfter !== bodyBefore,
    `len ${bodyBefore.length}→${bodyAfter.length}`,
  );

  await cdp.screenshot("target/e2e-stage1b.png");
  log("screenshot -> target/e2e-stage1b.png");
}

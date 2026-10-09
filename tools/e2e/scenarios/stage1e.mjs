// Stage 1e 验收：Mermaid/DOT 语法校验 + 报错行号（预览与状态栏）+ 编辑器定位。

async function waitFor(cdp, expr, { timeout = 15000, interval = 200 } = {}) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await cdp.evaluate(`(async () => { try { return !!(${expr}); } catch (e) { return false; } })()`)) return true;
    await new Promise((r) => setTimeout(r, interval));
  }
  return false;
}

export default async function ({ cdp, check, log }) {
  // ---- 报错解析（纯函数，直接对拍两种渲染器的原始文案）----
  const cases = await cdp.evaluate(`(() => {
    const d = window.DGM.preview.describeError;
    return {
      mermaid: d("Parse error on line 3\\nExpecting 'EOF', got 'NEWLINE'"),
      dot: d("syntax error in line 1 near ';'"),
      none: d("some unrelated failure"),
    };
  })()`);
  check("解析 Mermaid 报错行号", cases.mermaid.line === 3 && cases.mermaid.text.includes("第 3 行"), JSON.stringify(cases.mermaid));
  check("解析 DOT 报错行号", cases.dot.line === 1 && cases.dot.text.includes("第 1 行"), JSON.stringify(cases.dot));
  check("无行号时降级为首行文案", cases.none.line === 0 && cases.none.text.length > 0, JSON.stringify(cases.none));

  // ---- 真实无效 Mermaid：预览与状态栏都要报错并带行号 ----
  await cdp.evaluate("window.DGM.editor.setValue('graph TD\\n  A -- > B')");
  await cdp.evaluate("window.DGM.app.rerender()");

  const errored = await waitFor(cdp, "document.querySelector('.preview-error')", { timeout: 10000 });
  check("无效 Mermaid 在预览区报错", errored === true);

  const previewText = await cdp.evaluate("(document.querySelector('.preview-error')||{}).textContent || ''");
  check("错误文案带行号", /第\s*\d+\s*行/.test(previewText), JSON.stringify(previewText.slice(0, 80)));

  const statusText = await cdp.evaluate("document.getElementById('status-msg').textContent");
  check("状态栏同步报错", /第\s*\d+\s*行/.test(statusText), JSON.stringify(statusText.slice(0, 80)));

  // ---- 修好后恢复正常渲染 ----
  await cdp.evaluate("window.DGM.editor.setValue('graph TD\\n  A[开始] --> B[结束]')");
  await cdp.evaluate("window.DGM.app.rerender()");
  const recovered = await waitFor(cdp, "document.querySelector('#preview-content svg')", { timeout: 10000 });
  check("修正后恢复渲染", recovered === true);

  // ---- 编辑器定位：返回被夹取的行号 ----
  const revealed = await cdp.evaluate("window.DGM.editor.revealLine(99)");
  check("revealLine 把越界行号夹到文档范围内", revealed === 2, `revealed=${revealed}`);

  await cdp.screenshot("target/e2e-stage1e.png");
  log("screenshot -> target/e2e-stage1e.png");
}

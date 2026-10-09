// Stage 2 验收：设置持久化 / 最近文件 / 本地化 / 对话框 / 命令行打开 / 崩溃日志路径。
//
// 场景在模块作用域准备素材（临时 .mmd），并可以在运行中直接读机器上的
// settings.json —— 跑分器与被测应用同机，这比在页面里"假装"验证持久化更硬。

import { writeFile, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const workdir = await mkdtemp(path.join(tmpdir(), "dgm-e2e-stage2-"));
const sample = path.join(workdir, "sample.mmd");
await writeFile(sample, "graph TD\n  X[E2E] --> Y[OK]\n", "utf8");

async function waitFor(cdp, expr, { timeout = 15000, interval = 200 } = {}) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await cdp.evaluate(`(async () => { try { return !!(${expr}); } catch (e) { return false; } })()`)) return true;
    await new Promise((r) => setTimeout(r, interval));
  }
  return false;
}

export default async function ({ cdp, check, skip, sleep, log }) {
  // ---- 菜单栏 ----
  const menuCount = await cdp.evaluate("document.querySelectorAll('#menubar .menubar-item').length");
  const menuLabels = await cdp.evaluate("[...document.querySelectorAll('#menubar .menubar-item')].map(b=>b.textContent)");
  check("菜单栏有三个顶层菜单", menuCount === 3, JSON.stringify(menuLabels));

  // ---- 本地化：切到 en-US，界面与设置文件都要跟着变 ----
  const dirs = await cdp.evaluate("DGM.invoke('app_dirs')");
  const settingsPath = dirs.settings;

  await cdp.evaluate("DGM.i18n.setLang('en-US')");
  await sleep(900); // 设置写入去抖 300ms
  const openLabel = await cdp.evaluate("document.getElementById('btn-open').textContent");
  const fileLabel = await cdp.evaluate("document.querySelectorAll('#menubar .menubar-item')[0].textContent");
  check("切到 en-US 后工具栏文案变化", openLabel === "Open", `open="${openLabel}"`);
  check("切到 en-US 后菜单文案变化", fileLabel === "File", `file="${fileLabel}"`);

  let persisted = null;
  try {
    persisted = JSON.parse(await readFile(settingsPath, "utf8"));
  } catch (e) {
    persisted = null;
  }
  check("语言已落盘到 settings.json", persisted && persisted.language === "en-US", `${settingsPath} → ${persisted && persisted.language}`);

  // 切回中文
  await cdp.evaluate("DGM.i18n.setLang('zh-CN')");
  await sleep(700);
  const backLabel = await cdp.evaluate("document.getElementById('btn-open').textContent");
  check("切回 zh-CN 生效", backLabel === "打开", `open="${backLabel}"`);

  // ---- 编辑器比例持久化 ----
  await cdp.evaluate("DGM.settings.setEditorRatio(0.5)");
  await sleep(700);
  let persisted2 = null;
  try {
    persisted2 = JSON.parse(await readFile(settingsPath, "utf8"));
  } catch (e) {
    persisted2 = null;
  }
  check("编辑器比例已落盘", persisted2 && Math.abs((persisted2.editorRatio ?? 0) - 0.5) < 0.01, `ratio=${persisted2 && persisted2.editorRatio}`);

  // ---- 最近文件：先清空以获得确定状态，打开一个真实文件后被记录 ----
  await cdp.evaluate("DGM.invoke('recent_clear')");
  const tabId = await cdp.evaluate(`window.DGM.app.openPath(${JSON.stringify(sample)}).then(() => window.DGM.app.state.activeId)`);
  check("打开文件产生新标签页", typeof tabId === "string" && tabId.length > 0, tabId);

  const recorded = await waitFor(
    cdp,
    `(async () => { const r = await DGM.invoke('recent_list'); return r.length === 1 && r[0].path.includes('sample.mmd'); })()`,
    { timeout: 8000 },
  );
  check("最近文件已记录（Rust 侧）", recorded === true);
  const recordedPath = await cdp.evaluate("(async () => (await DGM.invoke('recent_list'))[0].path)()");

  const persistedRecent = JSON.parse(await readFile(settingsPath, "utf8"));
  check(
    "最近文件已落盘",
    Array.isArray(persistedRecent.recentFiles) && persistedRecent.recentFiles.some((r) => r.path.includes("sample.mmd")),
  );

  // 菜单里的「最近文件」子菜单能看到它
  const inMenu = await cdp.evaluate(`(async () => {
    await window.DGM.app.refreshRecent();
    window.DGM.app.renderMenu();
    const sub = [...document.querySelectorAll('#menubar .menu-row')].find(r => r.textContent.includes('最近文件'));
    return !!sub;
  })()`);
  check("菜单里有「最近文件」入口", inMenu === true);

  // ---- 打开历史对话框：搜索过滤 + 关闭 ----
  // 打开历史对话框：不要 await —— 它返回的 Promise 只在对话框关闭时结算
  await cdp.evaluate(
    "(() => { window.DGM.dialogs.history(window.DGM.app.state.recent); return true; })()",
  );
  check("历史对话框已弹出", await waitFor(cdp, "!document.querySelector('.modal-overlay').hidden"));
  const hasSearch = await cdp.evaluate("!!document.querySelector('.history-search')");
  check("历史对话框有搜索框", hasSearch === true);

  await cdp.evaluate(`(() => {
    const s = document.querySelector('.history-search');
    s.value = 'zzz-no-match'; s.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  await sleep(200);
  const filteredOut = await cdp.evaluate("document.querySelectorAll('.history-list .history-row').length");
  check("搜索可过滤到空", filteredOut === 0, `rows=${filteredOut}`);
  await cdp.evaluate("document.querySelector('.modal-actions .cancel, .modal-actions button:last-child').click()");
  await sleep(200);
  const closed = await cdp.evaluate("document.querySelector('.modal-overlay').hidden");
  check("历史对话框可关闭", closed === true);

  // ---- 最近文件失效剔除 ----
  await rm(sample, { force: true });
  const afterPrune = await cdp.evaluate("DGM.invoke('recent_prune')");
  check(
    "失效最近文件被剔除",
    Array.isArray(afterPrune) && !afterPrune.some((r) => r.path === recordedPath),
    `n=${afterPrune.length} recorded=${recordedPath}`,
  );

  // ---- 关于 / 操作说明 ----
  await cdp.evaluate("(() => { window.DGM.dialogs.about(window.DGM.app.state.info); return true; })()");
  const aboutTitle = await cdp.evaluate("document.querySelector('.modal-title').textContent");
  const aboutBody = await cdp.evaluate("document.querySelector('.modal-body').textContent");
  check("关于对话框显示版本与平台", aboutTitle === "Diagramon" && aboutBody.includes("2.0.0") && aboutBody.includes("windows"));
  await cdp.evaluate("document.querySelector('.modal-actions button').click()");
  await sleep(200);

  await cdp.evaluate("(() => { window.DGM.dialogs.guide(); return true; })()");
  const guideText = await cdp.evaluate("document.querySelector('.modal-body').textContent");
  check("操作说明有正文", guideText.includes("快捷键") || guideText.includes("Shortcuts"), guideText.slice(0, 40));
  await cdp.evaluate("document.querySelector('.modal-actions button').click()");
  await sleep(200);

  // ---- 崩溃日志路径（写入逻辑由 app-core 单元测试覆盖；这里核对目录被正确报告）----
  check("app_dirs 报告了 cache 目录", typeof dirs.cache === "string" && dirs.cache.includes("Diagramon"), dirs.cache);

  await cdp.screenshot("target/e2e-stage2.png");
  log("screenshot -> target/e2e-stage2.png");
}

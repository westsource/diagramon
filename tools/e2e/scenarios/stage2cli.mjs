// Stage 2 验收（命令行打开）：以文件路径作为参数启动，应用应直接打开它。
//
// 场景在模块作用域声明 `appArgs`（跑分器会在**启动应用之前**读取它）。

import { writeFile, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const workdir = await mkdtemp(path.join(tmpdir(), "dgm-e2e-cli-"));
const target = path.join(workdir, "from-cli.mmd");
await writeFile(target, "graph TD\n  CLI[来自命令行] --> OK[已打开]\n", "utf8");

export const appArgs = [target];

export default async function ({ cdp, check }) {
  const opened = await (async () => {
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline) {
      const ok = await cdp.evaluate(`(async () => {
        const tabs = window.DGM.app.state.tabs;
        return tabs.some(t => (t.path || '').includes('from-cli.mmd'));
      })()`);
      if (ok) return true;
      await new Promise((r) => setTimeout(r, 300));
    }
    return false;
  })();

  check("命令行参数里的文件被打开", opened === true);
  if (opened) {
    const body = await cdp.evaluate("(async () => await DGM.invoke('read_document', { id: window.DGM.app.state.activeId }))()");
    check("标签正文来自该文件", body.includes("来自命令行"), body.slice(0, 40));
  }
}

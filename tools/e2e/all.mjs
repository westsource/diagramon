// 一键跑完所有验收场景并汇总（每个场景单独起停应用）。
//
//   node tools/e2e/all.mjs [场景名...]      # 默认跑 scenarios/ 下全部 *.mjs
//
// 退出码：有 FAIL 时为 1。

import { readdir } from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const scenarioDir = path.join(here, "scenarios");

async function pick() {
  if (process.argv.length > 2) return process.argv.slice(2).map((s) => `${s}.mjs`);
  const files = await readdir(scenarioDir);
  return files.filter((f) => f.endsWith(".mjs")).sort();
}

function run(scenario) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(here, "run.mjs"), path.join(scenarioDir, scenario)], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    child.stdout.on("data", (b) => (out += b.toString()));
    child.stderr.on("data", (b) => (out += b.toString()));
    child.on("close", (code) => resolve({ scenario, code, out }));
  });
}

const scenarios = await pick();
let failed = 0;

for (const scenario of scenarios) {
  const { code, out } = await run(scenario);
  const verdict = (out.match(/^VERDICT.*$/m) || ["VERDICT|(未产出，可能崩溃)"])[0];
  const fails = out.split("\n").filter((l) => l.startsWith("FAIL "));
  console.log(`\n===== ${scenario} =====`);
  console.log(verdict);
  for (const f of fails) console.log(f);
  if (code !== 0) failed += 1;
}

console.log(`\n########## 汇总：${scenarios.length - failed}/${scenarios.length} 个场景通过 ##########`);
process.exit(failed ? 1 : 0);

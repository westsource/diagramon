#!/usr/bin/env node
/**
 * Diagramon 一条命令验收（第 1 步的产物）
 *
 *   node tools/dev/check.mjs            全量：单测 + 真机自检
 *   node tools/dev/check.mjs --skip-test  只跑真机自检（省时间）
 *   node tools/dev/check.mjs --test-only  只跑单测
 *
 * 为什么需要它 —— 这条链路上有三个反复踩的坑，每次手搓都会再踩一遍：
 *   1. 上一个实例还开着 ⇒ 链接失败报 `Permission denied`，看起来像代码错了；
 *   2. 忘了删旧的 selftest 报告 ⇒ 读到的是上一次的结果，误判成"没修好"；
 *   3. WebView2 对后台窗口把 setTimeout 节流到约 1 次/秒 ⇒ 自检里不能用定时器轮询界面
 *      （这是前端那一侧要守的规矩，本脚本负责把结论如实报出来）。
 *
 * 退出码：0 = 全绿；1 = 有失败；2 = 基础设施问题（构建失败 / 报告没产出）。
 */

import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SHOTS = join(ROOT, "ui", ".shots");
const REPORT = join(SHOTS, "selftest-report.json");
const APP_LOG = join(SHOTS, "app.log");

const EXE = process.platform === "win32"
  ? join(ROOT, "target", "debug", "diagramon.exe")
  : join(ROOT, "target", "debug", "diagramon");

const args = process.argv.slice(2);
const skipTest = args.includes("--skip-test");
const testOnly = args.includes("--test-only");

const C = {  // 只在 TTY 上上色，避免日志里出现乱码
  on: process.stdout.isTTY,
  dim: (s) => (process.stdout.isTTY ? `\x1b[2m${s}\x1b[0m` : s),
  red: (s) => (process.stdout.isTTY ? `\x1b[31m${s}\x1b[0m` : s),
  green: (s) => (process.stdout.isTTY ? `\x1b[32m${s}\x1b[0m` : s),
  bold: (s) => (process.stdout.isTTY ? `\x1b[1m${s}\x1b[0m` : s),
};
void C.on;

const log = (s = "") => process.stdout.write(`${s}\n`);
const step = (s) => log(`\n${C.bold("▸ " + s)}`);

/** 跑一条命令并继承 stdio；返回退出码。 */
function run(cmd, argv, opts = {}) {
  const r = spawnSync(cmd, argv, { cwd: ROOT, stdio: "inherit", shell: process.platform === "win32", ...opts });
  return r.status ?? 1;
}

/** 杀掉可能残留的实例（否则链接会 Permission denied）。 */
function killStale() {
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/IM", "diagramon.exe", "/F"], { stdio: "ignore", shell: true });
  } else {
    spawnSync("pkill", ["-f", "target/debug/diagramon"], { stdio: "ignore" });
  }
}

/** 等文件出现，并连续两次读到相同大小（说明写完了）。 */
async function waitForReport(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastSize = -1;
  while (Date.now() < deadline) {
    if (existsSync(REPORT)) {
      const size = readFileSync(REPORT).length;
      if (size > 0 && size === lastSize) {
        try {
          return JSON.parse(readFileSync(REPORT, "utf8"));
        } catch {
          /* 还在写，继续等 */
        }
      }
      lastSize = size;
    }
    await new Promise((r) => setTimeout(r, 400));
  }
  return null;
}

/** 自检超时/写盘失败时，把落下的阶段标记念出来 —— 不然失败现场什么也看不到。 */
function dumpDiagnostics() {
  const marks = [
    ["enter", "selftest-report.enter.json"],
    ["phase", "selftest-report.phase.json"],
    ["timeout", "selftest-report.timeout.json"],
    ["assert-error", "selftest-report.err.json"],
  ];
  const found = marks.filter(([, f]) => existsSync(join(SHOTS, f)));
  if (found.length) {
    log(C.dim("  前端落下的阶段标记："));
    for (const [, f] of found) log(C.dim(`    ${f}: ${readFileSync(join(SHOTS, f), "utf8").slice(0, 400)}`));
  } else {
    log(C.dim("  （前端连标记都没落下 ⇒ 页面没跑起来或没走到自检）"));
  }
  if (existsSync(APP_LOG)) {
    const tail = readFileSync(APP_LOG, "utf8").trim().split("\n").slice(-15).join("\n");
    if (tail) log(C.dim("  应用日志尾部：\n" + tail.replace(/^/gm, "    ")));
  }
}

async function main() {
  if (!testOnly) {
    step("杀掉残留实例（否则构建会卡在 Permission denied）");
    killStale();
    // 等久一点：被杀的实例还会带一串 msedgewebview2 子进程，它们松手前
    // 新实例可能卡在 WebView2 的 user-data 目录上（实测表现为页面 load 事件都不来）
    await new Promise((r) => setTimeout(r, 2500));
  }

  step("构建 diagramon");
  if (run("cargo", ["build", "-p", "diagramon", "--message-format", "short"]) !== 0) {
    log(C.red("构建失败 —— 先修编译错误"));
    process.exit(2);
  }
  if (!existsSync(EXE)) {
    log(C.red(`没找到可执行文件：${EXE}`));
    process.exit(2);
  }

  if (!testOnly) {
    step("Rust 纯逻辑单测");
    const testArgs = ["test", "-p", "app-ipc", "-p", "app-core", "-p", "assets", "-p", "platform", "-p", "platform-windows", "-p", "ai", "--message-format", "short"];
    if (run("cargo", testArgs) !== 0) {
      log(C.red("单测失败"));
      process.exit(1);
    }
  }
  if (testOnly) {
    log(C.green("\n✓ 单测通过"));
    process.exit(0);
  }

  step("真机自检（启动客户端 → 前端跑真实 IPC 断言 → 落盘报告）");
  mkdirSync(SHOTS, { recursive: true });
  rmSync(REPORT, { force: true });
  for (const f of ["enter", "phase", "timeout", "err", "fallback"]) {
    rmSync(join(SHOTS, `selftest-report.${f}.json`), { force: true });
  }

  const app = spawn(EXE, [], {
    cwd: ROOT,
    env: { ...process.env, DIAGRAMON_SELFTEST: "1", DIAGRAMON_SELFTEST_REPORT: REPORT },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let appOut = "";
  app.stdout.on("data", (b) => (appOut += b));
  app.stderr.on("data", (b) => (appOut += b));

  const report = await waitForReport(Number(process.env.DGM_SELFTEST_TIMEOUT || 120_000));
  killStale();
  app.kill();

  // 应用日志留一份，失败时好用
  try {
    const { writeFileSync } = await import("node:fs");
    writeFileSync(APP_LOG, appOut, "utf8");
  } catch {
    /* 日志写不进去不影响结论 */
  }

  if (!report) {
    log(C.red("自检报告没产出（60s 超时）"));
    dumpDiagnostics();
    process.exit(2);
  }

  log("");
  for (const r of report.results) {
    log(`  ${r.pass ? C.green("PASS") : C.red("FAIL")}  ${r.name}${r.extra == null ? "" : C.dim(`  ${JSON.stringify(r.extra)}`)}`);
  }
  log("");
  const ok = report.pass === report.total;
  log(`${C.bold(`${report.pass}/${report.total}`)} ${ok ? C.green("✓ 全绿") : C.red("✗ 有失败")}`);
  if (!ok) {
    log(C.dim(`  失败项：${report.failed.join(" · ")}`));
    if (appOut) log(C.dim("  应用日志尾部：\n" + appOut.trim().split("\n").slice(-15).join("\n").replace(/^/gm, "    ")));
  }
  process.exit(ok ? 0 : 1);
}

main().catch((e) => {
  log(C.red(`脚本自身出错：${e && e.stack}`));
  process.exit(2);
});

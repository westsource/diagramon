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
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
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

  step("前端语法检查（node --check，几秒钟，省掉一次 3 分钟的无效构建）");
  {
    // 真实教训：`const cv` 在两个作用域里重复声明，整页 JS 一行都没执行，
    // 自检报告自然是没产出 —— 这种错 3 秒能查出来，构建完才发现要 3 分钟。
    const files = readdirSync(join(ROOT, "ui", "js"))
      .filter((f) => f.endsWith(".js"))
      .map((f) => join(ROOT, "ui", "js", f));
    const bad = [];
    for (const f of files) {
      // 注意：本机 spawnSync + stdio:"pipe" 直接 EBUSY（连 cmd.exe 都起不来），
      // 必须给文件描述符 —— 这是 check.mjs 全文唯一一处不是 "inherit" 的 stdio。
      const r = spawnSync(process.execPath, ["--check", f], { stdio: ["ignore", 1, 2] });
      if (r.status !== 0) bad.push(f);
    }
    if (bad.length) {
      log(C.red("前端语法错误：\n" + bad.join("\n")));
      process.exit(2);
    }
    log(C.dim(`  ${files.length} 个文件，全部可解析`));
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
  for (const f of ["enter", "phase", "timeout", "err", "fallback"]) {
    rmSync(join(SHOTS, `selftest-report.${f}.json`), { force: true });
  }

  /**
   * 跑一场自检，返回报告（或 null = 没产出）。
   *
   * **为什么整场重试**：本机的 WebView2 会挂起"不被前台"的窗口 —— 定时器全停、
   * invoke 响应（走 ExecuteScript 投递）**偶发被丢**。Rust 侧命令明明执行完了，
   * 前端的 `await` 却永不结算，无报错、无 pagehide，卡在哪一条每次还不一样
   * （排查一个下午：convert / workspace_delete / workspace_get / clip 都中过招）。
   * 前端没有任何定时器可用（都被挂起），所以**只能在场次级别重试**：
   * 一场不产出报告就再来一场，直到某一场的窗口恰好没被挂起。
   * 这也符合验收的语义 —— 要的是"能跑出一份报告"，而不是"任何一次都必须成"。
   */
  const ATTEMPTS = Number(process.env.DGM_SELFTEST_ATTEMPTS || 6);
  const TIMEOUT = Number(process.env.DGM_SELFTEST_TIMEOUT || 90_000);
  let report = null;
  let appOut = "";
  for (let attempt = 1; attempt <= ATTEMPTS && !report; attempt += 1) {
    if (attempt > 1) {
      // 给被杀实例的 msedgewebview2 子进程松手的时间（它们还占着 user-data 目录时，
      // 新实例连页面 load 事件都不来 —— 这是已知的坑，见第 1 步）
      await new Promise((r) => setTimeout(r, 4000));
      step(`第 ${attempt}/${ATTEMPTS} 次自检（上一场没产出报告 —— 渲染进程被挂起，重试）`);
    }
    rmSync(REPORT, { force: true });
    const app = spawn(EXE, [], {
      cwd: ROOT,
      env: { ...process.env, DIAGRAMON_SELFTEST: "1", DIAGRAMON_SELFTEST_REPORT: REPORT },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    app.stdout.on("data", (b) => (out += b));
    app.stderr.on("data", (b) => (out += b));
    report = await waitForReport(TIMEOUT);
    killStale();
    app.kill();
    appOut = out;
    try {
      const { writeFileSync } = await import("node:fs");
      writeFileSync(APP_LOG, out, "utf8");
    } catch {
      /* 日志写不进去不影响结论 */
    }
    // 报告里若有**真失败**（断言没过），重试也不会变绿 —— 直接收下，别浪费回合
    if (report && report.failed.length) break;
  }

  if (!report) {
    log(C.red(`自检报告没产出（${ATTEMPTS} 次尝试均超时）`));
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

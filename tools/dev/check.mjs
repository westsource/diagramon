#!/usr/bin/env node
/**
 * Diagramon 一条命令验收（第 1 步的产物）
 *
 *   node tools/dev/check.mjs            全量：单测 + 真机自检
 *   node tools/dev/check.mjs --skip-test  只跑真机自检（省时间）
 *   node tools/dev/check.mjs --test-only  只跑单测（不跑真机自检）
 *
 * 环境变量：
 *   DGM_PYTHON             ui_probe 用的解释器（默认自动找 `python` / `py -3` / `python3`，
 *                          且**必须能 `import websocket`**；找不到就跳过那一步）
 *   DGM_SELFTEST_ATTEMPTS  真机自检整场重试次数（默认 6）
 *   DGM_SELFTEST_TIMEOUT   单场等报告的超时毫秒数（默认 90000）
 *
 * 整场输出会留一份到 `ui/.shots/check.log` —— 终端被关掉/滚走了也还能查。
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
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
  yellow: (s) => (process.stdout.isTTY ? `\x1b[33m${s}\x1b[0m` : s),
  bold: (s) => (process.stdout.isTTY ? `\x1b[1m${s}\x1b[0m` : s),
};
void C.on;

/**
 * 把整场输出留一份到磁盘。
 *
 * 教训（2026-10-11 实测）：脚本在第 4 步的**错误分支**里调用了一个不存在的颜色助手
 * （`C.yellow`），于是 `TypeError` 直接把整场带走 —— 终端上只有一行栈、退出码 2，
 * 而磁盘上**一点痕迹都没有**（旧报告还在，看起来像"跑过了、50/50 全绿"）。
 * 有这份日志，"跑完到底跑到哪一步"就是可查的，不必靠回忆终端。
 */
const LOG_FILE = join(SHOTS, "check.log");
/** 被跳过的步骤（最后要如实列出来 —— "跳过"混在"全绿"里看，等于报了个假绿）。 */
const skipped = [];
let logBuf = "";
process.on("exit", () => {
  try {
    mkdirSync(SHOTS, { recursive: true });
    writeFileSync(LOG_FILE, logBuf, "utf8");
  } catch {
    /* 日志写不进去不影响结论 */
  }
});

const log = (s = "") => {
  logBuf += `${s}\n`;
  process.stdout.write(`${s}\n`);
};
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

/**
 * 找一个**真能跑**的 Python 解释器（返回 argv 数组，找不到返回 null）。
 *
 * 为什么不能直接 `python`：Windows PowerShell 里 `python` 常被微软商店的占位程序截胡 ——
 * 命令"存在"，但只会打印 `Python was not found` 并以非 0 退出（实测 9009）。
 * 所以候选要**真的试跑一次 import**，而不是看命令在不在。
 *
 * 试的是 `import websocket` 而不是 `-c pass`：ui_probe 要的就是这个包，
 * 能起解释器但缺包等于白起 —— 那一步会以更难懂的姿态倒下。
 */
function findPython() {
  const cands = [];
  if (process.env.DGM_PYTHON) cands.push([process.env.DGM_PYTHON]);
  if (process.platform === "win32") {
    cands.push(["python"], ["py", "-3"], ["python3"]);
  } else {
    cands.push(["python3"], ["python"]);
  }
  for (const c of cands) {
    const r = spawnSync(c[0], [...c.slice(1), "-c", "import websocket"], {
      stdio: "ignore",
      shell: process.platform === "win32",
    });
    if (r.status === 0) return c;
  }
  return null;
}

/** 等文件出现，并连续两次读到相同大小（说明写完了）。 */async function waitForReport(timeoutMs) {
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

/**
 * 构建。
 *
 * **失败要重试一次，而且第二次先 `cargo clean -p`**：本机（rustc 1.99.0 · x86_64-pc-windows-gnu）
 * 偶发 ICE —— `rustc_metadata\src\rmeta\encoder.rs` panic、退出码 101、`query stack during panic`
 * 是空的，同一份**没改过**的代码重跑就过（2026-10-11 实测：同一次会话里前面成功、中间失败、
 * 之后又成功）。不重试的话，验收脚本会被一个与代码无关的抖动拦住，
 * 而人看到"构建失败 —— 先修编译错误"只会掉头去查源码，白掉一段时间。
 */
function build() {
  const argv = ["build", "-p", "diagramon", "--message-format", "short"];
  if (run("cargo", argv) === 0) return true;
  log(C.yellow("  构建失败，第二次先清掉该 crate 的增量产物再试（本机偶发 rustc ICE，通常与代码无关）"));
  run("cargo", ["clean", "-p", "diagramon"]);
  if (run("cargo", argv) === 0) {
    log(C.yellow("  重试成功 —— 刚才那次是编译器抖动，不是代码问题"));
    skipped.push("第一次构建（rustc ICE，重试后通过）");
    return true;
  }
  return false;
}

async function main() {
  // 无条件杀残留：**任何**模式都会走到"构建"那一步，而实例开着就会让链接失败。
  // （原来只在非 --test-only 时杀，于是 `--test-only` 若碰上实例开着会报
  // Permission denied —— 看起来像代码错了。）
  {
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

  // UI 交互冒烟：语法对 ≠ 页面活着。dialogs.js 曾因一个导出引用了已删除的函数，
  // 模块求值即抛 → DGM.dialogs 整个没赋值 → 所有对话框（含退出确认）在真机上全灭，
  // 而语法检查、Rust 单测、甚至真机自检（不点对话框）全都是绿的。
  // ui_probe.py 用浏览器原型（mock 后端）抓启动异常 + 程序化点击菜单。
  step("i18n 引用完整性（t() 用到的键必须在 ZH/EN 都存在；动态前缀在白名单）");
  {
    const i18n = readFileSync(join(ROOT, "ui", "js", "i18n.js"), "utf8");
    const keysOf = (n) => {
      const i = i18n.indexOf("const " + n + " = {");
      const j = i18n.indexOf("\n  };", i);
      const body = i18n.slice(i, j);
      return new Set([...body.matchAll(/^\s*"([^"]+)":/gm)].map((m) => m[1]));
    };
    const ZH = keysOf("ZH"), EN = keysOf("EN");
    const used = new Set();
    for (const f of readdirSync(join(ROOT, "ui", "js")).filter((f) => f.endsWith(".js"))) {
      const code = readFileSync(join(ROOT, "ui", "js", f), "utf8");
      if (f === "i18n.js") continue;
      for (const m of code.matchAll(/\bt\(\s*"([^"]+)"/g)) used.add(m[1]);
    }
    // 动态拼接前缀（t("side." + view) 等）按前缀放行 —— 前缀下的键由单测/探针覆盖
    const dynamic = [...used].filter((k) => k.endsWith("."));
    const statics = [...used].filter((k) => !k.endsWith("."));
    const miss = statics.filter((k) => !ZH.has(k) || !EN.has(k));
    if (miss.length) {
      log(C.red("i18n 缺键（运行时会显示裸键名）：\n" + miss.join("\n")));
      process.exit(2);
    }
    log(C.dim(`  静态键 ${statics.length} 个全覆盖；动态前缀 ${dynamic.length} 个（${dynamic.join(", ")}）`));
  }

  step("UI 交互冒烟（浏览器原型：启动异常 / 菜单可点 / 分屏比例 / 标签挤压）");
  {
    const py = findPython();
    if (!py) {
      // 环境缺件**不是**代码的问题：不拦验收，但把"装什么、怎么指路"说清楚 ——
      // 原来这里只写"环境不可用"，用户看到等于没说。
      log(C.yellow("  （跳过 ui_probe：没找到带 websocket-client 的 Python）"));
      log(C.yellow("    试过：python / py -3 / python3。装依赖：<解释器> -m pip install websocket-client"));
      log(C.yellow("    或显式指定：DGM_PYTHON=<python.exe 的路径> node tools/dev/check.mjs"));
      skipped.push("UI 交互冒烟（ui_probe）");
    } else {
      const r = spawnSync(py[0], [...py.slice(1), "tools/dev/ui_probe.py"], {
        cwd: ROOT,
        stdio: "inherit",
        shell: process.platform === "win32",
        timeout: 180_000,
      });
      if (r.status === 1) {
        // 断言失败：UI 真的死了，拦下整场验收
        log(C.red("UI 交互冒烟失败（见上方输出）"));
        process.exit(2);
      }
      if (r.status !== 0) {
        log(C.yellow(`  （ui_probe 起不来，退出码 ${r.status}，跳过 —— 上面的输出是现场）`));
        skipped.push("UI 交互冒烟（ui_probe 起不来）");
      }
    }
  }

  step("构建 diagramon");
  if (!build()) {
    log(C.red("构建失败 —— 两次都不行。日志里若有 `rustc' panicked at … rmeta\\encoder.rs`，"));
    log(C.red("那是编译器 ICE（与代码无关）：先 `cargo clean -p diagramon` 或 `cargo build` 手动重跑一次。"));
    process.exit(2);
  }
  if (!existsSync(EXE)) {
    log(C.red(`没找到可执行文件：${EXE}`));
    process.exit(2);
  }

  // 默认跑单测；`--skip-test` 才跳过。
  // **`--test-only` 不等于"跳过单测"** —— 它的语义是"只跑单测、不跑真机自检"。
  // 原来这里写成 `if (!testOnly)`，于是 `--test-only` 一条单测都没跑却打印
  // "✓ 单测通过"（2026-10-11 修）：最坏的 bug 是**报了个假绿**。
  if (!skipTest) {
    step("Rust 纯逻辑单测");
    const testArgs = ["test", "-p", "app-ipc", "-p", "app-core", "-p", "assets", "-p", "platform", "-p", "platform-windows", "-p", "ai", "--message-format", "short"];
    if (run("cargo", testArgs) !== 0) {
      log(C.red("单测失败"));
      process.exit(1);
    }
  } else {
    skipped.push("Rust 单测（--skip-test）");
  }
  if (testOnly) {
    log(C.green(skipTest ? "\n✓ 完成（--test-only 与 --skip-test 同时给了，两边都跳过）" : "\n✓ 单测通过（--test-only：未跑真机自检）"));
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
      writeFileSync(APP_LOG, out, "utf8");
    } catch {
      /* 日志写不进去不影响结论 */
    }
    // 报告里若有**真失败**（断言没过），重试也不会变绿 —— 直接收下，别浪费回合
    if (report && report.failed.length) break;
  }

  if (!report) {
    log(C.red(`自检报告没产出（${ATTEMPTS} 次尝试均超时）`));
    if (skipped.length) log(C.yellow(`  ⚠ 另有步骤被跳过：${skipped.join(" · ")}`));
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
  if (skipped.length) {
    log(C.yellow(`  ⚠ 有步骤被跳过（不等于验过）：${skipped.join(" · ")}`));
  }
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

// Diagramon 端到端验收跑分器。
//
// 原理：以 `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=<PORT>` 启动应用，
// 通过 CDP 连到窗口里的 WebView2 页面，直接在真实页面上执行断言与交互 —— 不依赖桌面输入注入，
// 也不依赖人工点击。这与阶段 0 spike 的页面级验证同一手法。
//
// 用法：
//   node tools/e2e/run.mjs <scenario.mjs> [app.exe]
// 环境变量：
//   CDP_PORT   调试端口（默认 9222）
//   APP        可执行文件路径（默认 target/debug/diagramon.exe）
//   KEEP_OPEN  跑完不杀进程（调试用）

import { spawn } from 'node:child_process';
import { setTimeout as sleep } from "node:timers/promises";
import { writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import path from "node:path";

const PORT = Number(process.env.CDP_PORT || 9222);
const APP = process.env.APP || process.argv[3] || "target/debug/diagramon.exe";
const SCENARIO = process.argv[2];

if (!SCENARIO) {
  console.error("用法: node tools/e2e/run.mjs <scenario.mjs> [app.exe]");
  process.exit(2);
}

class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    ws.addEventListener("message", (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(`${msg.error.message} (${msg.error.code})`));
        else resolve(msg.result);
      }
    });
  }

  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`CDP 超时: ${method}`));
        }
      }, 30000);
    });
  }

  /** 在页面里执行表达式（支持 await）；返回值按值返回。 */
  async evaluate(expression) {
    const res = await this.send("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (res.exceptionDetails) {
      const d = res.exceptionDetails;
      throw new Error(`页面异常: ${d.exception?.description || d.text}`);
    }
    return res.result?.value;
  }

  async screenshot(file) {
    const res = await this.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
    await writeFile(file, Buffer.from(res.data, "base64"));
    return file;
  }
}

async function findPage() {
  for (let i = 0; i < 80; i += 1) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      const page = list.find((t) => t.type === "page" && /dgm\.localhost|dgm:\/\//.test(t.url));
      if (page && page.webSocketDebuggerUrl) return page;
    } catch {
      /* 端口还没起来 */
    }
    await sleep(250);
  }
  throw new Error("未找到 WebView2 调试目标（端口未就绪或页面未加载）");
}

const checks = [];
function check(name, ok, detail = "") {
  checks.push({ name, ok: Boolean(ok), detail });
  console.log(`${ok ? "PASS" : "FAIL"} | ${name}${detail ? ` | ${detail}` : ""}`);
}

/** 环境导致的无法判定项：既不算通过也不算失败，单独计数并在结论里点名。 */
function skip(name, reason) {
  checks.push({ name, skip: true, detail: reason });
  console.log(`SKIP | ${name} | ${reason}`);
}

async function main() {
  const env = { ...process.env, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${PORT}` };
  // 让应用从仓库工作树取 ui/ 与旧资产树（与开发运行一致）。
  delete env.DIAGRAMON_UI_DIR;
  const child = spawn(APP, [], { env, stdio: ["ignore", "pipe", "pipe"] });
  const logs = [];
  child.stdout.on("data", (b) => logs.push(b.toString()));
  child.stderr.on("data", (b) => logs.push(b.toString()));

  let exitCode = 0;
  try {
    const page = await findPage();
    const ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      ws.addEventListener("open", resolve, { once: true });
      ws.addEventListener("error", reject, { once: true });
    });
    const cdp = new Cdp(ws);
    await cdp.send("Page.enable");

    // 等外壳启动完成：DGM 就绪 **且** 初始标签页已建立（boot 是异步的）
    for (let i = 0; i < 80; i += 1) {
      const ready = await cdp.evaluate(
        "!!window.DGM && !!window.DGM.app && window.DGM.app.state.tabs.length >= 1 && !!document.querySelector('.tabs .tab')",
      );
      if (ready) break;
      await sleep(250);
    }

    const scenario = await import(pathToFileURL(path.resolve(SCENARIO)).href);
    const ctx = {
      cdp,
      check,
      sleep,
      log: (...a) => console.log("[scenario]", ...a),
      shot: (file) => cdp.screenshot(file),
      skip,
      sleepMs: sleep,
    };
    await scenario.default(ctx);

    const failed = checks.filter((c) => !c.ok && !c.skip);
    const skipped = checks.filter((c) => c.skip);
    const passed = checks.filter((c) => c.ok);
    console.log(`\nVERDICT|PASS=${passed.length} FAIL=${failed.length} SKIP=${skipped.length}`);
    for (const s of skipped) console.log(`SKIP\n  - ${s.name}: ${s.detail}`);
    exitCode = failed.length ? 1 : 0;
  } catch (e) {
    console.error("harness error:", e?.stack || e);
    console.error("---- app output ----\n" + logs.join(""));
    exitCode = 3;
  } finally {
    if (!process.env.KEEP_OPEN) child.kill();
  }
  process.exit(exitCode);
}

main();

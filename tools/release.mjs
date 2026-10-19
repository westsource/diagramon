#!/usr/bin/env node
/**
 * Diagramon 发布脚本 —— **唯一的发版入口**。
 *
 * 规则真源：`AGENTS.md`（给 agent 的项目规则）+ `docs/发布检查单.md`（人读的细节）。
 * 本脚本把"顺序"与"红线"写进代码：绕开它手工发版 = 这些校验一个都不会跑。
 *
 *   node tools/release.mjs <版本> [选项]
 *
 * 选项
 *   --from=<步骤>     从某步开始跑到最后（断点续跑，构建 25 分钟时很有用）
 *   --only=<步骤>     只跑某一步
 *   --dry-run         只打印将要执行的命令/请求，不改任何东西、不发任何请求
 *   --skip-gate       跳过"真机自检报告必须比源码新"的门禁（会在日志里记警告）
 *   --no-portable     不产便携版 ZIP（不推荐：公开发版要带）
 *   --branch=<名>     主分支名，默认 main
 *   --keys=<目录>     签名密钥目录，默认 ../keys（相对 client2）
 *   --list-steps      列出步骤
 *   --help
 *
 * 步骤（按顺序）
 *   preflight  prepack  build  portable  manifest  tag  branches  push  publish  verify
 */
import { spawn, spawnSync } from "node:child_process";
import {
  appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync,
  readdirSync, rmSync, statSync, writeFileSync,
} from "node:fs";
import { dirname, join, resolve, basename } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SELF = process.execPath;              // 子进程一律用当前这个 node，别赌 PATH
const KEYS_DEFAULT = resolve(ROOT, "..", "keys");
const TAURI_CLI = resolve(ROOT, "..", ".tooling", "node_modules", "@tauri-apps", "cli", "tauri.js");
const SEVEN_ZIP = "C:\\Program Files\\7-Zip\\7z.exe";

const CFG = {
  repo: "westsource/diagramon",             // 两端仓库路径相同
  ghProxy: process.env.DGM_GIT_PROXY || "socks5h://127.0.0.1:1080",
  giteeRemote: "gitee",
  originRemote: "origin",
};

// 附件上传走 socks5 代理，实测约 130 KB/s ⇒ 62 MiB 要 8 分钟以上，900s 的总超时太紧
// （2026-10-19 实测被 --max-time 砍掉一次，curl 无输出导致报错成了 "HTTP NaN"）。
// 上传不能续传，所以失败后要**先删同名残留再重传**（见 uploadAsset）。
const UPLOAD_TIMEOUT_S = 1800;
const UPLOAD_ATTEMPTS = 3;

const STEPS = ["preflight", "prepack", "build", "portable", "manifest", "tag", "branches", "push", "publish", "verify"];

// ── 参数 ──────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const opts = { dryRun: false, skipGate: false, portable: true, moveTag: false, bodyOnly: false, createIfMissing: false, branch: "main", keys: KEYS_DEFAULT, from: null, only: null };
let rawVersion = null;
for (const a of argv) {
  if (a === "--help" || a === "-h") { printHelp(); process.exit(0); }
  else if (a === "--list-steps") { console.log(STEPS.join("  ")); process.exit(0); }
  else if (a === "--dry-run") opts.dryRun = true;
  else if (a === "--skip-gate") opts.skipGate = true;
  else if (a === "--no-portable") opts.portable = false;
  else if (a === "--move-tag") opts.moveTag = true;
  else if (a === "--body-only") opts.bodyOnly = true;
  else if (a === "--create-if-missing") opts.createIfMissing = true;
  else if (a.startsWith("--from=")) opts.from = a.slice(7);
  else if (a.startsWith("--only=")) opts.only = a.slice(7);
  else if (a.startsWith("--branch=")) opts.branch = a.slice(9);
  else if (a.startsWith("--keys=")) opts.keys = resolve(a.slice(7));
  else if (a.startsWith("-")) { console.error(`未知选项：${a}`); process.exit(2); }
  else if (rawVersion === null) rawVersion = a;
  else { console.error(`多余的参数：${a}`); process.exit(2); }
}
if (!rawVersion) { console.error("用法：node tools/release.mjs <版本>  例：node tools/release.mjs 3.0.1\n--help 看全部选项。"); process.exit(2); }
const VERSION = rawVersion.replace(/^v/, "");
const TAG = `v${VERSION}`;

// ── 日志 ──────────────────────────────────────────────────────────────────
const LOG_DIR = join(ROOT, "var", "release-logs");
const TMP_DIR = join(LOG_DIR, "tmp");
mkdirSync(TMP_DIR, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const LOG_FILE = join(LOG_DIR, `release-${VERSION}-${stamp}.log`);
const logFd = openSync(LOG_FILE, "a");

function stamp2() { return new Date().toISOString().slice(11, 19); }
function log(msg) { const line = `[${stamp2()}] ${msg}`; console.log(line); appendFileSync(LOG_FILE, line + "\n"); }
function warn(msg) { log(`⚠️  ${msg}`); }
function die(msg) { log(`❌ ${msg}`); appendFileSync(LOG_FILE, "失败退出\n"); console.error(`\n出错：${msg}\n日志：${LOG_FILE}`); process.exit(1); }
function step(title) { log(""); log(`━━ ${title} ━━`); }

if (!/^\d+\.\d+\.\d+$/.test(VERSION)) die(`版本号要形如 3.0.1（收到 "${rawVersion}"）`);

// ── 子进程 ────────────────────────────────────────────────────────────────
let capSeq = 0;
/**
 * 同步捕获输出。走临时文件而不是 pipe —— 本机沙箱下 spawnSync+pipe 会 EBUSY。
 *
 * ⚠️ **stdout 与 stderr 必须分开写**（各一个 fd）。合并写会出人命：`git rev-list -n1 v9.9.9`
 * 在 tag 不存在时往 stderr 打 `fatal: …`，合并后 `out` 里就有内容，于是"这个 tag 不存在"
 * 被判成"已存在于 fatal:" —— 2026-10-12 实测撞到，直接导致**任何新版本都打不出 tag**。
 */
function capture(cmd, args, { cwd = ROOT, env = {} } = {}) {
  const n = ++capSeq;
  const outTmp = join(TMP_DIR, `cap-${n}.out`);
  const errTmp = join(TMP_DIR, `cap-${n}.err`);
  const outFd = openSync(outTmp, "w");
  const errFd = openSync(errTmp, "w");
  const r = spawnSync(cmd, args, { cwd, env: { ...process.env, ...env }, stdio: ["ignore", outFd, errFd], windowsHide: true });
  closeSync(outFd);
  closeSync(errFd);
  const read = (p) => (existsSync(p) ? readFileSync(p, "utf8") : "");
  return { code: r.status, out: read(outTmp), err: read(errTmp) };
}
/** 跑一条命令并把输出实时透到屏幕与日志（构建这类长任务用）。此处**不使用 shell**。 */
function runLive(cmd, args, { cwd = ROOT, env = {}, label = "" } = {}) {
  const shown = [cmd, ...args].join(" ").replaceAll(ROOT, ".");
  log(`▸ ${label || shown}`);
  appendFileSync(LOG_FILE, `$ ${shown}\n`);
  if (opts.dryRun) { log("  （--dry-run：跳过执行）"); return 0; }
  return new Promise((res) => {
    const p = spawn(cmd, args, { cwd, env: { ...process.env, ...env }, windowsHide: true });
    const tee = (d) => { process.stdout.write(d); appendFileSync(LOG_FILE, d); };
    p.stdout.on("data", tee);
    p.stderr.on("data", (d) => { process.stderr.write(d); appendFileSync(LOG_FILE, d); });
    p.on("error", (e) => { log(`  启动失败：${e.message}`); res(-1); });
    p.on("close", (c) => res(c ?? -1));
  });
}
function must(code, what) { if (code !== 0) die(`${what} 失败（退出码 ${code}）；细节见日志。`); }

function git(args, o = {}) {
  const r = capture("git", args, o);
  if (r.code !== 0) {
    const detail = (r.out + r.err).trim().split("\n").slice(-3).join(" | ");
    die(`git ${args.join(" ")} 失败：${detail}`);
  }
  return r.out.trim();
}
function gitOpt(args, o = {}) { return capture("git", args, o); }
/** tag 是否存在（存在则返回它指向的 sha，否则返回空串）。**必须看退出码** —— 见 capture 的注释。 */
function tagSha0(tag) {
  const r = gitOpt(["rev-list", "-n1", tag]);
  return r.code === 0 ? r.out.trim() : "";
}
function gitEnv(remote) {
  const base = {
    GIT_TERMINAL_PROMPT: "0",
    // 2026-10-16 起本机全局 ~/.gitconfig 有两枚雷：ghproxy.net 的 insteadOf 把
    // 所有 github.com 地址改写到镜像（push 不该走镜像，且镜像没存凭据）；
    // credential.helper=manager（GCM）不支持 socks5h 直接报错。发版推送必须
    // 整体绕开全局/系统配置：仓库内配置 + store 助手（~/.git-credentials）
    // + socks5h 直连 GitHub。Gitee 不走代理，同样吃这套干净配置。
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_SYSTEM: "/dev/null",
  };
  const cfg = ["-c", "credential.helper=store"];
  if (remote === CFG.originRemote) cfg.push("-c", `http.proxy=${CFG.ghProxy}`, "-c", "http.version=HTTP/1.1");
  return { env: base, cfg };
}
async function gitPush(remote, refspecs, { force = false, lease = null } = {}) {
  const { env, cfg } = gitEnv(remote);
  const args = [...cfg, "push"];
  if (force) args.push(force && lease ? `--force-with-lease=${lease}` : "--force");
  args.push(remote, ...refspecs);
  must(await runLive("git", args, { env, label: `git push ${remote} ${refspecs.join(" ")}${force ? " (force)" : ""}` }), "git push");
}

// ── 密钥 / 令牌 ───────────────────────────────────────────────────────────
function readCred(host) {
  const p = join(process.env.USERPROFILE || process.env.HOME || "", ".git-credentials");
  if (!existsSync(p)) return null;
  for (const line of readFileSync(p, "utf8").split(/\r?\n/)) {
    const m = line.trim().match(/^https:\/\/([^:]+):(.+)@([^/@]+)$/);
    if (m && m[3].toLowerCase().includes(host)) return m[2];
  }
  return null;   // 注意：**按 host 匹配，不靠行序** —— git 会自己重排这个文件
}
function ghToken() { const t = process.env.GITHUB_TOKEN || readCred("github.com"); if (!t) die("取不到 GitHub 令牌（~/.git-credentials 里没有 github.com 条目）"); return t; }
function giteeToken() { const t = process.env.GITEE_TOKEN || readCred("gitee.com"); if (!t) die("取不到 Gitee 令牌（~/.git-credentials 里没有 gitee.com 条目）"); return t; }

// ── HTTP（一律走 curl：node 的 fetch 不支持 socks5 代理） ────────────────
/** Gitee 把令牌放在 query 里 ⇒ 任何要打印/记日志的 URL 都要先脱敏。 */
function redact(url) { return String(url).replace(/(access_token=)[^&\s]+/gi, "$1***"); }

function curlJson({ method = "GET", url, body = null, token = null, proxy = null, expect = [200, 201, 204] }) {
  const args = ["-s", "-X", method, "--max-time", "120", "-w", "\\n%{http_code}"];
  if (proxy) args.push("--proxy", proxy);
  if (token) args.push("-H", `Authorization: Bearer ${token}`);
  args.push("-H", "Accept: application/vnd.github+json");
  if (body) args.push("-H", "Content-Type: application/json; charset=utf-8", "--data-binary", `@${body}`);
  args.push(url);
  if (opts.dryRun) { log(`  （--dry-run：${method} ${redact(url)}）`); return { code: 0, json: {} }; }
  const r = capture("curl", args);
  const lines = r.out.trimEnd().split("\n");
  const httpCode = Number(lines.pop());
  const text = lines.join("\n");
  let json = {};
  try { json = text ? JSON.parse(text) : {}; } catch { json = { _raw: text }; }
  if (!expect.includes(httpCode)) {
    const detail = JSON.stringify(json).slice(0, 300);
    if (httpCode === 404) return { code: 404, json };
    die(`${method} ${redact(url)} 返回 ${httpCode}：${redact(detail)}`);
  }
  return { code: httpCode, json };
}
/** 删掉某个同名附件（重传前清残留：上传中断会留下 state=starter 的空壳，同名再 POST 会 422）。 */
function deleteAssetByName(releaseId, name) {
  const list = curlJson({ url: `https://api.github.com/repos/${CFG.repo}/releases/${releaseId}/assets`, token: ghToken(), proxy: CFG.ghProxy }).json || [];
  for (const a of list.filter((x) => x.name === name)) {
    log(`  删残留附件 ${a.name}（id ${a.id}，state=${a.state}）`);
    curlJson({ method: "DELETE", url: `https://api.github.com/repos/${CFG.repo}/releases/assets/${a.id}`, token: ghToken(), proxy: CFG.ghProxy, expect: [204] });
  }
}
async function uploadAsset(releaseId, file) {
  const url = `https://uploads.github.com/repos/${CFG.repo}/releases/${releaseId}/assets?name=${encodeURIComponent(basename(file))}`;
  if (opts.dryRun) { log(`  （--dry-run：上传 ${basename(file)}）`); return; }
  const args = ["-sS", "-X", "POST", "--proxy", CFG.ghProxy, "--max-time", String(UPLOAD_TIMEOUT_S),
    "-H", `Authorization: Bearer ${ghToken()}`, "-H", "Accept: application/vnd.github+json",
    "-H", "Content-Type: application/octet-stream", "--data-binary", `@${file}`, url,
    "-w", "\\n%{http_code}"];
  const mb = (statSync(file).size / 1048576).toFixed(2);
  for (let attempt = 1; attempt <= UPLOAD_ATTEMPTS; attempt++) {
    if (attempt > 1) {
      warn(`第 ${attempt} 次尝试（上一次失败）`);
      deleteAssetByName(releaseId, basename(file));
      await new Promise((r) => setTimeout(r, 5000));
    }
    log(`▸ 上传 ${basename(file)}（${mb} MiB，可能要几分钟）`);
    const t0 = Date.now();
    const r = capture("curl", args);
    const code = Number(r.out.trimEnd().split("\n").pop());
    if (code === 201) { log(`  ✓ 已上传（${((Date.now() - t0) / 1000).toFixed(0)}s）`); return; }
    // curl 自己挂了（超时 28 / 连接重置 56…）时 %{http_code} 是 000，取不到就用退出码说话
    const why = Number.isFinite(code) && code ? `HTTP ${code}` : `curl 退出码 ${r.code}${r.err.trim() ? "：" + r.err.trim().split("\n")[0] : ""}`;
    if (attempt === UPLOAD_ATTEMPTS) die(`上传 ${basename(file)} 失败（${why}，已试 ${UPLOAD_ATTEMPTS} 次）`);
    warn(`上传 ${basename(file)} 失败（${why}）`);
  }
}

// ── 工具函数 ──────────────────────────────────────────────────────────────
function conf() { return JSON.parse(readFileSync(join(ROOT, "src-tauri", "tauri.conf.json"), "utf8")); }
function nsisDir() { return join(ROOT, "target", "release", "bundle", "nsis"); }
function portableDir() { return join(ROOT, "target", "release", "bundle", "portable"); }
function setupExe() { return join(nsisDir(), `Diagramon_${VERSION}_x64-setup.exe`); }
function sigFile() { return `${setupExe()}.sig`; }
function manifestFile() { return join(nsisDir(), "latest.json"); }
function portableZip() { return join(portableDir(), `Diagramon-${VERSION}-win-x64.zip`); }
function notesFile() { return join(ROOT, "docs", "release-notes", `${TAG}.md`); }
function mb(p) { return (statSync(p).size / 1048576).toFixed(2); }
function gitClean() { return git(["status", "--porcelain"]) === ""; }
function newestMtime(dirs, skip = /(^|[\\/])(target|var|\.git|node_modules|\.shots|dist)([\\/]|$)/) {
  let newest = 0;
  const walk = (d) => {
    let entries; try { entries = readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = join(d, e.name);
      if (skip.test(p)) continue;
      if (e.isDirectory()) walk(p);
      else { const m = statSync(p).mtimeMs; if (m > newest) newest = m; }
    }
  };
  for (const d of dirs) walk(join(ROOT, d));
  return newest;
}

// ── 步骤实现 ──────────────────────────────────────────────────────────────
async function preflight() {
  step("preflight · 前置条件");
  // 1. 分支与工作区
  const branch = git(["rev-parse", "--abbrev-ref", "HEAD"]);
  if (branch !== opts.branch) die(`当前在 ${branch}，发版必须在 ${opts.branch}（先 git checkout ${opts.branch}）`);
  if (!gitClean()) die("工作区不干净（git status 有改动）—— 先提交或收起，发版提交必须能追到源码");
  log(`✓ 分支 ${branch}，工作区干净`);

  // 2. 版本号单一真源 = **工作区 Cargo.toml**（tauri.conf.json 已不存版本 —— 删掉它之后
  //    Tauri/updater/关于对话框 全部读 CARGO_PKG_VERSION，见 tauri-codegen context.rs:255：
  //    conf.version 缺省 ⇒ env!("CARGO_PKG_VERSION")）。曾经两处各存一份，
  //    发版只改 tauri.conf ⇒ 关于窗口永远显示 3.0.0（3.0.1–3.0.3 三个安装包都中招）。
  const wsVer = readFileSync(join(ROOT, "Cargo.toml"), "utf8").match(/^\s*version\s*=\s*"([^"]+)"/m)?.[1];
  if (!wsVer) die("Cargo.toml 里找不到 [workspace.package] version —— 版本真源被挪走了？");
  if (wsVer !== VERSION) die(`Cargo.toml 的 version 是 ${wsVer}，与要发的 ${VERSION} 不一致。先改它并提交（这是唯一真源；tauri.conf.json 不再存版本）。`);
  if (conf().version) die(`tauri.conf.json 里不应该再有 version 字段（版本真源已归一到 Cargo.toml）。删掉它。`);
  log(`✓ 版本号一致（Cargo 单一真源）：${VERSION}`);

  // 3. 发布说明（双语红线）
  if (!existsSync(notesFile())) die(`缺少发布说明：docs/release-notes/${TAG}.md。从 docs/release-notes/TEMPLATE.md 复制一份写好再发。`);
  const notes = readFileSync(notesFile(), "utf8");
  for (const need of ["# 中文", "# English"]) if (!notes.includes(need)) die(`发布说明缺少 "${need}" 段 —— Release 说明一律中英双语。`);
  log(`✓ 发布说明存在且中英双语：docs/release-notes/${TAG}.md`);

  // 4. 密钥与工具
  for (const f of ["diagramon.key", "password.txt"]) if (!existsSync(join(opts.keys, f))) die(`密钥缺件：${join(opts.keys, f)}`);
  if (!existsSync(TAURI_CLI)) die(`找不到 tauri-cli：${TAURI_CLI}（在 .tooling 里 npm 装）`);
  log(`✓ 密钥与 tauri-cli 就位（${TAURI_CLI.replace(ROOT, ".")}）`);

  // 5. 门禁：真机自检报告必须比"会进包的东西"新（tools/docs 改动不影响产品，不算）
  const report = join(ROOT, "ui", ".shots", "selftest-report.json");
  const newest = newestMtime(["crates", "src-tauri", "ui"]);
  if (!existsSync(report)) {
    if (!opts.skipGate) die("没有真机自检报告（ui/.shots/selftest-report.json）。先在前台跑：\n    $env:DGM_PYTHON=\"C:\\Users\\rong\\.workbuddy\\binaries\\python\\versions\\3.13.12\\python.exe\"; node tools/dev/check.mjs");
    warn("没有任何自检报告，但 --skip-gate 已指定，继续。");
  } else {
    const rep = statSync(report).mtimeMs;
    const r = JSON.parse(readFileSync(report, "utf8"));
    log(`  自检报告：${r.pass}/${r.total}（${r.at || "?"}）`);
    if (r.pass !== r.total) die(`自检有失败项（${r.pass}/${r.total}）—— 先修。`);
    if (rep < newest) {
      const msg = `自检报告（${new Date(rep).toLocaleString()}）比源码最新改动（${new Date(newest).toLocaleString()}）旧 —— 报告不能代表当前代码`;
      if (!opts.skipGate) die(`${msg}。重跑 check.mjs，或用 --skip-gate 显式跳过。`);
      warn(`${msg}；--skip-gate 已指定，继续。`);
    } else log("✓ 自检报告比源码新，且全绿");
  }

  // 6. tag 现状
  const ex = tagSha0(TAG);
  const mainSha0 = git(["rev-parse", opts.branch]);
  if (ex) {
    warn(`${TAG} 已存在（${ex.slice(0, 7)}）${ex === mainSha0 ? "，正好指向当前 " + opts.branch : "，与当前 " + opts.branch + " 不同 —— 真要前移得加 --move-tag（只改文档就别跑 tag/push）"}`);
  } else log(`✓ ${TAG} 尚不存在`);

  // 7. 资产挂载点（prepack 会再校验，这里先给个早退）
  const MOUNTS = ["drawio", "excalidraw", "graphviz", "mermaid", "d2", "mermaid-elk"];
  for (const mp of MOUNTS) {
    if (!existsSync(join(ROOT, "assets", mp))) die(`资产缺 ${mp} —— 先 node tools/fetch-assets.mjs`);
  }
  log(`✓ ${MOUNTS.length} 个挂载点都在（assets/）`);
}

async function prepack() {
  step("prepack · 打包前置清理（红线 1）");
  must(await runLive(SELF, ["tools/prepack.mjs"], { label: "node tools/prepack.mjs" }), "prepack");
  must(await runLive(SELF, ["tools/prepack.mjs", "--check"], { label: "node tools/prepack.mjs --check" }), "prepack --check");
  if (opts.dryRun) return;
  log("✓ 开发产物已清、挂载点完整");
}

async function build() {
  step("build · 打包 NSIS 安装包（约 25 分钟首次）");
  const pw = readFileSync(join(opts.keys, "password.txt"), "utf8").trim();
  const env = {
    TAURI_SIGNING_PRIVATE_KEY: join(opts.keys, "diagramon.key"),
    TAURI_SIGNING_PRIVATE_KEY_PASSWORD: pw,
    CARGO_INCREMENTAL: "0",   // 本机增量缓存会偶发 rustc ICE
  };
  must(await runLive(SELF, [TAURI_CLI, "build", "--bundles", "nsis"], { env, label: "tauri build --bundles nsis" }), "打包");
  if (opts.dryRun) return;
  for (const f of [setupExe(), sigFile()]) if (!existsSync(f)) die(`打包后缺件：${basename(f)}`);
  // 抽查载荷：安装包必须带 ui/ 与 assets/，否则装出来白屏
  if (!existsSync(SEVEN_ZIP)) {
    warn(`找不到 7z（${SEVEN_ZIP}），跳过载荷抽查 —— 建议手工确认安装包里有 ui/index.html 与 assets/drawio/`);
  } else {
    const listing = capture(SEVEN_ZIP, ["l", setupExe()]).out;
    const need = [["ui\\index.html", /ui\\index\.html/], ["assets\\drawio", /assets\\drawio\\/]];
    for (const [name, re] of need) if (!re.test(listing)) die(`安装包载荷里没有 ${name} —— bundle.resources 映射坏了，装出来会白屏`);
    const leaked = (listing.match(/ui\\\.shots/g) || []).length;   // 清单里的形态是 ui\.shots\
    if (leaked > 0) die(`安装包里有 ${leaked} 条 ui\\.shots —— prepack 没跑到，重来`);
    log(`✓ 载荷含 ui/ 与 assets/，无 .shots 泄漏`);
  }
  log(`✓ 安装包 ${mb(setupExe())} MiB，签名已生成`);
}

async function portableStep() {
  step("portable · 便携版 ZIP");
  if (!opts.portable) { warn("--no-portable：跳过（公开发版不推荐）"); return; }
  must(await runLive(SELF, ["tools/pack-portable.mjs"], { label: "node tools/pack-portable.mjs" }), "便携版打包");
  if (opts.dryRun) return;
  if (!existsSync(portableZip())) die(`便携包没生成：${portableZip()}`);
  log(`✓ ${basename(portableZip())} ${mb(portableZip())} MB`);
}

async function manifest() {
  step("manifest · 重新生成 latest.json（红线 2）");
  // 早退必须在 readFileSync **之前**：dry-run 不会执行 build，`.sig` 根本不存在，
  // 放在后面会 ENOENT 直接终止 —— 那样 --dry-run 永远验不到 tag/push/publish/verify 这后半段
  // （2026-10-17 实测撞到，dry-run 的价值就在于把后半段也预演一遍）。
  if (opts.dryRun) {
    const planUrl = `https://github.com/${CFG.repo}/releases/download/${TAG}/${basename(setupExe())}`;
    log(`  （--dry-run：写出 ${manifestFile().replace(ROOT, ".")}：version ${VERSION}、`
      + `signature 取 ${basename(sigFile())}、url ${planUrl}）`);
    return;
  }
  const sig = readFileSync(sigFile(), "utf8").trim();
  const url = `https://github.com/${CFG.repo}/releases/download/${TAG}/${basename(setupExe())}`;
  // 红线 3：清单只能指安装包。指向 zip 会被更新器判成 InvalidUpdaterFormat
  if (!/-setup\.exe$/i.test(url)) die(`清单 url 必须以 -setup.exe 结尾（收到 ${url}）`);
  if (/\.zip$/i.test(url)) die("清单绝不能指向便携 zip —— 更新器只认 PE/MSI，会直接报 InvalidUpdaterFormat");
  const rawNotes = readFileSync(notesFile(), "utf8");
  // latest.json 的 notes = 更新对话框里那一句话：优先取「摘要：」，没有就退化成首段正文
  const sum = rawNotes.match(/^(?:摘要|summary)[:：]\s*(.+)$/im)?.[1];
  const fallback = rawNotes.replace(/^#.*$/gm, "").replace(/\s+/g, " ").trim();
  const notes = (sum || fallback).slice(0, 220);
  const m = {
    version: VERSION,
    notes: notes.startsWith("Diagramon") ? notes : `Diagramon ${VERSION}：${notes}`,
    pub_date: new Date().toISOString().replace(/\.\d+Z$/, "Z"),
    platforms: { "windows-x86_64": { signature: sig, url } },
  };
  if (opts.dryRun) return;   // 已在本函数开头早退，这里只是兜底
  writeFileSync(manifestFile(), JSON.stringify(m, null, 2) + "\n", "utf8");
  const back = JSON.parse(readFileSync(manifestFile(), "utf8"));
  if (back.version !== VERSION || back.platforms["windows-x86_64"].signature !== sig) die("清单回读不一致");
  log(`✓ latest.json 重新生成（pub_date ${m.pub_date}，签名 ${sig.length} 字符）`);
}

async function tag() {
  step("tag · 前移到发版提交");
  const ex = tagSha0(TAG);
  const mainSha = git(["rev-parse", opts.branch]);
  // 闸门：tag 已存在且不指向当前 main ⇒ 很可能已经发布过了。force 前移会把"已发布的 tag"挪走，
  // 必须显式 --move-tag。只改文档的重发版不要跑这一步（tag 应留在发布提交上）。
  if (ex && ex !== mainSha && !opts.moveTag) {
    if (opts.dryRun) warn(`${TAG} 已存在于 ${ex.slice(0, 7)} 而 ${opts.branch} 是 ${mainSha.slice(0, 7)} —— 真跑时这一步会拒绝，除非加 --move-tag`);
    else {
      die(`${TAG} 已存在于 ${ex.slice(0, 7)}，而 ${opts.branch} 是 ${mainSha.slice(0, 7)}。\n`
        + `  · 发**新版本**、要把它前移：加 --move-tag 显式确认；\n`
        + `  · 只是**改文档/README**、不发新版：别跑 tag/push 这两步（tag 该留在发布提交上）。`);
    }
  }
  must(await runLive("git", ["tag", "-f", TAG, opts.branch], { label: `git tag -f ${TAG} ${opts.branch}` }), "打 tag");
  if (opts.dryRun) return;
  const sha = git(["rev-list", "-n1", TAG]);
  if (sha !== mainSha) die(`tag 没指到 ${opts.branch}（${sha.slice(0, 7)} vs ${mainSha.slice(0, 7)}）`);
  opts.tagMoved = true;
  log(`✓ ${TAG} → ${sha.slice(0, 7)}（${opts.branch}）`);
}

/** 重建 gitee-master：恒等于 main + 一个"换 README 命名"的提交。不改发版内容本身。 */
async function branches() {
  step("branches · 重建 gitee-master（Gitee 首页要中文优先）");
  if (opts.dryRun) { log("  （--dry-run：checkout -B / mv / commit，然后切回 main）"); return; }
  if (!gitClean()) die("工作区不干净，拒绝动分支");
  try {
    must(await runLive("git", ["checkout", "-q", "-B", "gitee-master", opts.branch], { label: "git checkout -B gitee-master main" }), "切分支");
    must(await runLive("git", ["mv", "README.md", "README_EN.md"], {}), "git mv README.md");
    must(await runLive("git", ["mv", "README.zh-CN.md", "README.md"], {}), "git mv README.zh-CN.md");
    for (const [f, a, b] of [["README.md", "[English](README.md)", "[English](README_EN.md)"], ["README_EN.md", "[中文文档](README.zh-CN.md)", "[中文文档](README.md)"]]) {
      const p = join(ROOT, f);
      const t = readFileSync(p, "utf8");
      if (!t.includes(a)) die(`${f} 里找不到互链 "${a}" —— README 结构变了，检查后更新本脚本`);
      writeFileSync(p, t.replace(a, b), "utf8");
    }
    const msgFile = join(TMP_DIR, `msg-gitee-${VERSION}.txt`);
    writeFileSync(msgFile, `gitee-master: README 换成本地语言优先的命名（与旧仓库同口径）\n\n`
      + `Gitee 默认分支是 master，首页语言按中文习惯来：本分支 README.md = 中文、README_EN.md = 英文；\n`
      + `GitHub 的 main 则是 README.md = 英文、README.zh-CN.md = 中文。两份内容一字不差，只是文件名\n`
      + `与顶部互链相反。改 README 内容时两条分支都要改。\n\n`
      + `本分支由 ${opts.branch} 重新生成（不用 rebase），保证恒等于 ${opts.branch} + 这一个提交。\n`, "utf8");
    must(await runLive("git", ["add", "-A"], {}), "git add");
    // 提交信息走文件：内联 shell 里的反引号会被命令替换吃掉
    must(await runLive("git", ["commit", "-q", "-F", msgFile], {}), "git commit");
    log(`✓ gitee-master = ${git(["rev-parse", "--short", "gitee-master"])}`);
  } finally {
    // 无论成败都切回去 —— `checkout -B` 会移动 HEAD，留在分支上改文件是踩过的坑
    await runLive("git", ["checkout", "-q", opts.branch], { label: `git checkout ${opts.branch}（复位）` });
    const now = git(["rev-parse", "--abbrev-ref", "HEAD"]);
    if (now !== opts.branch) warn(`复位后当前分支是 ${now}，不是 ${opts.branch} —— 动手前先确认`);
  }
}

async function push() {
  step("push · 双远端（GitHub main + Gitee master）");
  const mainSha = opts.dryRun ? "" : git(["rev-parse", opts.branch]);
  const tagSha = opts.dryRun ? "" : tagSha0(TAG);
  // 没在本场打过 tag 时，只有 tag 本来就指着当前 main 才推它 —— 否则会把已发布的 tag 挪走
  const withTag = opts.dryRun || opts.tagMoved || (tagSha && tagSha === mainSha);
  if (!withTag && !opts.dryRun) {
    warn(`${TAG} 指在 ${tagSha.slice(0, 7)}、而 ${opts.branch} 是 ${mainSha.slice(0, 7)} ⇒ 本次**不推 tag**（免得把已发布的 tag 挪走）。只改文档时这样是对的。`);
  }
  // 分支：快进，不加 force；tag：lightweight，预期会被 force 前移
  await gitPush(CFG.originRemote, [opts.branch]);
  if (withTag) await gitPush(CFG.originRemote, [`refs/tags/${TAG}`], { force: true });
  // Gitee master 常常不是快进：先取当前 tip 当 lease
  const ls = gitOpt(["ls-remote", CFG.giteeRemote, "refs/heads/master"]);
  const oldMaster = ls.out.trim() ? ls.out.trim().split(/\s+/)[0] : null;
  if (oldMaster) await gitPush(CFG.giteeRemote, ["gitee-master:master"], { force: true, lease: `master:${oldMaster}` });
  else await gitPush(CFG.giteeRemote, ["gitee-master:master"]);
  await gitPush(CFG.giteeRemote, [`${opts.branch}:main`]);
  if (withTag) await gitPush(CFG.giteeRemote, [`refs/tags/${TAG}`], { force: true });
  if (opts.dryRun) { log("  （--dry-run：上面的 push 都没执行）"); return; }
  for (const [remote, ref] of [[CFG.originRemote, `refs/heads/${opts.branch}`], [CFG.giteeRemote, "refs/heads/master"], [CFG.giteeRemote, "refs/heads/main"]]) {
    const r = gitOpt(["ls-remote", remote, ref]);
    log(`  ${remote} ${ref} = ${r.out.trim().split(/\s+/)[0]?.slice(0, 7) || "?"}`);
  }
  if (withTag) log(`  ${TAG} = ${tagSha === mainSha ? mainSha.slice(0, 7) : "已前移到 " + mainSha.slice(0, 7)}`);
  log("✓ 已推两端");
}

/** 组装 Release 正文：三处信息补齐，并做双语断言。 */
function releaseBody() {
  const setupUrl = `https://github.com/${CFG.repo}/releases/download/${TAG}/${basename(setupExe())}`;
  const zipUrl = `https://github.com/${CFG.repo}/releases/download/${TAG}/${basename(portableZip())}`;
  let body = readFileSync(notesFile(), "utf8")
    .replace(/^(?:摘要|summary)[:：].*$\n?/im, "")   // 「摘要：」只喂 latest.json 的 notes，不进 Release 正文
    .replaceAll("{{version}}", VERSION)
    .replaceAll("{{date}}", new Date().toISOString().slice(0, 10))
    .replaceAll("{{setup_url}}", setupUrl)
    .replaceAll("{{zip_url}}", zipUrl)
    .replaceAll("{{setup_size_mb}}", existsSync(setupExe()) ? mb(setupExe()) : "?")
    .replaceAll("{{zip_size_mb}}", existsSync(portableZip()) ? mb(portableZip()) : "?");
  if (!body.includes("# 中文") || !body.includes("# English")) die("正文双语段缺失");
  if (!body.includes(setupUrl)) die("正文里没有安装包下载链接（模板里要写 {{setup_url}}）");
  // 便携包链接同样必须**可点**：Gitee 不传附件，正文没链接等于拿不到便携版
  // （2026-10-12 就漏过一次：两个 zip 只在正文外当附件躺着）。
  if (opts.portable && !body.includes(zipUrl)) {
    die(`正文里没有便携包下载链接（模板里要写 {{zip_url}}）—— Gitee 不传附件，没链接就拿不到 ${basename(portableZip())}`);
  }
  return body;
}

async function publish() {
  step("publish · GitHub Release + Gitee Release");
  const body = releaseBody();
  if (opts.dryRun) {
    log(`  正文 ${body.length} 字符（含「# 中文」与「# English」，含安装包链接）`);
    if (opts.bodyOnly) log(`  计划（--body-only）：PATCH 两端 Release 的说明，不动附件、不改发布状态`);
    else log(`  计划：GET /releases/tags/${TAG} →（无则复用同 tag 的草稿，再没有才 POST 建草稿）→ 删同名旧附件 → 上传 ${opts.portable ? 4 : 3} 个 → PATCH draft=false`);
    log(`  计划：Gitee GET/PATCH /releases/tags/${TAG}（更新必须带 tag_name，正文不含附件）`);
    return;
  }
  // ── 只更新说明（--body-only）：不动附件、不改发布状态。改错字/补链接时用。
  if (opts.bodyOnly) {
    const p = join(TMP_DIR, `body-only-${VERSION}.json`);
    writeFileSync(p, JSON.stringify({ tag_name: TAG, name: `Diagramon ${VERSION}`, body }, null, 0), "utf8");
    const cur = curlJson({ url: `https://api.github.com/repos/${CFG.repo}/releases/tags/${TAG}`, token: ghToken(), proxy: CFG.ghProxy, expect: [200, 404] });
    if (!cur.json?.id) die(`GitHub 上找不到 ${TAG} 的 Release —— 说明先要发版，不能只更新说明`);
    log(`  更新 GitHub Release id=${cur.json.id} 的说明（${body.length} 字符）`);
    curlJson({ method: "PATCH", url: `https://api.github.com/repos/${CFG.repo}/releases/${cur.json.id}`, body: p, token: ghToken(), proxy: CFG.ghProxy });
    const gTok2 = giteeToken();
    const gRef = `https://gitee.com/api/v5/repos/${CFG.repo}/releases/tags/${TAG}?access_token=${gTok2}`;
    const g2 = curlJson({ url: gRef, expect: [200, 404] });
    const gBody = join(TMP_DIR, `gitee-body-only-${VERSION}.json`);
    writeFileSync(gBody, JSON.stringify({ tag_name: TAG, name: `Diagramon ${VERSION}`, body }), "utf8");
    if (g2.json?.id) {
      log(`  更新 Gitee Release id=${g2.json.id} 的说明`);
      curlJson({ method: "PATCH", url: `https://gitee.com/api/v5/repos/${CFG.repo}/releases/${g2.json.id}?access_token=${gTok2}`, body: gBody });
    } else if (opts.createIfMissing) {
      log("  Gitee 上还没有这个 Release，创建");
      curlJson({ method: "POST", url: `https://gitee.com/api/v5/repos/${CFG.repo}/releases?access_token=${gTok2}`, body: gBody });
    } else warn(`Gitee 上找不到 ${TAG} 的 Release —— 跳过（要顺手建就加 --create-if-missing）`);
    log("✓ 两端 Release 说明已更新（附件与发布状态未动）");
    return;
  }

  const bodyFile = join(TMP_DIR, `body-${VERSION}.json`);
  writeFileSync(bodyFile, JSON.stringify({ tag_name: TAG, name: `Diagramon ${VERSION}`, body, draft: false, prerelease: false }), "utf8");

  // ── GitHub
  let r = curlJson({ url: `https://api.github.com/repos/${CFG.repo}/releases/tags/${TAG}`, token: ghToken(), proxy: CFG.ghProxy, expect: [200, 404] });
  let id = r.json?.id;
  if (!id) {
    // ⚠️ /releases/tags/<tag> **看不见草稿**（draft 一律 404）。上一次 publish 传到一半断了时，
    // 这里若直接 POST 就会另建一个草稿：附件白传（实测两次共 260MB），旧草稿还得手工删。
    const drafts = curlJson({ url: `https://api.github.com/repos/${CFG.repo}/releases?per_page=50`, token: ghToken(), proxy: CFG.ghProxy }).json || [];
    const stale = drafts.find((x) => x.tag_name === TAG && x.draft);
    if (stale) { id = stale.id; log(`  复用未完成的草稿 id=${id}（附件会先删同名再重传）`); }
  }
  if (id) log(`  已有 Release id=${id}，复用`); 
  else {
    const draftFile = join(TMP_DIR, `gh-draft-${VERSION}.json`);
    writeFileSync(draftFile, JSON.stringify({ tag_name: TAG, name: `Diagramon ${VERSION}`, body, draft: true, prerelease: false }), "utf8");
    r = curlJson({ method: "POST", url: `https://api.github.com/repos/${CFG.repo}/releases`, body: draftFile, token: ghToken(), proxy: CFG.ghProxy });
    id = r.json?.id;
    if (!id && !opts.dryRun) die("创建 GitHub Release 没拿到 id");
    log(`  新建草稿 Release id=${id}`);
  }
  // 换产物 = 先删同名旧附件（否则同名上传会失败）
  if (!opts.dryRun && id) {
    const assets = curlJson({ url: `https://api.github.com/repos/${CFG.repo}/releases/${id}/assets`, token: ghToken(), proxy: CFG.ghProxy }).json || [];
    const mine = new Set([basename(setupExe()), basename(sigFile()), "latest.json", basename(portableZip())]);
    for (const a of assets) {
      if (!mine.has(a.name)) continue;
      log(`  删旧附件 ${a.name}（id ${a.id}）`);
      curlJson({ method: "DELETE", url: `https://api.github.com/repos/${CFG.repo}/releases/assets/${a.id}`, token: ghToken(), proxy: CFG.ghProxy, expect: [204] });
    }
    const files = [setupExe(), sigFile(), manifestFile()];
    if (opts.portable) files.push(portableZip());
    for (const f of files) await uploadAsset(id, f);
    // 正式发布：latest 只认已发布
    curlJson({ method: "PATCH", url: `https://api.github.com/repos/${CFG.repo}/releases/${id}`, body: bodyFile, token: ghToken(), proxy: CFG.ghProxy });
    log("  ✓ GitHub Release 已正式发布（draft=false）");
  }
  log(`  GitHub: https://github.com/${CFG.repo}/releases/tag/${TAG}`);

  // ── Gitee（不传附件，正文里放 GitHub 下载链接）
  const gFile = join(TMP_DIR, `gitee-${VERSION}.json`);
  writeFileSync(gFile, JSON.stringify({ tag_name: TAG, name: `Diagramon ${VERSION}`, body, target_commitish: "master", prerelease: false }), "utf8");
  const gTok = giteeToken();
  const cur = curlJson({ url: `https://gitee.com/api/v5/repos/${CFG.repo}/releases/tags/${TAG}?access_token=${gTok}`, expect: [200, 404] });
  if (cur.json?.id) {
    // ⚠️ Gitee 的更新接口必须带 tag_name，否则 400 tag_name is missing
    curlJson({ method: "PATCH", url: `https://gitee.com/api/v5/repos/${CFG.repo}/releases/${cur.json.id}?access_token=${gTok}`, body: gFile, proxy: null });
    log(`  ✓ Gitee Release ${cur.json.id} 已更新说明`);
  } else {
    const created = curlJson({ method: "POST", url: `https://gitee.com/api/v5/repos/${CFG.repo}/releases?access_token=${gTok}`, body: gFile, proxy: null });
    log(`  ✓ Gitee Release 已创建 id=${created.json?.id}`);
  }
}

async function verify() {
  step("verify · 回读更新链（红线 7）");
  if (opts.dryRun) { log("  （--dry-run：回读 latest.json / 附件列表 / content-length）"); return; }
  const url = `https://github.com/${CFG.repo}/releases/latest/download/latest.json`;
  const raw = capture("curl", ["-sL", "--proxy", CFG.ghProxy, "--max-time", "120", url]);
  if (raw.code !== 0) die("回读 latest.json 失败");
  let pulled; try { pulled = JSON.parse(raw.out); } catch { die(`回读的 latest.json 不是合法 JSON：${raw.out.slice(0, 120)}`); }
  const local = readFileSync(sigFile(), "utf8").trim();
  const got = pulled.platforms?.["windows-x86_64"]?.signature;
  if (pulled.version !== VERSION) die(`更新源上的版本是 ${pulled.version}，不是 ${VERSION}（Release 是否真的发布了？）`);
  if (got !== local) die("更新源的 signature 与本地 .sig 不一致 —— 传错文件了");
  log(`✓ version=${pulled.version}，signature 与本地 .sig 逐字节一致`);

  // 远端安装包的字节数：用 **Range 请求**取总长度 —— 206 的 content-range 里带着文件总大小，
  // 不必真下 54MB。
  // ⚠️ 不要用 `curl -I -L` 抓 content-length：跟随重定向时响应头是**逐段**打印的，第一段是
  // GitHub 那个 302 的 `content-length: 0`，只取第一个匹配就恒为 0（v3.0.1 实测撞到，
  // 于是"发布成功但自检报 0 字节"）。要取就取**最后一段**。
  const hdrFile = join(TMP_DIR, `head-${VERSION}.txt`);
  const bodySink = join(TMP_DIR, `head-${VERSION}.bin`);
  capture("curl", ["-sL", "-r", "0-0", "-D", hdrFile, "-o", bodySink, "--proxy", CFG.ghProxy, "--max-time", "180", pulled.platforms["windows-x86_64"].url]);
  const hdrs = existsSync(hdrFile) ? readFileSync(hdrFile, "utf8") : "";
  const range = hdrs.match(/content-range:\s*bytes\s+\d+-\d+\/(\d+)/i);
  const cls = [...hdrs.matchAll(/^content-length:\s*(\d+)/gim)].map((m) => Number(m[1]));
  const remoteSize = range ? Number(range[1]) : cls.length ? cls[cls.length - 1] : null;
  const localSize = statSync(setupExe()).size;
  if (remoteSize == null) warn("拿不到远端安装包长度，跳过字节数核对");
  else if (remoteSize !== localSize) die(`远端安装包 ${remoteSize} 字节 ≠ 本地 ${localSize} 字节`);
  else log(`✓ 远端安装包字节数与本地一致（${localSize}）`);

  const rel = curlJson({ url: `https://api.github.com/repos/${CFG.repo}/releases/tags/${TAG}`, token: ghToken(), proxy: CFG.ghProxy });
  const names = (rel.json.assets || []).map((a) => `${a.name}(${(a.size / 1048576).toFixed(1)}M,${a.state})`);
  log(`  附件：${names.join("  ")}`);
  const want = [basename(setupExe()), basename(sigFile()), "latest.json", ...(opts.portable ? [basename(portableZip())] : [])];
  for (const w of want) if (!(rel.json.assets || []).some((a) => a.name === w && a.state === "uploaded")) die(`附件缺失或未完成：${w}`);
  log("✓ 四个附件齐全且状态 uploaded");
  log("");
  log(`全部完成。Release 页面：https://github.com/${CFG.repo}/releases/tag/${TAG}`);
}

function printHelp() {
  console.log(`Diagramon 发布脚本（唯一入口）

  node tools/release.mjs <版本> [选项]        例：node tools/release.mjs 3.0.1

必读：规则见 AGENTS.md；细节见 docs/发布检查单.md
发版前要准备好的两样东西（脚本会拒绝，不会替你做）：
  1) Cargo.toml（工作区）的 version 改成目标版本并提交，然后 cargo update -w 刷 Cargo.lock（版本号唯一真源；tauri.conf.json 不存版本）
  2) docs/release-notes/v<版本>.md（从 TEMPLATE.md 复制，必须含 "# 中文" 与 "# English"）

选项
  --from=<步骤>   从某步开始跑到最后（构建 25 分钟，断了就从 build 续）
  --only=<步骤>   只跑某一步
  --dry-run       只打印计划，不执行、不请求
  --skip-gate     跳过"真机自检报告必须比源码新"的门禁（会记警告）
  --move-tag      允许把已存在的 tag 前移到当前 main（发新版才需要；只改文档时别加）
  --body-only     只更新两端 Release 的说明，不动附件、不改发布状态（改错字/补链接时用）
  --create-if-missing  配合 --body-only：Gitee 上还没有 Release 时顺手建一个
  --no-portable   不产便携 ZIP
  --branch=<名>   主分支，默认 main
  --keys=<目录>   签名密钥目录，默认 ../keys
  --list-steps    列出步骤

步骤
  ${STEPS.join("  ")}`);
}

// ── 主流程 ────────────────────────────────────────────────────────────────
const IMPL = { preflight, prepack, build, portable: portableStep, manifest, tag, branches, push, publish, verify };

async function main() {
  log(`Diagramon 发布 ${TAG}${opts.dryRun ? "（--dry-run：不产生任何改动、不发任何请求）" : ""}`);
  log(`日志：${LOG_FILE.replace(ROOT, ".")}`);
  let start = 0;
  if (opts.only) {
    if (!STEPS.includes(opts.only)) die(`未知步骤 "${opts.only}"（可选：${STEPS.join(" / ")}）`);
    start = STEPS.indexOf(opts.only);
  } else if (opts.from) {
    if (!STEPS.includes(opts.from)) die(`未知步骤 "${opts.from}"（可选：${STEPS.join(" / ")}）`);
    start = STEPS.indexOf(opts.from);
  }
  if (start > 0 && !opts.only) warn(`从 ${STEPS[start]} 开始 —— 假定前面这几步已跑过：${STEPS.slice(0, start).join(", ")}`);
  const todo = opts.only ? [opts.only] : STEPS.slice(start);
  const t0 = Date.now();
  for (const s of todo) await IMPL[s]();
  log("");
  log(`✔ 全部步骤完成（${todo.join(" → ")}），耗时 ${((Date.now() - t0) / 60000).toFixed(1)} 分钟`);
  log(`日志：${LOG_FILE}`);
}

main().catch((e) => die(e && e.stack ? e.stack : String(e)));

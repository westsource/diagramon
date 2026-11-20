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
import { createHash, createPublicKey, verify as verifySignature } from "node:crypto";
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
// 7-Zip 的解析与 `pack-portable.mjs` 同一套（审计 2026-11-03 G-7）：
// 原来这里写死 `C:\Program Files\7-Zip\7z.exe`，别的安装位置一律找不到 ——
// 而找不到时只 `warn` 然后继续发版，等于把红线 1 的兜底抽查静默关掉。
// 四个来源：SEVENZIP 环境变量 → 两个 Program Files → PATH 上的 `7z`。
const SEVEN_ZIP = [
  process.env.SEVENZIP,
  "C:\\Program Files\\7-Zip\\7z.exe",
  "C:\\Program Files (x86)\\7-Zip\\7z.exe",
  "7z",
].find((p) => p && (p === "7z" ? true : existsSync(p)));

/** 本场真正跑过的步骤（审计 G-7：`--from=build` 会跳过 prepack，红线 1 不能因此失守）。 */
const ran = new Set();

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

const STEPS = ["preflight", "prepack", "build", "linux", "portable", "manifest", "tag", "branches", "push", "publish", "verify"];

// ── 参数 ──────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const opts = { dryRun: false, skipGate: false, portable: true, linux: true, moveTag: false, bodyOnly: false, createIfMissing: false, branch: "main", keys: KEYS_DEFAULT, from: null, only: null };
let rawVersion = null;
for (const a of argv) {
  if (a === "--help" || a === "-h") { printHelp(); process.exit(0); }
  else if (a === "--list-steps") { console.log(STEPS.join("  ")); process.exit(0); }
  else if (a === "--dry-run") opts.dryRun = true;
  else if (a === "--skip-gate") opts.skipGate = true;
  else if (a === "--no-portable") opts.portable = false;
  else if (a === "--no-linux") opts.linux = false;
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

// ── Gitee 国内更新镜像 ────────────────────────────────────────────────────
//
// Gitee 只承担"国内能下到的安装包 + 一份清单"，不传便携 ZIP / .sig：
// 单附件 ≤100 MiB、单仓库附件总量 ≤1 GiB，保留最近 3 个安装包。
const GITEE_UPLOAD_TIMEOUT_S = 900;
const GITEE_KEEP_INSTALLERS = 3;

function giteeUrl(path) {
  return `https://gitee.com/api/v5/repos/${CFG.repo}/${path}`;
}
// Gitee 附件名必须固定为 `latest-cn.json`：服务端路由按这个名字找，不带版本号。
function cnManifestFile() { return join(TMP_DIR, "latest-cn.json"); }
function cnSetupUrl() {
  return `https://gitee.com/${CFG.repo}/releases/download/${TAG}/${basename(setupExe())}`;
}
function giteeAttachments(releaseId) {
  return curlJson({
    url: giteeUrl(`releases/${releaseId}/attach_files?access_token=${giteeToken()}`),
    proxy: null,
  }).json || [];
}
function deleteGiteeAttachment(releaseId, asset) {
  log(`  删 Gitee 旧附件 ${asset.name}（id ${asset.id}）`);
  curlJson({
    method: "DELETE",
    url: giteeUrl(`releases/${releaseId}/attach_files/${asset.id}?access_token=${giteeToken()}`),
    proxy: null,
    expect: [200, 204],
  });
}
async function uploadGiteeAsset(releaseId, file) {
  const name = basename(file);
  if (opts.dryRun) { log(`  （--dry-run：上传 Gitee ${name}）`); return; }
  // 重跑时先删同名残留：Gitee 同名附件会直接报错
  for (const a of giteeAttachments(releaseId).filter((x) => x.name === name)) {
    deleteGiteeAttachment(releaseId, a);
  }
  const mb = (statSync(file).size / 1048576).toFixed(2);
  const args = [
    "-sS", "-X", "POST", "--max-time", String(GITEE_UPLOAD_TIMEOUT_S),
    "-F", `file=@${file}`,
    `${giteeUrl(`releases/${releaseId}/attach_files`)}?access_token=${giteeToken()}`,
    "-w", "\\n%{http_code}",
  ];
  for (let attempt = 1; attempt <= 2; attempt++) {
    if (attempt > 1) {
      warn("Gitee 上传失败，重试一次（先删同名残留）");
      for (const a of giteeAttachments(releaseId).filter((x) => x.name === name)) {
        deleteGiteeAttachment(releaseId, a);
      }
    }
    log(`▸ 上传 Gitee ${name}（${mb} MiB）`);
    const t0 = Date.now();
    const r = capture("curl", args);
    const code = Number(r.out.trimEnd().split("\n").pop());
    if (code === 200 || code === 201) {
      log(`  ✓ 已上传（${((Date.now() - t0) / 1000).toFixed(0)}s）`);
      return;
    }
    const why = Number.isFinite(code) && code ? `HTTP ${code}` : `curl 退出码 ${r.code}`;
    if (attempt === 2) die(`Gitee 上传 ${name} 失败（${why}）`);
    warn(`Gitee 上传 ${name} 失败（${why}）`);
  }
}
/** 生成 `latest-cn.json`：与 GitHub 的 `latest.json` 同版本、同签名，只换下载 URL。 */
function writeCnManifest() {
  const manifest = JSON.parse(readFileSync(manifestFile(), "utf8"));
  const platform = manifest.platforms?.["windows-x86_64"];
  if (!platform) die("latest.json 里没有 windows-x86_64 —— 无法生成 Gitee 清单");
  const sig = readFileSync(sigFile(), "utf8").trim();
  if (platform.signature !== sig) die("latest.json 的 signature 与本地 .sig 不一致");
  platform.url = cnSetupUrl();
  writeFileSync(cnManifestFile(), JSON.stringify(manifest, null, 2), "utf8");
  log(`  ✓ 生成 ${basename(cnManifestFile())}（url → Gitee）`);
  return manifest;
}
/** 只保留最近 N 个带安装包的 Gitee Release；更老的删掉安装包与 latest-cn.json。
 *
 * 判据**必须读每个 release 的 attach_files**，不能看列表接口的 `assets`：
 * 2026-10-25 实测列表接口里旧 release 的 `assets` 为空（或没有 name），于是
 * `withSetup` 只算出最近几条、slice 之后一条都不删 —— 配额一路堆到 969 MB，
 * 下一次上传直接 400「文件大小已超出仓库附件配额：1 GB」，而日志还写着"已清理"。 */
function pruneGiteeInstallers() {
  if (opts.dryRun) { log(`  （--dry-run：Gitee 附件保留最近 ${GITEE_KEEP_INSTALLERS} 个）`); return; }
  const releases = curlJson({
    url: giteeUrl(`releases?per_page=100&access_token=${giteeToken()}`),
    proxy: null,
  }).json || [];
  const withSetup = [];
  for (const rel of releases) {
    let atts = [];
    try { atts = giteeAttachments(rel.id); } catch (e) { warn(`读 Gitee 附件失败（${rel.tag_name}）：${e.message}`); continue; }
    if (atts.some((a) => a.name.endsWith("-setup.exe"))) withSetup.push({ rel, atts });
  }
  withSetup.sort((a, b) => Date.parse(b.rel.created_at || 0) - Date.parse(a.rel.created_at || 0));
  for (const { rel, atts } of withSetup.slice(GITEE_KEEP_INSTALLERS)) {
    for (const a of atts) {
      if (a.name.endsWith("-setup.exe") || a.name === "latest-cn.json") {
        try { deleteGiteeAttachment(rel.id, a); } catch (e) { warn(`删 Gitee 附件失败（${a.name}）：${e.message}`); }
      }
    }
  }
  log(`  ✓ 已按保留 ${GITEE_KEEP_INSTALLERS} 个安装包清理 Gitee`);
}
/** 回读 Gitee：附件存在、清单签名与本地一致、安装包字节数一致。 */
function verifyGitee(releaseId) {
  const atts = giteeAttachments(releaseId);
  const exe = atts.find((a) => a.name === basename(setupExe()));
  const man = atts.find((a) => a.name === "latest-cn.json");
  if (!exe) die(`Gitee 上缺 ${basename(setupExe())} —— 国内更新会断`);
  if (!man) die("Gitee 上缺 latest-cn.json —— 国内清单无法下发");

  const raw = capture("curl", ["-sSL", "--max-time", "120", man.browser_download_url]);
  if (raw.code !== 0) die("回读 Gitee latest-cn.json 失败");
  let pulled;
  try { pulled = JSON.parse(raw.out); } catch { die(`Gitee 清单不是合法 JSON：${raw.out.slice(0, 120)}`); }
  const local = readFileSync(sigFile(), "utf8").trim();
  if (pulled.version !== VERSION) die(`Gitee 清单版本是 ${pulled.version}，不是 ${VERSION}`);
  if (pulled.platforms?.["windows-x86_64"]?.signature !== local) die("Gitee 清单的 signature 与本地 .sig 不一致");
  if (!String(pulled.platforms?.["windows-x86_64"]?.url || "").includes(`/releases/download/${TAG}/`)) {
    die("Gitee 清单的下载 URL 没有指向本次 tag");
  }
  log(`✓ Gitee 清单 version=${pulled.version}，signature 与本地 .sig 一致`);

  // Gitee 不支持 Range（会回 200 全文件），所以只取头：跟随重定向后取**最后一段**的 content-length
  const hdrFile = join(TMP_DIR, `gitee-head-${VERSION}.txt`);
  capture("curl", ["-sS", "-I", "-L", "--max-time", "180", "-D", hdrFile, "-o",
    join(TMP_DIR, `gitee-head-${VERSION}.bin`), exe.browser_download_url]);
  const hdrs = existsSync(hdrFile) ? readFileSync(hdrFile, "utf8") : "";
  const cls = [...hdrs.matchAll(/^content-length:\s*(\d+)/gim)].map((m) => Number(m[1]));
  const remoteSize = cls.length ? cls[cls.length - 1] : null;
  const localSize = statSync(setupExe()).size;
  if (remoteSize == null) warn("拿不到 Gitee 安装包长度，跳过字节数核对");
  else if (remoteSize !== localSize) die(`Gitee 安装包 ${remoteSize} 字节 ≠ 本地 ${localSize} 字节`);
  else log(`✓ Gitee 安装包字节数与本地一致（${localSize}）`);
}

// ── 工具函数 ──────────────────────────────────────────────────────────────
function conf() { return JSON.parse(readFileSync(join(ROOT, "src-tauri", "tauri.conf.json"), "utf8")); }
function nsisDir() { return join(ROOT, "target", "release", "bundle", "nsis"); }
function portableDir() { return join(ROOT, "target", "release", "bundle", "portable"); }
function setupExe() { return join(nsisDir(), `Diagramon_${VERSION}_x64-setup.exe`); }
function sigFile() { return `${setupExe()}.sig`; }
function manifestFile() { return join(nsisDir(), "latest.json"); }
function portableZip() { return join(portableDir(), `Diagramon-${VERSION}-win-x64.zip`); }

/**
 * 用 `tauri.conf.json` 里的 pubkey 验证 `.sig`（minisign，Tauri 以 base64 包裹）。
 *
 * 2026-11-19 事故：`d43e1d8`（Linux 首发）把 pubkey 改坏了一个字符
 * （`…MLQynvop…` → `…MLQYnvop…`），而签名仍由正确的私钥生成 —— 于是 3.14.5 / 3.15.0
 * 的客户端一检查更新就报 `The signature verification failed`，且**这两个版本自己
 * 再也收不到任何更新**。流水线当时对签名与公钥是否成对没有任何校验，所以照发不误。
 * 这条闸门补上：签字后的产物必须能被将要编进 exe 的那把公钥验证。
 */
function assertSignature(file, sigPath) {
  const confText = Buffer.from(conf().plugins.updater.pubkey || "", "base64").toString("latin1");
  const pkLine = confText.split(/\r?\n/).filter(Boolean)[1];
  if (!pkLine) die("tauri.conf.json 的 plugins.updater.pubkey 不是合法的 minisign 公钥");
  const pk = Buffer.from(pkLine, "base64");
  // `.sig` 文件本身是 base64（内容才是 minisign 的四行文本）；manifest 里放的也是这段 base64。
  const sigText = Buffer.from(readFileSync(sigPath, "utf8").trim(), "base64").toString("utf8");
  const sigLine = sigText.split(/\r?\n/).filter(Boolean)[1];
  const sig = Buffer.from(sigLine || "", "base64");
  if (sig.length !== 74) die(`${basename(sigPath)} 不是合法的 minisign 签名（长度 ${sig.length}）`);
  if (!sig.subarray(2, 10).equals(pk.subarray(2, 10))) {
    die(`${basename(file)} 的签名 key id（${sig.subarray(2, 10).toString("hex")}）与 tauri.conf.json 的 pubkey（${pk.subarray(2, 10).toString("hex")}）不是同一把密钥`);
  }
  const alg = sig.subarray(0, 2).toString("latin1");
  const data = readFileSync(file);
  const msg = alg === "ED" ? createHash("blake2b512").update(data).digest() : data;
  const der = Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), pk.subarray(10, 42)]);
  const key = createPublicKey({ key: der, format: "der", type: "spki" });
  if (!verifySignature(null, msg, key, sig.subarray(10, 74))) {
    die(`${basename(file)} 的签名无法被 tauri.conf.json 的 pubkey 验证 —— 客户端会报 `
      + `"The signature verification failed"。pubkey 必须与签名私钥成对（见 ../keys/diagramon.key.pub）。`);
  }
  log(`✓ 签名可由 tauri.conf.json 的 pubkey 验证：${basename(file)}`);
}

/* ------------------------------ Linux 产物（WSL 里构建） ------------------------------
 *
 * 桌面端不能在 Windows 上交叉编译 Linux（webkit2gtk 的 C 依赖），而发版机是 Windows。
 * 这里用 WSL2 里的一套 Ubuntu 构建，产物再拷回 `target/release/bundle/linux/`，
 * 后续 manifest / 上传 / 回读三条红线与 Windows 完全同一套。
 */
const WSL_DISTRO = process.env.DGM_WSL_DISTRO || "Ubuntu";
const WSL_REPO = "/root/diagramon";
const WSL_TOOLING = "/root/tooling";

function linuxDir() { return join(ROOT, "target", "release", "bundle", "linux"); }
function listLinux() {
  try { return readdirSync(linuxDir()); } catch { return []; }
}
function linuxFile(re) {
  // 必须再按版本号收窄：linuxDir 里可能留着上一版产物（WSL 构建只 `cp -f` 不回删），
  // 而 readdir 的顺序不保证 —— 2026-11-19 发 3.15.0 时清单就这样被写进了 3.14.5 的
  // AppImage 签名与文件名（红线 2 直接失守），所以这里两道防线：按版本挑 + 构建前清目录。
  const hit = listLinux().find((n) => re.test(n) && n.includes(VERSION));
  return hit ? join(linuxDir(), hit) : null;
}
function appImage() { return linuxFile(/\.AppImage$/i); }
function appImageSig() { const a = appImage(); return a ? `${a}.sig` : null; }
function debFile() { return linuxFile(/\.deb$/i); }

/** Windows 绝对路径 → WSL 挂载路径（只支持盘符路径，够发版机用）。 */
function wslPath(p) {
  const abs = resolve(p).replaceAll("\\", "/");
  const m = abs.match(/^([A-Za-z]):\/(.*)$/);
  if (!m) die(`WSL 只挂载了盘符路径，收到：${p}`);
  return `/mnt/${m[1].toLowerCase()}/${m[2]}`;
}
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
  if (opts.linux) {
    for (const need of ["{{appimage_url}}", "{{deb_url}}"]) {
      if (!notes.includes(need)) die(`发布说明缺少 ${need} —— Linux 包只在 GitHub Release 附件里，正文必须给直链`);
    }
  }
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

  // 8. Linux 产物：由 WSL 里的 Ubuntu 构建（本机只有 Windows 工具链）
  if (opts.linux) {
    if (process.platform !== "win32") die("Linux 产物依赖 WSL，本脚本要在 Windows 上跑（只想发 Windows 用 --no-linux）");
    const r = capture("wsl.exe", [
      "-d", WSL_DISTRO, "-u", "root", "--", "bash", "-lc",
      'export PATH="/root/.cargo/bin:$PATH"; command -v cargo >/dev/null && command -v dpkg-deb >/dev/null && pkg-config --exists webkit2gtk-4.1 && echo dgm-wsl-ok',
    ]);
    if (!r.out.includes("dgm-wsl-ok")) {
      die(`WSL(${WSL_DISTRO}) 缺 Linux 构建依赖。按 var/tmp/wsl/setup.sh 装一遍（webkit2gtk-4.1-dev / dpkg-deb / cargo）。输出：${(r.out + r.err).trim().slice(0, 300)}`);
    }
    log(`✓ WSL(${WSL_DISTRO}) 构建环境就绪（cargo / dpkg-deb / webkit2gtk-4.1）`);
  }
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
  // 红线 1 不因续跑姿势而破（审计 2026-11-03 G-7）：`--from=build` / `--only=build` 会跳过
  // prepack 步，而下面那次 7z 抽查只是**兜底**（历史上 7z 不在位时它会降级成 warn）。
  // 所以这里补跑一次清理 —— prepack 是幂等的（只删开发产物），代价秒级。
  if (!ran.has("prepack")) {
    warn("本次没跑 prepack 步（--from / --only 跳过了它）⇒ 在 build 前补跑一次（红线 1）");
    must(await runLive(SELF, ["tools/prepack.mjs"], { label: "node tools/prepack.mjs（build 前补跑）" }), "prepack");
    must(
      await runLive(SELF, ["tools/prepack.mjs", "--check"], { label: "node tools/prepack.mjs --check（build 前补跑）" }),
      "prepack --check",
    );
    if (opts.dryRun) return;
    ran.add("prepack");
  }
  const pw = readFileSync(join(opts.keys, "password.txt"), "utf8").trim();
  const env = {
    TAURI_SIGNING_PRIVATE_KEY: join(opts.keys, "diagramon.key"),
    TAURI_SIGNING_PRIVATE_KEY_PASSWORD: pw,
    CARGO_INCREMENTAL: "0",   // 本机增量缓存会偶发 rustc ICE
  };
  must(await runLive(SELF, [TAURI_CLI, "build", "--bundles", "nsis"], { env, label: "tauri build --bundles nsis" }), "打包");
  if (opts.dryRun) return;
  for (const f of [setupExe(), sigFile()]) if (!existsSync(f)) die(`打包后缺件：${basename(f)}`);
  assertSignature(setupExe(), sigFile());
  // 抽查载荷：安装包必须带 ui/ 与 assets/，否则装出来白屏。
  // **7z 是发版机的硬依赖，找不到就直接失败**（审计 G-7）：原来只 warn 然后继续，
  // 于是"带着开发产物的安装包"可以一路发出去 —— 那正是红线 1 记载的那次事故。
  if (!SEVEN_ZIP) {
    die("找不到 7-Zip —— 载荷抽查是红线 1 的兜底，不能跳过。装一个，或设 SEVENZIP=<7z.exe 的路径>");
  }
  {
    log(`  载荷抽查用 ${SEVEN_ZIP}`);
    const listing = capture(SEVEN_ZIP, ["l", setupExe()]).out;
    const need = [["ui\\index.html", /ui\\index\.html/], ["assets\\drawio", /assets\\drawio\\/]];
    for (const [name, re] of need) if (!re.test(listing)) die(`安装包载荷里没有 ${name} —— bundle.resources 映射坏了，装出来会白屏`);
    const leaked = (listing.match(/ui\\\.shots/g) || []).length;   // 清单里的形态是 ui\.shots\
    if (leaked > 0) die(`安装包里有 ${leaked} 条 ui\\.shots —— prepack 没跑到，重来`);
    log(`✓ 载荷含 ui/ 与 assets/，无 .shots 泄漏`);
  }
  log(`✓ 安装包 ${mb(setupExe())} MiB，签名已生成`);
}

async function linuxStep() {
  step("linux · AppImage + deb（WSL 里构建，产物回拷）");
  if (!opts.linux) { warn("--no-linux：跳过 Linux 产物"); return; }
  if (opts.dryRun) {
    log(`  （--dry-run：WSL(${WSL_DISTRO}) 里同步工作树 → tauri build --bundles appimage,deb → 回拷 ${linuxDir().replace(ROOT, ".")}）`);
    return;
  }
  mkdirSync(linuxDir(), { recursive: true });
  // 清掉上一版残留（见 linuxFile 的说明）：否则 manifest/publish 取到的是旧文件。
  for (const n of listLinux()) {
    if (/\.(AppImage|deb)(\.sig)?$/i.test(n)) rmSync(join(linuxDir(), n), { force: true });
  }
  // appimagetool 自己会去 GitHub 下 runtime，但受限网络/国内链路经常失败
  // （实测：`server returned status code 0`）。先自己下一份，用 `LDAI_RUNTIME_FILE`
  // 交给 linuxdeploy 的 appimage 插件（它直接转成 `--runtime-file`）。
  const runtime = join(ROOT, "var", "tmp", "appimage-runtime-x86_64");
  if (!existsSync(runtime)) {
    mkdirSync(dirname(runtime), { recursive: true });
    log("  下载 AppImage runtime（GitHub，走代理）…");
    must(await runLive("curl", [
      "-sSL", "--proxy", CFG.ghProxy, "--max-time", "180", "-o", runtime,
      "https://github.com/AppImage/type2-runtime/releases/download/continuous/runtime-x86_64",
    ], { label: "下载 AppImage runtime" }), "下载 AppImage runtime");
  }
  const src = wslPath(ROOT);
  const dest = wslPath(linuxDir());
  const key = wslPath(join(opts.keys, "diagramon.key"));
  const pw = wslPath(join(opts.keys, "password.txt"));
  const runtimeFile = wslPath(runtime);
  const script = join(TMP_DIR, `linux-build-${VERSION}.sh`);
  writeFileSync(script, `#!/bin/bash
set -euo pipefail
export PATH="/root/.cargo/bin:$PATH"
# linuxdeploy/appimagetool 在没有 FUSE 的环境里也能跑（CI/容器/受限桌面）
export APPIMAGE_EXTRACT_AND_RUN=1
# 用本地 runtime：appimagetool 的在线下载在受限网络里会直接失败
export LDAI_RUNTIME_FILE=${runtimeFile}
mkdir -p ${WSL_TOOLING}
if [ ! -x ${WSL_TOOLING}/node_modules/.bin/tauri ]; then
  cd ${WSL_TOOLING}
  npm init -y >/dev/null 2>&1 || true
  npm i --no-audit --no-fund @tauri-apps/cli@^2
fi
mkdir -p ${WSL_REPO}
rsync -a --delete \
  --exclude '.git/' --exclude 'target/' --exclude 'var/' --exclude 'node_modules/' \
  --exclude '.tooling/' --exclude 'local-build/' --exclude 'ui/.shots/' \
  ${src}/ ${WSL_REPO}/
cd ${WSL_REPO}
# 红线 1：开发产物清干净再打包（deb/AppImage 的载荷抽查在这里做，Windows 侧没有 dpkg）
node tools/prepack.mjs
node tools/prepack.mjs --check
export TAURI_SIGNING_PRIVATE_KEY=${key}
export TAURI_SIGNING_PRIVATE_KEY_PASSWORD=$(cat ${pw})
${WSL_TOOLING}/node_modules/.bin/tauri build --bundles appimage,deb

echo '[linux-check] deb 载荷'
DEB=$(ls target/release/bundle/deb/*.deb | head -1)
# 先落一份清单再 grep：dpkg-deb -c 直接接 grep -q 会让它吃 SIGPIPE，
# 而脚本开了 pipefail ⇒ 载荷抽查自己把构建判失败（实测 2026-11-16）。
dpkg-deb -c "$DEB" > /tmp/dgm-deb-list.txt
grep -q 'ui/index.html' /tmp/dgm-deb-list.txt
grep -q 'assets/drawio/host.html' /tmp/dgm-deb-list.txt
if grep -q 'ui/.shots' /tmp/dgm-deb-list.txt; then
  echo 'deb 里有 ui/.shots —— prepack 没跑到' >&2; exit 1
fi
echo '[linux-check] AppImage 载荷'
TMPD=$(mktemp -d)
cd "$TMPD"
${WSL_REPO}/target/release/bundle/appimage/*.AppImage --appimage-extract >/dev/null 2>&1
for base in squashfs-root/usr/lib/Diagramon squashfs-root/usr/lib/diagramon; do
  if [ -d "$base" ]; then
    test -f "$base/ui/index.html"
    test -f "$base/assets/drawio/host.html"
    echo "[linux-check] AppImage 资源目录 $base"
    ok=1
    break
  fi
done
if [ "\${ok:-}" != "1" ]; then echo 'AppImage 里找不到 ui/ 与 assets/ 的安装目录' >&2; exit 1; fi
cd ${WSL_REPO}

mkdir -p ${dest}
# 只回拷本版产物：WSL 的 target 跨次保留（rsync 排除了 target/），
# '*.deb' 会把上一版一起拷回来（3.15.1 发布时目录里就又是 3.14.5/3.15.0 的 deb）。
cp -f target/release/bundle/appimage/Diagramon_${VERSION}_*.AppImage ${dest}/
cp -f target/release/bundle/appimage/Diagramon_${VERSION}_*.AppImage.sig ${dest}/ 2>/dev/null || true
cp -f target/release/bundle/deb/Diagramon_${VERSION}_*.deb ${dest}/
ls -l ${dest}
`, "utf8");
  must(await runLive("wsl.exe", ["-d", WSL_DISTRO, "-u", "root", "--", "bash", wslPath(script)], {
    label: `WSL 构建 Linux 产物（${WSL_DISTRO}）`,
  }), "Linux 构建");
  if (!appImage()) die("Linux 产物缺失：*.AppImage（WSL 构建没产出或没拷回）");
  if (!debFile()) die("Linux 产物缺失：*.deb");
  if (!existsSync(appImageSig())) die("Linux 更新产物缺失：*.AppImage.sig（update artifacts 没开？）");
  assertSignature(appImage(), appImageSig());
  log(`✓ ${basename(appImage())} ${mb(appImage())} MB · ${basename(debFile())} ${mb(debFile())} MB`);
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
  const platforms = { "windows-x86_64": { signature: sig, url } };
  if (opts.linux) {
    const ai = appImage();
    const asig = appImageSig();
    if (!ai || !asig || !existsSync(asig)) die("Linux 更新产物缺失：AppImage 或 .sig —— 先跑 linux 步");
    const aurl = `https://github.com/${CFG.repo}/releases/download/${TAG}/${basename(ai)}`;
    // 红线 3 的 Linux 版：Tauri 更新器在 Linux **只认 AppImage**（deb/rpm 没有自更新）。
    if (!/\.AppImage$/i.test(aurl)) die(`Linux 清单 url 必须指向 .AppImage（收到 ${aurl}）`);
    platforms["linux-x86_64"] = { signature: readFileSync(asig, "utf8").trim(), url: aurl };
  }
  const m = {
    version: VERSION,
    notes: notes.startsWith("Diagramon") ? notes : `Diagramon ${VERSION}：${notes}`,
    pub_date: new Date().toISOString().replace(/\.\d+Z$/, "Z"),
    platforms,
  };
  if (opts.dryRun) return;   // 已在本函数开头早退，这里只是兜底
  writeFileSync(manifestFile(), JSON.stringify(m, null, 2) + "\n", "utf8");
  const back = JSON.parse(readFileSync(manifestFile(), "utf8"));
  if (back.version !== VERSION || back.platforms["windows-x86_64"].signature !== sig) die("清单回读不一致");
  if (opts.linux && back.platforms["linux-x86_64"].signature !== platforms["linux-x86_64"].signature) {
    die("清单回读不一致（linux-x86_64 签名）");
  }
  log(`✓ latest.json 重新生成（pub_date ${m.pub_date}，Windows 签名 ${sig.length} 字符${opts.linux ? "，含 linux-x86_64" : ""}）`);
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
  // 推之前**断言 gitee-master 确实是由当前分支重建的**（审计 2026-11-03 G-8）。
  //
  // 这条不变式只由 `branches` 步保证，而它可以被 `--from=push` / `--only=push` 跳过。
  // 跳过时本地残留的 `gitee-master` 会被当成本次内容 force-with-lease 推上去 ——
  // lease 只防"远端被别人动过"，防不了"我推的是旧货"：Gitee 首页于是停在上一版
  // README / 代码，而日志照样打 "✓ 已推两端"（正是红线 4 要防的两分支不一致）。
  if (!opts.dryRun) {
    const parent = gitOpt(["rev-parse", "gitee-master^"]).out.trim();
    if (!parent) {
      die("本地没有 gitee-master 分支 —— 先跑 branches 这一步（或用 --only=branches）");
    }
    if (parent !== mainSha) {
      die(
        `gitee-master 不是由当前 ${opts.branch}（${mainSha.slice(0, 7)}）重建的：它的父提交是 `
          + `${parent.slice(0, 7)}。先跑 branches（红线 4），别把旧 README 推上去`,
      );
    }
    const ahead = gitOpt(["rev-list", "--count", `${mainSha}..gitee-master`]).out.trim();
    if (ahead !== "1") {
      die(`gitee-master 应当恰好比 ${opts.branch} 多 1 个提交，实际 ${ahead} 个 —— 先重跑 branches`);
    }
  }
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
  const ai = appImage();
  const appimageUrl = ai ? `https://github.com/${CFG.repo}/releases/download/${TAG}/${basename(ai)}` : "";
  const deb = debFile();
  const debUrl = deb ? `https://github.com/${CFG.repo}/releases/download/${TAG}/${basename(deb)}` : "";
  let body = readFileSync(notesFile(), "utf8")
    .replace(/^(?:摘要|summary)[:：].*$\n?/im, "")   // 「摘要：」只喂 latest.json 的 notes，不进 Release 正文
    .replaceAll("{{version}}", VERSION)
    .replaceAll("{{date}}", new Date().toISOString().slice(0, 10))
    .replaceAll("{{setup_url}}", setupUrl)
    .replaceAll("{{zip_url}}", zipUrl)
    .replaceAll("{{appimage_url}}", appimageUrl)
    .replaceAll("{{deb_url}}", debUrl)
    .replaceAll("{{setup_size_mb}}", existsSync(setupExe()) ? mb(setupExe()) : "?")
    .replaceAll("{{zip_size_mb}}", existsSync(portableZip()) ? mb(portableZip()) : "?")
    .replaceAll("{{appimage_size_mb}}", ai ? mb(ai) : "?")
    .replaceAll("{{deb_size_mb}}", deb ? mb(deb) : "?");
  if (!body.includes("# 中文") || !body.includes("# English")) die("正文双语段缺失");
  if (!body.includes(setupUrl)) die("正文里没有安装包下载链接（模板里要写 {{setup_url}}）");
  // 便携包链接同样必须**可点**：Gitee 不传便携 ZIP，正文没链接等于拿不到便携版
  // （2026-10-12 就漏过一次：两个 zip 只在正文外当附件躺着）。
  if (opts.portable && !body.includes(zipUrl)) {
    die(`正文里没有便携包下载链接（模板里要写 {{zip_url}}）—— Gitee 不传便携 ZIP，没链接就拿不到 ${basename(portableZip())}`);
  }
  // Linux 只发 GitHub（Gitee 单附件上限 100 MiB，AppImage 会超）：正文必须给出直链，
  // 否则在 Release 页外根本拿不到 Linux 包。
  if (opts.linux) {
    if (!appimageUrl || !body.includes(appimageUrl)) die("正文里没有 AppImage 下载链接（模板里要写 {{appimage_url}}）");
    if (!debUrl || !body.includes(debUrl)) die("正文里没有 deb 下载链接（模板里要写 {{deb_url}}）");
  }
  return body;
}

/** Gitee 的正文：安装包链接换成 Gitee 自己的附件（国内可下），便携包仍指 GitHub。 */
function giteeReleaseBody(body) {
  return body.replaceAll(
    `https://github.com/${CFG.repo}/releases/download/${TAG}/${basename(setupExe())}`,
    cnSetupUrl(),
  );
}

async function publish() {
  step("publish · GitHub Release + Gitee Release");
  const body = releaseBody();
  if (opts.dryRun) {
    log(`  正文 ${body.length} 字符（含「# 中文」与「# English」，含安装包链接）`);
    if (opts.bodyOnly) log(`  计划（--body-only）：PATCH 两端 Release 的说明，不动附件、不改发布状态`);
    else log(`  计划：GitHub 草稿 → 删同名旧附件 → 上传 ${opts.portable ? 4 : 3} 个 → Gitee 创建/更新 → 上传安装包 + latest-cn.json → 回读校验 → 清理旧附件（保留 ${GITEE_KEEP_INSTALLERS} 个）→ **最后** PATCH GitHub draft=false`);
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
    const giteeBody = giteeReleaseBody(body);
    writeFileSync(gBody, JSON.stringify({ tag_name: TAG, name: `Diagramon ${VERSION}`, body: giteeBody }), "utf8");
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
    if (opts.linux) {
      for (const f of [appImage(), appImageSig(), debFile()]) if (f) mine.add(basename(f));
    }
    for (const a of assets) {
      if (!mine.has(a.name)) continue;
      log(`  删旧附件 ${a.name}（id ${a.id}）`);
      curlJson({ method: "DELETE", url: `https://api.github.com/repos/${CFG.repo}/releases/assets/${a.id}`, token: ghToken(), proxy: CFG.ghProxy, expect: [204] });
    }
    const files = [setupExe(), sigFile(), manifestFile()];
    if (opts.portable) files.push(portableZip());
    if (opts.linux) files.push(appImage(), appImageSig(), debFile());
    for (const f of files) if (f) await uploadAsset(id, f);
    // ⚠️ 这里**不能**立刻 draft=false：先让 Gitee 把安装包与 latest-cn.json 传完、校验通过，
    // 再把 GitHub 正式发布。否则国内用户可能拿到一个指向 404 的清单，而 updater 不会回退。
  }
  log(`  GitHub: https://github.com/${CFG.repo}/releases/tag/${TAG}`);

  // ── Gitee（国内更新源：安装包 + latest-cn.json；不传便携 ZIP / .sig）
  const gFile = join(TMP_DIR, `gitee-${VERSION}.json`);
  const giteeBody = giteeReleaseBody(body);
  writeFileSync(gFile, JSON.stringify({ tag_name: TAG, name: `Diagramon ${VERSION}`, body: giteeBody, target_commitish: "master", prerelease: false }), "utf8");
  const gTok = giteeToken();
  const cur = curlJson({ url: `https://gitee.com/api/v5/repos/${CFG.repo}/releases/tags/${TAG}?access_token=${gTok}`, expect: [200, 404] });
  let giteeId = cur.json?.id;
  if (giteeId) {
    // ⚠️ Gitee 的更新接口必须带 tag_name，否则 400 tag_name is missing
    curlJson({ method: "PATCH", url: `https://gitee.com/api/v5/repos/${CFG.repo}/releases/${giteeId}?access_token=${gTok}`, body: gFile, proxy: null });
    log(`  ✓ Gitee Release ${giteeId} 已更新说明`);
  } else {
    const created = curlJson({ method: "POST", url: `https://gitee.com/api/v5/repos/${CFG.repo}/releases?access_token=${gTok}`, body: gFile, proxy: null });
    giteeId = created.json?.id;
    log(`  ✓ Gitee Release 已创建 id=${giteeId}`);
  }

  if (!opts.dryRun) {
    if (!giteeId) die("Gitee Release 没拿到 id —— 国内更新源无法建立");
    writeCnManifest();
    await uploadGiteeAsset(giteeId, setupExe());
    await uploadGiteeAsset(giteeId, cnManifestFile());
    pruneGiteeInstallers();
    verifyGitee(giteeId);
    // ── 最后才把 GitHub 草稿切成已发布（红线：Gitee 未就绪时不能先发）
    curlJson({ method: "PATCH", url: `https://api.github.com/repos/${CFG.repo}/releases/${id}`, body: bodyFile, token: ghToken(), proxy: CFG.ghProxy });
    log("  ✓ GitHub Release 已正式发布（draft=false）");
  }
}

/** 远端文件总字节数（Range 请求，不真下整包）。GitHub 会 302 到对象存储，
 *  响应头逐段打印 —— 取**最后一段**的 content-range / content-length。 */
function remoteFileSize(url, tagName) {
  const hdr = join(TMP_DIR, `head-${tagName}-${VERSION}.txt`);
  const sink = join(TMP_DIR, `head-${tagName}-${VERSION}.bin`);
  capture("curl", ["-sL", "-r", "0-0", "-D", hdr, "-o", sink, "--proxy", CFG.ghProxy, "--max-time", "180", url]);
  const text = existsSync(hdr) ? readFileSync(hdr, "utf8") : "";
  const range = text.match(/content-range:\s*bytes\s+\d+-\d+\/(\d+)/i);
  if (range) return Number(range[1]);
  const cls = [...text.matchAll(/^content-length:\s*(\d+)/gim)].map((m) => Number(m[1]));
  return cls.length ? cls[cls.length - 1] : null;
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

  // Linux（Tauri 更新器在 Linux 只认 AppImage）：签名与 url 都要逐字节/逐字核对。
  if (opts.linux) {
    const lSigPath = appImageSig();
    if (!lSigPath || !existsSync(lSigPath)) die("本地缺少 Linux .AppImage.sig —— linux 步没跑？");
    const pl = pulled.platforms?.["linux-x86_64"];
    if (!pl) die("更新源上没有 linux-x86_64 —— Linux 清单没写进去或 Release 不是本次那版");
    if (pl.signature !== readFileSync(lSigPath, "utf8").trim()) {
      die("更新源的 linux-x86_64 signature 与本地 AppImage.sig 不一致");
    }
    if (!/\.AppImage$/i.test(String(pl.url || "")) || !String(pl.url).includes(`/releases/download/${TAG}/`)) {
      die(`更新源 linux-x86_64 的 url 不对（必须指向本次 AppImage）：${pl.url}`);
    }
    const aiSize = statSync(appImage()).size;
    const aiRemote = remoteFileSize(pl.url, "linux");
    if (aiRemote == null) warn("拿不到远端 AppImage 长度，跳过字节数核对");
    else if (aiRemote !== aiSize) die(`远端 AppImage ${aiRemote} 字节 ≠ 本地 ${aiSize} 字节`);
    else log(`✓ linux-x86_64：signature 一致、url 指向本次 AppImage、字节数与本地一致（${aiSize}）`);
  }

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
  if (opts.linux) want.push(basename(appImage()), basename(appImageSig()), basename(debFile()));
  for (const w of want) if (!(rel.json.assets || []).some((a) => a.name === w && a.state === "uploaded")) die(`附件缺失或未完成：${w}`);
  log(`✓ ${want.length} 个附件齐全且状态 uploaded`);

  // ── Gitee 国内更新源（安装包 + latest-cn.json）
  const gRel = curlJson({
    url: `https://gitee.com/api/v5/repos/${CFG.repo}/releases/tags/${TAG}?access_token=${giteeToken()}`,
    proxy: null,
    expect: [200, 404],
  });
  if (gRel.json?.id) {
    const atts = giteeAttachments(gRel.json.id);
    if (atts.some((a) => a.name === "latest-cn.json")) {
      verifyGitee(gRel.json.id);
    } else {
      warn("Gitee 上没有 latest-cn.json —— 国内更新清单尚未建立（旧版本或上传失败）");
    }
  } else {
    warn(`Gitee 上找不到 ${TAG} 的 Release —— 国内更新源缺失`);
  }

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
  --no-linux      不产 Linux 产物（AppImage + deb；默认产，走 WSL 构建）
  --branch=<名>   主分支，默认 main
  --keys=<目录>   签名密钥目录，默认 ../keys
  --list-steps    列出步骤

步骤
  ${STEPS.join("  ")}`);
}

// ── 主流程 ────────────────────────────────────────────────────────────────
const IMPL = { preflight, prepack, build, linux: linuxStep, portable: portableStep, manifest, tag, branches, push, publish, verify };

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
  for (const s of todo) {
    await IMPL[s]();
    ran.add(s);
  }
  log("");
  log(`✔ 全部步骤完成（${todo.join(" → ")}），耗时 ${((Date.now() - t0) / 60000).toFixed(1)} 分钟`);
  log(`日志：${LOG_FILE}`);
}

main().catch((e) => die(e && e.stack ? e.stack : String(e)));

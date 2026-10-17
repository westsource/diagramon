#!/usr/bin/env node
/**
 * 取 D2 资产：把 npm 包 @d2lang/d2 的**浏览器构建**解出到 `tools/d2/index.js`。
 *
 *   node tools/fetch-d2.mjs                 自动获取（已就位且与 pin 一致 → 直接跳过）
 *   node tools/fetch-d2.mjs --verify        只校验（不联网）
 *   node tools/fetch-d2.mjs --force         忽略已就位的那份，重新获取
 *   node tools/fetch-d2.mjs --from <tgz>    完全离线：用本地 tarball（气隙机器 / CI 缓存）
 *   node tools/fetch-d2.mjs --hash <tgz>    打印某个 tarball 的 sha256（登记新版本时用）
 *
 * 版本由 `tools/d2.version`（**入库**）钉住，与 `tools/{drawio,excalidraw,graphviz}.version` 同一口径。
 *
 * ## 获取顺序（拿到 tarball 的四条路，前一条不通就试下一条）
 *
 *   1. `--from <tgz>` 指定的本地 tarball（离线）
 *   2. `tools/d2/d2lang-d2-<版本>.tgz`（本机已缓存的 tarball）
 *   3. `npm pack`（先用随包的 `tools/node/npm.cmd`，再用 PATH 上的 npm；默认 registry → npmmirror 镜像）
 *   4. 直接 HTTP 下载 registry 上的 tarball 地址（机器上没有 npm 也能取）
 *
 * 不管走哪条路，**都要过 `TARBALL_SHA` 的 sha256 校验**（见下）。
 *
 * ## 产物（都落在 `tools/d2/`，.gitignore 已忽略）
 *
 *   index.js                包内 `package/dist/browser/index.js` 原样解出（约 11MB，wasm 以内联 base64 在里面）
 *   LICENSE.txt             上游 MPL-2.0 正文（随包分发时的归属声明，正式文本另见仓库根 NOTICE）
 *   THIRD_PARTY_NOTICES.txt 上游自己的第三方清单（D2 的 Go 依赖）
 *   .manifest.json          版本 + 每个文件的字节数与 sha256（`--verify` 与幂等跳过的判据）
 *
 * ## 为什么必须钉 sha256（而不是只钉版本号）
 *
 * 取资产的来源是**外部 registry / 镜像**，落到本机后会被打进安装包发给用户。
 * 只钉版本号的话，镜像投毒（同一版本号换内容）我们看不出来；钉住 tarball 的 sha256 才拦得住。
 * 这也是 `package-lock.json` 的 integrity 字段在做的事，只是我们这里没有 npm 工程。
 *
 * ## 为什么不能放进 `ui/`
 *
 * `ui/` 是前端源码树，**入库**且参与构建（`build.frontendDist = "../ui"` 会把 ui 再嵌进 exe 一份）。
 * D2 的 wasm 构建是上游产物，11MB 只该存在一份，按挂载点约定落在 `tools/<挂载点>/`，
 * 运行时由 `crates/assets` 挂到 `/d2/`（入口 `index.js`），随包形态进 `assets/`。
 */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const D2_DIR = join(ROOT, "tools", "d2");
const PIN_FILE = join(ROOT, "tools", "d2.version");
const INDEX = join(D2_DIR, "index.js");
const LICENSE = join(D2_DIR, "LICENSE.txt");
const NOTICES = join(D2_DIR, "THIRD_PARTY_NOTICES.txt");
const MANIFEST = join(D2_DIR, ".manifest.json");

const PACKAGE = "@d2lang/d2";
const LICENSE_MARKER = "Mozilla Public License Version 2.0";

/** 版本 → **tarball** 的 sha256。镜像换内容也拦得住（只钉版本号拦不住）。
 *
 *  登记新版本：先把包取到本地（`npm pack @d2lang/d2@<版本>`），
 *  跑 `node tools/fetch-d2.mjs --hash <tgz>` 得到 sha256，抄进这张表，再改 `tools/d2.version`。 */
const TARBALL_SHA = {
  "0.1.34": "3256bd0f8865e749175c85d013b461c9569fcfd798ff1f9ca1a4f89d29feb647",
};

/** tarball 里我们要的三个成员（wasm 的 node-cjs / node-esm 两份不要）。 */
const MEMBERS = ["package/dist/browser/index.js", "package/LICENSE.txt", "package/THIRD_PARTY_NOTICES.txt"];
/** 镜像候选：`null` = npm 的默认 registry（走机器上的 npm 配置，含代理）。 */
const REGISTRIES = [null, "https://registry.npmmirror.com"];
const DEFAULT_REGISTRY = "https://registry.npmjs.org";

const argv = process.argv.slice(2);
const VERIFY_ONLY = argv.includes("--verify");
const FORCE = argv.includes("--force");
const fromArg = argv.indexOf("--from");
const FROM = fromArg >= 0 ? resolve(argv[fromArg + 1] || "") : null;
const hashArg = argv.indexOf("--hash");
const HASH_ONLY = hashArg >= 0 ? resolve(argv[hashArg + 1] || "") : null;
const versionArg = argv.find((a) => a.startsWith("--version="));
const VERSION_OVERRIDE = versionArg ? versionArg.slice("--version=".length) : null;

const TTY = process.stdout.isTTY;
const log = (s = "") => process.stdout.write(`${s}\n`);
const red = (s) => (TTY ? `\x1b[31m${s}\x1b[0m` : s);
const green = (s) => (TTY ? `\x1b[32m${s}\x1b[0m` : s);
const yellow = (s) => (TTY ? `\x1b[33m${s}\x1b[0m` : s);
const dim = (s) => (TTY ? `\x1b[2m${s}\x1b[0m` : s);
const mb = (n) => (n / 1024 / 1024).toFixed(1) + "MB";

const sha256 = (file) => createHash("sha256").update(readFileSync(file)).digest("hex");

/** 版本 pin（入库的那份）；缺了或格式不对就直接报错，别让它悄悄用别的版本。 */
function readPin() {
  if (!existsSync(PIN_FILE)) {
    log(red(`✗ 缺版本 pin 文件 ${PIN_FILE}`));
    process.exit(2);
  }
  const v = readFileSync(PIN_FILE, "utf8").trim();
  if (!/^\d+\.\d+\.\d+$/.test(v)) {
    log(red(`✗ ${PIN_FILE} 内容不是合法的语义化版本号：'${v}'`));
    process.exit(2);
  }
  return VERSION_OVERRIDE || v;
}

function readManifest() {
  if (!existsSync(MANIFEST)) return null;
  try {
    return JSON.parse(readFileSync(MANIFEST, "utf8"));
  } catch (e) {
    return null;
  }
}

/** 一份就位的产物是否完整且与 pin 一致。返回 null 表示通过，否则是原因。 */
function problems(version) {
  const m = readManifest();
  if (!m) return `缺清单 ${MANIFEST}`;
  if (m.version !== version) return `清单版本(${m.version})与 pin(${version})不一致`;
  for (const [path, file] of [
    ["index.js", INDEX],
    ["LICENSE.txt", LICENSE],
    ["THIRD_PARTY_NOTICES.txt", NOTICES],
  ]) {
    const want = (m.files || []).find((f) => f.path === path);
    if (!want) return `清单缺少 ${path} 条目`;
    if (!existsSync(file)) return `缺少 ${file}`;
    const bytes = statSync(file).size;
    if (bytes !== want.bytes) return `${path} 字节数不符：实际 ${bytes}，清单 ${want.bytes}`;
    const got = sha256(file);
    if (got !== want.sha256) return `${path} sha256 不符：实际 ${got}，清单 ${want.sha256}`;
  }
  // 归属：随包分发的东西必须有可核对的许可证正文（与 fetch-graphviz.ps1 同一理由）
  if (!readFileSync(LICENSE, "utf8").includes(LICENSE_MARKER)) {
    return `LICENSE.txt 不是 MPL-2.0 正文（上游声明为 MPL-2.0）`;
  }
  return null;
}

/* ---------------------------------------------------------------- 取 tarball */

function npmCandidates() {
  const out = [];
  const bundled = join(ROOT, "tools", "node", process.platform === "win32" ? "npm.cmd" : "npm");
  if (existsSync(bundled)) out.push(bundled);
  out.push(process.platform === "win32" ? "npm.cmd" : "npm");
  return out;
}

/** 跑一次 npm。
 *
 *  Windows 上 npm 是 `.cmd`：CreateProcess 起不了批处理，而 node 的 `shell: true`
 * 会把参数 join 成串丢给 cmd.exe 且**不加引号**（仓库里那条"不要 shell:true"的红线就是为它写的，
 * 而且 Node 24 还会为此报 DEP0190）。所以这里显式走 `cmd.exe /d /s /c` 并**自己加引号**：
 * tarball 落在临时目录里，那个路径**可能带空格**。 */
function runNpm(cmd, args, cwd) {
  const quote = (a) => (/[\s"^&|<>]/.test(a) ? `"${String(a).replace(/"/g, '""')}"` : a);
  if (process.platform === "win32" && /\.(cmd|bat)$/i.test(cmd)) {
    const com = process.env.ComSpec || "cmd.exe";
    return spawnSync(com, ["/d", "/s", "/c", quote(cmd), ...args.map(quote)], { encoding: "utf8", cwd });
  }
  return spawnSync(cmd, args, { encoding: "utf8", cwd });
}

/** `npm pack` 取包（写到 `dest`，故用 cwd 而不是 `--pack-destination`，少一个可能带空格的参数）。 */
function packViaNpm(version, dest, registry) {
  const spec = `${PACKAGE}@${version}`;
  for (const cmd of npmCandidates()) {
    const args = ["pack", spec];
    if (registry) args.push(`--registry=${registry}`);
    const r = runNpm(cmd, args, dest);
    const label = `${cmd} (${registry || "默认 registry"})`;
    if (r.error) {
      log(dim(`  ${label} 不可用：${r.error.message}`));
      continue;
    }
    const tgz = (readdirSync(dest) || []).find((f) => f.endsWith(".tgz"));
    if (r.status === 0 && tgz) {
      log(dim(`  npm pack 成功（${label}）`));
      return join(dest, tgz);
    }
    log(dim(`  ${label} 失败（exit=${r.status}）`));
    const tail = String(r.stderr || r.stdout || "").trim().split("\n").slice(-3).join("\n    ");
    if (tail) log(dim(`    ${tail}`));
  }
  return null;
}

/** 机器上没有 npm 时的兜底：直接从 registry 下 tarball（URL 形态见 npm registry 约定）。 */
async function downloadDirect(version, dest, registry) {
  const base = registry || DEFAULT_REGISTRY;
  const url = `${base}/${PACKAGE}/-/d2-${version}.tgz`;
  try {
    const r = await fetch(url, { redirect: "follow" });
    if (!r.ok) {
      log(dim(`  HTTP ${r.status} —— ${url}`));
      return null;
    }
    const buf = Buffer.from(await r.arrayBuffer());
    const file = join(dest, `d2lang-d2-${version}.tgz`);
    writeFileSync(file, buf);
    log(dim(`  直接下载成功（${base}，${mb(buf.length)}）`));
    return file;
  } catch (e) {
    log(dim(`  直接下载失败：${(e && e.message) || e} —— ${url}`));
    return null;
  }
}

/** 按顺序试四条路，返回第一个可用的 tarball 路径。 */
async function acquire(version, dest) {
  if (FROM) {
    if (!existsSync(FROM)) {
      log(red(`✗ --from 指定的文件不存在：${FROM}`));
      process.exit(2);
    }
    log(`使用 --from 指定的 tarball：${FROM}`);
    return FROM;
  }

  const cached = join(D2_DIR, `d2lang-d2-${version}.tgz`);
  if (existsSync(cached)) {
    log(`使用已缓存的 tarball：${cached}`);
    return cached;
  }

  log(`获取 ${PACKAGE}@${version} …`);
  for (const registry of REGISTRIES) {
    const packed = packViaNpm(version, dest, registry);
    if (packed) return packed;
  }
  for (const registry of REGISTRIES) {
    const got = await downloadDirect(version, dest, registry);
    if (got) return got;
  }
  return null;
}

/* ---------------------------------------------------------------- 校验 tarball */

/**
 * tarball 的 sha256 必须与 `TARBALL_SHA` 里登记的一致。
 *
 * 没登记的版本**直接失败**：宁可让维护者抄一次哈希，也不让"来源不明的 11MB 二进制"
 * 悄悄进安装包（它随后会被打进发给用户的产物里）。
 */
function checkTarball(tgz, version) {
  const want = TARBALL_SHA[version];
  const got = sha256(tgz);
  if (!want) {
    log(red(`✗ ${PACKAGE}@${version} 的 tarball sha256 还没登记`));
    log("");
    log(`  实测：${got}`);
    log(`  请把它抄进 tools/fetch-d2.mjs 的 TARBALL_SHA（然后重跑），键是 "${version}"。`);
    log(dim("  换版本时这是**故意**的手工一步：哈希是这条路唯一的防线。"));
    process.exit(1);
  }
  if (got !== want) {
    log(red(`✗ tarball sha256 不符（可能是镜像投毒或下载损坏）`));
    log(`  实际：${got}`);
    log(`  期望：${want}`);
    process.exit(1);
  }
  log(green(`✓ tarball 校验通过（${mb(statSync(tgz).size)}，sha256 ${got.slice(0, 12)}…）`));
}

/* ---------------------------------------------------------------- 解包与落盘 */

function extract(tgz, dest) {
  const r = spawnSync("tar", ["-xzf", tgz, "-C", dest, ...MEMBERS], { encoding: "utf8" });
  if (r.error) {
    log(red(`✗ 调用 tar 失败：${r.error.message}（需要 bsdtar：Windows 10+ / macOS / Linux 自带）`));
    process.exit(2);
  }
  if (r.status !== 0) {
    log(red(`✗ 解包失败（exit=${r.status}）`));
    if (r.stderr) log(dim(r.stderr.trim()));
    process.exit(2);
  }
  for (const m of MEMBERS) {
    if (!existsSync(join(dest, m))) {
      log(red(`✗ tarball 里没有 ${m}`));
      process.exit(2);
    }
  }
}

function install(tmp, version) {
  mkdirSync(D2_DIR, { recursive: true });
  const picks = [
    ["package/dist/browser/index.js", INDEX],
    ["package/LICENSE.txt", LICENSE],
    ["package/THIRD_PARTY_NOTICES.txt", NOTICES],
  ];
  const files = [];
  for (const [from, to] of picks) {
    // 临时目录常在别的盘（Windows 下 C: vs 项目盘），所以"移动"用复制
    rmSync(to, { force: true });
    copyFileSync(join(tmp, from), to);
    files.push({ path: to.slice(D2_DIR.length + 1), bytes: statSync(to).size, sha256: sha256(to) });
  }
  writeFileSync(MANIFEST, JSON.stringify({ version, files }, null, 2) + "\n", "utf8");
  return files;
}

/* ---------------------------------------------------------------- 主流程 */

async function main() {
  if (HASH_ONLY) {
    if (!existsSync(HASH_ONLY)) {
      log(red(`✗ 文件不存在：${HASH_ONLY}`));
      return 2;
    }
    log(sha256(HASH_ONLY));
    return 0;
  }

  const version = readPin();

  if (VERIFY_ONLY) {
    const bad = problems(version);
    if (bad) {
      log(red(`✗ 校验失败：${bad}`));
      log(yellow("  先跑一次 node tools/fetch-d2.mjs 获取（或 --from <tgz> 走离线包）"));
      return 1;
    }
    log(green(`✓ tools/d2/index.js 校验通过（${mb(statSync(INDEX).size)}，sha256 ${sha256(INDEX).slice(0, 12)}…）`));
    log(dim(`  版本 ${PACKAGE}@${version} · 归属 ${LICENSE.slice(ROOT.length + 1)} · 清单 ${MANIFEST.slice(ROOT.length + 1)}`));
    return 0;
  }

  // 幂等：与 pin 完全一致就不动它（与 fetch-graphviz.ps1 同一行为）
  if (!FORCE && !FROM) {
    const bad = problems(version);
    if (!bad) {
      log(green(`✓ D2 资产已就位且与 pin 一致（${PACKAGE}@${version}），跳过获取`));
      log(dim(`  产物 ${INDEX.slice(ROOT.length + 1)}（${mb(statSync(INDEX).size)}）—— 要重取加 --force`));
      return 0;
    }
    log(yellow(`需要重新获取：${bad}`));
  }

  const tmp = mkdtempSync(join(tmpdir(), "diagramon-d2-"));
  try {
    const tgz = await acquire(version, tmp);
    if (!tgz) {
      log(red(`✗ 取不到 ${PACKAGE}@${version} 的 tarball`));
      log("");
      log("  四条路都试过了：--from / 本地缓存 / npm pack（默认 registry 与 npmmirror）/ 直接下载。");
      log("  有网机器上也可以手工取一次再拷过来：");
      log(`    npm pack ${PACKAGE}@${version}`);
      log(`    node tools/fetch-d2.mjs --from ./d2lang-d2-${version}.tgz`);
      return 2;
    }
    checkTarball(tgz, version);
    extract(tgz, tmp);
    const files = install(tmp, version);
    log(green(`✓ 解出 ${INDEX.slice(ROOT.length + 1)}（${mb(files[0].bytes)}，${PACKAGE}@${version}）`));
    log(dim(`  归属与清单：${LICENSE.slice(ROOT.length + 1)} / ${NOTICES.slice(ROOT.length + 1)} / ${MANIFEST.slice(ROOT.length + 1)}`));
    log(dim(`  下一步：node tools/fetch-assets.mjs（把 tools/d2 汇到 assets/d2）`));
    return 0;
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

process.exit(await main());

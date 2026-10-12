#!/usr/bin/env node
/**
 * 打便携版 ZIP（免安装、解压即用）。
 *
 *   node tools/pack-portable.mjs            # 用 src-tauri/tauri.conf.json 里的版本号
 *   node tools/pack-portable.mjs --version 3.0.1
 *   node tools/pack-portable.mjs --out D:/dist
 *
 * 产物：`Diagramon-<版本>-win-x64.zip`（默认落在 target/release/bundle/portable/）
 * 命名沿用旧客户端仓库的规矩：`Diagramon-<版本>-<runtime>.zip`，文件在**压缩包根**（无外层文件夹）。
 *
 * 为什么必须有 WebView2Loader.dll：release 的 diagramon.exe 导入表里是**动态**依赖它
 * （`objdump -p target/release/diagramon.exe | grep "DLL Name"` 能看到），
 * 少了它双击就起不来 —— 而 NSIS 安装包是把它一起装进去的，所以便携包也得带上。
 *
 * 为什么必须带 ui/ 与 assets/：`dgm` 协议是**从磁盘 serve 文件**的（不是嵌进 exe），
 * 目录布局由 `crates/assets::AssetRoots::detect` 决定：它先看 `ui/../assets`
 * （即 exe 同级的 assets/），再退回源码树。少了任何一个都会白屏。
 *
 * 前置：先 `npx tauri build --bundles nsis`（或至少 `cargo build --release -p diagramon`）
 * + `node tools/fetch-assets.mjs`（assets/ 由它汇出，不入库）。
 */

import { spawnSync } from "node:child_process";
import { closeSync, cpSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const RELEASE = join(ROOT, "target", "release");
const MOUNTS = ["drawio", "excalidraw", "graphviz", "mermaid"];

const argv = process.argv.slice(2);
const argOf = (name, fallback) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};

const version = argOf("--version", JSON.parse(readFileSync(join(ROOT, "src-tauri", "tauri.conf.json"), "utf8")).version);
const baseName = `Diagramon-${version}-win-x64`;
const outDir = resolve(argOf("--out", join(RELEASE, "bundle", "portable")));
const zipPath = join(outDir, `${baseName}.zip`);
const staging = join(ROOT, "var", "portable", baseName);

const log = (s = "") => console.log(s);
const fail = (s) => {
  log(`✗ ${s}`);
  process.exit(2);
};
const mb = (n) => (n / 1024 / 1024).toFixed(2) + " MB";

/** 目录大小 / 文件数。 */
function dirStat(dir) {
  let bytes = 0;
  let files = 0;
  for (const e of readdirSync(dir, { withFileTypes: true, recursive: true })) {
    if (e.isFile()) {
      bytes += statSync(join(e.parentPath ?? e.path, e.name)).size;
      files += 1;
    }
  }
  return { bytes, files };
}

/* ---------------------------------------------------------------- 前置检查 */

const required = [
  [join(RELEASE, "diagramon.exe"), "release 版 exe（先 `cargo build --release -p diagramon`）"],
  [join(RELEASE, "WebView2Loader.dll"), "WebView2Loader.dll（随 cargo build 生成，exe 依赖它）"],
  [join(ROOT, "ui", "index.html"), "ui/（前端外壳）"],
  [join(ROOT, "assets", "drawio", "index.html"), "assets/ 的 drawio 挂载点（先 `node tools/fetch-assets.mjs`）"],
];
for (const [p, why] of required) {
  if (!existsSync(p)) fail(`缺少 ${p} —— ${why}`);
}
for (const m of MOUNTS) {
  if (!existsSync(join(ROOT, "assets", m))) fail(`assets/${m}/ 不在位 —— 先 node tools/fetch-assets.mjs`);
}

/* ------------------------------------------------------------------ 组装 */

log(`▸ 组装便携版 ${baseName}`);
rmSync(staging, { recursive: true, force: true });
mkdirSync(staging, { recursive: true });

cpSync(join(RELEASE, "diagramon.exe"), join(staging, "diagramon.exe"));
cpSync(join(RELEASE, "WebView2Loader.dll"), join(staging, "WebView2Loader.dll"));
// ui/.shots/ 是**开发产物**（真机自检与探针的报告/日志/截图，4.8MB，gitignore 里有它），
// 不属于产品内容，便携包里剔掉。（安装包的 `bundle.resources` 是按目录整体映射的，
// 没法排除子目录 —— 那边要在打包前先清掉这个目录，见 docs/发布检查单.md。）
process.stdout.write("    ui/ … ");
cpSync(join(ROOT, "ui"), join(staging, "ui"), {
  recursive: true,
  filter: (src) => !/[/\\]\.shots([/\\]|$)/.test(src),
});
log(`${dirStat(join(staging, "ui")).files} 个文件 / ${mb(dirStat(join(staging, "ui")).bytes)}（已剔除 .shots/）`);

process.stdout.write("    assets/ … ");
cpSync(join(ROOT, "assets"), join(staging, "assets"), { recursive: true });
log(`${dirStat(join(staging, "assets")).files} 个文件 / ${mb(dirStat(join(staging, "assets")).bytes)}`);

for (const f of ["LICENSE", "NOTICE"]) {
  if (existsSync(join(ROOT, f))) cpSync(join(ROOT, f), join(staging, f));
}

// 文件名用 ASCII：7z 建 zip 时非 ASCII 名可能按**本地代码页**写进去（不带 UTF-8 标志），
// 在别的语言环境下解开就是乱码 —— 公开下载的产物不值得冒这个险。内容仍是中英对照。
writeFileSync(
  join(staging, "README-PORTABLE.txt"),
  `Diagramon ${version} · 便携版（免安装）
===============================
Portable build — unzip and run, no installer.

【中文】
怎么用
  1. 整个文件夹解压到任意位置（U 盘也行；别放在需要管理员权限的目录里）
  2. 双击 diagramon.exe 运行，不需要安装
  3. 卸载 = 直接删掉这个文件夹
     （设置与最近文件在 %APPDATA%\\Diagramon，想彻底清干净就一并删掉）

别把这些分开
  diagramon.exe 需要同目录的 WebView2Loader.dll、ui\\ 与 assets\\。
  少任何一个都会白屏或起不来 —— 别只把 exe 拷出去。

运行依赖
  只需要 Windows 10/11 自带的 WebView2 运行时（系统一般已预装）。
  不需要 Node.js、不需要 Chrome、不需要 VC++ 运行库（exe 已静态链接 CRT）。
  极老的 Win10 若提示缺 WebView2，去 https://developer.microsoft.com/microsoft-edge/webview2/
  装一次运行时即可；或者改用安装版（安装器会自己下载）。

【English】
How to run
  1. Unzip anywhere (a USB stick is fine; avoid directories that need admin rights)
  2. Run diagramon.exe — no installation step
  3. Uninstall = delete this folder
     (settings and recent files live in %APPDATA%\\Diagramon; delete that too for a clean wipe)

Keep these together
  diagramon.exe needs WebView2Loader.dll, ui\\ and assets\\ in the same folder.
  Copying just the .exe out will not work.

Requirements
  Only the system WebView2 runtime that ships with Windows 10/11.
  No Node.js, no Chrome, no VC++ redistributable (the CRT is statically linked).
  If an old Windows 10 build complains about WebView2, install the runtime once from
  https://developer.microsoft.com/microsoft-edge/webview2/ — or use the installer build,
  which downloads it automatically.
`,
  "utf8"
);

/* -------------------------------------------------------------------- 压缩 */

mkdirSync(outDir, { recursive: true });
rmSync(zipPath, { force: true });

const sevenZip = [
  process.env.SEVENZIP,
  "C:/Program Files/7-Zip/7z.exe",
  "C:/Program Files (x86)/7-Zip/7z.exe",
  "7z",
].find((p) => p && (p === "7z" ? true : existsSync(p)));

function run(cmd, args, cwd) {
  const r = spawnSync(cmd, args, { cwd, stdio: ["ignore", "inherit", "inherit"] });
  return r.status === 0;
}

log(`▸ 压缩 → ${zipPath}`);
if (sevenZip) {
  log(`    用 ${sevenZip}`);
  if (!run(sevenZip, ["a", "-tzip", "-mx=5", "-bso0", "-bsp0", zipPath, "."], staging)) fail("7z 压缩失败");
} else {
  log("    没找到 7-Zip，退回 Windows 自带的 tar（bsdtar 支持 -a 按扩展名选 zip）");
  if (!run("tar", ["-a", "-c", "-f", zipPath, "-C", staging, "."])) {
    fail("tar 压缩失败；装个 7-Zip（或设 SEVENZIP=<7z.exe 路径>）再重跑");
  }
}

/* -------------------------------------------------------------------- 校验 */

log("▸ 校验压缩包");
// 清单落文件再读，不要用 spawnSync + 管道抓 stdout：本机沙箱下会 EBUSY（与 check.mjs 踩过的是同一个坑）。
// `-scsUTF-8` 不能省：否则 7z 按控制台代码页输出，中文文件名到手上就是乱码，检查会误报"缺少"。
const listFile = join(ROOT, "var", "portable", "listing.txt");
mkdirSync(dirname(listFile), { recursive: true });
const fd = openSync(listFile, "w");
const ok = spawnSync(sevenZip || "tar", sevenZip ? ["l", "-ba", "-scsUTF-8", zipPath] : ["-tf", zipPath], {
  stdio: ["ignore", fd, fd],
}).status === 0;
closeSync(fd);
if (!ok) fail("读取压缩包清单失败");
const listingText = readFileSync(listFile, "utf8").replace(/\\/g, "/");
const must = [
  "diagramon.exe",
  "WebView2Loader.dll",
  "ui/index.html",
  "assets/drawio/index.html",
  "README-PORTABLE.txt",
];
const missing = must.filter((m) => !listingText.includes(m));
if (missing.length) fail(`压缩包里缺少：${missing.join(", ")}`);
log(`    关键条目齐备（${must.join(" / ")}）`);

const size = statSync(zipPath).size;
const raw = dirStat(staging);
log(`✓ ${zipPath}`);
log(`  ${mb(size)}（未压缩 ${mb(raw.bytes)} / ${raw.files + 2} 个文件）`);

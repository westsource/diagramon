#!/usr/bin/env node
/**
 * 打包前置：清掉不属于产品内容的东西，并校验资产在位。
 *
 *   node tools/prepack.mjs          # 清理 + 校验
 *   node tools/prepack.mjs --check  # 只看，不动手（确认清干净了没有）
 *
 * **打包（`tauri build`）之前必须跑一次。** 原因是结构性的：
 * `bundle.resources` 配的是 `{"../ui/": "ui/", "../assets/": "assets/"}` —— **按目录整体映射**，
 * tauri 的 glob 模式没有排除语法，所以只要工作树里的 `ui/` 有杂物，安装包就一定会带上。
 *
 * 目前会清的只有 `ui/.shots/`：它是真机自检与探针（check.mjs / ui_probe / canvas_probe /
 * readme_shots）的报告、日志与截图，约 4.8MB、65 个文件，`.gitignore` 里也有它。
 * 2026-10-12 第一次打 3.0.0 时没清，结果 **u​i/.shots 的 65 个文件进了安装包** ——
 * 于是有了这个脚本（便携版由 tools/pack-portable.mjs 过滤，它不受影响）。
 */

import { existsSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CHECK_ONLY = process.argv.includes("--check");
const MOUNTS = ["drawio", "excalidraw", "graphviz", "mermaid"];
const DEV_DIRS = ["ui/.shots"];

const log = (s = "") => console.log(s);
const mb = (n) => (n / 1024 / 1024).toFixed(2) + " MB";

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

let dirty = false;

for (const rel of DEV_DIRS) {
  const dir = join(ROOT, rel);
  if (!existsSync(dir)) {
    log(`  ✓ ${rel}/ 不在（本来就没跑过自检/探针，或已经清过）`);
    continue;
  }
  const s = dirStat(dir);
  dirty = true;
  if (CHECK_ONLY) {
    log(`  ✗ ${rel}/ 还在：${s.files} 个文件 / ${mb(s.bytes)} —— 打包前要先清理`);
    continue;
  }
  rmSync(dir, { recursive: true, force: true });
  log(`  ✓ 已清掉 ${rel}/：${s.files} 个文件 / ${mb(s.bytes)}`);
}

let assetsOk = true;
for (const m of MOUNTS) {
  const p = join(ROOT, "assets", m);
  const ok = existsSync(p) && readdirSync(p).length > 0;
  if (!ok) assetsOk = false;
  log(`  ${ok ? "✓" : "✗"} assets/${m}/${ok ? "" : " —— 缺失，先跑 node tools/fetch-assets.mjs"}`);
}
if (!existsSync(join(ROOT, "ui", "index.html"))) {
  assetsOk = false;
  log("  ✗ ui/index.html 缺失");
}

// 承载页是**本仓库**的文件（`tools/*-host/`），由 fetch-assets 复制进挂载点 ——
// 它们不在上游资产里，所以"取资产"漏跑时不会报缺件，只会静默用上旧的那份（实测踩过：
// target/debug/assets 里那份停在 2026-10-10，而源文件当天刚改过）。这里逐字节对一下：
// 不一致就拦住 —— 用户侧看到的是"改了没生效"，比报错难查得多。
//
// Excalidraw 那一份是 2026-10-17 补上的：它此前**根本没接进覆盖链**，于是打包出来的
// 承载页一直是源工作树里那份停更的旧副本（缺 `getScene` ⇒ 转换取不回产物），而源文件
// 早就改过了 —— 同一个坑，第二次踩。两份都要查。
const HOST_PAIRS = [
  ["tools/drawio-host/host.html", "assets/drawio/host.html"],
  ["tools/excalidraw-host/index.html", "assets/excalidraw/index.html"],
];
for (const [srcRel, dstRel] of HOST_PAIRS) {
  const src = join(ROOT, srcRel);
  const dst = join(ROOT, dstRel);
  if (!existsSync(src) || !existsSync(dst)) continue;
  if (readFileSync(src).equals(readFileSync(dst))) {
    log(`  ✓ ${dstRel} 与 ${srcRel} 一致`);
  } else {
    assetsOk = false;
    log(`  ✗ ${dstRel} 与 ${srcRel} 不一致 —— 先跑 node tools/fetch-assets.mjs`);
  }
}

if (!assetsOk) {
  log("\n✗ 资产不全，别往下打包");
  process.exit(2);
}
if (CHECK_ONLY && dirty) {
  log("\n✗ 还有开发产物没清（--check 模式不改动任何东西）");
  process.exit(1);
}
log(`\n✓ 可以打包${CHECK_ONLY ? "" : "（现在跑 npx tauri build --bundles nsis / node tools/pack-portable.mjs）"}`);

#!/usr/bin/env node
/**
 * 取资产：把五个挂载点的运行时资源汇到 `assets/`（随包形态用）。
 *
 *   node tools/fetch-assets.mjs                从默认源工作树复制到 assets/
 *   node tools/fetch-assets.mjs --from <dir>   指定源工作树
 *   node tools/fetch-assets.mjs --verify       只校验 assets/ 是否完整，不复制
 *
 * ## 为什么开发期不需要跑它
 *
 * `crates/assets` 的 `AssetRoots::detect` 会先看 `assets/`（随包），找不到才回退到
 * **源工作树**（`DIAGRAMON_SOURCE_TREE`，默认同级目录的 `client/`）。
 * 也就是说只要有 `assets/`，开发期一个字节都不用复制，93MB 也不会在仓库里多留一份。
 * 这个脚本在**打包前**跑一次，产出 `assets/` 供发布形态使用。
 *
 * ⚠️ 已知缺口（2026-10-17）：Rust 那个回退**仍只认 `client/`**（已删除，等于死代码），
 * 所以"没有 `assets/`"的机器上画布挂载点会 404 —— 先跑本脚本即可。真要修，是给
 * `AssetRoots` 支持按挂载点分别定位（本仓库 `tools/<挂载点>/`）。
 *
 * ## 源工作树怎么来
 *
 * 本仓库不存这五个运行时（见 .gitignore：`tools/drawio/`、`tools/excalidraw/`、
 * `tools/graphviz/`、`tools/mermaid/`、`tools/d2/`）。它们由**本仓库**的几个取资产脚本
 * （`tools/fetch-drawio.ps1`、`tools/fetch-excalidraw.ps1`、`tools/fetch-graphviz.ps1`、
 * `tools/fetch-d2.mjs`）下载 / 解出并离线化，产物直接落在
 * `tools/<挂载点>/`（2026-10-17 起脚本与产物都只在本仓库；旧的 `client/` 已删除）。
 *
 * 离线优先是本项目的底色，所以这里刻意**不实现联网下载**：
 * 复制是本机快速路径，联网那条路要处理代理 / 校验 / 离线化改写，留在上面那三个脚本里。
 *
 * ## 挂载点与入口
 *
 *   drawio     → tools/drawio            入口 index.html，另外必须包含 host.html
 *   excalidraw → tools/excalidraw        入口 index.html
 *   graphviz   → tools/graphviz          入口 graphviz.js（ESM）
 *   mermaid    → tools/mermaid           只取 mermaid.min.js
 *   d2         → tools/d2                入口 index.js（D2 的 wasm 构建）
 *
 * `drawio/host.html` 与 `excalidraw/index.html` 是**本仓库的承载页**
 * （`tools/drawio-host/host.html`、`tools/excalidraw-host/index.html`），
 * 不属于上游资产：协议要求它们落在挂载点内（`/drawio/host.html`、`/excalidraw/index.html`），
 * 所以复制时一并覆盖过去。
 *
 * ⚠️ 源工作树里的 `client/tools/{drawio-host/host.html,excalidraw-host/index.html}` 是**停更的旧副本**
 * （dev2.0 时代留下的），别再拿它们当真源去改 —— 两处覆盖就是为此存在的。
 * `tools/dev/*` 那几个探针直接挂源工作树，所以它们对这两个文件也要做同样的重定向。
 */

import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ASSETS = join(ROOT, "assets");
const MANIFEST = join(ASSETS, ".manifest.json");

const argv = process.argv.slice(2);
const VERIFY_ONLY = argv.includes("--verify");
const fromArg = argv.indexOf("--from");
/** 显式指定源工作树时，五个挂载点全从它取（行为与以前一致）。 */
const SOURCE_OVERRIDE = fromArg >= 0
  ? resolve(argv[fromArg + 1])
  : process.env.DIAGRAMON_SOURCE_TREE
    ? resolve(process.env.DIAGRAMON_SOURCE_TREE)
    : null;
/**
 * 某个挂载点的源目录。
 *
 * 源工作树**只有本仓库** `tools/<挂载点>/`（取资产脚本 2026-10-17 迁入，产物也落在那里，
 * 见 .gitignore）。旧工作树 `../client` 已删除，**不再有回退** —— 宁可报"缺件"也不要
 * 静默用上一份停更的副本（那是 B5 那类 bug 的成因）。
 * `--from` / `DIAGRAMON_SOURCE_TREE` 仍是显式覆盖（例如从别处的备份汇出）。
 *
 * 判据是**入口文件在不在**，不是"目录在不在" —— 仓库根下有个 `Assets/{drawio,excalidraw,
 * graphviz,mermaid}/` 的空壳目录（历史遗留），只看目录会让 mermaid 指到那里然后报缺件。
 */
function mountSource(sub, entry) {
  const base = SOURCE_OVERRIDE ? SOURCE_OVERRIDE : ROOT;
  return join(base, ...sub);
}

/** 挂载点 → 源目录 + 入口（入口缺失就认为这份资产没准备好）。 */
const MOUNTS = [
  {
    name: "drawio",
    from: mountSource(["tools", "drawio"], "index.html"),
    entry: "index.html",
    // 上游 webapp 的必需子目录，缺了 drawio 起不来（比"复制了多少文件"更能说明问题）
    needDirs: ["js", "styles", "mxgraph"],
    extra: [{ from: join(ROOT, "tools", "drawio-host", "host.html"), to: "host.html" }],
  },
  {
    name: "excalidraw",
    from: mountSource(["tools", "excalidraw"], "index.html"),
    entry: "index.html",
    needDirs: ["fonts"],
    // 承载页以本仓库的为准：源工作树里那份是停更的旧副本（缺 getScene ⇒ 转换取不回产物）
    extra: [{ from: join(ROOT, "tools", "excalidraw-host", "index.html"), to: "index.html" }],
  },
  {
    name: "graphviz",
    from: mountSource(["tools", "graphviz"], "graphviz.js"),
    entry: "graphviz.js",
    needDirs: [],
    extra: [],
  },
  {
    name: "mermaid",
    from: mountSource(["tools", "mermaid"], "mermaid.min.js"),
    entry: "mermaid.min.js",
    needDirs: [],
    extra: [],
  },
  {
    // Mermaid 的 ELK 布局引擎（@mermaid-js/layout-elk 打的离线 ESM 包，见 tools/fetch-mermaid-elk.ps1）。
    // 故意不进 ui/（build.frontendDist 会把它再嵌进 exe 一份）；前端按需懒加载 /mermaid-elk/。
    name: "mermaid-elk",
    from: mountSource(["tools", "mermaid-elk"], "mermaid-layout-elk.esm.js"),
    entry: "mermaid-layout-elk.esm.js",
    needDirs: [],
    extra: [],
  },
  {
    name: "d2",
    from: mountSource(["tools", "d2"], "index.js"),
    entry: "index.js",
    needDirs: [],
    extra: [],
  },
];

const TTY = process.stdout.isTTY;
const log = (s = "") => process.stdout.write(`${s}\n`);
const red = (s) => (TTY ? `\x1b[31m${s}\x1b[0m` : s);
const green = (s) => (TTY ? `\x1b[32m${s}\x1b[0m` : s);
const dim = (s) => (TTY ? `\x1b[2m${s}\x1b[0m` : s);
const mb = (n) => (n / 1024 / 1024).toFixed(1) + "MB";

/** 递归列出文件（相对 dir），跳过 .manifest.json。 */
function walk(dir, base = dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) out.push(...walk(p, base));
    else if (name !== ".manifest.json") out.push({ path: relative(base, p).split(sep).join("/"), bytes: st.size });
  }
  return out;
}

function sha256(file) {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

/** 取当前 assets/ 的清单；不存在返回 null。 */
function readManifest() {
  if (!existsSync(MANIFEST)) return null;
  try {
    return JSON.parse(readFileSync(MANIFEST, "utf8"));
  } catch {
    return null;
  }
}

function checkSource() {
  const problems = [];
  for (const m of MOUNTS) {
    if (!existsSync(join(m.from, m.entry))) {
      problems.push(`${m.name}：缺 ${join(m.from, m.entry)}`);
      continue;
    }
    for (const d of m.needDirs) {
      if (!existsSync(join(m.from, d))) problems.push(`${m.name}：缺子目录 ${d}/`);
    }
    for (const e of m.extra) {
      if (!existsSync(e.from)) problems.push(`${m.name}：缺 ${e.from}（本仓库的承载页）`);
    }
  }
  return problems;
}

function fetchAll() {
  const manifest = { generated_at: new Date().toISOString(), source: SOURCE_OVERRIDE || ROOT, mounts: {} };
  let grand = 0;

  for (const m of MOUNTS) {
    const dest = join(ASSETS, m.name);
    rmSync(dest, { recursive: true, force: true });
    mkdirSync(dest, { recursive: true });
    // 挂载点目录里只该有运行时资产：`tools/d2/` 还放着解包用的 npm tarball（31MB），
    // 那是**源**不是**产物**，复制时按扩展名剔掉，免得发布包里多塞一份。
    cpSync(m.from, dest, { recursive: true, filter: (src) => !src.endsWith(".tgz") });
    for (const e of m.extra) cpSync(e.from, join(dest, e.to));

    const files = walk(dest, dest);
    const bytes = files.reduce((n, f) => n + f.bytes, 0);
    grand += bytes;
    manifest.mounts[m.name] = { files: files.length, bytes, entry: m.entry };
    log(`  ${m.name.padEnd(11)} ${String(files.length).padStart(6)} 个文件  ${mb(bytes).padStart(8)}`);
  }

  manifest.total_bytes = grand;
  writeFileSync(MANIFEST, JSON.stringify(manifest, null, 2) + "\n", "utf8");
  log("");
  log(green(`✓ 资产就位：${relative(ROOT, ASSETS)}/ 共 ${mb(grand)}`));
  log(dim("  发布形态会由 AssetRoots 优先使用它；开发期仍走源工作树。"));
}

function verify() {
  const manifest = readManifest();
  if (!manifest) {
    log(red("assets/ 没有清单 —— 先跑一次不带 --verify 的取资产"));
    return 2;
  }
  let bad = 0;
  let grand = 0;
  for (const m of MOUNTS) {
    const dest = join(ASSETS, m.name);
    const want = manifest.mounts[m.name];
    if (!want || !existsSync(dest)) {
      log(red(`  ${m.name}：缺目录`));
      bad += 1;
      continue;
    }
    const files = walk(dest, dest);
    const bytes = files.reduce((n, f) => n + f.bytes, 0);
    grand += bytes;
    const okEntry = existsSync(join(dest, m.entry));
    const okCount = files.length === want.files;
    const okBytes = bytes === want.bytes;
    if (okEntry && okCount && okBytes) {
      log(`  ${m.name.padEnd(11)} ${String(files.length).padStart(6)} 个文件  ${mb(bytes).padStart(8)}  ${green("ok")}`);
    } else {
      bad += 1;
      log(
        red(
          `  ${m.name}：入口 ${okEntry ? "ok" : "缺失"} · 文件数 ${files.length}/${want.files} · ` +
            `体积 ${bytes}/${want.bytes}`,
        ),
      );
    }
  }
  log("");
  log(bad ? red(`✗ ${bad} 个挂载点不完整`) : green(`✓ ${MOUNTS.length} 个挂载点完整（共 ${mb(grand)}）`));
  return bad ? 1 : 0;
}

function main() {
  if (VERIFY_ONLY) {
    log(`校验 ${relative(ROOT, ASSETS)}/`);
    return verify();
  }

  log(`源工作树${SOURCE_OVERRIDE ? "（显式）" : ""}：${SOURCE_OVERRIDE || ROOT}`);
  const problems = checkSource();
  if (problems.length) {
    log(red("源工作树缺少资产："));
    for (const p of problems) log(`  - ${p}`);
    log("");
    log(dim("  这些运行时由 dev2.0 的取资产脚本下载，见本文件头部的说明。"));
    return 2;
  }

  mkdirSync(ASSETS, { recursive: true });
  log("");
  fetchAll();
  return 0;
}

process.exit(main());

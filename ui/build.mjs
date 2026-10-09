// 把 ui/src/editor-entry.js 打成 ui/vendor/editor.bundle.js（IIFE，挂 window.DGMEditor）。
//
// 产物入库（与 Assets/mermaid.min.js 同属"vendored 第三方/生成物"），
// 因此运行应用本身不需要 Node；只有改编辑器代码时才需要跑这个脚本。

import { build } from "esbuild";
import { mkdirSync } from "node:fs";

mkdirSync("vendor", { recursive: true });

const result = await build({
  entryPoints: ["src/editor-entry.js"],
  bundle: true,
  minify: true,
  format: "iife",
  target: "chrome120",
  outfile: "vendor/editor.bundle.js",
  legalComments: "none",
  logLevel: "info",
});

console.log("built ui/vendor/editor.bundle.js", result.errors.length ? result.errors : "");

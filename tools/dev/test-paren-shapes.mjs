#!/usr/bin/env node
/*
 * 回归测试：drawio 转换前「圆角里带括号」形状的改写（rebuildParenShapes）。
 *
 * 背景：drawio 内置 mermaid 导入器解析不了 `A("标签(IP)")` —— 标签里带 `(` / `)`
 * 会让它的括号匹配错位，标签被撕碎、残留串到下一个节点，整片几何全乱。
 * 处置见 ui/js/dialogs.js 的 rebuildParenShapes：仅当 `("...")` 标签内确有括号时，
 * 改写为 `(["..."])`；无括号的圆角保持原样。
 *
 * 为什么从 dialogs.js 里按函数名提取并 eval：本仓库前端没有 JS 单测框架
 * （check.mjs 只做 node --check 语法 + i18n 完整性 + 交互/画布探针），而 drawio
 * 转换走承载页引擎、Rust 侧 convert.rs 覆盖不到。这里直接取 dialogs.js 里
 * rebuildParenShapes 的**函数体**来跑，改动了实现、测试就会跟着改，避免测试与实现脱节。
 *
 * 用法：node tools/dev/test-paren-shapes.mjs   （退出码 0 = 通过；1 = 失败）
 */
import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
// 仓库根 = tools/dev/ 上溯两级（client2/）
const root = join(here, "..", "..");
const dialogsPath = join(root, "ui", "js", "dialogs.js");
const src = readFileSync(dialogsPath, "utf8");

// 提取 rebuildParenShapes 函数体（纯函数，无 DOM 依赖），按花括号配平截取
function extractFunction(name) {
  const marker = `function ${name}(`;
  const start = src.indexOf(marker);
  if (start < 0) throw new Error(`indexof ${name}: not found in ${dialogsPath}`);
  const open = src.indexOf("{", start);
  let depth = 0;
  let i = open;
  for (; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}") {
      depth--;
      if (depth === 0) break;
    }
  }
  // 在函数声明名前补 `function` 前缀，直接构造可调用表达式
  const body = src.slice(start, i + 1).replace(`function ${name}(`, `(function ${name}(`);
  return body + ")";
}

const rebuild = eval(extractFunction("rebuildParenShapes"));

let pass = 0, fail = 0;
function eq(got, want, msg) {
  if (got === want) { pass++; }
  else { fail++; console.error(`FAIL ${msg}\n  got:  ${JSON.stringify(got)}\n  want: ${JSON.stringify(want)}`); }
}
function ok(cond, msg) {
  if (cond) { pass++; } else { fail++; console.error(`FAIL ${msg}`); }
}

// ---- 用例 1：真实语料风格 —— 大量服务器节点带内网 IP（触发 bug 的形状）----
const corpus = [
  "flowchart TD",
  '    A("核心交换机<br>(172.16.0.1)") --> B("接入交换机<br>(172.16.0.2)")',
  '    C("纯圆角无括号") --> D(["防火墙"])',
  '    E("话务台<br>(VLAN 10)") --> F(("录音服务器"))',
  '    G["矩形(带括号)"] --> H[["子程序(带括号)"]]',
].join("\n");
const r1 = rebuild(corpus);
ok(r1.rebuilt === true, "corpus 含括号圆角 → rebuilt=true");
ok(r1.text.includes('A(["核心交换机<br>(172.16.0.1)"])'), "A 改写为双圆角且保留括号");
ok(r1.text.includes('B(["接入交换机<br>(172.16.0.2)"])'), "B 改写");
ok(r1.text.includes('E(["话务台<br>(VLAN 10)"])'), "E 改写");
ok(r1.text.includes('C("纯圆角无括号")'), "无括号圆角保持原样");
ok(r1.text.includes('F(("录音服务器"))'), "圆形 ((\"...\")) 不受影响");
ok(r1.text.includes('G["矩形(带括号)"]'), '矩形 [...] 不受影响');
ok(r1.text.includes('H[["子程序(带括号)"]]'), '子程序 [[...]] 不受影响');

// ---- 用例 2：无括号圆角 → 不做任何改写 ----
const r2 = rebuild('flowchart LR\n  A("one") --> B("two")');
ok(r2.rebuilt === false, "全无括号 → rebuilt=false");
eq(r2.text, 'flowchart LR\n  A("one") --> B("two")', "无括号时不改动文本");

// ---- 用例 3：标签内有转义引号，括号仍在 → 应改写且不破坏引号 ----
const r3 = rebuild('flowchart TD\n  A("他说 \\"好的\\"<br>(主)")');
ok(r3.rebuilt === true, "含转义引号 + 括号 → rebuilt=true");
ok(r3.text.includes('A(["他说 \\"好的\\"<br>(主)"])'), "转义引号被保留、括号被包进双圆角");

// ---- 用例 4：空输入 / 非 drawio 无关的写法不被误伤 ----
const r4 = rebuild("");
eq(r4.text, "", "空输入原样返回");
ok(r4.rebuilt === false, "空输入不标记改写");

// ---- 用例 5：C1 真实语料（若在 repo 里）—— service/docs 的智控平台部署图 ----
// 这份语料几乎所有服务器节点都用 `A("标签<br>(IP)")`，正是触发导入器缺陷的形态。
// 文件不在当前检出里时跳过（不把测试环境钉死）。
const real = join(root, "..", "service", "docs", "智控平台应用部署（含应急防汛部署）-前端未走负载均衡.mmd");
if (existsSync(real)) {
  const origReal = readFileSync(real, "utf8");
  const rr = rebuild(origReal);
  ok(rr.rebuilt === true, "真实语料确实含需要改写的括号圆角");
  const parenRounded = (t) => (t.match(/\(\"[^\"]*[()][^\"]*\"\)/g) || []).length;
  ok(parenRounded(rr.text) === 0, "真实语料改写后 0 个带括号圆角残留");
  const before = parenRounded(origReal);
  const stadium = (t) => (t.match(/\(\["[^\"]*[()][^\"]*"\]\)/g) || []).length;
  ok(before > 0 && stadium(rr.text) >= before, `真实语料 ${before} 个带括号圆角全部转为双圆角`);
}

// 汇总
console.log(`\nrebuildParenShapes 回归测试：${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);

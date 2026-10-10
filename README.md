# Diagramon

多格式图表编辑器（桌面客户端）· **本地优先** · **AI 是第一公民**。

支持 **Mermaid**、**Graphviz DOT**、**drawio**、**Excalidraw** 四种格式；
AI 既可用自有 Key 直连（BYOK：OpenAI 兼容 / Ollama / 自定义），也预留了云网关入口。

> 这是 **dev3.0**：按 `design/ui-proto/` 的界面原型从零重建（Rust + Tauri 2 + 系统 WebView）。
> dev2.0 的旧实现（含 C# Avalonia 参照）已从工作树移除，随时可取回：
> `git tag dev2.0-freeze-2026-10-10`，或仓库外的 `client2-dev2.0-archive-20261010.bundle`。

## 目录

```
crates/
  app-ipc/           前后端契约（唯一真源，前端不维护第二份字段清单）
  app-core/          格式注册表 · 文档与会话 · 语法校验 · 大纲 · 作用域 · 设置合并
  assets/            自定义协议 `dgm` 的路径解析（外壳与四个承载页同源的实现）
  ai/                提示词与供应商（BYOK 流式对话）
  platform/          平台适配层接口（凭据、路径）+ 非 Windows 的明文兜底
  platform-windows/  DPAPI 凭据存储（按当前用户加密）
src-tauri/           Tauri 装配与命令层（窗口、协议注册、命令、事件）
ui/                  前端外壳（无框架、无构建链、零 CDN）
  js/                外壳 · 侧栏 · 面板 · 标签 · 编辑器 · 画布承载 · 预览 · AI · 对话框 · 命令面板
  vendor/            CodeMirror 6 打包 · mermaid · wasm-graphviz（随包，无外部请求）
assets/              随包资产根（打包前由 tools/fetch-assets.mjs 汇出，不入库）
design/ui-proto/     界面原型与设计说明（index.html 是设计真源，含截图索引与实施映射）
tools/               取资产脚本 · drawio / Excalidraw 承载页 · 开发用验收脚本
```

### 为什么要走自定义协议 `dgm`

外壳与四个承载页（drawio / Excalidraw / graphviz / mermaid）**必须同源**：承载页的
「画布 ↔ 正文」往返靠直接读写 `iframe.contentWindow` 上的 `__hostQueue` / `__apply`
（见 `ui/js/canvas.js` 与 `tools/drawio-host/host.html` 的契约注释）。跨源就拿不到，
只能退回宿主轮询 + 脚本注入，那套在 WebView 包装层上不稳。

所以整个应用都从 `dgm` 协议加载：Windows 是 `http://dgm.localhost/`，
其它平台是 `dgm://localhost/`（Linux 用前者页面根本不加载 —— spike 实测）。
`/drawio/`、`/excalidraw/`、`/graphviz/`、`/mermaid/` 四个前缀是挂载点，
其余路径落到 `ui/`。

## 运行

```bash
cargo run -p diagramon            # 起客户端（Windows 需 WebView2 运行时）
node tools/dev/check.mjs          # 一条命令验收：单测 + 真机 IPC 自检
python tools/dev/canvas_probe.py  # 画布链路探针：真 drawio 载入 → 取回 → 截图
node tools/fetch-assets.mjs       # 打包前把四个挂载点的资产汇到 assets/
```

`check.mjs` 做四件事，顺序固定：**杀残留实例 → 构建 → Rust 单测 → 启动客户端跑真实 IPC 断言**
（前端把结果落成 `ui/.shots/selftest-report.json`，脚本读出来逐项打印）。
全绿退出码 0；有失败 1;基础设施问题（构建失败 / 报告没产出）2。

顺序里每一步都在防一个踩过的坑：残留实例会让链接报 `Permission denied`（看着像代码错）；
忘了删旧报告会读到上一次的结果；构建与自检抢同一个 exe。

单独跑自检也可以：

```bash
DIAGRAMON_SELFTEST=1 ./target/debug/diagramon.exe   # 报告写到数据目录
DIAGRAMON_SELFTEST_REPORT=<绝对路径>                 # 或指定位置
```

> 自检为什么由**页面自己**跑一遍、而不是外面用 CDP 断言：本机 WebView2 不认
> `--remote-debugging-port`（wry 默认传 `--disable-features=…`，宿主一旦显式传参，
> WebView2 就不再读 `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS`）。
> 页面自跑不依赖桌面输入注入，反而更稳。`tools/dev/cdp-probe.py` 留给能开调试端口的机器。
>
> 写自检时有一条硬规矩：**不要用 `setTimeout` 轮询等界面**。
> WebView2 对后台窗口把定时器节流到约 1 次/秒，`60 × 50ms` 的等待循环实际要跑一分多钟。
> 直接查 DOM、用 `fetch`（不受节流影响），或走应用自身的 API。

### 画布链路为什么要单独一个探针

`check.mjs` 的自检跑在 WebView2 里，**等不了** drawio 冷启（同上：定时器被节流），
所以它只断言「承载面挂上了、同源可读、协议供得出资产」这些同步/网络可判定的东西。

`canvas_probe.py` 补上另一半：用普通 HTTP 在本机起一份**与 `crates/assets` 相同的目录布局**，
再用 CDP 驱动本机 Chrome，让真 drawio 走一遍
「引擎起来 → 推进一版正文 → 取回 → 换一版再取回」，最后截图。

两个踩过的坑（都写在脚本头部）：`--virtual-time-budget` 遇上持续跑计时器的 SPA 会把虚拟时钟顶死
（实测挂十分钟不动）；`--screenshot` 在 load 事件就截图，那时 drawio 还是白屏。

**不开客户端也能看界面**：直接用浏览器打开 `ui/index.html`。
检测不到 Tauri 时会切到内置 **mock 后端**（示例文档、假 AI 流式、假问题列表），
标题栏会挂一个 `mock 模式` 徽标 —— 用于设计评审与截图，不会静默降级。

## 设计要点

完整说明见 `design/ui-proto/index.html`，这里只列决定架构的几条：

- **五块工作区**（活动栏 / 侧栏 / 编辑区 / AI 右栏 / 底部面板）沿用 VS Code 键位：
  `Ctrl+B` 侧栏、`Ctrl+J` 面板、`Ctrl+Shift+A` AI、`Ctrl+Shift+P` 命令面板、`Ctrl+1/2/3` 视图三态。
- **文本型与画布型分开说清**：Mermaid / DOT 支持源码 / 分屏 / 预览三态（源码窗口可整块隐藏）；
  drawio / Excalidraw 是"画布即编辑器"，UI 上不藏控件而是明说，磁盘上仍是可 diff 的文本。
- **没有面包屑**：文件路径在标题栏、层级在侧栏；唯一不重复的信息（当前行所在 subgraph/cluster）
  在状态栏的行列号旁边。
- **转换单向且理由透明**：Mermaid → drawio / Excalidraw / DOT 另开标签页、原文件不动；
  不可用方向在转换中心列出来并写明原因，不藏起来让用户猜。
- **密钥永不进前端**：BYOK 的 Key 只存在 Rust 进程内（Windows 走 DPAPI），
  前端只拿 `has_key` 与掩码（`sk-…1234`）。

## 运行时分工（Rust 原生 vs WebView）

一句话：**摸"机器状态"的归原生，摸"渲染与交互"的归 WebView**。

| 归 Rust | 归 WebView |
|---|---|
| 窗口生命周期、单实例、文件关联、更新器 | 全部界面 chrome、布局状态机、快捷键分发 |
| 文件读写（原子写）、最近文件、设置持久化 | CodeMirror 6 编辑器 |
| 语法校验、大纲、当前作用域（app-core，单一真源） | mermaid / wasm-graphviz 渲染 |
| 全工作区搜索（待接） | drawio / Excalidraw 画布承载 |
| AI 网络层（reqwest + SSE 流式）、凭据（DPAPI） | AI 流式展示、代码卡、应用/回退 |
| 剪贴板写图片、导出落盘 | 导出序列化（SVG / canvas → 字节交原生） |

边界：web→原生走 `invoke` 命令（名与载荷以 `crates/app-ipc/src/lib.rs` 为准）；
原生→web 走事件 `ai://delta` / `ai://done` / `ai://failed`。
fs 作用域限工作区目录，密钥只允许 Rust 读。

## 当前进度

**已接线（第一步：外壳 + 面板 + AI 面板）**
外壳与全部面板、标签页与会话、文件打开/保存/另存、语法校验与行内报错、大纲、
当前作用域、mermaid 与 graphviz 预览与导出、AI 三页签（对话 / 识图 / 改图）流式对话、
设置五页签与明暗主题、命令面板与对话框、内部 mock 后端。

**验收闭环（第一步）**
`node tools/dev/check.mjs` 一条命令跑完「单测 + 真机 IPC 自检」。
真机自检 26/26 全绿：契约版本与四格式注册表、设置局部更新不清空其它字段、
新建文档与语法校验（正常不报错 / 裸 `>=` 报警告）、大纲三组与中文标签、
状态栏作用域、画布型拒绝分屏、界面五块工作区与标签页跟随会话、
画布承载面挂载与同源可读、`dgm` 协议供得出四个挂载点与外壳自身。
Rust 单测 83 项（app-core 48 / ai 17 / assets 8 / platform 5 / platform-windows 5）。

**画布承载（第二步）**
drawio / Excalidraw 现在**真的能编辑**：
- `crates/assets` 恢复 + `dgm` 自定义协议，外壳与四个承载页同源（不再需要脚本注入）；
- `ui/js/canvas.js` 管「画布 ↔ 正文」：常驻 iframe（切标签不丢撤销历史）、
  队列搬运、`export` 取正文供落盘前 flush、`hotkey` 转发应用级快捷键、
  缩放/适应视图接到承载页的 `__hostZoom` / `__hostFit` / `__hostZoomBy`；
- 主题下发：Excalidraw 走它自己的 `appState.theme`；drawio 只换画布底色（用本站的 `--canvas-bg` 变量），
  **不动图形配色** —— 那是文档内容，要落盘要可 diff；
- 画布型标签页落盘前先 `flush()` 取最新正文，不让 drawio 的 1.5s autosave 去抖抢先。

验证：`check.mjs` 26/26；`canvas_probe.py` 9/9（真 drawio 引擎起来、推进去取回来、换一版再取回，
截图见 `ui/.shots/canvas-drawio.png`）。

**下一步**
完整拆分见 [`docs/roadmap-dev3.0.md`](docs/roadmap-dev3.0.md)（含依赖关系、每步的完成判据、待拍板项）。
摘要：① 闭环验收与开发环路 ✅ → ② drawio / Excalidraw 画布承载 + `dgm` 资产协议 ✅（关键路径）
→ ③ 格式转换执行 → ④ 工作区扫描 / 搜索 / watcher → ⑤ AI 补齐（区域截图、原生剪贴板）
→ ⑥ 云网关 → ⑦ 发布（更新器 / 三平台打包）→ ⑧ 硬化（真 AST / 画布大纲 / 性能 / i18n）。

## 许可

Apache-2.0，见 `LICENSE`；第三方组件与许可见 `NOTICE`。

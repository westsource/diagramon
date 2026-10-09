# Diagramon dev2.0 —— Rust + Tauri 2 跨平台实现

> 分支 `dev2.0`。以《Diagramon 客户端跨平台技术栈评估与迁移方案》v1.2 §7（目标架构）与
> §8（迁移路径）为依据，用 **Rust + Tauri 2 + 系统 WebView** 重写客户端，目标平台
> **Windows / macOS / Linux**（Windows 用 WebView2，macOS 用 WKWebView，Linux 用 WebKitGTK 4.1）。

同目录下的 Avalonia/C# 实现（`Diagramon.csproj` 等）在迁移完成前**保留为行为参照**，两者互不影响。

## 1. 阶段与当前进度

| 阶段 | 目标 | 状态 |
|---|---|---|
| 0 判定门 | 三平台最小可复现包跑通（`tauri-spike-kit/`） | ✅ Windows / Linux 已实测通过；macOS 待真机 |
| **1 骨架与适配层** | 三平台能起一个空壳窗口；凭据读写、文件对话框 | **进行中**：工作区骨架 + Windows 适配层已落地 |
| 2 承载与渲染 | 四类图渲染与导出（drawio / excalidraw 宿主页、graphviz / mermaid 页内渲染、去 mmdc） | ✅ **Windows 已完成**（四类图均可渲染与页内导出；drawio / Excalidraw 内嵌画布、DOT 六布局、编辑器高亮/查找、Mermaid→图形转换、语法校验行号） |
| 3 业务功能 | 文档模型、标签页、文件 IO、AI 面板、设置 | 部分（文档/标签页/文件 IO 已完成） |
| 4 平台化 | 三套打包、签名、更新器、文件关联 | 待做 |
| 5 验证与发布 | 三引擎回归、性能与体积、灰度 | 待做 |

## 2. 工程结构（对齐方案 §7.5）

```
Cargo.toml                 # 工作区
crates/
  app-ipc/                 # 前后端契约：命令与事件载荷（三平台与前端共享）
  app-core/                # 文档模型、格式注册表、会话状态（无平台依赖）
  assets/                  # 自定义协议 `dgm` 的路径 → 资产文件解析
  platform/                # 适配层 trait（CredentialStore / AppPaths / Platform）+ 标准路径
  platform-windows/        # Windows 实现：DPAPI 凭据等
  (platform-macos/…)       # 待补（阶段 1）
src-tauri/                 # Tauri 主进程装配（三平台同一入口）
ui/                        # 前端外壳（标签页 / 编辑器 / 预览）
```

两个关键约定：

* **契约单一真源**：命令的入参/返回值类型定义在 `app-ipc`，前端 `invoke()` 直接对应，避免两侧各写一份。
* **格式注册表单一真源**：新建正文、扩展名、承载方式、能力位集中在 `app-core::format`，前端经 `formats` 命令取，不维护第二份清单。

## 3. 承载与 origin

外壳页与所有渲染资产（drawio / excalidraw / graphviz / mermaid）由**同一个自定义协议 origin** 提供，
因此离线守卫只需管一个 origin。origin 的写法按平台分叉（阶段 0 实测）：

| 平台 | 页面 URL |
|---|---|
| Windows | `http://dgm.localhost/`（外部 URL，映射到协议处理器） |
| macOS / Linux | `dgm://localhost/` |

协议挂载点：`/drawio/`、`/excalidraw/`、`/graphviz/`、`/mermaid/`；其余路径落到 `ui/`。

## 4. 构建与运行

```bash
cargo build            # 工作区（Windows）
cargo run -p diagramon # 启动应用
cargo test -p platform-windows   # DPAPI 凭据存储往返测试
```

资产目录探测顺序（开发期无需把大体积资产复制进本分支）：

* 环境变量 `DIAGRAMON_ASSETS_DIR` → 随包资产根（其下含 `drawio/`、`excalidraw/`、`graphviz/`、`mermaid/` 子目录）；
* 否则从 `ui/` 向上查找名为 `client` 的旧仓库工作树（`tools/{drawio,excalidraw,graphviz}` + `Assets/mermaid.min.js`），
  也接受 `DIAGRAMON_CLIENT_DIR` 显式指定。

运行时在 stdout 打印 `dgm|roots|…`、`dgm|url|…`、`dgm|404|…` 便于诊断。

## 4.1 自动化验收（tools/e2e）

`tools/e2e/` 是一个零依赖的 Node 跑分器：以
`WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=<port>` 启动应用，
用 CDP 连到窗口里的真实 WebView2 页面执行断言与交互（真实键入、真实点击），
不依赖桌面输入注入，也不需要人工点击。

```bash
node tools/e2e/all.mjs                 # 跑完全部场景并汇总
node tools/e2e/run.mjs tools/e2e/scenarios/stage1a.mjs   # 单个场景
```

判定三态：`PASS` / `FAIL` / `SKIP`（环境导致的无法判定项，如系统剪贴板被他人独占）。
退出码在存在 `FAIL` 时为 1。

当前场景与覆盖：`stage1a` DOT 布局选择器 + 页内 PNG 导出；`stage1b` CodeMirror 高亮/行号/查找 + 真实键入；
`stage1c` drawio 内嵌画布 + flush + 导出 + Mermaid→drawio；`stage1d` Excalidraw 画布 + 回写 + 导出 + 转换；
`stage1e` 语法校验与报错行号。

## 5. 已完成 / 未完成（截至本分支首次提交）

已完成：

* 工作区与 crate 划分；格式注册表（四种格式的默认正文与既有客户端逐字符一致）；
* 文档模型与会话（脏标记按内容比对、同路径去重激活、关闭后活动页落点）；
* 自定义协议资产服务（`..` 防穿越、MIME 推断、按平台 origin）；
* 平台适配层 trait + Windows DPAPI 凭据存储（含落盘密文断言测试）；
* Tauri 命令层：开/存/另存/新建/关/激活标签页、读写正文、保存图片、凭据读写、退出；
* 编辑器：CodeMirror 6（行号、Mermaid/DOT 自带行式高亮、JSON/XML 官方语言、查找替换）；
* 预览：Mermaid / Graphviz 页内渲染、DOT 六布局、平移缩放适配、语法校验与报错行号；
* 导出：Mermaid/DOT 预览栅格化 + 画布内栅格化，保存到文件与复制到剪贴板（自适应倍率）；
* 内嵌画布：drawio 与 Excalidraw（同源 iframe 桥、autosave 回写、保存前 flush、
  页内导出、画布内应用级快捷键回传）；
* Mermaid → drawio / Excalidraw 单向转换；
* 配置地基：菜单栏（文件/设置/帮助）、设置持久化（`settings.json`：语言/编辑器比例/最近文件/
  跳过版本等）、最近文件（记录/去重/失效剔除/菜单+历史对话框含搜索）、本地化（en-US/zh-CN +
  首次按系统语言探测 + 即时切换）、关于/操作说明对话框、崩溃日志（`crash.log`）、命令行参数打开；
* 自动化验收跑分器 `tools/e2e/`（CDP 驱动真实页面，`node tools/e2e/all.mjs` 一键跑完）。

未完成（后续阶段）：

> 完整的功能差距清单（逐项与 main 分支对照，含 main 侧证据文件:行）见
> [`dev2.0-gap-analysis.md`](./dev2.0-gap-analysis.md)。

* macOS / Linux 平台适配层（当前在非 Windows 目标上会以 `compile_error!` 明确阻断，不静默降级）；
* 阶段 3 业务功能：AI 助手、设置持久化、最近文件、本地化、各对话框、云端、更新器（阶段 4）。

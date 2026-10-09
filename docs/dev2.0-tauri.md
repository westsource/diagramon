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
| 2 承载与渲染 | 四类图渲染与导出（drawio / excalidraw 宿主页、graphviz / mermaid 页内渲染、去 mmdc） | 待做 |
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

## 5. 已完成 / 未完成（截至本分支首次提交）

已完成：

* 工作区与 crate 划分；格式注册表（四种格式的默认正文与既有客户端逐字符一致）；
* 文档模型与会话（脏标记按内容比对、同路径去重激活、关闭后活动页落点）；
* 自定义协议资产服务（`..` 防穿越、MIME 推断、按平台 origin）；
* 平台适配层 trait + Windows DPAPI 凭据存储（含落盘密文断言测试）；
* Tauri 命令层：开/存/另存/新建/关/激活标签页、读写正文、凭据读写、退出；
* 前端外壳：标签页、编辑器、Mermaid/DOT 实时预览（350ms 防抖）、预览平移/缩放/适配、文件操作与快捷键。

未完成（后续阶段）：

> 完整的功能差距清单（逐项与 main 分支对照，含 main 侧证据文件:行）见
> [`dev2.0-gap-analysis.md`](./dev2.0-gap-analysis.md)。

* macOS / Linux 平台适配层（当前在非 Windows 目标上会以 `compile_error!` 明确阻断，不静默降级）；
* drawio / Excalidraw 内嵌画布宿主页（阶段 2）；DOT 六布局选择器；页内 PNG 导出（去 mmdc）；
* AI 助手、设置、云端、更新器（阶段 3–4）；三平台打包与签名（阶段 4）。

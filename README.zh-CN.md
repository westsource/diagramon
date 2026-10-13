# Diagramon - 多格式图表编辑器

[English](README.md)

**本地优先**的多格式图表编辑器。支持 **Mermaid**（`.mmd` / `.mermaid`）、**Graphviz DOT**（`.dot` / `.gv`）、
**drawio**（`.drawio`）与 **Excalidraw**（`.excalidraw`）四种格式，都能编辑并实时预览。
AI 是第一公民：既可用自有 Key 直连（BYOK），也可走会员云网关，含**识图**（图片 → 图表代码）。

**渲染、语法校验、格式转换全部在本机完成**：Mermaid 与 Graphviz 走内置引擎（WASM / 打包 JS），
drawio 与 Excalidraw 走随包自带的运行时，**不起任何子进程、不发任何外部请求**。
只有你主动使用 AI 时，相关代码或图片才会发往你选择的上游（BYOK 直连你的服务商，会员走 Diagramon 云网关）。

版本 **3.0.0** · 官网 <https://www.diagramon.com>

## 界面截图

![主界面](screenshots/01-main-light.png)

![AI 识图](screenshots/02-ai-vision.png)

![drawio 画布](screenshots/03-drawio-canvas.png)

![Excalidraw 画布](screenshots/04-excalidraw-canvas.png)

![深色主题](screenshots/05-dark-preview.png)

![云端文档](screenshots/06-cloud-docs.png)

![账户与 AI 额度](screenshots/07-cloud-account.png)

## 功能特性

### 编辑
- **多标签页**：一个窗口里并排编辑多种格式；标签过多时滚入视野 + 滚轮横滚 + 两端渐隐，
  `Ctrl+Tab` / `Ctrl+PgUp` / `Ctrl+PgDn` 循环切换
- **语法校验与行内报错**：括号/引号/标签配对、JSON 解析失败等**能确证**的问题才报，不做风格猜测；
  问题面板汇总所有已打开文档，逐行标出文档名、行列号
- **大纲与当前作用域**：从正文解出节点与 `subgraph` / `cluster` 树；状态栏在行列号旁显示
  光标所在的 subgraph/cluster（不重复出现在别处）
- **查找替换**、撤销重做、右键菜单、命令面板（`Ctrl+Shift+P` 或 `F1`）
- **大文档护栏**：行数/字节超阈值时预览先问一句「仍要渲染」，不默默把引擎拖死（阈值只存一份，由 Rust 下发）

### 预览与导出
- **文本型三态**：源码 / 分屏 / 预览（`Ctrl+1/2/3`），源码窗口可整块隐藏
- **统一手势**：滚轮平移、`Shift+滚轮` 横向平移、`Ctrl+滚轮` 以光标为锚缩放、拖拽平移、
  双击适应视图；`Ctrl+0` / `Ctrl+=` / `Ctrl+-` 由外壳转发给当前视图（预览与两个画布共用一套语义）
- **状态栏缩放读数**：只显示**当前**视图的缩放值（画布自己的读数被隐藏，避免两个数字打架）
- **DOT 布局引擎切换**：`dot` / `neato` / `fdp` / `sfdp` / `twopi` / `circo`，切换走增量重排，
  不重载 WASM
- **导出**：导出图片（PNG，倍率可选）与复制到剪贴板；DOT 走 `SVG → canvas → PNG`，零子进程

### 画布编辑（drawio / Excalidraw）
- **画布即编辑器**：不藏控件，而是明说 —— 两个格式都不提供源码/分屏三态
- **磁盘上仍是文本**：`.drawio` 就是 mxfile XML、`.excalidraw` 就是场景 JSON；画布只是它的一个视图，
  所以落盘内容可 diff、可版本管理，并复用同一套保存/另存/最近文件
- **自动回写**：画布改动（含 drawio 自己的 autosave）回写进标签页正文并打脏标；
  保存前先向画布取一次最新正文，不输给 autosave 的去抖窗口
- **撤销历史不丢**：承载页常驻（切标签不销毁）
- **离线自带**：drawio（裁剪过的运行时）与 Excalidraw（本地打包）都随安装包分发，零外部请求

### 格式转换（转换中心）
- **方向**：`Mermaid → DOT`（纯 Rust 实现）、`Mermaid → drawio`、`Mermaid → Excalidraw`
  （交给各自的引擎，不重新实现解析器）
- **单向语义**：产物另开标签页，原文件字节不变
- **有损就说清楚**：结果带 `notes`，逐条列出「哪类信息没迁移」（如 `subgraph → cluster` 丢样式），
  对话框直接显示，不静默丢
- **不可用方向照样列出来并写明原因**，不藏起来让人猜

### 工作区与文件
- **打开文件夹**：资源管理器树（只收本应用认的扩展名，跳过 `.git` / `node_modules` / `target`）
- **全工作区搜索**（`Ctrl+Shift+H`）：Rust 侧流式回结果，带行列号，可跳转；可取消
- **文件监视**：外部改动自动跟上；与本地未保存内容冲突时给一条横幅让你选「用磁盘版本 / 保留我的」
  （需要决策的状态不做成会自己消失的提示）
- **单实例 + 文件关联**：双击图表文件由已有窗口打开，不新起进程
- **自动保存与崩溃恢复**：autosave 归 Rust（后台线程，不依赖前端定时器）；
  未落盘内容有草稿仓，坏一份不连累其它
- **路径守卫**：工作区内的新建/重命名/删除永远经根目录校验，`..` 与绝对路径一律拒绝；
  「另存为 / 导出」走系统对话框（那是用户本人的授权），想收紧可开「只允许在工作区内读写文件」

### AI 助手
- **三个页签**：对话生成（自然语言 → 当前格式的图表代码）、识图（图片 → 代码）、改图（针对当前文档提要求）
- **两种凭据来源，界面上分开**：云网关（会员，凭据是当前登录令牌，用户什么都不用填）
  与本地 BYOK（OpenAI 兼容 / Ollama / 自定义，用户自己填 Key）——分组显示，不混排
- **识图两种入口**：选图片文件，或**框选屏幕一块区域**（冻结帧 + 无边框 overlay，
  多屏与 DPI 缩放都不用碰）；图片只在内存里压到 ≤1568px，不落盘
- **用量如实标注来源**：只累计供应商实报的 token，没回报的显示 `—` 并说明，绝不显示 0，
  也不掺本地估算
- **渲染报错自动修一次**：生成的代码在本机渲染失败时，把错误文本回传给模型修一次（可在设置里关掉）
- **可取消**、失败如实报错，绝不假装成功
- **密钥永不进前端**：Key 只存在 Rust 进程内（Windows 走 DPAPI，按当前用户加密），
  前端只拿 `has_key` 与掩码

### 云端（Diagramon Cloud）
- **登录令牌只进凭据库**：access / refresh 存 Windows DPAPI，前端只拿账户快照与文档列表；
  「已登录」是事实陈述，不是页面可伪造的状态
- **令牌静默续期**：access 过期自动用 refresh 换新（带轮换与重用检测口径），
  登录态在 refresh 有效期内自续，重启不再要求重新登录
- **账户视图**（只读）：邮箱、昵称、套餐、角色、存储用量，以及**AI 权益与信用点额度**
  （单位是「信用点」，不是人民币）
- **云端文档**：目录树（空目录也在）、筛选、打开；**保存到云端**对话框可挑目录、可新建子目录
- **登录是一站不是终点**：从「保存到云端」进去登录，登录完接着开保存窗口
- **注册不在客户端做**：页脚只给「去官网注册」，按配置的服务地址打开系统浏览器
- **base_url 留空 = 云端整体关闭**，一切照旧离线工作（离线优先是产品底色）
- 客户端不做假数据：未配置就写「去配置」，未登录就写「未登录」，绝不伪造余额

### 设置、主题与更新
- **明暗双主题** + 多套强调色，切换只改根上的一个属性；全部颜色只经 CSS 变量取值
- **面板状态记住**：侧栏/AI/底部面板的开合与宽度、源码窗格比例、最近文件——重启即还原
- **中英双语**：`zh-CN` / `en-US`，词条两侧键集完全一致（缺一条就拦住整场验收）
- **内置自动更新**：minisign 签名校验；已最新 / 有新版（下载 → 自动重启）/ 出错三种结果如实呈现，
  绝不把「检查失败」说成「已是最新」

## 技术栈

- **语言 / 框架**：Rust（2021 版次）+ Tauri 2，前端无框架、**无构建链**、零 CDN
- **WebView**：系统 WebView（Windows 上为 WebView2）
- **编辑器**：CodeMirror 6（打包进 `ui/vendor/`，暴露给外壳，不落 npm 依赖）
- **渲染引擎**：Mermaid（打包 JS）· Graphviz（WASM）· drawio（随包裁剪运行时）· Excalidraw（本地打包）
- **AI 网络层**：Rust（reqwest + SSE 流式），凭据走 DPAPI
- **打包**：NSIS 安装包；画布运行时与前端 `ui/` 都作为资源打进包（约 60 MB）

### 为什么有个自定义协议 `dgm`

外壳与四个承载页（drawio / Excalidraw / graphviz / mermaid）**必须同源**：承载页的
「画布 ↔ 正文」往返靠直接读写 `iframe.contentWindow` 上的 `__hostQueue` / `__apply`
（契约真源见 `tools/drawio-host/host.html` 的注释块）。跨源就拿不到，只能退回
「宿主轮询 + 脚本注入」——那套在 WebView 包装层上不稳。

所以整个应用都从 `dgm` 加载：Windows 是 `http://dgm.localhost/`，其它平台是 `dgm://localhost/`。
`/drawio/`、`/excalidraw/`、`/graphviz/`、`/mermaid/` 是挂载点，其余路径落到 `ui/`。

### 运行时分工（一句话）

**摸「机器状态」的归 Rust，摸「渲染与交互」的归 WebView。**

| 归 Rust | 归 WebView |
|---|---|
| 窗口 / 单实例 / 文件关联 / 更新器 | 全部界面 chrome、布局状态机、快捷键分发 |
| 文件读写（原子写）、最近文件、设置持久化 | CodeMirror 6 编辑器 |
| 语法校验 / 大纲 / 作用域 / 格式转换（app-core，单一真源） | mermaid 与 wasm-graphviz 渲染 |
| 全工作区搜索、文件监视、autosave 计时 | drawio / Excalidraw 画布承载 |
| AI 网络层（流式）、凭据（DPAPI）、云网关 | AI 流式展示、代码卡、应用 / 回退 |
| 区域截屏（冻结帧）、剪贴板写 PNG、导出落盘 | 导出序列化（SVG / canvas → 字节交原生） |

## 环境要求

### 运行打包版
- Windows 10 / 11 64 位（需要 WebView2 运行时；Win10/11 通常已预装）
- VC++ 运行库**不需要**：release 已静态链接 CRT
- 画布运行时（约 98 MB）与前端 `ui/` 都在安装包里，不需要额外下载

### 开发
- Rust 工具链（本机为 `stable-x86_64-pc-windows-gnu`）
- 画布资产不入库，开发期由 `crates/assets` 自动向上找源工作树；打包前必须先汇出（见下）

## 开发与验收

```bash
cargo run -p diagramon             # 起客户端
node tools/dev/check.mjs           # 一条命令验收（全量）
node tools/dev/check.mjs --test-only   # 只跑 Rust 单测
node tools/dev/check.mjs --skip-test   # 只跑真机自检（构建仍会跑）
python tools/dev/canvas_probe.py   # 画布链路探针：真 drawio 载入 → 取回 → 截图
python tools/dev/ui_probe.py       # 界面探针：浏览器原型里跑真实交互断言
python tools/dev/readme_shots.py   # 重新生成 screenshots/ 里的界面截图
node tools/fetch-assets.mjs        # 打包前把四个挂载点的资产汇到 assets/
```

`check.mjs` 的顺序是固定的：**杀残留实例 → 构建 → Rust 单测 → 启动客户端跑真实 IPC 断言**
（前端把结果落成 `ui/.shots/selftest-report.json`，脚本读出来逐项打印）。
全绿退出码 0，有失败 1，基础设施问题（构建失败 / 报告没产出）2，整场输出留在 `ui/.shots/check.log`。

单独跑真机自检：

```bash
DIAGRAMON_SELFTEST=1 ./target/debug/diagramon.exe
DIAGRAMON_SELFTEST_REPORT=<绝对路径>    # 或指定报告位置
```

> **两条硬规矩**（都由踩坑换来）：自检**不要用 `setTimeout` 轮询等界面** —— WebView2 对后台窗口
> 把定时器节流到约 1 次/秒；**`async` 命令一律返回有意义的值** —— `async + Result<(), String>`
> 的响应会被静默丢弃，前端 `await` 永不结算。

**浏览器里也能看界面**：直接用浏览器打开 `ui/index.html`，检测不到 Tauri 时会切到内置
**mock 后端**（示例文档、假 AI 流式、假问题列表），标题栏挂一个 `mock 模式` 徽标 ——
供设计评审与截图用，不会静默降级。

**打包**（PowerShell，在仓库根目录）：

```powershell
node tools/fetch-assets.mjs --verify
$env:TAURI_SIGNING_PRIVATE_KEY = "<私钥路径>"
$env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD = "<口令>"
npx tauri build --bundles nsis
```

产物三件套在 `target/release/bundle/nsis/`：安装包 + `.sig`（更新签名）+ `latest.json`（更新清单）。
完整步骤与仍欠的手续见 [`docs/发布检查单.md`](docs/发布检查单.md)。

## 目录结构

```
crates/
  app-ipc/           前后端契约（唯一真源，前端不维护第二份字段清单）
  app-core/          格式注册表 · 文档与会话 · 语法校验 · 大纲 · 作用域 · 格式转换 · 工作区 · 设置
  assets/            自定义协议 dgm 的路径解析（外壳与四个承载页同源的实现）
  ai/                提示词与供应商（BYOK 流式对话）
  platform/          平台适配层接口（凭据、路径）+ 非 Windows 的明文兜底
  platform-windows/  DPAPI 凭据存储（按当前用户加密）
src-tauri/           Tauri 装配与命令层（窗口、协议注册、命令、事件、监视、截屏）
ui/                  前端外壳（无框架、无构建链、零 CDN）
  js/                外壳 · 侧栏 · 面板 · 标签 · 编辑器 · 画布承载 · 预览 · AI · 云端 · 对话框
  vendor/            CodeMirror 6 打包 · mermaid · wasm-graphviz（随包，无外部请求）
assets/              随包资产根（打包前由 tools/fetch-assets.mjs 汇出，不入库）
design/ui-proto/     界面原型与设计说明（index.html 是设计真源，含截图索引与实施映射）
docs/                路线图与发布检查单
tools/               取资产脚本 · drawio / Excalidraw 承载页 · 开发用验收脚本
```

## 键盘快捷键

| 快捷键 | 作用 |
|--------|------|
| `Ctrl+N` | 新建（带格式则直达创建，不带则弹格式对话框） |
| `Ctrl+O` / `Ctrl+S` / `Ctrl+Shift+S` | 打开 / 保存 / 另存为 |
| `Ctrl+R` | 最近文件 |
| `Ctrl+W` / `Ctrl+Q` | 关闭当前标签页 / 退出 |
| `Ctrl+F` | 查找替换 |
| `Ctrl+Shift+H` | 全工作区搜索 |
| `Ctrl+Shift+P` / `F1` | 命令面板 |
| `Ctrl+I` / `Ctrl+Shift+I` | AI 对话 / AI 识图 |
| `Ctrl+Shift+C` | 复制当前视图为图片 |
| `Ctrl+B` / `Ctrl+J` / `Ctrl+Shift+A` | 侧栏 / 底部面板 / AI 面板 |
| `Ctrl+Shift+F` | 禅模式（全屏编辑） |
| `Ctrl+1` / `Ctrl+2` / `Ctrl+3` | 源码 / 分屏 / 预览 |
| `Ctrl+0` / `Ctrl+=` / `Ctrl+-` | 适应视图 / 放大 / 缩小 |
| `Ctrl+T` | 切换明暗主题 |
| `Ctrl+Tab` / `Ctrl+PgUp` / `Ctrl+PgDn` | 循环切换标签页 |
| `Alt+1` … `Alt+5` | 侧栏视图：资源浏览器 / 搜索 / 转换 / 云端文档 / 大纲 |

编辑器内：`Ctrl+Z` 撤销、`Ctrl+Y` 重做、`Ctrl+X/C/V/A` 剪切/复制/粘贴/全选。
预览或画布获得焦点时，上面这些应用级快捷键由承载页拦下并交回外壳，不会失效。

## 关于 3.0

3.0 是按 `design/ui-proto/` 的界面原型**从零重建**的实现：Rust + Tauri 2 + 系统 WebView，
前端无框架、无构建链。开发过程、每一步的完成判据与依赖关系见
[`docs/roadmap-dev3.0.md`](docs/roadmap-dev3.0.md)。

## 许可

Apache-2.0，见 [`LICENSE`](LICENSE)；第三方组件与许可见 [`NOTICE`](NOTICE)。

## 致谢

本项目使用了以下开源项目：

- [Tauri](https://tauri.app/) - 桌面应用框架（Rust + 系统 WebView）
- [CodeMirror](https://codemirror.net/) - 代码编辑器
- [Mermaid](https://mermaid.js.org/) - Mermaid 图表渲染引擎
- [Graphviz](https://graphviz.org/) / [@hpcc-js/wasm-graphviz](https://github.com/hpcc-systems/wasm-graphviz) - DOT 渲染（WASM）
- [drawio](https://github.com/jgraph/drawio) - `.drawio` 画布（随包裁剪运行时，Apache-2.0）
- [Excalidraw](https://github.com/excalidraw/excalidraw) - `.excalidraw` 手绘风格画布（MIT）
- [OpenAI 兼容 API](https://platform.openai.com/docs/api-reference) - BYOK 与云网关的对话协议
- [Ollama](https://ollama.com/) - 本地大模型

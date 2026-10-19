# Diagramon - 多格式图表编辑器

[English](README.md)

**本地优先**的多格式图表编辑器。支持 **Mermaid**（`.mmd` / `.mermaid`）、**Graphviz DOT**（`.dot` / `.gv`）、
**D2**（`.d2`）、**drawio**（`.drawio`）与 **Excalidraw**（`.excalidraw`）五种格式，都能编辑并实时预览。
AI 是第一公民：既可用自有 Key 直连（BYOK），也可走会员云网关，含**识图**（图片 → 图表代码）。

**渲染、语法校验、格式转换全部在本机完成**：Mermaid 与 Graphviz 走内置引擎（WASM / 打包 JS），
D2 走随包的官方 wasm 构建，drawio 与 Excalidraw 走随包自带的运行时，**不起任何子进程、不发任何外部请求**。
只有你主动使用 AI 时，相关代码或图片才会发往你选择的上游（BYOK 直连你的服务商，会员走 Diagramon 云网关）。

版本 **3.8.2** · 官网 <https://www.diagramon.com>

## 界面截图

![主界面](screenshots/01-main-light.png)

![AI 识图](screenshots/02-ai-vision.png)

![drawio 画布](screenshots/03-drawio-canvas.png)

![Excalidraw 画布](screenshots/04-excalidraw-canvas.png)

![深色主题](screenshots/05-dark-preview.png)

![云端文档](screenshots/06-cloud-docs.png)

![账户与 AI 额度](screenshots/07-cloud-account.png)

![D2 预览](screenshots/08-d2-preview.png)

## 功能特性

### 编辑
- **多标签页**：一个窗口里并排编辑多种格式；标签过多时滚入视野 + 滚轮横滚 + 两端渐隐，
  `Ctrl+Tab` / `Ctrl+PgUp` / `Ctrl+PgDn` 循环切换
- **语法校验与行内报错**：括号/引号/标签配对、JSON 解析失败等**能确证**的问题才报，不做风格猜测；
  问题面板汇总所有已打开文档，逐行标出文档名、行列号
- **Mermaid 引擎 10.9.5 → 12.2.0**：跟上上游这些年新增的图表类型与语法，渲染结果与 mermaid.live 对齐
- **报错精确到行列**：问题面板给出「行 N 列 M」，面板上的按钮切到源码视图并把光标钉到出错处；
  出错行在源码窗口里画红线（改对即消失），同一份定位（含列号）也喂给 AI 修正回环
- **大纲与当前作用域**：从正文解出节点与 `subgraph` / `cluster` / D2 容器树；状态栏在行列号旁显示
  光标所在的 subgraph/cluster/容器（不重复出现在别处）
- **查找替换**、撤销重做、右键菜单、命令面板（`Ctrl+Shift+P` 或 `F1`）
- **Tab 与主流编辑器一致**：空选区按 Tab 在**光标处**补空格到下一个制表位（行首仍是整档 4 空格），
  有选区时整块缩进、`Shift+Tab` 反缩进；一次按键仍是一个撤销步骤
- **大文档护栏**：行数/字节超阈值时预览先问一句「仍要渲染」，不默默把引擎拖死（阈值只存一份，由 Rust 下发）

### 预览与导出
- **文本型三态**：源码 / 分屏 / 预览（`Ctrl+1/2/3`），源码窗口可整块隐藏
- **统一手势**：滚轮平移、`Shift+滚轮` 横向平移、`Ctrl+滚轮` 以光标为锚缩放、拖拽平移、
  双击适应视图；`Ctrl+0` / `Ctrl+=` / `Ctrl+-` 由外壳转发给当前视图（预览与两个画布共用一套语义）
- **「适应视图」适配的是内容，不是页面**：按图自身的包围盒两维适配并居中（有意忽略 drawio 的页面框，
  所以落在页面之外的单元格不再被切掉），放大范围与其它视图一致，落在 0.2×–30×
- **状态栏缩放读数**：只显示**当前**视图的缩放值（画布自己的读数被隐藏，避免两个数字打架）
- **布局引擎切换**：DOT 有 `dot` / `neato` / `fdp` / `sfdp` / `twopi` / `circo`（切换走增量重排，
  不重载 WASM）；D2 有 `dagre` / `elk` / `tala`（切换重新编译，引擎实例复用；`tala` 慢，按需用）；
  Mermaid 有 `dagre` 与 ELK，ELK 以离线包随程序分发（`@mermaid-js/layout-elk`），不联网，
  加载失败自动回退 dagre、不断流。那份包是**一次性且常驻**的成本（实测 JS 堆 +7.7MB、
  进程工作集 +16MB、加载约 0.5 秒），所以**只有以前用过 elk** 才会在启动后台预热；
  没用到的人首次切换时才加载 —— 不为不用的人白背常驻内存
- **渲染选项就在预览顶栏**：Mermaid 显示两颗（外观 + 布局），DOT / D2 显示一颗（布局），画布型自动隐藏；
  选择**按文件记住**（关掉标签页、重启应用后再打开这个文件，仍是上次选的那一套）、点完立即重渲染
  （状态栏原有的布局入口保留，与顶栏同一数据源）
- **Mermaid 外观模式**：classic / neo / handDrawn 随时切换，观感与 mermaid.live 对齐
- **D2 引擎按需预热**：D2 的运行时是 11MB 的**离线** wasm，首次打开 `.d2` 会等几秒（界面明说
  「正在初始化 D2 引擎」），之后每次渲染几十毫秒；只有你**最近开过 `.d2`** 时才会在启动后台预热
  —— 不用 D2 就不会为它多背常驻内存
- **导出**：导出图片（PNG，倍率可选）与复制到剪贴板；文本型走 `SVG → canvas → PNG`，零子进程。
  位图**带着与预览一致的底色**（不透明，粘贴到白底文档或聊天框里不会"看着像一片空白"）；
  图大到越过 Chromium 画布上限（面积 2^28 像素）时会自动压倍率并在状态栏说明 —— 而不是
  悄悄给你一张空图
- **渲染产物先消毒再挂载**：引擎吐出的 SVG 先在惰性容器里剥掉脚本、内嵌对象与事件属性
  （在各引擎自身的转义纪律之外再加一道），主界面文档另带一份不放行内联脚本的 CSP

### 画布编辑（drawio / Excalidraw）
- **画布即编辑器**：不藏控件，而是明说 —— 两个格式都不提供源码/分屏三态
- **磁盘上仍是文本**：`.drawio` 就是 mxfile XML、`.excalidraw` 就是场景 JSON；画布只是它的一个视图，
  所以落盘内容可 diff、可版本管理，并复用同一套保存/另存/最近文件
- **自动回写**：画布改动（含 drawio 自己的 autosave）回写进标签页正文并打脏标；
  保存前先向画布取一次最新正文，不输给 autosave 的去抖窗口
- **撤销历史不丢**：承载页常驻（切标签不销毁）
- **离线自带**：drawio（裁剪过的运行时）与 Excalidraw（本地打包）都随安装包分发，零外部请求

### 格式转换（转换中心）
- **方向**：`Mermaid → DOT` / `Mermaid → D2` / `DOT → D2`（纯 Rust 实现）、`Mermaid → drawio`、
  `Mermaid → Excalidraw`（交给各自的引擎，不重新实现解析器）、`D2 → drawio`（在前端用 D2 自己的
  wasm 先算出几何，再映射成 mxGraph —— **保几何**，转出来还能继续拖拽编辑）
- **明确不做的方向也说明理由**：D2 是 Mermaid / DOT 的超集（容器、classes、vars、layers…），
  反向压缩要逐项决定丢什么，所以不做；「从 D2 出去」由 `D2 → drawio` 承接
- **单向语义**：产物另开标签页，原文件字节不变
- **有损就说清楚**：结果带 `notes`，逐条列出「哪类信息没迁移」（如 `subgraph → cluster` 丢样式），
  对话框直接显示，不静默丢
- **不可用方向照样列出来并写明原因**，不藏起来让人猜
- **以前会转坏的那几处 Mermaid 细节**：边的端点标记照转（`<-->` → DOT 的 `dir=both` / D2 的 `<->`）；
  目标格式里没有对应形状的标记（`o--o` / `x--x`）退化成普通边并写进 `notes`；与 DOT 关键字同名的
  节点（`EDGE`、`node`）加引号，graphviz 不再 syntax error；D2 的 `stroke-width` 取整并截断到
  0–15，改动过的原值进 `notes`
- **`Mermaid → Excalidraw` 沿用文档外观**：源码文档在顶栏选了 classic / neo / handDrawn，转换出的
  Excalidraw 按同一 look 渲染；转换记录里如实注明沿用了什么、布局按引擎默认重排

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
- **外部文件也能当上下文**：点 AI 输入框上方那排里的**文件夹按钮**选文件（可多选），
  或把文件**直接拖进 AI 面板** —— 最多 8 份、单份 256 KiB（超了按字符边界截断并标注），只收 UTF-8 文本
  （二进制/其它编码会明确报错）。参考文件与"当前图表源码"在提示词里分开措辞，
  模型不会把参考资料当成要重写的正文
- **AI 只改它自己写的那一版**：渲染失败时的自动修正只在"正文还是 AI 刚落的那一版"时触发 ——
  你自己接着手改出的语法错，它不会主动去改，更不会覆盖你正在写的内容（错误照常报在预览/问题面板里）
- **用量如实标注来源**：只累计供应商实报的 token，没回报的显示 `—` 并说明，绝不显示 0，
  也不掺本地估算
- **真的记得上文**：对话轮次会带进下一次请求（自动裁剪，最新一轮永远保留），
  可以接着上一句继续改图，而不是每轮从零开始
- **会话历史按文档持久化**：历史存在本机、按文档归类，重启后还在；「历史会话」里看到的是真实轮次，
  清空只影响当前文档（图片永不落盘）
- **文件还没存，对话先有了**：新建文档（还没另存为）里的对话存在**草稿**仓里，重启照常找回；
  你保存 / 另存为的那一刻，草稿会话迁移到文件身份下 —— 重命名、移动文件之前的对话不会留在旧路径上
- **对话按归属落盘，而不是「当前活动标签页」**：流式生成过程中切标签页不再丢一轮；
  「应用成新标签页」时对话跟着产物走（不再出现对话留在旧文档、产物在新文档）；
  保存失败会提示一次，不再被静默忽略
- **思考过程看得见、也能收起来**：思考型模型（GLM / DeepSeek / Qwen 这一族）的推理实时显示在气泡上方，
  收尾自动收起，点一下摘要行（或按 Enter / 空格）又能展开读完整原文；一轮只有推理、没有正文时，
  会说明原因并把推理留着。推理**随会话一起落盘**（它是真实计费的产出），重启后展开读到的还是那份原文
- **文件打开历史**：欢迎页的「最近」列 5 条，旁边的「更多」打开完整历史（本机最多留 50 条，
  可按文件名或路径过滤，点一行即打开 —— 已在标签页里的会切过去）；`Ctrl+R` 与文件菜单里那条
  「打开最近文件 → 更多」都是这个窗口
- **长期记忆（可选）**：AI 可以提议记住你的偏好与术语（配色、默认流向、命名习惯……），
  产物先落在「待确认」，**你确认后才生效**；也可以手动增删改，全部存本机、可整体关闭
- **受控工具循环（试验）**：打开后，AI 回答前可以先「读文档 → 查语法 → 做校验」，最多 5 步。
  工具只作用于内存中的文档模型，**绝不接触文件系统、shell 或网络**；打开后改走非流式多步调用
  （不再逐字输出），每一步都计入用量 —— 所以默认关闭，由你决定
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
- **关闭到托盘（按设置）**：设置 → 外观打开后，点 ✕ 只隐藏窗口，托盘图标可唤回、也可从菜单退出；
  托盘图标常驻，两种设置下都能从那里退出
- **Mermaid 默认外观**：文档自己没选外观时的全局兜底
  （优先级：文档选择 > 全局默认 > Mermaid 内建默认；frontmatter config 永远最高）
- **设置面板可滚动**：它曾被外层容器整体裁掉（`max-height` 漏到了面板之外），超出窗口的部分点不到；
  现在内容超出时面板自己出滚动条

## 技术栈

- **语言 / 框架**：Rust（2021 版次）+ Tauri 2，前端无框架、**无构建链**、零 CDN
- **WebView**：系统 WebView（Windows 上为 WebView2）
- **编辑器**：CodeMirror 6（打包进 `ui/vendor/`，暴露给外壳，不落 npm 依赖）
- **渲染引擎**：Mermaid（打包 JS）· Graphviz（WASM）· D2（随包的官方 wasm 构建）· drawio（随包裁剪运行时）· Excalidraw（本地打包）
- **AI 网络层**：Rust（reqwest + SSE 流式），凭据走 DPAPI
- **打包**：NSIS 安装包；画布/渲染运行时与前端 `ui/` 都作为资源打进包（其中 D2 的 wasm 约 11MB）

### 为什么有个自定义协议 `dgm`

外壳与承载页（drawio / Excalidraw / graphviz / mermaid / d2）**必须同源**：承载页的
「画布 ↔ 正文」往返靠直接读写 `iframe.contentWindow` 上的 `__hostQueue` / `__apply`
（契约真源见 `tools/drawio-host/host.html` 的注释块）。跨源就拿不到，只能退回
「宿主轮询 + 脚本注入」——那套在 WebView 包装层上不稳。

所以整个应用都从 `dgm` 加载：Windows 是 `http://dgm.localhost/`，其它平台是 `dgm://localhost/`。
`/drawio/`、`/excalidraw/`、`/graphviz/`、`/mermaid/`、`/d2/` 是挂载点，其余路径落到 `ui/`。
协议只供出挂载根之内的文件：路径先百分号解码，出现反斜杠、`..` 段或绝对/带根路径一律拒绝
（3.5.2 之前这里有过一个真实可利用的穿越漏洞，回归测试在 `crates/assets`）。

### 运行时分工（一句话）

**摸「机器状态」的归 Rust，摸「渲染与交互」的归 WebView。**

| 归 Rust | 归 WebView |
|---|---|
| 窗口 / 单实例 / 文件关联 / 更新器 | 全部界面 chrome、布局状态机、快捷键分发 |
| 文件读写（原子写）、最近文件、设置持久化 | CodeMirror 6 编辑器 |
| 语法校验 / 大纲 / 作用域 / 格式转换（app-core，单一真源） | mermaid · wasm-graphviz · D2（wasm）页内渲染 |
| 全工作区搜索、文件监视、autosave 计时 | drawio / Excalidraw 画布承载 |
| AI 网络层（流式）、凭据（DPAPI）、云网关 | AI 流式展示、代码卡、应用 / 回退 |
| 区域截屏（冻结帧）、剪贴板写 PNG、导出落盘 | 导出序列化（SVG / canvas → 字节交原生） |

## 环境要求

### 运行打包版
- Windows 10 / 11 64 位（需要 WebView2 运行时；Win10/11 通常已预装）
- VC++ 运行库**不需要**：release 已静态链接 CRT
- 画布 / 渲染运行时（约 105 MB，含 D2 的 11MB wasm）与前端 `ui/` 都在安装包里，不需要额外下载

### 开发
- Rust 工具链（本机为 `stable-x86_64-pc-windows-gnu`）
- 画布 / 渲染运行时不入库（drawio · excalidraw · graphviz · mermaid · d2，共约 105MB）：
  开发期由 `crates/assets` 自动向上找源工作树，打包前必须先汇出（D2 用 `node tools/fetch-d2.mjs`
  自动取，见下）

## 开发与验收

```bash
cargo run -p diagramon             # 起客户端
node tools/dev/check.mjs           # 一条命令验收（全量）
node tools/dev/check.mjs --test-only   # 只跑 Rust 单测
node tools/dev/check.mjs --skip-test   # 只跑真机自检（构建仍会跑）
python tools/dev/canvas_probe.py   # 画布链路探针：真 drawio 载入 → 取回 → 截图
python tools/dev/ui_probe.py       # 界面探针：浏览器原型里跑真实交互断言
python tools/dev/readme_shots.py   # 重新生成 screenshots/ 里的界面截图
node tools/fetch-d2.mjs            # 打包前取 D2 运行时（自动：npm pack / 直连 registry；已在位则跳过）
node tools/fetch-assets.mjs        # 打包前把五个挂载点的资产汇到 assets/
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
  assets/            自定义协议 dgm 的路径解析（外壳与五个挂载点同源的实现）
  ai/                提示词与供应商（BYOK 流式对话）
  platform/          平台适配层接口（凭据、路径）+ 非 Windows 的明文兜底
  platform-windows/  DPAPI 凭据存储（按当前用户加密）
src-tauri/           Tauri 装配与命令层（窗口、协议注册、命令、事件、监视、截屏）
ui/                  前端外壳（无框架、无构建链、零 CDN）
  js/                外壳 · 侧栏 · 面板 · 标签 · 编辑器 · 画布承载 · D2 引擎 · 预览 · AI · 云端 · 对话框
  vendor/            CodeMirror 6 打包 · mermaid · wasm-graphviz（随包，无外部请求；D2 的运行时在 `assets/d2/`）
assets/              随包资产根（打包前由 tools/fetch-assets.mjs 汇出，不入库）
design/ui-proto/     界面原型与设计说明（index.html 是设计真源，含截图索引与实施映射）
docs/                路线图与发布检查单
tools/               取资产脚本（drawio / excalidraw / graphviz / mermaid / d2）· drawio / Excalidraw 承载页 · 开发用验收脚本
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
- [D2](https://d2lang.com/) - `.d2` 图表（随包的官方浏览器 wasm 构建，MPL-2.0）
- [drawio](https://github.com/jgraph/drawio) - `.drawio` 画布（随包裁剪运行时，Apache-2.0）
- [Excalidraw](https://github.com/excalidraw/excalidraw) - `.excalidraw` 手绘风格画布（MIT）
- [OpenAI 兼容 API](https://platform.openai.com/docs/api-reference) - BYOK 与云网关的对话协议
- [Ollama](https://ollama.com/) - 本地大模型

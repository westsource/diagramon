# dev2.0 ↔ main 功能差距核对

> 基准：`main` 分支（`git rev-parse main` = `a1cf45f`，与 `E:/OpenCode/diagramon/client` 同提交，C#/Avalonia 旧实现）。
> 被核对对象：`client2` 的 **dev2.0 新栈**（`crates/` + `src-tauri/` + `ui/`）。
> 口径：**`client2` 工作树根部仍保留一份与 main 同名的 C# 源码副本**（迁移期行为参照），
> 它**不计入** dev2.0 实现；下表状态一律只针对 Rust 侧与新前端 `ui/`。
> 方法：对 main 的 5 个域（UI 外壳 / 渲染与画布 / AI / 云端 / 平台与数据）逐文件核对，证据为文件:行。

## 0. 总览

| 域 | 已实现 | 部分实现 | 未实现 | 一句话 |
|---|---|---|---|---|
| UI 外壳与交互 | 工具栏、状态栏、标签关闭/脏标、分割条拖动、预览手势、部分快捷键 | 新建/Ctrl+N、关闭确认、缩放范围、撤销重做 | 菜单栏、Help/About/操作说明、最近文件、AI 面板、高亮、查找替换、折叠、窗口持久化、CLI、崩溃日志 | 只有"单窗口编辑器雏形" |
| 渲染与画布 | 格式注册表数据面、`dgm` 协议替代 loopback | Mermaid/DOT 内联预览、防抖、错误展示 | 导出/复制图片、缓存、drawio/Excalidraw 承载、离线守卫、增量更新、语法高亮/校验、转换 | 用户"看不到图"以外的一切 |
| AI 助手 | 无（仅 `supports_ai_assistant` 能力位 + DPAPI 原语） | 凭据基础设施 | 全部（4 provider + 云网关 + 生成/识图/对话/设置） | 整个子系统缺席 |
| 云端 / 会员 | 无（仅通用凭据原语） | — | 全部（登录/会话/云文档 CRUD/乐观锁/配额） | 整个子系统缺席 |
| 平台 / 数据 / 配置 | 文件 IO 基本读写、DPAPI 凭据、格式过滤器 | 凭据落盘格式与旧 `secure.config` 不兼容 | settings 持久化、数据迁移、更新器、本地化、对话框、崩溃日志、预览临时文件清理 | 只做了最底层两块 |

## 1. 已实现（真机可验证）

| 能力 | dev2.0 证据 |
|---|---|
| 格式注册表数据面：扩展名、默认正文（与旧客户端逐字符一致）、承载枚举、能力位、DOT 六布局 | `crates/app-core/src/format.rs` |
| 文档/会话模型：脏标记按内容比对、同路径去重激活、关闭落点 | `crates/app-core/src/{document.rs,session.rs}` |
| 未知扩展名回退 Mermaid | `crates/app-ipc/src/lib.rs`(`from_path`) |
| 自定义协议 `dgm` 资产服务（等价替代旧 `LoopbackStaticServer`）：挂载 `drawio/excalidraw/graphviz/mermaid` + ui、`..` 防穿越、MIME | `crates/assets/src/lib.rs`、`src-tauri/src/lib.rs` |
| Windows DPAPI 凭据存储（当前用户域、密文落盘、每键 `sha256(key).cred`） | `crates/platform-windows/src/dpapi.rs`（含往返+密文断言测试） |
| 文件打开/保存/另存为（按格式过滤器、默认扩展名） | `src-tauri/src/commands.rs` |
| Mermaid / DOT 实时预览（页内 `mermaid.render` / graphviz ESM）、350ms 防抖、平移/缩放/适配手势、分割条、状态栏 | `ui/app.js` |
| 便携运行包（exe + `ui/` + 随包 `assets/`，双击可开） | `dist/`（本地装配，不入库） |

## 2. 部分实现（有骨架，缺口具体）

| 功能点 | 缺口 |
|---|---|
| 多格式"新建" | 有下拉，但 **Ctrl+N 固定建 mermaid**；无菜单栏子项（main `MainWindow.axaml:22-32`） |
| 关闭标签确认 | 用浏览器 `window.confirm` 两键，**无 Save/Don't Save/Cancel 三键**（main `Views/SaveChangesDialog.cs`） |
| 缩放范围 | 预览 clamp 5%–800%；main 预览 20%–3000%，画布各有范围（README:31） |
| 平移/缩放快捷键 | 有 `Ctrl+0/=/−`，**缺小键盘与 Shift 变体**（main `MainWindow.axaml.cs:212-217`） |
| 内嵌预览渲染 | 仅默认引擎；**DOT 六布局未接到渲染**（`layout_options` 仅数据层）；无独立承载页/就绪探测/三态错误 |
| 渲染错误 | 原样 `err.message`；main 有分类与友好化（`MainViewModel.cs:1004-1120`） |
| 编辑器 | `<textarea>`：无语法高亮、无行号、无查找替换（main 用 AvaloniaEdit + XSHD + SearchPanel） |
| 打开/保存对话框 | 无"当前格式排最前 / 归一化建议名 / 不跨格式转换"（main `DocumentFormatRegistry`） |
| 文件编码 | 严格 UTF-8（失败报错），无 BOM 兼容/回退（main `FileService.cs`） |
| 命令行打开 | `open_paths_cmd` 存在但**无 argv 接线**（main `App.axaml.cs:78-85`） |
| 退出 | `Ctrl+Q` 直接退出，**无逐文件未保存确认**（main `MainWindow.axaml.cs:420-448`） |
| 凭据落盘格式 | 每键文件 + 内嵌 JSON，**与旧 `secure.config`（`Key=Base64(DPAPI)` 行式）不兼容，读不回旧数据** |
| 平台适配层 | 仅 Windows；macOS/Linux 以 `compile_error!` 阻断 |

## 3. 完全未实现（按域）

### 3.1 UI 外壳（main `Views/MainWindow.axaml(.cs)`）

- 菜单栏整体：File / Edit / View / Account / Help / 设置（`MainWindow.axaml:20-119`）。
- Help：Mermaid 规范、DOT 规范、**操作说明**（`Views/HelpDialog.cs`）、检查更新、**关于**（`Views/AboutDialog.cs`）。
- **最近文件**菜单 + 「更多...」历史对话框（搜索过滤 + 双击打开）：`MainViewModel.cs:1552-1635`、`Views/RecentHistoryDialog.cs`。
- **浮动「保存预览图 / 复制预览图」按钮**：`MainWindow.axaml:295-330`。
- 状态栏 **DOT 布局选择器**：`MainWindow.axaml:338-351`。
- 标签栏**鼠标滚轮切标签**：`MainWindow.axaml.cs:122-136`。
- **▶/◀ 折叠编辑器**（全屏预览）：`MainWindow.axaml:244-263`。
- **语法高亮**（Mermaid/DOT XSHD、JSON/XML）：`Services/MermaidHighlightingProvider.cs`、`Highlighting/DotHighlightingProvider.cs`。
- **查找替换**（SearchPanel / Ctrl+F）：`MainWindow.axaml.cs:359`。
- 编辑器**右键上下文菜单**：`MainWindow.axaml:192-201`。
- **AI 助手面板**（消息/模型下拉/识图/应用/回退/清空/设置/输入区/分隔条）：`Views/AIPanel.axaml(.cs)`。
- **本地化**（en-US / zh-CN、首次自动探测、语言切换）：`Services/Localization/**`、`MarkupExtensions/LocalizeExtension.cs`；dev2.0 `ui/` 文案硬编码中文。
- 窗口**最大化启动与布局持久化**、**崩溃日志**（`Program.cs:19-53`）、**数据迁移**（`Services/AppDataMigration.cs`，`Program.cs:15`）。
- 单实例 / 拖放打开：main **本身也未实现**（故非差距）。

### 3.2 渲染与画布（main `Services/Documents/**`、`Preview/**`、`Drawio/**`、`Excalidraw/**`、`Embedded/**`）

- **图像导出全部**：保存图片、复制到剪贴板、自适应倍率 1.5–5.0x、固定倍率档、透明底、Mermaid(mmdc)/DOT(页内 `data:` 路)/drawio/Excalidraw 页内导出（`MainViewModel.cs:1200-1753`、`MermaidService.cs`、`DotWasmRenderer.cs:127-268`）。
- **渲染缓存 LRU(32) + 后台 PNG 预生成**：`MermaidService.cs:19-22,146-182`、`MainViewModel.cs:1315-1356`。
- **渲染器抽象与增量更新**：`IDocumentRenderer`（`BuildUpdateScript`/`BuildReadyProbeScript`/`RendererProvision`）、`PreviewSurfaceHost`（承载面落盘 + 7 天清理）。
- **drawio 内嵌承载**整条链：loopback + `host.html` + embed 事件（init/load/autosave/export）、自动回写、单保存入口（`noSaveBtn` + 主动取 XML）、离线加固、附加库/模板本地化（`DrawioDocumentHost.cs`、`DrawioMessage.cs`、`tools/drawio-host/host.html`、`tools/fetch-drawio.ps1`）。
- **Excalidraw 内嵌承载**整条链：库型实例化、onChange 回写去抖、规范化回声抑制、`EXCALIDRAW_ASSET_PATH` 字体本地化、离线守卫（`ExcalidrawDocumentHost.cs`、`tools/excalidraw-host/index.html`）。
- **Mermaid → drawio / Excalidraw 转换**：`MainViewModel.cs:758-799`。
- **语法校验 + 行号友好化**：`MermaidService.cs:130-134`、`MainViewModel.cs:1081-1120`。
- 承载抽象 `IEmbeddedDocumentHost` / `EmbeddedProtocol` / `WebViewBridge`（dev2.0 用单窗口 + 同源 DOM 取代，需重新设计等价物）。
- 注：**离线守卫**（`tools/offline-guard/offline-guard.js`）未接入 dev2.0 的承载路径。

### 3.3 AI 助手（main `Services/AIService/**`、`AIConversationService.cs`、`ViewModels/AI*.cs`）

全部未实现：OpenAI / Azure OpenAI / Ollama / Custom 四 provider；**会员云网关**（固定 `/v1/ai/chat/completions`、每请求取 token 不落盘、credits、档位自动选择与「实际使用档位」回报）；自然语言生成 + 分格式提示词 + 围栏提取；**识图**（截图→代码、视觉提示词、`ImagePreprocessor` 压缩）；**渲染错误自动修正**（第二次真调用 + 开关）；对话持久化（按文件 SHA256、路径可配置、清空）；参数（MaxTokens≤2,000,000、Temperature、多模型选择器）；一键应用/回退/应用到 drawio；面板输入体验（Shift+Enter、右键菜单、80–320px 分隔条）；密钥安全（DPAPI + 与 settings 隔离）。
dev2.0 仅有：`supports_ai_assistant` 能力位 + `platform` 凭据原语。

### 3.4 云端 / 会员（main `Services/Remote/**`、`AuthService.cs`、`Views/Cloud*`、`LoginDialog`）

全部未实现：登录/登出/注册跳转/重发激活；会话恢复与刷新互斥、401 静默刷新重试；匿名 `/v1/config` 下发与云入口门控；`/v1/ai/models` 别名目录；云文档 CRUD（列表/取/写）、**乐观锁 `If-Match` + `version_conflict`**、**客户端 UUIDv7 文档 id**、格式白名单 `CloudFormatIds`、`ResolveCloudFormat`；目录树与双栏浏览器、保存路径选择器、云端文件管理（删除确认）；配额展示；错误码本地化（`CloudErrorText`）。
dev2.0 仅有通用 `CredentialRecord` 与 `ApiError{code,message}`（无 Auth/Cloud/Membership DTO，无 HTTP 客户端）。

### 3.5 平台 / 数据 / 配置（main `Services/SettingsService.cs` 等）

- **settings.json 持久化**（全字段清单：`EditorPreviewRatio`、`UseFixedExportScale/FixedExportScale`、`Language`、`AutoCheckUpdate/SkipVersion/LastUpdateCheckTime/UpdateManifestUrl`、`ConversationStoragePath`、`AIPanelExpanded/Height`、`AiVisionNoticeAccepted`、`AiRenderFeedbackRetry`、各 provider 配置、`DeviceId`、`ServiceBaseUrl`、`LastOpenDirectory`、`RecentFiles`）与独立 `recent-history.json`；读写时机（启动加载、退出/切语言/改模型/加最近文件时保存）。
- **数据迁移**：`Mermaider → Diagramon`（`%APPDATA%`/`%LOCALAPPDATA%`，启动首句执行，`AppDataMigration.cs:35-72`）。
- **旧 `secure.config` 读回兼容**（trait 注释已把它列为要求，但未实现）。
- **最近文件**记录（≤10、去重、失效剔除、首次保存入历史、菜单+历史对话框）。
- **更新器**：清单（`update-manifest.json`，dev2.0 已有同名文件但**无读取者**）、版本比较、24h 冷却、跳过版本、下载进度、浏览器打开、更新对话框。
- **本地化**：`Assets/Languages/*.json`（~280 键）、首次系统语言探测、`Strings` 读取器、切语言刷新、帮助正文 `Assets/Help/help.<lang>.md`。
- **对话框**：保存确认三键、退出逐文件确认、最近历史、帮助、关于、图片倍率设置。
- **崩溃日志**（`crash.log`）+ **预览临时文件清理**（7 天）。

## 4. 建议的补齐顺序（按"用户可见价值 / 依赖顺序"）

1. **阶段 2 主菜（改动最大、最影响可用性）**：drawio / Excalidraw 内嵌承载 + Mermaid/DOT **页内导出（保存/复制图片）** + DOT 布局选择器 + 语法高亮与查找替换。→ 让四种格式真正可用。
2. **配置地基**：settings 持久化 + 最近文件 + 本地化 + 三大对话框（保存确认/关于/帮助）+ 崩溃日志 + 命令行打开。→ 补齐"日常使用"闭环。
3. **AI 助手**：先 BYOK（OpenAI/Ollama/Custom）+ 生成/应用/回退 + 对话持久化；再识图与渲染错误修正。
4. **云端/会员**：登录与会话 + 云文档 CRUD（含乐观锁、UUIDv7、格式白名单）。
5. **更新器**、平台化（macOS/Linux 适配层、三平台打包签名）。

> 说明：main 自身也存在未实现/未核实项（单实例、拖放、窗口 bounds 持久化；README 声称的"预览缩放自动保存""余额界面展示"未在代码中核实到绑定），这些不构成 dev2.0 的差距。

# Spike 结论（阶段 0）

> 依据《Diagramon 客户端升级完整方案》§8.1 与 §8.1.10。
> 本文档按**闸门项**分节。已完成：**项 7**（阶段 B 闸门）、**项 1**（阶段 C 方向）。
> 项 2–6 与项 8 的结论在 drawio / Excalidraw 落地过程中补记（每项都要有可观测判据，不是推断）。
> 执行环境：本机 Windows 11 / .NET 10 / 应用自带 WebView2；页面级验证用托管 Chromium 152。

## 项 1 — `CoreWebView2` 可用性（阶段 C 方向）

**结论：可以拿到 → 方案 §4.4 的首选（虚拟主机映射）技术上可行；但 drawio 的承载 origin 仍选 loopback（§4.4 回退方案）。**

| 事实 | 证据 |
|---|---|
| 控件 `AvaloniaWebView.WebView` **没有** `CoreWebView2` 成员 | 元数据枚举：该类型公开成员只有 `PlatformWebView` 等；`Source`、`CoreWebView2` 均不存在。这解释了 `Views/MainWindow.axaml.cs` 里那段 `GetProperty("CoreWebView2")` 反射为何始终取不到（走 else 支） |
| 但**能**经 `PlatformWebView` 到达 `CoreWebView2` | `WebView.PlatformWebView` → `WebViewCore.IPlatformWebView<WebView2Core>.PlatformView` → `Avalonia.WebView.Windows.Core.WebView2Core.CoreWebView2`（`public Microsoft.Web.WebView2.Core.CoreWebView2 CoreWebView2 { get; }`） |
| 随包 `Microsoft.Web.WebView2.Core.dll` 提供映射 API | `SetVirtualHostNameToFolderMapping` / `ClearVirtualHostNameToFolderMapping` / `PostWebMessageAsString` / `PostWebMessageAsJson` / `ExecuteScriptAsync` 都在 |
| 消息通道不必碰 `CoreWebView2` | 控件自身暴露 `WebMessageReceived : EventHandler<WebMessageReceivedEventArgs>` 与 `PostWebMessageAsString(string, Uri?)`，另有 `NavigationCompleted` |

**为什么仍选 loopback**：它不依赖包装层内部结构（升级不会突然失效），并且已经在 DOT 的 ESM + WASM 路径上实测通过（§项 7）；虚拟主机只服务静态文件、同样要处理跨源，省下一个本地端口的收益不值一条未实测的第二条 origin 路径。方案 §4.4「两条都实现、自动选择」保留为后续优化项，**本节只记录该路径确实可达**。

对应的实现：`Services/Preview/LoopbackStaticServer.cs`（DOT 预览）、`Services/Drawio/DrawioDocumentHost.cs`（drawio 画布，挂载 `/drawio/` → `tools/drawio`）。

## 项 2 — 自托管 embed 闭环（阶段 C 闸门）

**结论：通过。** 在**真实** drawio v31.4.6 裁剪产物 + 我方 `host.html` 外壳页 + 进程内 loopback origin 上实测（托管 Chromium 驱动，脚本与 C# 侧 `DrawioProtocol` 完全同构）：

| 判据 | 结果 | 证据 |
|---|---|---|
| 收到 `{"event":"init"}` | ✅ | 队列里出现 `{"event":"init"}`（**去掉 `configure=1` 之后**） |
| 回 `action:load`（含 xml + autosave:1）后收到 `load` | ✅ | `load` 事件带回完整 XML 与视图元数据（`pageVisible`/`bounds`/`modelBounds`/`containerSize`） |
| 模型变化后收到 `autosave` | ✅ | Mermaid descriptor 载入后立即收到 `autosave`，载荷即转换后的 mxfile XML |
| `action:export` 后收到 `export` 且 `data` 是合法 data URI | ✅ | `{event:'export', format:'png', data:'data:image/png;base64,…'}`，data URI 长 11,334 字符 |
| `parent != window` 判定被 iframe 满足 | ✅ | 在 iframe 内实测 `parent !== window === true`（方案 §3.2.3 的基础成立，不是想当然） |
| 消息不被双重编码 | ✅（C# 侧已修） | 见下方"发现的两个坑"第 2 条 |

### 发现的两个坑（都已修，且都是这套协议特有的）

1. **`configure=1` 会让 drawio 停住**：带该参数时 drawio 先发 `{"event":"configure"}` 并**等宿主回 `action:configure`**，`init` 永不到来 —— 承载层会一直空着。方案 §4.5 的 `host.html` 草案 URL 正好带了这个参数。现在不带它（离线加固在拉取期改 `PreConfig.js`，不需要 configure 回包），实测 `init` 立刻到达。
2. **`ExecuteScriptAsync` 的返回值是"返回值的 JSON 编码"**：脚本返回字符串时会再包一层引号并转义，直接 `Deserialize<List<string>>` 会抛错 → 事件被**静默丢弃**。C# 侧现在统一走 `WebViewBridge.ExecuteStringScriptAsync`（先解一层字符串再解析），数字/布尔返回值那两种形状也一并容忍。

## 项 4 — 最小资源子集与体积（阶段 C）

**结论：裁剪后 `tools/drawio/` = 2906 个文件 / 58.9 MB**（`du` 报 64 MB 磁盘占用）。上游 `src/main/webapp` 全量远大于此，"裁剪基准是能离线跑通 embed 模式"逐条写在 `tools/fetch-drawio.ps1` 的白名单注释里（每条都引了上游文件与行号）。

关键取舍（脚本注释里有完整理由）：

- **保留三个构建期 bundle**（`js/app.min.js`、`js/shapes-14-6-5.min.js`、`js/stencils.min.js`、`js/extensions.min.js`）→ 因此上游 46 MB 的 `shapes/`、`stencils/` 整目录**不需要**。
- **`js/integrate.min.js` 已从白名单移除**（约 21.5 MB）：它是"把 drawio 嵌进别的产品"的另一个成品包，`index.html`/`bootstrap.js` 走的是 `app.min.js`，实测零引用。方案 §8.1 项 4 把它列在初稿里，这里按实测裁掉 —— 这是本项相对方案的**有意偏差**。
- 实测加载清单（真机请求日志）与白名单完全一致：`index.html`、`styles/grapheditor.css`、`js/bootstrap.js`、`js/main.js`、`js/PreConfig.js`、`js/PostConfig.js`、`js/app.min.js`、`mxgraph/css/common.css`、`resources/dia.txt`、`js/shapes-14-6-5.min.js`、`js/stencils.min.js`、`js/extensions.min.js`…（共 15 个不同路径）。

## 项 5 — 离线缺口（阶段 C）

**结论：通过。** 真 drawio 页面 + 一次 Mermaid 转换 + 一次 PNG 导出，全程 **48 个请求、零外部**：全部落在 `http://127.0.0.1:<随机端口>/drawio/…`（`data:` / `blob:` 除外）。

加固方式（全部落在**拉取期**，不在运行期拦截）：

| 项 | 处理 | 依据 |
|---|---|---|
| 服务端导出 | `window.EXPORT_URL = null;`（确保存在） | `js/PreConfig.js` 是上游自带的宿主配置落点，早于 `app.min.js` 加载 |
| Google Drive 连接器 | `urlParams['gapi'] = '0';` | 上游 `App.js` 在 `gapi != '0'` 时会 `mxscript('https://apis.google.com/js/api.js…')` —— 这是**唯一**一条真实外链脚本 |
| MathJax 数学渲染 | `urlParams['math'] = '0';` | 上游会在异步路径去取 `math4/es5/startup.js`（方案 §6.2 记的那条）；关掉后 `math4/` 不再被请求 |
| 补丁幂等 + 进清单 | 追加行带探针，重复运行不重复追加；补丁后的 `PreConfig.js` 计入 `.manifest.json` 哈希 | 补丁丢了会被 `-Verify` / 发布前置校验发现 |

## 项 6 — Mermaid → drawio 转换质量（阶段 C）

**结论：通过。** 用仓库**已有的 15 个真实 `.mmd` 文件**（`MermaidGraphics/` 6 个 + `design/` 9 个）逐个走 `{"action":"load","descriptor":{"format":"mermaid","data":…,"wrap":true}}`，在真 drawio v31.4.6 上实测：

| 文件 | 节点 | 边 | 转换后 XML |
|---|---|---|---|
| 数据接入-数据源层改改改.mmd | 16 | 13 | 22 KB |
| 数据接入.mmd | 16 | 13 | 22 KB |
| 时序图.mmd | 4 | 4 | 10 KB |
| 示例代码流程图.mmd | 6 | 5 | 8 KB |
| 类图.mmd | 12 | 2 | 9 KB |
| 饼图.mmd | 19 | 0 | 7 KB |
| guimodels.mmd | 18 | 16 | 33 KB |
| initialize.mmd | 41 | 29 | 62 KB |
| initialize_fd.mmd | 45 | 41 | 67 KB |
| OnWorkspaceSizeChanged_fd.mmd | 34 | 32 | 54 KB |
| openfile.mmd | 66 | 42 | 87 KB |
| openfile_fd.mmd | 134 | 139 | 257 KB |
| 智控平台实施导向WBS.mmd | 405 | 403 | 598 KB |
| 用户点击复制或保存图片流程图.mmd | 17 | 16 | 26 KB |
| 用户编辑流程图.mmd | 22 | 15 | 27 KB |

**15/15 成功，零 `error` 事件**；饼图被转成 19 个图形单元（mermaid 解析器把扇形画成形状），流程图/类图/时序图都保住了语义（`mermaidId` 映射齐全）。

细节证据（中文标签 + `wrap` 语义）：转换结果里 `UserObject label="开始" mermaidId="n:A"`、`判断`（`rhombus`）、边 `mermaidId="e:B->C#0"` 且标签 `是` **全部保留**；`wrap:true` 生效 —— 整张图被包进一个带 `mermaidData`（原始源码 + config 的 JSON）的 `UserObject` 组里，这正是"画布上的手工调整不会回写源码、再次编辑 Mermaid 会覆盖该组"这条**单向语义**的来源。

> 覆盖面声明：语料只含 flowchart / sequence / class / pie（仓库现有文件就是这样），**gantt / stateDiagram / erDiagram / mindmap 等未取样**，因此"没有遇到不支持语法"只对这一语料成立，不等于全语法可用。Phase 4 的界面在语法不受支持时应给出 drawio 侧的错误提示（`error` 事件已接进状态栏）。

## 项 8 — Excalidraw 构建形态（阶段 D 闸门）

**结论：没有可直接 `<script>` 引用的预构建产物 —— 打包步骤是必需的。** 但代价是可量化的（见下），因此 **Phase 6 保留**。

| 问题 | 结论 | 证据 |
|---|---|---|
| 有 UMD/IIFE/`<script>` 可用构建吗 | **没有** | `@excalidraw/excalidraw`（0.18.1）的 `main`/`module` 都是 `./dist/prod/index.js`，`exports` 只有 `import`/`default` 条件，没有 `require`；`dist/prod/index.js` 以 `import{…}from` 开头（纯 ESM）；包内 `*umd*`/`*iife*`/`*.min.js` 扫描零命中 |
| 需要什么打包步骤 | esbuild（`--format=iife --target=chrome120 --global-name=ExcalidrawApp`），React/ReactDOM 打进 bundle | 见 `tools/fetch-excalidraw.ps1` |
| 产物体积（实测） | spike 的未压缩 bundle 约 25.6 MB；**落地产物（esbuild `--minify`）为 242 文件 / 20.64 MB**：`app.js` 4.87 MB、`mermaid.js` 3.50 MB、`index.css` 145 KB、`fonts/` 13.1 MB（234 个）、`licenses/` 4.3 KB | `tools/fetch-excalidraw.ps1` 实跑输出 |
| 浏览器里真的能跑吗 | **能**：托管 Chromium 实测 `mount` 完成、`EXCALIDRAW_ASSET_PATH` 指向本页 origin、字体请求落在 `/fonts/Assistant/*.woff2`（本地）、整页 6 个请求**零外部**；`setScene` 注入 1 个矩形后 `getSceneElements().length === 1` | `site/index.html` + 本地静态服务 |
| 它依赖 mermaid 本体吗 | 依赖：`@excalidraw/mermaid-to-excalidraw` 需要 mermaid 解析器（转换在页面内完成，不回连服务端），因此产物里另有一个 3.4 MB 的 `mermaid.js` | spike 的 `src/entry.jsx`/`mermaid-global.js` |
| 与承载方式的契合 | 契合：**库型**集成 —— 我们自己写承载页、当场实例化，不需要 iframe / postMessage / init 握手；由 loopback origin 提供即可（与 drawio 同一套 origin 机制） | `tools/excalidraw-host/index.html` + `Services/Excalidraw/ExcalidrawDocumentHost.cs` |
| 离线硬要求 | **必须**在 bundle 之前设 `window.EXCALIDRAW_ASSET_PATH`，否则字体等资源会被解析到 Excalidraw 的 CDN 回退地址（`esm.sh/…`） | spike 的 `site/index.html` 注释；已写入我方承载页 |

**新增复杂度**（相对只有 drawio 时）：仓库多了一条"npm 安装 + esbuild 打包"的构建链（`tools/fetch-excalidraw.ps1`），以及约 8.4 MB + 字体的体积。这是本项目此前没有的构建环节 —— 方案 §8.1 项 8 要的就是把这件事量出来再决定，现在数字有了。

### 项 8 补充：落地后的实测（我方承载页 × 真 bundle）

页面级（托管 Chromium，脚本与 C# 侧 `EmbeddedProtocol` 同构）：

| 断言 | 结果 |
|---|---|
| 承载页挂载：`window.ExcalidrawApp.mount(root, onChange)` | ✅ `mount.length === 2`，且 bundle 源码里 `props.onChange = (t,i,a) => u(t,i,a)`（真的接了回调） |
| `setScene` 载入 + 回读 | ✅ `getSceneElements().length === 1`，且**不产生回写事件**（无回声） |
| 真实用户输入 → 变更捕获 | ✅ 双击画布 + 输入文本 + Esc → 队列里出现 `scene` 事件，元素含 `text:"hello"` |
| 页面内导出 PNG | ✅ `{event:'export', data:'data:image/png;base64,…'}`（16,354 字符） |
| Mermaid → Excalidraw | ✅ `{event:'loaded', count:9}`，画布 9 个元素（含中文标签） |
| 离线 | ✅ 32 个请求 / 13 个不同路径 / **零外部**；20 个字体请求全部落在本地 `./fonts/`（`EXCALIDRAW_ASSET_PATH` 生效） |

应用内（WebView2）：loopback origin 起来并被请求（5–8 条服务侧连接）、WebView2 子进程 6 个、**零外部连接**、状态栏走"运行时存在"分支（不再误报缺资源）、标签页**不再被误标脏**。

**这一期抓到并修掉的三个真问题**（都是"只有真机才会暴露"的那类）：

1. **队列身份**：宿主取消息时替换 `window.__hostQueue`，而承载页持有旧引用 → 用户编辑事件**全部静默丢失**。现在承载页按属性重读、C# 侧 `splice` 不换数组。
2. **挂载回声**：Excalidraw 挂载完成时用空场景触发 onChange → 会被当成用户改动，把**刚打开的文件正文覆写成空场景**。现在初值基线即"空场景签名"。
3. **规范化回声**：载入后 Excalidraw 会规范化元素（补 `index`、改 `versionNonce`）再触发一次 onChange → "只是打开文件"被标成已修改。现在用 900ms 回声抑制窗口 + 窗口结束时按画布当前元素重新对齐基线。

> 未覆盖：应用内的"画布内编辑 → 落盘"仍需鼠标输入，受本机**输入桌面不可用**限制（见附录 C，与 drawio 同一原因）。页面级已用真实输入（CDP `Input.dispatch*`）覆盖同一条通路。



## 项 7 — DOT 渲染器可用性（阶段 B 方向）

**项 7 通过**：`@hpcc-js/wasm-graphviz` 是**单文件 ESM 预构建产物**（无需自行打包），六个布局引擎都能产出 SVG，页面内 `SVG → canvas → PNG` 可用；
**但 `file://` 下不可用**（ES module 被 CORS 拦截），因此 `RendererProvision.NpmWasm` **必须走真实 origin** —— 落地方案采用 loopback 静态服务（方案 §4.4 的回退方案）。

### 实测数据

| 判据 | 结果 | 证据 |
|---|---|---|
| 包是否提供可直接引用的构建 | **是**：`dist/index.js` 单文件 ESM，819,284 字节，Apache-2.0 | `npm pack @hpcc-js/wasm-graphviz@1.29.1`；包内只有 `dist/index.js` + `dist/index.js.map` + `src/` + `types/`，**没有独立 `.wasm` 文件**；bundle 内无 `import` / `require` |
| 是否需要打包步骤 | **不需要**（与项 8 的 Excalidraw 不同） | 同上 |
| 包体量 | 819,284 B（约 800 KB），其中含内嵌 WASM | `tools/graphviz.js` 实测字节数 = 819284，sha256 `b541d7de92d53b2d86f01e4c5fecadb61ee071ad889309171ce9b9383d6cafb6` |
| Graphviz 版本 | **16.1.0** | 页面内 `graphviz.version()` 返回 `16.1.0`；SVG 注释 `Generated by graphviz version 16.1.0` |
| WASM 加载耗时 | 96 ms（Chromium，首次 `Graphviz.load()`） | 页面内 `performance.now()` 计时 |
| 六个引擎出 SVG | **全部通过**：`dot` / `neato` / `fdp` / `sfdp` / `twopi` / `circo` | 同一份 DOT 源码，六个引擎的 `viewBox` 互不相同（316×103 / 184×141 / …/ 62×188），证明布局确实切换 |
| 额外可用引擎 | `osage` / `patchwork` / `nop` / `nop2` 也存在于 API 类型定义中 | `types/types.d.ts` 的 `Engine` 联合类型（本期按方案只注册六个） |
| 页面内导出 PNG | **通过**；透明底 | `SVG → Image → canvas.toDataURL('image/png')`：4x 下 716×564、49,402 字符 data URI；逐像素校验不透明像素占比 6.09%（= 图形墨迹占比，背景透明） |
| `file://` 是否可行 | **不可行** | `file://` 下模块导入被拦：`Failed to fetch dynamically imported module: file:///.../graphviz.js` |
| 真实 origin 是否可行 | **可行**（`http://127.0.0.1:<随机端口>`） | 页面与 `/renderer/graphviz.js` 同源加载成功；**全程只有 1 个资源请求**，无任何外部网络请求（离线安全） |
| 切换布局是否重载 WASM | **否**：布局切换只走 `renderDiagram(src, engine)`，`graphviz.js` 只被请求 **1 次** | 服务端请求日志 + 引擎切换前后计数 |
| 语法错误的表现 | 抛 `Error`，消息含行号：`syntax error in line 1 near ';'` | 页面 `showError` 渲染该消息；恢复后再渲染正常 |

## 附录 A · 落地方式（与方案的对应）

| 方案条目 | 落实 |
|---|---|
| §4.1.1 `RendererProvision = NpmWasm` | `DotWasmRenderer.Provision = NpmWasm` |
| §8.3.2 承载方式 | 进程内 loopback 静态服务（`Services/Preview/LoopbackStaticServer.cs`，`TcpListener` 绑 `127.0.0.1:0`，不用 `HttpListener` —— 后者在非管理员下需要 URL ACL）。页面挂 `<格式 id>/`，渲染器资源挂 `/renderer/` |
| §8.2.3 增量路径是一等公民 | 布局切换与内容变化都走 `BuildUpdateScript`；页面只在**换格式**时重新导航 |
| §8.3.4 导出零子进程 | 导出脚本在页面内完成栅格化；`graphviz.js` 自绘的白底多边形在透明导出时被剔除（唯一一处对渲染器输出的后处理，用于与 `mmdc -b transparent` 的观感一致） |
| §8.3.5 资源获取 | `tools/fetch-graphviz.ps1` + `tools/graphviz.version`（pin `1.29.1`）+ `.manifest.json`（相对路径 + sha256）；`tools/graphviz/` 不入库；`publish1-build.ps1` 打包前校验存在性与哈希，不匹配即退出 |

## 附录 B · 未通过项 → 需要重估的地方

| 若未通过 | 影响 | 本项实际情况 |
|---|---|---|
| WASM 在 `file://` 下可用 | 可省掉 origin 机制，`NpmWasm` 退化为"随包 JS 的变体" | **未通过 → 已按方案预期走真实 origin**（loopback），与 drawio 的 §4.4 回退路径共用同一套机制 |
| 有预构建产物 | 需要引入 esbuild/vite 打包步骤（新增构建环节） | **通过 → 不需要打包步骤** |
| 六引擎可用 | Phase 2 的"六个布局引擎"验收项要缩减 | **通过** |

## 附录 C · 应用内（WebView2）验证现状

协议层（项 2/5/6）走的是"真 drawio + 我方载体页 + loopback"，在托管 Chromium 里驱动；**应用内**另有一层必须单独确认的链路（WebView2 承载、C# 桥接、回写、落盘）。本轮状态：

| 应用内断言 | 结果 | 证据 |
|---|---|---|
| 承载面挂载 + loopback 启动 | ✅ | drawio 标签页打开后，应用内 `127.0.0.1:<随机端口>` 处于监听 |
| WebView2 真的去取了我们 origin 的资源 | ✅ | 该端口上**服务侧连接记录 18 条**（页面按 `host.html` → `index.html` → 各 bundle 的顺序取回），WebView2 子进程 6 个 |
| 承载面零外部请求 | ✅ | 进程树内所有非回环连接都归**应用主进程**（自动更新检查），WebView2 侧为 0 |
| Mermaid → drawio（15/15） | ✅ | 见项 6（页面级，同一份 C# 产物脚本） |
| 画布编辑 → autosave → 标签页 → 落盘 | ⏳ **被环境阻断** | 本机会话的**输入桌面不可用**：`SetForegroundWindow`/`AttachThreadInput` 都拿不到前台（`foreground ok=False`），注入的鼠标/键盘打不到应用窗口（`keybd_event` 与 `SendKeys` 均无效）。`PostMessage` 能把窗口消息投进去（F10 能打开"文件"菜单、菜单项会出现在 UIA 树里），但激活不稳定，不足以作为断言手段 |
| 画布内撤销/重做跨标签页 | ⏳ 同上 | 依赖输入 |
| 画布内导出（复制/保存图片） | ⏳ 同上 | 依赖点击浮动按钮 |

**Excalidraw 侧**同样的限制，但已确认的应用内事实：loopback origin 起来并被请求（5–8 条服务侧连接）、WebView2 子进程 6 个、**零外部连接**、状态栏走"运行时存在"分支（不再误报缺资源）、**打开 `.excalidraw` 不再被误标脏**（回声修复生效）。

被阻断的那几项都已备好可复跑脚本（本机 `%TEMP%\drawiotest\`）：`edit-test.ps1` 做"双击画布造节点 → Ctrl+S → 比对文件"，`convert-test.ps1`/`menu-click.ps1` 做"文件 → 转换为 drawio 图"，`sample.excalidraw`/`sample.drawio` 是配套样例。**待桌面可交互时**执行即可（今天已出现过一次该窗口）。

### 附录 C.1 · 2026-09-21:drawio 卡在 Loading 的根因与守卫

**现象**:打开 `.drawio` 标签页,画布永远停在 drawio 自己的 "Loading…" 转圈。

**根因(我方的回归)**:统一承载协议时,宿主侧投递固定为 `window.__apply(...)`(`EmbeddedProtocol.DeliverScript`),
而 drawio 的承载页当时暴露的是 `window.__deliver`。`ExecuteScriptAsync` 对**不存在的函数不报错**,
于是 `init` 之后 flush 出去的 `load` 动作被静默丢弃 —— 页面收到了 init 却永远等不到文件,只能一直转圈。

关键点:**这类失败没有任何日志/异常**,现场只剩一个转圈。

**修复**
1. `tools/drawio-host/host.html`(共享源)与 `tools/drawio/host.html`(拉取脚本生成的部署副本)统一为 `window.__apply`;
   两处都要改 —— 应用实际加载的是生成副本,只改共享源不生效。
2. 两侧就绪路径都加**入口探针**:drawio 在 `init`、Excalidraw 在 `ready` 时先执行
   `EmbeddedProtocol.ReadyProbeScript`(`typeof window.__apply === 'function'`),不为 `true` 就往状态栏报
   "承载页缺少消息入口 window.__apply…" —— 把静默失败变成可见错误。
3. drawio 的 `init` flush 改为复用 `SendAction`(此前自己又写了一遍投递,两条路径容易再次跑偏);
   Excalidraw 的 `SendCommand` 补上"未就绪先排队"(此前 `_pendingCommands` 从未入队、也不判就绪,同样是静默丢弃)。

**验证**
- 应用内(最大化窗口,PrintWindow 原状截图):`shapes.drawio`(两框一箭头)画出 甲方/乙方 + 箭头,**无 spinner、状态栏无报错**;
  页内探针:`rects:2, paths:3`、两个 140×60 的图形组位于视口内(1406,129)/(1706,289)。
- 反向验证:把部署副本的入口名退回 `__deliver`,再开同一文件 → 画布转圈**且状态栏出现含 `window.__apply` 的报错** ⇒ 守卫有效。
- Excalidraw 回归:`.excalidraw` 打开后画布挂载并画出内容,状态栏无 `window.__apply` 报错(新队列未引入退化)。

**测量陷阱(记录以免重犯)**:截图脚本里 `ShowWindow(SW_RESTORE)` 会把**最大化**窗口还原成 1216×839 再抓图,
而页面是按最大化时的 3440 px 视口布局的 —— 抓到的画面里图形恰好落在可视区之外,看起来像"画布空白",
一度把排查引偏。**抓 WebView2 窗口要按原状抓(只 `GetWindowRect` + `PrintWindow`),不要先改窗口状态。**

## 附录 E · 随包 vs 在线：四种格式的资源审计

**结论：四种格式的渲染资源全部随包分发，运行期零在线加载。** 审计方法：对随包产物做全量 http(s) 引用静态分类（脚本见本节末尾说明），再用真机逐格式扫描 WebView2 进程树里的非回环连接。

| 格式 | 资源位置 | 运行期来源 | 静态审计结果 |
|---|---|---|---|
| Mermaid | `Assets/mermaid.min.js`（`AvaloniaResource`，编进程序集，运行时抽到临时目录） | `file://` | 仅 XML 命名空间（w3.org / eclipse.org）与许可证注释 URL ✓ 无加载 |
| Graphviz DOT | `tools/graphviz/graphviz.js`（`fetch-graphviz.ps1` 从 npm 拉取） | loopback origin | 仅 SVG DOCTYPE 里的 DTD 字符串 ✓ 无加载 |
| drawio | `tools/drawio/**`（`fetch-drawio.ps1` 从 GitHub tag 拉取并裁剪） | loopback origin | 3 类真外链 + 1 类字体，已本地化 / 置空（见下） |
| Excalidraw | `tools/excalidraw/**`（`fetch-excalidraw.ps1`：npm + esbuild 打包） | loopback origin | 3 个在线端点（分享短链 / 在线图形库目录 / Plus），UI 关闭 + 守卫拦截 |

### drawio 的三类真外链（审计逐个定位）

| 外链 | 命中数 | 何时会真的联网 | 处理 |
|---|---|---|---|
| `jgraph.github.io/drawio-libs/libs/*.xml` | 41 | 用户在图形库面板展开"附加库"（Azure / AI 等）时 **XHR 拉取** | 拉取期下载进 `tools/drawio/libs/` 并改写成相对路径 |
| `cdn1/2/3.iconfinder.com/**`、`raw.githubusercontent.com/coreui/**` | 24 | 打开含这些图片的模板 / 模具时 **Image 加载** | 拉取期下载进 `tools/drawio/img/external/` 并改写成相对路径 |
| `fonts.googleapis.com/css?family=`（`Editor.GOOGLE_FONTS` / `_CSS2`） | 5 | 图里使用了 Google 字体时加载 CSS + 字体 | 拉取期把这两个常量**置为空串**，并断言替换成功（找不到模式即报错退出） |

另外已确认**不再**是外链的（配置已关）：`convert.diagrams.net`（`EXPORT_URL=null`）、`apis.google.com`（`gapi=0`）、MathJax CDN（`math=0`）、`icons.diagrams.net`（`PostConfig.js` 清空 `ICONSEARCH`/`ICON_SERVICE`）。其余命中都是注释 / 许可证 / XML 命名空间 / `openLink(` 纯导航链接（用户点了才会离开应用）。

### Excalidraw 的在线端点

`json.excalidraw.com`（分享短链）、`libraries.excalidraw.com`（在线图形库目录）、`plus.excalidraw.com`（Plus 推广）、`draw-room-persistence.cloudfunctions.net`（协作房间）—— 这些是**可选功能**的端点，不是渲染资源；形状 / 字体 / CSS 全部随包。处理：承载页关闭相应 UI 入口（`UIOptions` + 必要的 CSS），并由离线守卫兜底。

### 离线守卫（与配置无关的底线）

第三方应用内部的端点随版本增删，"逐个改配置关掉"不可能穷尽。因此新增共享资产 `tools/offline-guard/offline-guard.js`（**入库**），在任何应用脚本之前打补丁：

- 非本机 origin 的 `fetch` / `XMLHttpRequest` / `Image.src` / `navigator.sendBeacon` 一律拒绝；放行同 origin、相对路径、`data:` / `blob:` / `about:`；
- 每次拦截入队一条 `external-blocked`，宿主在状态栏显示"已拦截外部请求（离线模式）: <url>" —— 不静默吞掉，便于发现上游回归；
- 注入方式：Excalidraw 承载页 `<script src="./offline-guard.js">`（在 `app.js` 之前）；drawio 由 `fetch-drawio.ps1` 注入到 **drawio 自己的 `index.html`**（它跑在 iframe 里，宿主页的补丁管不到它的 realm）。

实测（托管 Chromium，真 Excalidraw 产物）：`guardInstalled=true`；外部 `fetch` / `XHR` / `Image` 三种尝试**全部被拦且留痕**，同源 `fetch('./index.css')` 照常 200，画布正常挂载，整页 9 个请求**零外部**。

**资源线交付后的复核(2026-09-21)** —— 静态闸门 + 端到端 + 真机三项都过:

| 项 | 命令/手法 | 结果 |
|---|---|---|
| 清单 | 逐条重算 sha256 | 2945 条,**0 不一致 / 0 缺失**,72,230,506 B |
| 静态闸门 | `tools/fetch-drawio.ps1 -Verify` | 通过;自检"无可加载外链",白名单 2 条均为不可加载项(`<link rel=canonical>`、mxGraph JSDoc 注释示例) |
| 目录改写 | `templates/index.xml` | 14 条 `<add>` 全部 `Ulibs/…` 相对,0 条 https;全树无 `jgraph.github.io/drawio-libs` |
| 守卫注入 | `index.html` | `offline-guard.js` 为 `<head>` 之后**首个** `<script>`(3,950 B,与共享源同哈希) |
| **端到端(本地化库)** | `index.html?embed=1&proto=json&clibs=Ulibs/integration/azure.xml` | 请求 **200 `/drawio/libs/integration/azure.xml`**,且**无 `/proxy?url=`** —— 走通 `App.start → restoreLibraries → loadTemplate` 全链 |
| **端到端(外链库,反证)** | 同上但 clibs 指向 `https://jgraph.github.io/…` | 被 cors 闸门拒 → 改写为 **`/proxy?url=…` → 404**(本机服务无 /proxy) ⇒ 这正是 `urlParams['cors']` 补丁要避免的失败模式 |
| 守卫(页面级) | 在 drawio 页里试 `fetch('https://example.com/a')`、`Image.src`、`XHR.open+send` | `fetch` 抛 `offline: blocked …`;三类尝试后**非回环 http(s) 请求 = 0**;`window.__diagramonOfflineGuard` 存在 |
| 真机(应用内) | WebView2 进程树连接分类 | 外部连接 **0**(应用主进程自身的更新/云连接不计),画布正常渲染、状态栏无"已拦截外部请求" |

**`?clibs=` 触发路径**(源码行号,v31.4.6,供复跑):`App.js:3604 App.start → App.js:6590 restoreLibraries() → App.js:6607 urlParams['clibs'] → App.js:6677 service=='U' → App.js:6746 loadTemplate('libs/…')`。
UI 等价入口:画布右键 → Insert → Template…(`Menus.js:241-244` → `editorUi.openTemplateDialog`,`App.js:4336`)→ 选带 `clibs` 的模板 → Create → `App.js:5991-6002`。

> 审计脚本：本机临时目录里的 `audit-urls.js`（一次性工具，未入库）—— 按宿主聚合 http(s) 命中并保留上下文，用于人工区分"会被加载"与"注释 / 命名空间 / 纯链接"。升级 drawio / Excalidraw 后应重跑同口径审计。

## 附录 F · 环境备注（与结论无关，但影响复现）


- 本机**火绒（HipsDaemon.exe）会静默删除 `publish1-build.ps1`**：用 `powershell.exe` 打开该文件即被隔离（`git show HEAD:publish1-build.ps1` 的原始副本同样被删）。复现发布校验时用仓库外的一次性副本执行，或在杀软白名单里放行后再跑；该行为与仓库内容无关。
- `powershell.exe` 5.1 在本机 GBK 代码页下会错读无 BOM 的中文脚本，故 `publish1-build.ps1` 与 `fetch-graphviz.ps1` 均以 **UTF-8 BOM** 保存（与既有 `publish2-release.ps1` 一致）。
- Debug 运行不带 `tools/puppeteer-cache`（Chrome for Testing 由发布脚本下载），因此**在 Debug 下 Mermaid 的"保存/复制图片"必然报"缺少渲染组件"** —— 这是既有环境行为，不是本期回归；DOT 的导出不经该路径，Debug 下即可用。
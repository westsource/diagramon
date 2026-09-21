# Tools 目录说明

此目录需要包含 Mermaid CLI 工具才能正常渲染图表。

## 安装步骤

1. 下载 Node.js 便携版 (Portable)
   - 访问 https://nodejs.org/en/download/
   - 下载 Windows Binary (.zip)
   - 解压到此目录，重命名文件夹为 `node`

2. 安装 Mermaid CLI
   ```cmd
   cd tools
   ..\tools\node\npm install @mermaid-js/mermaid-cli
   ```

## 目录结构

安装完成后，目录结构应该是：

```
tools/
├── mmdc.cmd          # Mermaid CLI 启动脚本
├── node/             # Node.js 便携版
│   ├── node.exe
│   └── npm.cmd
├── node_modules/     # Mermaid CLI 及依赖
│   └── @mermaid-js/
│       └── mermaid-cli/
└── puppeteer-cache/  # Chrome for Testing (headless shell)，随发布包内置
    └── chrome-headless-shell/
        └── win64-<版本号>/
            └── chrome-headless-shell-win64/
                └── chrome-headless-shell.exe
```

## Chrome for Testing (puppeteer-cache)

Mermaid CLI 通过 puppeteer 渲染图表，需要 Chrome for Testing 的 headless shell，
版本必须与 `node_modules/puppeteer-core` 固定的版本一致，否则会报
`Could not find Chrome (ver. ...)`。

- 发布时由 `publish1-build.ps1` 自动从 npmmirror 镜像
  （`https://registry.npmmirror.com/-/binary/chrome-for-testing/...`）下载对应版本并解压到本目录，
  失败时回退官方源 `https://storage.googleapis.com/chrome-for-testing-public/...`。
- `mmdc.cmd` 通过 `PUPPETEER_CACHE_DIR` 环境变量指向本目录，发布包无需联网即可渲染。
- 本地开发时若缺失，可手动执行：
  ```cmd
  tools\mmdc.cmd --version   :: 首次会失败
  ```
  或运行 `publish1-build.ps1` 生成。也可以手动下载解压：
  ```cmd
  curl -L -o %TEMP%\shell.zip https://registry.npmmirror.com/-/binary/chrome-for-testing/131.0.6778.204/win64/chrome-headless-shell-win64.zip
  ```
  解压后按上述目录结构放到 `tools\puppeteer-cache\chrome-headless-shell\win64-131.0.6778.204\`。
  版本号以 `node_modules\puppeteer-core\lib\cjs\puppeteer\revisions.js` 中的
  `chrome-headless-shell` 为准。

## Graphviz (DOT) 渲染资源

DOT 格式由 `@hpcc-js/wasm-graphviz`（Graphviz 的 WebAssembly 构建）渲染，
应用运行时通过本地 loopback HTTP 以 `text/javascript` 提供 `graphviz.js` 给 WebView。

- 获取资源（写出 `tools/graphviz/graphviz.js`，同时把 npm 包内的 `LICENSE` 一并复制过来）：
  ```cmd
  powershell -File tools\fetch-graphviz.ps1
  ```
- 只校验已有资源、不下载（校验 graphviz.js 存在、字节数/sha256 与 `.manifest.json` 一致）：
  ```cmd
  powershell -File tools\fetch-graphviz.ps1 -Verify
  ```
- 强制重新下载：`-Force`。不加开关时若资源已与 pin 版本一致，脚本会提示 up-to-date 并跳过下载。
- 版本 pin 文件：`tools/graphviz.version`（单行版本号，如 `1.29.1`）。升级时改这个文件再重跑脚本即可。
  下载优先用内置 `tools\node\npm.cmd`，失败时依次回退到 npmmirror 镜像和 PATH 上的 `npm`。
- `tools/graphviz/` **不入库**（见 `.gitignore`）：它是可再生成的第三方构建产物（单文件 ESM，约 800KB）。
  `publish1-build.ps1` 会在 `dotnet publish` 之前校验它，缺失或 sha256 不匹配时直接报错退出，
  不会产出缺少 DOT 渲染能力的残包。

```text
tools/
├── graphviz.version      # 版本 pin
├── fetch-graphviz.ps1    # 资源获取脚本
└── graphviz/             # 由脚本生成，不入库
    ├── graphviz.js       # npm 包内 package/dist/index.js
    ├── LICENSE           # 上游 Apache-2.0（随包分发需要）
    └── .manifest.json    # 版本 + 字节数 + sha256
```

## drawio (diagrams.net) 离线 webapp 资源

drawio 编辑器以「上游 webapp 的静态拷贝 + 本地 loopback HTTP 服务」的方式内置：
`tools/drawio/index.html` 是入口，宿主页 `tools/drawio/host.html` 以
`index.html?embed=1&proto=json&...` 加载它，用 postMessage 跑 drawio 的 embed 协议。

- 拉取并裁剪（写出 `tools/drawio/`，同时复制上游 `LICENSE` 与 `tools/drawio-host/host.html`）：
  ```cmd
  powershell -File tools\fetch-drawio.ps1
  ```
- 只校验、不下载（校验必需文件、离线补丁标记、清单逐条 bytes/sha256、文件数量一致）：
  ```cmd
  powershell -File tools\fetch-drawio.ps1 -Verify
  ```
  清单里除 `version`/`files` 外还记了一个 `whitelist` 指纹（白名单 + 补丁定义的哈希）：
  改了脚本里的白名单或补丁却没重跑时，`-Verify` 会直接指出「定义已变更」而不是报 up-to-date。
- 强制重新下载：`-Force`。不加开关时若产物与 pin tag 完全一致，脚本提示 up-to-date 并跳过下载；
  若只有 `host.html` 与清单不符（宿主页还在迭代），脚本只重新同步这一个文件并刷新清单，
  不会为了改一行宿主页重下 65 MB 源码包。
- 版本 pin 文件：`tools/drawio.version`（单个 release tag，如 `v31.4.6`）。升级时改这个文件再重跑脚本即可。
  下载来源按顺序回退：`codeload` 的 tar.gz → `codeload` 的 zip → `ghproxy.net` → `gh-proxy.com` →
  `git clone --depth 1 --branch <tag>`（gitclone.com / github.com），每条来源限时 300 秒。
- `tools/drawio/` **不入库**（见 `.gitignore`）：v31.4.6 裁剪后为 2906 个文件、58,916,841 字节（约 56 MB）。
  `publish1-build.ps1` 会在 `dotnet publish` 之前校验它（`index.html` 与 `.manifest.json` 一致、
  最小闭环文件齐全、清单版本与 `tools/drawio.version` 一致），缺失或不匹配时直接报错退出。

### 裁剪白名单与体积

上游 `src/main/webapp` 全量 3412 个文件 / 154,199,910 字节（147 MB），裁剪后 61.8% 的体积被去掉。
**白名单与「为什么必需」的逐条理由写在 `tools/fetch-drawio.ps1` 头部注释里**，改白名单时同步改注释。
两个关键判断：

- 上游的 `stencils/`（43 MB）与 `shapes/`（2.4 MB）整目录**不需要**：它们的内容已经编译进
  `js/stencils.min.js` 与 `js/shapes-14-6-5.min.js`（`etc/build/build.xml` 的 `merge` 目标），
  而 `js/diagramly/App.js:1368` 在生产路径下会 `App.loadScripts(['js/shapes-14-6-5.min.js',
  'js/stencils.min.js', 'js/extensions.min.js'])` 懒加载这三个 bundle。
- `js/integrate.min.js`（21.5 MB）**不需要**：那是给第三方产品做嵌入用的自包含包
  （`etc/build/build.xml` 的 `integrate` 目标 = atlas + shapes + stencils + `etc/integrate/Integrate.js`）。
  `index.html` 的加载链（`js/bootstrap.js` → `js/app.min.js` → `js/PostConfig.js`）不引用它，
  对 `index.html`/`bootstrap.js`/`main.js`/`PostConfig.js`/`app.min.js` 做 `grep -c 'integrate\.min'`
  全部为 0。

### 离线补丁（`js/PreConfig.js`）

脚本在复制完 `src/main/webapp/js/PreConfig.js` 之后、写清单之前，会**幂等**地追加一段补丁
（已包含的行不重复追加，补丁后的文件内容进清单哈希，所以补丁丢了 `-Verify` 会发现）。
补丁落点选 PreConfig 是因为它在 `js/bootstrap.js:381` 被动态加载、且早于 `app.min.js`，
是上游自己改全局变量/`urlParams` 的官方位置（上游在里面就写了 `urlParams['sync'] = 'manual'`）。

| 追加内容 | 作用 | 上游依据 |
|---|---|---|
| `window.EXPORT_URL = null;` | 导出全部走浏览器端渲染，不请求 `convert.diagrams.net` 导出服务 | `js/PreConfig.js:5`（上游默认就是 null，脚本只做「确保存在」）；`js/diagramly/Init.js:37` 只在未定义时才回退到远端导出服务 |
| `urlParams['gapi'] = '0';` | 禁 Google Drive 连接器 | `js/diagramly/App.js:1066-1072`：非 embed 且 `gapi != '0'` 时会 `mxscript('https://apis.google.com/js/api.js?...')` |
| `urlParams['math'] = '0';` | 关异步数学渲染（MathJax） | `js/diagramly/App.js:1082` 的 `if (urlParams['math'] != '0') Editor.initMath();` → `js/diagramly/Editor.js:4634` 取 `DRAW_MATH_URL + '/startup.js'` |
| `urlParams['cors'] = '^(?:libs\|img\|templates\|js\|styles\|resources\|math4\|mxgraph)/';` | 让**同源相对路径**绕开不存在的 `PROXY_URL` | `js/diagramly/Editor.js:5118-5125` `isCorsEnabledForUrl` 对相对路径判定为 false，于是 `App.prototype.loadTemplate`（`App.js:5542-5556`）会把在线图形库改写成 `PROXY_URL+'?url=…'`，而本机没有 `/proxy` 端点。`?cors=` 是上游自己的开关（源码注释：Blocked by CSP in production but allowed for hosted deployment） |

这四条写在 PreConfig 里即「硬编码」，URL 参数覆盖不了。要恢复数学渲染，删掉第三条并保留 `math4/`。

### 外链本地化与离线守卫（"该打包的打包 + 该拦的拦"）

drawio 里"活文档式"的第三方端点随上游版本增删，靠逐个关配置不可能穷尽，所以这里做两层：

**① 离线守卫（拦）**：`tools/offline-guard/offline-guard.js`（入库的共享资产，内容不由本脚本生成）
被复制为 `tools/drawio/offline-guard.js`，并注入到 `tools/drawio/index.html` 的 `<head>` 之后、
**任何应用脚本之前**：

```html
<head>
<script src="./offline-guard.js"></script>
    <title>Flowchart Maker &amp; Online Diagram Software</title>
```

为什么必须注入 drawio 自己的页面：drawio 跑在 iframe 里，`fetch`/`XHR`/`Image` 用的是 iframe 自己的
realm，宿主页 `host.html` 的 prototype 补丁管不到它。守卫把非本机 origin 的
`fetch`/`XHR.open+send`/`Image.src`/`sendBeacon` 一律拒绝，并把每次拦截入队一条
`{"event":"external-blocked", …}` 供宿主显示到状态栏。注入是幂等的，且脚本会断言它确实是
`index.html` 里 `<head>` 之后的第一个 `<script>`。

**② 外链本地化（打包）**：脚本在写清单之前做四件事，每件都带"替换数断言"，上游一改就报错退出：

| 处理 | 数量（v31.4.6 实测） | 落点 | 上游依据 |
|---|---|---|---|
| 在线图形库 → 相对路径。两种上游写法都处理：`<clibs><add>Uhttps://jgraph.github.io/drawio-libs/…</add>`（41 条）与 `<template … clibs="Uhttps%3A%2F%2Fjgraph.github.io%2Fdrawio-libs%2F…"/>`（3 条，属性值是百分号编码） | 44 条引用中 **17 条**下载成功（9.60 MB，17 个文件），**27 条上游本身 404** 直接删条目/清空属性 | `tools/drawio/libs/**`（14 个 `libs/integration/*.xml` + `libs/{arista,flat-color-icons,delivery-icons}.xml`） | 解析链：`Dialogs.js:3897-3913` 读 `<clibs>`/`<add>`、`:3919` 读 `clibs` 属性 → `App.js:5918` 拼 `?clibs=` → `App.js:6607` → `loadLibraries` 的 `service=='U'` 分支 `App.js:6745-6749` → `loadTemplate` |
| 会被加载的外部图片 → 相对路径。上下文包括 `image=` 样式、`src=`/`srcset=`、css `url(…)`、**`"data":"<url>"` 的 mxlibrary 图片条目**（`Sidebar.js:1908` 把 `img.data` 直接拼成 `image=<data>`），以及按宿主兜底的 iconfinder（它还出现在 Org Chart 的 CSV 示例数据列与形状默认 `ImageUrl` 里） | **32 条**引用、20 个文件（3.71 MB；其中 4 个是 `libs/arista.xml` 引用的机箱 SVG，单个最大 1.8 MB） | `tools/drawio/img/external/<basename>-<8位sha256>.<ext>` | 命中文件：`templates/basic/mindmap.xml`、`js/extensions.min.js`、`js/mermaid/drawio-mermaid.min.js`、`js/app.min.js`、`libs/arista.xml` |
| OneDrive 选择器的 `https://p.sfx.ms/…spinner.gif` → 随包 `images/ajax-loader.gif` | 2 条 | 复用已有本地文件 | `js/onedrive/OneDrive.js`、`OneDriveOrig.js` 各 1 处 |
| 第三方 SDK/接口/图标前缀字面量 → 同源占位 `js/no-network.js`（图标前缀改指同源空目录） | 4 条：gapi ×2、Drive userinfo ×1、Gliffy 的 coreui 图标前缀 ×1 | 生成 `tools/drawio/js/no-network.js`；Gliffy 前缀 → `img/external/coreui-brand/` | `App.js:1066-1072`、`location.hash` 以 `#G` 开头的分支、`DriveClient` 的用户信息 XHR、`js/gliffy/drawio-gliffy.min.js` 的 `ci` 常量 |
| `Editor.GOOGLE_FONTS` / `GOOGLE_FONTS_CSS2` → 同源惰性前缀 `#diagramon-fonts-disabled:` | 2 个常量 | 改 `js/app.min.js` 字面量 | `Editor.js:4139`/`:4144` 定义、`Editor.js:8758` 前缀比较 |

> 为什么 Google Fonts 不是"置空串"：这两个常量参与 `Graph.isGoogleFontUrl` 的前缀比较
> （`url.substring(0, Editor.GOOGLE_FONTS.length) == Editor.GOOGLE_FONTS`）。置空后 `substring(0,0)===''`
> 恒真，**任何**字体 URL（包括图里自带的相对字体路径）都会被当成 Google 字体并被改写成
> `<空>…:wght@400;500` 的 `<link>`，反而弄坏本地字体。换成同源惰性前缀后：图里自带的相对字体仍走
> `@font-face` 本地加载，外部 Google 字体 URL 既不匹配前缀（不再被"Google 化"），只会作为普通外链被守卫拦下。

**③ 静态自检（回归闸门）**：`-Verify` 与拉取流程都会扫一遍 `tools/drawio/` 的文本文件
（`.js/.css/.html/.xml/.txt/.json/.svg/.map`，2200 个），按"会被加载"的模式匹配外链：

```
image= 样式 / src=、srcset= / xlink:href= / <link href= / css url(…) /
mxscript|importScripts|sendBeacon|loadUrl|loadScript(…) / fetch|XHR.open(…,"http…") / <add>U…
```

命中且不在白名单里就**报错退出**。当前白名单只有 2 条，逐条给理由：
`index.html` 的 `<link rel="canonical">`（SEO 元数据，不加载）与
`mxgraph/src/view/mxGraph.js` 里 JSDoc 注释示例 `image=http://www.example.com/image.gif`
（`?dev=1` 才加载的开发源码）。升级 drawio 后若自检报出新条目，处理顺序是：
能下载的本地化 → 不能随包的写成同源占位 → 确实无害的才加进白名单并写明理由。

```bash
# 自检等价的手工复核（按宿主分类统计，应当只剩命名空间/注释/纯链接）
grep -rIo "https\?://[^\"'<> )]*" tools/drawio --exclude=.manifest.json | cut -d: -f1 | sort | uniq -c | sort -rn | head -20
grep -rIho "https\?://[a-zA-Z0-9._-]*" tools/drawio --exclude=.manifest.json | sed 's|https\?://||' | sort | uniq -c | sort -rn | head -30
```

本地化之后残留的 `https?://` 字面量按宿主分类，全部**不是加载路径**：

| 宿主 | 出处 | 为什么无害 |
|---|---|---|
| `www.w3.org`(3164)、`purl.org`(725)、`www.inkscape.org`(503)、`sodipodi.sourceforge.net`(501)、`creativecommons.org`(398)、`vecta.io`(34) | `img/lib/**.svg`、`math4/**` 的 `xmlns` 与 `<metadata>` | XML 命名空间/署名，浏览器不会请求 |
| `www.drawio.com`(118)、`github.com`(80)、`www.apache.org` | 文档链接、许可证正文、`<a href>` 生成字符串 | 纯导航链接（`openLink`），离线点不动而已 |
| `app.diagrams.net`(13)、`www.draw.io`(7)、`jgraph.github.io`(2) | `index.html` 的 `<link rel="canonical">`、`DRAWIO_BASE_URL` 回退值、域名判断（含 `"jgraph.github.io"==window.location.hostname`）、迁移 iframe（要求 `location.host=='app.diagrams.net' && forceMigration=1`） | 元数据或不可达分支 |
| `drive.google.com`、`www.googleapis.com`、`graph.microsoft.com`、`login.microsoftonline.com`、`onedrive.live.com`、`www.dropbox.com` | 云盘连接器的 API 端点常量 | gapi 已关（`gapi=0` + 字面量中性化）；真被触发也会被守卫拦下 |
| `www.example.com`(9) | `mxgraph/src/view/mxGraph.js` 的 JSDoc 注释（2 处）+ 示例数据 | 注释/示例，非加载路径 |
| `fonts.googleapis.com`(6) | `Graph.fontMapping` 的内联映射键、字体选择对话框列表、Electron 的 CSP 字符串 | 常量已改本地；残留只是查表用的字符串 |

其它守卫：`styles/*.css` **零外部引用**（连 `url(...)` 都没有，图标全是内联 data URI；草图字体走本地
`styles/fonts/ArchitectsDaughter-Regular.ttf`）；`VSS_CONVERT_URL`（`EditorUi.js:11614`）有
`!this.isOffline()` 守卫；`DRAWIO_BASE_URL/VIEWER_URL/LIGHTBOX_URL` 只用于生成嵌入 HTML 字符串
（`EditorUi.js:2707`、`8906`）；`service-worker.js`/`workbox-*.js` 已裁掉，且本地 host 下不会注册 SW
（`Editor.js:209` 要求 `offline=1`/`enableSW=1` 或 `*.draw.io`/`*.diagrams.net` 域名）。

### embed 协议要点（上游源码核实，写桥接层时用）

- 入口参数：`index.html?embed=1&proto=json&...`（`embed=1` 进 embed 模式、`proto=json`
  把事件换成 JSON；两者分别判在 `js/diagramly/EditorUi.js:22682` 与 `:23813`/`:25308`）。
- `parent != window` 判定：`js/diagramly/EditorUi.js:22687`（`EditorUi.initializeEmbedMode`，
  取 `this.embedMessageSource || window.opener || window.parent`）与
  `js/diagramly/App.js:3782`（`App` 的 `urlParams['data']`/`['create']` 加载路径）。
- 编辑器 → 宿主：`{event:'init'}`（`EditorUi.js:25308`，宿主据此回 `{action:'load'}`）、
  `{event:'load'|'autosave'|'save'|'export'|'exit'|'draft'|'fit'|'viewbox'|'template'|...}`
  （公共字段由 `EditorUi.js:22915 createLoadMessage` 提供：`pageVisible/translate/bounds/currentPage/
  scale/page/modelBounds/containerSize`；`load` 额外带 `xml`、`checksum`）。
- 宿主 → 编辑器：`{action:'load'}`（字段 `xml/autosave/diffSync/exportProtocol/title/modified/
  scale/fit/viewbox/border/theme/background/saveAndExit/noSaveBtn` 等，见 `EditorUi.js:24560` 起）、
  `{action:'export'}`（`format: 'png'|'xmlpng'|<其他>`、`xml/scale/border/embedImages/embedFonts/withSvg`，
  见 `EditorUi.js:24175` 起）、`{action:'autosave'}`、`{action:'save'}`、`{action:'merge'|'insert'|'layout'|
  'dialog'|'prompt'|'status'|'spinner'|'snapshot'|'viewport'|'resetEditor'|'fit'}`。
- `autosave` 事件由 `{action:'load', autosave:1}` 打开，之后编辑器内容变化即推送
  `{event:'autosave', xml, ...}`（`EditorUi.js:25151` 起）。

```text
tools/
├── drawio.version        # 版本 pin（单个 release tag，如 v31.4.6）
├── fetch-drawio.ps1      # 拉取 + 裁剪 + 离线补丁 + 清单脚本
├── drawio-host/
│   └── host.html         # 宿主页（父级/桥接层资产，脚本只负责复制）
└── drawio/               # 由脚本生成，不入库
    ├── index.html        # drawio 编辑器入口（embed 模式）；<head> 后已注入离线守卫
    ├── offline-guard.js  # 由 tools/offline-guard/offline-guard.js 复制（不改内容）
    ├── host.html         # 由 tools/drawio-host/host.html 复制
    ├── js/               # bootstrap.js / main.js / PreConfig.js / PostConfig.js / app.min.js / *.min.js
    │                     #   no-network.js = 生成的同源占位脚本（中性化掉 3 处第三方 SDK/接口字面量）
    ├── libs/             # 在线图形库本地化（libs/integration/*.xml，14 个）
    ├── img/external/     # 会被加载的外部图片本地化（11 个）
    ├── styles/ images/ img/ resources/ templates/ mxgraph/ math4/
    ├── LICENSE           # 上游 Apache-2.0
    └── .manifest.json    # {version, whitelist, files:[{path, bytes, sha256}]}
```

## Excalidraw 离线 bundle 资源

Excalidraw 是**库型集成**（不走 iframe、不走 postMessage）：承载页 `tools/excalidraw-host/index.html`
以普通 `<script src="./app.js">` 加载产物，由页面的 JS 直接调 `window.ExcalidrawApp` 的接口，
C# 侧通过页面暴露的 `window.__apply` 下发指令（形状与 drawio 那条通道一致）。

- 构建（写出 `tools/excalidraw/`，含 CSS/字体/许可证与清单）：
  ```cmd
  powershell -NoProfile -File tools\fetch-excalidraw.ps1
  ```
- 只校验、不构建（必需文件与字体族目录、清单逐条 bytes/sha256、文件数一致、
  bundle/CSS 引用到的每个字体文件都在磁盘上、清单 pin 指纹与 `tools/excalidraw.version` 一致）：
  ```cmd
  powershell -NoProfile -File tools\fetch-excalidraw.ps1 -Verify
  ```
- 强制重新构建：`-Force`。不加开关时若产物与 pin 完全一致，脚本提示 up-to-date 并**跳过构建**
  （不会连 npm install，约 6 秒返回）；若只有 `index.html` 与 `tools/excalidraw-host/index.html`
  不同步（承载页还在迭代），则只重新同步这一个文件并刷新清单哈希，同样不跑 npm install。
- 版本 pin 文件：`tools/excalidraw.version`（多行 `key=版本号`，见文件内注释）。升级时改对应行再重跑脚本。
  清单里记了一个 `pin` 指纹（pin 文件内容去掉注释/空行、排序后拼接），`-Verify` 和
  `publish1-build.ps1` 都会比对它 —— 改了 pin 文件却忘了重跑，会被当场点出来。
- 依赖获取顺序：内置 `tools\node\npm.cmd` → PATH 上的 `npm`；registry 先默认源、失败回退
  `registry.npmmirror.com`。脚本会打印实际用了哪个 npm / registry / node。
  临时目录与 npm 缓存都建在 `%TEMP%\diagramon-excalidraw-<guid>\` 下，结束后整棵删除。
  注：只有**直接依赖**被 pin 住，`npm install` 不带 lockfile，所以上游发布新的传递依赖版本时，
  重跑可能得到不同字节数的 bundle。产物不入库、以 `.manifest.json` 的哈希为准，
  换机器构建后跑一次 `-Verify` 即可确认手上这份是不是当前 pin 的产物。

### 为什么必须自己打包

`@excalidraw/excalidraw` 只发**纯 ESM**：`package.json` 的 `exports` 只有 `import` 条件、
`dist/prod/index.js` 全是 `import{…}from`，没有 UMD/IIFE，`<script>` 直接引它必炸。
所以脚本在临时目录里装上 pin 住的包，用 `esbuild` 打成两份经典脚本（IIFE）：

```text
node <tmp>\node_modules\esbuild\bin\esbuild <tmp>\src\entry.jsx --bundle --format=iife --target=chrome120
  --global-name=ExcalidrawApp --jsx=automatic --minify --legal-comments=none
  --define:process.env.NODE_ENV="production"
  --alias:@excalidraw/mermaid-to-excalidraw=<tmp>\src\m2e-shim.js
  --outfile=<tmp>\out\app.js

node <tmp>\node_modules\esbuild\bin\esbuild <tmp>\src\mermaid-global.js --bundle --format=iife --target=chrome120
  --jsx=automatic --minify --legal-comments=none
  --define:process.env.NODE_ENV="production"
  --outfile=<tmp>\out\mermaid.js
```

三个容易踩的点（脚本里有对应的产物自检，失败即报错退出）：

- `--define:process.env.NODE_ENV='"production"'` 经 PowerShell 5.1 传参时引号会被吞掉，必须写成
  `--define:process.env.NODE_ENV=\"production\"`，否则打进的是 React **开发版**（体积大 350 KB 且带警告）。
- 入口必须用 `export` 声明接口：`--global-name` 的返回值会覆盖 `window.ExcalidrawApp`，
  自己再赋值一次会被 IIFE 返回的空对象盖掉（承载页会报「缺少 window.ExcalidrawApp.mount`」）。
- `--alias:@excalidraw/mermaid-to-excalidraw=<m2e-shim.js>`：Excalidraw 库内部静态引用了这个包，
  不 alias 的话 mermaid（3.5 MB）会一起进主 bundle。`mermaid.js` 单独打、首次调 `convertMermaid` 时才拉。

入口源码（含 `mount` / `exportPng` / `convertMermaid` / `ready` 四个接口）**内嵌在
`tools/fetch-excalidraw.ps1` 的 here-string 里**（临时目录用，不入库），改完用 `-Force` 重跑。

### 产物体积（pin：excalidraw 0.18.1 / mermaid-to-excalidraw 2.2.2 / mermaid 11.17.2 / react 18.3.1 / esbuild 0.28.2）

```text
tools/excalidraw/           242 个文件 / 约 20.6 MB（index.html 的大小随承载页浮动）
├── app.js                  4,874,556   Excalidraw 组件 + 契约接口（全局 ExcalidrawApp）
├── mermaid.js              3,503,665   Mermaid -> Excalidraw 转换器（全局 ExcalidrawMermaid，懒加载）
├── index.css                 144,689   dist/prod/index.css 原样复制
├── index.html                ~8.7 KB   由 tools/excalidraw-host/index.html 复制（内容以承载页为准）
├── fonts/                234 个 / 13,107,068
├── licenses/              4 个 / 4,328   mermaid / mermaid-to-excalidraw / react / react-dom
└── .manifest.json                       {version, pin, licenses, files:[{path, bytes, sha256}]}
```

字体是 `dist/prod/fonts` 全量：`Xiaolai`（中文手写体）209 个子集文件占大头，
其余是 Excalifont/Nunito/ComicShanns/Lilita/Virgil/Cascadia/Liberation/Assistant（`index.css` 引 4 个 Assistant）。
**没有可裁余量**：bundle 与 CSS 里的 `fonts/**.woff2` 引用共 234 个，与磁盘上的 234 个文件一一对应
（`-Verify` 会逐个核对存在性）。`dist/prod` 里的 `subset-shared.chunk.js` / `subset-worker.chunk.js` /
`chunk-*.js` / `data/*.js` 都只是 ESM 内部 chunk，已被 esbuild 内联进 `app.js`，不需要单独分发。

**`dist/prod/locales/`（55 个文件 / 1,648,766 字节）没有复制**：excalidraw 只在组件收到 `langCode`
（或调用 `setLanguage`）时才按 `locales/<code>.json` 取语言包，承载页不设语言、界面走内置英文，
实测离线运行期间零 locale 请求（也零外部请求）。将来要在画布里切界面语言，把 `locales/` 一并复制、
再给承载页传 `langCode` 即可。

### 离线安全

- **`window.EXCALIDRAW_ASSET_PATH` 必须由承载页在加载 `app.js` 之前设成本页目录**
  （`tools/excalidraw-host/index.html` 里已设）：它是 Excalidraw 解析字体路径的基址，
  不设时库会回退到 CDN（`https://esm.sh/@excalidraw/excalidraw@0.18.1/dist/prod/…`）。
  实测该变量生效后，字体请求全部命中本地 `./fonts/…`。
- 实测（Chromium，承载页 `index.html` + 本地 loopback 静态服务，跑通 mount → setScene →
  convertMermaid → exportPng）：**产物发出的外部请求为 0**，请求只有本地 `app.js`/`mermaid.js`/`index.css`/`fonts/**`。
- 产物里的 `https?://` 字面量共 134 条（`app.js` 66、`mermaid.js` 66、`index.css` 2），全部是
  **不会发起的字符串**：`www.w3.org` 的 SVG/XML `xmlns`、帮助/文档/社交链接（`youtube`/`vimeo`/`github`/
  `mermaid.js.org` 等 UI 文案）、协作服务地址（`oss-collab.excalidraw.com` 等，本应用不启用协作）、
  mermaid 依赖 chevrotain/langium 的文档链接，以及 1 条 `esm.sh`（Excalidraw 的字体**回退基址**，
  只在本地字体取不到时才会被请求）。核对命令：
  ```bash
  grep -rIoh "https\?://[^\"'<> )]*" tools/excalidraw --exclude=.manifest.json | sed 's|https\?://||' | cut -d/ -f1 | sort | uniq -c | sort -rn
  ```

### 发布校验

`publish1-build.ps1` 在 `dotnet publish` 之前校验 `tools/excalidraw/`：`app.js` 存在且
字节数/sha256 与 `.manifest.json` 一致、清单 `pin` 指纹与 `tools/excalidraw.version` 一致、
最小闭环文件（`mermaid.js`/`index.css`/`index.html`/字体/许可证）齐全，任一不满足 `exit 1`，
提示重跑 `tools\fetch-excalidraw.ps1`。`tools/excalidraw/` **不入库**（见 `.gitignore`），
但 `tools/excalidraw-host/`（承载页）是仓库资产，不在这条忽略规则里。

```text
tools/
├── excalidraw.version    # 版本 pin（多行 key=版本号）
├── fetch-excalidraw.ps1  # npm install + esbuild 打包 + 复制 CSS/字体 + 清单脚本
├── excalidraw-host/
│   └── index.html        # 承载页（父级/桥接层资产，脚本只负责复制）
└── excalidraw/           # 由脚本生成，不入库
    ├── app.js mermaid.js index.css index.html
    ├── fonts/ Assistant|Cascadia|ComicShanns|Excalifont|Liberation|Lilita|Nunito|Virgil|Xiaolai
    ├── licenses/         # 上游 MIT 许可证（Excalidraw 的 npm 包不带 LICENSE，见仓库根 NOTICE）
    └── .manifest.json    # {version, pin, licenses, files:[{path, bytes, sha256}]}
```

## 测试

运行以下命令测试是否安装成功：

```cmd
tools\mmdc.cmd --version
```

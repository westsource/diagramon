param(
    [switch]$Verify,
    [switch]$Force
)

# ========== 编码处理（与 tools/fetch-graphviz.ps1 / publish1-build.ps1 一致） ==========
$null = chcp 65001
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
[Console]::InputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8

<#
.SYNOPSIS
    拉取并裁剪 jgraph/drawio 的 webapp 资源，产出可离线运行的 tools/drawio/。

.DESCRIPTION
    1. 读取版本 pin 文件 tools/drawio.version（单个 release tag，如 v31.4.6）。
    2. 下载该 tag 的源码包（codeload tar.gz → zip → ghproxy.net → gh-proxy.com → git 浅克隆）到临时目录，
       解包后只取 src/main/webapp。
    3. 先统计上游 src/main/webapp 全量体积/文件数，再按下方白名单裁剪到 tools/drawio/。
    4. 对已复制的 js/PreConfig.js 追加「离线补丁」（幂等，见 Invoke-OfflinePatch）。
    5. 外链本地化 / 离线化（都是「改上游文件 + 断言」，见对应函数注释）：
       - 复制 tools/offline-guard/offline-guard.js 并在 index.html 的 <head> 之后注入 <script>（最先加载）；
       - templates 里的在线图形库清单（jgraph.github.io/drawio-libs）下载到 libs/ 并改写成相对路径；
       - 会被加载的外部图片（iconfinder / p.sfx.ms 等）下载到 img/external/ 并改写成相对路径；
       - 无法随包的第三方 SDK/接口字面量（apis.google.com、www.googleapis.com）改写为同源占位 js/no-network.js；
       - Editor.GOOGLE_FONTS / GOOGLE_FONTS_CSS2 指向同源惰性前缀。
    6. 最小闭环自检：缺少任一必需文件、或离线守卫没落在 index.html 首个 <script>，就报错退出。
    7. 静态自检：扫全部文本文件，命中"会被加载"的外链且不在白名单内就报错退出（升级 drawio 时的回归闸门）。
    8. 写 tools/drawio/.manifest.json（{version, whitelist, files:[{path, bytes, sha256}]}），
       并从上游仓库根目录复制 LICENSE（Apache-2.0）。
    9. tools/drawio-host/host.html 存在时复制为 tools/drawio/host.html 并记入清单
       （本脚本不生成、也不修改该文件的内容，它是父级/桥接层负责的资产）。

    -Verify : 只校验已有产物（必需文件、离线补丁标记、离线守卫注入位置、静态自检、
              清单逐条 bytes/sha256、反向文件数）。
    -Force  : 忽略「已是最新」判断，强制重新下载。
    不加开关时：产物与 pin tag 完全一致则打印 up-to-date 并跳过下载；
    若只有 host.html 与清单不符（宿主页被改过），则只重新同步该文件并刷新清单，不重下源码包。

    升级流程：改 tools/drawio.version 里那一行 tag 再重跑本脚本。
    最新 tag 可用 GitHub API 获取：
        https://api.github.com/repos/jgraph/drawio/releases/latest
    升级后如果静态自检报出新的可加载外链，处理顺序是：能下载的本地化（libs/ 或 img/external/），
    不能随包的写进 $LiteralNeutralizations（同源占位），确实无害的才写进 $LoadScanAllowList（逐条给理由）。
#>

# ========== 路径与常量 ==========
$ToolsPath = $PSScriptRoot
$VersionFile = Join-Path $ToolsPath "drawio.version"
$DrawioDir = Join-Path $ToolsPath "drawio"
$ManifestFile = Join-Path $DrawioDir ".manifest.json"
$LicenseFile = Join-Path $DrawioDir "LICENSE"
$PreConfigFile = Join-Path $DrawioDir "js\PreConfig.js"
$HostSource = Join-Path $ToolsPath "drawio-host\host.html"
$HostDest = Join-Path $DrawioDir "host.html"

$Repository = "jgraph/drawio"
$WebappRoot = "src/main/webapp"
$UpstreamLicense = "LICENSE"

# ==========================================================================
# 最终白名单（裁剪基准：能离线跑通 index.html 的 embed 模式）
# --------------------------------------------------------------------------
# 结论来自对 v31.4.6 上游源码的核对，逐条列出「为什么必需」：
#
# [整目录]
#   styles    index.html 直接引 styles/grapheditor.css（:41）与 styles/high-contrast.css（:42）；
#             另含 styles/{default,default-old,dark-default}.xml（开发模式的样式表）与
#             styles/fonts/ArchitectsDaughter-Regular.ttf（草图模式字体）。CSS 内零外链。
#   images    index.html 引 images/{browserconfig.xml,manifest.json,apple-touch-icon.png,spin.gif}；
#             其余 sidebar-*.png 等是侧边栏形状库的预览图（app.min.js 按名引用）。
#   img       app.min.js 内硬编码 702 条 img/... 字面路径（Clipart/图标库，GRAPH_IMAGE_PATH 默认 'img'），
#             缺整个目录会让这些条目 404。6.8MB，保留。
#   resources 语言包 resources/dia*.txt（59 个），由 App.doLoad -> mxResources 按语言 XHR 读取。
#   templates TEMPLATE_PATH='templates'，新建图对话框的模板库。
#   mxgraph   app.min.js 引 mxgraph/css/common.css 与 mxgraph/images/*（运行时真实加载）；
#             mxgraph/src + mxgraph/mxClient.js 供 ?dev=1 调试（生产路径走 app.min.js）。
#   math4     DRAW_MATH_URL='math4/es5'（PreConfig.js:11、Init.js:39）→ 数学渲染用本地 MathJax。
#             离线补丁把 math 关掉后本目录当前不会被请求，保留是为了「随时能打开数学渲染」；
#             若确认永不需要数学渲染，可把本项从白名单去掉（省约 3.3MB）。
#   js/elk, js/mermaid
#             白名单要求保留（?dev=1 与 loadMermaid 的 dev 分支用，EditorUi.js:13147/13149）；
#             生产非 dev 路径由 extensions.min.js 承载 ELK+mermaid（EditorUi.js:13156）。
#   js/plantuml
#             PlantUML 转换器，独立于 extensions.min.js，按需加载（EditorUi.js:13207）。
#   js/gliffy Gliffy 导入转换器，按需加载（EditorUi.js:13276）。
#   js/orgchart
#             组织结构图布局，按需加载（EditorUi.js:12057）。
#   js/jquery / js/dropbox / js/onedrive / js/simplepeer
#             App.js:287/267/277/307 里登记的按需脚本 URL（Trello/Dropbox/OneDrive/实时协作），
#             合计约 0.3MB，保留以免这些分支直接 404。
#
# [显式文件]
#   index.html               应用入口（embed 模式查询参数都打在这个 URL 上）
#   favicon.ico              index.html:20/21 引用
#   js/bootstrap.js          index.html:42 加载；定义 urlParams/mxscript，并决定加载哪个 bundle
#   js/main.js               index.html:67 加载；window.onload 后调 App.main()
#   js/PreConfig.js          bootstrap.js:381 在加载 app.min.js 之前加载（离线补丁落点）
#   js/PostConfig.js         bootstrap.js:374 在 app.min.js 之后加载（清空 ICONSEARCH/ICON_SERVICE）
#   js/app.min.js            bootstrap.js:332 的主 bundle（diagramly 全量 + graph editor）
#   js/shapes-14-6-5.min.js  \
#   js/stencils.min.js        > App.js:1368 在非 dev/非 Electron 路径下 App.loadScripts([...]) 懒加载，
#   js/extensions.min.js     /  分别提供形状定义、模具定义、ELK+mermaid+jszip+orgchart+libavoid。
#                            正因为有这三个 bundle，上游的 shapes/ stencils/ 整目录（46MB）才不需要。
#
# [显式排除，附证据]
#   js/integrate.min.js       §8.1 项 4 初稿要求保留，但实测零引用，本应用用不到：
#                             grep -c 'integrate\.min' 在 index.html / js/bootstrap.js / js/main.js /
#                             js/PostConfig.js / js/app.min.js 全部为 0（app.min.js 里 20 处
#                             "integrate" 命中全是形状名/标签，如 "integrated electronics"）。
#                             index.html 的加载链由 bootstrap.js:381(PreConfig) -> :332(app.min.js) ->
#                             :374(PostConfig) 组成；integrate.min.js 是 etc/build/build.xml:675-694
#                             产出的「给第三方产品做嵌入」的自包含包（= atlas + shapes + stencils +
#                             etc/integrate/Integrate.js），走 host.html 路线只有 app.min.js 被用到。
#                             （整个上游仓库里提到它的只有 etc/build/build.xml 与 js/libavoid-js/README.md。）
#                             移除后省 22,590,972 字节（约 21.5 MiB）。
#   stencils/ shapes/         内容已编译进 stencils.min.js / shapes-14-6-5.min.js（etc/build/build.xml:63-87）。
#   js/diagramly, js/grapheditor
#                             ?dev=1 的源码目录，生产由 app.min.js 承载。
#   js/cryptojs, js/deflate, js/rough, js/freehand, js/spin, js/sanitizer
#                             已在构建期拼接进 app.min.js（etc/build/build.xml:432-437）。
#   js/jszip, js/libavoid-js  已拼接进 extensions.min.js（etc/build/build.xml:498-505）。
#   js/viewer*.min.js, js/embed.dev.js, js/export*.js, js/math-print.js, js/open.js, js/clear.js,
#   js/vsdxImporter.js, js/orgchart.min.js, service-worker*.js, workbox-*.js, *.map
#                             其它入口（独立 viewer/导出服务/离线 PWA）专用，embed 路线不加载；
#                             service-worker 在本地 host 下本来也不会注册（Editor.js:209 要求
#                             *.diagrams.net / *.draw.io 域名或 offline=1）。
#   stencils/ plugins/ WEB-INF/ META-INF/ connect/ *.html(除 index)
#                             服务端部署、插件市场、外部连接器页面，离线 embed 不需要。
# ==========================================================================
$IncludeDirs = @(
    'styles',
    'images',
    'img',
    'resources',
    'templates',
    'mxgraph',
    'math4',
    'js/elk',
    'js/mermaid',
    'js/plantuml',
    'js/gliffy',
    'js/orgchart',
    'js/jquery',
    'js/dropbox',
    'js/onedrive',
    'js/simplepeer'
)

$IncludeFiles = @(
    'index.html',
    'favicon.ico',
    'js/bootstrap.js',
    'js/main.js',
    'js/PreConfig.js',
    'js/PostConfig.js',
    'js/app.min.js',
    'js/shapes-14-6-5.min.js',
    'js/stencils.min.js',
    'js/extensions.min.js'
)

# 最小闭环自检：这些文件缺任何一个，离线 embed 必然跑不起来。
# 上游改目录结构时这里会当场报错，而不是等到真机上一片空白。
$RequiredFiles = @(
    'index.html',
    'js/main.js',
    'js/PreConfig.js',
    'js/PostConfig.js',
    'js/bootstrap.js',
    'js/app.min.js',
    'js/shapes-14-6-5.min.js',
    'js/stencils.min.js',
    'js/extensions.min.js',
    'styles/grapheditor.css',
    'mxgraph/css/common.css',
    'resources/dia.txt',
    'math4/es5/startup.js'
)

# ==========================================================================
# 外链本地化 / 离线化（"该打包的打包 + 该拦的拦"里的"打包"部分）
# --------------------------------------------------------------------------
# 审计结论：裁剪后的产物里"真会联网"的引用只有三类（其余都是注释/许可证/XML 命名空间/纯 <a href> 链接）：
#   ① templates/index.xml 里 41 条 <clibs><add>Uhttps://jgraph.github.io/drawio-libs/libs/….xml</add>
#      —— drawio 的"附加图形库"清单，用户展开那些库分类时会被真实 XHR 拉取
#         （解析：js/diagramly/Dialogs.js:3897-3913 读 <clibs>/<add>，App.js:5918 拼 ?clibs=，
#          App.js:6607 进 loadLibraries，App.js:6745-6749 命中 service=='U' → App.prototype.loadTemplate(url)）。
#   ② 24 处 image=https://cdn{1,2,3}.iconfinder.com/…（模板 + extensions.min.js/mermaid 里的形状定义）
#      与 2 处 OneDrive 的 https://p.sfx.ms/…spinner.gif —— 都是 img/src 真加载。
#   ③ js/app.min.js 里 2 处 https://apis.google.com/js/api.js（gapi）与 1 处
#      https://www.googleapis.com/oauth2/v2/userinfo（Drive 用户信息）—— 第三方 SDK/接口，无法随包，改写成同源占位。
# 另外 js/app.min.js 的 Editor.GOOGLE_FONTS / GOOGLE_FONTS_CSS2 两个常量被指到本地（见下）。
# ==========================================================================

# 离线守卫（共享资产，入库在 tools/offline-guard/，本脚本只复制 + 注入，不生成/不修改其内容）。
# 为什么必须注入 drawio 自己的页面：drawio 跑在 iframe 里，宿主页对 fetch/XHR/Image 的 prototype
# 补丁只作用于宿主 realm，管不到 iframe 内部。
$GuardSource = Join-Path $ToolsPath "offline-guard\offline-guard.js"
$GuardRel = 'offline-guard.js'
$GuardDest = Join-Path $DrawioDir $GuardRel
$IndexRel = 'index.html'
$IndexFile = Join-Path $DrawioDir $IndexRel
$GuardScriptTag = '<script src="./offline-guard.js"></script>'

# ① 在线图形库 → tools/drawio/libs/（保留上游目录结构）
$ExternalLibPrefix = 'https://jgraph.github.io/drawio-libs/'
$ExternalLibDir = 'libs'
$ExternalLibMirrors = @(
    'https://jgraph.github.io/drawio-libs/',
    'https://raw.githubusercontent.com/jgraph/drawio-libs/master/',
    'https://raw.githubusercontent.com/jgraph/drawio-libs/main/'
)
$LibAddPattern = '<add>\s*(U?)(https://jgraph\.github\.io/drawio-libs/[^<\s]+)\s*</add>'
# 第二种写法：<template … clibs="Uhttps%3A%2F%2Fjgraph.github.io%2Fdrawio-libs%2F…"/>（百分号编码的属性值）
$LibAttrPattern = 'clibs="U(https%3A%2F%2Fjgraph\.github\.io%2Fdrawio-libs%2F[^"]*)"'

# ② 会被加载的外部图片 → tools/drawio/img/external/<basename>-<8位sha256>.<ext>
$ExternalImageDir = 'img/external'
# 注意 ①：正则里用 \x27 表示单引号，避免在 PowerShell 数组字面量里用 '+' 拼接字符串
#          （数组元素里的 '+' 会被逗号运算符抢优先级，把三个模式并成一个字符串）。
# 注意 ②：第 3 条的 (?<![A-Za-z0-9_]) 负向后顾，避免把 loadUrl("https://…") 的调用尾巴
#          当成 CSS 的 url(…) 而去下载一个 API 端点。
# 注意 ③：第 4 条按**宿主**匹配 iconfinder（不限上下文）：它只可能是形状/示例图片，
#          除了 image= 样式，还出现在 Org Chart 的 CSV 示例数据列与某些形状的默认
#          ImageUrl 字面量里（这两种上下文没有 image=/src= 前缀，靠前三条抓不到）。
# 注意 ④：第 5 条匹配 mxlibrary 里的 `"data":"<url>"` 图片条目 ——
#          Sidebar.js:1908 会把 img.data 直接拼成 `image=<data>` 样式，是真加载。
$ExternalImagePatterns = @(
    '(?<prefix>image\s*=\s*"?)(?<url>https?://[^\s"\x27;&>]+)',
    '(?<prefix>(?:src|srcset)\s*=\s*")(?<url>https?://[^"]+)',
    '(?<![A-Za-z0-9_])url\(\s*["\x27]?(?<url>https?://[^\s"\x27)]+)',
    '(?<url>https?://cdn[0-9]*\.iconfinder\.com/[^\s"\x27;&,)\\]*)',
    '(?<prefix>"data"\s*:\s*")(?<url>https?://[^"]+)'
)

# 不下载、直接指向随包本地文件的例外（逐条注明理由）
$ImageOverrides = @(
    [pscustomobject]@{
        Find    = 'https://p.sfx.ms/common/spinner_grey_40_transparent.gif'
        Replace = 'images/ajax-loader.gif'
        Count   = 2
        Reason  = 'OneDrive 选择器的 loading 图（js/onedrive/OneDrive.js、OneDriveOrig.js 各 1 处）→ 用随包的 images/ajax-loader.gif 顶替'
    }
)

# ③ 无法随包的第三方脚本/接口字面量 → 同源占位（配合 PreConfig 的 gapi=0，任何路径都出不去）
#     注意：每条的 Count 是断言值，上游一改就会当场报错，逼我们复核。
$LiteralNeutralizations = @(
    [pscustomobject]@{
        File    = 'js/app.min.js'
        Find    = 'https://apis.google.com/js/api.js?onload=DrawGapiClientCallback'
        Replace = 'js/no-network.js'
        Count   = 1
        Reason  = 'gapi 加载（App.js:1066-1072，非 embed 且 gapi!=0 时）；已被 PreConfig 的 gapi=0 关掉，字面量也一并去掉'
    },
    [pscustomobject]@{
        File    = 'js/app.min.js'
        Find    = 'https://apis.google.com/js/api.js'
        Replace = 'js/no-network.js'
        Count   = 1
        Reason  = 'gapi 加载（location.hash 以 #G 开头的 Google-Docs 分支）'
    },
    [pscustomobject]@{
        File    = 'js/app.min.js'
        Find    = 'https://www.googleapis.com/oauth2/v2/userinfo?alt=json'
        Replace = 'js/no-network.js'
        Count   = 1
        Reason  = 'DriveClient 的 Google 用户信息 XHR；无 gapi 无凭据时不可达'
    },
    [pscustomobject]@{
        File    = 'js/gliffy/drawio-gliffy.min.js'
        Find    = 'https://raw.githubusercontent.com/coreui/coreui-icons/main/svg/brand/'
        Replace = 'img/external/coreui-brand/'
        Count   = 1
        Reason  = 'Gliffy 导入器的 coreui 品牌图标前缀（运行时拼出图标 URL）。coreui 整套图标无法随包，改成同源目录 img/external/coreui-brand/（本就不存在）：导入用到这些品牌图标时只是取不到图，既不出网、也不会像被守卫拦下那样留下 external-blocked 噪音'
    }
)

# 同源占位脚本（本脚本生成）：让上面那些"永远不该发生"的加载落在本机文件上，而不是 404 或出网。
$StubRel = 'js/no-network.js'
$StubContent = @'
// Diagramon 占位脚本（由 tools/fetch-drawio.ps1 生成，勿手工修改）。
// 上游 app.min.js 里两处对 Google gapi SDK 的 mxscript 调用、以及一处 Drive 用户信息接口的
// loadUrl 调用，它们的 URL 字面量都已被改写成本文件路径，使这些"永远不该发生"的第三方调用
// 落在同源文件而不是外网（配合 PreConfig 里的 gapi=0，正常路径根本不会执行到）。
// 本文件故意什么都不做；若它被请求，说明上游某条分支被触发了。
'@

# ④ Google Fonts 常量就地改成同源惰性前缀（改的是 js/app.min.js 里的字面量）。
#     为什么不用空串：Editor.GOOGLE_FONTS / GOOGLE_FONTS_CSS2 参与 Graph.isGoogleFontUrl 的前缀比较
#     （Editor.js:8758 `url.substring(0, Editor.GOOGLE_FONTS.length) == Editor.GOOGLE_FONTS`），
#     置空 => substring(0,0)==='' 恒真 => 任何字体 URL（含图里自带的相对字体路径）都会被当成
#     Google 字体、被改写成 "<空>…:wght@400;500" 的 <link>，反而弄坏本地字体。
#     换成一个同源、不可能真实存在的惰性前缀后：图里自带的相对字体仍然走 @font-face 本地加载 ✓，
#     外部 Google 字体 URL 既不匹配前缀（不再被"Google 化"），只会作为普通 @font-face 外链被
#     离线守卫拦下并上报 external-blocked ✓。
$FontPrefixDisabled = '#diagramon-fonts-disabled:'
$GoogleFontsPatches = @(
    [pscustomobject]@{
        File    = 'js/app.min.js'
        Find    = 'Editor.GOOGLE_FONTS="https://fonts.googleapis.com/css?family="'
        Replace = 'Editor.GOOGLE_FONTS="' + $FontPrefixDisabled + '"'
        Count   = 1
        Reason  = 'Editor.GOOGLE_FONTS（Editor.js:4139）改为惰性同源前缀'
    },
    [pscustomobject]@{
        File    = 'js/app.min.js'
        Find    = 'Editor.GOOGLE_FONTS_CSS2="https://fonts.googleapis.com/css2?family="'
        Replace = 'Editor.GOOGLE_FONTS_CSS2="' + $FontPrefixDisabled + '"'
        Count   = 1
        Reason  = 'Editor.GOOGLE_FONTS_CSS2（Editor.js:4144）改为惰性同源前缀'
    }
)

# ==========================================================================
# 静态自检：扫全部文本文件，命中"会被加载"的外链就报错退出（升级 drawio 时的回归闸门）
# --------------------------------------------------------------------------
# 命中下列模式即视为"会被加载"（相对/同源路径不在扫描范围，因为它们不会出网）：
#   image= 样式 / src=、srcset= / xlink:href=（SVG <image>）/ <link href=（stylesheet 等）
#   css url(…) / mxscript(… / fetch|loadUrl|importScripts|sendBeacon(… / xhr.open(…, "http…
#   <add>U… （drawio 的在线库清单）
# 例外白名单逐条给理由（见 $LoadScanAllowList）；一旦上游新增了别处的可加载外链，这里会直接失败。
$LoadScanPatterns = @(
    [pscustomobject]@{ Name = 'style-image'; Pattern = 'image\s*=\s*"?https?://[^\s"'';&>]+' },
    [pscustomobject]@{ Name = 'src-attr'; Pattern = '(?:src|srcset)\s*=\s*"https?://[^"]+' },
    [pscustomobject]@{ Name = 'xlink-href'; Pattern = 'xlink:href\s*=\s*"https?://[^"]+' },
    [pscustomobject]@{ Name = 'link-href'; Pattern = '<link[^>]{0,200}href\s*=\s*["'']https?://[^"'']+' },
    [pscustomobject]@{ Name = 'css-url'; Pattern = 'url\(\s*["'']?https?://[^\s"'')]+' },
    [pscustomobject]@{ Name = 'script-load'; Pattern = '(?:mxscript|importScripts|sendBeacon|loadUrl|loadScript)\s*\(\s*["'']https?://[^\s"'')]+' },
    [pscustomobject]@{ Name = 'fetch-xhr'; Pattern = '(?:fetch|XMLHttpRequest)[^\n]{0,80}?open\s*\(\s*["''][A-Z]+["'']\s*,\s*["'']https?://[^\s"'')]+|fetch\s*\(\s*["'']https?://[^\s"'')]+' },
    [pscustomobject]@{ Name = 'clibs-add'; Pattern = '<add>\s*U?https?://[^<\s]+' },
    [pscustomobject]@{ Name = 'clibs-attr'; Pattern = 'clibs="U?https?(?:%3A|:)//[^"]*' },
    [pscustomobject]@{ Name = 'json-data-url'; Pattern = '"data"\s*:\s*"https?://[^"]+' }
)

# 白名单：path 是相对 tools/drawio 的 glob（* 通配），host 是命中的主机名。
$LoadScanAllowList = @(
    [pscustomobject]@{
        Host   = 'app.diagrams.net'
        Path   = 'index.html'
        Reason = 'index.html 第 18 行的 <link rel="canonical">（SEO 元数据，浏览器不加载）'
    },
    [pscustomobject]@{
        Host   = 'www.example.com'
        Path   = 'mxgraph/src/view/mxGraph.js'
        Reason = 'mxGraph 的 JSDoc 注释示例 image=http://www.example.com/image.gif（?dev=1 才加载的开发源码，非运行路径）'
    }
)

# 文本类扩展名（其余二进制一律不扫）
$TextScanExtensions = @('.js', '.css', '.html', '.xml', '.txt', '.json', '.svg', '.map')

# ========== 工具函数 ==========

function Get-Sha256Hex {
    param([string]$Path)
    return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
}

function Join-Rel {
    # 白名单里的相对路径统一用 '/' 书写，落到磁盘时换成 Windows 分隔符。
    param([string]$Root, [string]$Relative)
    return (Join-Path $Root ($Relative -replace '/', '\'))
}

function Get-Sha256OfText {
    param([string]$Text)
    $Bytes = [System.Text.Encoding]::UTF8.GetBytes($Text)
    $Sha = [System.Security.Cryptography.SHA256]::Create()
    try {
        return ([System.BitConverter]::ToString($Sha.ComputeHash($Bytes)) -replace '-', '').ToLowerInvariant()
    }
    finally {
        $Sha.Dispose()
    }
}

function Get-WhitelistFingerprint {
    # 白名单 + 离线补丁定义的指纹。清单里记下它，这样「改了脚本但没重跑」会被 -Verify 抓到，
    # 而不是拿着一份与当前规则不符的旧产物说 up-to-date。
    $Spec = @(
        "dirs=" + (($IncludeDirs | Sort-Object) -join ',')
        "files=" + (($IncludeFiles | Sort-Object) -join ',')
        "required=" + (($RequiredFiles | Sort-Object) -join ',')
        "patch=" + (($OfflinePatchSteps | ForEach-Object { $_.Line }) -join ',')
        "guard=" + $GuardScriptTag
        "libs=" + $ExternalLibPrefix + '|' + $ExternalLibDir + '|' + $LibAddPattern + '|' + $LibAttrPattern
        "imgs=" + $ExternalImageDir + '|' + (($ExternalImagePatterns | Sort-Object) -join ',')
        "imgoverride=" + (($ImageOverrides | ForEach-Object { $_.Find + '>' + $_.Replace }) -join ',')
        "neutral=" + (($LiteralNeutralizations | ForEach-Object { $_.File + '|' + $_.Find + '>' + $_.Replace }) -join ',')
        "fonts=" + (($GoogleFontsPatches | ForEach-Object { $_.Find + '>' + $_.Replace }) -join ',')
        "scan=" + (($LoadScanPatterns | ForEach-Object { $_.Name + '=' + $_.Pattern }) -join ',')
        "scanallow=" + (($LoadScanAllowList | ForEach-Object { $_.Host + '@' + $_.Path }) -join ',')
    ) -join ';'
    return Get-Sha256OfText $Spec
}

function Get-PinnedVersion {
    if (-not (Test-Path $VersionFile)) {
        Write-Host "错误: 缺少版本 pin 文件: $VersionFile" -ForegroundColor Red
        Write-Host "  请在 $VersionFile 写入一个 release tag（如 v31.4.6）。" -ForegroundColor Yellow
        Write-Host "  最新 tag: https://api.github.com/repos/$Repository/releases/latest" -ForegroundColor Yellow
        exit 1
    }
    $Pinned = (Get-Content -Path $VersionFile -Raw).Trim()
    if ($Pinned -notmatch '^v\d+\.\d+\.\d+$') {
        Write-Host "错误: $VersionFile 内容不是合法的 release tag（应形如 v31.4.6）: '$Pinned'" -ForegroundColor Red
        exit 1
    }
    return $Pinned
}

function Read-Manifest {
    param([string]$Path)
    if (-not (Test-Path $Path)) { return $null }
    try {
        return (Get-Content -Path $Path -Raw -Encoding UTF8 | ConvertFrom-Json)
    }
    catch {
        return $null
    }
}

function Get-FileRecords {
    # 递归收集清单记录，路径统一为 '/' 分隔、按 path 排序；排除清单自身。
    param([string]$Root)
    $Records = New-Object System.Collections.Generic.List[object]
    foreach ($Item in (Get-ChildItem -Path $Root -Recurse -File -Force)) {
        if ($Item.Name -eq '.manifest.json') { continue }
        $Records.Add([pscustomobject]@{
            path   = $Item.FullName.Substring($Root.Length + 1).Replace('\', '/')
            bytes  = $Item.Length
            sha256 = (Get-FileHash -LiteralPath $Item.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
        })
    }
    return @($Records | Sort-Object path)
}

function Get-TreeSummary {
    # 返回「一级条目 -> 文件数/字节数」的汇总，用于裁剪前后对比。
    param([string]$Root)
    $Summary = @()
    foreach ($Entry in (Get-ChildItem -Path $Root -Force | Sort-Object Name)) {
        if ($Entry.PSIsContainer) {
            $Files = @(Get-ChildItem -Path $Entry.FullName -Recurse -File -Force)
            $Bytes = 0
            foreach ($F in $Files) { $Bytes += $F.Length }
            $Summary += [pscustomobject]@{ name = "$($Entry.Name)/"; files = $Files.Count; bytes = $Bytes }
        }
        else {
            $Summary += [pscustomobject]@{ name = $Entry.Name; files = 1; bytes = $Entry.Length }
        }
    }
    return @($Summary | Sort-Object -Property bytes -Descending)
}

function Format-Size {
    param([long]$Bytes)
    return ("{0:N2} MB" -f ($Bytes / 1MB))
}

function Get-TreeTotals {
    param($Summary)
    $Files = 0
    $Bytes = 0
    foreach ($Row in $Summary) { $Files += $Row.files; $Bytes += $Row.bytes }
    return [pscustomobject]@{ files = $Files; bytes = $Bytes }
}

function Write-TreeSummary {
    # 只打印传入的行（可先 Select-Object 截断），合计始终按全量统计。
    param($Summary, $Totals, [string]$Title)
    Write-Host $Title -ForegroundColor Cyan
    Write-Host ("  {0,-26} {1,8} {2,16}" -f '条目', '文件数', '字节数') -ForegroundColor Gray
    foreach ($Row in $Summary) {
        Write-Host ("  {0,-26} {1,8} {2,16:N0}" -f $Row.name, $Row.files, $Row.bytes) -ForegroundColor Gray
    }
    Write-Host ("  {0,-26} {1,8} {2,16:N0}   ({3})" -f '合计(全量)', $Totals.files, $Totals.bytes, (Format-Size $Totals.bytes)) -ForegroundColor Gray
}

# ========== 离线补丁 ==========
# 目标文件是 tools/drawio/js/PreConfig.js。上游该文件在 bootstrap.js:381 被
# mxscript 动态加载，且早于 app.min.js，因此是「改全局变量 / 改 urlParams」的官方落点
# （上游自己就在里面写 urlParams['sync'] = 'manual'）。补丁只追加行，不删改上游内容。
#
# 追加的三件事：
#   1) window.EXPORT_URL = null;            导出全部走浏览器端渲染，不请求 convert.diagrams.net。
#                                           上游 PreConfig.js:5 已是 null；这里只做「确保存在」，
#                                           万一上游改了默认值，脚本会重新补上。
#   2) urlParams['gapi'] = '0';             禁掉唯一一条真实的外链脚本加载：
#                                           App.js:1066-1072 在 gapi != '0'（非 embed 模式）时
#                                           mxscript('https://apis.google.com/js/api.js?...')。
#   3) urlParams['math'] = '0';             关闭异步数学渲染（App.js:1082 `if (urlParams['math'] != '0')
#                                           Editor.initMath()` → Editor.js:4634 会去取
#                                           math4/es5/startup.js）。关掉后 MathJax 完全不加载，
#                                           math4/ 目录当前不会被请求（仍留在白名单里以便随时打开）。
#
# 这些开关写在 PreConfig 里即「硬编码」，无法被 URL 参数覆盖；如需恢复数学渲染，
# 删掉第 3 条并保留 math4/ 即可。
$OfflinePatchSteps = @(
    [pscustomobject]@{
        Probe   = 'window\.EXPORT_URL\s*=\s*null'
        Line    = 'window.EXPORT_URL = null;'
        Comment = '// [Diagramon] 确保禁用服务端导出（走浏览器端渲染），见 upstream js/PreConfig.js:5'
    },
    [pscustomobject]@{
        Probe   = "urlParams\['gapi'\]\s*=\s*'0'"
        Line    = "urlParams['gapi'] = '0';"
        Comment = '// [Diagramon] 禁 Google Drive 连接器，避免加载 https://apis.google.com/js/api.js（App.js:1066-1072）'
    },
    [pscustomobject]@{
        Probe   = "urlParams\['math'\]\s*=\s*'0'"
        Line    = "urlParams['math'] = '0';"
        Comment = '// [Diagramon] 禁异步数学渲染，避免 MathJax 加载 math4/es5/startup.js（App.js:1082、Editor.js:4634）'
    },
    [pscustomobject]@{
        Probe   = "urlParams\['cors'\]\s*="
        Line    = "urlParams['cors'] = '^(?:libs|img|templates|js|styles|resources|math4|mxgraph)/';"
        Comment = '// [Diagramon] 让同源相对路径绕开不存在的 PROXY_URL：Editor.js:5118-5125 的 isCorsEnabledForUrl 会对'
        Extra   = "//   相对路径判定为 false，从而把在线图形库 libs/….xml 改写成 PROXY_URL+'?url=…'（本机没有 /proxy 端点）。"
        Extra2  = '//   这里用上游自己的 ?cors= 正则开关（注释原文：Blocked by CSP in production but allowed for hosted deployment）放行我们自己的相对目录。'
    }
)

$PatchMarker = '// ===== Diagramon offline patch (added by tools/fetch-drawio.ps1; do not edit) ====='

function Invoke-OfflinePatch {
    # 幂等：已存在的行不重复追加；整段标记只在确实有内容要追加时写一次。
    param([string]$Path)
    $Utf8NoBom = New-Object System.Text.UTF8Encoding($false)
    $Text = [System.IO.File]::ReadAllText($Path, $Utf8NoBom)

    $Missing = @()
    foreach ($Step in $OfflinePatchSteps) {
        if ($Text -notmatch $Step.Probe) { $Missing += $Step }
    }
    if ($Missing.Count -eq 0) {
        Write-Host "  离线补丁已存在，跳过追加 (up-to-date)。" -ForegroundColor Gray
        return $false
    }

    $Newline = if ($Text.Contains("`r`n")) { "`r`n" } else { "`n" }
    $Append = ''
    if ($Text.Length -gt 0 -and -not $Text.EndsWith("`n")) { $Append += $Newline }
    if ($Text -notmatch [regex]::Escape($PatchMarker)) {
        $Append += $PatchMarker + $Newline
    }
    foreach ($Step in $Missing) {
        $Append += $Step.Comment + $Newline
        if ($Step.PSObject.Properties.Name -contains 'Extra' -and $Step.Extra) { $Append += $Step.Extra + $Newline }
        if ($Step.PSObject.Properties.Name -contains 'Extra2' -and $Step.Extra2) { $Append += $Step.Extra2 + $Newline }
        $Append += $Step.Line + $Newline
    }

    [System.IO.File]::WriteAllText($Path, $Text + $Append, $Utf8NoBom)
    foreach ($Step in $Missing) {
        Write-Host "  追加离线补丁: $($Step.Line)" -ForegroundColor Yellow
    }
    return $true
}

function Test-OfflinePatch {
    # 返回 $null 表示通过，否则返回错误描述。
    if (-not (Test-Path $PreConfigFile)) {
        return "缺少 $PreConfigFile"
    }
    $Text = [System.IO.File]::ReadAllText($PreConfigFile, (New-Object System.Text.UTF8Encoding($false)))
    foreach ($Step in $OfflinePatchSteps) {
        if ($Text -notmatch $Step.Probe) {
            return "离线补丁缺失: $PreConfigFile 里找不到 $($Step.Line)"
        }
    }
    return $null
}

# ========== 外链本地化 / 离线化 ==========

function Invoke-OfflineGuard {
    # 复制共享的离线守卫并注入 index.html。注入点：<head> 之后的第一个 <script>。
    # 幂等：已含该 <script> 就不再插；找不到 <head>/首个 <script> 则报错退出（断言）。
    param()
    if (-not (Test-Path -PathType Leaf -LiteralPath $GuardSource)) {
        Write-Host "错误: 缺少离线守卫资产 $GuardSource" -ForegroundColor Red
        Write-Host "  它是入库的共享资产（tools/offline-guard/offline-guard.js），请先确保它在仓库里。" -ForegroundColor Yellow
        exit 1
    }
    Copy-Item -LiteralPath $GuardSource -Destination $GuardDest -Force
    $GuardBytes = (Get-Item -LiteralPath $GuardDest).Length

    $Utf8NoBom = New-Object System.Text.UTF8Encoding($false)
    $Text = [System.IO.File]::ReadAllText($IndexFile, $Utf8NoBom)

    if ($Text.Contains($GuardScriptTag)) {
        Write-Host "  离线守卫已注入 index.html，跳过 (up-to-date)。" -ForegroundColor Gray
        return
    }

    $HeadIdx = $Text.IndexOf('<head>')
    if ($HeadIdx -lt 0) {
        Write-Host "错误: index.html 里找不到 <head>，无法注入离线守卫。" -ForegroundColor Red
        exit 1
    }
    $InsertAt = $HeadIdx + '<head>'.Length

    # 断言：注入点必须是 <head> 之后的第一个 <script>（之前不能已存在其它 <script>）
    $FirstScript = $Text.IndexOf('<script', [System.StringComparison]::Ordinal)
    if ($FirstScript -lt 0) {
        Write-Host "错误: index.html 里找不到任何 <script>（上游结构变了？）。" -ForegroundColor Red
        exit 1
    }
    if ($FirstScript -lt $InsertAt) {
        Write-Host "错误: <head> 之前已存在 <script>（上游结构变了？），无法保证守卫最先加载。" -ForegroundColor Red
        exit 1
    }

    $Newline = if ($Text.Contains("`r`n")) { "`r`n" } else { "`n" }
    $Text = $Text.Substring(0, $InsertAt) + $Newline + $GuardScriptTag + $Text.Substring($InsertAt)
    [System.IO.File]::WriteAllText($IndexFile, $Text, $Utf8NoBom)

    # 注入后再断言一次：守卫标签必须出现在首个 <script 之前
    $VerifyText = [System.IO.File]::ReadAllText($IndexFile, $Utf8NoBom)
    $GuardIdx = $VerifyText.IndexOf($GuardScriptTag)
    $ScriptIdx = $VerifyText.IndexOf('<script')
    if (($GuardIdx -lt 0) -or ($GuardIdx -ne $ScriptIdx)) {
        Write-Host "错误: 离线守卫注入后未处于首个 <script> 位置（guard=$GuardIdx, firstScript=$ScriptIdx）。" -ForegroundColor Red
        exit 1
    }
    Write-Host "  已注入离线守卫: index.html ($GuardBytes 字节) -> $GuardScriptTag" -ForegroundColor Yellow
}

function Get-LocalNameForUrl {
    # 外部图片落地名：<basename>-<8位sha256>.<ext>，避免不同目录同名冲突。
    param([string]$Url)
    $Uri = [System.Uri]$Url
    $Base = [System.IO.Path]::GetFileNameWithoutExtension($Uri.AbsolutePath)
    $Ext = [System.IO.Path]::GetExtension($Uri.AbsolutePath)
    if ([string]::IsNullOrWhiteSpace($Ext)) { $Ext = '.png' }
    $Base = ($Base -replace '[^A-Za-z0-9._-]', '_')
    if ([string]::IsNullOrWhiteSpace($Base)) { $Base = 'asset' }
    return "$Base-$( (Get-Sha256OfText $Url).Substring(0, 8) )$Ext"
}

function Get-ExternalLibraryFile {
    # 下载一个在线图形库到 tools/drawio/libs/…。
    # 返回 @{ status='ok'|'missing'; rel=<本地相对路径> }；'missing' 表示上游 404/410（死链）。
    # 其它失败（网络/超时/5xx）视为环境问题，直接报错退出，不静默降级。
    param([string]$Rel, [string]$Url)
    $LocalRel = ($Rel -replace '//+', '/')          # 上游有 libs//arista.xml 这种双斜杠写法
    $LocalFull = Join-Rel -Root $DrawioDir -Relative $LocalRel
    if (Test-Path -PathType Leaf -LiteralPath $LocalFull) {
        return [pscustomobject]@{ status = 'ok'; rel = $LocalRel }
    }
    $LocalParent = Split-Path $LocalFull -Parent
    if (-not (Test-Path $LocalParent)) {
        New-Item -ItemType Directory -Path $LocalParent -Force | Out-Null
    }

    $NotFound = $false
    foreach ($Mirror in $ExternalLibMirrors) {
        $TryUrl = $Mirror + $Rel
        try {
            Invoke-WebRequest -Uri $TryUrl -OutFile $LocalFull -UseBasicParsing -TimeoutSec 90 -ErrorAction Stop
            if ((Get-Item -LiteralPath $LocalFull).Length -le 0) {
                Write-Host "错误: 在线图形库下载为空: $TryUrl" -ForegroundColor Red
                exit 1
            }
            return [pscustomobject]@{ status = 'ok'; rel = $LocalRel }
        }
        catch {
            $StatusCode = $null
            if ($_.Exception.Response -ne $null) {
                try { $StatusCode = [int]$_.Exception.Response.StatusCode } catch { $StatusCode = $null }
            }
            if ($StatusCode -eq 404 -or $StatusCode -eq 410) { $NotFound = $true }
            Write-Host "    库下载失败($TryUrl): HTTP $StatusCode $($_.Exception.Message)" -ForegroundColor DarkGray
        }
    }
    if ($NotFound) {
        return [pscustomobject]@{ status = 'missing'; rel = $LocalRel }
    }
    Write-Host "错误: 无法下载在线图形库 $Url（已试 $($ExternalLibMirrors.Count) 个来源，且不是 404）。" -ForegroundColor Red
    exit 1
}

function Invoke-ExternalLibraryLocalization {
    # 把 templates/**/*.xml 里 <add>Uhttps://jgraph.github.io/drawio-libs/…</add> 的库清单
    # 下载到 tools/drawio/libs/ 并改写成相对路径。返回 [pscustomobject]{refs, files, bytes, dropped}
    #
    # 上游这份清单本身有死链（v31.4.6：41 条里 27 条 404，主要是 fortinet/* 与若干 integration/*）。
    # 死链处理：**删掉该 <add> 条目**（上游用户点开也是 404，删掉只是让库分类少一项，不是功能回归），
    # 而不是把 URL 留着 —— 留着就违反"产物里不允许出现可加载外链"的静态自检。
    # 非 404 的失败（网络/超时/5xx）视为环境问题，直接报错退出，不静默降级。
    param()
    $Refs = 0
    $NewFiles = 0
    $Dropped = 0
    $Bytes = 0L
    $DroppedList = New-Object System.Collections.Generic.List[string]
    $Targets = @(Get-ChildItem -Path $DrawioDir -Recurse -File -Include *.xml |
        Where-Object { $_.FullName -notlike "*$([System.IO.Path]::DirectorySeparatorChar)$ExternalLibDir$([System.IO.Path]::DirectorySeparatorChar)*" })
    $Utf8NoBom = New-Object System.Text.UTF8Encoding($false)

    foreach ($File in $Targets) {
        $Text = [System.IO.File]::ReadAllText($File.FullName, $Utf8NoBom)
        $AddMatches = [regex]::Matches($Text, $LibAddPattern)
        $AttrMatches = [regex]::Matches($Text, $LibAttrPattern)
        if (($AddMatches.Count -eq 0) -and ($AttrMatches.Count -eq 0)) { continue }

        # ① <add>Uhttps://jgraph.github.io/drawio-libs/…</add>
        foreach ($Match in $AddMatches) {
            $Flag = $Match.Groups[1].Value
            $Url = $Match.Groups[2].Value
            # 上游路径本身就带 libs/ 前缀（https://jgraph.github.io/drawio-libs/libs/integration/azure.xml
            # 去掉 https://jgraph.github.io/drawio-libs/ 后就是 libs/integration/azure.xml）。
            $Rel = $Url.Substring($ExternalLibPrefix.Length)
            $Result = Get-ExternalLibraryFile -Rel $Rel -Url $Url

            if ($Result.status -eq 'missing') {
                # 上游死链：整行删掉（优先按"独占一行"删，保留前后行的换行，避免把相邻行粘在一起）
                $LinePattern = '(?m)^[ \t]*' + [regex]::Escape($Match.Value) + '[ \t]*\r?\n'
                $LineMatch = [regex]::Match($Text, $LinePattern)
                if ($LineMatch.Success) {
                    $Text = $Text.Remove($LineMatch.Index, $LineMatch.Length)
                }
                else {
                    $Text = $Text.Replace($Match.Value, '')
                }
                $Dropped++
                $DroppedList.Add($Rel)
                continue
            }

            $NewTag = '<add>' + $Flag + $Result.rel + '</add>'
            if ($Text.Contains($Match.Value)) {
                $Text = $Text.Replace($Match.Value, $NewTag)
                $Refs++
            }
        }

        # ② <template … clibs="Uhttps%3A%2F%2Fjgraph.github.io%2Fdrawio-libs%2F…"/>（属性里是百分号编码）
        #    解析链：Dialogs.js:3919 取属性 → 查 <clibs name> 映射失败则原样用 → App.js:5918 拼 ?clibs=
        #    → App.js:6607 → loadLibraries 的 service=='U' 分支 decodeURIComponent 后交给 loadTemplate。
        foreach ($Match in $AttrMatches) {
            $Decoded = [System.Uri]::UnescapeDataString($Match.Groups[1].Value)
            $Rel = $Decoded.Substring($ExternalLibPrefix.Length)
            $Result = Get-ExternalLibraryFile -Rel $Rel -Url $Decoded

            if ($Result.status -eq 'missing') {
                # 死链：把属性清空（loadLibraries 会跳过空 id，不会产生请求）
                $Text = $Text.Replace($Match.Value, 'clibs=""')
                $Dropped++
                $DroppedList.Add($Rel)
                continue
            }

            $Text = $Text.Replace($Match.Value, 'clibs="U' + $Result.rel + '"')
            $Refs++
        }

        [System.IO.File]::WriteAllText($File.FullName, $Text, $Utf8NoBom)
    }

    # 统计落地文件（含 -Force 重跑时命中的已有文件）
    $LibRoot = Join-Rel -Root $DrawioDir -Relative $ExternalLibDir
    if (Test-Path $LibRoot) {
        foreach ($Item in (Get-ChildItem -Path $LibRoot -Recurse -File)) {
            $NewFiles++
            $Bytes += $Item.Length
        }
    }

    Write-Host "  在线图形库: 引用改写 $Refs 条，落地文件 $NewFiles 个 ($(Format-Size $Bytes))，上游死链删除 $Dropped 条。" -ForegroundColor Gray
    if ($Dropped -gt 0) {
        Write-Host "    被删的上游死链（404，上游同样打不开）: $($DroppedList -join ', ')" -ForegroundColor DarkGray
    }
    return [pscustomobject]@{ refs = $Refs; files = $NewFiles; bytes = $Bytes; dropped = $Dropped }
}

function Invoke-ExternalImageLocalization {
    # 把会被加载的外部图片下载到 tools/drawio/img/external/ 并改写成相对路径；
    # $ImageOverrides 里的例外直接指向随包本地文件。返回 [pscustomobject]{refs, files, bytes, overrides}
    param()
    $Refs = 0
    $NewFiles = 0
    $Bytes = 0L
    $OverrideHits = 0
    $Utf8NoBom = New-Object System.Text.UTF8Encoding($false)
    $Cache = @{}          # url -> local relative path

    $Files = @(Get-ChildItem -Path $DrawioDir -Recurse -File |
        Where-Object { $TextScanExtensions -contains $_.Extension.ToLowerInvariant() })

    foreach ($File in $Files) {
        $Text = [System.IO.File]::ReadAllText($File.FullName, $Utf8NoBom)
        if ($Text.IndexOf('://') -lt 0) { continue }
        $Changed = $false
        $Original = $Text

        # 例外映射（OneDrive spinner 之类）
        foreach ($Override in $ImageOverrides) {
            if ($Text.Contains($Override.Find)) {
                $Text = $Text.Replace($Override.Find, $Override.Replace)
                $OverrideHits++
                $Changed = $true
            }
        }

        # 需要下载的外部图片
        $Rel = Get-RepoRelativePath -Root $DrawioDir -Full $File.FullName
        $Urls = New-Object System.Collections.Generic.List[string]
        foreach ($PatternInfo in $ExternalImagePatterns) {
            foreach ($Match in [regex]::Matches($Text, $PatternInfo)) {
                $Url = $Match.Groups['url'].Value
                if ($Url -notmatch '^https?://') { continue }
                # 静态自检白名单里的条目（例如 mxGraph 的 JSDoc 示例）不下载、不改写
                $SkipHost = ([regex]::Match($Url, 'https?://([A-Za-z0-9._-]+)')).Groups[1].Value.ToLowerInvariant()
                $Skip = $false
                foreach ($Rule in $LoadScanAllowList) {
                    if ($SkipHost -eq $Rule.Host.ToLowerInvariant() -and $Rel -like $Rule.Path) { $Skip = $true; break }
                }
                if ($Skip) { continue }
                if ($Urls -notcontains $Url) { $Urls.Add($Url) }
            }
        }

        foreach ($Url in $Urls) {
            if (-not $Cache.ContainsKey($Url)) {
                $LocalRel = "$ExternalImageDir/$(Get-LocalNameForUrl -Url $Url)"
                $LocalFull = Join-Rel -Root $DrawioDir -Relative $LocalRel
                $LocalParent = Split-Path $LocalFull -Parent
                if (-not (Test-Path $LocalParent)) {
                    New-Item -ItemType Directory -Path $LocalParent -Force | Out-Null
                }
                if (-not (Test-Path -PathType Leaf -LiteralPath $LocalFull)) {
                    try {
                        Invoke-WebRequest -Uri $Url -OutFile $LocalFull -UseBasicParsing -TimeoutSec 60 -ErrorAction Stop
                    }
                    catch {
                        Write-Host "错误: 无法下载外部图片 $Url : $($_.Exception.Message)" -ForegroundColor Red
                        exit 1
                    }
                    if ((Get-Item -LiteralPath $LocalFull).Length -le 0) {
                        Write-Host "错误: 外部图片下载为空: $Url" -ForegroundColor Red
                        exit 1
                    }
                    $NewFiles++
                    $Bytes += (Get-Item -LiteralPath $LocalFull).Length
                }
                $Cache[$Url] = $LocalRel
            }
            # 统计真实出现次数（同一个 URL 可能在同文件里出现多次）
            $Occurrences = ([regex]::Matches($Text, [regex]::Escape($Url))).Count
            $Text = $Text.Replace($Url, $Cache[$Url])
            $Refs += $Occurrences
        }

        if ($Text -ne $Original) {
            [System.IO.File]::WriteAllText($File.FullName, $Text, $Utf8NoBom)
        }
        $null = $Changed
    }

    Write-Host "  外部图片: 改写 $Refs 条引用，新增 $NewFiles 个文件 ($(Format-Size $Bytes))；例外映射命中 $OverrideHits 条。" -ForegroundColor Gray
    return [pscustomobject]@{ refs = $Refs; files = $NewFiles; bytes = $Bytes; overrides = $OverrideHits }
}

function Invoke-LiteralNeutralization {
    # 第三方脚本/接口字面量 → 同源占位（带替换数断言）。返回 [pscustomobject]{replaced}
    param()
    $Utf8NoBom = New-Object System.Text.UTF8Encoding($false)
    $Total = 0
    foreach ($Spec in $LiteralNeutralizations) {
        $Full = Join-Rel -Root $DrawioDir -Relative $Spec.File
        if (-not (Test-Path -PathType Leaf -LiteralPath $Full)) {
            Write-Host "错误: 中性化目标文件不存在: $($Spec.File)" -ForegroundColor Red
            exit 1
        }
        $Text = [System.IO.File]::ReadAllText($Full, $Utf8NoBom)
        $Count = ([regex]::Matches($Text, [regex]::Escape($Spec.Find))).Count
        if ($Count -ne $Spec.Count) {
            Write-Host "错误: 中性化断言失败: $($Spec.File) 里 '$($Spec.Find)' 出现 $Count 次，期望 $($Spec.Count) 次。" -ForegroundColor Red
            Write-Host "  上游可能改了这段代码，请复核后更新脚本里的 \$LiteralNeutralizations。" -ForegroundColor Yellow
            exit 1
        }
        $Text = $Text.Replace($Spec.Find, $Spec.Replace)
        [System.IO.File]::WriteAllText($Full, $Text, $Utf8NoBom)
        Write-Host "  中性化 $($Spec.File): $($Spec.Find) -> $($Spec.Replace)" -ForegroundColor Yellow
        $Total += $Count
    }

    # 同源占位脚本
    $StubFull = Join-Rel -Root $DrawioDir -Relative $StubRel
    $StubParent = Split-Path $StubFull -Parent
    if (-not (Test-Path $StubParent)) { New-Item -ItemType Directory -Path $StubParent -Force | Out-Null }
    [System.IO.File]::WriteAllText($StubFull, ($StubContent -replace "`r`n", "`n") + "`n", $Utf8NoBom)
    return [pscustomobject]@{ replaced = $Total }
}

function Invoke-GoogleFontsPatch {
    # Editor.GOOGLE_FONTS / GOOGLE_FONTS_CSS2 指到同源惰性前缀（带替换数断言）。
    param()
    $Utf8NoBom = New-Object System.Text.UTF8Encoding($false)
    $Total = 0
    foreach ($Spec in $GoogleFontsPatches) {
        $Full = Join-Rel -Root $DrawioDir -Relative $Spec.File
        $Text = [System.IO.File]::ReadAllText($Full, $Utf8NoBom)
        $Count = ([regex]::Matches($Text, [regex]::Escape($Spec.Find))).Count
        if ($Count -ne $Spec.Count) {
            Write-Host "错误: Google Fonts 断言失败: $($Spec.File) 里 '$($Spec.Find)' 出现 $Count 次，期望 $($Spec.Count) 次。" -ForegroundColor Red
            Write-Host "  上游可能改了常量定义，请复核后更新脚本里的 \$GoogleFontsPatches。" -ForegroundColor Yellow
            exit 1
        }
        $Text = $Text.Replace($Spec.Find, $Spec.Replace)
        [System.IO.File]::WriteAllText($Full, $Text, $Utf8NoBom)
        Write-Host "  $($Spec.Reason): $($Spec.Find) -> $($Spec.Replace)" -ForegroundColor Yellow
        $Total += $Count
    }
    return [pscustomobject]@{ replaced = $Total }
}

function Test-OfflineGuardInjection {
    # 返回 $null 表示通过，否则返回错误描述。
    param()
    if (-not (Test-Path -PathType Leaf -LiteralPath $GuardDest)) {
        return "缺少离线守卫 $GuardRel"
    }
    if (-not (Test-Path -PathType Leaf -LiteralPath $IndexFile)) {
        return "缺少 $IndexRel"
    }
    $Text = [System.IO.File]::ReadAllText($IndexFile, (New-Object System.Text.UTF8Encoding($false)))
    $GuardIdx = $Text.IndexOf($GuardScriptTag)
    if ($GuardIdx -lt 0) {
        return "$IndexRel 里没有离线守卫 <script src=`"./offline-guard.js`">"
    }
    $HeadIdx = $Text.IndexOf('<head>')
    if ($HeadIdx -lt 0) {
        return "$IndexRel 里找不到 <head>"
    }
    $ScriptIdx = $Text.IndexOf('<script')
    if ($GuardIdx -ne $ScriptIdx) {
        return "离线守卫不是 $IndexRel 的第一个 <script>（guard@$GuardIdx, firstScript@$ScriptIdx）"
    }
    if ($GuardIdx -lt $HeadIdx) {
        return "离线守卫出现在 <head> 之前"
    }
    return $null
}

function Get-RepoRelativePath {
    param([string]$Root, [string]$Full)
    return $Full.Substring($Root.Length + 1).Replace('\', '/')
}

function Test-NoExternalLoads {
    # 静态自检：扫文本文件里"会被加载"的外链，命中不在白名单里的就返回错误描述。
    param()
    $Files = @(Get-ChildItem -Path $DrawioDir -Recurse -File |
        Where-Object { $TextScanExtensions -contains $_.Extension.ToLowerInvariant() -and $_.Name -ne '.manifest.json' })
    $Hits = @()

    foreach ($File in $Files) {
        $Text = [System.IO.File]::ReadAllText($File.FullName, (New-Object System.Text.UTF8Encoding($false)))
        if ($Text.IndexOf('://') -lt 0) { continue }
        $Rel = Get-RepoRelativePath -Root $DrawioDir -Full $File.FullName

        foreach ($Info in $LoadScanPatterns) {
            foreach ($Match in [regex]::Matches($Text, $Info.Pattern)) {
                $Value = $Match.Value
                $Host2 = ([regex]::Match($Value, 'https?://([A-Za-z0-9._-]+)')).Groups[1].Value.ToLowerInvariant()
                if ([string]::IsNullOrEmpty($Host2)) { continue }

                $Allowed = $false
                foreach ($Rule in $LoadScanAllowList) {
                    if ($Host2 -eq $Rule.Host.ToLowerInvariant() -and $Rel -like $Rule.Path) { $Allowed = $true; break }
                }
                if (-not $Allowed) {
                    $Hits += [pscustomobject]@{ file = $Rel; kind = $Info.Name; host = $Host2; value = $Value.Substring(0, [Math]::Min(120, $Value.Length)) }
                }
            }
        }
    }

    if ($Hits.Count -gt 0) {
        Write-Host "错误: 静态自检发现 $($Hits.Count) 处会被加载的外链（应随包本地化或加入白名单）：" -ForegroundColor Red
        $Grouped = @($Hits | Group-Object -Property host | Sort-Object Count -Descending)
        foreach ($Group in $Grouped) {
            $Sample = $Group.Group[0]
            Write-Host ("  {0,-30} x{1,-4} 例: {2} ({3})" -f $Group.Name, $Group.Count, $Sample.file, $Sample.kind) -ForegroundColor Red
        }
        Write-Host '  新增的可加载外链只能本地化（下载到 libs/ 或 img/external/）、中性化成同源占位，' -ForegroundColor Yellow
        Write-Host '  或写明理由加进脚本里的 $LoadScanAllowList。' -ForegroundColor Yellow
        return "静态自检失败: 仍有 $($Hits.Count) 处可加载外链"
    }

    return $null
}

# ========== 产物校验（-Verify 与幂等判断共用） ==========

function Write-ManifestFile {
    # 契约 schema：{version, files:[{path, bytes, sha256}]}；额外记一个 whitelist 指纹，
    # 这样「改了脚本里的白名单/补丁却没重跑」会被 -Verify 直接指出来。
    # 手写 JSON 是为了确定性：LF 换行、2 空格缩进、UTF-8 无 BOM。
    param([string]$Path, [string]$Version, $Records)

    $Builder = New-Object System.Text.StringBuilder
    [void]$Builder.Append("{`n")
    [void]$Builder.Append("  `"version`": `"$Version`",`n")
    [void]$Builder.Append("  `"whitelist`": `"$(Get-WhitelistFingerprint)`",`n")
    [void]$Builder.Append("  `"files`": [`n")
    for ($i = 0; $i -lt $Records.Count; $i++) {
        $R = $Records[$i]
        $Comma = if ($i -lt ($Records.Count - 1)) { "," } else { "" }
        [void]$Builder.Append("    {`n")
        [void]$Builder.Append("      `"path`": `"$($R.path)`",`n")
        [void]$Builder.Append("      `"bytes`": $($R.bytes),`n")
        [void]$Builder.Append("      `"sha256`": `"$($R.sha256)`"`n")
        [void]$Builder.Append("    }$Comma`n")
    }
    [void]$Builder.Append("  ]`n}")
    [void]$Builder.Append("`n")
    $Utf8NoBom = New-Object System.Text.UTF8Encoding($false)
    [System.IO.File]::WriteAllText($Path, $Builder.ToString(), $Utf8NoBom)
}

function Sync-HostHtml {
    # 把 tools/drawio-host/host.html 同步到 tools/drawio/host.html（源不存在则删除目标），
    # 然后按当前磁盘内容重写清单。返回 $true 表示清单已更新。
    param([string]$PinnedVersion)
    $OldBytes = if (Test-Path -PathType Leaf -LiteralPath $HostDest) { (Get-Item -LiteralPath $HostDest).Length } else { $null }
    if (Test-Path -PathType Leaf -LiteralPath $HostSource) {
        Copy-Item -LiteralPath $HostSource -Destination $HostDest -Force
        $NewBytes = (Get-Item -LiteralPath $HostDest).Length
        Write-Host "  已刷新宿主页 tools/drawio-host/host.html -> tools/drawio/host.html ($OldBytes -> $NewBytes 字节)。" -ForegroundColor Yellow
    }
    elseif (Test-Path -PathType Leaf -LiteralPath $HostDest) {
        Remove-Item -LiteralPath $HostDest -Force
        Write-Host "  源 $HostSource 已不存在，移除 tools/drawio/host.html（原 $OldBytes 字节）。" -ForegroundColor Yellow
    }
    else {
        return $false
    }
    Write-ManifestFile -Path $ManifestFile -Version $PinnedVersion -Records @(Get-FileRecords -Root $DrawioDir)
    return $true
}

function Test-DrawioAssets {
    # 返回 $null 表示通过，否则返回错误描述。
    # -IgnoreHostHtml：跳过 host.html 条目与 host.html 收录检查，用于判断
    # 「是否只有宿主页漂移」（父级在迭代 tools/drawio-host/host.html 时走快路径，不必重下整包）。
    param([string]$PinnedVersion, [switch]$IgnoreHostHtml)

    if (-not (Test-Path $DrawioDir)) {
        return "缺少目录 $DrawioDir"
    }
    if (-not (Test-Path $ManifestFile)) {
        return "缺少清单文件 $ManifestFile"
    }
    $Manifest = Read-Manifest -Path $ManifestFile
    if ($null -eq $Manifest) {
        return "清单文件无法解析: $ManifestFile"
    }
    if ($Manifest.version -ne $PinnedVersion) {
        return "清单版本($($Manifest.version))与版本 pin 文件中的 $PinnedVersion 不一致"
    }
    $Fingerprint = Get-WhitelistFingerprint
    if ($Manifest.whitelist -ne $Fingerprint) {
        return "白名单/离线补丁定义已变更（清单 $($Manifest.whitelist) != 当前 $Fingerprint），需要重跑本脚本"
    }

    foreach ($Rel in $RequiredFiles) {
        $Full = Join-Rel -Root $DrawioDir -Relative $Rel
        if (-not (Test-Path -PathType Leaf -LiteralPath $Full)) {
            return "缺少必需文件 $Rel（上游目录结构可能已变化）"
        }
    }

    $PatchProblem = Test-OfflinePatch
    if ($PatchProblem) { return $PatchProblem }

    $GuardProblem = Test-OfflineGuardInjection
    if ($GuardProblem) { return $GuardProblem }

    $ScanProblem = Test-NoExternalLoads
    if ($ScanProblem) { return $ScanProblem }

    $Entries = @($Manifest.files)
    if ($Entries.Count -eq 0) {
        return "清单 files 为空"
    }

    foreach ($Entry in $Entries) {
        $Rel = [string]$Entry.path
        if ($IgnoreHostHtml -and $Rel -eq 'host.html') { continue }
        $Full = Join-Rel -Root $DrawioDir -Relative $Rel
        if (-not (Test-Path -PathType Leaf -LiteralPath $Full)) {
            return "清单记录了但磁盘上不存在: $Rel"
        }
        $Bytes = (Get-Item -LiteralPath $Full).Length
        if ([int64]$Entry.bytes -ne $Bytes) {
            return "$Rel 字节数不符: 实际 $Bytes, 清单 $($Entry.bytes)"
        }
        $Sha = Get-Sha256Hex -Path $Full
        if ($Sha -ne $Entry.sha256) {
            return "$Rel sha256 不符: 实际 $Sha, 清单 $($Entry.sha256)"
        }
    }

    $OnDisk = @(Get-FileRecords -Root $DrawioDir)
    if ($OnDisk.Count -ne $Entries.Count) {
        return "文件数量与清单不符: 磁盘 $($OnDisk.Count) 个, 清单 $($Entries.Count) 个（可能有残留文件或在 host.html 出现/消失后未重跑）"
    }

    # host.html 由 tools/drawio-host/host.html 复制而来：源存在就必须已收录。
    if ($IgnoreHostHtml) { return $null }
    $HasHostEntry = ($null -ne ($Entries | Where-Object { $_.path -eq 'host.html' } | Select-Object -First 1))
    if ((Test-Path $HostSource) -and -not $HasHostEntry) {
        return "tools/drawio-host/host.html 已存在但未收录进工具资源，需要重跑本脚本"
    }

    return $null
}

$PinnedVersion = Get-PinnedVersion
$ReleaseLabel = "$Repository@$PinnedVersion"

# ========== 仅校验模式 ==========
if ($Verify) {
    Write-Host "校验 drawio 离线资源 ($ReleaseLabel)..." -ForegroundColor Cyan
    $Problem = Test-DrawioAssets -PinnedVersion $PinnedVersion
    if ($Problem) {
        Write-Host "校验失败: $Problem" -ForegroundColor Red
        Write-Host "请重新运行 tools\fetch-drawio.ps1 获取资源。" -ForegroundColor Yellow
        exit 1
    }
    $Records = @((Read-Manifest -Path $ManifestFile).files)
    $TotalBytes = 0
    foreach ($R in $Records) { $TotalBytes += [int64]$R.bytes }
    Write-Host "校验通过。" -ForegroundColor Green
    Write-Host "  版本: $PinnedVersion" -ForegroundColor Gray
    Write-Host "  文件数: $($Records.Count)" -ForegroundColor Gray
    Write-Host "  总字节: $TotalBytes ($(Format-Size $TotalBytes))" -ForegroundColor Gray
    Write-Host "  入口: $(Join-Rel -Root $DrawioDir -Relative 'index.html')" -ForegroundColor Gray
    Write-Host "  离线补丁: js/PreConfig.js（EXPORT_URL=null / gapi=0 / math=0 / cors 放行同源相对目录）" -ForegroundColor Gray
    Write-Host "  离线守卫: $GuardRel 已注入 $IndexRel <head> 之后的首个 <script>" -ForegroundColor Gray
    Write-Host "  静态自检: 无可加载外链（白名单 $($LoadScanAllowList.Count) 条）" -ForegroundColor Gray
    Write-Host "  白名单指纹: $(Get-WhitelistFingerprint)" -ForegroundColor Gray
    Write-Host "  归属: $LicenseFile ($Repository, Apache-2.0)" -ForegroundColor Gray
    Write-Host "  清单: $ManifestFile" -ForegroundColor Gray
    exit 0
}

# ========== 幂等：内容与 pin tag 一致时跳过下载 ==========
if (-not $Force) {
    $Problem = Test-DrawioAssets -PinnedVersion $PinnedVersion
    if (-not $Problem) {
        $Records = @((Read-Manifest -Path $ManifestFile).files)
        $TotalBytes = 0
        foreach ($R in $Records) { $TotalBytes += [int64]$R.bytes }
        Write-Host "drawio 离线资源已是最新 ($ReleaseLabel)，跳过下载 (up-to-date)。" -ForegroundColor Green
        Write-Host "  产物: $DrawioDir" -ForegroundColor Gray
        Write-Host "  文件数: $($Records.Count), 总字节: $TotalBytes ($(Format-Size $TotalBytes))" -ForegroundColor Gray
        exit 0
    }

    # 快路径：除 host.html 外全都对得上，说明只是宿主页被改过（它由 tools/drawio-host/ 提供，
    # 迭代频繁）。这时没必要重下 65MB 源码包，重新同步这一个文件 + 刷新清单即可。
    if ($null -eq (Test-DrawioAssets -PinnedVersion $PinnedVersion -IgnoreHostHtml)) {
        Write-Host "drawio 离线资源已是最新（仅宿主页 host.html 与清单不符）：" -ForegroundColor Cyan
        if (Sync-HostHtml -PinnedVersion $PinnedVersion) {
            Write-Host "  清单已刷新: $ManifestFile" -ForegroundColor Gray
        }
        exit 0
    }

    Write-Host "需要重新获取: $Problem" -ForegroundColor Yellow
}

# ========== 选择解包工具 ==========
$TarExe = Get-Command tar.exe -ErrorAction SilentlyContinue
if ($null -eq $TarExe) {
    Write-Host "错误: 找不到 tar.exe，无法解包源码包（需要 Windows 10 1803 及以上）。" -ForegroundColor Red
    exit 1
}

# ========== 下载并解包 ==========
$TempDir = Join-Path $env:TEMP ("diagramon-drawio-" + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $TempDir -Force | Out-Null

try {
    # 下载来源按顺序尝试：codeload 官方两条优先（无中间人、体积最小），
    # 之后是国内镜像（GitHub 直连受限时用），最后才是 git 浅克隆。
    # 每个来源限时 300 秒（约 65MB 的文件在 1MB/s 下需 65 秒，300 秒足够；
    # 卡住不动的连接会被超时打断并自动换下一个来源）。
    $ArchiveAttempts = @(
        [pscustomobject]@{
            Name = 'codeload (tar.gz)'
            Url  = "https://codeload.github.com/$Repository/tar.gz/refs/tags/$PinnedVersion"
            File = "drawio.tar.gz"
            Flag = '-xzf'
        },
        [pscustomobject]@{
            Name = 'codeload (zip)'
            Url  = "https://codeload.github.com/$Repository/zipball/refs/tags/$PinnedVersion"
            File = "drawio.zip"
            Flag = '-xf'
        },
        [pscustomobject]@{
            Name = 'ghproxy.net 镜像'
            Url  = "https://ghproxy.net/https://github.com/$Repository/archive/refs/tags/$PinnedVersion.tar.gz"
            File = "drawio-ghproxy.tar.gz"
            Flag = '-xzf'
        },
        [pscustomobject]@{
            Name = 'gh-proxy.com 镜像'
            Url  = "https://gh-proxy.com/https://github.com/$Repository/archive/refs/tags/$PinnedVersion.tar.gz"
            File = "drawio-ghproxy2.tar.gz"
            Flag = '-xzf'
        }
    )

    $ArchivePath = $null
    $ArchiveFlag = $null
    foreach ($Attempt in $ArchiveAttempts) {
        Write-Host "正在下载 $PinnedVersion 源码包 [$($Attempt.Name)]: $($Attempt.Url)" -ForegroundColor Cyan
        $Out = Join-Path $TempDir $Attempt.File
        try {
            Invoke-WebRequest -Uri $Attempt.Url -OutFile $Out -UseBasicParsing -TimeoutSec 300 -ErrorAction Stop
            $ArchivePath = $Out
            $ArchiveFlag = $Attempt.Flag
            break
        }
        catch {
            Write-Host "  该来源失败，尝试下一个来源: $($_.Exception.Message)" -ForegroundColor Yellow
            if (Test-Path $Out) { Remove-Item -LiteralPath $Out -Force -ErrorAction SilentlyContinue }
        }
    }

    # ---------- 解包 / 或退回 git 浅克隆 ----------
    $SourceRoot = $null
    if ($ArchivePath) {
        $ArchiveBytes = (Get-Item -LiteralPath $ArchivePath).Length
        Write-Host "  下载完成: $ArchiveBytes 字节 ($(Format-Size $ArchiveBytes))" -ForegroundColor Gray

        $ExtractDir = Join-Path $TempDir "extract"
        New-Item -ItemType Directory -Path $ExtractDir -Force | Out-Null
        Write-Host "解包 $ArchivePath ..." -ForegroundColor Gray
        & $TarExe.Source $ArchiveFlag $ArchivePath "-C" $ExtractDir
        if ($LASTEXITCODE -ne 0) {
            Write-Host "错误: 解包失败 (exit=$LASTEXITCODE): $ArchivePath" -ForegroundColor Red
            exit 1
        }

        $TopDirs = @(Get-ChildItem -Path $ExtractDir -Directory -Force)
        if ($TopDirs.Count -ne 1) {
            Write-Host "错误: 解包结果不是单个顶层目录（找到 $($TopDirs.Count) 个）。" -ForegroundColor Red
            exit 1
        }
        $SourceRoot = $TopDirs[0].FullName
    }
    else {
        # 所有直链都不通时，用 git 浅克隆（只取该 tag 的那一次提交）。
        $GitExe = Get-Command git.exe -ErrorAction SilentlyContinue
        if ($null -ne $GitExe) {
            $CloneUrls = @("https://gitclone.com/github.com/$Repository", "https://github.com/$Repository")
            foreach ($CloneUrl in $CloneUrls) {
                $CloneDir = Join-Path $TempDir ("clone-" + [guid]::NewGuid().ToString('N'))
                Write-Host "尝试 git 浅克隆: $CloneUrl (tag $PinnedVersion)" -ForegroundColor Cyan
                & $GitExe.Source clone --depth 1 --branch $PinnedVersion $CloneUrl $CloneDir 2>&1 |
                    Select-Object -Last 3 | ForEach-Object { Write-Host "    $_" -ForegroundColor DarkGray }
                if (($LASTEXITCODE -eq 0) -and (Test-Path (Join-Path $CloneDir ($WebappRoot -replace '/', '\')))) {
                    $SourceRoot = $CloneDir
                    break
                }
                Write-Host "  浅克隆失败 (exit=$LASTEXITCODE)，尝试下一个来源。" -ForegroundColor Yellow
                if (Test-Path $CloneDir) { Remove-Item -Path $CloneDir -Recurse -Force -ErrorAction SilentlyContinue }
            }
        }
        else {
            Write-Host "  未找到 git.exe，跳过浅克隆兜底。" -ForegroundColor Yellow
        }

        if (-not $SourceRoot) {
            Write-Host "错误: 无法获取 $ReleaseLabel 的源码（codeload/镜像/git 全部失败）。" -ForegroundColor Red
            Write-Host "  请检查网络后重试；如需走代理，请先设置 HTTP_PROXY/HTTPS_PROXY 环境变量。" -ForegroundColor Yellow
            exit 1
        }
    }

    $WebappSource = Join-Path $SourceRoot ($WebappRoot -replace '/', '\')
    if (-not (Test-Path $WebappSource)) {
        Write-Host "错误: 源码包里缺少 ${WebappRoot}: $WebappSource" -ForegroundColor Red
        exit 1
    }
    $SourceLicense = Join-Path $SourceRoot $UpstreamLicense
    if (-not (Test-Path $SourceLicense)) {
        Write-Host "错误: 源码包里缺少 ${UpstreamLicense}: $SourceLicense" -ForegroundColor Red
        exit 1
    }

    # ---------- 裁剪前基线 ----------
    $BeforeSummary = @(Get-TreeSummary -Root $WebappSource)
    $Before = Get-TreeTotals -Summary $BeforeSummary
    Write-Host ""
    Write-Host "上游 $WebappRoot 全量清单（$PinnedVersion，按体积 top 15）：" -ForegroundColor Cyan
    Write-TreeSummary -Summary ($BeforeSummary | Select-Object -First 15) -Totals $Before -Title "  [一级条目 top 15 / 共 $($BeforeSummary.Count) 项]"

    # ---------- 裁剪复制 ----------
    Write-Host ""
    Write-Host "按白名单复制到 $DrawioDir ..." -ForegroundColor Cyan
    if (Test-Path $DrawioDir) {
        Remove-Item -Path $DrawioDir -Recurse -Force
    }
    New-Item -ItemType Directory -Path $DrawioDir -Force | Out-Null

    $CopiedFiles = 0
    foreach ($Rel in $IncludeFiles) {
        $Src = Join-Rel -Root $WebappSource -Relative $Rel
        if (-not (Test-Path -PathType Leaf -LiteralPath $Src)) {
            Write-Host "错误: 上游缺少白名单文件 $Rel（$PinnedVersion 的目录结构可能已变化）。" -ForegroundColor Red
            exit 1
        }
        $Dst = Join-Rel -Root $DrawioDir -Relative $Rel
        $DstParent = Split-Path $Dst -Parent
        if (-not (Test-Path $DstParent)) {
            New-Item -ItemType Directory -Path $DstParent -Force | Out-Null
        }
        Copy-Item -LiteralPath $Src -Destination $Dst -Force
        $CopiedFiles++
    }

    foreach ($Rel in $IncludeDirs) {
        $Src = Join-Rel -Root $WebappSource -Relative $Rel
        if (-not (Test-Path -PathType Container -LiteralPath $Src)) {
            Write-Host "错误: 上游缺少白名单目录 $Rel（$PinnedVersion 的目录结构可能已变化）。" -ForegroundColor Red
            exit 1
        }
        $Dst = Join-Rel -Root $DrawioDir -Relative $Rel
        New-Item -ItemType Directory -Path $Dst -Force | Out-Null
        foreach ($Item in (Get-ChildItem -Path $Src -Recurse -File -Force)) {
            $SubRel = $Item.FullName.Substring($Src.Length + 1)
            $Target = Join-Path $Dst $SubRel
            $TargetParent = Split-Path $Target -Parent
            if (-not (Test-Path $TargetParent)) {
                New-Item -ItemType Directory -Path $TargetParent -Force | Out-Null
            }
            Copy-Item -LiteralPath $Item.FullName -Destination $Target -Force
            $CopiedFiles++
        }
    }

    Copy-Item -LiteralPath $SourceLicense -Destination $LicenseFile -Force
    $CopiedFiles++
    Write-Host "  已复制 $CopiedFiles 个文件。" -ForegroundColor Gray

    # ---------- 离线补丁 ----------
    Write-Host "应用离线补丁到 js/PreConfig.js ..." -ForegroundColor Cyan
    $null = Invoke-OfflinePatch -Path $PreConfigFile

    # ---------- host.html（父级资产，存在才复制；本脚本不生成其内容） ----------
    if (Test-Path -PathType Leaf -LiteralPath $HostSource) {
        Copy-Item -LiteralPath $HostSource -Destination $HostDest -Force
        $HostBytes = (Get-Item -LiteralPath $HostDest).Length
        Write-Host "  已复制宿主页 tools/drawio-host/host.html -> tools/drawio/host.html ($HostBytes 字节)。" -ForegroundColor Gray
    }
    else {
        Write-Host "  未找到 $HostSource，跳过 host.html（需要时由父级提供后重跑本脚本即可收录）。" -ForegroundColor Yellow
    }

    # ---------- 离线守卫（共享资产，复制 + 注入 index.html） ----------
    Write-Host "部署离线守卫 ..." -ForegroundColor Cyan
    Invoke-OfflineGuard

    # ---------- 外链本地化 ----------
    Write-Host "本地化在线图形库（jgraph.github.io/drawio-libs）..." -ForegroundColor Cyan
    $LibStats = Invoke-ExternalLibraryLocalization

    Write-Host "本地化会被加载的外部图片 ..." -ForegroundColor Cyan
    $ImgStats = Invoke-ExternalImageLocalization

    Write-Host "中性化第三方 SDK/接口字面量 ..." -ForegroundColor Cyan
    $NeutralStats = Invoke-LiteralNeutralization

    Write-Host "把 Google Fonts 常量指向本地 ..." -ForegroundColor Cyan
    $FontStats = Invoke-GoogleFontsPatch

    # ---------- 最小闭环自检 ----------
    $MissingRequired = @()
    foreach ($Rel in $RequiredFiles) {
        if (-not (Test-Path -PathType Leaf -LiteralPath (Join-Rel -Root $DrawioDir -Relative $Rel))) {
            $MissingRequired += $Rel
        }
    }
    if ($MissingRequired.Count -gt 0) {
        Write-Host "错误: 最小闭环自检失败，缺少必需文件：" -ForegroundColor Red
        foreach ($Rel in $MissingRequired) { Write-Host "  - $Rel" -ForegroundColor Red }
        Write-Host "  说明 $PinnedVersion 的上游目录结构已变化，请更新脚本里的白名单后重试。" -ForegroundColor Yellow
        exit 1
    }
    $GuardProblem = Test-OfflineGuardInjection
    if ($GuardProblem) {
        Write-Host "错误: 最小闭环自检失败: $GuardProblem" -ForegroundColor Red
        exit 1
    }
    Write-Host "最小闭环自检通过（$($RequiredFiles.Count) 项必需文件 + 离线守卫注入位置）。" -ForegroundColor Green

    # ---------- 静态自检：不允许残留可加载外链 ----------
    Write-Host "静态自检（可加载外链扫描）..." -ForegroundColor Cyan
    $ScanProblem = Test-NoExternalLoads
    if ($ScanProblem) {
        Write-Host "错误: $ScanProblem" -ForegroundColor Red
        exit 1
    }
    Write-Host "静态自检通过：无未白名单的可加载外链（白名单 $($LoadScanAllowList.Count) 条，逐条注明理由）。" -ForegroundColor Green

    # ---------- 清单 ----------
    $Records = @(Get-FileRecords -Root $DrawioDir)
    $TotalBytes = 0
    foreach ($R in $Records) { $TotalBytes += [int64]$R.bytes }

    # 裁剪后摘要（在写清单之前统计，磁盘内容 == 清单内容）
    $AfterSummary = Get-TreeSummary -Root $DrawioDir

    Write-ManifestFile -Path $ManifestFile -Version $PinnedVersion -Records $Records

    # ---------- 裁剪后摘要 ----------
    Write-Host ""
    Write-TreeSummary -Summary $AfterSummary -Totals (Get-TreeTotals -Summary $AfterSummary) -Title "裁剪后 tools/drawio 一级条目（全量 $($AfterSummary.Count) 项）："
    Write-Host ""
    $JsSummary = @(Get-TreeSummary -Root (Join-Path $DrawioDir 'js'))
    Write-TreeSummary -Summary $JsSummary -Totals (Get-TreeTotals -Summary $JsSummary) -Title "  js/ 二级明细（全量 $($JsSummary.Count) 项）："

    Write-Host ""
    $After = Get-TreeTotals -Summary $AfterSummary
    Write-Host "裁剪前后对比：" -ForegroundColor Cyan
    Write-Host ("  上游 {0}: {1} 个文件, {2:N0} 字节 ({3})" -f $WebappRoot, $Before.files, $Before.bytes, (Format-Size $Before.bytes)) -ForegroundColor Gray
    Write-Host ("  裁剪后               : {0} 个文件, {1:N0} 字节 ({2})" -f $After.files, $After.bytes, (Format-Size $After.bytes)) -ForegroundColor Gray
    Write-Host ("  一级条目 {0} -> {1}；体积省 {2:P1}" -f $BeforeSummary.Count, $AfterSummary.Count, (1 - ($After.bytes / $Before.bytes))) -ForegroundColor Gray

    Write-Host ""
    Write-Host "外链本地化/离线化小结：" -ForegroundColor Cyan
    Write-Host ("  在线图形库 {0}: 引用改写 {1} 条, 新增文件 {2} 个 / {3:N0} 字节" -f $ExternalLibDir, $LibStats.refs, $LibStats.files, $LibStats.bytes) -ForegroundColor Gray
    Write-Host ("  外部图片 {0}: 引用改写 {1} 条, 新增文件 {2} 个 / {3:N0} 字节, 例外映射 {4} 条" -f $ExternalImageDir, $ImgStats.refs, $ImgStats.files, $ImgStats.bytes, $ImgStats.overrides) -ForegroundColor Gray
    Write-Host ("  第三方 SDK/接口字面量中性化 {0} 条 -> {1}" -f $NeutralStats.replaced, $StubRel) -ForegroundColor Gray
    Write-Host ("  Google Fonts 常量改写 {0} 条 -> {1}" -f $FontStats.replaced, $FontPrefixDisabled) -ForegroundColor Gray
    Write-Host "  离线守卫: $GuardRel ($((Get-Item -LiteralPath $GuardDest).Length) 字节) 已注入 $IndexRel <head> 之后" -ForegroundColor Gray

    Write-Host ""
    Write-Host "drawio 离线资源就绪 ($ReleaseLabel)。" -ForegroundColor Green
    Write-Host "  产物: $DrawioDir" -ForegroundColor Gray
    Write-Host "  文件数: $($Records.Count), 总字节: $TotalBytes ($(Format-Size $TotalBytes))" -ForegroundColor Gray
    Write-Host "  入口: $DrawioDir\index.html（embed 模式见 tools/README.md）" -ForegroundColor Gray
    Write-Host "  离线补丁: js/PreConfig.js（EXPORT_URL=null / gapi=0 / math=0 / cors 放行同源相对目录）" -ForegroundColor Gray
    Write-Host "  白名单指纹: $(Get-WhitelistFingerprint)" -ForegroundColor Gray
    Write-Host "  归属: $LicenseFile ($Repository, Apache-2.0)" -ForegroundColor Gray
    Write-Host "  清单: $ManifestFile" -ForegroundColor Gray
}
finally {
    if (Test-Path $TempDir) {
        Remove-Item -Path $TempDir -Recurse -Force -ErrorAction SilentlyContinue
    }
}

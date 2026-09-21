param(
    [switch]$Verify,
    [switch]$Force
)

# ========== 编码处理（与 tools/fetch-graphviz.ps1 / tools/fetch-drawio.ps1 / publish1-build.ps1 一致） ==========
$null = chcp 65001
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
[Console]::InputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8

<#
.SYNOPSIS
    构建并落盘 @excalidraw/excalidraw 的离线 bundle，产出可离线运行的 tools/excalidraw/。

.DESCRIPTION
    @excalidraw/excalidraw 是**纯 ESM 库**：npm 包里没有 UMD/IIFE/<script> 可用的预构建产物
    （package.json 的 exports 只给 import 条件，dist/prod/index.js 全是 `import{…}from`），
    所以「拉包 + 复制文件」不够，必须自己跑一次打包。流程：

    1. 读版本 pin 文件 tools/excalidraw.version（key=value 多行，见该文件注释）。
    2. 在临时目录里 npm install 这些包（含 esbuild 自身）：
         @excalidraw/excalidraw / @excalidraw/mermaid-to-excalidraw / mermaid / react / react-dom / esbuild
    3. 把两个入口源码写进临时目录（本脚本内嵌，见下方 here-string），用 esbuild 打两份 IIFE：
         app.js      Excalidraw 组件 + 契约接口（全局 ExcalidrawApp）
         mermaid.js  Mermaid -> Excalidraw 转换器（全局 ExcalidrawMermaid，由 app.js 懒加载）
       mermaid 走 `--alias:@excalidraw/mermaid-to-excalidraw=<shim>` 从主 bundle 里摘掉（省约 3.5 MB），
       否则 Excalidraw 库内部对该包的静态引用会把 mermaid 一起打进 app.js。
    4. dist/prod/index.css 与 dist/prod/fonts/** 原样复制（esbuild 不碰它们；
       CSS 里的 ./fonts/… 相对路径因此仍然可解析）。
    5. tools/excalidraw-host/index.html 存在时复制为 tools/excalidraw/index.html
       （本脚本不生成、也不修改该文件的内容，它是父级/桥接层负责的资产）。
    6. 复制上游 LICENSE（随包分发需要）。
    7. 写 tools/excalidraw/.manifest.json（{version, pin, files:[{path, bytes, sha256}]}）。

    -Verify : 只校验已有产物（必需文件/目录、清单逐条 bytes/sha256、文件数、
              以及 bundle/CSS 引用到的每个字体文件都在磁盘上）。
    -Force  : 忽略「已是最新」判断，强制重新安装并打包。
    不加开关时：产物与 pin 完全一致则打印 up-to-date 并跳过（不联网、不 npm install）；
    若只有 index.html 与 tools/excalidraw-host/index.html 不同步（承载页还在迭代），
    则只重新同步这一个文件并刷新清单，不重跑 npm install。

    升级流程：改 tools/excalidraw.version 里对应的行再重跑本脚本。

    临时目录与 npm 缓存都建在 %TEMP%\diagramon-excalidraw-<guid>\ 下，脚本结束（含失败）时整棵删除，
    仓库里只留 tools/excalidraw/ 产物。
#>

# ========== 路径与常量 ==========
$ToolsPath = $PSScriptRoot
$VersionFile = Join-Path $ToolsPath "excalidraw.version"
$ExcalidrawDir = Join-Path $ToolsPath "excalidraw"
$HostSource = Join-Path $ToolsPath "excalidraw-host\index.html"
$HostDest = Join-Path $ExcalidrawDir "index.html"
# 离线守卫：承载页在 app.js 之前 <script src="./offline-guard.js">，
# 它把非本机 origin 的网络访问一律拒绝并上报（第三方应用内部的活文档式端点靠配置关不干净）。
$GuardSource = Join-Path $ToolsPath "offline-guard\offline-guard.js"
$GuardDest = Join-Path $ExcalidrawDir "offline-guard.js"

$AppJs = Join-Path $ExcalidrawDir "app.js"
$MermaidJs = Join-Path $ExcalidrawDir "mermaid.js"
$IndexCss = Join-Path $ExcalidrawDir "index.css"
$FontsDir = Join-Path $ExcalidrawDir "fonts"
$LicensesDir = Join-Path $ExcalidrawDir "licenses"
$ManifestFile = Join-Path $ExcalidrawDir ".manifest.json"

$RegistryMirror = "https://registry.npmmirror.com"

# pin 文件里必须出现的键（顺序无关），键名 -> npm 包名
$PinKeys = @{
    'excalidraw'             = '@excalidraw/excalidraw'
    'mermaid-to-excalidraw'  = '@excalidraw/mermaid-to-excalidraw'
    'mermaid'                = 'mermaid'
    'react'                  = 'react'
    'react-dom'              = 'react-dom'
    'esbuild'                = 'esbuild'
}
# 主 pin（记进清单 version，发布前与 tools/excalidraw.version 对照）
$PrimaryPinKey = 'excalidraw'

# 随包分发的上游许可证（npm 包内 LICENSE / LICENSE.md -> 产物 licenses/ 下的文件名）。
# @excalidraw/excalidraw 的 npm 包里**没有** LICENSE 文件（只有 dist/ + package.json + README.md），
# 它的 MIT 全文在仓库根 NOTICE 里给出，所以这里标记为可选：缺了只警告，不发许可证文本（不能编）。
$LicenseFiles = @(
    [pscustomobject]@{ Package = '@excalidraw/excalidraw'; Dest = 'excalidraw-LICENSE'; Required = $false }
    [pscustomobject]@{ Package = '@excalidraw/mermaid-to-excalidraw'; Dest = 'mermaid-to-excalidraw-LICENSE'; Required = $true }
    [pscustomobject]@{ Package = 'mermaid'; Dest = 'mermaid-LICENSE'; Required = $true }
    [pscustomobject]@{ Package = 'react'; Dest = 'react-LICENSE'; Required = $true }
    [pscustomobject]@{ Package = 'react-dom'; Dest = 'react-dom-LICENSE'; Required = $true }
)

# 最小闭环自检：这些文件缺任何一个，承载页就跑不起来（字体闭环另见 Test-FontClosure）。
$RequiredFiles = @(
    'app.js',
    'mermaid.js',
    'index.css',
    'index.html',
    'fonts/Assistant/Assistant-Regular.woff2',
    'fonts/Cascadia/CascadiaCode-Regular.woff2',
    'fonts/Virgil/Virgil-Regular.woff2',
    'fonts/Liberation/LiberationSans-Regular.woff2',
    'licenses/mermaid-to-excalidraw-LICENSE',
    'licenses/mermaid-LICENSE',
    'licenses/react-LICENSE',
    'licenses/react-dom-LICENSE'
)

# 字体族目录（Excalidraw 的字体按族分目录，缺一族就会有几款手写体/代码字体回退）
$RequiredFontDirs = @(
    'Assistant',
    'Cascadia',
    'ComicShanns',
    'Excalifont',
    'Liberation',
    'Lilita',
    'Nunito',
    'Virgil',
    'Xiaolai'
)

# ========== 内嵌的 bundle 入口源码 ==========
# 这些文件只在临时目录里存在（不落在仓库），所以内嵌在这里；改动后用 -Force 重跑。
$EntrySource = @'
// Diagramon 离线 Excalidraw bundle 入口。
// 由 esbuild 打成经典脚本 tools/excalidraw/app.js（IIFE，全局名 ExcalidrawApp）。
// 承载页 tools/excalidraw-host/index.html 的契约：
//   const api = await window.ExcalidrawApp.mount(el, onChange)   // 返回 Excalidraw api
//   const png = await window.ExcalidrawApp.exportPng({ scale: 2, transparent: true })
//   const converted = await window.ExcalidrawApp.convertMermaid('graph TD; A-->B;')
//   window.ExcalidrawApp.ready
//
// 全局对象就是本模块的导出命名空间（esbuild --global-name=ExcalidrawApp 的返回值），
// 所以这里必须用 export 声明；自己再写 window.ExcalidrawApp = ... 会被 IIFE 的返回值覆盖成空对象。
import React from "react";
import { createRoot } from "react-dom/client";
import {
  Excalidraw,
  convertToExcalidrawElements,
  serializeAsJSON,
  exportToBlob,
} from "@excalidraw/excalidraw";
import { parseMermaidToExcalidraw } from "./m2e-shim.js";

// 本脚本自身所在目录（= tools/excalidraw/），懒加载的 mermaid.js 相对它解析。
// 字体资源目录由承载页设置 window.EXCALIDRAW_ASSET_PATH 决定，本 bundle 不碰它。
const SELF_DIR = new URL(
  "./",
  (document.currentScript && document.currentScript.src) || document.baseURI,
);

/** 挂载完成后为 true。 */
export let ready = false;

/** Excalidraw 原生 imperative API（mount 完成前为 null）。 */
let nativeApi = null;
/** 懒加载 ./mermaid.js 的句柄；失败后允许重试。 */
let mermaidLoader = null;

function requireApi() {
  if (!nativeApi) {
    throw new Error("Excalidraw is not mounted yet");
  }
  return nativeApi;
}

/**
 * 把原生 API 的方法逐个绑定到普通对象上（承载页直接调 updateScene），
 * 再补一个 Excalidraw 库函数形式的 serializeAsJSON({ type })。
 */
function wrapApi(native) {
  const api = {};
  for (const key in native) {
    const value = native[key];
    api[key] = typeof value === "function" ? value.bind(native) : value;
  }
  api.serializeAsJSON = (options) =>
    serializeAsJSON(
      native.getSceneElements(),
      native.getAppState(),
      native.getFiles(),
      (options && options.type) || "local",
    );
  return api;
}

function loadMermaidBundle() {
  if (window.ExcalidrawMermaid) {
    return Promise.resolve();
  }
  if (!mermaidLoader) {
    mermaidLoader = new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.src = new URL("mermaid.js", SELF_DIR).href;
      script.onload = () => {
        if (window.ExcalidrawMermaid) {
          resolve();
        } else {
          mermaidLoader = null;
          reject(new Error("mermaid.js did not expose window.ExcalidrawMermaid"));
        }
      };
      script.onerror = () => {
        mermaidLoader = null;
        reject(new Error("failed to load ./mermaid.js"));
      };
      document.head.appendChild(script);
    });
  }
  return mermaidLoader;
}

/**
 * 挂载 <Excalidraw/> 到 container，返回 api。
 * @param {HTMLElement} container
 * @param {(elements: unknown[], appState: object, files: object) => void} [onChange]
 */
export function mount(container, onChange) {
  if (!container) {
    return Promise.reject(new Error("mount: container is empty"));
  }
  return new Promise((resolve, reject) => {
    const root = createRoot(container);
    const props = {
      initialData: { appState: { viewBackgroundColor: "#ffffff" } },
      excalidrawAPI: (native) => {
        nativeApi = native;
        const api = wrapApi(native);
        ready = true;
        resolve(api);
      },
    };
    if (typeof onChange === "function") {
      props.onChange = (elements, appState, files) => onChange(elements, appState, files);
    }
    try {
      root.render(
        React.createElement(
          "div",
          { style: { width: "100%", height: "100%" } },
          React.createElement(Excalidraw, props),
        ),
      );
    } catch (error) {
      reject(error);
    }
  });
}

function blobToDataUri(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error || new Error("failed to read exported PNG"));
    reader.readAsDataURL(blob);
  });
}

/**
 * 当前场景导出为 PNG。
 * @param {{ scale?: number, transparent?: boolean }} [options]
 * @returns {Promise<string>} data URI（data:image/png;base64,…）
 */
export async function exportPng(options) {
  const opts = options || {};
  const native = requireApi();
  const appState = native.getAppState();
  const blob = await exportToBlob({
    elements: native.getSceneElements(),
    appState: Object.assign({}, appState, {
      exportBackground: opts.transparent === false,
      exportScale: opts.scale > 0 ? opts.scale : appState.exportScale || 1,
    }),
    files: native.getFiles(),
    mimeType: "image/png",
    quality: 1,
  });
  return await blobToDataUri(blob);
}

/**
 * Mermaid 源码 -> Excalidraw 元素。
 * @param {string} source
 * @returns {Promise<{ elements: unknown[] }>}
 */
export async function convertMermaid(source, config) {
  if (typeof source !== "string" || !source.trim()) {
    throw new Error("convertMermaid: mermaid source is empty");
  }
  await loadMermaidBundle();
  const parsed = await parseMermaidToExcalidraw(source, config);
  const elements = convertToExcalidrawElements(parsed.elements, {
    regenerateIds: true,
  });
  return { elements: elements };
}
'@

$ShimSource = @'
// esbuild --alias:@excalidraw/mermaid-to-excalidraw=<本文件> 的别名目标。
// 主 bundle 因此不含 mermaid（约 3.5 MB），实现从 ./mermaid.js 懒加载；
// Excalidraw 库内部对 mermaid-to-excalidraw 的引用同样落到这里。
export async function parseMermaidToExcalidraw(definition, config) {
  const converter = window.ExcalidrawMermaid;
  if (!converter) {
    throw new Error(
      "Mermaid converter is not loaded. Load ./mermaid.js before calling convertMermaid.",
    );
  }
  return converter.parseMermaidToExcalidraw(definition, config);
}
'@

$MermaidSource = @'
// 懒加载 bundle：只把官方 Mermaid -> Excalidraw 转换器挂到全局。
// 由 esbuild 单独打成 tools/excalidraw/mermaid.js（IIFE）。
// 刻意不加 --global-name：esbuild 在没有 export 时会返回空对象并覆盖同名全局，
// 这里的全局由本文件自己赋值。
import { parseMermaidToExcalidraw } from "@excalidraw/mermaid-to-excalidraw";

window.ExcalidrawMermaid = { parseMermaidToExcalidraw: parseMermaidToExcalidraw };
'@

# ========== 工具函数 ==========

function Get-Sha256Hex {
    param([string]$Path)
    return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
}

function Write-Utf8NoBom {
    param([string]$Path, [string]$Text)
    $Encoding = New-Object System.Text.UTF8Encoding($false)
    [System.IO.File]::WriteAllText($Path, $Text, $Encoding)
}

function Read-Manifest {
    param([string]$Path)
    if (-not (Test-Path -LiteralPath $Path)) { return $null }
    try {
        return (Get-Content -Path $Path -Raw -Encoding UTF8 | ConvertFrom-Json)
    }
    catch {
        return $null
    }
}

function Join-Rel {
    # 清单里的相对路径统一用 '/' 书写，落到磁盘时换成 Windows 分隔符。
    param([string]$Root, [string]$Relative)
    return (Join-Path $Root ($Relative -replace '/', '\'))
}

function Get-Pins {
    # 解析 tools/excalidraw.version（key=value，每行一条，# 起始为注释）。
    if (-not (Test-Path -LiteralPath $VersionFile)) {
        Write-Host "错误: 缺少版本 pin 文件: $VersionFile" -ForegroundColor Red
        exit 1
    }
    $Pins = @{}
    foreach ($Line in (Get-Content -Path $VersionFile)) {
        $Text = $Line.Trim()
        if ($Text -eq '' -or $Text.StartsWith('#')) { continue }
        $Parts = $Text -split '=', 2
        if ($Parts.Count -ne 2) {
            Write-Host "错误: $VersionFile 里这行不是 key=value 形式: '$Text'" -ForegroundColor Red
            exit 1
        }
        $Key = $Parts[0].Trim()
        $Value = $Parts[1].Trim()
        if ($Value -notmatch '^\d+\.\d+\.\d+$') {
            Write-Host "错误: $VersionFile 里 $Key= 的值不是合法的语义化版本号: '$Value'" -ForegroundColor Red
            exit 1
        }
        $Pins[$Key] = $Value
    }
    foreach ($Key in $PinKeys.Keys) {
        if (-not $Pins.ContainsKey($Key)) {
            Write-Host "错误: $VersionFile 缺少必需的一行: $Key=<版本号>" -ForegroundColor Red
            exit 1
        }
    }
    return $Pins
}

function Get-PinFingerprint {
    # pin 文件内容指纹（去掉注释/空行、去空白、排序后拼接）。
    # 清单里记下它，这样「改了 pin 文件但没重跑」会被 -Verify 和 publish1-build.ps1 抓到，
    # 而不是拿着一份与当前 pin 不符的旧产物说 up-to-date。
    $Lines = @()
    foreach ($Line in (Get-Content -Path $VersionFile)) {
        $Text = $Line.Trim()
        if ($Text -eq '' -or $Text.StartsWith('#')) { continue }
        $Lines += $Text
    }
    return ((@($Lines | Sort-Object)) -join ';')
}

function Get-PinLabel {
    param($Pins)
    return ((@($PinKeys.Keys | Sort-Object | ForEach-Object { "$_=$($Pins[$_])" })) -join ' ')
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

function Get-ProductEntries {
    # 「一级条目 -> 文件数/字节数」，用于打印产物体积明细。
    param([string]$Root)
    $Entries = @()
    foreach ($Item in (Get-ChildItem -Path $Root -Force | Sort-Object Name)) {
        if ($Item.Name -eq '.manifest.json') { continue }
        if ($Item.PSIsContainer) {
            $Files = @(Get-ChildItem -Path $Item.FullName -Recurse -File -Force)
            $Bytes = 0
            foreach ($F in $Files) { $Bytes += $F.Length }
            $Entries += [pscustomobject]@{ name = "$($Item.Name)/"; files = $Files.Count; bytes = $Bytes }
        }
        else {
            $Entries += [pscustomobject]@{ name = $Item.Name; files = 1; bytes = $Item.Length }
        }
    }
    return @($Entries | Sort-Object -Property bytes -Descending)
}

function Format-Size {
    param([long]$Bytes)
    return ("{0:N2} MB" -f ($Bytes / 1MB))
}

function Write-ProductSummary {
    param([string]$Root, [string]$Title)
    if (-not (Test-Path -LiteralPath $Root)) {
        Write-Host "$Title (产物目录不存在: $Root)" -ForegroundColor Yellow
        return
    }
    $Entries = Get-ProductEntries -Root $Root
    $TotalFiles = 0
    $TotalBytes = 0
    foreach ($Row in $Entries) { $TotalFiles += $Row.files; $TotalBytes += $Row.bytes }
    Write-Host $Title -ForegroundColor Cyan
    Write-Host ("  {0,-24} {1,8} {2,16}" -f '条目', '文件数', '字节数') -ForegroundColor Gray
    foreach ($Row in $Entries) {
        Write-Host ("  {0,-24} {1,8} {2,16:N0}" -f $Row.name, $Row.files, $Row.bytes) -ForegroundColor Gray
    }
    Write-Host ("  {0,-24} {1,8} {2,16:N0}   ({3})" -f '合计', $TotalFiles, $TotalBytes, (Format-Size $TotalBytes)) -ForegroundColor Gray
}

function Test-FontClosure {
    # 返回 $null 表示通过，否则返回错误描述。
    # app.js / index.css 里出现的每个 fonts/**.woff2 引用都必须能在产物里找到文件，
    # 否则离线时那张图会缺字体（Excalidraw 会静默回退到默认字体）。
    $Text = [System.IO.File]::ReadAllText($AppJs) + [System.IO.File]::ReadAllText($IndexCss)
    $Refs = [regex]::Matches($Text, 'fonts/[A-Za-z0-9_-]+/[A-Za-z0-9_.-]+\.woff2') |
        ForEach-Object { $_.Value } | Sort-Object -Unique
    if ($Refs.Count -eq 0) {
        return "app.js/index.css 里没有任何 fonts/**.woff2 引用（打包或复制步骤可能出错）"
    }
    $Missing = @()
    foreach ($Ref in $Refs) {
        if (-not (Test-Path -LiteralPath (Join-Rel -Root $ExcalidrawDir -Relative $Ref))) {
            $Missing += $Ref
        }
    }
    if ($Missing.Count -gt 0) {
        $Head = ($Missing | Select-Object -First 5) -join ', '
        return "缺少 $($Missing.Count) 个被引用的字体文件: $Head"
    }
    return $null
}

function Test-ExcalidrawAssets {
    # 返回 $null 表示通过，否则返回错误描述。
    # -IgnoreHostPage: 跳过产物 index.html 的一致性检查（承载页单独迭代时的快捷路径用）。
    param([string]$PinnedVersion, [string]$PinFingerprint, [switch]$IgnoreHostPage)

    foreach ($Rel in $RequiredFiles) {
        if (-not (Test-Path -LiteralPath (Join-Rel -Root $ExcalidrawDir -Relative $Rel))) {
            return "缺少 $Rel"
        }
    }
    foreach ($Dir in $RequiredFontDirs) {
        if (-not (Test-Path -LiteralPath (Join-Rel -Root $ExcalidrawDir -Relative "fonts/$Dir"))) {
            return "缺少字体族目录 fonts/$Dir/"
        }
    }
    if (-not (Test-Path -LiteralPath $ManifestFile)) {
        return "缺少清单文件 $ManifestFile"
    }
    $Manifest = Read-Manifest -Path $ManifestFile
    if ($null -eq $Manifest) {
        return "清单文件无法解析: $ManifestFile"
    }
    if ($Manifest.version -ne $PinnedVersion) {
        return "清单版本($($Manifest.version))与 tools\excalidraw.version 里的 $PrimaryPinKey=$PinnedVersion 不一致"
    }
    if ($Manifest.pin -ne $PinFingerprint) {
        return "清单里的 pin 指纹与 tools\excalidraw.version 不符（pin 文件改过，需重跑本脚本）"
    }
    if ($null -eq $Manifest.licenses) {
        return "清单缺少 licenses 字段（随包分发的第三方许可证标识）"
    }
    $RecordedLicenses = @($Manifest.licenses.PSObject.Properties.Name)
    foreach ($Package in $PinKeys.Values) {
        if ($RecordedLicenses -notcontains $Package) {
            return "清单 licenses 里缺少 $Package"
        }
        $Declared = [string]$Manifest.licenses.PSObject.Properties[$Package].Value
        if ([string]::IsNullOrWhiteSpace($Declared)) {
            return "清单 licenses 里 $Package 的许可证标识为空"
        }
    }

    $Entries = @($Manifest.files)
    if ($IgnoreHostPage) {
        $Entries = @($Entries | Where-Object { $_.path -ne 'index.html' })
    }
    if ($Entries.Count -eq 0) {
        return "清单里没有任何文件记录"
    }
    $OnDisk = @(Get-FileRecords -Root $ExcalidrawDir)
    if ($IgnoreHostPage) {
        $OnDisk = @($OnDisk | Where-Object { $_.path -ne 'index.html' })
    }
    if ($OnDisk.Count -ne $Entries.Count) {
        return "产物文件数($($OnDisk.Count))与清单($($Entries.Count))不一致（产物被改动或清单过期）"
    }
    foreach ($Entry in $Entries) {
        $Path = Join-Rel -Root $ExcalidrawDir -Relative $Entry.path
        if (-not (Test-Path -LiteralPath $Path)) {
            return "清单里有但磁盘上没有: $($Entry.path)"
        }
        $Bytes = (Get-Item -LiteralPath $Path).Length
        if ([int64]$Entry.bytes -ne $Bytes) {
            return "$($Entry.path) 字节数不符: 实际 $Bytes, 清单 $($Entry.bytes)"
        }
        $Sha = Get-Sha256Hex -Path $Path
        if ($Sha -ne $Entry.sha256) {
            return "$($Entry.path) sha256 不符: 实际 $Sha, 清单 $($Entry.sha256)"
        }
    }
    return (Test-FontClosure)
}

function Get-LicensePairs {
    # 把「包名 -> 许可证标识」统一成有序表：构建路径传进来的是 hashtable，
    # 清单回读路径传进来的是 ConvertFrom-Json 出来的 PSCustomObject，两者都走 .PSObject.Properties。
    param($LicenseIds)
    $Pairs = [ordered]@{}
    foreach ($Property in $LicenseIds.PSObject.Properties) {
        $Pairs[$Property.Name] = [string]$Property.Value
    }
    return $Pairs
}

function Write-ExcalidrawManifest {
    # 写 tools/excalidraw/.manifest.json；files 为 Get-FileRecords 的记录，LicenseIds 为
    # 包名 -> 上游 package.json 声明的许可证标识。
    param([string]$PinnedVersion, [string]$PinFingerprint, $LicenseIds, $Records)

    $Licenses = Get-LicensePairs -LicenseIds $LicenseIds
    $LicensePackages = @($Licenses.Keys)
    $Builder = New-Object System.Text.StringBuilder
    [void]$Builder.AppendLine("{")
    [void]$Builder.AppendLine("  `"version`": `"$PinnedVersion`",")
    [void]$Builder.AppendLine("  `"pin`": `"$PinFingerprint`",")
    [void]$Builder.AppendLine("  `"licenses`": {")
    for ($i = 0; $i -lt $LicensePackages.Count; $i++) {
        $Package = $LicensePackages[$i]
        $Comma = if ($i -lt ($LicensePackages.Count - 1)) { "," } else { "" }
        [void]$Builder.AppendLine("    `"$Package`": `"$($Licenses[$Package])`"$Comma")
    }
    [void]$Builder.AppendLine("  },")
    [void]$Builder.AppendLine("  `"files`": [")
    for ($i = 0; $i -lt $Records.Count; $i++) {
        $Entry = $Records[$i]
        $Comma = if ($i -lt ($Records.Count - 1)) { "," } else { "" }
        [void]$Builder.AppendLine("    {")
        [void]$Builder.AppendLine("      `"path`": `"$($Entry.path)`",")
        [void]$Builder.AppendLine("      `"bytes`": $($Entry.bytes),")
        [void]$Builder.AppendLine("      `"sha256`": `"$($Entry.sha256)`"")
        [void]$Builder.AppendLine("    }$Comma")
    }
    [void]$Builder.AppendLine("  ]")
    [void]$Builder.AppendLine("}")
    Write-Utf8NoBom -Path $ManifestFile -Text $Builder.ToString()
}

function Get-HostPageStatus {
    # 承载页还在迭代时，不必为了改一行 HTML 重跑一次 npm install。
    # sync = $true 仅当「其余产物是好的、只有产物里的 index.html 需要从承载页重新同步」：
    #   - 产物缺 index.html（例如构建时承载页还没写好，或者文件被删了）；或
    #   - 清单里没有 index.html 条目；或
    #   - 产物里的 index.html 与清单一致（不是被人手改的）且与承载页内容不同（承载页改过）。
    # 返回 @{ sync = $true/$false }。
    if (-not (Test-Path -LiteralPath $HostSource)) {
        return @{ sync = $false }
    }
    if (-not (Test-Path -LiteralPath $ManifestFile)) {
        return @{ sync = $false }
    }
    $Manifest = Read-Manifest -Path $ManifestFile
    if ($null -eq $Manifest) {
        return @{ sync = $false }
    }
    if (-not (Test-Path -LiteralPath $HostDest)) {
        return @{ sync = $true }
    }
    $Entry = @($Manifest.files) | Where-Object { $_.path -eq 'index.html' } | Select-Object -First 1
    if ($null -eq $Entry) {
        return @{ sync = $true }
    }
    if ((Get-Sha256Hex -Path $HostDest) -ne $Entry.sha256) {
        # 产物里的 index.html 自己就被改过（不是承载页导致的），走完整重建
        return @{ sync = $false }
    }
    if ((Get-Sha256Hex -Path $HostSource) -eq $Entry.sha256) {
        # 没有漂移
        return @{ sync = $false }
    }
    return @{ sync = $true }
}

function Test-RequiredPackages {
    # 校验临时目录里实际装到的版本与 pin 一致（npm 解析出别的版本时当场报错），
    # 顺带取回每个包 package.json 声明的 license 标识（写进清单，供随包分发时核对归属）。
    param($Pins, [string]$BuildDir)
    $Versions = [ordered]@{}
    $Licenses = [ordered]@{}
    foreach ($Key in @($PinKeys.Keys | Sort-Object)) {
        $Package = $PinKeys[$Key]
        $PackageJson = Join-Path $BuildDir ("node_modules\" + ($Package -replace '/', '\') + "\package.json")
        if (-not (Test-Path -LiteralPath $PackageJson)) {
            return [pscustomobject]@{ problem = "临时目录里缺少 $Package"; versions = $null; licenses = $null }
        }
        $Meta = (Get-Content -Path $PackageJson -Raw -Encoding UTF8 | ConvertFrom-Json)
        if ($Meta.version -ne $Pins[$Key]) {
            return [pscustomobject]@{
                problem  = "$Package 实际装到 $($Meta.version)，pin 要求 $($Pins[$Key])"
                versions = $null
                licenses = $null
            }
        }
        $Versions[$Key] = $Meta.version
        $Declared = if ($Meta.license) { [string]$Meta.license } else { 'UNKNOWN' }
        $Licenses[$Package] = $Declared
    }
    return [pscustomobject]@{ problem = $null; versions = $Versions; licenses = $Licenses }
}

$Pins = Get-Pins
$PinnedVersion = $Pins[$PrimaryPinKey]
$PinFingerprint = Get-PinFingerprint
$PinLabel = Get-PinLabel -Pins $Pins

# ========== 仅校验模式 ==========
if ($Verify) {
    Write-Host "校验 Excalidraw 离线资源 (pin: $PinLabel)..." -ForegroundColor Cyan
    $Problem = Test-ExcalidrawAssets -PinnedVersion $PinnedVersion -PinFingerprint $PinFingerprint
    if ($Problem) {
        Write-Host "校验失败: $Problem" -ForegroundColor Red
        Write-Host "请重新运行 tools\fetch-excalidraw.ps1 获取资源。" -ForegroundColor Yellow
        exit 1
    }
    Write-Host "校验通过。" -ForegroundColor Green
    Write-Host "  pin: $PinLabel" -ForegroundColor Gray
    Write-Host "  app.js: $AppJs" -ForegroundColor Gray
    Write-Host "  sha256: $(Get-Sha256Hex -Path $AppJs)" -ForegroundColor Gray
    if (Test-Path -LiteralPath $HostDest) {
        Write-Host "  index.html: $((Get-Item -LiteralPath $HostDest).Length) 字节, sha256 $(Get-Sha256Hex -Path $HostDest)" -ForegroundColor Gray
    }
    Write-Host "  清单: $ManifestFile ($((@((Read-Manifest -Path $ManifestFile).files)).Count) 条文件记录)" -ForegroundColor Gray
    Write-ProductSummary -Root $ExcalidrawDir -Title "产物体积:"
    exit 0
}

# ========== 幂等：产物与 pin 完全一致时跳过（不联网、不 npm install） ==========
if (-not $Force) {
    # 承载页单独迭代：其余产物都是好的、只有 index.html 需要从 tools/excalidraw-host/index.html
    # 重新同步时，只复制这一个文件并刷新清单，不重跑 npm install。
    $HostStatus = Get-HostPageStatus
    if ($HostStatus.sync) {
        $OtherProblem = Test-ExcalidrawAssets -PinnedVersion $PinnedVersion -PinFingerprint $PinFingerprint -IgnoreHostPage
        if (-not $OtherProblem) {
            Copy-Item -LiteralPath $HostSource -Destination $HostDest -Force
            if (Test-Path -LiteralPath $GuardSource) {
                Copy-Item -LiteralPath $GuardSource -Destination $GuardDest -Force
                Write-Host "已复制离线守卫: $GuardSource -> $GuardDest" -ForegroundColor Gray
            }
            else {
                Write-Host "错误: 缺少离线守卫 $GuardSource（承载页依赖它，不能缺）" -ForegroundColor Red
                exit 1
            }
            $Manifest = Read-Manifest -Path $ManifestFile
            Write-ExcalidrawManifest -PinnedVersion $PinnedVersion -PinFingerprint $PinFingerprint `
                -LicenseIds $Manifest.licenses -Records (Get-FileRecords -Root $ExcalidrawDir)
            Write-Host "Excalidraw 离线资源已是最新 (pin: $PinLabel)，只重新同步了承载页 (up-to-date)。" -ForegroundColor Green
            Write-Host "  $HostSource -> $HostDest" -ForegroundColor Gray
            Write-Host "  index.html: $((Get-Item -LiteralPath $HostDest).Length) 字节, sha256 $(Get-Sha256Hex -Path $HostDest)" -ForegroundColor Gray
            exit 0
        }
    }

    $Problem = Test-ExcalidrawAssets -PinnedVersion $PinnedVersion -PinFingerprint $PinFingerprint
    if (-not $Problem) {
        Write-Host "Excalidraw 离线资源已是最新 (pin: $PinLabel)，跳过构建 (up-to-date)。" -ForegroundColor Green
        Write-Host "  app.js: $AppJs" -ForegroundColor Gray
        Write-Host "  sha256: $(Get-Sha256Hex -Path $AppJs)" -ForegroundColor Gray
        Write-ProductSummary -Root $ExcalidrawDir -Title "产物体积:"
        exit 0
    }
    Write-Host "需要重新构建: $Problem" -ForegroundColor Yellow
}

# ========== 选择 npm / node ==========
# 优先用内置 Node.js 便携版自带的 npm；不存在或不可用（tools/node 目前是半提交状态，只有 npm.cmd
# 没有 node.exe）时回退 PATH 上的 npm。用到哪个都会打印出来。
$NpmCandidates = @()
$BundledNpm = Join-Path $ToolsPath "node\npm.cmd"
if (Test-Path -LiteralPath $BundledNpm) {
    $NpmCandidates += $BundledNpm
}
else {
    Write-Host "未找到内置 npm ($BundledNpm)，回退到 PATH 上的 npm。" -ForegroundColor Yellow
}
$NpmCandidates += "npm"

$BundledNode = Join-Path $ToolsPath "node\node.exe"
if (Test-Path -LiteralPath $BundledNode) {
    $NodeExe = $BundledNode
}
else {
    $NodeExe = "node"
}

# ========== 临时工作区 ==========
$TempDir = Join-Path ([System.IO.Path]::GetTempPath()) ("diagramon-excalidraw-" + [guid]::NewGuid().ToString('N'))
$BuildDir = Join-Path $TempDir "build"
$SrcDir = Join-Path $BuildDir "src"
$OutDir = Join-Path $TempDir "out"
$CacheDir = Join-Path $TempDir "npm-cache"
New-Item -ItemType Directory -Path $SrcDir, $OutDir -Force | Out-Null

try {
    # ---------- 安装依赖 ----------
    $PackageSpecs = @()
    foreach ($Key in @($PinKeys.Keys | Sort-Object)) {
        $PackageSpecs += "$($PinKeys[$Key])@$($Pins[$Key])"
    }

    Write-Utf8NoBom -Path (Join-Path $BuildDir "package.json") -Text @'
{
  "name": "diagramon-excalidraw-build",
  "version": "1.0.0",
  "private": true,
  "description": "Throwaway workspace for tools/fetch-excalidraw.ps1 (deleted on exit)."
}
'@

    $Installed = $false
    $UsedNpm = $null
    $UsedRegistry = $null
    $RegistryAttempts = @($null, $RegistryMirror)

    foreach ($NpmExe in $NpmCandidates) {
        foreach ($Registry in $RegistryAttempts) {
            $RegistryLabel = if ($Registry) { $Registry } else { "默认 registry" }
            Write-Host "正在 npm install (npm: $NpmExe, registry: $RegistryLabel)..." -ForegroundColor Cyan

            $NpmArgs = @(
                "install", "--no-save", "--no-package-lock", "--no-audit", "--no-fund",
                "--loglevel=error", "--cache=$CacheDir"
            )
            if ($Registry) { $NpmArgs += "--registry=$Registry" }
            $NpmArgs += $PackageSpecs

            Push-Location $BuildDir
            try {
                $NpmOutput = & $NpmExe @NpmArgs 2>&1
                $NpmExit = $LASTEXITCODE
            }
            finally {
                Pop-Location
            }

            if (($NpmExit -eq 0) -and (Test-Path -LiteralPath (Join-Path $BuildDir "node_modules\esbuild\bin\esbuild"))) {
                $Installed = $true
                $UsedNpm = $NpmExe
                $UsedRegistry = $RegistryLabel
                break
            }

            Write-Host "  该来源失败 (exit=$NpmExit)，尝试下一个来源..." -ForegroundColor Yellow
            if ($NpmOutput) {
                $NpmOutput | Select-Object -Last 6 | ForEach-Object { Write-Host "    $_" -ForegroundColor DarkGray }
            }
        }
        if ($Installed) { break }
    }

    if (-not $Installed) {
        Write-Host "错误: 无法安装 Excalidraw 构建依赖（已尝试内置/系统 npm 与默认 registry/npmmirror）。" -ForegroundColor Red
        Write-Host "  需要的包: $($PackageSpecs -join ' ')" -ForegroundColor Yellow
        exit 1
    }
    Write-Host "依赖安装完成 (npm: $UsedNpm, registry: $UsedRegistry)。" -ForegroundColor Gray

    $PackageCheck = Test-RequiredPackages -Pins $Pins -BuildDir $BuildDir
    if ($PackageCheck.problem) {
        Write-Host "错误: $($PackageCheck.problem)" -ForegroundColor Red
        exit 1
    }

    # ---------- 写入口源码 ----------
    $EntryJsx = Join-Path $SrcDir "entry.jsx"
    Write-Utf8NoBom -Path $EntryJsx -Text $EntrySource
    $ShimJs = Join-Path $SrcDir "m2e-shim.js"
    Write-Utf8NoBom -Path $ShimJs -Text $ShimSource
    $MermaidEntry = Join-Path $SrcDir "mermaid-global.js"
    Write-Utf8NoBom -Path $MermaidEntry -Text $MermaidSource

    # ---------- esbuild 打包 ----------
    $EsbuildJs = Join-Path $BuildDir "node_modules\esbuild\bin\esbuild"
    # PowerShell 5.1 传参给原生程序时会把 `"` 吞掉，这里用 \" 让 esbuild 拿到 JSON 字符串 "production"。
    $DefineArg = '--define:process.env.NODE_ENV=\"production\"'
    $AliasTarget = ($ShimJs -replace '\\', '/')
    $AppOut = Join-Path $OutDir "app.js"
    $MermaidOut = Join-Path $OutDir "mermaid.js"

    $AppArgs = @(
        $EntryJsx, "--bundle", "--format=iife", "--target=chrome120",
        "--global-name=ExcalidrawApp", "--jsx=automatic", "--minify", "--legal-comments=none",
        $DefineArg, "--alias:@excalidraw/mermaid-to-excalidraw=$AliasTarget", "--outfile=$AppOut"
    )
    $MermaidArgs = @(
        $MermaidEntry, "--bundle", "--format=iife", "--target=chrome120",
        "--jsx=automatic", "--minify", "--legal-comments=none",
        $DefineArg, "--outfile=$MermaidOut"
    )

    Write-Host "正在打包 app.js（$($Pins['excalidraw']) + react $($Pins['react'])）..." -ForegroundColor Cyan
    Write-Host ("  " + $NodeExe + " " + $EsbuildJs + " " + (($AppArgs | ForEach-Object { if ($_ -match '\s') { "`"$_`"" } else { $_ } }) -join ' ')) -ForegroundColor DarkGray
    & $NodeExe $EsbuildJs @AppArgs
    if ($LASTEXITCODE -ne 0) {
        Write-Host "错误: esbuild 打包 app.js 失败 (exit=$LASTEXITCODE)。" -ForegroundColor Red
        exit 1
    }

    Write-Host "正在打包 mermaid.js（mermaid $($Pins['mermaid'])）..." -ForegroundColor Cyan
    Write-Host ("  " + $NodeExe + " " + $EsbuildJs + " " + (($MermaidArgs | ForEach-Object { if ($_ -match '\s') { "`"$_`"" } else { $_ } }) -join ' ')) -ForegroundColor DarkGray
    & $NodeExe $EsbuildJs @MermaidArgs
    if ($LASTEXITCODE -ne 0) {
        Write-Host "错误: esbuild 打包 mermaid.js 失败 (exit=$LASTEXITCODE)。" -ForegroundColor Red
        exit 1
    }

    # 产物自检：全局名、生产模式 React、mermaid 是否真的被摘出主 bundle。
    # 这三条都对应真实踩过的坑，不是形式检查：
    #   - 少了 `var ExcalidrawApp=` 说明 --global-name 没生效（承载页拿不到接口）；
    #   - 出现 react-dom.development 说明 --define 的引号被 PowerShell 吞了，打进的是开发版 React；
    #   - app.js 里出现 mermaid 解析器的字面量（mermaidAPI / flowchart-v2）说明 --alias 没生效
    #     （主 bundle 会白胖 3.5 MB）；反过来，少了 ExcalidrawMermaid 说明 m2e 的懒加载壳没进包，
    #     convertMermaid 会永远拿不到转换器。两者一起看才自圆其说。
    $AppText = [System.IO.File]::ReadAllText($AppOut)
    if ($AppText -notmatch 'var ExcalidrawApp\s*=') {
        Write-Host "错误: app.js 里没有找到全局 ExcalidrawApp（--global-name 未生效）。" -ForegroundColor Red
        exit 1
    }
    if ($AppText -match 'react-dom\.development') {
        Write-Host "错误: app.js 里出现 react-dom.development（--define:process.env.NODE_ENV 未生效）。" -ForegroundColor Red
        exit 1
    }
    if ($AppText -match 'mermaidAPI|flowchart-v2') {
        Write-Host "错误: app.js 里疑似打进了 mermaid（--alias 未生效）。" -ForegroundColor Red
        exit 1
    }
    if ($AppText -notmatch 'ExcalidrawMermaid') {
        Write-Host "错误: app.js 里没有 ExcalidrawMermaid（m2e 懒加载壳缺失）。" -ForegroundColor Red
        exit 1
    }

    # ---------- 落盘到 tools/excalidraw ----------
    if (Test-Path -LiteralPath $ExcalidrawDir) {
        Remove-Item -LiteralPath $ExcalidrawDir -Recurse -Force
    }
    New-Item -ItemType Directory -Path $ExcalidrawDir, $FontsDir, $LicensesDir -Force | Out-Null

    $ProdDir = Join-Path $BuildDir "node_modules\@excalidraw\excalidraw\dist\prod"
    if (-not (Test-Path -LiteralPath (Join-Path $ProdDir "index.css"))) {
        Write-Host "错误: 包内缺少 dist/prod/index.css: $ProdDir" -ForegroundColor Red
        exit 1
    }
    if (-not (Test-Path -LiteralPath (Join-Path $ProdDir "fonts"))) {
        Write-Host "错误: 包内缺少 dist/prod/fonts: $ProdDir" -ForegroundColor Red
        exit 1
    }

    Copy-Item -LiteralPath $AppOut -Destination $AppJs -Force
    Copy-Item -LiteralPath $MermaidOut -Destination $MermaidJs -Force
    Copy-Item -LiteralPath (Join-Path $ProdDir "index.css") -Destination $IndexCss -Force
    Copy-Item -Path (Join-Path $ProdDir "fonts\*") -Destination $FontsDir -Recurse -Force

    foreach ($License in $LicenseFiles) {
        $PackageDir = Join-Path $BuildDir ("node_modules\" + ($License.Package -replace '/', '\'))
        $Source = $null
        foreach ($Name in @("LICENSE", "LICENSE.md", "LICENSE.txt")) {
            $Candidate = Join-Path $PackageDir $Name
            if (Test-Path -LiteralPath $Candidate) { $Source = $Candidate; break }
        }
        if ($null -eq $Source) {
            if ($License.Required) {
                Write-Host "错误: 包内没有 LICENSE 文件: $PackageDir" -ForegroundColor Red
                exit 1
            }
            Write-Host "注意: $($License.Package) 的 npm 包里没有 LICENSE 文件，跳过（归属见仓库根 NOTICE）。" -ForegroundColor Yellow
            continue
        }
        Copy-Item -LiteralPath $Source -Destination (Join-Path $LicensesDir $License.Dest) -Force
    }

    if (Test-Path -LiteralPath $HostSource) {
        Copy-Item -LiteralPath $HostSource -Destination $HostDest -Force
        Write-Host "已复制承载页: $HostSource -> $HostDest" -ForegroundColor Gray
        if (Test-Path -LiteralPath $GuardSource) {
            Copy-Item -LiteralPath $GuardSource -Destination $GuardDest -Force
            Write-Host "已复制离线守卫: $GuardSource -> $GuardDest" -ForegroundColor Gray
        }
        else {
            Write-Host "错误: 缺少离线守卫 $GuardSource（承载页依赖它，不能缺）" -ForegroundColor Red
            exit 1
        }
    }
    else {
        Write-Host "未找到承载页 $HostSource，跳过 index.html 复制（本脚本不生成该文件）。" -ForegroundColor Yellow
    }

    # ---------- 清单 ----------
    # 先做一遍内容自检（清单还没写，这里只查必需文件与字体闭环），再写清单。
    $Problem = Test-FontClosure
    if ($Problem) {
        Write-Host "错误: $Problem" -ForegroundColor Red
        exit 1
    }

    $Records = Get-FileRecords -Root $ExcalidrawDir
    Write-ExcalidrawManifest -PinnedVersion $PinnedVersion -PinFingerprint $PinFingerprint `
        -LicenseIds $PackageCheck.licenses -Records $Records

    # ---------- 收尾自检 ----------
    $Problem = Test-ExcalidrawAssets -PinnedVersion $PinnedVersion -PinFingerprint $PinFingerprint
    if ($Problem) {
        Write-Host "错误: 构建完成但自检未通过: $Problem" -ForegroundColor Red
        exit 1
    }

    Write-Host ""
    Write-Host "Excalidraw 离线资源就绪。" -ForegroundColor Green
    Write-Host "  pin: $PinLabel" -ForegroundColor Gray
    Write-Host "  依赖来源: npm=$UsedNpm, registry=$UsedRegistry, node=$NodeExe" -ForegroundColor Gray
    Write-Host "  app.js: $AppJs" -ForegroundColor Gray
    Write-Host "  sha256: $(Get-Sha256Hex -Path $AppJs)" -ForegroundColor Gray
    Write-Host "  清单: $ManifestFile ($($Records.Count) 条文件记录)" -ForegroundColor Gray
    $LicensePairs = Get-LicensePairs -LicenseIds $PackageCheck.licenses
    Write-Host ("  第三方许可证: " + ((@($LicensePairs.Keys | ForEach-Object { "$_=$($LicensePairs[$_])" })) -join ', ')) -ForegroundColor Gray
    Write-ProductSummary -Root $ExcalidrawDir -Title "产物体积:"
}
finally {
    if (Test-Path -LiteralPath $TempDir) {
        Remove-Item -LiteralPath $TempDir -Recurse -Force -ErrorAction SilentlyContinue
    }
}

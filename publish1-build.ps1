param(
    [string]$Runtime = "win-x64",
    [switch]$Run,
    [switch]$English,
    [string]$Version,
    [string]$ManifestUrlPrefix = "",
    [switch]$CheckOnly
)

$null = chcp 65001
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
[Console]::InputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8

$ProjectPath = $PSScriptRoot
$CsprojPath = Join-Path $ProjectPath "Diagramon.csproj"
$PublishPath = Join-Path $ProjectPath "bin\Release\net10.0\$Runtime\publish"
$DistPath = Join-Path $ProjectPath "dist"
$BuildCountFile = Join-Path $ProjectPath ".build-count"

# ========== 前置校验：Graphviz WASM 渲染资源 ==========
# tools/graphviz 不入库（见 .gitignore），打包前必须确认已由 tools\fetch-graphviz.ps1 获取，
# 且 graphviz.js 的字节数/sha256 与 tools\graphviz\.manifest.json 一致。
# 校验放在 dotnet publish 之前，缺失或不匹配时直接退出，绝不产出残包。
$GraphvizDir = Join-Path $ProjectPath "tools\graphviz"
$GraphvizJs = Join-Path $GraphvizDir "graphviz.js"
$GraphvizManifest = Join-Path $GraphvizDir ".manifest.json"

$GraphvizProblem = $null
if (-not (Test-Path $GraphvizJs)) {
    $GraphvizProblem = "缺少 $GraphvizJs"
} elseif (-not (Test-Path $GraphvizManifest)) {
    $GraphvizProblem = "缺少清单文件 $GraphvizManifest"
} else {
    try {
        $GraphvizManifestData = Get-Content $GraphvizManifest -Raw -Encoding UTF8 | ConvertFrom-Json
    } catch {
        $GraphvizManifestData = $null
    }
    if ($null -eq $GraphvizManifestData) {
        $GraphvizProblem = "清单文件无法解析: $GraphvizManifest"
    } else {
        $GraphvizEntry = $GraphvizManifestData.files | Where-Object { $_.path -eq 'graphviz.js' } | Select-Object -First 1
        if ($null -eq $GraphvizEntry) {
            $GraphvizProblem = "清单缺少 graphviz.js 条目"
        } else {
            $GraphvizBytes = (Get-Item $GraphvizJs).Length
            $GraphvizSha = (Get-FileHash $GraphvizJs -Algorithm SHA256).Hash.ToLowerInvariant()
            if ([int64]$GraphvizEntry.bytes -ne $GraphvizBytes) {
                $GraphvizProblem = "graphviz.js 字节数不符: 实际 $GraphvizBytes, 清单 $($GraphvizEntry.bytes)"
            } elseif ($GraphvizSha -ne $GraphvizEntry.sha256) {
                $GraphvizProblem = "graphviz.js sha256 不符: 实际 $GraphvizSha, 清单 $($GraphvizEntry.sha256)"
            }
        }
    }
}

if ($GraphvizProblem) {
    if ($English) {
        Write-Host ""
        Write-Host "ERROR: Graphviz renderer asset check failed: $GraphvizProblem" -ForegroundColor Red
        Write-Host "Please run tools\fetch-graphviz.ps1 first to fetch the renderer assets." -ForegroundColor Yellow
    } else {
        Write-Host ""
        Write-Host "错误: Graphviz 渲染资源校验失败: $GraphvizProblem" -ForegroundColor Red
        Write-Host "请先运行 tools\fetch-graphviz.ps1 获取渲染资源。" -ForegroundColor Yellow
    }
    exit 1
}

if ($English) {
    Write-Host "Graphviz renderer assets verified." -ForegroundColor Gray
} else {
    Write-Host "Graphviz 渲染资源校验通过。" -ForegroundColor Gray
}

# ========== 前置校验：drawio 离线资源 ==========
# tools/drawio 不入库（见 .gitignore），打包前必须确认已由 tools\fetch-drawio.ps1 拉取并裁剪，
# 且 index.html 的字节数/sha256 与 tools\drawio\.manifest.json 一致。
# 同样放在 dotnet publish 之前，缺失或不匹配时直接退出，绝不产出缺少 drawio 渲染能力的残包。
$DrawioDir = Join-Path $ProjectPath "tools\drawio"
$DrawioIndex = Join-Path $DrawioDir "index.html"
$DrawioManifest = Join-Path $DrawioDir ".manifest.json"
$DrawioVersionFile = Join-Path $ProjectPath "tools\drawio.version"

# 最小闭环文件集，与 tools\fetch-drawio.ps1 里的 $RequiredFiles 保持一致
$DrawioRequired = @(
    "js\main.js",
    "js\bootstrap.js",
    "js\app.min.js",
    "js\PreConfig.js",
    "js\PostConfig.js",
    "js\shapes-14-6-5.min.js",
    "js\stencils.min.js",
    "js\extensions.min.js",
    "styles\grapheditor.css",
    "mxgraph\css\common.css",
    "resources\dia.txt",
    "math4\es5\startup.js"
)

$DrawioProblem = $null
if (-not (Test-Path $DrawioIndex)) {
    $DrawioProblem = "缺少 $DrawioIndex"
} elseif (-not (Test-Path $DrawioManifest)) {
    $DrawioProblem = "缺少清单文件 $DrawioManifest"
} else {
    try {
        $DrawioManifestData = Get-Content $DrawioManifest -Raw -Encoding UTF8 | ConvertFrom-Json
    } catch {
        $DrawioManifestData = $null
    }
    if ($null -eq $DrawioManifestData) {
        $DrawioProblem = "清单文件无法解析: $DrawioManifest"
    } elseif ((Test-Path $DrawioVersionFile) -and
        ($DrawioManifestData.version -ne (Get-Content $DrawioVersionFile -Raw).Trim())) {
        $DrawioProblem = "清单版本($($DrawioManifestData.version))与 tools\drawio.version 不一致"
    } else {
        $DrawioEntry = $DrawioManifestData.files | Where-Object { $_.path -eq 'index.html' } | Select-Object -First 1
        if ($null -eq $DrawioEntry) {
            $DrawioProblem = "清单缺少 index.html 条目"
        } else {
            $DrawioBytes = (Get-Item $DrawioIndex).Length
            $DrawioSha = (Get-FileHash $DrawioIndex -Algorithm SHA256).Hash.ToLowerInvariant()
            if ([int64]$DrawioEntry.bytes -ne $DrawioBytes) {
                $DrawioProblem = "index.html 字节数不符: 实际 $DrawioBytes, 清单 $($DrawioEntry.bytes)"
            } elseif ($DrawioSha -ne $DrawioEntry.sha256) {
                $DrawioProblem = "index.html sha256 不符: 实际 $DrawioSha, 清单 $($DrawioEntry.sha256)"
            } else {
                $DrawioMissing = @()
                foreach ($DrawioRel in $DrawioRequired) {
                    if (-not (Test-Path -LiteralPath (Join-Path $DrawioDir $DrawioRel))) {
                        $DrawioMissing += $DrawioRel
                    }
                }
                if ($DrawioMissing.Count -gt 0) {
                    $DrawioProblem = "缺少必需文件: $($DrawioMissing -join ', ')"
                }
            }
        }
    }
}

if ($DrawioProblem) {
    if ($English) {
        Write-Host ""
        Write-Host "ERROR: drawio asset check failed: $DrawioProblem" -ForegroundColor Red
        Write-Host "Please run tools\fetch-drawio.ps1 first to fetch the drawio assets." -ForegroundColor Yellow
    } else {
        Write-Host ""
        Write-Host "错误: drawio 资源校验失败: $DrawioProblem" -ForegroundColor Red
        Write-Host "请先运行 tools\fetch-drawio.ps1 获取资源。" -ForegroundColor Yellow
    }
    exit 1
}

if ($English) {
    Write-Host "drawio assets verified." -ForegroundColor Gray
} else {
    Write-Host "drawio 资源校验通过。" -ForegroundColor Gray
}

# ========== 前置校验：Excalidraw 离线资源 ==========
# tools/excalidraw 不入库（见 .gitignore），打包前必须确认已由 tools\fetch-excalidraw.ps1 用 esbuild 打包生成，
# 且 app.js 的字节数/sha256 与 tools/excalidraw/.manifest.json 一致、清单的 pin 指纹与 tools/excalidraw.version 一致。
# 同样放在 dotnet publish 之前，缺失或不匹配时直接退出，绝不产出缺少 Excalidraw 画布能力的残包。
$ExcalidrawDir = Join-Path $ProjectPath "tools\excalidraw"
$ExcalidrawApp = Join-Path $ExcalidrawDir "app.js"
$ExcalidrawManifest = Join-Path $ExcalidrawDir ".manifest.json"
$ExcalidrawVersionFile = Join-Path $ProjectPath "tools\excalidraw.version"

# 最小闭环文件集，与 tools\fetch-excalidraw.ps1 里的 $RequiredFiles 保持一致
$ExcalidrawRequired = @(
    "mermaid.js",
    "index.css",
    "index.html",
    "fonts\Assistant\Assistant-Regular.woff2",
    "fonts\Xiaolai",
    "licenses\mermaid-LICENSE"
)

# pin 指纹 = tools\excalidraw.version 去掉注释/空行、去空白、排序后拼接
# （口径与 tools\fetch-excalidraw.ps1 的 Get-PinFingerprint 一致，改了那边要同步改这边）
$ExcalidrawPin = $null
if (Test-Path $ExcalidrawVersionFile) {
    $ExcalidrawPin = ((@((Get-Content $ExcalidrawVersionFile) |
                    Where-Object { $_ -match '\S' -and $_ -notmatch '^\s*#' } |
                    ForEach-Object { $_.Trim() }) | Sort-Object) -join ';')
}

$ExcalidrawProblem = $null
if (-not (Test-Path $ExcalidrawApp)) {
    $ExcalidrawProblem = "缺少 $ExcalidrawApp"
} elseif (-not (Test-Path $ExcalidrawManifest)) {
    $ExcalidrawProblem = "缺少清单文件 $ExcalidrawManifest"
} elseif ([string]::IsNullOrWhiteSpace($ExcalidrawPin)) {
    $ExcalidrawProblem = "缺少版本 pin 文件或内容为空: $ExcalidrawVersionFile"
} else {
    try {
        $ExcalidrawManifestData = Get-Content $ExcalidrawManifest -Raw -Encoding UTF8 | ConvertFrom-Json
    } catch {
        $ExcalidrawManifestData = $null
    }
    if ($null -eq $ExcalidrawManifestData) {
        $ExcalidrawProblem = "清单文件无法解析: $ExcalidrawManifest"
    } elseif ($ExcalidrawManifestData.pin -ne $ExcalidrawPin) {
        $ExcalidrawProblem = "清单的 pin 指纹与 tools\excalidraw.version 不一致（改过 pin 文件后需重跑 tools\fetch-excalidraw.ps1）"
    } else {
        $ExcalidrawEntry = $ExcalidrawManifestData.files | Where-Object { $_.path -eq 'app.js' } | Select-Object -First 1
        if ($null -eq $ExcalidrawEntry) {
            $ExcalidrawProblem = "清单缺少 app.js 条目"
        } else {
            $ExcalidrawBytes = (Get-Item $ExcalidrawApp).Length
            $ExcalidrawSha = (Get-FileHash $ExcalidrawApp -Algorithm SHA256).Hash.ToLowerInvariant()
            if ([int64]$ExcalidrawEntry.bytes -ne $ExcalidrawBytes) {
                $ExcalidrawProblem = "app.js 字节数不符: 实际 $ExcalidrawBytes, 清单 $($ExcalidrawEntry.bytes)"
            } elseif ($ExcalidrawSha -ne $ExcalidrawEntry.sha256) {
                $ExcalidrawProblem = "app.js sha256 不符: 实际 $ExcalidrawSha, 清单 $($ExcalidrawEntry.sha256)"
            } else {
                $ExcalidrawMissing = @()
                foreach ($ExcalidrawRel in $ExcalidrawRequired) {
                    if (-not (Test-Path -LiteralPath (Join-Path $ExcalidrawDir $ExcalidrawRel))) {
                        $ExcalidrawMissing += $ExcalidrawRel
                    }
                }
                if ($ExcalidrawMissing.Count -gt 0) {
                    $ExcalidrawProblem = "缺少必需文件: $($ExcalidrawMissing -join ', ')"
                }
            }
        }
    }
}

if ($ExcalidrawProblem) {
    if ($English) {
        Write-Host ""
        Write-Host "ERROR: Excalidraw asset check failed: $ExcalidrawProblem" -ForegroundColor Red
        Write-Host "Please run tools\fetch-excalidraw.ps1 first to build the Excalidraw bundle." -ForegroundColor Yellow
    } else {
        Write-Host ""
        Write-Host "错误: Excalidraw 离线资源校验失败: $ExcalidrawProblem" -ForegroundColor Red
        Write-Host "请先运行 tools\fetch-excalidraw.ps1 打包 Excalidraw 资源。" -ForegroundColor Yellow
    }
    exit 1
}

if ($English) {
    Write-Host "Excalidraw assets verified." -ForegroundColor Gray
} else {
    Write-Host "Excalidraw 资源校验通过。" -ForegroundColor Gray
}

if ($CheckOnly) {
    if ($English) {
        Write-Host "Check-only mode: publish skipped." -ForegroundColor Gray
    } else {
        Write-Host "仅校验模式: 未执行打包。" -ForegroundColor Gray
    }
    exit 0
}

if ($English) {
    Write-Host "Building Diagramon..." -ForegroundColor Cyan
    Write-Host "Target platform: $Runtime" -ForegroundColor Gray
} else {
    Write-Host "正在打包 Diagramon..." -ForegroundColor Cyan
    Write-Host "目标平台: $Runtime" -ForegroundColor Gray
}

$CsprojContent = Get-Content $CsprojPath -Raw

if ([string]::IsNullOrWhiteSpace($Version)) {
    if ($CsprojContent -match '<Version>(\d+)\.(\d+)') {
        $Major = $matches[1]
        $Minor = $matches[2]
    } else {
        $Major = "1"
        $Minor = "0"
    }
    
    $DateRevision = Get-Date -Format "yyMMdd"
    
    $BuildCount = 0
    $TodayStr = Get-Date -Format "yyyy-MM-dd"
    if (Test-Path $BuildCountFile) {
        $CountContent = Get-Content $BuildCountFile -ErrorAction SilentlyContinue
        if ($CountContent -match '^(\d{4}-\d{2}-\d{2})\|(\d+)$') {
            if ($matches[1] -eq $TodayStr) {
                $BuildCount = [int]$matches[2] + 1
            } else {
                $BuildCount = 0
            }
        }
    }
    Set-Content -Path $BuildCountFile -Value "$TodayStr|$BuildCount" -NoNewline
    
    $Version = "$Major.$Minor.$DateRevision.$BuildCount"
}

if ($English) {
    Write-Host "Version: $Version" -ForegroundColor Gray
} else {
    Write-Host "版本号: $Version" -ForegroundColor Gray
}

$VersionParts = $Version.Split('.')
$Major = $VersionParts[0]
$Minor = if ($VersionParts.Length -gt 1) { $VersionParts[1] } else { "0" }
$Revision = if ($VersionParts.Length -gt 2) { $VersionParts[2] } else { "0" }
$BuildNum = if ($VersionParts.Length -gt 3) { $VersionParts[3] } else { "0" }
$AssemblyVersion = "$Major.$Minor.0.0"

$DateCode = Get-Date -Format "yyMMdd"
$BuildPart = [math]::Min([int]$DateCode.Substring(0, 3), 65534)
$RevisionPart = [math]::Min([int]$DateCode.Substring(3, 3), 65534)
$FileVersion = "$Major.$Minor.$BuildPart.$RevisionPart"

$CsprojContent = $CsprojContent -replace '<Version>.*?</Version>', "<Version>$Version</Version>"
$CsprojContent = $CsprojContent -replace '<AssemblyVersion>.*?</AssemblyVersion>', "<AssemblyVersion>$AssemblyVersion</AssemblyVersion>"
$CsprojContent = $CsprojContent -replace '<FileVersion>.*?</FileVersion>', "<FileVersion>$FileVersion</FileVersion>"

Set-Content -Path $CsprojPath -Value $CsprojContent -NoNewline

dotnet publish $ProjectPath `
    -c Release `
    -r $Runtime `
    --self-contained true

if ($LASTEXITCODE -ne 0) {
    if ($English) {
        Write-Host "`nBuild failed!" -ForegroundColor Red
    } else {
        Write-Host "`n打包失败!" -ForegroundColor Red
    }
    exit 1
}

$ToolsSourcePath = Join-Path $ProjectPath "tools"
$ToolsDestPath = Join-Path $PublishPath "tools"

# ========== 确保内置 Chrome Headless Shell ==========
# Mermaid CLI 通过 puppeteer 渲染，需要 Chrome for Testing (headless shell)。
# 发布包必须自带浏览器，否则用户机器上"保存/复制"会报
# "Could not find Chrome (ver. ...)"。这里从 npmmirror 镜像下载对应版本，
# 解压到 tools/puppeteer-cache 随包发布（mmdc.cmd 通过 PUPPETEER_CACHE_DIR 指向它）。
if (Test-Path $ToolsSourcePath) {
    $PuppeteerCacheDir = Join-Path $ToolsSourcePath "puppeteer-cache"

    $Platform = switch ($Runtime) {
        'win-x86'   { 'win32' }
        'linux-x64' { 'linux64' }
        'osx-x64'   { 'mac-x64' }
        'osx-arm64' { 'mac-arm64' }
        default     { 'win64' }
    }

    $NodeExe = if (Test-Path (Join-Path $ToolsSourcePath "node\node.exe")) {
        Join-Path $ToolsSourcePath "node\node.exe"
    } else {
        "node"
    }

    # 读取 puppeteer-core 固定的 chrome-headless-shell 版本号
    $RevisionScript = @'
const fs = require('fs');
const path = require('path');
const base = path.join(process.cwd(), 'node_modules', 'puppeteer-core', 'lib');
for (const m of ['cjs', 'esm']) {
  const f = path.join(base, m, 'puppeteer', 'revisions.js');
  if (fs.existsSync(f)) {
    const m2 = fs.readFileSync(f, 'utf8').match(/'chrome-headless-shell':\s*'([^']+)'/);
    if (m2) { process.stdout.write(m2[1]); break; }
  }
}
'@
    $RevisionFile = Join-Path $env:TEMP "mermaider-revision.js"
    [System.IO.File]::WriteAllText($RevisionFile, $RevisionScript)
    Push-Location $ToolsSourcePath
    $BuildId = & $NodeExe $RevisionFile
    Pop-Location
    Remove-Item $RevisionFile -Force -ErrorAction SilentlyContinue

    if ([string]::IsNullOrWhiteSpace($BuildId)) {
        if ($English) {
            Write-Host "WARNING: cannot read puppeteer revision, skipping bundled Chrome." -ForegroundColor Yellow
        } else {
            Write-Host "警告: 无法读取 puppeteer 版本号，跳过内置 Chrome 步骤" -ForegroundColor Yellow
        }
    }
    else {
        # 计算 puppeteer 期望的可执行文件完整路径（含缓存目录结构）
        $ComputeScript = @'
const { computeExecutablePath, Browser, BrowserPlatform } = require('@puppeteer/browsers');
const [buildId, platform, cacheDir] = process.argv.slice(2);
try {
  process.stdout.write(computeExecutablePath({
    browser: Browser.CHROME_HEADLESS_SHELL,
    buildId,
    platform: BrowserPlatform[platform],
    cacheDir,
  }));
} catch {
  const path = require('path');
  process.stdout.write(path.join(cacheDir, 'chrome-headless-shell', platform + '-' + buildId, 'chrome-headless-shell-' + platform, 'chrome-headless-shell.exe'));
}
'@
        $ComputeFile = Join-Path $env:TEMP "mermaider-compute.js"
        [System.IO.File]::WriteAllText($ComputeFile, $ComputeScript)
        $env:NODE_PATH = Join-Path $ToolsSourcePath "node_modules"
        $ShellExe = & $NodeExe $ComputeFile $BuildId $Platform $PuppeteerCacheDir
        Remove-Item $ComputeFile -Force -ErrorAction SilentlyContinue

        if (Test-Path $ShellExe) {
            if ($English) {
                Write-Host "Bundled Chrome headless shell found: $ShellExe" -ForegroundColor Gray
            } else {
                Write-Host "内置 Chrome headless shell 已存在: $ShellExe" -ForegroundColor Gray
            }
        }
        else {
            $ZipName = "chrome-headless-shell-$Platform.zip"
            $ZipPath = Join-Path $env:TEMP $ZipName
            $PlatformDir = Split-Path (Split-Path $ShellExe -Parent) -Parent
            $ShellRoot = Split-Path $PlatformDir -Parent
            $MirrorUrl = "https://registry.npmmirror.com/-/binary/chrome-for-testing/$BuildId/$Platform/$ZipName"
            $OfficialUrl = "https://storage.googleapis.com/chrome-for-testing-public/$BuildId/$Platform/$ZipName"

            if ($English) {
                Write-Host "Downloading Chrome headless shell $BuildId ($Platform)..." -ForegroundColor Cyan
            } else {
                Write-Host "正在下载 Chrome headless shell $BuildId ($Platform)..." -ForegroundColor Cyan
            }
            try {
                Invoke-WebRequest -Uri $MirrorUrl -OutFile $ZipPath -UseBasicParsing -ErrorAction Stop
            }
            catch {
                if ($English) {
                    Write-Host "npmmirror download failed, falling back to official source..." -ForegroundColor Yellow
                } else {
                    Write-Host "npmmirror 下载失败，回退官方源..." -ForegroundColor Yellow
                }
                Invoke-WebRequest -Uri $OfficialUrl -OutFile $ZipPath -UseBasicParsing -ErrorAction Stop
            }

            Expand-Archive -Path $ZipPath -DestinationPath $ShellRoot -Force
            New-Item -ItemType Directory -Path $PlatformDir -Force | Out-Null
            $ExtractedDir = Join-Path $ShellRoot ($ZipName.Replace('.zip', ''))
            if ((Split-Path $ExtractedDir -Leaf) -ne (Split-Path $PlatformDir -Leaf)) {
                Move-Item -Path $ExtractedDir -Destination (Join-Path $PlatformDir (Split-Path $ExtractedDir -Leaf)) -Force
            }
            Remove-Item $ZipPath -Force -ErrorAction SilentlyContinue

            if (Test-Path $ShellExe) {
                if ($English) {
                    Write-Host "Bundled Chrome headless shell ready: $ShellExe" -ForegroundColor Green
                } else {
                    Write-Host "内置 Chrome headless shell 就绪: $ShellExe" -ForegroundColor Green
                }
            }
            else {
                if ($English) {
                    Write-Host "ERROR: failed to bundle Chrome headless shell" -ForegroundColor Red
                } else {
                    Write-Host "错误: 内置 Chrome headless shell 准备失败" -ForegroundColor Red
                }
            }
        }
    }
}

# ========== 确保内置 Node.js 运行时 ==========
# 发布包必须自带 Node.js，否则用户机器上 mmdc 无法启动
# （报 "'node' 不是内部或外部命令"）。这里从 npmmirror 镜像下载
# 便携版并解压到 tools/node，随包发布（mmdc.cmd 通过 PATH 指向它）。
if (Test-Path $ToolsSourcePath) {
    $ToolsNodeExe = Join-Path $ToolsSourcePath "node\node.exe"
    if (-not (Test-Path $ToolsNodeExe)) {
        $NodeArch = if ($Runtime -eq 'win-x86') { 'win-x86' } else { 'win-x64' }
        $NodeVersion = "v22.23.2"   # Node.js LTS (Jod)，升级时在此更新
        $NodeZipName = "node-$NodeVersion-$NodeArch.zip"
        $NodeZipPath = Join-Path $env:TEMP $NodeZipName
        $NodeExtractRoot = Join-Path $env:TEMP ("node-extract-" + [guid]::NewGuid().ToString('N'))
        $NodeMirrorUrl = "https://registry.npmmirror.com/-/binary/node/$NodeVersion/$NodeZipName"
        $NodeOfficialUrl = "https://nodejs.org/dist/$NodeVersion/$NodeZipName"

        if ($English) {
            Write-Host "Downloading Node.js $NodeVersion ($NodeArch)..." -ForegroundColor Cyan
        } else {
            Write-Host "正在下载 Node.js $NodeVersion ($NodeArch)..." -ForegroundColor Cyan
        }
        try {
            Invoke-WebRequest -Uri $NodeMirrorUrl -OutFile $NodeZipPath -UseBasicParsing -ErrorAction Stop
        }
        catch {
            if ($English) {
                Write-Host "npmmirror download failed, falling back to official source..." -ForegroundColor Yellow
            } else {
                Write-Host "npmmirror 下载失败，回退官方源..." -ForegroundColor Yellow
            }
            Invoke-WebRequest -Uri $NodeOfficialUrl -OutFile $NodeZipPath -UseBasicParsing -ErrorAction Stop
        }

        Expand-Archive -Path $NodeZipPath -DestinationPath $NodeExtractRoot -Force
        $NodeExtractedDir = Join-Path $NodeExtractRoot ($NodeZipName.Replace('.zip', ''))
        $ToolsNodeDir = Join-Path $ToolsSourcePath "node"
        New-Item -ItemType Directory -Path $ToolsNodeDir -Force | Out-Null
        Copy-Item -Path "$NodeExtractedDir\*" -Destination $ToolsNodeDir -Recurse -Force
        Remove-Item $NodeZipPath -Force -ErrorAction SilentlyContinue
        Remove-Item $NodeExtractRoot -Recurse -Force -ErrorAction SilentlyContinue

        if (Test-Path $ToolsNodeExe) {
            if ($English) {
                Write-Host "Bundled Node.js ready: $ToolsNodeExe" -ForegroundColor Green
            } else {
                Write-Host "内置 Node.js 就绪: $ToolsNodeExe" -ForegroundColor Green
            }
        }
        else {
            if ($English) {
                Write-Host "ERROR: failed to bundle Node.js" -ForegroundColor Red
            } else {
                Write-Host "错误: 内置 Node.js 准备失败" -ForegroundColor Red
            }
        }
    }
    else {
        if ($English) {
            Write-Host "Bundled Node.js found: $ToolsNodeExe" -ForegroundColor Gray
        } else {
            Write-Host "内置 Node.js 已存在: $ToolsNodeExe" -ForegroundColor Gray
        }
    }
}

if (Test-Path $ToolsSourcePath) {
    if (-not (Test-Path $ToolsDestPath)) {
        New-Item -ItemType Directory -Path $ToolsDestPath -Force | Out-Null
    }
    Copy-Item -Path "$ToolsSourcePath\*" -Destination $ToolsDestPath -Recurse -Force
    if ($English) {
        Write-Host "Tools copied to publish directory." -ForegroundColor Gray
    } else {
        Write-Host "工具已复制到发布目录。" -ForegroundColor Gray
    }
}

# Remove unnecessary .map and .d.ts files from publish output
$mapFiles = Get-ChildItem -Path $PublishPath -Recurse -Include *.map,*.d.ts -File -ErrorAction SilentlyContinue
$removedCount = $mapFiles.Count
$mapFiles | Remove-Item -Force -ErrorAction SilentlyContinue
if ($removedCount -gt 0) {
    if ($English) {
        Write-Host "Cleaned up $removedCount .map/.d.ts files." -ForegroundColor Gray
    } else {
        Write-Host "清理了 $removedCount 个 .map/.d.ts 文件" -ForegroundColor Gray
    }
}

if (Test-Path $DistPath) {
    Remove-Item -Path $DistPath -Recurse -Force
}
New-Item -ItemType Directory -Path $DistPath -Force | Out-Null

$ZipFileName = "Diagramon-$Version-$Runtime.zip"
$ZipFilePath = Join-Path $DistPath $ZipFileName

if ($English) {
    Write-Host "Creating ZIP archive..." -ForegroundColor Cyan
} else {
    Write-Host "正在创建 ZIP 压缩包..." -ForegroundColor Cyan
}

Add-Type -AssemblyName System.IO.Compression.FileSystem
$ZipArchive = [System.IO.Compression.ZipFile]::Open($ZipFilePath, 'Create')
$CompressionLevel = [System.IO.Compression.CompressionLevel]::Optimal

Get-ChildItem -Path $PublishPath -Recurse -File | ForEach-Object {
    $relativePath = $_.FullName.Substring($PublishPath.Length + 1)
    $entry = $ZipArchive.CreateEntry($relativePath, $CompressionLevel)
    $entryStream = $entry.Open()
    $fileStream = $_.OpenRead()
    try {
        $fileStream.CopyTo($entryStream)
    }
    finally {
        $fileStream.Dispose()
        $entryStream.Dispose()
    }
}

$ZipArchive.Dispose()

if (Test-Path $ZipFilePath) {
    $ZipInfo = Get-Item $ZipFilePath
    $SizeMB = [math]::Round($ZipInfo.Length / 1MB, 2)
    
    $PublishSize = (Get-ChildItem -Path $PublishPath -Recurse -File | Measure-Object -Property Length -Sum).Sum
    $PublishSizeMB = [math]::Round($PublishSize / 1MB, 2)
    
    $ManifestPath = Join-Path $ProjectPath "update-manifest.json"
    $DownloadUrl = if ([string]::IsNullOrWhiteSpace($ManifestUrlPrefix)) { "" } else { "$ManifestUrlPrefix/$ZipFileName" }
    $Manifest = @{
        version      = $Version
        downloadUrl  = $DownloadUrl
        releaseNotes = ""
        zipFileName  = $ZipFileName
        zipFileSize  = $ZipInfo.Length
        publishedAt  = (Get-Date -Format "o")
    }
    $ManifestJson = $Manifest | ConvertTo-Json
    Set-Content -Path $ManifestPath -Value $ManifestJson -Encoding UTF8

    if ($English) {
        Write-Host "`nBuild succeeded!" -ForegroundColor Green
        Write-Host "Version: $Version" -ForegroundColor Yellow
        Write-Host "ZIP path: $ZipFilePath" -ForegroundColor Yellow
        Write-Host "ZIP size: $SizeMB MB" -ForegroundColor Yellow
        Write-Host "Extracted size: $PublishSizeMB MB" -ForegroundColor Gray
        Write-Host "Manifest: $ManifestPath" -ForegroundColor Gray
        
        if ($Run) {
            Write-Host "`nLaunching application..." -ForegroundColor Cyan
            Start-Process (Join-Path $PublishPath "Diagramon.exe")
        }
    } else {
        Write-Host "`n打包成功!" -ForegroundColor Green
        Write-Host "版本号: $Version" -ForegroundColor Yellow
        Write-Host "ZIP路径: $ZipFilePath" -ForegroundColor Yellow
        Write-Host "ZIP大小: $SizeMB MB" -ForegroundColor Yellow
        Write-Host "解压后大小: $PublishSizeMB MB" -ForegroundColor Gray
        Write-Host "清单文件: $ManifestPath" -ForegroundColor Gray
        
        if ($Run) {
            Write-Host "`n启动程序..." -ForegroundColor Cyan
            Start-Process (Join-Path $PublishPath "Diagramon.exe")
        }
    }
} else {
    if ($English) {
        Write-Host "`nFailed to create ZIP archive!" -ForegroundColor Red
    } else {
        Write-Host "`n创建 ZIP 压缩包失败!" -ForegroundColor Red
    }
    exit 1
}

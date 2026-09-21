param(
    [switch]$Verify,
    [switch]$Force
)

# ========== 编码处理（与 publish1-build.ps1 一致） ==========
$null = chcp 65001
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
[Console]::InputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8

# ========== 路径与常量 ==========
$ToolsPath = $PSScriptRoot
$VersionFile = Join-Path $ToolsPath "graphviz.version"
$GraphvizDir = Join-Path $ToolsPath "graphviz"
$GraphvizJs = Join-Path $GraphvizDir "graphviz.js"
$LicenseFile = Join-Path $GraphvizDir "LICENSE"
$ManifestFile = Join-Path $GraphvizDir ".manifest.json"

$PackageName = "@hpcc-js/wasm-graphviz"
# npm 包 package.json 元数据：author = hpcc-systems, license = Apache-2.0
$PackageAuthor = "hpcc-systems"
$PackageLicenseId = "Apache-2.0"
$RegistryMirror = "https://registry.npmmirror.com"

# ========== 工具函数 ==========

function Get-Sha256Hex {
    param([string]$Path)
    return (Get-FileHash -Path $Path -Algorithm SHA256).Hash.ToLowerInvariant()
}

function Get-PinnedVersion {
    if (-not (Test-Path $VersionFile)) {
        Write-Host "错误: 缺少版本 pin 文件: $VersionFile" -ForegroundColor Red
        exit 1
    }
    $Pinned = (Get-Content -Path $VersionFile -Raw).Trim()
    if ($Pinned -notmatch '^\d+\.\d+\.\d+$') {
        Write-Host "错误: $VersionFile 内容不是合法的语义化版本号: '$Pinned'" -ForegroundColor Red
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

function Test-LicenseAttribution {
    # 返回 $null 表示通过，否则返回错误描述。
    # LICENSE 必须是从 npm 包原样取出的 Apache-2.0 正文（含上游版权模板），
    # 否则视为归属信息被改动，与包声明的 Apache-2.0 不一致。
    if (-not (Test-Path $LicenseFile)) {
        return "缺少 $LicenseFile（随包分发的 $PackageLicenseId 归属声明）"
    }
    $Text = Get-Content -Path $LicenseFile -Raw
    if ([string]::IsNullOrWhiteSpace($Text)) {
        return "$LicenseFile 内容为空"
    }
    if (($Text -notmatch 'Apache License') -or ($Text -notmatch 'Version 2\.0')) {
        return "$LicenseFile 不是 Apache-2.0 许可证正文（$PackageName 声明为 $PackageLicenseId）"
    }
    if ($Text -notmatch 'Copyright \[yyyy\] \[name of copyright owner\]') {
        return "$LicenseFile 的上游归属信息被改动（缺少 Apache-2.0 附录版权模板行）"
    }
    return $null
}

function Test-GraphvizAssets {
    # 返回 $null 表示通过，否则返回错误描述。
    param([string]$PinnedVersion)

    if (-not (Test-Path $GraphvizJs)) {
        return "缺少 $GraphvizJs"
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
    $Entry = $Manifest.files | Where-Object { $_.path -eq 'graphviz.js' } | Select-Object -First 1
    if ($null -eq $Entry) {
        return "清单缺少 graphviz.js 条目"
    }
    $Bytes = (Get-Item -Path $GraphvizJs).Length
    if ([int64]$Entry.bytes -ne $Bytes) {
        return "graphviz.js 字节数不符: 实际 $Bytes, 清单 $($Entry.bytes)"
    }
    $Sha = Get-Sha256Hex -Path $GraphvizJs
    if ($Sha -ne $Entry.sha256) {
        return "graphviz.js sha256 不符: 实际 $Sha, 清单 $($Entry.sha256)"
    }
    return (Test-LicenseAttribution)
}

$PinnedVersion = Get-PinnedVersion
$PackageSpec = "$PackageName@$PinnedVersion"

# ========== 仅校验模式 ==========
if ($Verify) {
    Write-Host "校验 Graphviz 渲染资源 ($PackageSpec)..." -ForegroundColor Cyan
    $Problem = Test-GraphvizAssets -PinnedVersion $PinnedVersion
    if ($Problem) {
        Write-Host "校验失败: $Problem" -ForegroundColor Red
        Write-Host "请重新运行 tools\fetch-graphviz.ps1 获取资源。" -ForegroundColor Yellow
        exit 1
    }
    $Bytes = (Get-Item -Path $GraphvizJs).Length
    $Sha = Get-Sha256Hex -Path $GraphvizJs
    Write-Host "校验通过。" -ForegroundColor Green
    Write-Host "  产物: $GraphvizJs ($Bytes 字节)" -ForegroundColor Gray
    Write-Host "  sha256: $Sha" -ForegroundColor Gray
    Write-Host "  归属: $LicenseFile ($PackageName, author=$PackageAuthor, license=$PackageLicenseId)" -ForegroundColor Gray
    Write-Host "  清单: $ManifestFile" -ForegroundColor Gray
    exit 0
}

# ========== 幂等：内容与 pin 版本一致时跳过下载 ==========
if (-not $Force) {
    $Problem = Test-GraphvizAssets -PinnedVersion $PinnedVersion
    if (-not $Problem) {
        $Bytes = (Get-Item -Path $GraphvizJs).Length
        $Sha = Get-Sha256Hex -Path $GraphvizJs
        Write-Host "Graphviz 渲染资源已是最新 ($PackageSpec)，跳过下载 (up-to-date)。" -ForegroundColor Green
        Write-Host "  产物: $GraphvizJs ($Bytes 字节)" -ForegroundColor Gray
        Write-Host "  sha256: $Sha" -ForegroundColor Gray
        exit 0
    }
    Write-Host "需要重新获取: $Problem" -ForegroundColor Yellow
}

# ========== 选择 npm ==========
# 优先使用内置 Node.js 便携版自带的 npm；不存在（或不可用）时回退 PATH 上的 npm。
$NpmCandidates = @()
$BundledNpm = Join-Path $ToolsPath "node\npm.cmd"
if (Test-Path $BundledNpm) {
    $NpmCandidates += $BundledNpm
}
else {
    Write-Host "未找到内置 npm ($BundledNpm)，回退到 PATH 上的 npm。" -ForegroundColor Yellow
}
$NpmCandidates += "npm"

# ========== 选择解包工具 ==========
$TarExe = Get-Command tar.exe -ErrorAction SilentlyContinue
if ($null -eq $TarExe) {
    Write-Host "错误: 找不到 tar.exe，无法解包 .tgz（需要 Windows 10 1803 及以上）。" -ForegroundColor Red
    exit 1
}

# ========== 下载并解包 ==========
$TempDir = Join-Path $env:TEMP ("diagramon-graphviz-" + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $TempDir -Force | Out-Null

try {
    $TgzPath = $null
    # 先试默认 registry，再回退 npmmirror 镜像
    $RegistryAttempts = @($null, $RegistryMirror)

    foreach ($NpmExe in $NpmCandidates) {
        foreach ($Registry in $RegistryAttempts) {
            $RegistryLabel = if ($Registry) { $Registry } else { "默认 registry" }
            Write-Host "正在执行 npm pack $PackageSpec (npm: $NpmExe, registry: $RegistryLabel)..." -ForegroundColor Cyan

            $NpmArgs = @("pack", $PackageSpec)
            if ($Registry) {
                $NpmArgs += "--registry=$Registry"
            }

            Push-Location $TempDir
            try {
                $NpmOutput = & $NpmExe @NpmArgs 2>&1
                $NpmExit = $LASTEXITCODE
            }
            finally {
                Pop-Location
            }

            $Tgz = Get-ChildItem -Path $TempDir -Filter "*.tgz" -File -ErrorAction SilentlyContinue | Select-Object -First 1
            if (($NpmExit -eq 0) -and ($null -ne $Tgz)) {
                $TgzPath = $Tgz.FullName
                break
            }

            Write-Host "  该来源失败 (exit=$NpmExit)，尝试下一个来源..." -ForegroundColor Yellow
            if ($NpmOutput) {
                $NpmOutput | Select-Object -Last 6 | ForEach-Object { Write-Host "    $_" -ForegroundColor DarkGray }
            }
        }
        if ($TgzPath) { break }
    }

    if (-not $TgzPath) {
        Write-Host "错误: 无法获取 $PackageSpec（已尝试内置/系统 npm 与默认 registry/npmmirror）。" -ForegroundColor Red
        exit 1
    }

    Write-Host "解包 $TgzPath ..." -ForegroundColor Gray
    & $TarExe.Source "-xzf" $TgzPath "-C" $TempDir
    if ($LASTEXITCODE -ne 0) {
        Write-Host "错误: 解包失败 (exit=$LASTEXITCODE): $TgzPath" -ForegroundColor Red
        exit 1
    }

    # 只取 dist/index.js（单文件 ESM）与 LICENSE，其余（index.js.map / src / types）不复制。
    $ExtractRoot = Join-Path $TempDir "package"
    $SrcJs = Join-Path $ExtractRoot "dist\index.js"
    $SrcLicense = Join-Path $ExtractRoot "LICENSE"
    if (-not (Test-Path $SrcJs)) {
        Write-Host "错误: 包内缺少 package/dist/index.js: $SrcJs" -ForegroundColor Red
        exit 1
    }
    if (-not (Test-Path $SrcLicense)) {
        Write-Host "错误: 包内缺少 package/LICENSE: $SrcLicense" -ForegroundColor Red
        exit 1
    }

    New-Item -ItemType Directory -Path $GraphvizDir -Force | Out-Null
    Copy-Item -Path $SrcJs -Destination $GraphvizJs -Force
    Copy-Item -Path $SrcLicense -Destination $LicenseFile -Force

    $Bytes = (Get-Item -Path $GraphvizJs).Length
    $Sha = Get-Sha256Hex -Path $GraphvizJs

    $ManifestJson = @"
{
  "version": "$PinnedVersion",
  "files": [
    {
      "path": "graphviz.js",
      "bytes": $Bytes,
      "sha256": "$Sha"
    }
  ]
}
"@
    $ManifestJson = $ManifestJson.TrimEnd() + "`n"
    $Utf8NoBom = New-Object System.Text.UTF8Encoding($false)
    [System.IO.File]::WriteAllText($ManifestFile, $ManifestJson, $Utf8NoBom)

    Write-Host ""
    Write-Host "Graphviz 渲染资源就绪 ($PackageSpec)。" -ForegroundColor Green
    Write-Host "  产物: $GraphvizJs" -ForegroundColor Gray
    Write-Host "  字节数: $Bytes" -ForegroundColor Gray
    Write-Host "  sha256: $Sha" -ForegroundColor Gray
    Write-Host "  归属: $LicenseFile ($PackageName, author=$PackageAuthor, license=$PackageLicenseId)" -ForegroundColor Gray
    Write-Host "  清单: $ManifestFile" -ForegroundColor Gray
}
finally {
    if (Test-Path $TempDir) {
        Remove-Item -Path $TempDir -Recurse -Force -ErrorAction SilentlyContinue
    }
}
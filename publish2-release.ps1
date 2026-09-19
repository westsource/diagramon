param(
    [string]$Version,
    [string]$GitHubToken,
    [string]$GiteeToken,
    [string]$Owner = "westsource",
    [string]$Repo = "diagramon",
    [switch]$Draft,
    [switch]$PreRelease,
    [switch]$SkipGitee,
    [switch]$Help
)

$null = chcp 65001
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
[Console]::InputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8

if ($Help) {
    Write-Host @"
发布脚本 v2 - GitHub Release + Gitee Release

用法: .\publish2-release.ps1 [参数]

参数:
  -Version        版本号 (如: 2.0.260505.0)，不指定则自动从 .csproj 读取
  -GitHubToken    GitHub 个人访问令牌 (或设置环境变量 GITHUB_TOKEN)
  -GiteeToken     Gitee 私人令牌 (或设置环境变量 GITEE_TOKEN)
  -Owner          用户名 (默认: westsource)
  -Repo           仓库名 (默认: diagramon)
  -Draft          创建 GitHub Release 为草稿
  -PreRelease     标记 GitHub Release 为预发布版本
  -SkipGitee      跳过 Gitee Release 创建
  -Help           显示帮助信息

示例:
  .\publish2-release.ps1 -GitHubToken ghp_xxx -GiteeToken ghp_yyy
  .\publish2-release.ps1 -Version 2.0.260505.0 -GitHubToken ghp_xxx

注意:
  1. 需要先运行 publish1-build.ps1 生成 dist 目录下的 ZIP 文件
  2. GitHub Token 需要 repo 权限
  3. 可在 https://github.com/settings/tokens 创建 GitHub Token
  4. 可在 https://gitee.com/profile/personal_access_tokens 创建 Gitee Token
"@
    exit 0
}

# ========== 初始化路径 ==========
$ProjectPath = $PSScriptRoot
$CsprojPath = Join-Path $ProjectPath "Diagramon.csproj"
$DistPath = Join-Path $ProjectPath "dist"
$ManifestPath = Join-Path $ProjectPath "update-manifest.json"

# ========== 获取版本号 ==========
if ([string]::IsNullOrWhiteSpace($Version)) {
    $CsprojContent = Get-Content $CsprojPath -Raw
    if ($CsprojContent -match '<Version>([^<]+)</Version>') {
        $Version = $matches[1]
    }
    else {
        Write-Host "无法从 .csproj 读取版本号，请使用 -Version 参数指定" -ForegroundColor Red
        exit 1
    }
}

# ========== 获取 Token ==========
if ([string]::IsNullOrWhiteSpace($GitHubToken)) {
    $GitHubToken = $env:GITHUB_TOKEN
}
if ([string]::IsNullOrWhiteSpace($GitHubToken)) {
    Write-Host "请提供 GitHub Token (参数 -GitHubToken 或环境变量 GITHUB_TOKEN)" -ForegroundColor Red
    exit 1
}

if (-not $SkipGitee -and [string]::IsNullOrWhiteSpace($GiteeToken)) {
    $GiteeToken = $env:GITEE_TOKEN
}
if (-not $SkipGitee -and [string]::IsNullOrWhiteSpace($GiteeToken)) {
    Write-Host "请提供 Gitee Token (参数 -GiteeToken 或环境变量 GITEE_TOKEN)" -ForegroundColor Red
    Write-Host "使用 -SkipGitee 可跳过 Gitee Release" -ForegroundColor Yellow
    exit 1
}

# ========== 检查 dist 目录 ==========
if (-not (Test-Path $DistPath)) {
    Write-Host "dist 目录不存在，请先运行 publish1-build.ps1 生成发布包" -ForegroundColor Red
    exit 1
}

$ZipFiles = Get-ChildItem -Path $DistPath -Filter "*.zip"
if ($ZipFiles.Count -eq 0) {
    Write-Host "dist 目录下没有 ZIP 文件，请先运行 publish1-build.ps1 生成发布包" -ForegroundColor Red
    exit 1
}

$ZipFile = $ZipFiles[0]
$ZipFilePath = $ZipFile.FullName
$ZipFileName = $ZipFile.Name
$ZipFileSize = $ZipFile.Length

Write-Host "============================================" -ForegroundColor Cyan
Write-Host "  发布 Diagramon v$Version" -ForegroundColor Cyan
Write-Host "  ZIP: $ZipFileName ($([math]::Round($ZipFileSize/1MB,2)) MB)" -ForegroundColor Cyan
Write-Host "============================================" -ForegroundColor Cyan

# ========== 构建发布说明 ==========
$TagName = "v$Version"
$ReleaseName = "Diagramon v$Version"

# 从 git log 获取更新日志（基于上一个 tag 或最近 10 条提交）
$PreviousTag = git tag --list 'v*' --sort=-version:refname | Select-Object -First 1
if ([string]::IsNullOrWhiteSpace($PreviousTag) -or $PreviousTag -eq $TagName) {
    $PreviousTag = git tag --list 'v*' --sort=-version:refname | Select-Object -Skip 1 | Select-Object -First 1
}
if (-not [string]::IsNullOrWhiteSpace($PreviousTag)) {
    $GitLog = git log --format="- %s" "$PreviousTag..HEAD" 2>$null
}
if (-not $GitLog -or $GitLog.Count -eq 0) {
    $GitLog = git log --oneline -10 --format="- %s" 2>$null
}

$ReleaseNotesBody = @"
### 更新内容
$($GitLog -join "`n")

### 关于 Diagramon
Diagramon 是一款本地 Mermaid 图表编辑器，支持实时预览、语法高亮、AI 辅助编写、多标签页编辑与高质量图片导出。

### 系统要求
- Windows 10/11 64位
- WebView2 运行时 (Windows 10+ 通常已内置)
"@

# ========== Step 1: GitHub Release ==========
Write-Host "`n[1/4] 创建 GitHub Release..." -ForegroundColor Cyan

# GitHub API 基础 URL
$GitHubApi = "https://api.github.com/repos/$Owner/$Repo"

# 检查 tag 是否已存在
try {
    $ExistingRelease = Invoke-RestMethod -Uri "$GitHubApi/releases/tags/$TagName" -Headers @{
        "Authorization" = "Bearer $GitHubToken"
        "Accept" = "application/vnd.github+json"
    } -Method Get -ErrorAction SilentlyContinue
}
catch {
    $ExistingRelease = $null
}

if ($ExistingRelease) {
    Write-Host "  GitHub Release $TagName 已存在，删除旧版本..." -ForegroundColor Yellow
    Invoke-RestMethod -Uri "$GitHubApi/releases/$($ExistingRelease.id)" -Headers @{
        "Authorization" = "Bearer $GitHubToken"
        "Accept" = "application/vnd.github+json"
    } -Method Delete | Out-Null
    # 也删除同名 tag（否则创建会失败）
    try {
        Invoke-RestMethod -Uri "$GitHubApi/git/refs/tags/$TagName" -Headers @{
            "Authorization" = "Bearer $GitHubToken"
            "Accept" = "application/vnd.github+json"
        } -Method Delete -ErrorAction SilentlyContinue | Out-Null
    }
    catch { }
}

# 创建 Release
$CreateBody = @{
    tag_name = $TagName
    name = $ReleaseName
    body = $ReleaseNotesBody
    draft = $Draft.IsPresent
    prerelease = $PreRelease.IsPresent
} | ConvertTo-Json -Depth 10

try {
    $GitHubRelease = Invoke-RestMethod -Uri "$GitHubApi/releases" -Method Post -Body ([System.Text.Encoding]::UTF8.GetBytes($CreateBody)) -Headers @{
        "Authorization" = "Bearer $GitHubToken"
        "Content-Type" = "application/json"
        "Accept" = "application/vnd.github+json"
    }
    $ReleaseId = $GitHubRelease.id
    $UploadUrl = $GitHubRelease.upload_url -replace '\{\?name,label\}', "?name=$ZipFileName"
    Write-Host "  Release 创建成功! ID: $ReleaseId" -ForegroundColor Green
}
catch {
    $ErrorMsg = $_.Exception.Message
    try {
        $ResponseBody = $_.Exception.Response
        $Reader = New-Object System.IO.StreamReader($ResponseBody.GetResponseStream())
        $ResponseText = $Reader.ReadToEnd()
        Write-Host "  API 响应: $ResponseText" -ForegroundColor Red
    }
    catch { }
    Write-Host "  创建 GitHub Release 失败: $ErrorMsg" -ForegroundColor Red
    exit 1
}

# ========== Step 2: 上传 ZIP 到 GitHub Release ==========
Write-Host "`n[2/4] 上传 ZIP 到 GitHub Release..." -ForegroundColor Cyan

try {
    $FileBytes = [System.IO.File]::ReadAllBytes($ZipFilePath)
    $UploadResponse = Invoke-RestMethod -Uri $UploadUrl -Method Post -Body $FileBytes -Headers @{
        "Authorization" = "Bearer $GitHubToken"
        "Content-Type" = "application/octet-stream"
        "Accept" = "application/vnd.github+json"
    }
    Write-Host "  ZIP 上传成功!" -ForegroundColor Green
}
catch {
    Write-Host "  ZIP 上传失败: $($_.Exception.Message)" -ForegroundColor Red
    exit 1
}

# ========== Step 3: 更新 update-manifest.json ==========
Write-Host "`n[3/4] 更新 update-manifest.json..." -ForegroundColor Cyan

$DownloadUrl = "https://github.com/$Owner/$Repo/releases/download/$TagName/$ZipFileName"

# 从 Git log 提取简要更新说明
$ReleaseNotesShort = ($GitLog | ForEach-Object { $_ -replace '^- ', '' }) -join "`n"

$Manifest = @{
    version      = $Version
    releaseNotes = $ReleaseNotesShort
    zipFileSize  = $ZipFileSize
    downloadUrl  = $DownloadUrl
    publishedAt  = (Get-Date -Format "o")
    zipFileName  = $ZipFileName
}
$ManifestJson = $Manifest | ConvertTo-Json
Set-Content -Path $ManifestPath -Value $ManifestJson -Encoding UTF8
Write-Host "  update-manifest.json 已更新" -ForegroundColor Green
Write-Host "  下载地址: $DownloadUrl" -ForegroundColor Gray

# ========== Step 4: Gitee Release ==========
if (-not $SkipGitee) {
    Write-Host "`n[4/4] 创建 Gitee Release..." -ForegroundColor Cyan

    $GiteeReleaseBody = @"
## $ReleaseName

### 更新内容
$($GitLog -join "`n")

### 下载地址
⬇️ **[$ZipFileName]($DownloadUrl)**

### 关于 Diagramon
Diagramon 是一款本地 Mermaid 图表编辑器，支持实时预览、语法高亮、AI 辅助编写、多标签页编辑与高质量图片导出。

### 系统要求
- Windows 10/11 64位
- WebView2 运行时 (Windows 10+ 通常已内置)
"@

    $GiteeApi = "https://gitee.com/api/v5/repos/$Owner/$Repo/releases?access_token=$GiteeToken"

    # 检查是否已存在
    try {
        $ExistingGiteeRelease = Invoke-RestMethod -Uri "$GiteeApi" -Method Get -ErrorAction SilentlyContinue
        $ExistingGiteeRelease = $ExistingGiteeRelease | Where-Object { $_.tag_name -eq $TagName } | Select-Object -First 1
    }
    catch { $ExistingGiteeRelease = $null }

    if ($ExistingGiteeRelease) {
        Write-Host "  Gitee Release $TagName 已存在，更新内容..." -ForegroundColor Yellow
        $GiteeBody = @{
            name = $ReleaseName
            body = $GiteeReleaseBody
        } | ConvertTo-Json -Depth 10
        try {
            Invoke-RestMethod -Uri "https://gitee.com/api/v5/repos/$Owner/$Repo/releases/$($ExistingGiteeRelease.id)?access_token=$GiteeToken" -Method Patch -Body ([System.Text.Encoding]::UTF8.GetBytes($GiteeBody)) -ContentType "application/json; charset=utf-8" | Out-Null
            Write-Host "  Gitee Release 更新成功!" -ForegroundColor Green
        }
        catch {
            Write-Host "  更新 Gitee Release 失败: $($_.Exception.Message)" -ForegroundColor Red
        }
    }
    else {
        $GiteeBody = @{
            tag_name = $TagName
            name = $ReleaseName
            body = $GiteeReleaseBody
            target_commitish = "master"
        } | ConvertTo-Json -Depth 10
        try {
            Invoke-RestMethod -Uri "$GiteeApi" -Method Post -Body ([System.Text.Encoding]::UTF8.GetBytes($GiteeBody)) -ContentType "application/json; charset=utf-8" | Out-Null
            Write-Host "  Gitee Release 创建成功!" -ForegroundColor Green
        }
        catch {
            $ErrorMsg = $_.Exception.Message
            try {
                $ResponseBody = $_.Exception.Response
                $Reader = New-Object System.IO.StreamReader($ResponseBody.GetResponseStream())
                $ResponseText = $Reader.ReadToEnd()
                Write-Host "  Gitee API 响应: $ResponseText" -ForegroundColor Yellow
            }
            catch { }
            Write-Host "  创建 Gitee Release 失败: $ErrorMsg" -ForegroundColor Red
        }
    }
    Write-Host "  查看: https://gitee.com/$Owner/$Repo/releases/tag/$TagName" -ForegroundColor Cyan
}
else {
    Write-Host "`n[4/4] 跳过 Gitee Release" -ForegroundColor Yellow
}

# ========== 提交并推送 ==========
Write-Host "`n正在提交并推送更新..." -ForegroundColor Cyan

# 暂存已修改的文件
git add $CsprojPath $ManifestPath 2>&1 | Out-Null
git commit -m "chore: bump version to v$Version and update manifest" 2>&1 | Out-Null

# 创建本地 tag
git tag -f $TagName 2>&1 | Out-Null

# 先推送到 Gitee (确保 tag 在 Gitee 上存在, 否则 Gitee Release API 会失败)
Write-Host "  推送到 Gitee (origin)..." -ForegroundColor Gray
git push origin master 2>&1 | Out-Null
git push origin $TagName 2>&1 | Out-Null

# 再推送到 GitHub
Write-Host "  推送到 GitHub (mirror)..." -ForegroundColor Gray
git push github master 2>&1 | Out-Null
git push github $TagName 2>&1 | Out-Null

# ========== 完成 ==========
Write-Host "`n============================================" -ForegroundColor Green
Write-Host "  发布完成!" -ForegroundColor Green
Write-Host "  GitHub Release: https://github.com/$Owner/$Repo/releases/tag/$TagName" -ForegroundColor Cyan
Write-Host "  Gitee Release:  https://gitee.com/$Owner/$Repo/releases/tag/$TagName" -ForegroundColor Cyan
Write-Host "  下载地址: $DownloadUrl" -ForegroundColor Cyan
Write-Host "============================================" -ForegroundColor Green

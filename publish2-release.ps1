param(
    [string]$Version,
    [string]$Token,
    [string]$Owner = "westsource",
    [string]$Repo = "diagramon",
    [switch]$Draft,
    [switch]$PreRelease,
    [switch]$Help
)

$null = chcp 65001
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
[Console]::InputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8

if ($Help) {
    Write-Host @"
Gitee Release 发布脚本

用法: .\publish2-release.ps1 [参数]

参数:
  -Version    版本号 (如: 1.0.260426.0)，不指定则自动从 .csproj 读取
  -Token      Gitee 私人令牌 (也可设置环境变量 GITEE_TOKEN)
  -Owner      Gitee 用户名 (默认: westsource)
  -Repo       仓库名 (默认: diagramon)
  -Draft      创建为草稿
  -PreRelease 标记为预发布版本
  -Help       显示帮助信息

示例:
  .\publish2-release.ps1 -Version 1.0.0 -Token ghp_xxxx
  .\publish2-release.ps1 -Draft

注意:
  1. 需要先运行 publish1-build.ps1 生成 dist 目录下的 ZIP 文件
  2. Token 需要有 projects 权限
  3. 可在 https://gitee.com/profile/personal_access_tokens 创建令牌
"@
    exit 0
}

$ProjectPath = $PSScriptRoot
$CsprojPath = Join-Path $ProjectPath "Diagramon.csproj"
$DistPath = Join-Path $ProjectPath "dist"

# 获取版本号
if ([string]::IsNullOrWhiteSpace($Version)) {
    $CsprojContent = Get-Content $CsprojPath -Raw
    if ($CsprojContent -match '<Version>([^<]+)</Version>') {
        $Version = $matches[1]
    } else {
        Write-Host "无法从 .csproj 读取版本号，请使用 -Version 参数指定" -ForegroundColor Red
        exit 1
    }
}

# 获取 Token
if ([string]::IsNullOrWhiteSpace($Token)) {
    $Token = $env:GITEE_TOKEN
}
if ([string]::IsNullOrWhiteSpace($Token)) {
    Write-Host "请提供 Gitee Token (参数 -Token 或环境变量 GITEE_TOKEN)" -ForegroundColor Red
    Write-Host "可在 https://gitee.com/profile/personal_access_tokens 创建令牌" -ForegroundColor Yellow
    exit 1
}

# 检查 dist 目录
if (-not (Test-Path $DistPath)) {
    Write-Host "dist 目录不存在，请先运行 publish1-build.ps1 生成发布包" -ForegroundColor Red
    exit 1
}

$ZipFiles = Get-ChildItem -Path $DistPath -Filter "*.zip"
if ($ZipFiles.Count -eq 0) {
    Write-Host "dist 目录下没有 ZIP 文件，请先运行 publish1-build.ps1 生成发布包" -ForegroundColor Red
    exit 1
}

Write-Host "准备发布 Diagramon v$Version 到 Gitee..." -ForegroundColor Cyan
Write-Host "仓库: $Owner/$Repo" -ForegroundColor Gray

# 构建发布说明
$ReleaseNotes = @"
## Diagramon v$Version

### 功能特性
- Mermaid 图表实时预览
- 语法高亮编辑器
- AI 辅助编写 (支持 OpenAI/Azure/Ollama)
- 高质量图片导出 (PNG/JPEG)
- 多标签页编辑

### 系统要求
- Windows 10/11 64位
- WebView2 运行时 (Windows 10+ 通常已内置)

### 安装方式
1. 下载 ZIP 压缩包
2. 解压到任意目录
3. 运行 Diagramon.exe

### 更新日志
查看 [README.md](https://gitee.com/$Owner/$Repo/blob/main/README.md) 获取详细信息。
"@

# 创建 Release
$TagName = "v$Version"
$ReleaseName = "Diagramon v$Version"

$Body = @{
    tag_name = $TagName
    name = $ReleaseName
    body = $ReleaseNotes
    draft = $Draft.IsPresent
    prerelease = $PreRelease.IsPresent
} | ConvertTo-Json -Depth 10

Write-Host "`n正在创建 Release..." -ForegroundColor Cyan

$Headers = @{
    "Content-Type" = "application/json"
}

$ApiUrl = "https://gitee.com/api/v5/repos/$Owner/$Repo/releases?access_token=$Token"

try {
    $Response = Invoke-RestMethod -Uri $ApiUrl -Method Post -Body $Body -Headers $Headers -ContentType "application/json"
    $ReleaseId = $Response.id
    Write-Host "Release 创建成功! ID: $ReleaseId" -ForegroundColor Green
} catch {
    $ErrorMsg = $_.Exception.Message
    $ResponseBody = $_.Exception.Response
    if ($ResponseBody) {
        $Reader = New-Object System.IO.StreamReader($ResponseBody.GetResponseStream())
        $ResponseText = $Reader.ReadToEnd()
        Write-Host "API 响应: $ResponseText" -ForegroundColor Yellow
    }
    if ($ErrorMsg -match "already exists") {
        Write-Host "版本 $TagName 已存在，尝试获取现有 Release..." -ForegroundColor Yellow
        $ExistingReleases = Invoke-RestMethod -Uri "https://gitee.com/api/v5/repos/$Owner/$Repo/releases?access_token=$Token" -Method Get
        $ExistingRelease = $ExistingReleases | Where-Object { $_.tag_name -eq $TagName } | Select-Object -First 1
        if ($ExistingRelease) {
            $ReleaseId = $ExistingRelease.id
            Write-Host "找到现有 Release ID: $ReleaseId" -ForegroundColor Green
        } else {
            Write-Host "无法找到现有 Release" -ForegroundColor Red
            exit 1
        }
    } else {
        Write-Host "创建 Release 失败: $ErrorMsg" -ForegroundColor Red
        exit 1
    }
}

# 上传附件
Write-Host "`n正在上传附件..." -ForegroundColor Cyan

$UploadUrl = "https://gitee.com/api/v5/repos/$Owner/$Repo/releases/$ReleaseId/attach_files?access_token=$Token"

foreach ($ZipFile in $ZipFiles) {
    Write-Host "上传: $($ZipFile.Name)" -ForegroundColor Gray
    
    $FileName = $ZipFile.Name
    $FilePath = $ZipFile.FullName
    
    # Gitee 使用 multipart/form-data 上传
    $Boundary = [System.Guid]::NewGuid().ToString()
    $LF = "`r`n"
    
    $BodyLines = @(
        "--$Boundary",
        "Content-Disposition: form-data; name=`"file`"; filename=`"$FileName`"",
        "Content-Type: application/octet-stream$LF"
    )
    $BodyText = $BodyLines -join $LF
    
    try {
        $FileBytes = [System.IO.File]::ReadAllBytes($FilePath)
        $Encoding = [System.Text.Encoding]::UTF8
        $BodyBytes = $Encoding.GetBytes($BodyText)
        $EndBoundary = $Encoding.GetBytes("$LF--$Boundary--$LF")
        
        $AllBytes = New-Object byte[] ($BodyBytes.Length + $FileBytes.Length + $EndBoundary.Length)
        [Array]::Copy($BodyBytes, 0, $AllBytes, 0, $BodyBytes.Length)
        [Array]::Copy($FileBytes, 0, $AllBytes, $BodyBytes.Length, $FileBytes.Length)
        [Array]::Copy($EndBoundary, 0, $AllBytes, $BodyBytes.Length + $FileBytes.Length, $EndBoundary.Length)
        
        $UploadHeaders = @{
            "Content-Type" = "multipart/form-data; boundary=$Boundary"
        }
        
        $UploadResponse = Invoke-RestMethod -Uri $UploadUrl -Method Post -Body $AllBytes -Headers $UploadHeaders
        Write-Host "  上传成功!" -ForegroundColor Green
    } catch {
        Write-Host "  上传失败: $($_.Exception.Message)" -ForegroundColor Red
    }
}

Write-Host "`n发布完成!" -ForegroundColor Green
Write-Host "查看: https://gitee.com/$Owner/$Repo/releases/tag/$TagName" -ForegroundColor Cyan

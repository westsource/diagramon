param(
    [string]$Runtime = "win-x64",
    [switch]$Run,
    [switch]$English,
    [string]$Version,
    [string]$ManifestUrlPrefix = ""
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

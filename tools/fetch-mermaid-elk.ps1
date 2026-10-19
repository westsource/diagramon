param(
    [switch]$Verify,
    [switch]$Force
)

# NOTE: no $ErrorActionPreference="Stop" here - npm writes notices to stderr and PS 5.1
# would turn them into terminating NativeCommandErrors (fetch-excalidraw.ps1 learned this
# the same way; it relies on explicit exit codes instead).

<#
.SYNOPSIS
    Build the offline ELK layout-engine bundle for Mermaid, into tools/mermaid-elk/.

.DESCRIPTION
    @mermaid-js/layout-elk is ESM-only (no UMD/prebuilt IIFE), and the ELK engine is NOT part
    of the mermaid core bundle. To keep Diagramon fully offline we vendor it:

      1. Read the version pin file tools/mermaid-elk.version (key=value lines).
      2. npm install @mermaid-js/layout-elk + esbuild into a throwaway temp dir.
      3. esbuild --bundle --format=esm the entry from tools/mermaid-elk-entry/entry.js.
         The npm "main" entry is the *core* variant: it does NOT import mermaid at runtime
         (mermaid APIs arrive via mermaid.registerLayoutLoaders callbacks), so nothing is
         external and no second copy of mermaid can sneak into the bundle.
      4. Write tools/mermaid-elk/mermaid-layout-elk.esm.js + LICENSE + .manifest.json
         ({version, pin, files:[{path, bytes, sha256}]}).

    The frontend lazy-loads it: import("/mermaid-elk/mermaid-layout-elk.esm.js") then
    mermaid.registerLayoutLoaders(module.default), after which initialize({layout:"elk"}) works.

    -Verify : only validate the existing product (manifest bytes/sha256, no bare imports left).
    -Force  : rebuild even if the product matches the pin.
    Without switches: up-to-date products are kept (no network, no npm install).

    Temp dir and npm cache live under %TEMP%\diagramon-mermaid-elk-<guid>\ and are removed on
    exit (success or failure). Only tools/mermaid-elk/ stays in the repo (gitignored).
#>

# ========== paths ==========
$ToolsPath = $PSScriptRoot
$VersionFile = Join-Path $ToolsPath "mermaid-elk.version"
$OutDir = Join-Path $ToolsPath "mermaid-elk"
$EntrySourcePath = Join-Path $ToolsPath "mermaid-elk-entry\entry.js"
$BundleFile = Join-Path $OutDir "mermaid-layout-elk.esm.js"
$ManifestFile = Join-Path $OutDir ".manifest.json"

$RegistryMirror = "https://registry.npmmirror.com"

$PinKeys = @{
    'layout-elk' = '@mermaid-js/layout-elk'
    'esbuild'    = 'esbuild'
}
$PrimaryPinKey = 'layout-elk'

# ========== helpers ==========
function Get-Sha256Hex {
    param([string]$Path)
    return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
}

function Write-Utf8NoBom {
    param([string]$Path, [string]$Text)
    $Encoding = New-Object System.Text.UTF8Encoding($false)
    [System.IO.File]::WriteAllText($Path, $Text, $Encoding)
}

function Get-Pins {
    if (-not (Test-Path -LiteralPath $VersionFile)) {
        Write-Host "ERROR: missing version pin file: $VersionFile" -ForegroundColor Red
        exit 1
    }
    $Pins = @{}
    foreach ($Line in (Get-Content -Path $VersionFile)) {
        $Text = $Line.Trim()
        if ($Text -eq '' -or $Text.StartsWith('#')) { continue }
        $Parts = $Text -split '=', 2
        if ($Parts.Count -ne 2) {
            Write-Host "ERROR: not a key=value line in ${VersionFile}: '$Text'" -ForegroundColor Red
            exit 1
        }
        $Key = $Parts[0].Trim()
        $Value = $Parts[1].Trim()
        if ($Value -notmatch '^\d+\.\d+\.\d+$') {
            Write-Host "ERROR: $Key= is not a semver: '$Value'" -ForegroundColor Red
            exit 1
        }
        $Pins[$Key] = $Value
    }
    foreach ($Key in $PinKeys.Keys) {
        if (-not $Pins.ContainsKey($Key)) {
            Write-Host "ERROR: pin file lacks required key: $Key=" -ForegroundColor Red
            exit 1
        }
    }
    return $Pins
}

function Get-PinFingerprint {
    $Lines = @()
    foreach ($Line in (Get-Content -Path $VersionFile)) {
        $Text = $Line.Trim()
        if ($Text -eq '' -or $Text.StartsWith('#')) { continue }
        $Lines += $Text
    }
    return ((@($Lines | Sort-Object)) -join ';')
}

function Get-FileRecords {
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

function Write-Manifest {
    param([string]$PinnedVersion, [string]$PinFingerprint, [string]$LicenseId, $Records)
    $Builder = New-Object System.Text.StringBuilder
    [void]$Builder.AppendLine("{")
    [void]$Builder.AppendLine("  `"version`": `"$PinnedVersion`",")
    [void]$Builder.AppendLine("  `"pin`": `"$PinFingerprint`",")
    [void]$Builder.AppendLine("  `"licenses`": { `"@mermaid-js/layout-elk`": `"$LicenseId`" },")
    [void]$Builder.AppendLine("  `"files`": [")
    for ($i = 0; $i -lt $Records.Count; $i++) {
        $Entry = $Records[$i]
        $Comma = if ($i -lt ($Records.Count - 1)) { "," } else { "" }
        [void]$Builder.AppendLine("    { `"path`": `"$($Entry.path)`", `"bytes`": $($Entry.bytes), `"sha256`": `"$($Entry.sha256)`" }$Comma")
    }
    [void]$Builder.AppendLine("  ]")
    [void]$Builder.AppendLine("}")
    Write-Utf8NoBom -Path $ManifestFile -Text $Builder.ToString()
}

function Read-Manifest {
    param([string]$Path)
    if (-not (Test-Path -LiteralPath $Path)) { return $null }
    try { return (Get-Content -Path $Path -Raw -Encoding UTF8 | ConvertFrom-Json) } catch { return $null }
}

function Test-Product {
    # Returns $null when the product on disk matches the pin and is self-consistent.
    param([string]$PinnedVersion, [string]$PinFingerprint)
    if (-not (Test-Path -LiteralPath $BundleFile)) { return "missing $BundleFile" }
    if (-not (Test-Path -LiteralPath $ManifestFile)) { return "missing manifest $ManifestFile" }
    $Manifest = Read-Manifest -Path $ManifestFile
    if ($null -eq $Manifest) { return "manifest unparseable" }
    if ($Manifest.version -ne $PinnedVersion) { return "manifest version $($Manifest.version) != pin $PinnedVersion" }
    if ($Manifest.pin -ne $PinFingerprint) { return "pin fingerprint drift (pin file edited, re-run the fetch script)" }
    $Entries = @($Manifest.files)
    $OnDisk = @(Get-FileRecords -Root $OutDir)
    if ($OnDisk.Count -ne $Entries.Count) { return "file count on disk $($OnDisk.Count) != manifest $($Entries.Count)" }
    foreach ($Entry in $Entries) {
        $Path = Join-Path $OutDir ($Entry.path -replace '/', '\')
        if (-not (Test-Path -LiteralPath $Path)) { return "manifest lists but disk lacks: $($Entry.path)" }
        if ((Get-Item -LiteralPath $Path).Length -ne [int64]$Entry.bytes) { return "bytes mismatch: $($Entry.path)" }
        if ((Get-Sha256Hex -Path $Path) -ne $Entry.sha256) { return "sha256 mismatch: $($Entry.path)" }
    }
    # Self-contained check: a fully bundled ESM output must not keep any bare-specifier import
    # (dayjs / d3 / katex / ... would 404 offline). Relative chunk imports would also count as a
    # miss because esbuild inlines dynamic imports without --splitting.
    $Text = [System.IO.File]::ReadAllText($BundleFile)
    if ($Text -match '(^|[;\s])import\s*[\"{''(]') { return "bundle still contains import statements (dependencies were not fully inlined)" }
    if ($Text -notmatch 'elk') { return "bundle does not look like the ELK package (no 'elk' marker)" }
    if ((Get-Item -LiteralPath $BundleFile).Length -lt 500KB) { return "bundle suspiciously small (<500KB)" }
    return $null
}

$Pins = Get-Pins
$PinnedVersion = $Pins[$PrimaryPinKey]
$PinFingerprint = Get-PinFingerprint
$PinLabel = "$($PinKeys.Keys | Sort-Object | ForEach-Object { "$_=$($Pins[$_])" })"

# ========== verify-only mode ==========
if ($Verify) {
    Write-Host "Verifying Mermaid-ELK offline bundle (pin: $PinLabel)..." -ForegroundColor Cyan
    $Problem = Test-Product -PinnedVersion $PinnedVersion -PinFingerprint $PinFingerprint
    if ($Problem) {
        Write-Host "FAILED: $Problem" -ForegroundColor Red
        Write-Host "Re-run tools\fetch-mermaid-elk.ps1 to rebuild." -ForegroundColor Yellow
        exit 1
    }
    Write-Host "OK." -ForegroundColor Green
    Write-Host "  bundle: $BundleFile ($((Get-Item -LiteralPath $BundleFile).Length) bytes)" -ForegroundColor Gray
    exit 0
}

# ========== idempotence ==========
if (-not $Force) {
    $Problem = Test-Product -PinnedVersion $PinnedVersion -PinFingerprint $PinFingerprint
    if (-not $Problem) {
        Write-Host "Mermaid-ELK offline bundle up-to-date (pin: $PinLabel)." -ForegroundColor Green
        Write-Host "  bundle: $BundleFile ($((Get-Item -LiteralPath $BundleFile).Length) bytes)" -ForegroundColor Gray
        exit 0
    }
    Write-Host "Rebuild needed: $Problem" -ForegroundColor Yellow
}

# ========== npm / node selection ==========
$NpmCandidates = @()
$BundledNpm = Join-Path $ToolsPath "node\npm.cmd"
if (Test-Path -LiteralPath $BundledNpm) { $NpmCandidates += $BundledNpm }
$NpmCandidates += "npm"

$NodeExe = "node"
$BundledNode = Join-Path $ToolsPath "node\node.exe"
if (Test-Path -LiteralPath $BundledNode) { $NodeExe = $BundledNode }

# ========== temp workspace ==========
$TempDir = Join-Path ([System.IO.Path]::GetTempPath()) ("diagramon-mermaid-elk-" + [guid]::NewGuid().ToString('N'))
$BuildDir = Join-Path $TempDir "build"
$CacheDir = Join-Path $TempDir "npm-cache"
New-Item -ItemType Directory -Path $BuildDir -Force | Out-Null

try {
    # ---------- install ----------
    $PackageSpecs = @("$($PinKeys['layout-elk'])@$($Pins['layout-elk'])", "esbuild@$($Pins['esbuild'])")

    Write-Utf8NoBom -Path (Join-Path $BuildDir "package.json") -Text @'
{
  "name": "diagramon-mermaid-elk-build",
  "version": "1.0.0",
  "private": true,
  "description": "Throwaway workspace for tools/fetch-mermaid-elk.ps1 (deleted on exit)."
}
'@

    $Installed = $false
    # npmmirror first: on this machine the default registry is slow/unreliable, and the mirror
    # serves identical tarballs (same content-addressed integrity).
    $RegistryAttempts = @($RegistryMirror, $null)
    foreach ($Registry in $RegistryAttempts) {
        $RegistryLabel = if ($Registry) { $Registry } else { "default registry" }
        Write-Host "npm install (registry: $RegistryLabel)..." -ForegroundColor Cyan
        $NpmArgs = @("install", "--no-save", "--no-package-lock", "--no-audit", "--no-fund", "--loglevel=error", "--cache=$CacheDir")
        if ($Registry) { $NpmArgs += "--registry=$Registry" }
        $NpmArgs += $PackageSpecs

        Push-Location $BuildDir
        try {
            $NpmOutput = & npm @NpmArgs 2>&1
            $NpmExit = $LASTEXITCODE
        }
        finally { Pop-Location }

        if (($NpmExit -eq 0) -and (Test-Path -LiteralPath (Join-Path $BuildDir "node_modules\esbuild\bin\esbuild"))) {
            $Installed = $true
            break
        }
        Write-Host "  source failed (exit=$NpmExit), trying next..." -ForegroundColor Yellow
        if ($NpmOutput) { $NpmOutput | Select-Object -Last 5 | ForEach-Object { Write-Host "    $_" -ForegroundColor DarkGray } }
    }
    if (-not $Installed) {
        Write-Host "ERROR: could not install build dependencies ($($PackageSpecs -join ' '))." -ForegroundColor Red
        exit 1
    }

    # pin check: the actually installed layout-elk must equal the pin
    $Meta = (Get-Content -Path (Join-Path $BuildDir "node_modules\@mermaid-js\layout-elk\package.json") -Raw -Encoding UTF8 | ConvertFrom-Json)
    if ($Meta.version -ne $Pins['layout-elk']) {
        Write-Host "ERROR: layout-elk resolved to $($Meta.version), pin requires $($Pins['layout-elk'])" -ForegroundColor Red
        exit 1
    }
    $LicenseId = if ($Meta.license) { [string]$Meta.license } else { 'UNKNOWN' }

    # ---------- entry ----------
    if (-not (Test-Path -LiteralPath $EntrySourcePath)) {
        Write-Host "ERROR: missing entry source $EntrySourcePath (tools/mermaid-elk-entry/ should be in the repo)" -ForegroundColor Red
        exit 2
    }
    $EntryTarget = Join-Path $BuildDir "entry.js"
    Copy-Item -LiteralPath $EntrySourcePath -Destination $EntryTarget -Force

    # ---------- esbuild ----------
    $EsbuildJs = Join-Path $BuildDir "node_modules\esbuild\bin\esbuild"
    $BundleOut = Join-Path $TempDir "mermaid-layout-elk.esm.js"
    $EsArgs = @($EntryTarget, "--bundle", "--format=esm", "--target=chrome120", "--minify", "--legal-comments=none", "--outfile=$BundleOut")

    Write-Host "Bundling layout-elk $($Pins['layout-elk']) with esbuild $($Pins['esbuild'])..." -ForegroundColor Cyan
    & $NodeExe $EsbuildJs @EsArgs
    if ($LASTEXITCODE -ne 0) {
        Write-Host "ERROR: esbuild failed (exit=$LASTEXITCODE)." -ForegroundColor Red
        exit 1
    }

    # ---------- install into tools/mermaid-elk ----------
    if (Test-Path -LiteralPath $OutDir) { Remove-Item -LiteralPath $OutDir -Recurse -Force }
    New-Item -ItemType Directory -Path $OutDir -Force | Out-Null
    Copy-Item -LiteralPath $BundleOut -Destination $BundleFile -Force

    # upstream license: the npm package may or may not ship a LICENSE file
    foreach ($Name in @("LICENSE", "LICENSE.md", "LICENSE.txt")) {
        $Candidate = Join-Path $BuildDir "node_modules\@mermaid-js\layout-elk\$Name"
        if (Test-Path -LiteralPath $Candidate) {
            Copy-Item -LiteralPath $Candidate -Destination (Join-Path $OutDir "layout-elk-LICENSE") -Force
            break
        }
    }

    $Records = Get-FileRecords -Root $OutDir
    Write-Manifest -PinnedVersion $PinnedVersion -PinFingerprint $PinFingerprint -LicenseId $LicenseId -Records $Records

    # ---------- final self-check ----------
    $Problem = Test-Product -PinnedVersion $PinnedVersion -PinFingerprint $PinFingerprint
    if ($Problem) {
        Write-Host "ERROR: built but self-check failed: $Problem" -ForegroundColor Red
        exit 1
    }

    Write-Host ""
    Write-Host "Mermaid-ELK offline bundle ready." -ForegroundColor Green
    Write-Host "  pin: $PinLabel" -ForegroundColor Gray
    Write-Host "  bundle: $BundleFile ($((Get-Item -LiteralPath $BundleFile).Length) bytes)" -ForegroundColor Gray
    Write-Host "  license: $LicenseId" -ForegroundColor Gray
}
finally {
    if (Test-Path -LiteralPath $TempDir) {
        Remove-Item -LiteralPath $TempDir -Recurse -Force -ErrorAction SilentlyContinue
    }
}

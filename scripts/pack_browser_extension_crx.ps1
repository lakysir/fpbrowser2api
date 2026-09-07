param(
    [string]$ChromePath = "",
    [string]$ExtensionDir = "",
    [string]$KeyPath = "",
    [string]$OutputCrx = "",
    [switch]$KeepStaging
)

$ErrorActionPreference = "Stop"

function Resolve-FullPath([string]$Path) {
    if ([System.IO.Path]::IsPathRooted($Path)) {
        return [System.IO.Path]::GetFullPath($Path)
    }
    return [System.IO.Path]::GetFullPath((Join-Path (Get-Location).Path $Path))
}

function Find-Chrome {
    param([string]$RequestedPath)

    if ($RequestedPath) {
        if (Test-Path -LiteralPath $RequestedPath) {
            return (Resolve-Path -LiteralPath $RequestedPath).Path
        }
        throw "Chrome executable not found: $RequestedPath"
    }

    $candidates = @(
        (Join-Path $env:ProgramFiles "Google\Chrome\Application\chrome.exe"),
        (Join-Path ${env:ProgramFiles(x86)} "Google\Chrome\Application\chrome.exe"),
        (Join-Path $env:LocalAppData "Google\Chrome\Application\chrome.exe")
    )

    foreach ($candidate in $candidates) {
        if ($candidate -and (Test-Path -LiteralPath $candidate)) {
            return (Resolve-Path -LiteralPath $candidate).Path
        }
    }

    $command = Get-Command chrome.exe -ErrorAction SilentlyContinue
    if ($command) {
        return $command.Source
    }

    throw "Chrome executable not found. Pass -ChromePath explicitly."
}

$ProjectRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..")).Path

if (-not $ExtensionDir) {
    $ExtensionDir = Join-Path $ProjectRoot "browser_extension"
}
if (-not $KeyPath) {
    $KeyPath = Join-Path $ProjectRoot "browser_extension.pem"
}
if (-not $OutputCrx) {
    $OutputCrx = Join-Path $ProjectRoot "browser_extension.crx"
}

$ChromePath = Find-Chrome $ChromePath
$ExtensionDir = (Resolve-Path -LiteralPath $ExtensionDir).Path
$KeyPath = Resolve-FullPath $KeyPath
$OutputCrx = Resolve-FullPath $OutputCrx

if (-not (Test-Path -LiteralPath (Join-Path $ExtensionDir "manifest.json"))) {
    throw "manifest.json not found in extension directory: $ExtensionDir"
}
if (-not (Test-Path -LiteralPath $KeyPath)) {
    throw "Extension private key not found: $KeyPath. Keep this .pem file to preserve the CRX extension ID."
}

$StageRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("fpbrowser2api_ext_pack_" + [System.Guid]::NewGuid().ToString("N"))
$StageExtension = Join-Path $StageRoot "browser_extension"
$PackedCrx = "$StageExtension.crx"

try {
    New-Item -ItemType Directory -Path $StageRoot | Out-Null
    Copy-Item -LiteralPath $ExtensionDir -Destination $StageExtension -Recurse -Force

    $BackgroundPath = Join-Path $StageExtension "background.js"
    $Utf8NoBom = New-Object System.Text.UTF8Encoding($false)
    $BackgroundText = [System.IO.File]::ReadAllText($BackgroundPath, $Utf8NoBom)
    $Pattern = 'const\s+NEWAPI_CHARGE_ENABLED\s*=\s*false\s*;'
    if ($BackgroundText -notmatch $Pattern) {
        throw "Could not find 'const NEWAPI_CHARGE_ENABLED = false;' in staged background.js."
    }

    $BackgroundText = [regex]::Replace(
        $BackgroundText,
        $Pattern,
        "const NEWAPI_CHARGE_ENABLED = true;",
        1
    )
    [System.IO.File]::WriteAllText($BackgroundPath, $BackgroundText, $Utf8NoBom)

    if (Test-Path -LiteralPath $PackedCrx) {
        Remove-Item -LiteralPath $PackedCrx -Force
    }
    if (Test-Path -LiteralPath $OutputCrx) {
        Remove-Item -LiteralPath $OutputCrx -Force
    }

    $arguments = @(
        "--pack-extension=$StageExtension",
        "--pack-extension-key=$KeyPath"
    )

    $process = Start-Process -FilePath $ChromePath -ArgumentList $arguments -Wait -PassThru -WindowStyle Hidden
    if ($process.ExitCode -ne 0) {
        throw "Chrome pack-extension failed with exit code $($process.ExitCode)."
    }
    if (-not (Test-Path -LiteralPath $PackedCrx)) {
        throw "Chrome finished but CRX was not created: $PackedCrx"
    }

    $OutputDir = Split-Path -Parent $OutputCrx
    if ($OutputDir -and -not (Test-Path -LiteralPath $OutputDir)) {
        New-Item -ItemType Directory -Path $OutputDir | Out-Null
    }
    Copy-Item -LiteralPath $PackedCrx -Destination $OutputCrx -Force

    Write-Host "CRX created: $OutputCrx"
    Write-Host "Packaged background.js uses: const NEWAPI_CHARGE_ENABLED = true;"
    Write-Host "Packaged manifest.json keeps side_panel behavior; no action.default_popup is added."
    Write-Host "Source background.js was not modified: $ExtensionDir\background.js"
}
finally {
    if ($KeepStaging) {
        Write-Host "Staging directory kept: $StageRoot"
    }
    elseif (Test-Path -LiteralPath $StageRoot) {
        Remove-Item -LiteralPath $StageRoot -Recurse -Force
    }
}

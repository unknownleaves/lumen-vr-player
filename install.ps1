<#
.SYNOPSIS
  Downloads and installs the latest Lumen VR Player from GitHub Releases.

.DESCRIPTION
  One-line install (PowerShell 5.1 or 7+):
    irm https://raw.githubusercontent.com/unknownleaves/lumen-vr-player/main/install.ps1 | iex

  Or save this file and run it:
    powershell -ExecutionPolicy Bypass -File .\install.ps1            # install + launch
    powershell -ExecutionPolicy Bypass -File .\install.ps1 -Portable  # portable .exe, no install
    powershell -ExecutionPolicy Bypass -File .\install.ps1 -Version 1.0.0 -NoLaunch

  Installs for the current user only (no admin rights needed) into
  %LOCALAPPDATA%\Programs, and adds Start-menu and desktop shortcuts with the app icon.
  The installed app keeps itself up to date.
#>
[CmdletBinding()]
param(
    [string]$Version = 'latest',          # e.g. 1.0.0 or v1.0.0
    [switch]$Portable,                    # download the portable .exe instead of installing
    [string]$Destination = [Environment]::GetFolderPath('Desktop'),  # where -Portable saves the .exe
    [switch]$NoLaunch                     # don't start the app afterwards
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'   # makes Invoke-WebRequest much faster on PowerShell 5.1
[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

$Repo    = 'unknownleaves/lumen-vr-player'
$AppName = 'Lumen VR Player'
$Headers = @{ 'User-Agent' = 'lumen-vr-player-installer'; 'Accept' = 'application/vnd.github+json' }

function Write-Step($msg) { Write-Host "==> $msg" -ForegroundColor Cyan }

if ($env:OS -ne 'Windows_NT') { throw 'This script is for Windows. On macOS/Linux download the .dmg / .AppImage / .deb from the Releases page.' }

# 1. Find the release ---------------------------------------------------------------------------
$api = if ($Version -eq 'latest') { "https://api.github.com/repos/$Repo/releases/latest" }
       else { "https://api.github.com/repos/$Repo/releases/tags/v$($Version.TrimStart('v'))" }
Write-Step "Looking up $AppName release ($Version)..."
try {
    $release = Invoke-RestMethod -Uri $api -Headers $Headers
} catch {
    $code = $_.Exception.Response.StatusCode.value__
    if ($code -eq 404) { throw "No published release found at https://github.com/$Repo/releases. Push a version tag (e.g. v1.0.0) to build one." }
    throw "Could not reach GitHub: $($_.Exception.Message)"
}

$pattern = if ($Portable) { '*portable*.exe' } else { '*Setup*.exe' }
$asset = $release.assets | Where-Object { $_.name -like $pattern } | Select-Object -First 1
if (-not $asset) { throw "Release $($release.tag_name) has no file matching '$pattern'." }
$sizeMB = [math]::Round($asset.size / 1MB, 1)

# 2. Download --------------------------------------------------------------------------------------
$folder = if ($Portable) { $Destination } else { Join-Path $env:TEMP 'lumen-vr-player' }
New-Item -ItemType Directory -Force -Path $folder | Out-Null
$file = Join-Path $folder $asset.name
Write-Step "Downloading $($asset.name) ($sizeMB MB)..."
Invoke-WebRequest -Uri $asset.browser_download_url -OutFile $file -Headers @{ 'User-Agent' = $Headers['User-Agent'] } -UseBasicParsing
if ((Get-Item $file).Length -ne $asset.size) { throw 'Download was incomplete. Please run the script again.' }
Unblock-File -Path $file   # remove the "downloaded from the internet" mark

if ($Portable) {
    Write-Host "Saved portable app to $file" -ForegroundColor Green
    if (-not $NoLaunch) { Start-Process -FilePath $file }
    return
}

# 3. Install (per-user, silent) -----------------------------------------------------------------
Get-Process -Name 'lumen-vr-player' -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
Write-Step "Installing $AppName $($release.tag_name)..."
$proc = Start-Process -FilePath $file -ArgumentList '/S', '/currentuser' -Wait -PassThru
if ($proc.ExitCode -ne 0) { throw "Installer exited with code $($proc.ExitCode)." }
Remove-Item $file -ErrorAction SilentlyContinue

# 4. Locate and launch -------------------------------------------------------------------------
$exe = @(
    Join-Path $env:LOCALAPPDATA 'Programs\lumen-vr-player\lumen-vr-player.exe'
    Join-Path $env:LOCALAPPDATA "Programs\$AppName\lumen-vr-player.exe"
) | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $exe) {
    $exe = Get-ChildItem (Join-Path $env:LOCALAPPDATA 'Programs') -Filter 'lumen-vr-player.exe' -Recurse -Depth 2 -ErrorAction SilentlyContinue |
           Select-Object -First 1 -ExpandProperty FullName
}

Write-Host ''
Write-Host "$AppName $($release.tag_name) installed." -ForegroundColor Green
if ($exe) { Write-Host "  Location : $exe" }
Write-Host '  Shortcuts: Start menu and Desktop'
Write-Host '  Tip      : right-click the running app in the taskbar and choose "Pin to taskbar".'

if (-not $NoLaunch) {
    $shortcut = Join-Path ([Environment]::GetFolderPath('Programs')) "$AppName.lnk"
    $target = if (Test-Path $shortcut) { $shortcut } elseif ($exe) { $exe } else { $null }
    # Start through Explorer so the app is fully detached from this PowerShell window:
    # it keeps running when you close PowerShell and doesn't print messages here.
    # (The Start-menu shortcut also gives Windows the app's ID and icon right away.)
    if ($target) { Start-Process -FilePath 'explorer.exe' -ArgumentList "`"$target`"" }
}
Write-Host ''
Write-Host 'Done. You can close this window.' -ForegroundColor Green

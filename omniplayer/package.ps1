# Build OmniPlayer release folder; optionally install a per-user stable copy.
#
# 便携发布约定：
# - 产出目录只放程序与说明（OmniPlayer.exe、采集 exe、bat、使用说明等）
# - 切勿把运行时数据根 OmniDatabase 打进发布包（发布物与数据根分离）
# - 稳定版：-Install → %LOCALAPPDATA%\OmniTrace + 桌面快捷方式 + HKCU 卸载项
# - 增量：覆盖 dist 后，若稳定版在跑则写入 incoming，壳内「关于→更新」换 exe
#
param(
  [switch]$Install,
  [switch]$SkipBuild
)

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $Root

$Repo = Split-Path -Parent $Root
$Dist = Join-Path $Repo "dist\OmniPlayer"
$InstallDir = Join-Path $env:LOCALAPPDATA "OmniTrace"
$IncomingDir = Join-Path $InstallDir "incoming"
$DbRoot = Join-Path $Repo "OmniDatabase"

function Copy-ReleaseBits([string]$Dest) {
  New-Item -ItemType Directory -Force -Path $Dest | Out-Null
  Copy-Item (Join-Path $Dist "OmniPlayer.exe") (Join-Path $Dest "OmniPlayer.exe") -Force
  $rec = Join-Path $Dist "omnitrace_input.exe"
  if (Test-Path $rec) {
    Copy-Item $rec (Join-Path $Dest "omnitrace_input.exe") -Force
  }
  $ico = Join-Path $Root "src-tauri\icons\icon.ico"
  if (Test-Path $ico) {
    Copy-Item $ico (Join-Path $Dest "OmniTrace.ico") -Force
  }
  Get-ChildItem (Join-Path $Root "package") -File | ForEach-Object {
    Copy-Item $_.FullName (Join-Path $Dest $_.Name) -Force
  }
}

function Write-DataRootPointer([string]$Dest) {
  $ptr = @{ path = $DbRoot } | ConvertTo-Json -Compress
  $path = Join-Path $Dest "data_root.json"
  $utf8 = New-Object System.Text.UTF8Encoding $false
  [System.IO.File]::WriteAllText($path, $ptr, $utf8)
}

function Install-UninstallKey([string]$Version) {
  $uninst = Join-Path $InstallDir "uninstall.ps1"
  $key = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\OmniTrace"
  $uninstCmd = 'powershell.exe -NoProfile -ExecutionPolicy Bypass -File "' + $uninst + '"'
  New-Item -Path $key -Force | Out-Null
  New-ItemProperty -Path $key -Name "DisplayName" -Value "OmniTrace" -PropertyType String -Force | Out-Null
  New-ItemProperty -Path $key -Name "DisplayVersion" -Value $Version -PropertyType String -Force | Out-Null
  New-ItemProperty -Path $key -Name "Publisher" -Value "OmniTrace" -PropertyType String -Force | Out-Null
  New-ItemProperty -Path $key -Name "InstallLocation" -Value $InstallDir -PropertyType String -Force | Out-Null
  New-ItemProperty -Path $key -Name "UninstallString" -Value $uninstCmd -PropertyType String -Force | Out-Null
  New-ItemProperty -Path $key -Name "NoModify" -Value 1 -PropertyType DWord -Force | Out-Null
  New-ItemProperty -Path $key -Name "NoRepair" -Value 1 -PropertyType DWord -Force | Out-Null
}

function Write-UninstallScript {
  $desk = Join-Path ([Environment]::GetFolderPath("Desktop")) "OmniTrace.lnk"
  $startDir = Join-Path $env:APPDATA "Microsoft\Windows\Start Menu\Programs\OmniTrace"
  $lines = @(
    '$ErrorActionPreference = ''Continue''',
    ('$install = ''' + $InstallDir + ''''),
    ('$desk = ''' + $desk + ''''),
    ('$startDir = ''' + $startDir + ''''),
    '$key = ''HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\OmniTrace''',
    'Remove-Item $desk -Force -ErrorAction SilentlyContinue',
    'Remove-Item $startDir -Recurse -Force -ErrorAction SilentlyContinue',
    'Remove-Item $key -Recurse -Force -ErrorAction SilentlyContinue',
    'Get-ChildItem $install -Force -ErrorAction SilentlyContinue | Where-Object { $_.Name -ne ''uninstall.ps1'' } | Remove-Item -Recurse -Force -ErrorAction SilentlyContinue',
    'Remove-Item $install -Recurse -Force -ErrorAction SilentlyContinue',
    'Write-Host ''OmniTrace stable uninstalled (OmniDatabase untouched).'''
  )
  $utf8 = New-Object System.Text.UTF8Encoding $false
  [System.IO.File]::WriteAllText((Join-Path $InstallDir "uninstall.ps1"), ($lines -join "`r`n") + "`r`n", $utf8)
}

function New-Shortcut([string]$LinkPath, [string]$Target, [string]$WorkDir) {
  $dir = Split-Path -Parent $LinkPath
  New-Item -ItemType Directory -Force -Path $dir | Out-Null
  $ws = New-Object -ComObject WScript.Shell
  $sc = $ws.CreateShortcut($LinkPath)
  $sc.TargetPath = $Target
  $sc.WorkingDirectory = $WorkDir
  $sc.Description = "OmniTrace stable"
  $ico = Join-Path $WorkDir "OmniTrace.ico"
  if (Test-Path $ico) { $sc.IconLocation = "$ico,0" }
  $sc.Save()
}

function Test-StableRunning {
  $exe = Join-Path $InstallDir "OmniPlayer.exe"
  if (-not (Test-Path $exe)) { return $false }
  $want = [System.IO.Path]::GetFullPath($exe)
  $procs = Get-Process -Name OmniPlayer,omniplayer -ErrorAction SilentlyContinue
  foreach ($p in $procs) {
    try {
      if ($p.Path -and ($p.Path -ieq $want)) { return $true }
    } catch {}
  }
  return $false
}

function Get-AppVersion {
  $conf = Join-Path $Root "src-tauri\tauri.conf.json"
  $json = Get-Content $conf -Raw -Encoding UTF8 | ConvertFrom-Json
  return [string]$json.version
}

if (-not $SkipBuild) {
  $env:CARGO_TARGET_DIR = Join-Path $Root "src-tauri\target"

  Write-Host "==> npm install (if needed)..." -ForegroundColor Cyan
  if (-not (Test-Path (Join-Path $Root "node_modules"))) {
    npm install
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
  }

  Write-Host "==> tauri build (force feature custom-protocol)..." -ForegroundColor Cyan
  # CLI 有时 --no-default-features，Cargo.toml default 的 custom-protocol 不会生效，
  # 编出的 release 仍 cfg(dev) → 双击去连 Vite 1420。显式 -f 保证嵌入 UI。
  npm run tauri build -- --features custom-protocol
  if ($LASTEXITCODE -ne 0) {
    Write-Host "tauri build exit $LASTEXITCODE (NSIS fail is OK if OmniPlayer.exe exists)" -ForegroundColor Yellow
  }

  # 双保险：若 CLI 仍没把 feature 传进 cargo，直接再编一次 release bin
  $env:CARGO_TARGET_DIR = Join-Path $Root "src-tauri\target"
  Push-Location (Join-Path $Root "src-tauri")
  try {
    cargo build --release --features custom-protocol
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
  } finally {
    Pop-Location
  }

  Write-Host "==> cargo build --release omnitrace_input..." -ForegroundColor Cyan
  Push-Location $Repo
  try {
    $env:CARGO_TARGET_DIR = Join-Path $Repo "target"
    cargo build --release --bin omnitrace_input
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
  } finally {
    Pop-Location
  }
}

$ReleaseDir = Join-Path $Root "src-tauri\target\release"
$BuiltExe = $null
foreach ($name in @("OmniPlayer.exe", "omniplayer.exe")) {
  $candidate = Join-Path $ReleaseDir $name
  if (Test-Path $candidate) { $BuiltExe = $candidate; break }
}
if (-not $BuiltExe) {
  Write-Error "Missing release exe under $ReleaseDir"
  exit 1
}

# 防再装「假正式版」：最新 build script 若仍 rustc-cfg=dev，双击会连 Vite 1420。
$buildOutDir = Join-Path $Root "src-tauri\target\release\build"
$latestAppBuild = Get-ChildItem $buildOutDir -Directory -Filter "omniplayer-*" -ErrorAction SilentlyContinue |
  Where-Object { Test-Path (Join-Path $_.FullName "output") } |
  Sort-Object LastWriteTime -Descending |
  Select-Object -First 1
if (-not $latestAppBuild) {
  Write-Error "No omniplayer build script output under $buildOutDir"
  exit 1
}
$buildOut = Get-Content (Join-Path $latestAppBuild.FullName "output") -Raw
if ($buildOut -match "(?m)^cargo:rustc-cfg=dev\s*$") {
  Write-Error @"
Release OmniPlayer compiled with cfg(dev) ($($latestAppBuild.Name)).
Double-click would open http://127.0.0.1:1420 → ERR_CONNECTION_REFUSED.
Need feature custom-protocol on tauri. Built: $BuiltExe
"@
  exit 1
}
Write-Host "cfg(dev) check OK ($($latestAppBuild.Name))" -ForegroundColor Green

$RecorderExe = Join-Path $Repo "target\release\omnitrace_input.exe"
if (-not (Test-Path $RecorderExe)) {
  $alt = Join-Path $ReleaseDir "omnitrace_input.exe"
  if (Test-Path $alt) { $RecorderExe = $alt }
}

New-Item -ItemType Directory -Force -Path $Dist | Out-Null
Copy-Item $BuiltExe (Join-Path $Dist "OmniPlayer.exe") -Force
if (Test-Path $RecorderExe) {
  Copy-Item $RecorderExe (Join-Path $Dist "omnitrace_input.exe") -Force
} else {
  Write-Warning "omnitrace_input.exe not found; packaged install cannot start capture without cargo"
}
Copy-Item (Join-Path $Root "package\*") $Dist -Force

$BundleNsis = Join-Path $ReleaseDir "bundle\nsis"
$installer = Get-ChildItem $BundleNsis -Filter "*.exe" -ErrorAction SilentlyContinue | Select-Object -First 1
if ($installer) {
  Copy-Item $installer.FullName (Join-Path $Dist "OmniPlayer_Setup.exe") -Force
}

Write-Host ""
Write-Host "portable folder:" -ForegroundColor Green
Write-Host "  $Dist"

if (-not $Install) {
  Write-Host "To install stable + desktop shortcut:  .\package.ps1 -Install  or  ..\scripts\install-stable.ps1"
  exit 0
}

if (-not (Test-Path $DbRoot)) {
  Write-Warning "OmniDatabase not found at $DbRoot ; pointer will still be written"
}

New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
New-Item -ItemType Directory -Force -Path $IncomingDir | Out-Null

$running = Test-StableRunning
if ($running) {
  # 仅在稳定版占用 exe 时写入 incoming，供关于→更新旁路替换；勿在空闲安装时留一份同内容 twin
  Copy-ReleaseBits $IncomingDir
  Write-DataRootPointer $IncomingDir
  Write-Host "stable app is running; wrote incoming. Use About -> Update." -ForegroundColor Yellow
} else {
  Copy-ReleaseBits $InstallDir
  Write-DataRootPointer $InstallDir
  Write-UninstallScript
  Install-UninstallKey (Get-AppVersion)
  $exe = Join-Path $InstallDir "OmniPlayer.exe"
  New-Shortcut (Join-Path ([Environment]::GetFolderPath("Desktop")) "OmniTrace.lnk") $exe $InstallDir
  $startLink = Join-Path $env:APPDATA "Microsoft\Windows\Start Menu\Programs\OmniTrace\OmniTrace.lnk"
  New-Shortcut $startLink $exe $InstallDir
  # 空闲安装后清空误报：incoming 里不应残留与当前相同的 OmniPlayer.exe
  Get-ChildItem $IncomingDir -Force -ErrorAction SilentlyContinue | Remove-Item -Recurse -Force -ErrorAction SilentlyContinue
  Write-Host "installed stable (OmniDatabase not modified):" -ForegroundColor Green
  Write-Host "  $InstallDir"
  Write-Host "  desktop shortcut: OmniTrace.lnk"
}

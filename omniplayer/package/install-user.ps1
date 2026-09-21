# Install the unzipped Liuhen (留痕) folder for the current Windows user.
# Programs: %LOCALAPPDATA%\OmniTrace  (folder name unchanged for compatibility)
# Data:     %USERPROFILE%\OmniTrace\OmniDatabase  (created if missing)
# Uninstall does not delete the data folder.
$ErrorActionPreference = "Stop"

$Here = Split-Path -Parent $MyInvocation.MyCommand.Path
$InstallDir = Join-Path $env:LOCALAPPDATA "OmniTrace"
$IncomingDir = Join-Path $InstallDir "incoming"
$DataRoot = Join-Path $env:USERPROFILE (Join-Path "OmniTrace" "OmniDatabase")
$ExeSrc = Join-Path $Here "OmniPlayer.exe"
$RecSrc = Join-Path $Here "omnitrace_input.exe"

if (-not (Test-Path -LiteralPath $ExeSrc)) {
  Write-Error "OmniPlayer.exe not found next to this script. Unzip the whole folder first."
  exit 1
}

function Test-AppRunning([string]$ExePath) {
  if (-not (Test-Path -LiteralPath $ExePath)) { return $false }
  $want = [System.IO.Path]::GetFullPath($ExePath)
  $procs = Get-Process -Name OmniPlayer, omniplayer -ErrorAction SilentlyContinue
  foreach ($p in $procs) {
    try {
      if ($p.Path -and ($p.Path -ieq $want)) { return $true }
    } catch {}
  }
  return $false
}

$destExe = Join-Path $InstallDir "OmniPlayer.exe"
if (Test-AppRunning $destExe) {
  Write-Error "留痕 is running. Close it, then run this installer again."
  exit 1
}
if (Test-AppRunning $ExeSrc) {
  Write-Error "留痕 is running from this unzipped folder. Close it, then run this installer again."
  exit 1
}

New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
New-Item -ItemType Directory -Force -Path $IncomingDir | Out-Null
New-Item -ItemType Directory -Force -Path $DataRoot | Out-Null

Get-ChildItem -LiteralPath $Here -File | Where-Object {
  $_.Name -ne "data_root.json"
} | ForEach-Object {
  Copy-Item -LiteralPath $_.FullName -Destination (Join-Path $InstallDir $_.Name) -Force
}

Get-ChildItem -LiteralPath $InstallDir -File -ErrorAction SilentlyContinue |
  ForEach-Object { Unblock-File -LiteralPath $_.FullName -ErrorAction SilentlyContinue }

$ptrFile = Join-Path $InstallDir "data_root.json"
if (-not (Test-Path -LiteralPath $ptrFile)) {
  $ptr = @{ path = $DataRoot } | ConvertTo-Json -Compress
  $utf8 = New-Object System.Text.UTF8Encoding $false
  [System.IO.File]::WriteAllText($ptrFile, $ptr, $utf8)
}

$version = "0.1.4"
$verFile = Join-Path $InstallDir "VERSION.txt"
if (Test-Path -LiteralPath $verFile) {
  $line = (Get-Content -LiteralPath $verFile -TotalCount 1 -ErrorAction SilentlyContinue)
  if ($line) { $version = $line.Trim() }
}

function New-Shortcut([string]$LinkPath, [string]$Target, [string]$WorkDir) {
  $dir = Split-Path -Parent $LinkPath
  New-Item -ItemType Directory -Force -Path $dir | Out-Null
  $ws = New-Object -ComObject WScript.Shell
  $sc = $ws.CreateShortcut($LinkPath)
  $sc.TargetPath = $Target
  $sc.WorkingDirectory = $WorkDir
  $sc.Description = "留痕"
  $ico = Join-Path $WorkDir "OmniTrace.ico"
  if (Test-Path -LiteralPath $ico) { $sc.IconLocation = "$ico,0" }
  $sc.Save()
}

$desk = Join-Path ([Environment]::GetFolderPath("Desktop")) "留痕.lnk"
$deskLegacy = Join-Path ([Environment]::GetFolderPath("Desktop")) "OmniTrace.lnk"
$startDir = Join-Path $env:APPDATA "Microsoft\Windows\Start Menu\Programs\留痕"
$startLegacy = Join-Path $env:APPDATA "Microsoft\Windows\Start Menu\Programs\OmniTrace"
$startLink = Join-Path $startDir "留痕.lnk"
$exe = Join-Path $InstallDir "OmniPlayer.exe"
Remove-Item $deskLegacy -Force -ErrorAction SilentlyContinue
Remove-Item $startLegacy -Recurse -Force -ErrorAction SilentlyContinue
New-Shortcut $desk $exe $InstallDir
New-Shortcut $startLink $exe $InstallDir

$uninst = Join-Path $InstallDir "uninstall.ps1"
$uninstLines = @(
  '$ErrorActionPreference = ''Continue''',
  ('$install = ''' + $InstallDir + ''''),
  ('$desk = ''' + $desk + ''''),
  ('$deskLegacy = ''' + $deskLegacy + ''''),
  ('$startDir = ''' + $startDir + ''''),
  ('$startLegacy = ''' + $startLegacy + ''''),
  '$key = ''HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\OmniTrace''',
  'Remove-Item $desk -Force -ErrorAction SilentlyContinue',
  'Remove-Item $deskLegacy -Force -ErrorAction SilentlyContinue',
  'Remove-Item $startDir -Recurse -Force -ErrorAction SilentlyContinue',
  'Remove-Item $startLegacy -Recurse -Force -ErrorAction SilentlyContinue',
  'Remove-Item $key -Recurse -Force -ErrorAction SilentlyContinue',
  'Get-ChildItem $install -Force -ErrorAction SilentlyContinue | Where-Object { $_.Name -ne ''uninstall.ps1'' } | Remove-Item -Recurse -Force -ErrorAction SilentlyContinue',
  'Remove-Item $install -Recurse -Force -ErrorAction SilentlyContinue',
  'Write-Host ''留痕 removed. Your data folder was not deleted.'''
)
$utf8 = New-Object System.Text.UTF8Encoding $false
[System.IO.File]::WriteAllText($uninst, ($uninstLines -join "`r`n") + "`r`n", $utf8)

$uninstCmd = 'powershell.exe -NoProfile -ExecutionPolicy Bypass -File "' + $uninst + '"'
$key = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\OmniTrace"
New-Item -Path $key -Force | Out-Null
New-ItemProperty -Path $key -Name "DisplayName" -Value "留痕" -PropertyType String -Force | Out-Null
New-ItemProperty -Path $key -Name "DisplayVersion" -Value $version -PropertyType String -Force | Out-Null
New-ItemProperty -Path $key -Name "Publisher" -Value "Fortda" -PropertyType String -Force | Out-Null
New-ItemProperty -Path $key -Name "InstallLocation" -Value $InstallDir -PropertyType String -Force | Out-Null
New-ItemProperty -Path $key -Name "UninstallString" -Value $uninstCmd -PropertyType String -Force | Out-Null
New-ItemProperty -Path $key -Name "NoModify" -Value 1 -PropertyType DWord -Force | Out-Null
New-ItemProperty -Path $key -Name "NoRepair" -Value 1 -PropertyType DWord -Force | Out-Null

if (-not (Test-Path -LiteralPath $RecSrc)) {
  Write-Warning "omnitrace_input.exe was missing from the zip; recording may not start."
}

Write-Host ""
Write-Host "Installed:" $InstallDir
Write-Host "Data stays in:" $DataRoot
Write-Host "Shortcut: desktop 留痕"
Write-Host "Uninstall: Windows Settings -> Apps -> 留痕 (data folder is kept)"
Write-Host ""

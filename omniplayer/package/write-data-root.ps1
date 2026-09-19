# Called by the NSIS setup.exe (and safe to run by hand).
# Writes data_root.json next to the installed exe.
# Data lives under %USERPROFILE%\OmniTrace\OmniDatabase — never inside the program folder.
param(
  [Parameter(Mandatory = $true)]
  [string]$InstallDir
)

$ErrorActionPreference = "Stop"

if (-not (Test-Path -LiteralPath $InstallDir)) {
  Write-Error "InstallDir does not exist: $InstallDir"
  exit 1
}

$DataRoot = Join-Path $env:USERPROFILE (Join-Path "OmniTrace" "OmniDatabase")
New-Item -ItemType Directory -Force -Path $DataRoot | Out-Null

$ptr = @{ path = $DataRoot } | ConvertTo-Json -Compress
$utf8 = New-Object System.Text.UTF8Encoding $false
[System.IO.File]::WriteAllText((Join-Path $InstallDir "data_root.json"), $ptr, $utf8)

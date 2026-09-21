# Build a sideload APK and copy it to dist/Liuhen-<version>-android.apk
#
# - Never packs OmniDatabase (the APK is compiled from omnitrace_android/ only)
# - Signs with the machine debug keystore unless OMNI_ANDROID_STORE_FILE is set
# - Almost unusable; attach to a GitHub Release, do not treat as a daily driver
#
# Usage (repo root or this folder):
#   .\omnitrace_android\package.ps1
#
param(
  [string]$Version = "",
  [int]$VersionCode = 0
)

$ErrorActionPreference = "Stop"
$AndroidRoot = $PSScriptRoot
$Repo = Split-Path -Parent $AndroidRoot
$DistDir = Join-Path $Repo "dist"

function Read-OmniVersion {
  $tauri = Join-Path $Repo "omniplayer\src-tauri\tauri.conf.json"
  if (-not (Test-Path $tauri)) { return "0.1.4" }
  $m = [regex]::Match((Get-Content -Raw $tauri), '"version"\s*:\s*"([^"]+)"')
  if ($m.Success) { return $m.Groups[1].Value }
  return "0.1.4"
}

if (-not $Version) { $Version = Read-OmniVersion }
if ($VersionCode -le 0) {
  $parts = $Version.Split(".") | ForEach-Object { [int]($_ -replace "[^0-9]", "0") }
  if ($parts.Count -ge 3) {
    $VersionCode = ($parts[0] * 10000) + ($parts[1] * 100) + $parts[2]
  } else {
    $VersionCode = 14
  }
}

$jdkCandidates = @(
  $env:JAVA_HOME,
  "C:\Program Files\Microsoft\jdk-21.0.7.6-hotspot",
  "C:\Program Files\Microsoft\jdk-21*",
  "C:\Program Files\Eclipse Adoptium\jdk-21*"
) | Where-Object { $_ }
$javaHome = $null
foreach ($c in $jdkCandidates) {
  $resolved = Get-Item $c -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($resolved -and (Test-Path (Join-Path $resolved.FullName "bin\java.exe"))) {
    $javaHome = $resolved.FullName
    break
  }
}
if (-not $javaHome) {
  throw "Need JDK 17+ (e.g. C:\Program Files\Microsoft\jdk-21.0.7.6-hotspot). JAVA 8 on PATH is not enough."
}
$env:JAVA_HOME = $javaHome
$env:PATH = (Join-Path $javaHome "bin") + ";" + $env:PATH

$sdkCandidates = @(
  $env:ANDROID_HOME,
  $env:ANDROID_SDK_ROOT,
  (Join-Path $env:LOCALAPPDATA "Android\Sdk"),
  "E:\tools\Android Emulator"
) | Where-Object { $_ }
$sdk = $null
foreach ($c in $sdkCandidates) {
  if (Test-Path (Join-Path $c "platforms")) { $sdk = $c; break }
}
if (-not $sdk) {
  throw "Android SDK not found. Set ANDROID_HOME or copy local.properties.example to local.properties."
}
$env:ANDROID_HOME = $sdk
$env:ANDROID_SDK_ROOT = $sdk

$localProps = Join-Path $AndroidRoot "local.properties"
$sdkEscaped = ($sdk -replace "\\", "\\")
$utf8 = New-Object System.Text.UTF8Encoding $false
[System.IO.File]::WriteAllText($localProps, "sdk.dir=$sdkEscaped`n", $utf8)

$debugKs = Join-Path $env:USERPROFILE ".android\debug.keystore"
if (-not $env:OMNI_ANDROID_STORE_FILE -and -not (Test-Path $debugKs)) {
  New-Item -ItemType Directory -Force -Path (Split-Path $debugKs) | Out-Null
  & (Join-Path $javaHome "bin\keytool.exe") -genkeypair -v `
    -keystore $debugKs -storepass android -alias androiddebugkey `
    -keypass android -keyalg RSA -keysize 2048 -validity 10000 `
    -dname "CN=Android Debug,O=Android,C=US"
}

function Resolve-GradleCommand {
  $wrapper = Join-Path $AndroidRoot "gradlew.bat"
  if (Test-Path $wrapper) { return $wrapper }
  $cached = Get-ChildItem (Join-Path $env:USERPROFILE ".gradle\wrapper\dists\gradle-8.7-bin") -Recurse -Filter "gradle.bat" -ErrorAction SilentlyContinue |
    Where-Object { $_.FullName -match "\\bin\\gradle\.bat$" } |
    Select-Object -First 1
  if ($cached) { return $cached.FullName }
  $onPath = Get-Command gradle -ErrorAction SilentlyContinue
  if ($onPath) { return $onPath.Source }
  throw "No Gradle wrapper and no Gradle 8.7 cache. Install the wrapper or a local Gradle 8.7."
}

$gradleCmd = Resolve-GradleCommand
Write-Host "Using Gradle: $gradleCmd"

Push-Location $AndroidRoot
try {
  & $gradleCmd ":app:assembleRelease" --no-daemon "-PomniVersion=$Version" "-PomniVersionCode=$VersionCode"
  if ($LASTEXITCODE -ne 0) { throw "gradle assembleRelease failed ($LASTEXITCODE)" }
} finally {
  Pop-Location
}

$built = Join-Path $AndroidRoot "app\build\outputs\apk\release\app-release.apk"
if (-not (Test-Path $built)) {
  throw "APK missing after build: $built"
}

Add-Type -AssemblyName System.IO.Compression.FileSystem
$zip = [System.IO.Compression.ZipFile]::OpenRead($built)
try {
  $leak = $zip.Entries | Where-Object { $_.FullName -match "(?i)OmniDatabase" }
  if ($leak) {
    throw "Refusing APK: it contains OmniDatabase paths: $($leak.FullName -join ', ')"
  }
} finally {
  $zip.Dispose()
}

New-Item -ItemType Directory -Force -Path $DistDir | Out-Null
$out = Join-Path $DistDir "Liuhen-$Version-android.apk"
Copy-Item $built $out -Force
$item = Get-Item $out
Write-Host ""
Write-Host "Sideload APK (debug-signed unless OMNI_ANDROID_STORE_FILE is set):"
Write-Host ("  {0}  ({1:N1} MB)" -f $item.FullName, ($item.Length / 1MB))
Write-Host "Almost unusable. Data stays on the phone. Do not upload traces."

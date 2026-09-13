# 把手机 OmniDatabase 拉到本仓库旁路根：
#   OmniDatabase/sources/<android_id>/
# 用法：连上 adb 后在仓库根执行
#   powershell -File omnitrace_android/package/pull-to-sidecar.ps1

$ErrorActionPreference = "Stop"
$repo = Resolve-Path (Join-Path $PSScriptRoot "..\..")
$adb = Get-Command adb -ErrorAction SilentlyContinue
if (-not $adb) {
    Write-Error "找不到 adb。先装 platform-tools 并加入 PATH。"
}

$model = (adb shell getprop ro.product.model).Trim()
$aid = (adb shell settings get secure android_id).Trim()
$safeModel = [regex]::Replace($model, "[^A-Za-z0-9._-]", "_")
$id = "android_${safeModel}_$aid"
$dest = Join-Path $repo "OmniDatabase\sources\$id"
New-Item -ItemType Directory -Force -Path $dest | Out-Null

$remote = "/sdcard/Android/data/com.omnitrace.android/files/OmniDatabase"
Write-Host "pull $remote -> $dest"
adb pull $remote $dest
if (Test-Path (Join-Path $dest "OmniDatabase")) {
    Get-ChildItem (Join-Path $dest "OmniDatabase") | ForEach-Object {
        Move-Item -Force $_.FullName (Join-Path $dest $_.Name)
    }
    Remove-Item -Recurse -Force (Join-Path $dest "OmniDatabase")
}
Write-Host "done: $dest"
Write-Host "不要把 imu_DD.bin 合并进 Windows 的 EventData/.../trace_DD.bin"

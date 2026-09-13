# 编 release 并安装当前用户稳定版（桌面快捷方式 + HKCU 卸载项）。
# 用法：在仓库根 powershell -NoProfile -ExecutionPolicy Bypass -File scripts\install-stable.ps1
# 已编过：加 -SkipBuild
param(
  [switch]$SkipBuild
)
$ErrorActionPreference = "Stop"
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$pkg = Join-Path $here "..\omniplayer\package.ps1"
& $pkg -Install -SkipBuild:$SkipBuild
exit $LASTEXITCODE

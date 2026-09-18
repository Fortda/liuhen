@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo Installing OmniTrace for this Windows user...
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0install-user.ps1"
if errorlevel 1 (
  echo.
  echo Install failed.
  pause
  exit /b 1
)
echo.
pause

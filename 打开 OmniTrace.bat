@echo off
chcp 65001 >nul
cd /d "%~dp0"
start "OmniTrace" cmd /c call "%~dp0scripts\run-app.bat"
exit /b 0

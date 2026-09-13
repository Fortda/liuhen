@echo off
chcp 65001 >nul
cd /d "%~dp0"
start "OmniTrace Notes" cmd /c call "%~dp0scripts\run-app.bat" --page=notes
exit /b 0

@echo off
chcp 65001 >nul
cd /d "%~dp0..\omniplayer"
if not exist "node_modules" goto do_install
goto run_dev

:do_install
echo First run: npm install ...
call npm install
if errorlevel 1 goto npm_fail
goto run_dev

:npm_fail
echo npm install failed
pause
exit /b 1

:run_dev
rem Forward CLI (e.g. --page=notes) past npm/tauri into the app binary.
call npm run tauri -- dev -- %*
if errorlevel 1 pause
exit /b %ERRORLEVEL%

@echo off
setlocal
rem ============================================================
rem  SLG Offline - source-mode launcher
rem  Runs the original Cocos web-desktop build inside Electron,
rem  with the local protocol server on 127.0.0.1:8088 / :8004.
rem
rem  ELECTRON_RUN_AS_NODE must be empty: if it is set, electron.exe
rem  starts as plain Node and `app` is undefined (crash on boot).
rem ============================================================
set ELECTRON_RUN_AS_NODE=
cd /d "%~dp0"

set "EXE=node_modules\electron\dist\electron.exe"
if not exist "%EXE%" goto noexe

start "" "%EXE%" "."
exit /b 0

:noexe
echo.
echo   [ERROR] Electron runtime not found:
echo           %~dp0%EXE%
echo   Run "npm install" inside this folder first.
echo.
pause
exit /b 1

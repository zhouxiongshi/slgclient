@echo off
setlocal
rem ============================================================
rem  SLG Offline - packaged build launcher
rem  Runs build\SLG-Offline-win32-x64\SLG-Offline.exe
rem  (self-contained Electron runtime + the untouched web build).
rem
rem  ELECTRON_RUN_AS_NODE must be empty, otherwise the packaged
rem  runtime starts as plain Node and `app` is undefined.
rem ============================================================
set ELECTRON_RUN_AS_NODE=
cd /d "%~dp0"

set "EXE=build\SLG-Offline-win32-x64\SLG-Offline.exe"
if not exist "%EXE%" goto nobuild

start "" "%EXE%"
exit /b 0

:nobuild
echo.
echo   [ERROR] Packaged build not found:
echo           %~dp0%EXE%
echo   Run "npm run pack" inside this folder first.
echo.
pause
exit /b 1

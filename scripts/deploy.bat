@echo off
REM ---------------------------------------------------------------------------
REM deploy.bat - one-click deploy of the latest pushed code to this server.
REM
REM Wraps scripts\update.ps1 (git pull -> stop -> npm ci if a lockfile changed
REM -> start -> health-check; auto-rolls back on any failure).
REM
REM Usage: double-click this file on the server (it lives next to update.ps1).
REM Note: if you ever run it over SSH instead, call update.ps1 directly -
REM       the PAUSE below would hang a non-interactive session.
REM ---------------------------------------------------------------------------
title speedtest-logger deploy
powershell -ExecutionPolicy Bypass -File "%~dp0update.ps1"
set "RC=%ERRORLEVEL%"
echo.
echo [deploy] update.ps1 exited with code %RC% (0 = success, 1 = failed/rolled back).
pause
exit /b %RC%

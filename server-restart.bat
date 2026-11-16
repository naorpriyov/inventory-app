@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo Restarting the background server...
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0server-control.ps1" -Action restart
echo Log file: logs\server.log
echo.
pause

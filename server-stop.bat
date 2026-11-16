@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo Stopping the background server...
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0server-control.ps1" -Action stop
echo It will start again at the next sign-in to Windows (or within 5 minutes),
echo or now with server-restart.bat.
echo.
pause

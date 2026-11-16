@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo Windows will ask for approval once. Click "Yes".
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0enable-always-on.ps1"
echo.
pause

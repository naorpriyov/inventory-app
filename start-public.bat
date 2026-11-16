@echo off
chcp 65001 >nul
cd /d "%~dp0"
set INV_HTTPS=1
rem Listen on this computer only; outside access goes through the secure Tailscale address
set INV_HOST=127.0.0.1

rem If the background server (scheduled task "InventoryServer") is already running, don't start a second copy.
netstat -ano | findstr /r /c:":8000 .*LISTENING" >nul
if not errorlevel 1 (
  echo.
  echo The server is already running in the background.
  echo To restart it use server-restart.bat, to stop it use server-stop.bat.
  echo.
  pause
  exit /b
)

rem The permanent address comes from Tailscale Funnel, which starts with the computer.
rem To check it: "C:\Program Files\Tailscale\tailscale.exe" funnel status
"C:\Program Files\Tailscale\tailscale.exe" funnel --bg --yes 8000 >nul 2>&1

rem Detect the current address and save it in the project folder (updates by itself if it changes)
set SITE_URL=
for /f "usebackq delims=" %%u in (`python update_link.py`) do set SITE_URL=%%u

echo.
echo Inventory server is running.
echo Address for phones:  %SITE_URL%
echo (also saved as a shortcut and a text file in the project folder)
echo Keep this window open.
echo.
python app.py
pause

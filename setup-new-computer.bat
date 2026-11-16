@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo === Inventory server: setup on a new computer ===
echo.

where python >nul 2>&1
if errorlevel 1 (
  echo Installing Python...
  winget install -e --id Python.Python.3.12 --accept-package-agreements --accept-source-agreements
  echo.
  echo Python was installed. Close this window and run setup-new-computer.bat again.
  pause
  exit /b
)

echo Installing the program's Python packages...
python -m pip install -r requirements.txt
if errorlevel 1 (
  echo Package installation failed. Check the internet connection and try again.
  pause
  exit /b
)

if not exist "C:\Program Files\Tailscale\tailscale.exe" (
  echo Installing Tailscale...
  winget install -e --id Tailscale.Tailscale --accept-package-agreements --accept-source-agreements
)

echo.
echo === Almost done. Do these steps yourself: ===
echo 1. Open Tailscale (icon near the clock) and sign in with the SAME account as before.
echo 2. In the Tailscale admin page (login.tailscale.com/admin/machines):
echo    remove the OLD computer, then rename this computer to:  cnd03720l6
echo    This keeps the same address, so the phones keep working.
echo 3. Make the server always on (starts with the computer, Windows asks once for approval):
echo    double-click enable-always-on.bat
echo    then double-click server-restart.bat to start it now.
echo.
pause

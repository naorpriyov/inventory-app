@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo Packing the program and all data into a zip file on the Desktop...
python pack_for_move.py
echo.
pause

@echo off
setlocal
cd /d "%~dp0.."
python tools\preview_blocking.py
if errorlevel 1 pause
endlocal
chcp 936 >nul

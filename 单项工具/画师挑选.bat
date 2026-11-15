@echo off
setlocal
cd /d "%~dp0.."
set "PY=python"
where python >nul 2>nul
if errorlevel 1 set "PY=py"
%PY% tools\danbooru_picker\server.py --open %*
if errorlevel 1 pause
chcp 936 >nul

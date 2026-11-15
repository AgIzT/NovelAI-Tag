@echo off
chcp 65001 >nul
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0..\..\工具箱\NAI法典批量配图\launchers\setup_official_key.ps1"
if errorlevel 1 pause

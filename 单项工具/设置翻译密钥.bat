@echo off
setlocal
chcp 65001 >nul
call "%~dp0补译中文对照.bat" --set-api-key
set "RC=%ERRORLEVEL%"
chcp 936 >nul
exit /b %RC%

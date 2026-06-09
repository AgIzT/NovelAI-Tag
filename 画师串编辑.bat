@echo off
setlocal
chcp 65001 >nul
cd /d "%~dp0"

set "PY="
where py >nul 2>nul && set "PY=py"
if not defined PY ( where python >nul 2>nul && set "PY=python" )
if not defined PY (
  echo [ERROR] Python not found.
  echo Install Python 3 from https://www.python.org/downloads/ ^(tick "Add to PATH"^).
  pause
  exit /b 1
)

echo Opening http://localhost:8768  (close this window to stop)
echo.
echo   Gallery : http://localhost:8768/strings.html
echo   Editor  : http://localhost:8768/__editor__
echo.
start "" http://localhost:8768/__editor__
%PY% tools\strings_server.py

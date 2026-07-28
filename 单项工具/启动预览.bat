@echo off
setlocal
chcp 65001 >nul
cd /d "%~dp0.."

REM --- find Python: prefer the 'py' launcher, then 'python' ---
set "PY="
where py >nul 2>nul && set "PY=py"
if not defined PY ( where python >nul 2>nul && set "PY=python" )
if not defined PY (
  echo [ERROR] Python not found.
  echo Install Python 3 from https://www.python.org/downloads/ ^(tick "Add to PATH"^).
  pause
  exit /b 1
)

echo Opening http://localhost:8766  (close this window to stop)
start "" http://localhost:8766
%PY% tools\preview_server.py
pause

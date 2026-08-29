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

REM --- make sure Pillow is installed (auto-fix if missing) ---
%PY% -c "import PIL" 2>nul
if errorlevel 1 (
  echo == Installing dependencies ^(python-docx, Pillow^) ==
  %PY% -m pip install -r requirements.txt
)

echo Image tool:  http://localhost:18767/__pei__
echo Gallery:     http://localhost:18767/
start "" http://localhost:18767/__pei__
%PY% tools\imgserver.py
pause

@echo off
setlocal EnableExtensions
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

%PY% -c "import PIL" 2>nul
if errorlevel 1 (
  echo == Installing dependencies ^(python-docx, Pillow^) ==
  %PY% -m pip install -r requirements.txt
)

%PY% -c "import PyInstaller" 2>nul
if errorlevel 1 (
  echo [ERROR] PyInstaller is missing. Run this first:  pip install pyinstaller
  pause
  exit /b 1
)

echo == Building the standalone local edition, this takes a few minutes ==
%PY% tools\build_local_edition.py
set "RC=%ERRORLEVEL%"
echo.
if "%RC%"=="0" (
  echo [DONE] Artifacts are under output\local-edition\
) else (
  echo [ERROR] Build failed with code %RC%.
)
pause
exit /b %RC%

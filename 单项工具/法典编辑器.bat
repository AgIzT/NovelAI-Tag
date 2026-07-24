@echo off
chcp 65001 >nul
cd /d "%~dp0.."

set PY=
if defined PYTHON_EXE (
  if exist "%PYTHON_EXE%" set PY="%PYTHON_EXE%"
)
if not defined PY (
  py -3 -c "import sys" >nul 2>nul
  if %errorlevel%==0 set "PY=py -3"
)
if not defined PY (
  py -c "import sys" >nul 2>nul
  if %errorlevel%==0 set "PY=py"
)
if not defined PY (
  python -c "import sys" >nul 2>nul
  if %errorlevel%==0 set PY=python
)

if not defined PY (
  echo Python 3 was not found.
  echo Install Python 3 first, or set PYTHON_EXE to the full path of python.exe.
  pause
  exit /b 1
)

%PY% -c "import PIL" >nul 2>nul
if not %errorlevel%==0 (
  echo Installing Pillow...
  %PY% -m pip install Pillow
)

echo Starting the codex editor server...
echo Open http://localhost:8769/ then click the pencil toggle in the topbar.
echo Every save is backed up to output\edit-backups\ first.
echo NOTE: do not run this together with the peitu tool (port 8767).
echo Press Ctrl+C to stop.
echo.
start "" http://localhost:8769/
%PY% tools\edit_server.py
pause

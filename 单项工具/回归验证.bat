@echo off
setlocal
chcp 65001 >nul
cd /d "%~dp0.."

set PY=
if defined PYTHON_EXE (
  if exist "%PYTHON_EXE%" set PY="%PYTHON_EXE%"
)
if not defined PY (
  py -3 -c "import sys" >nul 2>nul
  if not errorlevel 1 set "PY=py -3"
)
if not defined PY (
  py -c "import sys" >nul 2>nul
  if not errorlevel 1 set "PY=py"
)
if not defined PY (
  python -c "import sys" >nul 2>nul
  if not errorlevel 1 set PY=python
)

if not defined PY (
  echo Python 3 was not found.
  echo Install Python 3 first, or set PYTHON_EXE to the full path of python.exe.
  pause
  exit /b 1
)

echo Running UI regression checks...
echo Output will be written to output\ui-regression\
echo.
%PY% tools\verify_ui.py
set ERR=%errorlevel%
echo.
if "%ERR%"=="0" (
  echo UI regression checks passed.
) else (
  echo UI regression checks failed. Check the report under output\ui-regression\.
)
pause
exit /b %ERR%

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

echo Scanning output\ for cleanable reports (dry-run)...
echo Retention: keep newest 5 ui-regression runs, newest report per family; delete stray logs.
echo.
%PY% tools\cleanup_output.py
echo.
set /p CONFIRM=Type Y then Enter to delete the items listed above (anything else cancels):
if /i not "%CONFIRM%"=="Y" (
  echo Cancelled. Nothing was deleted.
  pause
  exit /b 0
)
%PY% tools\cleanup_output.py --apply
set ERR=%errorlevel%
echo.
if "%ERR%"=="0" (
  echo Cleanup finished.
) else (
  echo Cleanup finished with errors. See messages above.
)
pause
exit /b %ERR%

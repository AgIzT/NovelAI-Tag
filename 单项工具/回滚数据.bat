@echo off
setlocal EnableExtensions
cd /d "%~dp0.."
chcp 65001 >nul

set "PY="
python --version >nul 2>nul
if not errorlevel 1 set "PY=python"
if not defined PY (
  py -3 --version >nul 2>nul
  if not errorlevel 1 set "PY=py -3"
)
if not defined PY (
  echo [ERROR] Python not found.
  pause
  exit /b 1
)

if not exist r2_config.json (
  echo [ERROR] Missing r2_config.json
  pause
  exit /b 1
)

echo This switches current.json to its previous release.
set "CONFIRM="
set /p "CONFIRM=Type ROLLBACK to continue: "
if /i not "%CONFIRM%"=="ROLLBACK" (
  echo Cancelled.
  pause
  exit /b 0
)

call %PY% "tools\publish_data_r2.py" --rollback
set "RC=%ERRORLEVEL%"
echo.
if "%RC%"=="0" (
  echo [DONE] Previous data release is active.
) else (
  echo [ERROR] Rollback failed with code %RC%.
)
pause
exit /b %RC%

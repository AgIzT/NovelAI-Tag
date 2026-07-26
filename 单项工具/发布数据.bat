@echo off
setlocal EnableExtensions
cd /d "%~dp0.."

if /i "%~1"=="--inner" goto :inner

echo Publishing data from %CD%
echo.
call "%~f0" --inner
set "RC=%ERRORLEVEL%"
echo.
if "%RC%"=="0" (
  echo Done. The R2 data release is active; Git and Pages were not changed.
) else (
  echo Data publish failed. The previous R2 release remains active.
)
pause
exit /b %RC%

:inner
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
  echo Install Python 3 from https://www.python.org/downloads/ ^(tick "Add to PATH"^).
  exit /b 1
)

if not exist r2_config.json (
  echo [ERROR] Missing r2_config.json
  echo Copy r2_config.example.json to r2_config.json and fill in your R2 keys.
  exit /b 1
)

echo == Syncing images and JSON metadata to Cloudflare R2 ==
call %PY% "tools\sync_r2.py"
set "RC=%ERRORLEVEL%"
if "%RC%"=="0" goto :sync_ok
if "%RC%"=="2" (
  echo [WARN] R2 asset sync reported metadata issues, code %RC%. Continuing.
  goto :sync_ok
)
echo [ERROR] R2 asset sync failed with code %RC%.
exit /b %RC%

:sync_ok
echo == Building share card index ==
call %PY% "tools\build_share_index.py"
if errorlevel 1 exit /b 1

echo == Publishing immutable JSON release to Cloudflare R2 ==
call %PY% "tools\publish_data_r2.py" --publish
if errorlevel 1 exit /b 1

exit /b 0

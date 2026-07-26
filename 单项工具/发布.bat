@echo off
setlocal EnableExtensions
cd /d "%~dp0.."

if /i "%~1"=="--inner" goto :inner

echo Starting publish from %CD%
echo.
call "%~f0" --inner
set "RC=%ERRORLEVEL%"
echo.
if "%RC%"=="0" (
  echo Done. The live site updates in ~1 minute.
) else (
  echo Publish failed. Please check the message above.
)
pause
exit /b %RC%

:inner
chcp 65001 >nul

where git >nul 2>nul
if errorlevel 1 (
  echo Git not found. Please install Git for Windows first.
  exit /b 1
)

REM --- find Python: prefer python, then the py launcher ---
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
  echo Copy r2_config.example.json to r2_config.json and fill in your R2 keys before publishing.
  exit /b 1
)

echo == Syncing images to Cloudflare R2 ==
call %PY% "tools\sync_r2.py"
set "RC=%ERRORLEVEL%"
if "%RC%"=="0" goto :sync_ok
if "%RC%"=="2" (
  echo [WARN] R2 sync reported metadata issues, code %RC%. Continuing to publish.
  goto :sync_ok
)
echo [ERROR] R2 sync failed with code %RC%.
goto :fail

:sync_ok

echo == Building share card index ==
call %PY% "tools\build_share_index.py"
if errorlevel 1 (
  echo [ERROR] Share index build failed.
  goto :fail
)

echo == Publishing immutable JSON release to Cloudflare R2 ==
call %PY% "tools\publish_data_r2.py" --publish
if errorlevel 1 (
  echo [ERROR] R2 data release failed. Git and Pages were not published.
  goto :fail
)

echo == Publishing updates to GitHub - Cloudflare will auto-deploy ==
call git add -A
if errorlevel 1 goto :fail

call git diff --cached --quiet
if errorlevel 1 goto :commit
echo No local changes to commit.
goto :push

:commit
call git commit -m "update site data and images"
if errorlevel 1 goto :fail

:push
call git push
if errorlevel 1 goto :fail

exit /b 0

:fail
echo.
exit /b 1

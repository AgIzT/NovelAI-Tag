@echo off
setlocal EnableExtensions
cd /d "%~dp0.."

if /i "%~1"=="--inner" goto :inner

echo Publishing program only from %CD%
echo.
call "%~f0" --inner
set "RC=%ERRORLEVEL%"
echo.
if "%RC%"=="0" (
  echo Done. Program pushed; Cloudflare Pages will deploy it automatically.
  echo Data was NOT changed. After deployment, use menu 4 to check and publish data.
  echo For data that needs this new program, wait 4 hours after deployment before publishing data.
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

echo == Publishing program updates to GitHub - Cloudflare will auto-deploy ==
call git add -A
if errorlevel 1 goto :fail

call git diff --cached --quiet -- site/data
if errorlevel 1 (
  echo [ERROR] site/data is local-only and must be published through the R2 data release.
  call git restore --staged -- site/data
  goto :fail
)

call git diff --cached --quiet
if errorlevel 1 goto :commit
echo No local changes to commit.
goto :push

:commit
call git commit -m "更新站点程序"
if errorlevel 1 goto :fail

:push
call git push
if errorlevel 1 goto :fail

exit /b 0

:fail
echo.
exit /b 1

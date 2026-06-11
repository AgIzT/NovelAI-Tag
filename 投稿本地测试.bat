@echo off
setlocal
chcp 65001 >nul
cd /d "%~dp0"

REM --- need Node.js for wrangler (Cloudflare Pages local dev) ---
where node >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Node.js not found.
  echo Install Node.js from https://nodejs.org/ then run this again.
  pause
  exit /b 1
)

echo ============================================================
echo  Local test for community submission (Pages Functions + R2)
echo  Site : http://localhost:8788/strings.html
echo  Admin: http://localhost:8788/review.html   token: devtoken
echo  First run downloads wrangler, please wait...
echo  (close this window to stop)
echo ============================================================
start "" http://localhost:8788/strings.html
call npx --yes wrangler@4 pages dev site --port 8788 --r2 STRINGS_BUCKET --compatibility-date=2025-01-01
pause

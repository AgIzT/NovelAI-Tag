@echo off
setlocal
chcp 65001 >nul
cd /d "%~dp0.."

REM --- need Node.js for wrangler (Cloudflare Pages local dev) ---
where node >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Node.js not found.
  echo Install Node.js from https://nodejs.org/ then run this again.
  pause
  exit /b 1
)

REM --- Pages Functions only injects .dev.vars; append missing local-only values without overwriting ---
if not exist ".dev.vars" type nul >".dev.vars"
findstr /b /c:"ADMIN_TOKEN=" ".dev.vars" >nul || >>".dev.vars" echo ADMIN_TOKEN=devtoken
findstr /b /c:"STRINGS_PUBLIC_BASE=" ".dev.vars" >nul || >>".dev.vars" echo STRINGS_PUBLIC_BASE=/r2
findstr /b /c:"COMMUNITY_LIKES_ENABLED=" ".dev.vars" >nul || >>".dev.vars" echo COMMUNITY_LIKES_ENABLED=true
findstr /b /c:"ENGAGEMENT_COOKIE_SECRET=" ".dev.vars" >nul || >>".dev.vars" echo ENGAGEMENT_COOKIE_SECRET=local-development-only-5d8c17b4-8f97-4d14-a71a-4bb47f1f17e0
findstr /b /c:"RATE_LIMIT_SALT=" ".dev.vars" >nul || >>".dev.vars" echo RATE_LIMIT_SALT=local-development-only-community-likes

echo ============================================================
echo  Local test for community submission and likes (Pages Functions + R2 + D1)
echo  Site : http://localhost:8788/strings.html
echo  Admin: http://localhost:8788/review.html   token: devtoken
echo  First run downloads wrangler, please wait...
echo  (close this window to stop)
echo ============================================================
start "" http://localhost:8788/strings.html
echo.
echo Applying local D1 migrations...
call npx --yes wrangler@4 d1 migrations apply COMMUNITY_DB --local --config wrangler.likes.jsonc --persist-to .wrangler/state
if errorlevel 1 (
  echo [ERROR] Local D1 migration failed.
  pause
  exit /b 1
)

call npx --yes wrangler@4 pages dev site --port 8788 --r2 STRINGS_BUCKET --d1 COMMUNITY_DB --persist-to .wrangler/state --compatibility-date=2026-07-11 --compatibility-flag=nodejs_compat --env-file .dev.vars
pause

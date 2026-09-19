@echo off
setlocal
chcp 65001 >nul
cd /d "%~dp0.."

REM --- find Python: prefer the 'py' launcher, then 'python' ---
set "PY="
where py >nul 2>nul && set "PY=py"
if not defined PY ( where python >nul 2>nul && set "PY=python" )
if not defined PY (
  echo [ERROR] Python not found.
  echo Install Python 3 from https://www.python.org/downloads/
  echo and tick "Add python.exe to PATH" during setup, then re-run this file.
  pause
  exit /b 1
)

if not exist "tools\data\tag_zh\ai_config.json" (
  echo [ERROR] Missing tools\data\tag_zh\ai_config.json
  echo That file holds the AI relay settings ^(base_url / api_key / model^).
  echo It stays private and never enters the repository.
  pause
  exit /b 1
)

echo == Counting tags that still have no Chinese name ==
call %PY% tools\translate_tag_zh.py --dry-run
if errorlevel 1 (
  echo.
  echo [FAILED] Could not read the glossary tables - send the message above to fix it.
  pause
  exit /b 1
)

echo.
echo The next step CALLS A PAID AI ENDPOINT and may take a while.
echo Stopping here costs nothing. The run also resumes where it left off,
echo so an interrupted run is never wasted money.
echo.
set "ans="
set /p "ans=Type YES and press Enter to run, anything else cancels: "
if /i not "%ans%"=="YES" (
  echo Cancelled. No request was sent.
  pause
  exit /b 0
)

echo.
echo == Translating the long tail ==
REM Batches of 30: the relay blocks a whole batch on sensitive content, and small
REM batches keep one blocked tag from dragging its neighbours down with it.
call %PY% tools\translate_tag_zh.py --batch-size 30
if errorlevel 1 (
  echo.
  echo [FAILED] Translation run error - whatever was translated is already saved.
  echo Just run this file again; finished tags are skipped automatically.
  pause
  exit /b 1
)

echo.
echo == Rebuilding tag Chinese glossary shards ==
call %PY% tools\build_tag_zh.py
if errorlevel 1 (
  echo.
  echo [FAILED] Glossary build error - send the message above to fix it.
  pause
  exit /b 1
)

echo.
echo [DONE] AI table topped up, shards rewritten to site\data\tag_zh\
echo Reports: output\tag-zh\  (run report, coverage report, untranslated list)
echo Publish them with the normal "publish data" action.
pause
exit /b 0

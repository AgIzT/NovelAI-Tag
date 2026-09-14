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

echo == Building tag Chinese glossary shards ==
echo Sources: tools\data\tag_zh\ (manual table, AI table, community dictionary)
%PY% tools\build_tag_zh.py
if errorlevel 1 (
  echo.
  echo [FAILED] Glossary build error - please send the message above to fix it.
  pause
  exit /b 1
)

echo.
echo [DONE] Shards written to site\data\tag_zh\
echo Report: output\tag-zh\  (coverage report + untranslated list)
echo Publish them with the normal "publish data" action.
pause
exit /b 0

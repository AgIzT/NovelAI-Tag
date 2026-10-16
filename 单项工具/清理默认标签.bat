@echo off
setlocal
chcp 65001 >nul
cd /d "%~dp0.."
set "PY="
where py >nul 2>nul && set "PY=py"
if not defined PY ( where python >nul 2>nul && set "PY=python" )
if not defined PY (
  echo [ERROR] Python not found.
  pause
  chcp 936 >nul
  exit /b 1
)
echo == Clean complete NAI default tails in local positive prompts ==
echo Existing data is backed up before replacement.
%PY% tools\clean_nai_default_tags.py --apply
set "cleanup_exit=%ERRORLEVEL%"
if not "%cleanup_exit%"=="0" (
  echo [FAILED] Cleanup failed. See the message above.
) else (
  echo [DONE] Cleanup finished. Reports and backups are under output\default-tags-cleanup-YYYYMMDD.
)
pause
chcp 936 >nul
exit /b %cleanup_exit%

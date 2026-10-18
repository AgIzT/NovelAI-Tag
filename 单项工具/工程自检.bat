@echo off
setlocal EnableExtensions
chcp 65001 >nul
cd /d "%~dp0.."
set "AUDIT_NO_PAUSE="
set "AUDIT_RC=2"
if "%~1"=="--no-pause" set "AUDIT_NO_PAUSE=1"
if not "%~1"=="" if not "%~1"=="--no-pause" (
  echo Usage: engineering checks [--no-pause]
  goto finish
)

set "AUDIT_PY="
if defined PYTHON_EXE if exist "%PYTHON_EXE%" set AUDIT_PY="%PYTHON_EXE%"
if not defined AUDIT_PY (
  py -3 -c "import sys" >nul 2>nul
  if not errorlevel 1 set "AUDIT_PY=py -3"
)
if not defined AUDIT_PY (
  python -c "import sys" >nul 2>nul
  if not errorlevel 1 set "AUDIT_PY=python"
)
if not defined AUDIT_PY (
  echo BLOCKED: Python 3 was not found. Set PYTHON_EXE or install Python.
  goto finish
)

echo Running selected offline engineering checks. No publishing or production access.
echo Reports: output\project-audit\checks\
call %AUDIT_PY% -B tools\run_project_checks.py --profile quick
set "AUDIT_RC=%ERRORLEVEL%"
if "%AUDIT_RC%"=="0" (
  echo Selected checks passed. This is not a full project or production approval.
) else (
  echo Checks failed or were blocked. Read the report; do not treat skipped checks as passed.
)

:finish
if not defined AUDIT_NO_PAUSE pause
chcp 936 >nul
endlocal & exit /b %AUDIT_RC%

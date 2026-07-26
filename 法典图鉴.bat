@echo off
REM Encoding: GBK/936 - do NOT re-save as UTF-8 (Chinese menu would break)
REM ============================================================
REM  法典图鉴 总控台 —— 一个菜单整合全部维护动作
REM  逻辑自包含, 命令/路径全 ASCII; 旧的单项 .bat 已可弃用
REM ============================================================
setlocal EnableExtensions
chcp 936 >nul
cd /d "%~dp0"
title 法典图鉴 - 总控台

:menu
cls
echo ============================================================
echo                     法典图鉴  总控台
echo ============================================================
echo.
echo   [ 日常 ]
echo      1.  法典编辑器      浏览 + 编辑一体      :8769
echo      2.  配图工具        批量拖图配词条       :8767
echo.
echo   [ 发布上线 ]
echo      3.  同步 R2         上传图片到云端
echo      4.  发布            同步 R2 + 推送 (自动部署)
echo      5.  转换法典        法典源/ 新 docx 转数据
echo.
echo   [ 本地版发行 ]
echo      6.  打包本地版      生成独立发行包 + zip
echo.
echo   [ 开发 / 测试 ]
echo      7.  只读预览        访客视角            :8766
echo      8.  投稿本地测试    站 + 后端 + R2      :8788
echo      9.  画风串编辑                          :8768
echo     10.  回归验证        UI 自检
echo     11.  清理输出        按保留策略清 output
echo.
echo      0.  退出
echo ------------------------------------------------------------
set "c="
set /p "c=  请输入序号后回车: "
if "%c%"=="1" goto act_editor
if "%c%"=="2" goto act_imgserver
if "%c%"=="3" goto act_sync
if "%c%"=="4" goto act_publish
if "%c%"=="5" goto act_convert
if "%c%"=="6" goto act_buildlocal
if "%c%"=="7" goto act_preview
if "%c%"=="8" goto act_wrangler
if "%c%"=="9" goto act_strings
if "%c%"=="10" goto act_verify
if "%c%"=="11" goto act_cleanup
if "%c%"=="0" goto end
goto menu

:act_editor
call :findpy
if errorlevel 1 goto menu
%PY% -c "import PIL" 2>nul
if errorlevel 1 (
  echo == 安装依赖 python-docx, Pillow ==
  %PY% -m pip install -r requirements.txt
)
echo 已在新窗口启动法典编辑器, 浏览器打开 http://localhost:8769
echo 点顶栏铅笔进入编辑模式; 每次保存前会自动备份到 output\edit-backups\
echo 注意: 不要和配图工具 (菜单 2) 同时开, 两者都会写同一份数据
start "" http://localhost:8769
start "fadian-editor-8769" /D "%~dp0" %PY% tools\edit_server.py
goto menu

:act_buildlocal
call :findpy
if errorlevel 1 goto menu
%PY% -c "import PIL" 2>nul
if errorlevel 1 (
  echo == 安装依赖 python-docx, Pillow ==
  %PY% -m pip install -r requirements.txt
)
%PY% -c "import PyInstaller" 2>nul
if errorlevel 1 (
  echo [ERROR] 缺少 PyInstaller, 请先运行: pip install pyinstaller
  pause
  goto menu
)
echo == 构建独立本地版, 需要几分钟 ==
%PY% tools\build_local_edition.py
echo.
echo 产物在 output\local-edition\
pause
goto menu

:act_cleanup
call :findpy
if errorlevel 1 goto menu
echo == 先预览将被清理的内容 ==
%PY% tools\cleanup_output.py
echo.
set "yn="
set /p "yn=  确认删除以上项目? 输入 Y 回车 (其它键取消): "
if /i not "%yn%"=="Y" goto menu
%PY% tools\cleanup_output.py --apply
echo.
pause
goto menu

:act_preview
call :findpy
if errorlevel 1 goto menu
echo 已在新窗口启动预览, 浏览器打开 http://localhost:8766
start "" http://localhost:8766
start "fadian-preview-8766" /D "%~dp0" %PY% tools\preview_server.py
goto menu

:act_imgserver
call :findpy
if errorlevel 1 goto menu
%PY% -c "import PIL" 2>nul
if errorlevel 1 (
  echo == 安装依赖 python-docx, Pillow ==
  %PY% -m pip install -r requirements.txt
)
echo 已在新窗口启动配图工具, 浏览器打开 http://localhost:8767/__pei__
start "" http://localhost:8767/__pei__
start "fadian-imgserver-8767" /D "%~dp0" %PY% tools\imgserver.py
goto menu

:act_strings
call :findpy
if errorlevel 1 goto menu
echo 已在新窗口启动画风串编辑器 http://localhost:8768/__editor__
start "" http://localhost:8768/__editor__
start "fadian-strings-8768" /D "%~dp0" %PY% tools\strings_server.py
goto menu

:act_wrangler
echo 已在新窗口启动投稿本地测试 站+后端+R2+D1 :8788
start "fadian-wrangler-8788" /D "%~dp0" cmd /c call "单项工具\投稿本地测试.bat"
goto menu

:act_sync
call :findpy
if errorlevel 1 goto menu
if not exist r2_config.json (
  echo [ERROR] 缺少 r2_config.json  ^(从 r2_config.example.json 复制并填 R2 密钥^)
  pause
  goto menu
)
%PY% tools\sync_r2.py
echo.
pause
goto menu

:act_convert
call :findpy
if errorlevel 1 goto menu
%PY% -c "import docx" 2>nul
if errorlevel 1 (
  echo == 安装依赖 python-docx, Pillow ==
  %PY% -m pip install -r requirements.txt
)
echo == 转换 法典源/ 里的 docx ==
%PY% tools\convert.py --archive-sources
echo.
pause
goto menu

:act_publish
where git >nul 2>nul
if errorlevel 1 (
  echo [ERROR] 未找到 Git, 请先安装 Git for Windows
  pause
  goto menu
)
call :findpy
if errorlevel 1 goto menu
if not exist r2_config.json (
  echo [ERROR] 缺少 r2_config.json  ^(从 r2_config.example.json 复制^)
  pause
  goto menu
)
echo == 同步图片到 Cloudflare R2 ==
%PY% tools\sync_r2.py
set "RC=%ERRORLEVEL%"
if "%RC%"=="0" goto pub_git
if "%RC%"=="2" (
  echo [WARN] R2 元数据有提示 ^(code 2^), 继续发布
  goto pub_git
)
echo [ERROR] R2 同步失败, code %RC%
pause
goto menu
:pub_git
echo == 推送到 GitHub - Cloudflare 自动部署 ==
git add -A
git diff --cached --quiet
if errorlevel 1 goto pub_commit
echo 没有本地改动需要提交
goto pub_push
:pub_commit
git commit -m "update site data and images"
:pub_push
git push
if errorlevel 1 (
  echo 发布失败, 请看上面的提示
  pause
  goto menu
)
echo.
echo 完成. 线上约 1 分钟后更新
pause
goto menu

:act_verify
call :findpy
if errorlevel 1 goto menu
echo 正在运行 UI 回归自检, 报告写到 output\ui-regression\
echo.
%PY% tools\verify_ui.py
echo.
pause
goto menu

:findpy
set "PY="
where py >nul 2>nul && set "PY=py"
if not defined PY ( where python >nul 2>nul && set "PY=python" )
if not defined PY (
  echo [ERROR] 未找到 Python. 去 https://www.python.org/downloads/ 装, 勾选 Add to PATH
  pause
  exit /b 1
)
exit /b 0

:end
endlocal
exit /b 0

@echo off
REM Encoding: GBK/936 - do NOT re-save as UTF-8 (Chinese menu would break)
REM ============================================================
REM  法典图鉴 总控台 —— 唯一入口
REM  本文件只做菜单和分发, 每个动作的真正实现都在 单项工具\*.bat
REM  注意: 别把实现抄回这里。抄过一次, 结果两边各改各的, 菜单那份漏了 R2
REM     数据发布, 线上会静默停在旧数据。改动作请改 单项工具\ 里那一份。
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
echo   [ 日常维护 ]
echo      1.  法典编辑器      浏览 + 编辑一体          :18769
echo      2.  配图工具        批量拖图配词条           :18767
echo      3.  转换法典        法典源\ 新 docx 转数据
echo.
echo   [ 上线 ]
echo      4.  发布数据        图片 + 分享索引 + R2 数据版本 ^(不动 Git^)
echo      5.  发布程序        先发布数据, 再推 GitHub 自动部署
echo      6.  回滚数据        切回上一个 R2 数据版本
echo.
echo   [ 发行 ]
echo      7.  打包本地版      生成独立发行包 + zip
echo.
echo   [ 开发 / 测试 ]
echo      8.  只读预览        访客视角                 :8766
echo      9.  投稿本地测试    站 + 后端 + R2 + D1      :8788
echo     10.  画风串编辑                               :18768
echo     11.  回归验证        UI 自检
echo     12.  清理输出        按保留策略清 output
echo     13.  互动数据库迁移  生产 D1, 谨慎
echo.
echo      0.  退出
echo ------------------------------------------------------------
set "c="
set /p "c=  请输入序号后回车: "
if "%c%"=="1" goto act_editor
if "%c%"=="2" goto act_imgserver
if "%c%"=="3" goto act_convert
if "%c%"=="4" goto act_publish_data
if "%c%"=="5" goto act_publish
if "%c%"=="6" goto act_rollback
if "%c%"=="7" goto act_buildlocal
if "%c%"=="8" goto act_preview
if "%c%"=="9" goto act_wrangler
if "%c%"=="10" goto act_strings
if "%c%"=="11" goto act_verify
if "%c%"=="12" goto act_cleanup
if "%c%"=="13" goto act_migrate
if "%c%"=="0" goto end
goto menu

:act_editor
echo 编辑模式请点顶栏铅笔; 每次保存前自动备份到 output\edit-backups\
echo 注意: 别和配图工具 ^(菜单 2^) 同时开, 两者都会写同一份数据
call :window "fadian-editor-18769" "法典编辑器.bat"
goto menu

:act_imgserver
call :window "fadian-imgserver-18767" "配图工具.bat"
goto menu

:act_convert
call :run "转换法典.bat"
goto menu

:act_publish_data
call :run "发布数据.bat"
goto menu

:act_publish
call :run "发布.bat"
goto menu

:act_rollback
call :run "回滚数据.bat"
goto menu

:act_buildlocal
call :run "打包本地版.bat"
goto menu

:act_preview
call :window "fadian-preview-8766" "启动预览.bat"
goto menu

:act_wrangler
call :window "fadian-wrangler-8788" "投稿本地测试.bat"
goto menu

:act_strings
call :window "fadian-strings-18768" "画师串编辑.bat"
goto menu

:act_verify
call :run "回归验证.bat"
goto menu

:act_cleanup
call :run "清理输出.bat"
goto menu

:act_migrate
call :run "互动数据库迁移.bat"
goto menu

REM 前台跑完再回菜单。被调用的 bat 自己会 chcp 65001, 回来必须切回 936,
REM 否则本文件的 GBK 中文菜单会变乱码。
:run
call "单项工具\%~1"
chcp 936 >nul
exit /b 0

REM 常驻服务丢到新窗口, 菜单不被占住; 新窗口有自己的代码页, 不影响这里。
:window
echo 已在新窗口启动: %~2
start "%~1" /D "%~dp0" cmd /c call "单项工具\%~2"
timeout /t 2 /nobreak >nul 2>nul
exit /b 0

:end
endlocal
exit /b 0

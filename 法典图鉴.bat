@echo off
REM Encoding: GBK/936 - do NOT re-save as UTF-8.
REM 只做菜单与分发；动作实现统一放在 单项工具\。
setlocal EnableExtensions
chcp 936 >nul
cd /d "%~dp0"
title 法典图鉴 - 总控台
set "more="

:menu
cls
echo ==================== 法典图鉴 ====================
echo.
if defined more goto more
echo   日常维护
echo      1. 法典编辑器        2. 配图工具
echo      3. 转换法典
echo.
echo   发布与回滚
echo      4. 发布数据          5. 发布程序
echo      6. 回滚数据
echo.
echo      7. 打包本地版        8. 只读预览
echo      M. 更多工具          0. 退出
goto input

:more
echo   更多工具
echo      9. 投稿本地测试     10. 画风串编辑
echo     11. 回归验证         17. 工程自检
echo.
echo   数据维护
echo     14. 生成中文对照     15. 补译中文对照 ^(付费^)
echo     16. 清理默认标签     12. 清理输出
echo     13. 互动数据库迁移 ^(生产 D1^)
echo.
echo      B. 返回首页          0. 退出

:input
echo --------------------------------------------------
set "c="
set /p "c=  输入编号或字母，回车执行: "
if /i "%c%"=="M" set "more=1"
if /i "%c%"=="B" set "more="
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
if "%c%"=="14" goto act_tagzh
if "%c%"=="15" goto act_tagzh_ai
if "%c%"=="16" goto act_default_tags
if "%c%"=="17" goto act_project_checks
if "%c%"=="0" goto end
goto menu

:act_editor
call :window "fadian-editor" "法典编辑器.bat"
goto menu

:act_imgserver
call :window "fadian-imgserver" "配图工具.bat"
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
call :window "fadian-preview" "启动预览.bat"
goto menu

:act_wrangler
call :window "fadian-wrangler" "投稿本地测试.bat"
goto menu

:act_strings
call :window "fadian-strings" "画师串编辑.bat"
goto menu

:act_verify
call :run "回归验证.bat"
goto menu

:act_cleanup
call :run "清理输出.bat"
goto menu

:act_tagzh
call :run "生成中文对照.bat"
goto menu

:act_tagzh_ai
call :run "补译中文对照.bat"
goto menu

:act_default_tags
call :run "清理默认标签.bat"
goto menu

:act_project_checks
call :run "工程自检.bat"
goto menu

:act_migrate
call :run "互动数据库迁移.bat"
goto menu

REM 前台动作结束后恢复 GBK，再回菜单。
:run
call "单项工具\%~1"
chcp 936 >nul
exit /b 0

REM 常驻服务在独立窗口运行。
:window
echo 已在新窗口启动: %~2
start "%~1" /D "%~dp0" cmd /c call "单项工具\%~2"
timeout /t 2 /nobreak >nul 2>nul
exit /b 0

:end
endlocal
exit /b 0

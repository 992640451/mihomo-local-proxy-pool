@echo off
setlocal DisableDelayedExpansion
chcp 65001 >nul
title Proxy Port Manager - Stop
echo 正在停止管理器... / Stopping the manager...
call "%~dp0bin\ppm.cmd" stop %*
set "PPM_RESULT=%ERRORLEVEL%"
echo.
if not "%PPM_RESULT%"=="0" goto failed
echo 管理器已停止或原本未运行。订阅、密码和端口配置均已保留。
echo The manager is stopped or was not running. Your data and settings are kept.
goto finish
:failed
echo 停止未完成，请保留上方错误信息，查看“开始使用.txt”的排查说明。
echo Stop failed. Keep the error above and read START_HERE.txt for troubleshooting.
:finish
echo.
echo 按任意键关闭此窗口... / Press any key to close this window...
pause >nul
exit /b %PPM_RESULT%

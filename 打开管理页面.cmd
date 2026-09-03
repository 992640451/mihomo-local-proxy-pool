@echo off
setlocal DisableDelayedExpansion
chcp 65001 >nul
title Proxy Port Manager - Open
call "%~dp0bin\ppm.cmd" open %*
set "PPM_RESULT=%ERRORLEVEL%"
echo.
if not "%PPM_RESULT%"=="0" goto failed
echo 如浏览器未打开，请手动访问上方管理地址。
echo If no browser opens, visit the management URL printed above.
goto finish
:failed
echo 页面未打开。若服务尚未启动，请先双击“启动管理器.cmd”。
echo Could not open the page. Start the manager first if it is not running.
:finish
echo.
echo 按任意键关闭此窗口... / Press any key to close this window...
pause >nul
exit /b %PPM_RESULT%

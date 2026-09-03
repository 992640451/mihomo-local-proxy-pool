@echo off
setlocal DisableDelayedExpansion
chcp 65001 >nul
title Proxy Port Manager - Start
echo 正在启动管理器，请稍候... / Starting the manager...
call "%~dp0bin\ppm.cmd" start --background %*
set "PPM_RESULT=%ERRORLEVEL%"
echo.
if not "%PPM_RESULT%"=="0" goto failed
echo 请先保存上方首次生成的账号和密码，再关闭此窗口。
echo Save the first-start credentials above before closing this window.
echo 服务在后台运行；关闭此窗口或浏览器不会停止代理。
echo The service keeps running after this window or the browser is closed.
echo 使用“停止管理器.cmd”退出服务。 / Use the Stop Manager launcher to stop it.
goto finish
:failed
echo 启动未完成，请保留上方错误信息，查看“开始使用.txt”的排查说明。
echo Start failed. Keep the error above and read START_HERE.txt for troubleshooting.
:finish
echo.
echo 按任意键关闭此窗口... / Press any key to close this window...
pause >nul
exit /b %PPM_RESULT%

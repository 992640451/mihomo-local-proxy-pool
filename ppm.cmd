@echo off
setlocal
set "PPM_ROOT=%~dp0"
set "PPM_PORTABLE=1"
set "PPM_NODE=%PPM_ROOT%runtime\node.exe"
set "PPM_ENTRY=%PPM_ROOT%app\scripts\launcher.mjs"
if not exist "%PPM_NODE%" set "PPM_NODE=node"
if not exist "%PPM_ENTRY%" set "PPM_ENTRY=%PPM_ROOT%scripts\launcher.mjs"
"%PPM_NODE%" "%PPM_ENTRY%" %*
exit /b %ERRORLEVEL%

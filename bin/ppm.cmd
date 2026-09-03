@echo off
setlocal DisableDelayedExpansion
for %%I in ("%~dp0..") do set "PPM_ROOT=%%~fI\"
set "PPM_PORTABLE=1"
set "PPM_NODE=%PPM_ROOT%runtime\node.exe"
set "PPM_ENTRY=%PPM_ROOT%app\scripts\launcher.mjs"
if not exist "%PPM_NODE%" set "PPM_NODE=node"
if not exist "%PPM_ENTRY%" set "PPM_ENTRY=%PPM_ROOT%scripts\launcher.mjs"
"%PPM_NODE%" "%PPM_ENTRY%" %*
exit /b %ERRORLEVEL%

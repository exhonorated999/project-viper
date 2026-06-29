@echo off
REM VIPER developer build launcher (npm start)
title VIPER Dev Build
cd /d "C:\Users\JUSTI\Workspace\VIPER"

REM Ensure uv is on PATH for any tooling that needs it
set "PATH=%PATH%;C:\Users\JUSTI\.local\bin"

echo Starting VIPER developer build...
echo Working dir: %CD%
echo.
call npm start

REM Keep the window open if npm start exits (so errors are visible)
echo.
echo VIPER dev build exited. Press any key to close this window.
pause >nul

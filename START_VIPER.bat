@echo off
title VIPER Network Intelligence
color 0B
cls
echo.
echo  ========================================
echo   VIPER - Network Intelligence Edition
echo  ========================================
echo.
echo  Starting local server and opening VIPER...
echo.

cd /d "%~dp0"

REM Start Python HTTP server in background
start /B python -m http.server 8000 >nul 2>&1

REM Wait for server to start
timeout /t 3 /nobreak >nul

REM Open browser
start "" "http://localhost:8000/case-detail-with-analytics.html"

echo  VIPER is running at: http://localhost:8000
echo.
echo  Close this window to stop the server
echo.
echo  ========================================
echo.

REM Keep window open and server running
pause

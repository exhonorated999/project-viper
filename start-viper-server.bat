@echo off
echo ========================================
echo  VIPER Local Development Server
echo ========================================
echo.
echo Starting local web server...
echo This avoids browser tracking prevention issues
echo.
echo Server will run on: http://localhost:8000
echo.
echo Press Ctrl+C to stop the server
echo.

cd /d "%~dp0"
python -m http.server 8000

pause

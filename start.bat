@echo off
echo Starting Project VIPER site on port 3000...
cd /d "%~dp0"
python -m http.server 3000

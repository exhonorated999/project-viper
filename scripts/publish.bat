@echo off
rem ===========================================================================
rem  Release V.I.P.E.R. (investigator edition) to GitHub Releases.
rem
rem  Usage (from anywhere):   scripts\publish.bat
rem
rem  Expected sequence before running this:
rem      npm version <x.y.z> --no-git-tag-version
rem      git commit -am "V.I.P.E.R. <x.y.z> - <summary>"
rem      git tag v<x.y.z>
rem      git push origin master
rem      git push origin v<x.y.z>      <-- the tag MUST be on the remote first
rem
rem  Builds nsis + portable + msi (per electron-builder.yml) and publishes all
rem  three plus latest.yml. verify-package.js then opens the built asar and
rem  confirms the app inside is intact before we call the release good.
rem
rem  The token is read from the OS keyring (service "workshop", key
rem  VIPER_GITHUB_TOKEN) into GH_TOKEN for the life of this script only. Echo
rem  stays off so it never reaches the console or a log.
rem ===========================================================================
setlocal
cd /d "%~dp0.."

for /f "delims=" %%i in ('uvx --quiet keyring get workshop VIPER_GITHUB_TOKEN 2^>nul') do set "GH_TOKEN=%%i"
if "%GH_TOKEN%"=="" (
  echo.
  echo   VIPER_GITHUB_TOKEN not found in the keyring.
  echo   Add it in Workshop ^(Secrets^) or run:  uvx keyring set workshop VIPER_GITHUB_TOKEN
  echo.
  exit /b 1
)

node scripts\release-guard.mjs
if errorlevel 1 exit /b 1

call npx electron-builder --win --publish always
if errorlevel 1 (
  echo.
  echo   BUILD/PUBLISH FAILED -- see the output above.
  exit /b 1
)

call node scripts\verify-package.js
if errorlevel 1 exit /b 1

node scripts\verify-release.mjs
if errorlevel 1 exit /b 1

endlocal

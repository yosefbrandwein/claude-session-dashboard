@echo off
setlocal enabledelayedexpansion
title Claude Session Dashboard - Device Setup
cd /d "%~dp0"

echo ===============================================
echo   Claude Session Dashboard - device setup
echo ===============================================
echo.

REM --- 1. Node.js present? -------------------------------------------------
where node >nul 2>&1
if errorlevel 1 (
  echo [ERROR] Node.js is not installed.
  echo Install it from https://nodejs.org ^(LTS, v18+^), then run this again.
  echo.
  pause
  exit /b 1
)
for /f "tokens=*" %%v in ('node -v') do echo Node %%v detected.
echo.

REM --- 2. install agent dependencies --------------------------------------
echo Installing agent dependencies (first run can take a minute)...
pushd "%~dp0..\packages\agent"
call npm install --no-fund --no-audit
if errorlevel 1 (
  echo [ERROR] npm install failed. Check your internet connection and retry.
  popd & pause & exit /b 1
)
popd
echo Dependencies installed.
echo.

REM --- 3. login config (~/.claude-dash/config.json) -----------------------
set "CFG=%USERPROFILE%\.claude-dash\config.json"
if exist "%CFG%" goto :haveconfig
echo Enter your dashboard account (same login on every device):
set /p "EMAIL=  Email: "
set /p "PASSWORD=  Password: "
if not exist "%USERPROFILE%\.claude-dash" mkdir "%USERPROFILE%\.claude-dash"
> "%CFG%" echo {"email":"!EMAIL!","password":"!PASSWORD!"}
echo Saved login to %CFG%
goto :startagent
:haveconfig
echo Found existing login config at %CFG%
:startagent
echo.

REM --- 4. start the agent -------------------------------------------------
echo This device will now appear at https://claude-session-dashboard.web.app
echo Keep this window open to stay live (or set up auto-start - see README).
echo Press Ctrl+C to stop.
echo.
cd /d "%~dp0..\packages\agent"
node "node_modules\tsx\dist\cli.mjs" src\index.ts

endlocal

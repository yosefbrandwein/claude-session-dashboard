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
REM Resolve tsx robustly: npm workspaces hoist it to the REPO-ROOT node_modules,
REM not packages\agent\node_modules — so use the .bin shim wherever it landed,
REM falling back to npx. A hardcoded path breaks on a fresh clone.
set "TSX="
if exist "node_modules\.bin\tsx.cmd" set "TSX=node_modules\.bin\tsx.cmd"
if not defined TSX if exist "..\..\node_modules\.bin\tsx.cmd" set "TSX=..\..\node_modules\.bin\tsx.cmd"
if defined TSX (
  call "%TSX%" src\index.ts
) else (
  call npx --yes tsx src\index.ts
)

echo.
echo ============================================================
echo  The agent has STOPPED. If there is an error above, copy it
echo  and send it over. (Normally this window stays running.)
echo ============================================================
pause

endlocal

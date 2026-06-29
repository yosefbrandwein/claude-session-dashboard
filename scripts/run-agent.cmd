@echo off
REM Launches the device agent against the CLOUD project (reads creds from
REM %USERPROFILE%\.claude-dash\config.json). Used by the "at logon" Scheduled
REM Task so this device stays live on the dashboard. No emulator env = cloud.
cd /d "%~dp0..\packages\agent"
REM tsx is hoisted to repo-root node_modules by npm workspaces; resolve it wherever it landed.
set "TSX="
if exist "node_modules\.bin\tsx.cmd" set "TSX=node_modules\.bin\tsx.cmd"
if not defined TSX if exist "..\..\node_modules\.bin\tsx.cmd" set "TSX=..\..\node_modules\.bin\tsx.cmd"
if defined TSX (
  call "%TSX%" src\index.ts
) else (
  call npx --yes tsx src\index.ts
)

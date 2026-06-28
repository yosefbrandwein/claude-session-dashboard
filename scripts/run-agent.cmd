@echo off
REM Launches the device agent against the CLOUD project (reads creds from
REM %USERPROFILE%\.claude-dash\config.json). Used by the "at logon" Scheduled
REM Task so this device stays live on the dashboard. No emulator env = cloud.
cd /d "%~dp0..\packages\agent"
node "node_modules\tsx\dist\cli.mjs" src\index.ts

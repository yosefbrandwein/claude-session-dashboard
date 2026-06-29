@echo off
REM One-click: register the device agent to auto-start (hidden) at logon on THIS
REM PC. No admin needed. Double-click this, or run it from a terminal.
REM To remove later: run  scripts\uninstall-startup.cmd
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install-startup.ps1"
echo.
pause

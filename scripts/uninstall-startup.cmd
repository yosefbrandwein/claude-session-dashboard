@echo off
REM Removes the agent's auto-start (Startup shortcut) from THIS PC.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install-startup.ps1" -Uninstall
echo.
pause

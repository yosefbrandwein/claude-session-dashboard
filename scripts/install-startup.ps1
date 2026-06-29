# Registers (or removes) the device agent as a per-user STARTUP app on THIS PC.
# No admin required — it drops a shortcut in your Startup folder that launches the
# agent hidden at every logon. Path-independent: it points at run-agent-hidden.vbs
# next to this script, so it works wherever you cloned the repo.
#
#   Install:   powershell -ExecutionPolicy Bypass -File install-startup.ps1
#   Uninstall: powershell -ExecutionPolicy Bypass -File install-startup.ps1 -Uninstall
param([switch]$Uninstall)

$ErrorActionPreference = 'Stop'
$vbs = Join-Path $PSScriptRoot 'run-agent-hidden.vbs'
$startup = [Environment]::GetFolderPath('Startup')
$lnkPath = Join-Path $startup 'Claude Dashboard Agent.lnk'

if ($Uninstall) {
  if (Test-Path $lnkPath) { Remove-Item $lnkPath -Force; Write-Host "Removed: $lnkPath" }
  else { Write-Host "Nothing to remove (no startup shortcut found)." }
  return
}

if (-not (Test-Path $vbs)) {
  Write-Error "Launcher not found: $vbs (run this from the repo's scripts\ folder)"
  return
}

$ws = New-Object -ComObject WScript.Shell
$lnk = $ws.CreateShortcut($lnkPath)
$lnk.TargetPath = 'wscript.exe'
$lnk.Arguments = '"' + $vbs + '"'
$lnk.WindowStyle = 7   # hidden / minimized
$lnk.Description = 'Claude Session Dashboard agent (auto-start at logon)'
$lnk.Save()

Write-Host "Installed startup shortcut:" -ForegroundColor Green
Write-Host "  $lnkPath"
Write-Host "  -> wscript.exe `"$vbs`""
Write-Host ""
Write-Host "The agent will now auto-start (hidden) at every logon on this PC."
Write-Host "To remove later: re-run this with  -Uninstall"

# Starts the Firebase Emulator Suite (Auth + Firestore + RTDB + UI) for local dev.
#
# WHY THIS SCRIPT EXISTS (machine-specific gotcha, verified 2026-06-26):
#   • firebase-tools v15 HARD-REQUIRES JDK >= 21.
#   • On this machine the only JDK >= 21 (Android openjdk 21) cannot Selector.open()
#     because its AF_UNIX loopback socket is blocked (endpoint-security / EDR), so the
#     Firestore + RTDB emulators crash on startup under v15.
#   • JDK 11 works fine (classic TCP selector) but v15 refuses it.
#   => Pin firebase-tools v13 (its Firestore emulator JAR runs on JDK 11) and force JDK 11.
#
# If you are on a normal machine with a working JDK 21+, you can instead just run:
#   firebase emulators:start
param(
  [string]$Only = "auth,firestore,database"
)
$ErrorActionPreference = "Stop"
$env:JAVA_HOME = "C:\Program Files\Microsoft\jdk-11.0.20.101-hotspot"
$env:PATH = "$env:JAVA_HOME\bin;$env:PATH"
Push-Location (Split-Path $PSScriptRoot -Parent)   # repo root (has firebase.json)
try {
  Write-Host "Starting emulators with firebase-tools@13 + JDK 11 ($Only)..." -ForegroundColor Cyan
  npx -y firebase-tools@13 emulators:start --only $Only
} finally {
  Pop-Location
}

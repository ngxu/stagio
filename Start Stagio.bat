@echo off
cd /d "%~dp0"
if not exist node_modules (
  echo Installing dependencies, first run only...
  call npm install --no-audit --no-fund
)
echo Starting Stagio. Close this window to stop it.
node server.js --open
pause

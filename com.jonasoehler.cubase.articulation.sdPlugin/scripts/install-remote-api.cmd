@echo off
setlocal
set SCRIPT_DIR=%~dp0
powershell -NoProfile -ExecutionPolicy Bypass -File "%SCRIPT_DIR%install-remote-api.ps1"
if errorlevel 1 (
  echo Install failed. See messages above.
  pause
) else (
  echo Done. Press any key to close...
  pause
)

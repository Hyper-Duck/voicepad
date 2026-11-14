@echo off
setlocal
cd /d "%~dp0"
where pythonw >nul 2>nul
if not errorlevel 1 (
  start "" pythonw "%~dp0server.py" --open
  exit /b 0
)
where python >nul 2>nul
if not errorlevel 1 (
  start "Voicepad" /min python "%~dp0server.py" --open
  exit /b 0
)
echo Python 3.10 or newer is required. No extra packages are needed.
pause

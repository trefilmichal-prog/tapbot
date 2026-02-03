@echo off
setlocal

set "REPO_DIR=%~dp0"
set "DATA_DIR=%REPO_DIR%data"
set "PID_FILE=%DATA_DIR%\bot.pid"

if not exist "%DATA_DIR%" mkdir "%DATA_DIR%"
if not exist "%DATA_DIR%" (
  echo [ERROR] Failed to create data directory: "%DATA_DIR%"
  exit /b 1
)

for /f "usebackq delims=" %%p in (`powershell -NoProfile -Command "(Start-Process -FilePath 'npm' -ArgumentList 'start' -WorkingDirectory \"%REPO_DIR%\" -PassThru).Id"`) do set "BOT_PID=%%p"

if "%BOT_PID%"=="" (
  echo [ERROR] Failed to start "npm start" or retrieve PID from Start-Process.
  exit /b 1
)

echo %BOT_PID%> "%PID_FILE%"
if not exist "%PID_FILE%" (
  echo [ERROR] Failed to write PID file: "%PID_FILE%"
  exit /b 1
)

endlocal

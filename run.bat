@echo off
setlocal

set "REPO_DIR=%~dp0"
set "DATA_DIR=%REPO_DIR%data"
set "PID_FILE=%DATA_DIR%\bot.pid"

if not exist "%DATA_DIR%" mkdir "%DATA_DIR%"

for /f "usebackq delims=" %%p in (`powershell -NoProfile -Command "(Start-Process -FilePath 'npm' -ArgumentList 'start' -PassThru).Id"`) do set "BOT_PID=%%p"

if not "%BOT_PID%"=="" (
  echo %BOT_PID%> "%PID_FILE%"
)

endlocal

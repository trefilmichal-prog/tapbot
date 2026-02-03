@echo off
setlocal

set "REPO_DIR=%~dp0"
set "TEMP_DIR=%TEMP%\tapbot-update"
set "ZIP_PATH=%TEMP_DIR%\tapbot-main.zip"
set "EXTRACT_DIR=%TEMP_DIR%\tapbot-main"
set "PID_FILE=%REPO_DIR%data\bot.pid"

if exist "%PID_FILE%" (
  for /f "usebackq delims=" %%p in ("%PID_FILE%") do set "BOT_PID=%%p"
  if not "%BOT_PID%"=="" (
    taskkill /PID %BOT_PID% /F >nul 2>&1
  )
  del "%PID_FILE%" >nul 2>&1
)

if exist "%TEMP_DIR%" rmdir /s /q "%TEMP_DIR%"
mkdir "%TEMP_DIR%"

powershell -NoProfile -Command "Invoke-WebRequest -Uri 'https://github.com/trefilmichal-prog/tapbot/archive/refs/heads/main.zip' -OutFile '%ZIP_PATH%'"
powershell -NoProfile -Command "Expand-Archive -Path '%ZIP_PATH%' -DestinationPath '%TEMP_DIR%' -Force"

robocopy "%EXTRACT_DIR%" "%REPO_DIR%" /E /XD node_modules data /XF config.json >nul

rmdir /s /q "%TEMP_DIR%"

call "%REPO_DIR%run.bat"

endlocal

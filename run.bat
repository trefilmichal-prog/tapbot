@echo off
setlocal
set "KEEP_OPEN=1"

set "LOG_DIR=%~dp0logs"
if not exist "%LOG_DIR%" (
  mkdir "%LOG_DIR%"
)
set "DEBUG_LOG=%LOG_DIR%\\debug.log"
echo Logs are saved to: "%LOG_DIR%"

if not exist config.json (
  echo Missing config.json file. Run:
  echo   npm run setup
  if "%KEEP_OPEN%"=="1" pause
  exit /b 1
)

node -e "import('./src/config.js').then(m=>m.loadConfig())"
if errorlevel 1 (
  echo Failed to load config.json. Fix the configuration and try again.
  if "%KEEP_OPEN%"=="1" pause
  exit /b 1
)

pm2 start src/bot.js --name tapbot --time --output "%LOG_DIR%\\pm2-out.log" --error "%LOG_DIR%\\pm2-error.log" 1>>"%DEBUG_LOG%" 2>>&1
if errorlevel 1 (
  echo Failed to start the bot using PM2.
  echo PM2 output and errors are in: "%DEBUG_LOG%"
  if "%KEEP_OPEN%"=="1" pause
  exit /b 1
)

pm2 logs tapbot --lines 200 --nostream > "%DEBUG_LOG%" 2>>&1

pm2 save
if errorlevel 1 (
  echo Failed to save the PM2 process list.
  echo PM2 output and errors are in: "%DEBUG_LOG%"
  if "%KEEP_OPEN%"=="1" pause
  exit /b 1
)

pm2 status

endlocal

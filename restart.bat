@echo off
setlocal
set "KEEP_OPEN=0"

set "LOG_DIR=%~dp0logs"
if not exist "%LOG_DIR%" (
  mkdir "%LOG_DIR%"
)
set "DEBUG_LOG=%LOG_DIR%\\restart-debug.log"
echo Restart log: "%DEBUG_LOG%"

set "PM2_NAME=tapbot"
set "PM2_SCRIPT=src/bot.js"
set "PM2_ARGS=--name %PM2_NAME% --time --output \"%LOG_DIR%\\pm2-out.log\" --error \"%LOG_DIR%\\pm2-error.log\""

pm2 describe %PM2_NAME% 1>>"%DEBUG_LOG%" 2>>&1
if errorlevel 1 (
  echo PM2 process %PM2_NAME% neni registrovan, spoustim novy. 1>>"%DEBUG_LOG%" 2>>&1
  pm2 start %PM2_SCRIPT% %PM2_ARGS% 1>>"%DEBUG_LOG%" 2>>&1
  if errorlevel 1 (
    echo Spusteni pm2 procesu selhalo. 1>>"%DEBUG_LOG%" 2>>&1
    if "%KEEP_OPEN%"=="1" pause
    exit /b 1
  )
  pm2 save 1>>"%DEBUG_LOG%" 2>>&1
  if errorlevel 1 (
    echo Ulozeni pm2 procesu selhalo. 1>>"%DEBUG_LOG%" 2>>&1
    if "%KEEP_OPEN%"=="1" pause
    exit /b 1
  )
  exit /b 0
)

pm2 stop %PM2_NAME% 1>>"%DEBUG_LOG%" 2>>&1
if errorlevel 1 (
  echo Zastaveni pm2 procesu selhalo. 1>>"%DEBUG_LOG%" 2>>&1
  if "%KEEP_OPEN%"=="1" pause
  exit /b 1
)

pm2 start %PM2_NAME% 1>>"%DEBUG_LOG%" 2>>&1
if errorlevel 1 (
  echo Start pm2 procesu selhal. 1>>"%DEBUG_LOG%" 2>>&1
  if "%KEEP_OPEN%"=="1" pause
  exit /b 1
)

pm2 save 1>>"%DEBUG_LOG%" 2>>&1
if errorlevel 1 (
  echo Ulozeni pm2 procesu selhalo. 1>>"%DEBUG_LOG%" 2>>&1
  if "%KEEP_OPEN%"=="1" pause
  exit /b 1
)

endlocal

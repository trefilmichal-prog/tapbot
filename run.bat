@echo off
setlocal
set "KEEP_OPEN=1"

set "LOG_DIR=%~dp0logs"
if not exist "%LOG_DIR%" (
  mkdir "%LOG_DIR%"
)
set "DEBUG_LOG=%LOG_DIR%\\debug.log"
echo Logy se ukladaji do: "%LOG_DIR%"

pm2 --version >nul 2>&1
if errorlevel 1 (
  echo pm2 nebyl nalezen. Nainstaluj ho prikazem:
  echo   npm install -g pm2
  echo Potom zkus script spustit znovu.
  if "%KEEP_OPEN%"=="1" timeout /t 10
  if "%KEEP_OPEN%"=="1" pause
  exit /b 1
)

if not exist config.json (
  echo Chybi soubor config.json. Spust:
  echo   npm run setup
  if "%KEEP_OPEN%"=="1" timeout /t 10
  if "%KEEP_OPEN%"=="1" pause
  exit /b 1
)

node -e "import('./src/config.js').then(m=>m.loadConfig())"
if errorlevel 1 (
  echo Nacteni config.json selhalo. Oprav konfiguraci a zkuste to znovu.
  if "%KEEP_OPEN%"=="1" timeout /t 10
  if "%KEEP_OPEN%"=="1" pause
  exit /b 1
)

pm2 start src/bot.js --name tapbot --time --output "%LOG_DIR%\\pm2-out.log" --error "%LOG_DIR%\\pm2-error.log" 1>>"%DEBUG_LOG%" 2>>&1
if errorlevel 1 (
  echo Spusteni bota pres pm2 selhalo.
  echo PM2 vystup a chyby jsou v: "%DEBUG_LOG%"
  if "%KEEP_OPEN%"=="1" timeout /t 10
  if "%KEEP_OPEN%"=="1" pause
  exit /b 1
)

pm2 logs tapbot --lines 200 > "%DEBUG_LOG%" 2>>&1

pm2 save
if errorlevel 1 (
  echo Ulozeni pm2 procesu selhalo.
  echo PM2 vystup a chyby jsou v: "%DEBUG_LOG%"
  if "%KEEP_OPEN%"=="1" timeout /t 10
  if "%KEEP_OPEN%"=="1" pause
  exit /b 1
)

pm2 status

endlocal

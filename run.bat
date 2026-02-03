@echo off
setlocal

pm2 --version >nul 2>&1
if errorlevel 1 (
  echo pm2 nebyl nalezen. Nainstaluj ho prikazem:
  echo   npm install -g pm2
  echo Potom zkus script spustit znovu.
  exit /b 1
)

if not exist config.json (
  echo Chybi soubor config.json. Spust:
  echo   npm run setup
  exit /b 1
)

node -e "import('./src/config.js').then(m=>m.loadConfig())"
if errorlevel 1 (
  echo Nacteni config.json selhalo. Oprav konfiguraci a zkuste to znovu.
  exit /b 1
)

pm2 start src/bot.js --name tapbot --time
if errorlevel 1 (
  echo Spusteni bota pres pm2 selhalo.
  exit /b 1
)

pm2 save
if errorlevel 1 (
  echo Ulozeni pm2 procesu selhalo.
  exit /b 1
)

pm2 status

endlocal

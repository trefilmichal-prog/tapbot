@echo off
setlocal
set "KEEP_OPEN=1"

set "LOG_DIR=%~dp0logs"
if not exist "%LOG_DIR%" (
  mkdir "%LOG_DIR%"
)
set "DEBUG_LOG=%LOG_DIR%\\debug.log"
set "DAEMON_CHECK_LOG=%LOG_DIR%\\winrt-daemon-check.log"
echo Logs are saved to: "%LOG_DIR%"

set "BOT_PM2_NAME=tapbot"
set "BOT_PM2_SCRIPT=src/bot.js"

set "DAEMON_PM2_NAME=tapbot-winrt-daemon"
set "DAEMON_SCRIPT=bridge/windows_notifications_daemon.py"
set "DAEMON_HOST=127.0.0.1"
set "DAEMON_PORT=8765"
set "DAEMON_OUT_LOG=%LOG_DIR%\\pm2-winrt-daemon-out.log"
set "DAEMON_ERR_LOG=%LOG_DIR%\\pm2-winrt-daemon-error.log"
set "DAEMON_PYTHON_EXE="
set "DAEMON_PYTHON_ARGS="

if exist "%DAEMON_CHECK_LOG%" del /q "%DAEMON_CHECK_LOG%" >nul 2>&1

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

pm2 start %BOT_PM2_SCRIPT% --name %BOT_PM2_NAME% --time --output "%LOG_DIR%\\pm2-out.log" --error "%LOG_DIR%\\pm2-error.log" 1>>"%DEBUG_LOG%" 2>>&1
if errorlevel 1 (
  echo Failed to start the bot using PM2.
  echo PM2 output and errors are in: "%DEBUG_LOG%"
  if "%KEEP_OPEN%"=="1" pause
  exit /b 1
)

where py >nul 2>&1
if not errorlevel 1 (
  set "DAEMON_PYTHON_EXE=py"
  set "DAEMON_PYTHON_ARGS=-3"
) else (
  where python >nul 2>&1
  if not errorlevel 1 (
    set "DAEMON_PYTHON_EXE=python"
  )
)

if defined DAEMON_PYTHON_EXE (
  %DAEMON_PYTHON_EXE% %DAEMON_PYTHON_ARGS% -c "import winrt" 1>>"%DAEMON_CHECK_LOG%" 2>>&1
  if errorlevel 1 (
    echo [WARN] WINRT daemon preflight failed (missing winrt module).>>"%DAEMON_CHECK_LOG%"
    echo [WARN] Skipping %DAEMON_PM2_NAME% start. Bot %BOT_PM2_NAME% continues without Windows notifications daemon.
  ) else (
    pm2 describe %DAEMON_PM2_NAME% 1>>"%DEBUG_LOG%" 2>>&1
    if errorlevel 1 (
      pm2 start %DAEMON_PYTHON_EXE% --name %DAEMON_PM2_NAME% --interpreter none --time --output "%DAEMON_OUT_LOG%" --error "%DAEMON_ERR_LOG%" -- %DAEMON_PYTHON_ARGS% "%DAEMON_SCRIPT%" --host %DAEMON_HOST% --port %DAEMON_PORT% 1>>"%DEBUG_LOG%" 2>>&1
    ) else (
      pm2 restart %DAEMON_PM2_NAME% 1>>"%DEBUG_LOG%" 2>>&1
    )

    if errorlevel 1 (
      echo [WARN] Failed to start/restart PM2 daemon process %DAEMON_PM2_NAME%.>>"%DAEMON_CHECK_LOG%"
      echo [WARN] Bot %BOT_PM2_NAME% is running. Check daemon logs in "%DAEMON_ERR_LOG%".
    )
  )
) else (
  echo [WARN] Python launcher not found (tried py and python).>>"%DAEMON_CHECK_LOG%"
  echo [WARN] Skipping %DAEMON_PM2_NAME% start. Bot %BOT_PM2_NAME% continues without Windows notifications daemon.
)

pm2 logs %BOT_PM2_NAME% --lines 200 --nostream > "%DEBUG_LOG%" 2>>&1

pm2 save
if errorlevel 1 (
  echo Failed to save the PM2 process list.
  echo PM2 output and errors are in: "%DEBUG_LOG%"
  if "%KEEP_OPEN%"=="1" pause
  exit /b 1
)

pm2 status

endlocal

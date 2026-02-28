@echo off
setlocal
set "KEEP_OPEN=0"

set "LOG_DIR=%~dp0logs"
if not exist "%LOG_DIR%" (
  mkdir "%LOG_DIR%"
)
set "DEBUG_LOG=%LOG_DIR%\\restart-debug.log"
set "DAEMON_CHECK_LOG=%LOG_DIR%\\winrt-daemon-check.log"
echo Restart log: "%DEBUG_LOG%"

set "PM2_NAME=tapbot"
set "PM2_SCRIPT=src/bot.js"
set "PM2_ARGS=--name %PM2_NAME% --time --output \"%LOG_DIR%\\pm2-out.log\" --error \"%LOG_DIR%\\pm2-error.log\""

set "DAEMON_PM2_NAME=tapbot-winrt-daemon"
set "DAEMON_SCRIPT=bridge/windows_notifications_daemon.py"
set "DAEMON_HOST=127.0.0.1"
set "DAEMON_PORT=8765"
set "DAEMON_OUT_LOG=%LOG_DIR%\\pm2-winrt-daemon-out.log"
set "DAEMON_ERR_LOG=%LOG_DIR%\\pm2-winrt-daemon-error.log"
set "DAEMON_PYTHON_EXE="
set "DAEMON_PYTHON_ARGS="

pm2 describe %PM2_NAME% 1>>"%DEBUG_LOG%" 2>>&1
if errorlevel 1 (
  echo PM2 process %PM2_NAME% is not registered. Starting a new one. 1>>"%DEBUG_LOG%" 2>>&1
  pm2 start %PM2_SCRIPT% %PM2_ARGS% 1>>"%DEBUG_LOG%" 2>>&1
  if errorlevel 1 (
    echo Failed to start the PM2 process. 1>>"%DEBUG_LOG%" 2>>&1
    if "%KEEP_OPEN%"=="1" pause
    exit /b 1
  )
) else (
  pm2 stop %PM2_NAME% 1>>"%DEBUG_LOG%" 2>>&1
  if errorlevel 1 (
    echo Failed to stop the PM2 process. 1>>"%DEBUG_LOG%" 2>>&1
    if "%KEEP_OPEN%"=="1" pause
    exit /b 1
  )

  pm2 start %PM2_NAME% 1>>"%DEBUG_LOG%" 2>>&1
  if errorlevel 1 (
    echo Failed to start the PM2 process. 1>>"%DEBUG_LOG%" 2>>&1
    if "%KEEP_OPEN%"=="1" pause
    exit /b 1
  )
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
    echo [WARN] Skipping %DAEMON_PM2_NAME% restart. Bot %PM2_NAME% continues without Windows notifications daemon. 1>>"%DEBUG_LOG%" 2>>&1
  ) else (
    pm2 describe %DAEMON_PM2_NAME% 1>>"%DEBUG_LOG%" 2>>&1
    if errorlevel 1 (
      pm2 start %DAEMON_PYTHON_EXE% --name %DAEMON_PM2_NAME% --interpreter none --time --output "%DAEMON_OUT_LOG%" --error "%DAEMON_ERR_LOG%" -- %DAEMON_PYTHON_ARGS% "%DAEMON_SCRIPT%" --host %DAEMON_HOST% --port %DAEMON_PORT% 1>>"%DEBUG_LOG%" 2>>&1
    ) else (
      pm2 stop %DAEMON_PM2_NAME% 1>>"%DEBUG_LOG%" 2>>&1
      pm2 start %DAEMON_PM2_NAME% 1>>"%DEBUG_LOG%" 2>>&1
    )

    if errorlevel 1 (
      echo [WARN] Failed to start/restart PM2 daemon process %DAEMON_PM2_NAME%.>>"%DAEMON_CHECK_LOG%"
      echo [WARN] Bot %PM2_NAME% is running. Check daemon logs in "%DAEMON_ERR_LOG%". 1>>"%DEBUG_LOG%" 2>>&1
    )
  )
) else (
  echo [WARN] Python launcher not found (tried py and python).>>"%DAEMON_CHECK_LOG%"
  echo [WARN] Skipping %DAEMON_PM2_NAME% restart. Bot %PM2_NAME% continues without Windows notifications daemon. 1>>"%DEBUG_LOG%" 2>>&1
)

pm2 save 1>>"%DEBUG_LOG%" 2>>&1
if errorlevel 1 (
  echo Failed to save the PM2 process list. 1>>"%DEBUG_LOG%" 2>>&1
  if "%KEEP_OPEN%"=="1" pause
  exit /b 1
)

endlocal

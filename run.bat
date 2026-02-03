@echo off
setlocal

set "REPO_DIR=%~dp0"
set "PROCESS_NAME=tapbot"

echo [INFO] Repo: "%REPO_DIR%"
echo [INFO] Config file: "%REPO_DIR%config.json" (created by "npm run setup")
echo [INFO] Optional data folder: "%REPO_DIR%data"

if not exist "%REPO_DIR%config.json" (
  echo [ERROR] Missing config.json. Run "npm run setup" first.
  exit /b 1
)

set "PM2_CMD="
if exist "%REPO_DIR%node_modules\.bin\pm2.cmd" (
  set "PM2_CMD=npx --no-install pm2"
) else (
  where pm2 >nul 2>&1
  if not errorlevel 1 (
    set "PM2_CMD=pm2"
  )
)

if "%PM2_CMD%"=="" (
  echo [ERROR] PM2 not found. Install with: npm install -g pm2 ^|^| npm install pm2
  exit /b 1
)

if /I "%~1"=="update" (
  echo [INFO] Running update command before starting PM2...
  call npm run deploy
  if errorlevel 1 (
    echo [ERROR] Update command failed.
    exit /b 1
  )
)

echo [INFO] Ensuring PM2 process "%PROCESS_NAME%" is running...
call %PM2_CMD% describe "%PROCESS_NAME%" >nul 2>&1
if not errorlevel 1 (
  call %PM2_CMD% restart "%PROCESS_NAME%"
  if errorlevel 1 (
    echo [ERROR] Failed to restart "%PROCESS_NAME%" via PM2.
    exit /b 1
  )
) else (
  call %PM2_CMD% start npm --name "%PROCESS_NAME%" -- start
  if errorlevel 1 (
    echo [ERROR] Failed to start "%PROCESS_NAME%" via PM2.
    exit /b 1
  )
)

echo [INFO] "%PROCESS_NAME%" is running under PM2.

endlocal

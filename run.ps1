$ErrorActionPreference = 'Stop'

$REPO_DIR = Split-Path -Parent $MyInvocation.MyCommand.Path
$DATA_DIR = Join-Path $REPO_DIR 'data'
$PID_FILE = Join-Path $DATA_DIR 'bot.pid'

if (-not (Test-Path -Path $DATA_DIR)) {
  New-Item -ItemType Directory -Path $DATA_DIR -Force | Out-Null
}

if (-not (Test-Path -Path $DATA_DIR)) {
  Write-Error "[ERROR] Failed to create data directory: '$DATA_DIR'"
  exit 1
}

try {
  $process = Start-Process -FilePath 'npm' -ArgumentList 'start' -WorkingDirectory $REPO_DIR -PassThru
} catch {
  Write-Error "[ERROR] Failed to start 'npm start'. $_"
  exit 1
}

if (-not $process -or -not $process.Id) {
  Write-Error "[ERROR] Failed to start 'npm start' or retrieve PID from Start-Process."
  exit 1
}

$process.Id | Set-Content -Path $PID_FILE

if (-not (Test-Path -Path $PID_FILE)) {
  Write-Error "[ERROR] Failed to write PID file: '$PID_FILE'"
  exit 1
}

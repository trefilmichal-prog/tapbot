import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const POWERSHELL_TIMEOUT_MS = 12000;

const READ_NOTIFICATIONS_SCRIPT = `
$ErrorActionPreference = 'Stop'

if (-not ([System.Management.Automation.PSTypeName]'Windows.UI.Notifications.Management.UserNotificationListener').Type) {
  Add-Type -AssemblyName System.Runtime.WindowsRuntime
  [Windows.UI.Notifications.Management.UserNotificationListener, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null
  [Windows.UI.Notifications.NotificationKinds, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null
  [Windows.UI.Notifications.UserNotificationChangedTriggerDetails, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null
}

if (-not ([System.Management.Automation.PSTypeName]'System.WindowsRuntimeSystemExtensions').Type) {
  Add-Type -AssemblyName System.Runtime.WindowsRuntime
}

$listener = [Windows.UI.Notifications.Management.UserNotificationListener]::Current
$accessTask = [System.WindowsRuntimeSystemExtensions]::AsTask[Windows.UI.Notifications.Management.UserNotificationListenerAccessStatus]($listener.RequestAccessAsync())
$access = $accessTask.GetAwaiter().GetResult()

if ($access -ne [Windows.UI.Notifications.Management.UserNotificationListenerAccessStatus]::Allowed) {
  throw "ACCESS_STATUS:$access"
}

$kinds = [Windows.UI.Notifications.NotificationKinds]::Toast
$notificationsTask = [System.WindowsRuntimeSystemExtensions]::AsTask[Windows.Foundation.Collections.IVectorView[Windows.UI.Notifications.UserNotification]]($listener.GetNotificationsAsync($kinds))
$notifications = $notificationsTask.GetAwaiter().GetResult()
$result = @()

foreach ($notification in $notifications) {
  $appName = $null
  try {
    $appName = $notification.AppInfo.DisplayInfo.DisplayName
  } catch {
    $appName = $notification.AppInfo.Id
  }

  $title = $null
  $body = $null

  try {
    $bindings = $notification.Notification.Visual.Bindings
    if ($bindings) {
      foreach ($binding in $bindings) {
        $textElements = $binding.GetTextElements()
        if ($textElements) {
          $nonEmptyTexts = @()
          foreach ($textElement in $textElements) {
            if ($textElement -and -not [string]::IsNullOrWhiteSpace($textElement.Text)) {
              $nonEmptyTexts += $textElement.Text
            }
          }

          if ($nonEmptyTexts.Count -ge 1) {
            if ([string]::IsNullOrWhiteSpace($title)) {
              $title = $nonEmptyTexts[0]
            }

            if ([string]::IsNullOrWhiteSpace($body)) {
              if ($nonEmptyTexts.Count -ge 2) {
                $body = ($nonEmptyTexts | Select-Object -Skip 1) -join [Environment]::NewLine
              } elseif ([string]::IsNullOrWhiteSpace($title)) {
                $body = $nonEmptyTexts[0]
              }
            }
          }
        }
      }
    }
  } catch {
    # Keep title/body as null when visual payload cannot be inspected.
  }

  $result += [PSCustomObject]@{
    title = $title
    body = $body
    app = $appName
    timestamp = $notification.CreationTime.UtcDateTime.ToString('o')
  }
}

$result | ConvertTo-Json -Depth 6 -Compress
`;

function normalizeText(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function mapNotification(rawItem) {
  if (!rawItem || typeof rawItem !== 'object') {
    return null;
  }

  const timestamp = typeof rawItem.timestamp === 'string' ? rawItem.timestamp : null;
  const rawBody = typeof rawItem.body === 'string' ? rawItem.body : null;
  return {
    title: normalizeText(rawItem.title),
    body: rawBody === null ? null : normalizeText(rawBody),
    app: normalizeText(rawItem.app) ?? 'Unknown app',
    timestamp
  };
}

function parseAccessStatus(stderr, stdout) {
  const combined = `${stderr ?? ''}\n${stdout ?? ''}`;
  const match = combined.match(/ACCESS_STATUS:([A-Za-z]+)/);
  return match ? match[1] : null;
}

export async function readWindowsToastNotifications() {
  if (process.platform !== 'win32') {
    return {
      ok: false,
      errorCode: 'UNSUPPORTED_PLATFORM',
      message: 'Windows notifications are only supported on Windows hosts.',
      notifications: []
    };
  }

  let stdout;
  let stderr;

  try {
    const result = await execFileAsync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', READ_NOTIFICATIONS_SCRIPT],
      { timeout: POWERSHELL_TIMEOUT_MS, maxBuffer: 1024 * 1024 * 2 }
    );
    stdout = result.stdout;
    stderr = result.stderr;
  } catch (error) {
    const errorStdout = typeof error?.stdout === 'string' ? error.stdout : '';
    const errorStderr = typeof error?.stderr === 'string' ? error.stderr : '';
    const accessStatus = parseAccessStatus(errorStderr, errorStdout);

    if (accessStatus && accessStatus !== 'Allowed') {
      return {
        ok: false,
        errorCode: 'ACCESS_DENIED',
        message: `Notification access is not granted (${accessStatus}). Enable notification access in Windows settings and retry.`,
        notifications: []
      };
    }

    const combined = `${errorStderr}\n${errorStdout}`.toLowerCase();
    if (combined.includes('usenotificationlistener') || combined.includes('windows.ui.notifications')) {
      return {
        ok: false,
        errorCode: 'API_UNAVAILABLE',
        message: 'Windows notification APIs are unavailable in this environment.',
        notifications: []
      };
    }

    return {
      ok: false,
      errorCode: 'READ_FAILED',
      message: `Failed to read Windows notifications: ${error?.message ?? 'Unknown error'}`,
      notifications: []
    };
  }

  const accessStatus = parseAccessStatus(stderr, stdout);
  if (accessStatus && accessStatus !== 'Allowed') {
    return {
      ok: false,
      errorCode: 'ACCESS_DENIED',
      message: `Notification access is not granted (${accessStatus}). Enable notification access in Windows settings and retry.`,
      notifications: []
    };
  }

  const trimmed = typeof stdout === 'string' ? stdout.trim() : '';
  if (!trimmed) {
    return {
      ok: true,
      errorCode: null,
      message: 'No notifications found.',
      notifications: []
    };
  }

  let parsed;
  try {
    parsed = JSON.parse(trimmed);
  } catch (error) {
    return {
      ok: false,
      errorCode: 'INVALID_RESPONSE',
      message: 'Windows notification API returned an unreadable response.',
      notifications: []
    };
  }

  const list = Array.isArray(parsed) ? parsed : [parsed];
  const notifications = list.map(mapNotification).filter(Boolean);

  return {
    ok: true,
    errorCode: null,
    message: notifications.length ? null : 'No notifications found.',
    notifications
  };
}

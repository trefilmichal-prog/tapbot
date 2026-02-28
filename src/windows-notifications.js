import { readWinRtNotificationsFromBridge } from './winrt-notifications-bridge.js';

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

export async function readWindowsToastNotifications() {
  if (process.platform !== 'win32') {
    return {
      ok: false,
      errorCode: 'UNSUPPORTED_PLATFORM',
      message: 'Windows notifications are only supported on Windows hosts.',
      notifications: []
    };
  }

  const result = await readWinRtNotificationsFromBridge();

  if (!result.ok) {
    if (result.errorCode === 'ACCESS_DENIED') {
      return {
        ok: false,
        errorCode: 'ACCESS_DENIED',
        message: result.message ?? 'Notification access is denied by the host OS.',
        notifications: []
      };
    }

    if (result.errorCode === 'API_UNAVAILABLE') {
      return {
        ok: false,
        errorCode: 'API_UNAVAILABLE',
        message: result.message ?? 'Windows notification APIs are unavailable in this environment.',
        notifications: []
      };
    }

    return {
      ok: false,
      errorCode: 'READ_FAILED',
      message: result.message ?? 'Failed to read Windows notifications.',
      notifications: []
    };
  }

  const notifications = (Array.isArray(result.notifications) ? result.notifications : [])
    .map(mapNotification)
    .filter(Boolean);

  return {
    ok: true,
    errorCode: null,
    message: notifications.length ? null : 'No notifications found.',
    notifications
  };
}

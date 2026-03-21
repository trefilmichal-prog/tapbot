export function formatNotificationTimestamp(isoTimestamp) {
  if (!isoTimestamp) return 'Unknown';
  const parsed = new Date(isoTimestamp);
  if (Number.isNaN(parsed.getTime())) return 'Unknown';
  return `<t:${Math.floor(parsed.getTime() / 1000)}:R>`;
}

export function buildForwardNotificationMessage({ notification, player }) {
  const mentionTargetId = player?.mentionTargetId ?? player?.applicantId ?? null;

  return [
    '📣 **Secret Hatcher**',
    '',
    mentionTargetId
      ? `**Player:** <@${mentionTargetId}> (${player.displayNickname})`
      : `**Player:** ${player?.displayNickname ?? 'Unknown player'}`,
    `**Title:** ${notification?.title ?? '(no title)'}`,
    `**Time:** ${formatNotificationTimestamp(notification?.timestamp)}`,
    '**Body:**',
    notification?.body ?? '*(empty)*'
  ].join('\n');
}

export function normalizeNotificationForForward(rawItem) {
  if (!rawItem || typeof rawItem !== 'object') {
    return null;
  }

  const title = typeof rawItem.title === 'string' && rawItem.title.trim() ? rawItem.title.trim() : null;
  const app = typeof rawItem.app === 'string' && rawItem.app.trim() ? rawItem.app.trim() : 'Unknown app';
  const timestamp = typeof rawItem.timestamp === 'string' ? rawItem.timestamp : null;
  const hasBody = typeof rawItem.body === 'string';
  const body = hasBody
    ? (rawItem.body.trim() ? rawItem.body.trim() : null)
    : null;

  return {
    title,
    app,
    timestamp,
    body
  };
}

export function extractNotificationsFromBridgeEvent(eventPayload) {
  if (!eventPayload || typeof eventPayload !== 'object') {
    return [];
  }

  const eventType = typeof eventPayload.type === 'string'
    ? eventPayload.type
    : (typeof eventPayload.event === 'string' ? eventPayload.event : '');

  if (eventType === 'notification' && eventPayload.notification && typeof eventPayload.notification === 'object') {
    return [eventPayload.notification];
  }

  if ((eventType === 'notifications' || eventType === 'notification_batch') && Array.isArray(eventPayload.notifications)) {
    return eventPayload.notifications;
  }

  if (Array.isArray(eventPayload.notifications)) {
    return eventPayload.notifications;
  }

  if (eventPayload.notification && typeof eventPayload.notification === 'object') {
    return [eventPayload.notification];
  }

  return [];
}

export function buildNotificationSignature(item) {
  return [
    item?.timestamp ?? '',
    item?.app ?? '',
    item?.title ?? '',
    item?.body ?? ''
  ].join('|');
}

export function buildSortedUniqueForwardNotifications(rawItems) {
  const uniqueBySignature = new Map();
  for (const rawItem of rawItems) {
    const normalizedItem = normalizeNotificationForForward(rawItem);
    if (!normalizedItem) {
      continue;
    }

    const signature = buildNotificationSignature(normalizedItem);
    uniqueBySignature.set(signature, normalizedItem);
  }

  return [...uniqueBySignature.values()]
    .sort((a, b) => (new Date(a.timestamp ?? 0).getTime() || 0) - (new Date(b.timestamp ?? 0).getTime() || 0));
}

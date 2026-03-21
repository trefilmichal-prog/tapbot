import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildForwardNotificationMessage,
  buildSortedUniqueForwardNotifications
} from '../src/notification-forwarding.js';

test('buildForwardNotificationMessage renders the full multi-line toast body for Discord Components V2 text output', () => {
  const message = buildForwardNotificationMessage({
    notification: {
      title: 'Secret Hatcher',
      timestamp: '2026-02-01T10:00:00.000Z',
      body: 'Egg: Royal Egg\nRarity: Huge\nSerial: #77\nStats: +99% luck'
    },
    player: {
      applicantId: '1234567890',
      displayNickname: 'senpaicat22'
    }
  });

  assert.match(message, /\*\*Body:\*\*/);
  assert.match(message, /Egg: Royal Egg/);
  assert.match(message, /Rarity: Huge/);
  assert.match(message, /Serial: #77/);
  assert.match(message, /Stats: \+99% luck/);
  assert.ok(
    message.includes('**Body:**\nEgg: Royal Egg\nRarity: Huge\nSerial: #77\nStats: +99% luck'),
    'body should stay multi-line instead of collapsing to a single sentence'
  );
});

test('buildSortedUniqueForwardNotifications keeps all toast lines in normalized notification bodies', () => {
  const notifications = buildSortedUniqueForwardNotifications([
    {
      title: 'Secret Hatcher',
      body: 'Egg: Ancient Egg\nRarity: Legendary\nSerial: #321\nStats: +12% speed',
      app: 'Pet Simulator',
      timestamp: '2026-02-01T10:00:00.000Z'
    }
  ]);

  assert.equal(notifications.length, 1);
  assert.match(notifications[0].body, /Egg: Ancient Egg/);
  assert.match(notifications[0].body, /Rarity: Legendary/);
  assert.match(notifications[0].body, /Serial: #321/);
  assert.match(notifications[0].body, /Stats: \+12% speed/);
});

import test from 'node:test';
import assert from 'node:assert/strict';

import { readWindowsToastNotifications } from '../src/windows-notifications.js';

test('readWindowsToastNotifications uses bridge result on non-win32 runtimes', async (t) => {
  if (process.platform === 'win32') {
    t.skip('non-win32 specific coverage');
    return;
  }

  const result = await readWindowsToastNotifications({
    readBridge: async () => ({
      ok: true,
      notifications: [
        {
          title: ' Forwarded title ',
          body: ' Egg: Ancient Egg\nRarity: Legendary\nSerial: #321\nStats: +12% speed ',
          app: ' Bridge app ',
          timestamp: '2026-01-01T00:00:00.000Z'
        }
      ]
    })
  });

  assert.equal(result.ok, true);
  assert.equal(result.errorCode, null);
  assert.equal(result.message, null);
  assert.deepEqual(result.notifications, [
    {
      title: 'Forwarded title',
      body: 'Egg: Ancient Egg\nRarity: Legendary\nSerial: #321\nStats: +12% speed',
      app: 'Bridge app',
      timestamp: '2026-01-01T00:00:00.000Z'
    }
  ]);
});


test('readWindowsToastNotifications preserves full multi-line toast body content', async () => {
  const result = await readWindowsToastNotifications({
    readBridge: async () => ({
      ok: true,
      notifications: [
        {
          title: 'Secret Hatcher',
          body: 'Egg: Royal Egg\nRarity: Huge\nSerial: #77\nStats: +99% luck',
          app: 'Pet Simulator',
          timestamp: '2026-02-01T10:00:00.000Z'
        }
      ]
    })
  });

  assert.equal(result.ok, true);
  assert.equal(result.notifications[0].title, 'Secret Hatcher');
  assert.match(result.notifications[0].body, /Egg: Royal Egg/);
  assert.match(result.notifications[0].body, /Rarity: Huge/);
  assert.match(result.notifications[0].body, /Serial: #77/);
  assert.match(result.notifications[0].body, /Stats: \+99% luck/);
});

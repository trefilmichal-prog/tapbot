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
          body: ' Forwarded body ',
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
      body: 'Forwarded body',
      app: 'Bridge app',
      timestamp: '2026-01-01T00:00:00.000Z'
    }
  ]);
});

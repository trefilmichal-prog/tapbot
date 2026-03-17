import test from 'node:test';
import assert from 'node:assert/strict';

import { WinRtDaemonClient } from '../src/winrt-notifications-bridge.js';

test('handleData parses chunked and mixed frames while preserving id routing and events', () => {
  const client = new WinRtDaemonClient();
  const resolved = [];
  const events = [];

  client.pendingRequests.set('req-1', {
    resolve: (payload) => resolved.push({ id: 'req-1', payload }),
    reject: () => assert.fail('req-1 should not reject')
  });
  client.pendingRequests.set('req-2', {
    resolve: (payload) => resolved.push({ id: 'req-2', payload }),
    reject: () => assert.fail('req-2 should not reject')
  });
  client.pendingRequests.set('req-3', {
    resolve: (payload) => resolved.push({ id: 'req-3', payload }),
    reject: () => assert.fail('req-3 should not reject')
  });

  client.onEvent((payload) => events.push(payload));

  client.handleData('{"id":"req-1","ok":true,"value":"first"}\n{"type":"notifications","notifications":[{"title":"n1"}]}\n');

  assert.deepEqual(
    resolved,
    [{ id: 'req-1', payload: { id: 'req-1', ok: true, value: 'first' } }],
    'one chunk with two valid lines should process both frames'
  );
  assert.deepEqual(events, [{ type: 'notifications', notifications: [{ title: 'n1' }] }]);

  client.handleData('{"id":"req-2","ok":true,"value":"second"}');

  assert.equal(resolved.length, 1, 'partial line should stay buffered until newline arrives');
  assert.equal(client.buffer, '{"id":"req-2","ok":true,"value":"second"}');

  client.handleData('\n{"id":"req-3","ok":true,"value":"third"}\nthis-is-not-json\n{"type":"notifications","notifications":[{"title":"n2"}]}\n');

  assert.deepEqual(
    resolved,
    [
      { id: 'req-1', payload: { id: 'req-1', ok: true, value: 'first' } },
      { id: 'req-2', payload: { id: 'req-2', ok: true, value: 'second' } },
      { id: 'req-3', payload: { id: 'req-3', ok: true, value: 'third' } }
    ],
    'responses must resolve by matching id even when mixed with other frames'
  );

  assert.deepEqual(
    events,
    [
      { type: 'notifications', notifications: [{ title: 'n1' }] },
      { type: 'notifications', notifications: [{ title: 'n2' }] }
    ],
    'event frames should still flow through emitEvent when mixed with responses'
  );

  assert.equal(client.buffer, '', 'buffer should preserve and consume only complete framed lines');
  assert.equal(client.pendingRequests.size, 0, 'all matched pending requests should be resolved');
});

test('ping helper keeps daemon request flow healthy even without notifications events', async () => {
  const client = new WinRtDaemonClient();
  let pingCount = 0;

  client.sendRequest = async (payload) => {
    assert.equal(payload?.type, 'ping');
    pingCount += 1;
    return { ok: true, type: 'pong' };
  };

  for (let i = 0; i < 6; i += 1) {
    const response = await client.ping();
    assert.equal(response.ok, true);
  }

  assert.equal(pingCount, 6, 'periodic ping/pong should stay successful over long idle periods');
  assert.equal(client.connected, false, 'test performs pure request-level ping checks without notification event dependency');
});


test('startNotificationPush exposes pushActive so caller can enable polling fallback when push is unavailable', async () => {
  const client = new WinRtDaemonClient();

  client.sendRequest = async (payload) => {
    assert.equal(payload?.type, 'subscribe_notifications');
    return {
      ok: true,
      pushActive: false,
      message: 'Subscribed in fallback mode without push updates; poll using read_notifications.'
    };
  };

  const result = await client.startNotificationPush();

  assert.equal(result.ok, true);
  assert.equal(result.pushActive, false);
  assert.match(result.message, /fallback mode/i);
  assert.equal(result.ok && result.pushActive !== true, true, 'fallback subscribe should allow caller to keep polling fallback active');
});

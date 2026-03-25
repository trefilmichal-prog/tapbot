import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';

import { defaultCommands } from '../src/deploy-commands.js';
import {
  getAcceptedTicketRobloxAccessError,
  resolveRobloxAlertOptInTarget
} from '../src/roblox-alert-target.js';
import {
  getClanState,
  getRobloxMonitorState,
  updateClanState,
  updateRobloxMonitorState
} from '../src/persistence.js';
import {
  buildRobloxMonitorStatsReportComponents,
  robloxMonitorInternals,
  startRobloxMonitorScheduler,
  stopRobloxMonitorScheduler
} from '../src/roblox-monitor.js';

async function waitForCondition(predicate, { timeoutMs = 2500, intervalMs = 25 } = {}) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }

  throw new Error('Timed out waiting for condition');
}

function findSubcommand(commandName, subcommandName, subcommandGroup = null) {
  const command = defaultCommands.find((entry) => entry.name === commandName);
  assert.ok(command, `Command ${commandName} should exist`);

  if (subcommandGroup) {
    const group = (command.options ?? []).find((entry) => entry.type === 2 && entry.name === subcommandGroup);
    assert.ok(group, `Subcommand group ${subcommandGroup} should exist on ${commandName}`);
    const subcommand = (group.options ?? []).find((entry) => entry.type === 1 && entry.name === subcommandName);
    assert.ok(subcommand, `Subcommand ${subcommandName} should exist in ${commandName}/${subcommandGroup}`);
    return subcommand;
  }

  const subcommand = (command.options ?? []).find((entry) => entry.type === 1 && entry.name === subcommandName);
  assert.ok(subcommand, `Subcommand ${subcommandName} should exist on ${commandName}`);
  return subcommand;
}

test('opt_in command payload exposes optional nick override for all relevant commands', () => {
  const targets = [
    findSubcommand('roblox_alerts', 'opt_in'),
    findSubcommand('roblox_monitor', 'opt_in'),
    findSubcommand('roblox_monitor', 'opt_in', 'alerts')
  ];

  for (const subcommand of targets) {
    const nickOption = (subcommand.options ?? []).find((entry) => entry.name === 'nick');
    assert.deepEqual(nickOption, {
      type: 3,
      name: 'nick',
      description: 'Optional Roblox nickname override',
      required: false
    });
  }
});

test('opt_in target resolution prioritizes explicit valid nick', () => {
  const resolution = resolveRobloxAlertOptInTarget({
    requestedNickRaw: '  Custom_123  ',
    acceptedTicketNickname: 'TicketNick',
    fallbackNickname: 'GuildNick'
  });

  assert.equal(resolution.resolvedRobloxUsername, 'Custom_123');
  assert.equal(resolution.source, 'manual_opt_in_nick');
  assert.equal(resolution.hasInvalidRequestedNick, false);
  assert.equal(
    getAcceptedTicketRobloxAccessError(
      { applicantId: '123456789012345678', robloxNickname: null },
      null,
      { subcommand: 'opt_in', hasValidRequestedNick: true }
    ),
    null
  );
});

test('opt_in target resolution uses fallback chain when nick is whitespace', () => {
  const whitespaceResolution = resolveRobloxAlertOptInTarget({
    requestedNickRaw: '    ',
    acceptedTicketNickname: 'TicketNick',
    fallbackNickname: 'GuildNick'
  });
  assert.equal(whitespaceResolution.resolvedRobloxUsername, 'TicketNick');
  assert.equal(whitespaceResolution.source, 'ticket_account');
  assert.equal(whitespaceResolution.hasInvalidRequestedNick, false);

  const fallbackResolution = resolveRobloxAlertOptInTarget({
    requestedNickRaw: '\n\t ',
    acceptedTicketNickname: null,
    fallbackNickname: 'GuildNick'
  });
  assert.equal(fallbackResolution.resolvedRobloxUsername, 'GuildNick');
  assert.equal(fallbackResolution.source, 'guild_nickname');
});

test('RobloxSessionClient request retries 429 responses and eventually succeeds', async () => {
  const originalFetch = global.fetch;
  const originalWarn = console.warn;
  const calls = [];
  const warnings = [];

  global.fetch = async (url) => {
    calls.push(String(url));
    if (calls.length < 3) {
      return new Response(JSON.stringify({ errors: [{ message: 'Rate limited' }] }), {
        status: 429,
        headers: {
          'content-type': 'application/json',
          'retry-after': '0'
        }
      });
    }
    return Response.json({ ok: true });
  };
  console.warn = (...args) => warnings.push(args);

  try {
    const client = new robloxMonitorInternals.RobloxSessionClient('cookie');
    const response = await client.request('https://users.roblox.com/v1/users/authenticated');
    assert.deepEqual(response, { ok: true });
    assert.equal(calls.length, 3);
    assert.equal(warnings.length, 2);
  } finally {
    global.fetch = originalFetch;
    console.warn = originalWarn;
  }
});

test('RobloxSessionClient request throws rate-limit exhaustion after max retries', async () => {
  const originalFetch = global.fetch;
  let fetchCalls = 0;

  global.fetch = async () => {
    fetchCalls += 1;
    return new Response(JSON.stringify({ errors: [{ message: 'Rate limited' }] }), {
      status: 429,
      headers: {
        'content-type': 'application/json',
        'retry-after': '0'
      }
    });
  };

  try {
    const client = new robloxMonitorInternals.RobloxSessionClient('cookie');
    await assert.rejects(
      client.request('https://users.roblox.com/v1/users/authenticated', { maxRetries: 2 }),
      (error) => {
        assert.match(String(error?.message), /rate-limit exhaustion/i);
        return true;
      }
    );
    assert.equal(fetchCalls, 3);
  } finally {
    global.fetch = originalFetch;
  }
});

test('subscriber roblox account source and target persist across module reload (restart simulation)', async () => {
  const guildId = `test-guild-${Date.now()}-${Math.floor(Math.random() * 100000)}`;
  const userId = '123456789012345678';
  const guildDir = path.join(process.cwd(), 'data', 'guilds', guildId);

  await updateRobloxMonitorState(guildId, (state) => {
    state.subscriberUserIds = [userId];
    state.subscriberRobloxAccounts = {
      [userId]: {
        robloxUsername: 'Custom_123',
        robloxUserId: 321,
        source: 'manual_opt_in_nick',
        optedInAt: '2026-03-24T00:00:00.000Z'
      }
    };
  });

  const stateBeforeReload = getRobloxMonitorState(guildId);
  assert.equal(stateBeforeReload.subscriberRobloxAccounts[userId].robloxUsername, 'Custom_123');
  assert.equal(stateBeforeReload.subscriberRobloxAccounts[userId].source, 'manual_opt_in_nick');

  const reloaded = await import(`../src/persistence.js?restart=${Date.now()}`);
  const stateAfterReload = reloaded.getRobloxMonitorState(guildId);
  assert.equal(stateAfterReload.subscriberRobloxAccounts[userId].robloxUsername, 'Custom_123');
  assert.equal(stateAfterReload.subscriberRobloxAccounts[userId].source, 'manual_opt_in_nick');

  await fs.rm(guildDir, { recursive: true, force: true });
});

test('clan monitor mode derives effective monitored users from accepted clan members without explicit opt-ins', async () => {
  const guildId = `test-guild-clan-mode-${Date.now()}-${Math.floor(Math.random() * 100000)}`;
  const guildDir = path.join(process.cwd(), 'data', 'guilds', guildId);
  const selectedClanName = 'Raiders';

  await updateRobloxMonitorState(guildId, (state) => {
    state.monitorSource = {
      ...state.monitorSource,
      clan_name: selectedClanName
    };
    state.subscriberUserIds = [];
  });

  await updateClanState(guildId, (state) => {
    state.clan_ticket_decisions = {
      acceptedInSelectedClanA: {
        status: 'accept',
        applicantId: '111111111111111111',
        clanName: selectedClanName,
        answers: { robloxNick: 'AlphaMember' }
      },
      acceptedInSelectedClanB: {
        status: 'accept',
        applicantId: '222222222222222222',
        clanName: selectedClanName,
        answers: { robloxNick: 'BravoMember' }
      },
      acceptedOtherClan: {
        status: 'accept',
        applicantId: '333333333333333333',
        clanName: 'OtherClan',
        answers: { robloxNick: 'OtherClanMember' }
      },
      rejectedInSelectedClan: {
        status: 'reject',
        applicantId: '444444444444444444',
        clanName: selectedClanName,
        answers: { robloxNick: 'RejectedMember' }
      }
    };
  });

  const expectedAcceptedSelectedClanIds = ['111111111111111111', '222222222222222222'];
  const clanState = getClanState(guildId);
  const derivedAcceptedSelectedClanIds = Object.values(clanState.clan_ticket_decisions)
    .filter((entry) => entry.status === 'accept' && entry.clanName === selectedClanName)
    .map((entry) => entry.applicantId)
    .sort();
  assert.deepEqual(derivedAcceptedSelectedClanIds, expectedAcceptedSelectedClanIds);

  const fakeClient = {
    guilds: {
      cache: new Map([[guildId, { id: guildId, name: 'Clan mode test guild' }]]),
      fetch: async () => null
    }
  };

  startRobloxMonitorScheduler(fakeClient, guildId);

  await waitForCondition(() => {
    const updatedState = getRobloxMonitorState(guildId);
    return JSON.stringify(updatedState.subscriberUserIds) === JSON.stringify(expectedAcceptedSelectedClanIds)
      && JSON.stringify(Object.keys(updatedState.subscriberFriendshipStatus).sort()) === JSON.stringify(expectedAcceptedSelectedClanIds)
      && JSON.stringify(Object.keys(updatedState.subscriberPresence).sort()) === JSON.stringify(expectedAcceptedSelectedClanIds);
  });

  const updatedState = getRobloxMonitorState(guildId);
  assert.deepEqual(updatedState.subscriberUserIds, expectedAcceptedSelectedClanIds);
  assert.deepEqual(Object.keys(updatedState.subscriberFriendshipStatus).sort(), expectedAcceptedSelectedClanIds);
  assert.deepEqual(Object.keys(updatedState.subscriberPresence).sort(), expectedAcceptedSelectedClanIds);

  stopRobloxMonitorScheduler(guildId);
  await fs.rm(guildDir, { recursive: true, force: true });
});

test('without monitorSource.clan_name the monitor keeps explicit opt-in subscriber IDs', async () => {
  const guildId = `test-guild-explicit-optin-${Date.now()}-${Math.floor(Math.random() * 100000)}`;
  const guildDir = path.join(process.cwd(), 'data', 'guilds', guildId);
  const explicitSubscriberIds = ['888888888888888888'];

  await updateRobloxMonitorState(guildId, (state) => {
    state.monitorSource = {
      ...state.monitorSource,
      clan_name: null
    };
    state.subscriberUserIds = [...explicitSubscriberIds];
  });

  await updateClanState(guildId, (state) => {
    state.clan_ticket_decisions = {
      acceptedWouldBeIgnoredInNonClanMode: {
        status: 'accept',
        applicantId: '999999999999999999',
        clanName: 'Raiders',
        answers: { robloxNick: 'IgnoredMember' }
      }
    };
  });

  const fakeClient = {
    guilds: {
      cache: new Map([[guildId, { id: guildId, name: 'Non clan mode test guild' }]]),
      fetch: async () => null
    }
  };

  startRobloxMonitorScheduler(fakeClient, guildId);

  await waitForCondition(() => {
    const updatedState = getRobloxMonitorState(guildId);
    return JSON.stringify(updatedState.subscriberUserIds) === JSON.stringify(explicitSubscriberIds);
  });

  const updatedState = getRobloxMonitorState(guildId);
  assert.deepEqual(updatedState.subscriberUserIds, explicitSubscriberIds);

  stopRobloxMonitorScheduler(guildId);
  await fs.rm(guildDir, { recursive: true, force: true });
});

test('clan auto subscriber without explicit opt-in does not receive DM fallback reminders', async () => {
  const guildId = `test-guild-clan-auto-no-dm-${Date.now()}-${Math.floor(Math.random() * 100000)}`;
  const guildDir = path.join(process.cwd(), 'data', 'guilds', guildId);
  const subscriberUserId = '777777777777777777';
  const selectedClanName = 'Raiders';
  const originalFetch = global.fetch;
  let dmFetchCount = 0;

  global.fetch = async (url, options = {}) => {
    const resolvedUrl = String(url);
    const method = (options?.method ?? 'GET').toUpperCase();

    if (resolvedUrl.includes('/v1/users/authenticated') && method === 'GET') {
      return Response.json({ id: 999, name: 'MonitorAccount' });
    }
    if (resolvedUrl.includes('/v1/usernames/users') && method === 'POST') {
      return Response.json({
        data: [
          {
            requestedUsername: 'AlphaMember',
            name: 'AlphaMember',
            displayName: 'Alpha Member',
            id: 123
          }
        ]
      });
    }
    if (resolvedUrl.includes('/v1/presence/users') && method === 'POST') {
      return Response.json({
        userPresences: [
          {
            userId: 123,
            userPresenceType: 1,
            rootPlaceId: 111,
            placeId: 111,
            lastLocation: 'Somewhere else'
          }
        ]
      });
    }
    if (resolvedUrl.includes('/v1/users/999/friends') && method === 'GET') {
      return Response.json({ data: [{ id: 123 }] });
    }
    if (resolvedUrl.includes('/v1/my/friends/requests') && method === 'GET') {
      return Response.json({ data: [], nextPageCursor: null });
    }

    throw new Error(`Unexpected fetch call in test: ${resolvedUrl}`);
  };

  try {
    await updateRobloxMonitorState(guildId, (state) => {
      state.monitoringSession = { sessionCookie: 'test-cookie' };
      state.monitorSource = {
        source_type: 'target_override',
        clan_name: selectedClanName,
        channel_id: null
      };
      state.subscriberUserIds = [];
      state.subscriberRobloxAccounts = {
        [subscriberUserId]: {
          robloxUsername: 'AlphaMember',
          robloxUserId: 123,
          source: 'clan_auto',
          optedInAt: '2026-03-24T00:00:00.000Z'
        }
      };
      state.subscriberOfflineReminderAt = {};
      state.subscriberPresence = {};
      state.subscriberFriendshipStatus = {};
      state.subscriberStats = {};
    });

    await updateClanState(guildId, (state) => {
      state.clan_ticket_decisions = {
        acceptedInSelectedClan: {
          status: 'accept',
          applicantId: subscriberUserId,
          clanName: selectedClanName,
          answers: { robloxNick: 'AlphaMember' }
        }
      };
    });

    const fakeGuild = {
      id: guildId,
      name: 'Clan auto DM gate test guild',
      channels: {
        cache: new Map(),
        fetch: async () => null
      },
      members: {
        fetch: async () => null
      }
    };
    const fakeClient = {
      guilds: {
        cache: new Map([[guildId, fakeGuild]]),
        fetch: async (requestedGuildId) => (requestedGuildId === guildId ? fakeGuild : null)
      },
      users: {
        fetch: async () => {
          dmFetchCount += 1;
          return {
            send: async () => {}
          };
        }
      }
    };

    startRobloxMonitorScheduler(fakeClient, guildId);

    await waitForCondition(() => {
      const state = getRobloxMonitorState(guildId);
      return typeof state?.subscriberOfflineReminderAt?.[subscriberUserId] === 'string';
    });

    assert.equal(dmFetchCount, 0);
  } finally {
    stopRobloxMonitorScheduler(guildId);
    global.fetch = originalFetch;
    await fs.rm(guildDir, { recursive: true, force: true });
  }
});

test('monitor tick fetches friends list once per tick even with multiple subscribers', async () => {
  const guildId = `test-guild-friends-cached-${Date.now()}-${Math.floor(Math.random() * 100000)}`;
  const guildDir = path.join(process.cwd(), 'data', 'guilds', guildId);
  const originalFetch = global.fetch;
  let friendsCalls = 0;

  global.fetch = async (url, options = {}) => {
    const resolvedUrl = String(url);
    const method = (options?.method ?? 'GET').toUpperCase();
    const parsedBody = typeof options?.body === 'string' ? JSON.parse(options.body) : null;

    if (resolvedUrl.includes('/v1/users/authenticated') && method === 'GET') {
      return Response.json({ id: 999, name: 'MonitorAccount' });
    }
    if (resolvedUrl.includes('/v1/my/friends/requests') && method === 'GET') {
      return Response.json({ data: [], nextPageCursor: null });
    }
    if (resolvedUrl.includes('/v1/users/999/friends') && method === 'GET') {
      friendsCalls += 1;
      return Response.json({
        data: [{ id: 123 }, { id: 456 }],
        nextPageCursor: null
      });
    }
    if (resolvedUrl.includes('/v1/usernames/users') && method === 'POST') {
      return Response.json({
        data: [
          {
            requestedUsername: 'AlphaMember',
            name: 'AlphaMember',
            displayName: 'Alpha Member',
            id: 123
          },
          {
            requestedUsername: 'BetaMember',
            name: 'BetaMember',
            displayName: 'Beta Member',
            id: 456
          }
        ]
      });
    }
    if (resolvedUrl.includes('/v1/presence/users') && method === 'POST') {
      const requestedId = Number(parsedBody?.userIds?.[0]);
      return Response.json({
        userPresences: [
          {
            userId: requestedId,
            userPresenceType: 2,
            rootPlaceId: 74260430392611,
            placeId: 74260430392611,
            lastLocation: 'In game'
          }
        ]
      });
    }

    throw new Error(`Unexpected fetch call in test: ${resolvedUrl}`);
  };

  try {
    await updateRobloxMonitorState(guildId, (state) => {
      state.monitoringSession = { sessionCookie: 'test-cookie' };
      state.monitorSource = { source_type: 'target_override' };
      state.subscriberUserIds = ['111111111111111111', '222222222222222222'];
      state.subscriberRobloxAccounts = {
        '111111111111111111': {
          robloxUsername: 'AlphaMember',
          robloxUserId: 123,
          source: 'opt_in',
          optedInAt: '2026-03-24T00:00:00.000Z'
        },
        '222222222222222222': {
          robloxUsername: 'BetaMember',
          robloxUserId: 456,
          source: 'opt_in',
          optedInAt: '2026-03-24T00:00:00.000Z'
        }
      };
      state.subscriberOfflineReminderAt = {};
      state.subscriberPresence = {};
      state.subscriberFriendshipStatus = {};
      state.subscriberStats = {};
    });

    const fakeGuild = {
      id: guildId,
      name: 'Friends cache guild',
      channels: {
        cache: new Map(),
        fetch: async () => null
      },
      members: {
        fetch: async () => null
      }
    };
    const fakeClient = {
      guilds: {
        cache: new Map([[guildId, fakeGuild]]),
        fetch: async (requestedGuildId) => (requestedGuildId === guildId ? fakeGuild : null)
      },
      users: {
        fetch: async () => ({
          send: async () => {}
        })
      }
    };

    startRobloxMonitorScheduler(fakeClient, guildId);

    await waitForCondition(() => {
      const state = getRobloxMonitorState(guildId);
      const firstChecked = typeof state?.subscriberFriendshipStatus?.['111111111111111111']?.lastCheckedAt === 'string';
      const secondChecked = typeof state?.subscriberFriendshipStatus?.['222222222222222222']?.lastCheckedAt === 'string';
      return firstChecked && secondChecked;
    });

    assert.equal(friendsCalls, 1);
  } finally {
    stopRobloxMonitorScheduler(guildId);
    global.fetch = originalFetch;
    await fs.rm(guildDir, { recursive: true, force: true });
  }
});

test('monitor username resolution cache avoids second usernames resolve call within TTL', async () => {
  const guildId = `test-guild-username-cache-${Date.now()}-${Math.floor(Math.random() * 100000)}`;
  const guildDir = path.join(process.cwd(), 'data', 'guilds', guildId);
  const subscriberUserId = '333333333333333333';
  const originalFetch = global.fetch;
  let usernamesResolveCalls = 0;

  global.fetch = async (url, options = {}) => {
    const resolvedUrl = String(url);
    const method = (options?.method ?? 'GET').toUpperCase();
    const parsedBody = typeof options?.body === 'string' ? JSON.parse(options.body) : null;

    if (resolvedUrl.includes('/v1/users/authenticated') && method === 'GET') {
      return Response.json({ id: 999, name: 'MonitorAccount' });
    }
    if (resolvedUrl.includes('/v1/my/friends/requests') && method === 'GET') {
      return Response.json({ data: [], nextPageCursor: null });
    }
    if (resolvedUrl.includes('/v1/users/999/friends') && method === 'GET') {
      return Response.json({ data: [{ id: 123 }], nextPageCursor: null });
    }
    if (resolvedUrl.includes('/v1/usernames/users') && method === 'POST') {
      usernamesResolveCalls += 1;
      return Response.json({
        data: [
          {
            requestedUsername: 'AlphaMember',
            name: 'AlphaMember',
            displayName: 'Alpha Member',
            id: 123
          }
        ]
      });
    }
    if (resolvedUrl.includes('/v1/presence/users') && method === 'POST') {
      return Response.json({
        userPresences: [
          {
            userId: Number(parsedBody?.userIds?.[0]),
            userPresenceType: 2,
            rootPlaceId: 74260430392611,
            placeId: 74260430392611,
            lastLocation: 'In game'
          }
        ]
      });
    }

    throw new Error(`Unexpected fetch call in test: ${resolvedUrl}`);
  };

  try {
    await updateRobloxMonitorState(guildId, (state) => {
      state.monitoringSession = { sessionCookie: 'test-cookie' };
      state.monitorSource = { source_type: 'target_override' };
      state.subscriberUserIds = [subscriberUserId];
      state.subscriberRobloxAccounts = {
        [subscriberUserId]: {
          robloxUsername: 'AlphaMember',
          robloxUserId: null,
          source: 'opt_in',
          optedInAt: '2026-03-24T00:00:00.000Z'
        }
      };
      state.usernameResolutionCache = {};
      state.subscriberOfflineReminderAt = {};
      state.subscriberPresence = {};
      state.subscriberFriendshipStatus = {};
      state.subscriberStats = {};
    });

    const fakeGuild = {
      id: guildId,
      name: 'Username resolution cache guild',
      channels: {
        cache: new Map(),
        fetch: async () => null
      },
      members: {
        fetch: async () => null
      }
    };
    const fakeClient = {
      guilds: {
        cache: new Map([[guildId, fakeGuild]]),
        fetch: async (requestedGuildId) => (requestedGuildId === guildId ? fakeGuild : null)
      },
      users: {
        fetch: async () => ({ send: async () => {} })
      }
    };

    await robloxMonitorInternals.runRobloxMonitorTick(fakeClient, guildId);
    await robloxMonitorInternals.runRobloxMonitorTick(fakeClient, guildId);

    assert.equal(usernamesResolveCalls, 1);
  } finally {
    global.fetch = originalFetch;
    await fs.rm(guildDir, { recursive: true, force: true });
  }
});

test('clan monitor removes subscriber record when ticket nickname can no longer be resolved on Roblox', async () => {
  const guildId = `test-guild-clan-prune-missing-nickname-${Date.now()}-${Math.floor(Math.random() * 100000)}`;
  const guildDir = path.join(process.cwd(), 'data', 'guilds', guildId);
  const subscriberUserId = '444444444444444444';
  const selectedClanName = 'Raiders';
  const originalFetch = global.fetch;

  global.fetch = async (url, options = {}) => {
    const resolvedUrl = String(url);
    const method = (options?.method ?? 'GET').toUpperCase();

    if (resolvedUrl.includes('/v1/users/authenticated') && method === 'GET') {
      return Response.json({ id: 999, name: 'MonitorAccount' });
    }
    if (resolvedUrl.includes('/v1/my/friends/requests') && method === 'GET') {
      return Response.json({ data: [], nextPageCursor: null });
    }
    if (resolvedUrl.includes('/v1/users/999/friends') && method === 'GET') {
      return Response.json({ data: [], nextPageCursor: null });
    }
    if (resolvedUrl.includes('/v1/usernames/users') && method === 'POST') {
      return Response.json({
        data: []
      });
    }

    throw new Error(`Unexpected fetch call in test: ${resolvedUrl}`);
  };

  try {
    await updateRobloxMonitorState(guildId, (state) => {
      state.monitoringSession = { sessionCookie: 'test-cookie' };
      state.monitorSource = {
        source_type: 'target_override',
        clan_name: selectedClanName,
        channel_id: null
      };
      state.subscriberUserIds = [];
      state.subscriberRobloxAccounts = {
        [subscriberUserId]: {
          robloxUsername: 'MissingOnRoblox',
          robloxUserId: null,
          source: 'clan_auto',
          optedInAt: '2026-03-24T00:00:00.000Z'
        }
      };
      state.subscriberOfflineReminderAt = {
        [subscriberUserId]: '2026-03-24T01:00:00.000Z'
      };
      state.subscriberPresence = {
        [subscriberUserId]: {
          checkedAt: '2026-03-24T02:00:00.000Z',
          isOnline: false,
          isInTargetGame: false
        }
      };
      state.subscriberFriendshipStatus = {
        [subscriberUserId]: {
          robloxUserId: null,
          isFriend: false,
          lastCheckedAt: '2026-03-24T02:00:00.000Z',
          lastAutoAcceptedAt: null,
          note: 'seed'
        }
      };
      state.subscriberStats = {
        [subscriberUserId]: {
          totalOnlineMinutes: 0,
          totalOfflineMinutes: 10,
          onlinePercentage: 0
        }
      };
      state.usernameResolutionCache = {};
    });

    await updateClanState(guildId, (state) => {
      state.clan_ticket_decisions = {
        missing: {
          applicantId: subscriberUserId,
          status: 'accept',
          clanName: selectedClanName,
          answers: { robloxNick: 'MissingOnRoblox' }
        }
      };
    });

    const fakeGuild = {
      id: guildId,
      name: 'Clan prune missing nickname guild',
      channels: {
        cache: new Map(),
        fetch: async () => null
      },
      members: {
        fetch: async () => null
      }
    };
    const fakeClient = {
      guilds: {
        cache: new Map([[guildId, fakeGuild]]),
        fetch: async (requestedGuildId) => (requestedGuildId === guildId ? fakeGuild : null)
      },
      users: {
        fetch: async () => ({ send: async () => {} })
      }
    };

    await robloxMonitorInternals.runRobloxMonitorTick(fakeClient, guildId);

    const stateAfterTick = getRobloxMonitorState(guildId);
    assert.equal(stateAfterTick.subscriberRobloxAccounts?.[subscriberUserId], undefined);
    assert.equal(stateAfterTick.subscriberPresence?.[subscriberUserId], undefined);
    assert.equal(stateAfterTick.subscriberFriendshipStatus?.[subscriberUserId], undefined);
    assert.equal(stateAfterTick.subscriberOfflineReminderAt?.[subscriberUserId], undefined);
    assert.equal(stateAfterTick.subscriberStats?.[subscriberUserId], undefined);
  } finally {
    global.fetch = originalFetch;
    await fs.rm(guildDir, { recursive: true, force: true });
  }
});

test('stats report renders subscribers sorted by online percentage desc with tie-breakers', () => {
  const state = {
    targetGame: { name: 'Raid Game' },
    subscriberRobloxAccounts: {
      userA: { robloxUsername: 'Zulu' },
      userB: { robloxUsername: 'Alpha' },
      userC: { robloxUsername: 'Charlie' }
    }
  };
  const subscriberUserIds = ['userA', 'userB', 'userC'];
  const subscriberStatsBySubscriber = {
    userA: { totalOnlineMinutes: 30, totalOfflineMinutes: 30, totalSampledMinutes: 60 }, // 50%
    userB: { totalOnlineMinutes: 50, totalOfflineMinutes: 50, totalSampledMinutes: 100 }, // 50%
    userC: { totalOnlineMinutes: 70, totalOfflineMinutes: 30, totalSampledMinutes: 100 } // 70%
  };

  const components = buildRobloxMonitorStatsReportComponents({
    guild: { id: 'guild-1', name: 'Guild One' },
    state,
    subscriberUserIds,
    subscriberStatsBySubscriber,
    subscriberFriendshipStatusBySubscriber: {},
    presenceBySubscriber: {},
    monitoringAccountLabel: 'MonitorAccount',
    requiredRootPlaceId: 123,
    checkedAt: '2026-03-25T00:00:00.000Z'
  });

  const reportText = components[0].components[2].content;
  const charlieIndex = reportText.indexOf('• Charlie');
  const alphaIndex = reportText.indexOf('• Alpha');
  const zuluIndex = reportText.indexOf('• Zulu');

  assert.ok(charlieIndex >= 0, 'Charlie line should be present');
  assert.ok(alphaIndex >= 0, 'Alpha line should be present');
  assert.ok(zuluIndex >= 0, 'Zulu line should be present');
  assert.ok(charlieIndex < alphaIndex, 'Higher online percentage should render first');
  assert.ok(alphaIndex < zuluIndex, 'Tie should use total online minutes desc');
});

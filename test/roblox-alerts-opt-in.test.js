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

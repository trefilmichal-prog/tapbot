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
  getRobloxMonitorState,
  updateRobloxMonitorState
} from '../src/persistence.js';

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

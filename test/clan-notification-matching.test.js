import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildNotificationFilterRosterEntries,
  collectAcceptedClanPlayersFromState,
  collectAcceptedClanPlayersWithRobloxAliasesFromState,
  collectAcceptedTicketRobloxIdentitiesFromState,
  extractNicknameBeforeHatched,
  filterNotificationsByClanNicknames,
  getAcceptedTicketRobloxIdentityFromState,
  hasAcceptedTicketAccessFromState
} from '../src/clan-notification-matching.js';

test('extractNicknameBeforeHatched parses tolerated hatched formats', () => {
  assert.equal(
    extractNicknameBeforeHatched('🔥 Congrats! :flag_cz: senpaicat22 hatched a Huge Dog'),
    'senpaicat22'
  );
  assert.equal(
    extractNicknameBeforeHatched('🇨🇿 senpaicat22 hatched a Huge Dog'),
    'senpaicat22'
  );
  assert.equal(
    extractNicknameBeforeHatched('senpaicat22 hatched a Huge Dog'),
    'senpaicat22'
  );
  assert.equal(
    extractNicknameBeforeHatched('senpaicat22 found a Huge Dog'),
    null
  );
});

test('extractNicknameBeforeHatched normalizes edge separators around nickname', () => {
  assert.equal(
    extractNicknameBeforeHatched('senpaicat22, hatched a Huge Dog'),
    'senpaicat22'
  );
  assert.equal(
    extractNicknameBeforeHatched('senpaicat22 🔥 hatched a Huge Dog'),
    'senpaicat22'
  );
  assert.equal(
    extractNicknameBeforeHatched('🔥 Congrats! senpaicat22!!! hatched a Huge Dog'),
    'senpaicat22'
  );
});

test('filterNotificationsByClanNicknames matches accepted clan player for hatched notification variants', () => {
  const acceptedClanPlayers = collectAcceptedClanPlayersFromState({
    clan_ticket_decisions: {
      acceptedTicket: {
        status: 'accept',
        applicantId: '123456789012345678',
        answers: {
          robloxNick: 'SenpaiCat22'
        }
      },
      rejectedTicket: {
        status: 'reject',
        applicantId: '999999999999999999',
        answers: {
          robloxNick: 'OtherPlayer'
        }
      }
    }
  });

  const notifications = [
    {
      title: 'Secret Hatcher',
      body: '🔥 Congrats! :flag_cz: senpaicat22 hatched a Huge Dog'
    },
    {
      title: 'Secret Hatcher',
      body: 'No hatch text here'
    }
  ];

  const filteredNotifications = filterNotificationsByClanNicknames(
    notifications,
    acceptedClanPlayers
  );

  assert.equal(filteredNotifications.length, 1);
  assert.equal(filteredNotifications[0].matchedNickname, 'senpaicat22');
  assert.deepEqual(filteredNotifications[0].player, {
    displayNickname: 'SenpaiCat22',
    applicantId: '123456789012345678'
  });
  assert.equal(filteredNotifications[0].notification.body, notifications[0].body);
});

test('filterNotificationsByClanNicknames matches when hatched text is only in title and body has stats', () => {
  const acceptedClanPlayers = new Map([
    ['senpaicat22', { displayNickname: 'SenpaiCat22', applicantId: '123456789012345678' }]
  ]);

  const notifications = [
    {
      title: '🔥 Congrats! :flag_cz: senpaicat22 hatched a Huge Dog',
      body: 'Coins: +120\nPower: +340\nRank up ready!'
    }
  ];

  const filteredNotifications = filterNotificationsByClanNicknames(
    notifications,
    acceptedClanPlayers
  );

  assert.equal(filteredNotifications.length, 1);
  assert.equal(filteredNotifications[0].matchedNickname, 'senpaicat22');
  assert.deepEqual(filteredNotifications[0].player, {
    displayNickname: 'SenpaiCat22',
    applicantId: '123456789012345678'
  });
});

test('filterNotificationsByClanNicknames matches using title and multiline body payload combination', () => {
  const acceptedClanPlayers = new Map([
    ['senpaicat22', { displayNickname: 'SenpaiCat22', applicantId: '123456789012345678' }]
  ]);

  const notifications = [
    {
      title: '🔥 Congrats!',
      body: ':flag_cz:\nsenpaicat22\nhatched a Huge Dog\nwith bonus roll'
    }
  ];

  const filteredNotifications = filterNotificationsByClanNicknames(
    notifications,
    acceptedClanPlayers
  );

  assert.equal(filteredNotifications.length, 1);
  assert.equal(filteredNotifications[0].matchedNickname, 'senpaicat22');
  assert.deepEqual(filteredNotifications[0].player, {
    displayNickname: 'SenpaiCat22',
    applicantId: '123456789012345678'
  });
});

test('filterNotificationsByClanNicknames keeps body-only matching behavior (regression)', () => {
  const acceptedClanPlayers = new Map([
    ['senpaicat22', { displayNickname: 'SenpaiCat22', applicantId: '123456789012345678' }]
  ]);

  const notifications = [
    {
      title: 'Secret Hatcher',
      body: '🇨🇿 senpaicat22 hatched a Huge Dog'
    }
  ];

  const filteredNotifications = filterNotificationsByClanNicknames(
    notifications,
    acceptedClanPlayers
  );

  assert.equal(filteredNotifications.length, 1);
  assert.equal(filteredNotifications[0].matchedNickname, 'senpaicat22');
});

test('accepted ticket identity lookup reuses accepted ticket state and prefers stored Roblox nicknames', () => {
  const state = {
    clan_ticket_decisions: {
      acceptedWithoutNick: {
        status: 'accept',
        applicantId: '123456789012345678',
        answers: {
          robloxNick: '   '
        }
      },
      acceptedWithNick: {
        status: 'accept',
        applicantId: '123456789012345678',
        answers: {
          robloxNick: 'SenpaiCat22'
        }
      },
      acceptedOtherMember: {
        status: 'accept',
        applicantId: '222222222222222222',
        answers: {
          robloxNick: 'OtherPlayer'
        }
      },
      rejectedWithNick: {
        status: 'reject',
        applicantId: '333333333333333333',
        answers: {
          robloxNick: 'RejectedPlayer'
        }
      }
    }
  };

  const identities = collectAcceptedTicketRobloxIdentitiesFromState(state);
  assert.equal(identities.length, 3);
  assert.deepEqual(
    getAcceptedTicketRobloxIdentityFromState(state, '123456789012345678'),
    identities[1]
  );
  assert.equal(
    getAcceptedTicketRobloxIdentityFromState(state, '123456789012345678')?.robloxNickname,
    'SenpaiCat22'
  );
  assert.equal(hasAcceptedTicketAccessFromState(state, '222222222222222222'), true);
  assert.equal(hasAcceptedTicketAccessFromState(state, '333333333333333333'), false);
});

test('accepted ticket identity lookup returns ticket without Roblox nickname when no account is attached yet', () => {
  const state = {
    clan_ticket_decisions: {
      acceptedWithoutNick: {
        status: 'accept',
        applicantId: '123456789012345678',
        answers: {
          robloxNick: '   '
        }
      }
    }
  };

  assert.deepEqual(
    getAcceptedTicketRobloxIdentityFromState(state, '123456789012345678'),
    {
      applicantId: '123456789012345678',
      robloxNickname: null,
      normalizedRobloxNickname: null,
      entry: state.clan_ticket_decisions.acceptedWithoutNick
    }
  );
});

test('accepted ticket stored as username matches notification displayName via cache alias', () => {
  const state = {
    clan_ticket_decisions: {
      accepted: {
        status: 'accept',
        applicantId: '123456789012345678',
        answers: {
          robloxNick: 'CoolUser123'
        }
      }
    }
  };
  const cacheEntry = {
    username: 'CoolUser123',
    displayName: 'Cool Display'
  };
  const acceptedClanPlayers = collectAcceptedClanPlayersWithRobloxAliasesFromState(
    state,
    () => cacheEntry
  );

  const notifications = [
    {
      title: 'Secret Hatcher',
      body: '🔥 Congrats! Cool Display hatched a Huge Dog'
    }
  ];

  const filtered = filterNotificationsByClanNicknames(notifications, acceptedClanPlayers);
  assert.equal(filtered.length, 1);
  assert.equal(filtered[0].matchedNickname, 'cool display');
  assert.equal(filtered[0].player.displayNickname, 'CoolUser123');
  assert.equal(filtered[0].player.applicantId, '123456789012345678');
});

test('accepted ticket matches refreshed displayName cache alias after name change', () => {
  const state = {
    clan_ticket_decisions: {
      accepted: {
        status: 'accept',
        applicantId: '123456789012345678',
        answers: {
          robloxNick: 'CoolUser123'
        }
      }
    }
  };
  const acceptedClanPlayers = collectAcceptedClanPlayersWithRobloxAliasesFromState(
    state,
    () => ({
      username: 'CoolUser123',
      displayName: 'New Cool Display'
    })
  );

  const notifications = [
    {
      title: 'Secret Hatcher',
      body: '🔥 Congrats! New Cool Display hatched a Huge Dog'
    }
  ];

  const filtered = filterNotificationsByClanNicknames(notifications, acceptedClanPlayers);
  assert.equal(filtered.length, 1);
  assert.equal(filtered[0].matchedNickname, 'new cool display');
  assert.equal(filtered[0].player.displayNickname, 'CoolUser123');
});

test('manual collision still prefers manual_overrides_accepted rule', () => {
  const sharedAcceptedPlayer = {
    displayNickname: 'CoolUser123',
    applicantId: '123456789012345678',
    mentionTargetId: '123456789012345678',
    source: 'accepted'
  };
  const acceptedPlayers = new Map([
    ['cooluser123', sharedAcceptedPlayer],
    ['cool display', sharedAcceptedPlayer]
  ]);
  const manualPlayer = {
    displayNickname: 'Cool Display',
    applicantId: '222222222222222222',
    mentionTargetId: '222222222222222222',
    ownerUserId: '222222222222222222',
    source: 'manual'
  };
  const manualNicknames = new Map([
    ['cool display', manualPlayer]
  ]);

  const roster = buildNotificationFilterRosterEntries(acceptedPlayers, manualNicknames);
  assert.equal(roster.get('cool display')?.collisionRule, 'manual_overrides_accepted');
  assert.deepEqual(roster.get('cool display')?.effectivePlayer, manualPlayer);
  assert.deepEqual(roster.get('cool display')?.acceptedPlayer, sharedAcceptedPlayer);
});

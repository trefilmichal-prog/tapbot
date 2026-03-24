import test from 'node:test';
import assert from 'node:assert/strict';

import {
  collectAcceptedClanPlayersFromState,
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

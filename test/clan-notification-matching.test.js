import test from 'node:test';
import assert from 'node:assert/strict';

import {
  collectAcceptedClanPlayersFromState,
  extractNicknameBeforeHatched,
  filterNotificationsByClanNicknames
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

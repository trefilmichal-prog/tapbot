export function normalizeClanNicknameForMatch(value) {
  if (typeof value !== 'string') {
    return null;
  }

  const trimmed = value.trim().toLowerCase();
  return trimmed ? trimmed : null;
}

const HATCHED_NICKNAME_REGEXES = [
  /(?:^|\b)(?:(?:\p{Extended_Pictographic}|\p{Emoji_Presentation})\uFE0F?\s+)*(?:congrats!?\s+)(?:(?::flag_[a-z]{2}:|[\u{1F1E6}-\u{1F1FF}]{2})\s+)?([^\s].*?)\s+hatched\b/iu,
  /(?:^|\b)(?:(?::flag_[a-z]{2}:|[\u{1F1E6}-\u{1F1FF}]{2})\s+)([^\s].*?)\s+hatched\b/iu,
  /(?:^|\b)([^\s].*?)\s+hatched\b/iu
];

export function extractNicknameBeforeHatched(text) {
  if (typeof text !== 'string') {
    return null;
  }

  const flattened = text.replace(/\s+/g, ' ').trim();
  if (!flattened || !/\bhatched\b/i.test(flattened)) {
    return null;
  }

  const hatchedSegment = flattened.match(/(.+?\bhatched\b)/iu)?.[1] ?? flattened;

  for (const regex of HATCHED_NICKNAME_REGEXES) {
    const match = hatchedSegment.match(regex);
    const nickname = normalizeClanNicknameForMatch(match?.[1]);
    if (nickname) {
      return nickname;
    }
  }

  return null;
}

export function collectAcceptedClanPlayersFromState(state, acceptedStatus = 'accept') {
  const players = new Map();

  for (const entry of Object.values(state?.clan_ticket_decisions ?? {})) {
    if (!entry || entry.status !== acceptedStatus) {
      continue;
    }

    const normalizedNickname = normalizeClanNicknameForMatch(entry?.answers?.robloxNick);
    if (!normalizedNickname || players.has(normalizedNickname)) {
      continue;
    }

    const displayNickname = typeof entry?.answers?.robloxNick === 'string'
      ? entry.answers.robloxNick.trim()
      : '';
    if (!displayNickname) {
      continue;
    }

    players.set(normalizedNickname, {
      displayNickname,
      applicantId: entry.applicantId ?? null
    });
  }

  return players;
}

export function filterNotificationsByClanNicknames(notifications, acceptedClanPlayers) {
  if (!(acceptedClanPlayers instanceof Map) || !acceptedClanPlayers.size) {
    return [];
  }

  return notifications.flatMap((notification) => {
    const matchedNickname = extractNicknameBeforeHatched(notification?.body);
    if (!matchedNickname) {
      return [];
    }

    const player = acceptedClanPlayers.get(matchedNickname);
    if (!player) {
      return [];
    }

    return [{ notification, matchedNickname, player }];
  });
}

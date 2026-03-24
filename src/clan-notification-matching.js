export function normalizeClanNicknameForMatch(value) {
  if (typeof value !== 'string') {
    return null;
  }

  const trimmed = value.trim().toLowerCase();
  if (!trimmed) {
    return null;
  }

  const normalized = trimmed
    .replace(/^[^\p{L}\p{N}_]+/u, '')
    .replace(/[^\p{L}\p{N}_]+$/u, '')
    .trim();

  return normalized ? normalized : null;
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

function normalizeDiscordSnowflake(value) {
  if (typeof value !== 'string') {
    return null;
  }

  const trimmed = value.trim();
  return /^\d{17,20}$/.test(trimmed) ? trimmed : null;
}

function deriveAcceptedTicketApplicantId(entry) {
  if (!entry || typeof entry !== 'object') {
    return null;
  }

  const directCandidateFields = [
    entry.applicantId,
    entry.userId,
    entry.authorId,
    entry.ownerId,
    entry.createdBy
  ];

  for (const candidate of directCandidateFields) {
    const normalizedCandidate = normalizeDiscordSnowflake(candidate);
    if (normalizedCandidate) {
      return normalizedCandidate;
    }
  }

  const answerCandidateFields = [
    entry.answers?.applicantId,
    entry.answers?.userId,
    entry.answers?.authorId,
    entry.answers?.discordId,
    entry.answers?.discordUserId,
    entry.answers?.memberId
  ];

  for (const candidate of answerCandidateFields) {
    const normalizedCandidate = normalizeDiscordSnowflake(candidate);
    if (normalizedCandidate) {
      return normalizedCandidate;
    }
  }

  return null;
}

function buildAcceptedTicketIdentity(entry) {
  const applicantId = deriveAcceptedTicketApplicantId(entry);
  const robloxNickname = typeof entry?.answers?.robloxNick === 'string'
    ? entry.answers.robloxNick.trim()
    : '';

  return {
    applicantId,
    robloxNickname: robloxNickname || null,
    normalizedRobloxNickname: normalizeClanNicknameForMatch(robloxNickname),
    entry
  };
}

export function collectAcceptedTicketRobloxIdentitiesFromState(state, acceptedStatus = 'accept') {
  const identities = [];

  for (const entry of Object.values(state?.clan_ticket_decisions ?? {})) {
    if (!entry || entry.status !== acceptedStatus) {
      continue;
    }

    identities.push(buildAcceptedTicketIdentity(entry));
  }

  return identities;
}

export function getAcceptedTicketRobloxIdentityFromState(state, userId, acceptedStatus = 'accept') {
  const normalizedUserId = normalizeDiscordSnowflake(userId);
  if (!normalizedUserId) {
    return null;
  }

  let fallbackIdentity = null;
  for (const identity of collectAcceptedTicketRobloxIdentitiesFromState(state, acceptedStatus)) {
    if (identity.applicantId !== normalizedUserId) {
      continue;
    }

    if (identity.robloxNickname) {
      return identity;
    }

    fallbackIdentity ??= identity;
  }

  return fallbackIdentity;
}

export function hasAcceptedTicketAccessFromState(state, userId, acceptedStatus = 'accept') {
  return Boolean(getAcceptedTicketRobloxIdentityFromState(state, userId, acceptedStatus));
}

export function collectAcceptedClanPlayersFromState(state, acceptedStatus = 'accept') {
  const players = new Map();

  for (const identity of collectAcceptedTicketRobloxIdentitiesFromState(state, acceptedStatus)) {
    const normalizedNickname = identity.normalizedRobloxNickname;
    if (!normalizedNickname || players.has(normalizedNickname)) {
      continue;
    }

    const displayNickname = identity.robloxNickname ?? '';
    if (!displayNickname) {
      continue;
    }

    players.set(normalizedNickname, {
      displayNickname,
      applicantId: identity.applicantId ?? null
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

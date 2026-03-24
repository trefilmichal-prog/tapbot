export function normalizeRobloxUsernameCandidate(rawUsername) {
  if (typeof rawUsername !== 'string') {
    return null;
  }

  const candidate = rawUsername.trim();
  if (!candidate) {
    return null;
  }

  if (!/^[A-Za-z0-9_]{3,20}$/u.test(candidate)) {
    return null;
  }

  return candidate;
}

export function resolveRobloxAlertOptInTarget({ requestedNickRaw, acceptedTicketNickname, fallbackNickname }) {
  const hasNickStringInput = typeof requestedNickRaw === 'string';
  const hasNonWhitespaceNickInput = hasNickStringInput && requestedNickRaw.trim().length > 0;
  const requestedNick = hasNickStringInput
    ? normalizeRobloxUsernameCandidate(requestedNickRaw)
    : null;
  const hasInvalidRequestedNick = hasNonWhitespaceNickInput && !requestedNick;

  if (requestedNick) {
    return {
      resolvedRobloxUsername: requestedNick,
      source: 'manual_opt_in_nick',
      requestedNick,
      hasInvalidRequestedNick,
      hasExplicitRequestedNick: true
    };
  }

  if (acceptedTicketNickname) {
    return {
      resolvedRobloxUsername: acceptedTicketNickname,
      source: 'ticket_account',
      requestedNick: null,
      hasInvalidRequestedNick,
      hasExplicitRequestedNick: false
    };
  }

  if (fallbackNickname) {
    return {
      resolvedRobloxUsername: fallbackNickname,
      source: 'guild_nickname',
      requestedNick: null,
      hasInvalidRequestedNick,
      hasExplicitRequestedNick: false
    };
  }

  return {
    resolvedRobloxUsername: null,
    source: null,
    requestedNick: null,
    hasInvalidRequestedNick,
    hasExplicitRequestedNick: false
  };
}

export function getAcceptedTicketRobloxAccessError(identity, fallbackNickname = null, options = {}) {
  const subcommand = options?.subcommand === 'opt_out' ? 'opt_out' : 'opt_in';
  const hasValidRequestedNick = options?.hasValidRequestedNick === true;

  if (!identity) {
    return 'Only members with an accepted ticket in this server can use Roblox monitor alerts.';
  }

  if (subcommand === 'opt_in' && hasValidRequestedNick) {
    return null;
  }

  if (!identity.robloxNickname && !fallbackNickname) {
    return 'Your accepted ticket has no Roblox account attached yet.';
  }

  return null;
}

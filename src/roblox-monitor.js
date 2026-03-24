import { getClanState, getRobloxMonitorState, updateRobloxMonitorState } from './persistence.js';
import { collectAcceptedTicketRobloxIdentitiesFromState } from './clan-notification-matching.js';

const DEFAULT_TARGET_USERNAME = 'altiksenpaicat2';
const DEFAULT_REQUIRED_ROOT_PLACE_ID = 74260430392611;
const DEFAULT_CHECK_INTERVAL_MINUTES = 5;
const DEFAULT_OFFLINE_REMINDER_MINUTES = 10;
const MIN_INTERVAL_MINUTES = 1;
const ROBLOX_API_ORIGIN = 'https://www.roblox.com';
const USERNAME_RESOLVE_URL = 'https://users.roblox.com/v1/usernames/users';
const AUTHENTICATED_USER_URL = 'https://users.roblox.com/v1/users/authenticated';
const PRESENCE_URL = 'https://presence.roblox.com/v1/presence/users';

const schedulerStateByGuild = new Map();

function normalizeUsername(username) {
  return typeof username === 'string' ? username.trim().toLowerCase() : '';
}

function normalizeGuildNicknameAsRobloxCandidate(rawNickname) {
  if (typeof rawNickname !== 'string') {
    return null;
  }

  let candidate = rawNickname.trim();
  if (!candidate) {
    return null;
  }

  candidate = candidate
    .replace(/^\[[^\]]{1,12}\]\s*/u, '')
    .replace(/\s*\[[^\]]{1,12}\]$/u, '')
    .replace(/^[\s|:;•·★☆→«»『』【】(){}<>~`!@#$%^&*=+,./\\-]+/u, '')
    .replace(/[\s|:;•·★☆→«»『』【】(){}<>~`!@#$%^&*=+,./\\-]+$/u, '')
    .trim();

  if (!candidate || candidate.length < 3 || candidate.length > 32) {
    return null;
  }

  return candidate;
}

function getIntervalMinutes(state) {
  return Math.max(MIN_INTERVAL_MINUTES, Number(state?.checkIntervalMinutes) || DEFAULT_CHECK_INTERVAL_MINUTES);
}

function getOfflineReminderMinutes(state) {
  return Math.max(MIN_INTERVAL_MINUTES, Number(state?.offlineReminderMinutes) || DEFAULT_OFFLINE_REMINDER_MINUTES);
}

function getRequiredRootPlaceId(state) {
  const targetGameRootPlaceId = Number.isInteger(state?.targetGame?.requiredRootPlaceId) && state.targetGame.requiredRootPlaceId > 0
    ? state.targetGame.requiredRootPlaceId
    : null;
  return targetGameRootPlaceId
    ?? (Number.isInteger(state?.requiredRootPlaceId) && state.requiredRootPlaceId > 0
      ? state.requiredRootPlaceId
      : DEFAULT_REQUIRED_ROOT_PLACE_ID);
}

function getSessionCookie(state) {
  const nestedSessionCookie = typeof state?.monitoringSession?.sessionCookie === 'string' && state.monitoringSession.sessionCookie.trim()
    ? state.monitoringSession.sessionCookie.trim()
    : null;
  if (nestedSessionCookie) {
    return nestedSessionCookie;
  }
  return typeof state?.sessionCookie === 'string' && state.sessionCookie.trim()
    ? state.sessionCookie.trim()
    : null;
}

function isPresenceOnline(presence) {
  return Number(presence?.userPresenceType) > 0;
}

function isPresenceInTargetGame(presence, requiredRootPlaceId) {
  if (!isPresenceOnline(presence)) {
    return false;
  }

  const requiredId = Number(requiredRootPlaceId);
  if (!Number.isInteger(requiredId) || requiredId <= 0) {
    return false;
  }

  const rootPlaceId = Number.isInteger(presence?.rootPlaceId) ? presence.rootPlaceId : null;
  const placeId = Number.isInteger(presence?.placeId) ? presence.placeId : null;
  return rootPlaceId === requiredId || placeId === requiredId;
}

function describePresenceForReminder(snapshot) {
  if (!snapshot?.isOnline) {
    return 'offline';
  }
  if (!snapshot.isInTargetGame) {
    return 'online, but outside the monitored game';
  }
  return 'online in the monitored game';
}

function createRobloxCookieHeader(sessionCookie) {
  if (!sessionCookie || typeof sessionCookie !== 'string') {
    return null;
  }

  const trimmed = sessionCookie.trim();
  if (!trimmed) {
    return null;
  }

  return trimmed.startsWith('.ROBLOSECURITY=') ? trimmed : `.ROBLOSECURITY=${trimmed}`;
}

class RobloxSessionClient {
  constructor(sessionCookie) {
    this.cookieHeader = createRobloxCookieHeader(sessionCookie);
    this.csrfToken = null;
  }

  async request(url, { method = 'GET', body = null, headers = {}, retryOnCsrf = true } = {}) {
    if (!this.cookieHeader) {
      throw new Error('Roblox session cookie is not configured.');
    }

    const resolvedHeaders = {
      accept: 'application/json',
      cookie: this.cookieHeader,
      ...headers
    };

    if (this.csrfToken) {
      resolvedHeaders['x-csrf-token'] = this.csrfToken;
    }

    let payloadBody = body;
    if (body && typeof body === 'object' && !(body instanceof ArrayBuffer) && !(body instanceof Uint8Array) && !(typeof body === 'string')) {
      resolvedHeaders['content-type'] = resolvedHeaders['content-type'] ?? 'application/json';
      payloadBody = JSON.stringify(body);
    }

    const response = await fetch(url, {
      method,
      headers: resolvedHeaders,
      body: method === 'GET' || method === 'HEAD' ? undefined : payloadBody
    });

    const csrfToken = response.headers.get('x-csrf-token');
    if (csrfToken) {
      this.csrfToken = csrfToken;
    }

    if (response.status === 403 && retryOnCsrf && csrfToken && method !== 'GET' && method !== 'HEAD') {
      return this.request(url, { method, body, headers, retryOnCsrf: false });
    }

    const contentType = response.headers.get('content-type') || '';
    const responseBody = contentType.includes('application/json')
      ? await response.json().catch(() => null)
      : await response.text().catch(() => null);

    if (!response.ok) {
      const message = typeof responseBody === 'string'
        ? responseBody
        : responseBody?.errors?.map((entry) => entry?.message).filter(Boolean).join('; ') || response.statusText;
      const error = new Error(`Roblox API request failed (${response.status} ${response.statusText}): ${message || 'Unknown error'}`);
      error.status = response.status;
      error.payload = responseBody;
      throw error;
    }

    return responseBody;
  }
}

async function resolveRobloxUserIdByUsername(apiClient, username) {
  const payload = await apiClient.request(USERNAME_RESOLVE_URL, {
    method: 'POST',
    body: {
      usernames: [username],
      excludeBannedUsers: false
    }
  });

  const matched = payload?.data?.find((entry) => normalizeUsername(entry?.requestedUsername) === normalizeUsername(username))
    ?? payload?.data?.find((entry) => normalizeUsername(entry?.name) === normalizeUsername(username));
  if (!matched?.id) {
    throw new Error(`Unable to resolve Roblox user id for username "${username}".`);
  }

  return {
    userId: matched.id,
    username: matched.name ?? username,
    displayName: matched.displayName ?? matched.name ?? username
  };
}

async function getAuthenticatedRobloxUser(apiClient) {
  const payload = await apiClient.request(AUTHENTICATED_USER_URL);
  if (!payload?.id) {
    throw new Error('Unable to resolve the authenticated Roblox user for the configured cookie.');
  }
  return payload;
}

async function getRobloxPresence(apiClient, targetUserId) {
  const payload = await apiClient.request(PRESENCE_URL, {
    method: 'POST',
    body: {
      userIds: [targetUserId]
    }
  });

  const presence = payload?.userPresences?.find((entry) => Number(entry?.userId) === Number(targetUserId));
  if (!presence) {
    throw new Error(`No presence payload was returned for Roblox user ${targetUserId}.`);
  }
  return presence;
}

async function isMonitoringAccountFriendsWithTarget(apiClient, monitoringUserId, targetUserId) {
  const payload = await apiClient.request(`https://friends.roblox.com/v1/users/${monitoringUserId}/friends`);
  return Boolean(payload?.data?.some((entry) => Number(entry?.id) === Number(targetUserId)));
}

async function listPendingInboundFriendRequests(apiClient) {
  const requests = [];
  let cursor = null;

  do {
    const url = new URL('https://friends.roblox.com/v1/my/friends/requests');
    url.searchParams.set('limit', '100');
    url.searchParams.set('sortOrder', 'Asc');
    if (cursor) {
      url.searchParams.set('cursor', cursor);
    }

    const payload = await apiClient.request(url.toString());
    const pageEntries = Array.isArray(payload?.data) ? payload.data : [];
    requests.push(...pageEntries);
    cursor = typeof payload?.nextPageCursor === 'string' && payload.nextPageCursor ? payload.nextPageCursor : null;
  } while (cursor);

  return requests;
}

async function acceptFriendRequest(apiClient, requesterUserId) {
  await apiClient.request(`https://friends.roblox.com/v1/users/${requesterUserId}/accept-friend-request`, {
    method: 'POST',
    body: {}
  });
}

function collectApprovedTicketUsers(guildId) {
  const state = getClanState(guildId);
  const discordUserIds = new Set();
  const robloxUsernames = new Set();
  const discordUserIdToRobloxUsername = {};

  for (const identity of collectAcceptedTicketRobloxIdentitiesFromState(state)) {
    if (identity.applicantId) {
      discordUserIds.add(identity.applicantId);
    }

    if (identity.robloxNickname) {
      robloxUsernames.add(identity.robloxNickname);
      if (identity.applicantId && !discordUserIdToRobloxUsername[identity.applicantId]) {
        discordUserIdToRobloxUsername[identity.applicantId] = identity.robloxNickname;
      }
    }
  }

  return {
    discordUserIds: [...discordUserIds].sort(),
    robloxUsernames: [...robloxUsernames].sort((left, right) => left.localeCompare(right)),
    discordUserIdToRobloxUsername
  };
}

async function sendOfflineReminderToSubscribers(client, guild, targetUsername, subscriberUserIds, presenceSnapshot) {
  for (const userId of subscriberUserIds) {
    try {
      const user = await client.users.fetch(userId);
      await user.send(
        `Roblox monitor alert for **${guild.name}**: **${targetUsername}** is currently ${describePresenceForReminder(presenceSnapshot)}. `
        + `The bot will remind you again after the configured interval if they are still not in the monitored game.`
      );
    } catch (error) {
      console.warn(`Failed to send Roblox offline reminder to user ${userId} in guild ${guild.id}:`, error);
    }
  }
}

function buildPresenceSnapshot({
  state,
  targetUsername,
  targetUserId,
  monitoringAccountUserId,
  isFriend,
  presence,
  requiredRootPlaceId,
  error = null
}) {
  const previousLastOnlineAt = state?.lastKnownPresence?.lastOnlineAt ?? null;
  const isOnline = isPresenceOnline(presence);
  const monitoredRootPlaceId = Number.isInteger(requiredRootPlaceId) ? requiredRootPlaceId : getRequiredRootPlaceId(state);
  const isInTargetGame = isPresenceInTargetGame(presence, monitoredRootPlaceId);

  return {
    checkedAt: new Date().toISOString(),
    isOnline,
    isInTargetGame,
    userPresenceType: Number(presence?.userPresenceType) || 0,
    targetUsername,
    targetUserId: Number.isInteger(targetUserId) && targetUserId > 0 ? targetUserId : null,
    monitoringAccountUserId: Number.isInteger(monitoringAccountUserId) ? monitoringAccountUserId : null,
    isFriend: typeof isFriend === 'boolean' ? isFriend : null,
    lastOnlineAt: isOnline ? new Date().toISOString() : previousLastOnlineAt,
    lastLocation: typeof presence?.lastLocation === 'string' && presence.lastLocation.trim() ? presence.lastLocation.trim() : null,
    placeId: Number.isInteger(presence?.placeId) ? presence.placeId : null,
    rootPlaceId: Number.isInteger(presence?.rootPlaceId) ? presence.rootPlaceId : null,
    universeId: Number.isInteger(presence?.universeId) ? presence.universeId : null,
    gameId: typeof presence?.gameId === 'string' && presence.gameId.trim() ? presence.gameId.trim() : null,
    lastError: error ? String(error) : null
  };
}

async function runRobloxMonitorTick(client, guildId) {
  const guild = client.guilds.cache.get(guildId) ?? await client.guilds.fetch(guildId).catch(() => null);
  if (!guild) {
    stopRobloxMonitorScheduler(guildId);
    return;
  }

  const approvedUsers = collectApprovedTicketUsers(guildId);
  let state = getRobloxMonitorState(guildId);
  const monitorSource = state?.monitorSource && typeof state.monitorSource === 'object'
    ? state.monitorSource
    : {};
  const sourceType = monitorSource.source_type === 'guild_nickname' ? 'guild_nickname' : 'target_override';
  const sourceUserId = typeof monitorSource.source_user_id === 'string' && monitorSource.source_user_id.trim()
    ? monitorSource.source_user_id.trim()
    : null;
  const targetOverride = typeof monitorSource.target_override === 'string' && monitorSource.target_override.trim()
    ? monitorSource.target_override.trim()
    : null;
  const normalizedTargetUsername = sourceType === 'guild_nickname'
    ? null
    : (targetOverride || state.targetUsername || DEFAULT_TARGET_USERNAME);
  const requiredRootPlaceId = getRequiredRootPlaceId(state);
  const approvedDiscordUserIdSet = new Set(approvedUsers.discordUserIds);
  const filteredSubscriberUserIds = state.subscriberUserIds.filter((userId) => approvedDiscordUserIdSet.has(userId));

  if (JSON.stringify(state.subscriberUserIds) !== JSON.stringify(filteredSubscriberUserIds)) {
    state = await updateRobloxMonitorState(guildId, (nextState) => {
      nextState.subscriberUserIds = filteredSubscriberUserIds;
      if (!nextState.subscriberRobloxAccounts || typeof nextState.subscriberRobloxAccounts !== 'object' || Array.isArray(nextState.subscriberRobloxAccounts)) {
        nextState.subscriberRobloxAccounts = {};
      }
      if (!nextState.subscriberFriendshipStatus || typeof nextState.subscriberFriendshipStatus !== 'object' || Array.isArray(nextState.subscriberFriendshipStatus)) {
        nextState.subscriberFriendshipStatus = {};
      }
      for (const userId of Object.keys(nextState.subscriberRobloxAccounts)) {
        if (!approvedDiscordUserIdSet.has(userId)) {
          delete nextState.subscriberRobloxAccounts[userId];
        }
      }
      for (const userId of Object.keys(nextState.subscriberFriendshipStatus)) {
        if (!approvedDiscordUserIdSet.has(userId)) {
          delete nextState.subscriberFriendshipStatus[userId];
        }
      }
      if (!nextState.targetUsername) {
        nextState.targetUsername = DEFAULT_TARGET_USERNAME;
      }
      if (!nextState.requiredRootPlaceId) {
        nextState.requiredRootPlaceId = requiredRootPlaceId;
      }
    });
  }

  const sessionCookie = getSessionCookie(state);
  if (!sessionCookie) {
    await updateRobloxMonitorState(guildId, (nextState) => {
      const checkedAt = new Date().toISOString();
      nextState.targetUsername = normalizedTargetUsername ?? nextState.targetUsername ?? DEFAULT_TARGET_USERNAME;
      nextState.requiredRootPlaceId = getRequiredRootPlaceId(nextState);
      if (!nextState.subscriberFriendshipStatus || typeof nextState.subscriberFriendshipStatus !== 'object' || Array.isArray(nextState.subscriberFriendshipStatus)) {
        nextState.subscriberFriendshipStatus = {};
      }
      for (const subscriberUserId of filteredSubscriberUserIds) {
        const previous = nextState.subscriberFriendshipStatus[subscriberUserId];
        nextState.subscriberFriendshipStatus[subscriberUserId] = {
          robloxUserId: Number.isInteger(previous?.robloxUserId) ? previous.robloxUserId : null,
          isFriend: false,
          lastCheckedAt: checkedAt,
          lastAutoAcceptedAt: previous?.lastAutoAcceptedAt ?? null,
          note: 'Periodic check skipped: missing monitor session cookie.'
        };
      }
      nextState.lastKnownPresence = buildPresenceSnapshot({
        state: nextState,
        targetUsername: normalizedTargetUsername ?? nextState.targetUsername ?? DEFAULT_TARGET_USERNAME,
        targetUserId: nextState.targetUserId ?? null,
        monitoringAccountUserId: null,
        isFriend: null,
        presence: null,
        requiredRootPlaceId: getRequiredRootPlaceId(nextState),
        error: 'Roblox monitor skipped because no .ROBLOSECURITY cookie is configured.'
      });
    });
    return;
  }

  const apiClient = new RobloxSessionClient(sessionCookie);
  try {
    let targetResolution = null;
    let resolutionSource = 'target_override';
    let resolutionUserId = sourceUserId;

    if (sourceType === 'guild_nickname') {
      resolutionSource = 'guild_nickname';
      if (!sourceUserId) {
        throw new Error('Roblox monitor source_type=guild_nickname requires source_user_id in monitorSource.');
      }

      const member = await guild.members.fetch(sourceUserId).catch(() => null);
      const dynamicNickname = normalizeGuildNicknameAsRobloxCandidate(member?.nickname)
        ?? normalizeGuildNicknameAsRobloxCandidate(member?.displayName);
      if (!dynamicNickname) {
        throw new Error(`Unable to resolve Roblox username from guild nickname for user ${sourceUserId}.`);
      }
      targetResolution = await resolveRobloxUserIdByUsername(apiClient, dynamicNickname);
    } else {
      const staticTarget = normalizedTargetUsername ?? DEFAULT_TARGET_USERNAME;
      targetResolution = state.targetUserId && normalizeUsername(state.targetUsername) === normalizeUsername(staticTarget)
        ? { userId: state.targetUserId, username: staticTarget }
        : await resolveRobloxUserIdByUsername(apiClient, staticTarget);
    }

    const targetUserId = Number(targetResolution.userId);
    const targetUsername = targetResolution.username ?? normalizedTargetUsername ?? DEFAULT_TARGET_USERNAME;
    console.info('Roblox monitor target resolved', {
      guild_id: guildId,
      user_id: resolutionUserId,
      game_id: requiredRootPlaceId,
      resolution_source: resolutionSource,
      target_username: targetUsername,
      target_user_id: targetUserId
    });
    const monitoringUser = await getAuthenticatedRobloxUser(apiClient);
    const presence = await getRobloxPresence(apiClient, targetUserId);
    const isFriend = await isMonitoringAccountFriendsWithTarget(apiClient, monitoringUser.id, targetUserId);

    const approvedRobloxIds = new Set();
    for (const username of approvedUsers.robloxUsernames) {
      try {
        const resolution = await resolveRobloxUserIdByUsername(apiClient, username);
        approvedRobloxIds.add(Number(resolution.userId));
      } catch (error) {
        console.warn(`Failed to resolve approved Roblox username ${username} in guild ${guildId}:`, error);
      }
    }

    const pendingRequests = await listPendingInboundFriendRequests(apiClient);
    let acceptedCount = 0;
    const acceptedRequesterIds = new Set();
    for (const request of pendingRequests) {
      const requesterId = Number(request?.id);
      if (!approvedRobloxIds.has(requesterId)) {
        continue;
      }
      await acceptFriendRequest(apiClient, requesterId);
      acceptedRequesterIds.add(requesterId);
      acceptedCount += 1;
    }

    const checkedAt = new Date().toISOString();
    const friendshipStatusBySubscriber = {};
    const subscriberAccountMap = state?.subscriberRobloxAccounts && typeof state.subscriberRobloxAccounts === 'object' && !Array.isArray(state.subscriberRobloxAccounts)
      ? state.subscriberRobloxAccounts
      : {};
    const resolvedUsernameCache = new Map();

    for (const subscriberUserId of filteredSubscriberUserIds) {
      const preferredUsername = subscriberAccountMap[subscriberUserId]?.username
        ?? approvedUsers.discordUserIdToRobloxUsername[subscriberUserId]
        ?? null;

      if (!preferredUsername) {
        friendshipStatusBySubscriber[subscriberUserId] = {
          robloxUserId: null,
          isFriend: false,
          lastCheckedAt: checkedAt,
          lastAutoAcceptedAt: null,
          note: 'No Roblox username could be resolved for this subscriber.'
        };
        continue;
      }

      const cacheKey = normalizeUsername(preferredUsername);
      let resolvedRobloxUserId = resolvedUsernameCache.get(cacheKey) ?? null;
      if (!resolvedRobloxUserId) {
        try {
          const resolution = await resolveRobloxUserIdByUsername(apiClient, preferredUsername);
          resolvedRobloxUserId = Number(resolution.userId);
          resolvedUsernameCache.set(cacheKey, resolvedRobloxUserId);
        } catch (error) {
          friendshipStatusBySubscriber[subscriberUserId] = {
            robloxUserId: null,
            isFriend: false,
            lastCheckedAt: checkedAt,
            lastAutoAcceptedAt: null,
            note: `Failed to resolve Roblox user "${preferredUsername}".`
          };
          continue;
        }
      }

      const subscriberIsFriend = await isMonitoringAccountFriendsWithTarget(apiClient, monitoringUser.id, resolvedRobloxUserId);
      friendshipStatusBySubscriber[subscriberUserId] = {
        robloxUserId: resolvedRobloxUserId,
        isFriend: subscriberIsFriend,
        lastCheckedAt: checkedAt,
        lastAutoAcceptedAt: acceptedRequesterIds.has(resolvedRobloxUserId) ? checkedAt : null,
        note: subscriberIsFriend
          ? 'Friendship verified during periodic monitor tick.'
          : 'Friendship not verified during periodic monitor tick.'
      };
    }

    const nextPresence = buildPresenceSnapshot({
      state,
      targetUsername,
      targetUserId,
      monitoringAccountUserId: Number(monitoringUser.id),
      isFriend,
      presence,
      requiredRootPlaceId
    });

    const nowMs = Date.now();
    const reminderIntervalMs = getOfflineReminderMinutes(state) * 60 * 1000;
    const lastReminderMs = state.lastOfflineReminderAt ? new Date(state.lastOfflineReminderAt).getTime() : 0;
    const shouldSendOfflineReminder = !nextPresence.isInTargetGame
      && filteredSubscriberUserIds.length > 0
      && (!lastReminderMs || Number.isNaN(lastReminderMs) || (nowMs - lastReminderMs) >= reminderIntervalMs);

    if (shouldSendOfflineReminder) {
      await sendOfflineReminderToSubscribers(client, guild, targetUsername, filteredSubscriberUserIds, nextPresence);
    }

    await updateRobloxMonitorState(guildId, (nextState) => {
      nextState.targetUsername = targetUsername;
      nextState.targetUserId = targetUserId;
      nextState.requiredRootPlaceId = requiredRootPlaceId;
      if (!nextState.monitorSource || typeof nextState.monitorSource !== 'object' || Array.isArray(nextState.monitorSource)) {
        nextState.monitorSource = {};
      }
      nextState.monitorSource.guild_id = guildId;
      nextState.monitorSource.channel_id = nextState.monitorSource.channel_id ?? null;
      nextState.monitorSource.game_id = requiredRootPlaceId;
      nextState.monitorSource.source_type = sourceType;
      nextState.monitorSource.target_override = sourceType === 'guild_nickname' ? null : (targetOverride ?? targetUsername);
      nextState.monitorSource.source_user_id = sourceUserId;
      nextState.monitorSource.updated_at = new Date().toISOString();
      nextState.subscriberUserIds = filteredSubscriberUserIds;
      nextState.subscriberFriendshipStatus = friendshipStatusBySubscriber;
      nextState.lastKnownPresence = nextPresence;
      nextState.lastFriendRequestSweepAt = new Date().toISOString();
      nextState.lastOfflineReminderAt = nextPresence.isInTargetGame
        ? null
        : (shouldSendOfflineReminder ? new Date().toISOString() : nextState.lastOfflineReminderAt);
    });

    if (acceptedCount > 0) {
      console.log(`Accepted ${acceptedCount} Roblox friend request(s) for guild ${guildId}.`);
    }
  } catch (error) {
    console.warn(`Roblox monitor tick failed for guild ${guildId}:`, error);
    console.warn('Roblox monitor target resolution warning', {
      guild_id: guildId,
      user_id: sourceUserId,
      game_id: requiredRootPlaceId,
      resolution_source: sourceType
    });
    await updateRobloxMonitorState(guildId, (nextState) => {
      const checkedAt = new Date().toISOString();
      nextState.targetUsername = normalizedTargetUsername ?? nextState.targetUsername ?? DEFAULT_TARGET_USERNAME;
      nextState.requiredRootPlaceId = getRequiredRootPlaceId(nextState);
      if (!nextState.subscriberFriendshipStatus || typeof nextState.subscriberFriendshipStatus !== 'object' || Array.isArray(nextState.subscriberFriendshipStatus)) {
        nextState.subscriberFriendshipStatus = {};
      }
      for (const subscriberUserId of filteredSubscriberUserIds) {
        const previous = nextState.subscriberFriendshipStatus[subscriberUserId];
        nextState.subscriberFriendshipStatus[subscriberUserId] = {
          robloxUserId: Number.isInteger(previous?.robloxUserId) ? previous.robloxUserId : null,
          isFriend: typeof previous?.isFriend === 'boolean' ? previous.isFriend : false,
          lastCheckedAt: checkedAt,
          lastAutoAcceptedAt: previous?.lastAutoAcceptedAt ?? null,
          note: `Periodic check failed: ${error?.message ?? error}`
        };
      }
      nextState.lastKnownPresence = buildPresenceSnapshot({
        state: nextState,
        targetUsername: normalizedTargetUsername ?? nextState.targetUsername ?? DEFAULT_TARGET_USERNAME,
        targetUserId: nextState.targetUserId ?? null,
        monitoringAccountUserId: nextState.lastKnownPresence?.monitoringAccountUserId ?? null,
        isFriend: nextState.lastKnownPresence?.isFriend ?? null,
        presence: nextState.lastKnownPresence,
        requiredRootPlaceId: getRequiredRootPlaceId(nextState),
        error: error?.message ?? error
      });
    });
  }
}

async function executeGuildSchedulerTick(client, guildId) {
  const schedulerState = schedulerStateByGuild.get(guildId);
  if (!schedulerState || schedulerState.running) {
    return;
  }

  schedulerState.running = true;
  try {
    await runRobloxMonitorTick(client, guildId);
  } finally {
    schedulerState.running = false;
  }

  const latestState = getRobloxMonitorState(guildId);
  const latestIntervalMs = getIntervalMinutes(latestState) * 60 * 1000;
  if (schedulerState.intervalMs !== latestIntervalMs) {
    startRobloxMonitorScheduler(client, guildId);
  }
}

export function stopRobloxMonitorScheduler(guildId) {
  const key = String(guildId);
  const schedulerState = schedulerStateByGuild.get(key);
  if (!schedulerState) {
    return;
  }

  if (schedulerState.timer) {
    clearInterval(schedulerState.timer);
  }
  schedulerStateByGuild.delete(key);
}

export function startRobloxMonitorScheduler(client, guildId) {
  const key = String(guildId);
  stopRobloxMonitorScheduler(key);

  const state = getRobloxMonitorState(key);
  const intervalMs = getIntervalMinutes(state) * 60 * 1000;
  const schedulerState = {
    intervalMs,
    running: false,
    timer: null
  };

  schedulerState.timer = setInterval(() => {
    void executeGuildSchedulerTick(client, key);
  }, intervalMs);
  schedulerStateByGuild.set(key, schedulerState);

  void executeGuildSchedulerTick(client, key);
}

export function startRobloxMonitorSchedulers(client) {
  for (const [guildId] of client.guilds.cache) {
    startRobloxMonitorScheduler(client, guildId);
  }
}

export function getRobloxMonitorDefaultTargetUsername() {
  return DEFAULT_TARGET_USERNAME;
}

export const robloxMonitorInternals = {
  RobloxSessionClient,
  resolveRobloxUserIdByUsername,
  getAuthenticatedRobloxUser,
  getRobloxPresence,
  isMonitoringAccountFriendsWithTarget,
  listPendingInboundFriendRequests,
  acceptFriendRequest,
  collectApprovedTicketUsers,
  buildPresenceSnapshot,
  isPresenceInTargetGame,
  ROBLOX_API_ORIGIN
};

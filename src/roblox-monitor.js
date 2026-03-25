import { getClanState, getRobloxMonitorState, updateRobloxMonitorState } from './persistence.js';
import { collectAcceptedTicketRobloxIdentitiesFromState } from './clan-notification-matching.js';
import {
  buildV2Container,
  buildV2MessagePayload,
  buildV2Separator,
  buildV2TextDisplay
} from './components-v2.js';

const DEFAULT_REQUIRED_ROOT_PLACE_ID = 74260430392611;
const DEFAULT_CHECK_INTERVAL_MINUTES = 5;
const DEFAULT_OFFLINE_REMINDER_MINUTES = 10;
const DEFAULT_STATS_REPORT_POST_INTERVAL_MINUTES = 30;
const MIN_INTERVAL_MINUTES = 1;
const ROBLOX_API_ORIGIN = 'https://www.roblox.com';
const USERNAME_RESOLVE_URL = 'https://users.roblox.com/v1/usernames/users';
const AUTHENTICATED_USER_URL = 'https://users.roblox.com/v1/users/authenticated';
const PRESENCE_URL = 'https://presence.roblox.com/v1/presence/users';
const USERNAME_RESOLUTION_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const USERNAME_RESOLUTION_CACHE_MAX_ENTRIES = 500;

const schedulerStateByGuild = new Map();

export const ROBLOX_SUBSCRIBER_ACCOUNT_SOURCE = Object.freeze({
  CLAN_AUTO: 'clan_auto',
  OPT_IN: 'opt_in',
  LEGACY_MANUAL_OPT_IN_NICK: 'manual_opt_in_nick',
  LEGACY_TICKET_ACCOUNT: 'ticket_account',
  LEGACY_GUILD_NICKNAME: 'guild_nickname'
});

const LEGACY_OPT_IN_SOURCES = new Set([
  ROBLOX_SUBSCRIBER_ACCOUNT_SOURCE.LEGACY_MANUAL_OPT_IN_NICK,
  ROBLOX_SUBSCRIBER_ACCOUNT_SOURCE.LEGACY_TICKET_ACCOUNT,
  ROBLOX_SUBSCRIBER_ACCOUNT_SOURCE.LEGACY_GUILD_NICKNAME
]);

function isOptInPreferredSubscriberSource(source) {
  if (source === ROBLOX_SUBSCRIBER_ACCOUNT_SOURCE.OPT_IN) {
    return true;
  }
  return LEGACY_OPT_IN_SOURCES.has(source);
}

function isExplicitDmOptInSubscriberSource(source) {
  return source === ROBLOX_SUBSCRIBER_ACCOUNT_SOURCE.OPT_IN
    || source === ROBLOX_SUBSCRIBER_ACCOUNT_SOURCE.LEGACY_MANUAL_OPT_IN_NICK;
}

function resolveSubscriberAccountSourceForTick({ existingSource, sourceClanName }) {
  if (!sourceClanName) {
    return existingSource ?? ROBLOX_SUBSCRIBER_ACCOUNT_SOURCE.LEGACY_TICKET_ACCOUNT;
  }
  if (isOptInPreferredSubscriberSource(existingSource)) {
    return existingSource;
  }
  return ROBLOX_SUBSCRIBER_ACCOUNT_SOURCE.CLAN_AUTO;
}

function isRobloxUsernameNotFoundError(error) {
  if (!error) {
    return false;
  }
  const message = typeof error?.message === 'string' ? error.message : String(error);
  return message.includes('Unable to resolve Roblox user id for username');
}

function shouldRetainSubscriberRecord(userId, account, mode, approvedSet) {
  if (mode !== 'clan') {
    return false;
  }
  if (approvedSet.has(userId)) {
    return true;
  }
  if (account?.source === ROBLOX_SUBSCRIBER_ACCOUNT_SOURCE.CLAN_AUTO) {
    return approvedSet.has(userId);
  }
  return account?.source === ROBLOX_SUBSCRIBER_ACCOUNT_SOURCE.OPT_IN;
}

function normalizeUsername(username) {
  return typeof username === 'string' ? username.trim().toLowerCase() : '';
}

function getCachedUsernameResolution(cache, username, nowMs = Date.now()) {
  if (!cache || typeof cache !== 'object' || Array.isArray(cache)) {
    return null;
  }
  const normalized = normalizeUsername(username);
  if (!normalized) {
    return null;
  }
  const entry = cache[normalized];
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
    return null;
  }
  const resolvedAtMs = new Date(entry.resolvedAt).getTime();
  const isFresh = Number.isFinite(resolvedAtMs) && (nowMs - resolvedAtMs) <= USERNAME_RESOLUTION_CACHE_TTL_MS;
  if (!isFresh || !Number.isInteger(entry.userId) || entry.userId <= 0) {
    return null;
  }
  return {
    normalizedUsername: normalized,
    userId: entry.userId,
    username: typeof entry.username === 'string' && entry.username.trim() ? entry.username.trim() : normalized,
    resolvedAt: entry.resolvedAt
  };
}

function upsertUsernameResolutionCacheEntry(cache, resolution, nowIso = new Date().toISOString()) {
  if (!cache || typeof cache !== 'object' || Array.isArray(cache)) {
    return;
  }

  const normalizedUsername = normalizeUsername(resolution?.normalizedUsername ?? resolution?.username);
  const userId = Number(resolution?.userId);
  if (!normalizedUsername || !Number.isInteger(userId) || userId <= 0) {
    return;
  }

  cache[normalizedUsername] = {
    normalizedUsername,
    userId,
    username: typeof resolution?.username === 'string' && resolution.username.trim()
      ? resolution.username.trim()
      : normalizedUsername,
    resolvedAt: nowIso
  };
}

function pruneUsernameResolutionCache(cache, nowMs = Date.now()) {
  if (!cache || typeof cache !== 'object' || Array.isArray(cache)) {
    return {};
  }

  const entries = Object.entries(cache)
    .filter(([, entry]) => {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
        return false;
      }
      const normalizedUsername = normalizeUsername(entry.normalizedUsername);
      const userId = Number(entry.userId);
      const resolvedAtMs = new Date(entry.resolvedAt).getTime();
      return Boolean(normalizedUsername)
        && Number.isInteger(userId)
        && userId > 0
        && Number.isFinite(resolvedAtMs)
        && (nowMs - resolvedAtMs) <= USERNAME_RESOLUTION_CACHE_TTL_MS;
    })
    .sort((a, b) => new Date(b[1].resolvedAt).getTime() - new Date(a[1].resolvedAt).getTime())
    .slice(0, USERNAME_RESOLUTION_CACHE_MAX_ENTRIES);

  const pruned = {};
  for (const [key, entry] of entries) {
    const normalizedKey = normalizeUsername(key);
    if (!normalizedKey) {
      continue;
    }
    pruned[normalizedKey] = {
      normalizedUsername: normalizedKey,
      userId: Number(entry.userId),
      username: typeof entry.username === 'string' && entry.username.trim()
        ? entry.username.trim()
        : normalizedKey,
      resolvedAt: entry.resolvedAt
    };
  }
  return pruned;
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

function normalizeSubscriberAggregateStats(stats) {
  const totalOnlineMinutes = Math.max(0, Number(stats?.totalOnlineMinutes) || 0);
  const totalOfflineMinutes = Math.max(0, Number(stats?.totalOfflineMinutes) || 0);
  const totalSampledMinutes = Math.max(0, Number(stats?.totalSampledMinutes) || 0);
  const onlinePercentage = totalSampledMinutes > 0
    ? (totalOnlineMinutes / totalSampledMinutes) * 100
    : 0;
  return {
    totalOnlineMinutes,
    totalOfflineMinutes,
    totalSampledMinutes,
    onlinePercentage
  };
}

function buildUpdatedSubscriberAggregateStats(previousStats, { isOnline, sampleMinutes }) {
  const normalized = normalizeSubscriberAggregateStats(previousStats);
  const sampledIncrement = Math.max(0, Number(sampleMinutes) || 0);
  if (sampledIncrement <= 0) {
    return normalized;
  }

  const nextOnlineMinutes = normalized.totalOnlineMinutes + (isOnline ? sampledIncrement : 0);
  const nextOfflineMinutes = normalized.totalOfflineMinutes + (isOnline ? 0 : sampledIncrement);
  const nextSampledMinutes = normalized.totalSampledMinutes + sampledIncrement;
  return normalizeSubscriberAggregateStats({
    totalOnlineMinutes: nextOnlineMinutes,
    totalOfflineMinutes: nextOfflineMinutes,
    totalSampledMinutes: nextSampledMinutes
  });
}

export function formatRobloxMonitorAggregateStats(stats) {
  const normalized = normalizeSubscriberAggregateStats(stats);
  return `Uptime: **${normalized.onlinePercentage.toFixed(2)}%** (Online: **${normalized.totalOnlineMinutes}m**, Offline: **${normalized.totalOfflineMinutes}m**, Sampled: **${normalized.totalSampledMinutes}m**)`;
}

function getOfflineReminderMinutes(state) {
  return Math.max(MIN_INTERVAL_MINUTES, Number(state?.offlineReminderMinutes) || DEFAULT_OFFLINE_REMINDER_MINUTES);
}

function getStatsReportPostIntervalMinutes(state) {
  return Math.max(MIN_INTERVAL_MINUTES, Number(state?.statsReport?.postIntervalMinutes) || DEFAULT_STATS_REPORT_POST_INTERVAL_MINUTES);
}

function formatDurationMinutes(totalMinutes) {
  const normalizedMinutes = Math.max(0, Number(totalMinutes) || 0);
  const hours = Math.floor(normalizedMinutes / 60);
  const minutes = normalizedMinutes % 60;
  return hours > 0
    ? `${hours}h ${minutes}m`
    : `${minutes}m`;
}

function resolveMonitoredGameLabel(state, requiredRootPlaceId) {
  const configuredLabel = typeof state?.targetGame?.name === 'string' && state.targetGame.name.trim()
    ? state.targetGame.name.trim()
    : 'Unknown game';
  return `${configuredLabel} (${requiredRootPlaceId})`;
}

export function buildRobloxMonitorStatsReportComponents({
  guild,
  state,
  subscriberUserIds,
  subscriberStatsBySubscriber,
  subscriberFriendshipStatusBySubscriber,
  presenceBySubscriber,
  monitoringAccountLabel,
  requiredRootPlaceId,
  checkedAt
}) {
  const gameLabel = resolveMonitoredGameLabel(state, requiredRootPlaceId);
  const guildContext = guild?.name ? `${guild.name} (${guild.id})` : String(guild?.id ?? 'Unknown guild');
  const playerLines = subscriberUserIds.length > 0
    ? subscriberUserIds.map((userId) => {
      const stats = normalizeSubscriberAggregateStats(subscriberStatsBySubscriber[userId]);
      const friendship = subscriberFriendshipStatusBySubscriber?.[userId] ?? null;
      const presence = presenceBySubscriber?.[userId] ?? null;
      const robloxName = typeof state?.subscriberRobloxAccounts?.[userId]?.robloxUsername === 'string'
        && state.subscriberRobloxAccounts[userId].robloxUsername.trim()
        ? state.subscriberRobloxAccounts[userId].robloxUsername.trim()
        : userId;
      const presenceLabel = presence?.isInTargetGame === true
        ? '🎮 in-game'
        : (presence?.isOnline === true ? '🟡 online outside the monitored game' : '⚫ offline');
      const baseLine = `• ${robloxName}, 🟢 online: ${formatDurationMinutes(stats.totalOnlineMinutes)}, 🔴 offline: ${formatDurationMinutes(stats.totalOfflineMinutes)}, online %: ${stats.onlinePercentage.toFixed(2)}%, status: ${presenceLabel}`;
      if (friendship?.isFriend === false) {
        const fallbackMonitoringAccountLabel = presenceBySubscriber?.[userId]?.monitoringAccountUserId
          ? String(presenceBySubscriber[userId].monitoringAccountUserId)
          : 'monitoring account';
        const nextMonitoringAccountLabel = typeof monitoringAccountLabel === 'string' && monitoringAccountLabel.trim()
          ? monitoringAccountLabel.trim()
          : fallbackMonitoringAccountLabel;
        return [
          baseLine,
          '  Not friends with the monitoring session account.',
          `  Add: **${nextMonitoringAccountLabel}**.`
        ].join('\n');
      }
      return baseLine;
    }).join('\n')
    : 'No subscribed players are currently configured.';

  return [
    buildV2Container([
      buildV2TextDisplay('📊 **Roblox monitor summary report**'),
      buildV2Separator(),
      buildV2TextDisplay([
        `Guild context: **${guildContext}**`,
        `Monitored game label: **${gameLabel}**`,
        `Report generated at: **${checkedAt}**`,
        '',
        '**Per player summary**',
        playerLines
      ].join('\n'))
    ])
  ];
}

async function postRobloxMonitorStatsReportIfDue(client, guild, state, {
  checkedAt,
  requiredRootPlaceId,
  subscriberUserIds,
  subscriberStatsBySubscriber,
  subscriberFriendshipStatusBySubscriber,
  presenceBySubscriber,
  monitoringAccountLabel
}) {
  const statsReport = state?.statsReport && typeof state.statsReport === 'object' && !Array.isArray(state.statsReport)
    ? state.statsReport
    : {};
  const channelId = typeof statsReport.channelId === 'string' && statsReport.channelId.trim()
    ? statsReport.channelId.trim()
    : null;
  const postIntervalMinutes = getStatsReportPostIntervalMinutes(state);
  const postIntervalMs = postIntervalMinutes * 60 * 1000;
  const isEnabled = Boolean(statsReport.enabled) && Boolean(channelId);
  if (!isEnabled) {
    return;
  }

  const nowMs = new Date(checkedAt).getTime();
  const lastPostedAt = typeof statsReport.lastPostedAt === 'string' ? statsReport.lastPostedAt : null;
  const lastPostedAtMs = lastPostedAt ? new Date(lastPostedAt).getTime() : NaN;
  const isDueToPost = !Number.isFinite(lastPostedAtMs) || (nowMs - lastPostedAtMs) >= postIntervalMs;
  if (!isDueToPost) {
    return;
  }

  const channel = guild.channels.cache.get(channelId) ?? await guild.channels.fetch(channelId).catch(() => null);
  if (!channel || !channel.isTextBased()) {
    return;
  }

  const components = buildRobloxMonitorStatsReportComponents({
    guild,
    state,
    subscriberUserIds,
    subscriberStatsBySubscriber,
    subscriberFriendshipStatusBySubscriber,
    presenceBySubscriber,
    monitoringAccountLabel,
    requiredRootPlaceId,
    checkedAt
  });
  await channel.send(buildV2MessagePayload({
    components,
    allowedMentions: { parse: [], users: [], roles: [], repliedUser: false }
  }));

  await updateRobloxMonitorState(guild.id, (nextState) => {
    if (!nextState.statsReport || typeof nextState.statsReport !== 'object' || Array.isArray(nextState.statsReport)) {
      nextState.statsReport = {};
    }
    nextState.statsReport.channelId = channelId;
    nextState.statsReport.postIntervalMinutes = postIntervalMinutes;
    nextState.statsReport.enabled = true;
    nextState.statsReport.lastPostedAt = checkedAt;
    nextState.statsReport.updatedAt = nextState.statsReport.updatedAt ?? checkedAt;
  });
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

  async request(
    url,
    {
      method = 'GET',
      body = null,
      headers = {},
      retryOnCsrf = true,
      attempt = 0,
      maxRetries = 5,
      retryContext = {}
    } = {}
  ) {
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

    if (response.status === 429) {
      if (attempt >= maxRetries) {
        throw new Error(`Roblox API rate-limit exhaustion after ${attempt + 1} attempts (${method} ${url}).`);
      }

      const retryAfterRaw = response.headers.get('retry-after');
      const retryAfterSeconds = Number.parseFloat(retryAfterRaw);
      const hasRetryAfter = Number.isFinite(retryAfterSeconds) && retryAfterSeconds >= 0;
      const baseDelayMs = 500;
      const maxDelayMs = 10_000;
      const exponentialDelayMs = Math.min(baseDelayMs * (2 ** attempt), maxDelayMs);
      const jitteredDelayMs = Math.floor((exponentialDelayMs / 2) + (Math.random() * (exponentialDelayMs / 2)));
      const retryDelayMs = hasRetryAfter
        ? Math.max(0, Math.floor(retryAfterSeconds * 1000))
        : jitteredDelayMs;

      console.warn('Roblox API rate-limit encountered; retrying request', {
        guildId: retryContext?.guildId ?? null,
        userId: retryContext?.userId ?? null,
        url,
        method,
        status: response.status,
        attempt,
        maxRetries,
        retryAfterHeader: retryAfterRaw,
        retryDelayMs
      });

      await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
      return this.request(url, {
        method,
        body,
        headers,
        retryOnCsrf,
        attempt: attempt + 1,
        maxRetries,
        retryContext
      });
    }

    if (response.status === 403 && retryOnCsrf && csrfToken && method !== 'GET' && method !== 'HEAD') {
      return this.request(url, {
        method,
        body,
        headers,
        retryOnCsrf: false,
        attempt,
        maxRetries,
        retryContext
      });
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

async function getMonitoringFriendsSet(apiClient, monitoringUserId) {
  const friends = new Set();
  let cursor = null;

  do {
    const url = new URL(`https://friends.roblox.com/v1/users/${monitoringUserId}/friends`);
    url.searchParams.set('limit', '100');
    if (cursor) {
      url.searchParams.set('cursor', cursor);
    }

    const payload = await apiClient.request(url.toString());
    const entries = Array.isArray(payload?.data) ? payload.data : [];
    for (const entry of entries) {
      const friendId = Number(entry?.id);
      if (Number.isInteger(friendId) && friendId > 0) {
        friends.add(friendId);
      }
    }

    cursor = typeof payload?.nextPageCursor === 'string' && payload.nextPageCursor
      ? payload.nextPageCursor
      : null;
  } while (cursor);

  return friends;
}

async function isMonitoringAccountFriendsWithTarget(apiClient, monitoringUserId, targetUserId) {
  const friends = await getMonitoringFriendsSet(apiClient, monitoringUserId);
  return friends.has(Number(targetUserId));
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

function collectApprovedTicketUsers(guildId, { clanName = null } = {}) {
  const state = getClanState(guildId);
  const discordUserIds = new Set();
  const robloxUsernames = new Set();
  const discordUserIdToRobloxUsername = {};
  const normalizedClanName = typeof clanName === 'string' && clanName.trim()
    ? clanName.trim().toLowerCase()
    : null;

  for (const identity of collectAcceptedTicketRobloxIdentitiesFromState(state)) {
    if (normalizedClanName) {
      const identityClanName = typeof identity?.entry?.clanName === 'string'
        ? identity.entry.clanName.trim().toLowerCase()
        : null;
      if (!identityClanName || identityClanName !== normalizedClanName) {
        continue;
      }
    }

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

async function sendOfflineReminderToSubscriber(client, guild, subscriberUserId, targetUsername, presenceSnapshot) {
  try {
    const user = await client.users.fetch(subscriberUserId);
    await user.send(
      `Roblox monitor alert for **${guild.name}**: **${targetUsername}** is currently ${describePresenceForReminder(presenceSnapshot)}. `
      + `The bot will remind you again after the configured interval if they are still not in the monitored game.`
    );
  } catch (error) {
    console.warn(`Failed to send Roblox offline reminder to user ${subscriberUserId} in guild ${guild.id}:`, error);
  }
}

async function sendOfflineReminderToMonitorRoom(guild, channelId, subscriberUserId, targetUsername, presenceSnapshot) {
  if (!channelId || typeof channelId !== 'string') {
    return false;
  }

  const channel = guild.channels.cache.get(channelId) ?? await guild.channels.fetch(channelId).catch(() => null);
  if (!channel || !channel.isTextBased()) {
    return false;
  }

  await channel.send(buildV2MessagePayload({
    components: [
      buildV2Container([
        buildV2TextDisplay([
          `🔔 Subscriber ID: ${subscriberUserId}`,
          `Target: **${targetUsername}**`,
          `Status: **${describePresenceForReminder(presenceSnapshot)}**`,
          'Reminder: target is not in the monitored game.'
        ].join('\n'))
      ])
    ],
    allowedMentions: { parse: [], users: [], roles: [], repliedUser: false }
  }));

  return true;
}

function buildPresenceSnapshot({
  previousPresence = null,
  targetUsername,
  targetUserId,
  monitoringAccountUserId,
  isFriend,
  presence,
  requiredRootPlaceId,
  error = null
}) {
  const previousLastOnlineAt = previousPresence?.lastOnlineAt ?? null;
  const isOnline = isPresenceOnline(presence);
  const monitoredRootPlaceId = Number.isInteger(requiredRootPlaceId) ? requiredRootPlaceId : DEFAULT_REQUIRED_ROOT_PLACE_ID;
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

  let state = getRobloxMonitorState(guildId);
  const monitorSource = state?.monitorSource && typeof state.monitorSource === 'object'
    ? state.monitorSource
    : {};
  const approvedUsers = collectApprovedTicketUsers(guildId, {
    clanName: typeof monitorSource?.clan_name === 'string' ? monitorSource.clan_name : null
  });
  const sourceType = monitorSource.source_type === 'guild_nickname' ? 'guild_nickname' : 'target_override';
  const sourceUserId = typeof monitorSource.source_user_id === 'string' && monitorSource.source_user_id.trim()
    ? monitorSource.source_user_id.trim()
    : null;
  const sourceClanName = typeof monitorSource.clan_name === 'string' && monitorSource.clan_name.trim()
    ? monitorSource.clan_name.trim()
    : null;
  const monitorMode = sourceClanName ? 'clan' : 'non_clan';
  const approvedSubscriberUserIdSet = new Set(approvedUsers.discordUserIds);
  const sourceChannelId = typeof monitorSource.channel_id === 'string' && monitorSource.channel_id.trim()
    ? monitorSource.channel_id.trim()
    : null;
  const targetOverride = typeof monitorSource.target_override === 'string' && monitorSource.target_override.trim()
    ? monitorSource.target_override.trim()
    : null;
  const requiredRootPlaceId = getRequiredRootPlaceId(state);
  const explicitSubscriberUserIds = Array.isArray(state?.subscriberUserIds)
    ? state.subscriberUserIds.filter((userId) => typeof userId === 'string' && userId.trim())
    : [];
  const effectiveMonitoredUserIds = sourceClanName
    ? [...new Set(approvedUsers.discordUserIds)].sort()
    : explicitSubscriberUserIds;
  const effectiveMonitoredUserIdSet = new Set(effectiveMonitoredUserIds);

  if (JSON.stringify(state.subscriberUserIds) !== JSON.stringify(effectiveMonitoredUserIds)) {
    state = await updateRobloxMonitorState(guildId, (nextState) => {
      nextState.subscriberUserIds = effectiveMonitoredUserIds;
      if (!nextState.subscriberRobloxAccounts || typeof nextState.subscriberRobloxAccounts !== 'object' || Array.isArray(nextState.subscriberRobloxAccounts)) {
        nextState.subscriberRobloxAccounts = {};
      }
      if (!nextState.subscriberFriendshipStatus || typeof nextState.subscriberFriendshipStatus !== 'object' || Array.isArray(nextState.subscriberFriendshipStatus)) {
        nextState.subscriberFriendshipStatus = {};
      }
      if (!nextState.subscriberPresence || typeof nextState.subscriberPresence !== 'object' || Array.isArray(nextState.subscriberPresence)) {
        nextState.subscriberPresence = {};
      }
      if (!nextState.subscriberOfflineReminderAt || typeof nextState.subscriberOfflineReminderAt !== 'object' || Array.isArray(nextState.subscriberOfflineReminderAt)) {
        nextState.subscriberOfflineReminderAt = {};
      }
      if (!nextState.subscriberStats || typeof nextState.subscriberStats !== 'object' || Array.isArray(nextState.subscriberStats)) {
        nextState.subscriberStats = {};
      }
      for (const userId of Object.keys(nextState.subscriberRobloxAccounts)) {
        const subscriberAccount = nextState.subscriberRobloxAccounts[userId] ?? null;
        const shouldRetainRecord = shouldRetainSubscriberRecord(
          userId,
          subscriberAccount,
          monitorMode,
          approvedSubscriberUserIdSet
        );
        if (!effectiveMonitoredUserIdSet.has(userId) && !shouldRetainRecord) {
          delete nextState.subscriberRobloxAccounts[userId];
        }
      }
      for (const userId of Object.keys(nextState.subscriberFriendshipStatus)) {
        const subscriberAccount = nextState.subscriberRobloxAccounts[userId] ?? null;
        const shouldRetainRecord = shouldRetainSubscriberRecord(
          userId,
          subscriberAccount,
          monitorMode,
          approvedSubscriberUserIdSet
        );
        if (!effectiveMonitoredUserIdSet.has(userId) && !shouldRetainRecord) {
          delete nextState.subscriberFriendshipStatus[userId];
        }
      }
      for (const userId of Object.keys(nextState.subscriberPresence)) {
        const subscriberAccount = nextState.subscriberRobloxAccounts[userId] ?? null;
        const shouldRetainRecord = shouldRetainSubscriberRecord(
          userId,
          subscriberAccount,
          monitorMode,
          approvedSubscriberUserIdSet
        );
        if (!effectiveMonitoredUserIdSet.has(userId) && !shouldRetainRecord) {
          delete nextState.subscriberPresence[userId];
        }
      }
      for (const userId of Object.keys(nextState.subscriberOfflineReminderAt)) {
        const subscriberAccount = nextState.subscriberRobloxAccounts[userId] ?? null;
        const shouldRetainRecord = shouldRetainSubscriberRecord(
          userId,
          subscriberAccount,
          monitorMode,
          approvedSubscriberUserIdSet
        );
        if (!effectiveMonitoredUserIdSet.has(userId) && !shouldRetainRecord) {
          delete nextState.subscriberOfflineReminderAt[userId];
        }
      }
      for (const userId of Object.keys(nextState.subscriberStats)) {
        const subscriberAccount = nextState.subscriberRobloxAccounts[userId] ?? null;
        const shouldRetainRecord = shouldRetainSubscriberRecord(
          userId,
          subscriberAccount,
          monitorMode,
          approvedSubscriberUserIdSet
        );
        if (!effectiveMonitoredUserIdSet.has(userId) && !shouldRetainRecord) {
          delete nextState.subscriberStats[userId];
        } else {
          nextState.subscriberStats[userId] = normalizeSubscriberAggregateStats(nextState.subscriberStats[userId]);
        }
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
      nextState.requiredRootPlaceId = getRequiredRootPlaceId(nextState);
      if (!nextState.subscriberFriendshipStatus || typeof nextState.subscriberFriendshipStatus !== 'object' || Array.isArray(nextState.subscriberFriendshipStatus)) {
        nextState.subscriberFriendshipStatus = {};
      }
      if (!nextState.subscriberPresence || typeof nextState.subscriberPresence !== 'object' || Array.isArray(nextState.subscriberPresence)) {
        nextState.subscriberPresence = {};
      }
      if (!nextState.subscriberStats || typeof nextState.subscriberStats !== 'object' || Array.isArray(nextState.subscriberStats)) {
        nextState.subscriberStats = {};
      }
      for (const subscriberUserId of effectiveMonitoredUserIds) {
        const previous = nextState.subscriberFriendshipStatus[subscriberUserId];
        nextState.subscriberFriendshipStatus[subscriberUserId] = {
          robloxUserId: Number.isInteger(previous?.robloxUserId) ? previous.robloxUserId : null,
          isFriend: false,
          lastCheckedAt: checkedAt,
          lastAutoAcceptedAt: previous?.lastAutoAcceptedAt ?? null,
          note: 'Periodic check skipped: monitoring session cookie is missing.'
        };
        nextState.subscriberPresence[subscriberUserId] = buildPresenceSnapshot({
          previousPresence: nextState.subscriberPresence[subscriberUserId] ?? null,
          targetUsername: null,
          targetUserId: null,
          monitoringAccountUserId: null,
          isFriend: null,
          presence: null,
          requiredRootPlaceId: getRequiredRootPlaceId(nextState),
          error: 'Roblox monitor skipped because no .ROBLOSECURITY cookie is configured.'
        });
        nextState.subscriberStats[subscriberUserId] = normalizeSubscriberAggregateStats(nextState.subscriberStats[subscriberUserId]);
      }
      nextState.lastKnownPresence = effectiveMonitoredUserIds.length > 0
        ? (nextState.subscriberPresence[effectiveMonitoredUserIds[0]] ?? null)
        : null;
    });
    return;
  }

  const apiClient = new RobloxSessionClient(sessionCookie);
  try {
    const monitoringUser = await getAuthenticatedRobloxUser(apiClient);
    const monitoringFriendsSet = await getMonitoringFriendsSet(apiClient, monitoringUser.id);
    const monitoringAccountRuntime = {
      monitoringAccountLabel: [
        typeof monitoringUser?.name === 'string' && monitoringUser.name.trim()
          ? monitoringUser.name.trim()
          : (typeof monitoringUser?.username === 'string' && monitoringUser.username.trim()
            ? monitoringUser.username.trim()
            : null),
        Number.isInteger(Number(monitoringUser?.id)) ? `(${Number(monitoringUser.id)})` : null
      ].filter(Boolean).join(' '),
      monitoringAccountUserId: Number.isInteger(Number(monitoringUser?.id)) ? Number(monitoringUser.id) : null
    };

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
    const friendshipStatusBySubscriber = state?.subscriberFriendshipStatus
      && typeof state.subscriberFriendshipStatus === 'object'
      && !Array.isArray(state.subscriberFriendshipStatus)
      ? { ...state.subscriberFriendshipStatus }
      : {};
    const presenceBySubscriber = state?.subscriberPresence
      && typeof state.subscriberPresence === 'object'
      && !Array.isArray(state.subscriberPresence)
      ? { ...state.subscriberPresence }
      : {};
    const reminderTimestampBySubscriber = state?.subscriberOfflineReminderAt && typeof state.subscriberOfflineReminderAt === 'object' && !Array.isArray(state.subscriberOfflineReminderAt)
      ? { ...state.subscriberOfflineReminderAt }
      : {};
    const subscriberAccountMap = state?.subscriberRobloxAccounts && typeof state.subscriberRobloxAccounts === 'object' && !Array.isArray(state.subscriberRobloxAccounts)
      ? state.subscriberRobloxAccounts
      : {};
    const previousPresenceBySubscriber = state?.subscriberPresence && typeof state.subscriberPresence === 'object' && !Array.isArray(state.subscriberPresence)
      ? state.subscriberPresence
      : {};
    const previousSubscriberStats = state?.subscriberStats && typeof state.subscriberStats === 'object' && !Array.isArray(state.subscriberStats)
      ? state.subscriberStats
      : {};
    const subscriberStatsBySubscriber = {};
    for (const userId of Object.keys(previousSubscriberStats)) {
      subscriberStatsBySubscriber[userId] = normalizeSubscriberAggregateStats(previousSubscriberStats[userId]);
    }
    for (const userId of Object.keys(subscriberAccountMap)) {
      if (!subscriberStatsBySubscriber[userId]) {
        subscriberStatsBySubscriber[userId] = normalizeSubscriberAggregateStats(null);
      }
    }
    for (const subscriberUserId of effectiveMonitoredUserIds) {
      subscriberStatsBySubscriber[subscriberUserId] = normalizeSubscriberAggregateStats(subscriberStatsBySubscriber[subscriberUserId]);
    }

    if (monitorMode === 'clan') {
      for (const subscriberUserId of effectiveMonitoredUserIds) {
        const existingAccount = subscriberAccountMap[subscriberUserId] ?? null;
        const hasValidStoredUsername = typeof existingAccount?.robloxUsername === 'string'
          && Boolean(existingAccount.robloxUsername.trim());
        if (hasValidStoredUsername) {
          continue;
        }
        const ticketRobloxNickname = approvedUsers.discordUserIdToRobloxUsername?.[subscriberUserId];
        if (typeof ticketRobloxNickname !== 'string' || !ticketRobloxNickname.trim()) {
          continue;
        }
        subscriberAccountMap[subscriberUserId] = {
          robloxUsername: ticketRobloxNickname.trim(),
          robloxUserId: null,
          source: ROBLOX_SUBSCRIBER_ACCOUNT_SOURCE.CLAN_AUTO,
          optedInAt: existingAccount?.optedInAt ?? checkedAt
        };
      }
    }

    const resolvedUsernameCache = new Map();
    const usernameResolutionCache = state?.usernameResolutionCache
      && typeof state.usernameResolutionCache === 'object'
      && !Array.isArray(state.usernameResolutionCache)
      ? { ...state.usernameResolutionCache }
      : {};

    for (const subscriberUserId of effectiveMonitoredUserIds) {
      const subscriberAccount = subscriberAccountMap[subscriberUserId] ?? null;
      const storedSubscriberUsername = typeof subscriberAccount?.robloxUsername === 'string' && subscriberAccount.robloxUsername.trim()
        ? subscriberAccount.robloxUsername.trim()
        : (typeof subscriberAccount?.username === 'string' && subscriberAccount.username.trim()
          ? subscriberAccount.username.trim()
          : null);
      let preferredUsername = null;
      let resolutionSource = sourceType;
      if (!storedSubscriberUsername) {
        friendshipStatusBySubscriber[subscriberUserId] = {
          robloxUserId: null,
          isFriend: false,
          lastCheckedAt: checkedAt,
          lastAutoAcceptedAt: null,
          note: 'Periodic check skipped: subscriber has no stored Roblox account (manual opt-in or clan_auto from ticket nickname required).'
        };
        presenceBySubscriber[subscriberUserId] = buildPresenceSnapshot({
          previousPresence: previousPresenceBySubscriber[subscriberUserId] ?? null,
          targetUsername: null,
          targetUserId: null,
          monitoringAccountUserId: Number(monitoringUser.id),
          isFriend: null,
          presence: null,
          requiredRootPlaceId,
          error: 'Subscriber skipped: no stored Roblox account.'
        });
        continue;
      }

      if (sourceType === 'guild_nickname') {
        const member = await guild.members.fetch(subscriberUserId).catch(() => null);
        preferredUsername = normalizeGuildNicknameAsRobloxCandidate(member?.nickname)
          ?? normalizeGuildNicknameAsRobloxCandidate(member?.displayName)
          ?? storedSubscriberUsername;
      } else {
        preferredUsername = storedSubscriberUsername;
        resolutionSource = subscriberAccount?.source ?? 'target_override';
      }

      try {
        if (!preferredUsername) {
          throw new Error('No Roblox username could be resolved for this subscriber.');
        }
        const cacheKey = normalizeUsername(preferredUsername);
        let targetResolution = null;
        const nowMs = Date.now();
        if (subscriberAccount?.robloxUserId && normalizeUsername(subscriberAccount?.robloxUsername ?? subscriberAccount?.username) === cacheKey) {
          targetResolution = { userId: subscriberAccount.robloxUserId, username: preferredUsername };
        } else if (resolvedUsernameCache.has(cacheKey)) {
          targetResolution = resolvedUsernameCache.get(cacheKey);
        } else {
          const cachedResolution = getCachedUsernameResolution(usernameResolutionCache, preferredUsername, nowMs);
          if (cachedResolution) {
            targetResolution = { userId: cachedResolution.userId, username: cachedResolution.username };
            resolvedUsernameCache.set(cacheKey, targetResolution);
          }
        }

        if (!targetResolution) {
          targetResolution = await resolveRobloxUserIdByUsername(apiClient, preferredUsername);
          resolvedUsernameCache.set(cacheKey, targetResolution);
          upsertUsernameResolutionCacheEntry(usernameResolutionCache, {
            normalizedUsername: cacheKey,
            userId: Number(targetResolution.userId),
            username: targetResolution.username ?? preferredUsername
          });
        }

        const targetUserId = Number(targetResolution.userId);
        const targetUsername = targetResolution.username ?? preferredUsername;
        console.info('Roblox monitor subscriber target resolved', {
          guild_id: guildId,
          subscriber_user_id: subscriberUserId,
          game_id: requiredRootPlaceId,
          resolution_source: resolutionSource,
          target_username: targetUsername,
          target_user_id: targetUserId
        });
        const presence = await getRobloxPresence(apiClient, targetUserId);
        const isFriend = monitoringFriendsSet.has(targetUserId);
        const nextPresence = buildPresenceSnapshot({
          previousPresence: previousPresenceBySubscriber[subscriberUserId] ?? null,
          targetUsername,
          targetUserId,
          monitoringAccountUserId: Number(monitoringUser.id),
          isFriend,
          presence,
          requiredRootPlaceId
        });

        const sampleMinutes = getIntervalMinutes(state);
        subscriberStatsBySubscriber[subscriberUserId] = buildUpdatedSubscriberAggregateStats(
          subscriberStatsBySubscriber[subscriberUserId],
          { isOnline: nextPresence.isOnline, sampleMinutes }
        );
        const reminderIntervalMs = getOfflineReminderMinutes(state) * 60 * 1000;
        const lastReminderIso = typeof reminderTimestampBySubscriber[subscriberUserId] === 'string'
          ? reminderTimestampBySubscriber[subscriberUserId]
          : null;
        const lastReminderMs = lastReminderIso ? new Date(lastReminderIso).getTime() : 0;
        const shouldSendOfflineReminder = !nextPresence.isInTargetGame
          && (!lastReminderMs || Number.isNaN(lastReminderMs) || (nowMs - lastReminderMs) >= reminderIntervalMs);
        if (shouldSendOfflineReminder) {
          const isOptedIn = isExplicitDmOptInSubscriberSource(subscriberAccount?.source);
          const sentToRoom = await sendOfflineReminderToMonitorRoom(
            guild,
            sourceChannelId,
            subscriberUserId,
            targetUsername,
            nextPresence
          );
          if (!sentToRoom && isOptedIn) {
            await sendOfflineReminderToSubscriber(client, guild, subscriberUserId, targetUsername, nextPresence);
          }
          reminderTimestampBySubscriber[subscriberUserId] = new Date().toISOString();
        } else if (nextPresence.isInTargetGame && reminderTimestampBySubscriber[subscriberUserId]) {
          delete reminderTimestampBySubscriber[subscriberUserId];
        }

        friendshipStatusBySubscriber[subscriberUserId] = {
          robloxUserId: targetUserId,
          isFriend,
          lastCheckedAt: checkedAt,
          lastAutoAcceptedAt: acceptedRequesterIds.has(targetUserId) ? checkedAt : null,
          note: isFriend
            ? 'Friendship verified during periodic monitor tick.'
            : 'Periodic check result: Account is not in friends with the monitoring session account.'
        };
        presenceBySubscriber[subscriberUserId] = nextPresence;
        subscriberAccountMap[subscriberUserId] = {
          robloxUsername: targetUsername,
          robloxUserId: targetUserId,
          source: resolveSubscriberAccountSourceForTick({
            existingSource: subscriberAccount?.source,
            sourceClanName
          }),
          optedInAt: subscriberAccount?.optedInAt ?? checkedAt
        };
      } catch (error) {
        try {
          if (
            monitorMode === 'clan'
            && isRobloxUsernameNotFoundError(error)
            && (
              subscriberAccount?.source === ROBLOX_SUBSCRIBER_ACCOUNT_SOURCE.CLAN_AUTO
              || subscriberAccount?.source === ROBLOX_SUBSCRIBER_ACCOUNT_SOURCE.LEGACY_TICKET_ACCOUNT
              || subscriberAccount?.source === 'target_override'
            )
          ) {
            delete subscriberAccountMap[subscriberUserId];
            delete friendshipStatusBySubscriber[subscriberUserId];
            delete presenceBySubscriber[subscriberUserId];
            delete reminderTimestampBySubscriber[subscriberUserId];
            delete subscriberStatsBySubscriber[subscriberUserId];
            console.info('Removed Roblox monitor subscriber due to unresolved ticket nickname in clan mode', {
              guild_id: guildId,
              subscriber_user_id: subscriberUserId,
              preferred_username: preferredUsername
            });
            continue;
          }

          friendshipStatusBySubscriber[subscriberUserId] = {
            robloxUserId: Number.isInteger(subscriberAccount?.robloxUserId) ? subscriberAccount.robloxUserId : null,
            isFriend: false,
            lastCheckedAt: checkedAt,
            lastAutoAcceptedAt: null,
            note: `Periodic check failed: ${error?.message ?? error}`
          };
          presenceBySubscriber[subscriberUserId] = buildPresenceSnapshot({
            previousPresence: previousPresenceBySubscriber[subscriberUserId] ?? null,
            targetUsername: preferredUsername,
            targetUserId: subscriberAccount?.robloxUserId ?? null,
            monitoringAccountUserId: Number(monitoringUser.id),
            isFriend: null,
            presence: null,
            requiredRootPlaceId,
            error: error?.message ?? error
          });
        } catch (nestedError) {
          console.warn(`Failed to capture Roblox monitor subscriber error state for ${subscriberUserId}:`, nestedError);
        }
      }
    }

    const shouldKeepUserRecord = (userId) => shouldRetainSubscriberRecord(
      userId,
      subscriberAccountMap[userId] ?? null,
      monitorMode,
      approvedSubscriberUserIdSet
    );

    for (const userId of Object.keys(subscriberAccountMap)) {
      if (!effectiveMonitoredUserIdSet.has(userId) && !shouldKeepUserRecord(userId)) {
        delete subscriberAccountMap[userId];
      }
    }
    for (const userId of Object.keys(friendshipStatusBySubscriber)) {
      if (!effectiveMonitoredUserIdSet.has(userId) && !shouldKeepUserRecord(userId)) {
        delete friendshipStatusBySubscriber[userId];
      }
    }
    for (const userId of Object.keys(presenceBySubscriber)) {
      if (!effectiveMonitoredUserIdSet.has(userId) && !shouldKeepUserRecord(userId)) {
        delete presenceBySubscriber[userId];
      }
    }
    for (const userId of Object.keys(reminderTimestampBySubscriber)) {
      if (!effectiveMonitoredUserIdSet.has(userId) && !shouldKeepUserRecord(userId)) {
        delete reminderTimestampBySubscriber[userId];
      }
    }
    for (const userId of Object.keys(subscriberStatsBySubscriber)) {
      if (!effectiveMonitoredUserIdSet.has(userId) && !shouldKeepUserRecord(userId)) {
        delete subscriberStatsBySubscriber[userId];
      } else {
        subscriberStatsBySubscriber[userId] = normalizeSubscriberAggregateStats(subscriberStatsBySubscriber[userId]);
      }
    }

    await updateRobloxMonitorState(guildId, (nextState) => {
      nextState.targetUsername = null;
      nextState.targetUserId = null;
      nextState.requiredRootPlaceId = requiredRootPlaceId;
      if (!nextState.monitorSource || typeof nextState.monitorSource !== 'object' || Array.isArray(nextState.monitorSource)) {
        nextState.monitorSource = {};
      }
      nextState.monitorSource.guild_id = guildId;
      nextState.monitorSource.channel_id = nextState.monitorSource.channel_id ?? null;
      nextState.monitorSource.game_id = requiredRootPlaceId;
      nextState.monitorSource.source_type = sourceType;
      nextState.monitorSource.target_override = sourceType === 'guild_nickname' ? null : targetOverride;
      nextState.monitorSource.source_user_id = sourceUserId;
      nextState.monitorSource.clan_name = sourceClanName;
      nextState.monitorSource.updated_at = new Date().toISOString();
      nextState.subscriberUserIds = effectiveMonitoredUserIds;
      nextState.subscriberRobloxAccounts = subscriberAccountMap;
      nextState.usernameResolutionCache = pruneUsernameResolutionCache(usernameResolutionCache);
      nextState.subscriberFriendshipStatus = friendshipStatusBySubscriber;
      nextState.subscriberPresence = presenceBySubscriber;
      nextState.subscriberStats = subscriberStatsBySubscriber;
      nextState.lastKnownPresence = effectiveMonitoredUserIds.length > 0
        ? (presenceBySubscriber[effectiveMonitoredUserIds[0]] ?? null)
        : null;
      nextState.lastFriendRequestSweepAt = new Date().toISOString();
      nextState.subscriberOfflineReminderAt = reminderTimestampBySubscriber;
      const latestReminder = Object.values(reminderTimestampBySubscriber)
        .filter((timestamp) => typeof timestamp === 'string')
        .sort()
        .at(-1) ?? null;
      nextState.lastOfflineReminderAt = latestReminder;
    });

    if (acceptedCount > 0) {
      console.log(`Accepted ${acceptedCount} Roblox friend request(s) for guild ${guildId}.`);
    }

    const refreshedState = getRobloxMonitorState(guildId);
    await postRobloxMonitorStatsReportIfDue(client, guild, refreshedState, {
      checkedAt: new Date().toISOString(),
      requiredRootPlaceId,
      subscriberUserIds: effectiveMonitoredUserIds,
      subscriberStatsBySubscriber,
      subscriberFriendshipStatusBySubscriber: friendshipStatusBySubscriber,
      presenceBySubscriber,
      monitoringAccountLabel: monitoringAccountRuntime.monitoringAccountLabel
    });
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
      nextState.requiredRootPlaceId = getRequiredRootPlaceId(nextState);
      if (!nextState.subscriberFriendshipStatus || typeof nextState.subscriberFriendshipStatus !== 'object' || Array.isArray(nextState.subscriberFriendshipStatus)) {
        nextState.subscriberFriendshipStatus = {};
      }
      if (!nextState.subscriberPresence || typeof nextState.subscriberPresence !== 'object' || Array.isArray(nextState.subscriberPresence)) {
        nextState.subscriberPresence = {};
      }
      if (!nextState.subscriberStats || typeof nextState.subscriberStats !== 'object' || Array.isArray(nextState.subscriberStats)) {
        nextState.subscriberStats = {};
      }
      for (const subscriberUserId of effectiveMonitoredUserIds) {
        const previous = nextState.subscriberFriendshipStatus[subscriberUserId];
        nextState.subscriberFriendshipStatus[subscriberUserId] = {
          robloxUserId: Number.isInteger(previous?.robloxUserId) ? previous.robloxUserId : null,
          isFriend: typeof previous?.isFriend === 'boolean' ? previous.isFriend : false,
          lastCheckedAt: checkedAt,
          lastAutoAcceptedAt: previous?.lastAutoAcceptedAt ?? null,
          note: `Periodic check failed: ${error?.message ?? error}`
        };
        nextState.subscriberPresence[subscriberUserId] = buildPresenceSnapshot({
          previousPresence: nextState.subscriberPresence[subscriberUserId] ?? null,
          targetUsername: nextState.subscriberPresence[subscriberUserId]?.targetUsername ?? null,
          targetUserId: nextState.subscriberPresence[subscriberUserId]?.targetUserId ?? null,
          monitoringAccountUserId: nextState.subscriberPresence[subscriberUserId]?.monitoringAccountUserId ?? null,
          isFriend: nextState.subscriberPresence[subscriberUserId]?.isFriend ?? null,
          presence: nextState.subscriberPresence[subscriberUserId],
          requiredRootPlaceId: getRequiredRootPlaceId(nextState),
          error: error?.message ?? error
        });
        nextState.subscriberStats[subscriberUserId] = normalizeSubscriberAggregateStats(nextState.subscriberStats[subscriberUserId]);
      }
      nextState.lastKnownPresence = effectiveMonitoredUserIds.length > 0
        ? (nextState.subscriberPresence[effectiveMonitoredUserIds[0]] ?? null)
        : null;
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

export const robloxMonitorInternals = {
  RobloxSessionClient,
  resolveRobloxUserIdByUsername,
  getAuthenticatedRobloxUser,
  getRobloxPresence,
  getMonitoringFriendsSet,
  isMonitoringAccountFriendsWithTarget,
  listPendingInboundFriendRequests,
  acceptFriendRequest,
  collectApprovedTicketUsers,
  buildPresenceSnapshot,
  isPresenceInTargetGame,
  runRobloxMonitorTick,
  ROBLOX_API_ORIGIN
};

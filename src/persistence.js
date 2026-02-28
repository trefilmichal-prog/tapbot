import fs from 'node:fs';
import path from 'node:path';

const rootDir = path.resolve(process.cwd());
const dataDir = path.join(rootDir, 'data');
const legacyWelcomeConfigPath = path.join(dataDir, 'welcome-config.json');
const legacyClanStatePath = path.join(dataDir, 'clan_state.json');
const guildsDir = path.join(dataDir, 'guilds');

const cachedWelcomeConfig = new Map();
const cachedLogConfig = new Map();
const cachedCommandsConfig = new Map();
const cachedClanState = new Map();
const clanStateWriteQueues = new Map();
const cachedRpsState = new Map();
const rpsStateWriteQueues = new Map();
const cachedPingRoleState = new Map();
const pingRoleStateWriteQueues = new Map();
const cachedPingRolePanelConfig = new Map();
const cachedNotificationForwardConfig = new Map();
const notificationForwardWriteQueues = new Map();
const cachedPrivateMessageState = new Map();
const privateMessageStateWriteQueues = new Map();
let legacyMigrationDone = false;

function getDefaultClanState() {
  return {
    schemaVersion: 1,
    clan_application_panels: {},
    clan_panel_configs: {},
    clan_clans: {},
    clan_applications: {},
    clan_ticket_decisions: {},
    officer_stats: {},
    clan_ticket_vacations: {},
    clan_ticket_reminders: {},
    permission_role_id: null,
    cooldowns: {},
    cooldowns_user: {},
    cooldowns_role: {}
  };
}

function getDefaultRpsState() {
  return {
    schemaVersion: 1,
    active_games: {},
    scores: {},
    last_message: null
  };
}

function getDefaultPingRoleState() {
  return {
    schemaVersion: 1,
    available_roles: [],
    user_selections: {},
    channel_routes: {}
  };
}

function getDefaultPrivateMessageState() {
  return {
    schemaVersion: 1,
    messages: {}
  };
}

async function atomicWriteJson(targetPath, data) {
  await fs.promises.mkdir(path.dirname(targetPath), { recursive: true });
  const tempName = `${path.basename(targetPath)}.${process.pid}.${Date.now()}.tmp`;
  const tempPath = path.join(path.dirname(targetPath), tempName);
  await fs.promises.writeFile(tempPath, JSON.stringify(data, null, 2), 'utf8');
  await fs.promises.rename(tempPath, targetPath);
}

function atomicWriteJsonSync(targetPath, data) {
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  const tempName = `${path.basename(targetPath)}.${process.pid}.${Date.now()}.tmp`;
  const tempPath = path.join(path.dirname(targetPath), tempName);
  fs.writeFileSync(tempPath, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tempPath, targetPath);
}

function getGuildDir(guildId) {
  return path.join(guildsDir, String(guildId));
}

function getGuildWelcomeConfigPath(guildId) {
  return path.join(getGuildDir(guildId), 'welcome-config.json');
}

function getGuildLogConfigPath(guildId) {
  return path.join(getGuildDir(guildId), 'log-config.json');
}

function getGuildClanStatePath(guildId) {
  return path.join(getGuildDir(guildId), 'clan_state.json');
}

function getGuildCommandsConfigPath(guildId) {
  return path.join(getGuildDir(guildId), 'commands-config.json');
}

function getGuildRpsStatePath(guildId) {
  return path.join(getGuildDir(guildId), 'rps_state.json');
}

function getGuildPingRoleStatePath(guildId) {
  return path.join(getGuildDir(guildId), 'ping_roles.json');
}

function getGuildPingRolePanelConfigPath(guildId) {
  return path.join(getGuildDir(guildId), 'ping_roles_panel.json');
}

function getGuildNotificationForwardConfigPath(guildId) {
  const guildKey = normalizeGuildIdForScopedData(guildId);
  const guildDir = getGuildDir(guildKey);
  const configPath = path.join(guildDir, 'notification-forward.json');
  const normalizedGuildDir = path.resolve(guildDir);
  const normalizedPath = path.resolve(configPath);
  const scopedPrefix = `${normalizedGuildDir}${path.sep}`;
  if (normalizedPath !== normalizedGuildDir && !normalizedPath.startsWith(scopedPrefix)) {
    throw new Error(`Notification forward path escaped guild scope for guild ${guildKey}.`);
  }
  return configPath;
}

function normalizeGuildIdForScopedData(guildId) {
  const key = String(guildId ?? '').trim();
  if (!/^\d{5,30}$/.test(key)) {
    throw new Error(`Invalid guild id for notification forward data: ${guildId}`);
  }
  return key;
}

function getGuildPrivateMessageStatePath(guildId) {
  return path.join(getGuildDir(guildId), 'private-messages.json');
}

function enqueueClanStateWrite(guildId, task) {
  const key = String(guildId);
  const queue = clanStateWriteQueues.get(key) ?? Promise.resolve();
  const nextQueue = queue.then(task, task);
  clanStateWriteQueues.set(key, nextQueue);
  return nextQueue;
}

function enqueueRpsStateWrite(guildId, task) {
  const key = String(guildId);
  const queue = rpsStateWriteQueues.get(key) ?? Promise.resolve();
  const nextQueue = queue.then(task, task);
  rpsStateWriteQueues.set(key, nextQueue);
  return nextQueue;
}

function enqueuePingRoleStateWrite(guildId, task) {
  const key = String(guildId);
  const queue = pingRoleStateWriteQueues.get(key) ?? Promise.resolve();
  const nextQueue = queue.then(task, task);
  pingRoleStateWriteQueues.set(key, nextQueue);
  return nextQueue;
}

function enqueuePrivateMessageStateWrite(guildId, task) {
  const key = String(guildId);
  const queue = privateMessageStateWriteQueues.get(key) ?? Promise.resolve();
  const nextQueue = queue.then(task, task);
  privateMessageStateWriteQueues.set(key, nextQueue);
  return nextQueue;
}

function enqueueNotificationForwardWrite(guildId, task) {
  const key = String(guildId);
  const queue = notificationForwardWriteQueues.get(key) ?? Promise.resolve();
  const nextQueue = queue.then(task, task);
  notificationForwardWriteQueues.set(key, nextQueue);
  return nextQueue;
}

function getDefaultNotificationForwardConfig() {
  return {
    enabled: false,
    channelId: null,
    mode: 'poll',
    lastBridgeStatus: null,
    lastDeliveredNotificationSignature: null
  };
}

function normalizeNotificationForwardMode(mode) {
  return mode === 'daemon_push' || mode === 'poll' ? mode : 'poll';
}

function normalizeNotificationForwardConfig(config) {
  const fallback = getDefaultNotificationForwardConfig();
  const parsed = config && typeof config === 'object' ? config : {};
  return {
    enabled: Boolean(parsed.enabled),
    channelId: parsed.channelId ?? null,
    mode: normalizeNotificationForwardMode(parsed.mode),
    lastBridgeStatus: parsed.lastBridgeStatus && typeof parsed.lastBridgeStatus === 'object'
      ? {
          connected: Boolean(parsed.lastBridgeStatus.connected),
          updatedAt: typeof parsed.lastBridgeStatus.updatedAt === 'string' ? parsed.lastBridgeStatus.updatedAt : null,
          reason: typeof parsed.lastBridgeStatus.reason === 'string' ? parsed.lastBridgeStatus.reason : null
        }
      : fallback.lastBridgeStatus,
    lastDeliveredNotificationSignature: typeof parsed.lastDeliveredNotificationSignature === 'string'
      ? parsed.lastDeliveredNotificationSignature
      : fallback.lastDeliveredNotificationSignature
  };
}

function migrateLegacyWelcomeConfig() {
  if (!fs.existsSync(legacyWelcomeConfigPath)) return;
  let parsed;
  try {
    const raw = fs.readFileSync(legacyWelcomeConfigPath, 'utf8');
    parsed = JSON.parse(raw);
  } catch (e) {
    console.warn('Invalid legacy welcome-config.json, skipping migration:', e);
    return;
  }
  if (!parsed || typeof parsed !== 'object') return;
  for (const [guildId, config] of Object.entries(parsed)) {
    if (!guildId) continue;
    const targetPath = getGuildWelcomeConfigPath(guildId);
    if (fs.existsSync(targetPath)) continue;
    const payload = {
      channelId: config?.channelId ?? null,
      message: config?.message ?? null
    };
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    fs.writeFileSync(targetPath, JSON.stringify(payload, null, 2), 'utf8');
  }
  const migratedPath = path.join(dataDir, 'welcome-config.legacy.json');
  try {
    fs.renameSync(legacyWelcomeConfigPath, migratedPath);
  } catch (e) {
    console.warn('Failed to archive legacy welcome-config.json:', e);
  }
}

function migrateLegacyClanState() {
  if (!fs.existsSync(legacyClanStatePath)) return;
  let parsed;
  try {
    const raw = fs.readFileSync(legacyClanStatePath, 'utf8');
    parsed = JSON.parse(raw);
  } catch (e) {
    console.warn('Invalid legacy clan_state.json, skipping migration:', e);
    return;
  }
  if (!parsed || typeof parsed !== 'object') return;

  const guildIds = new Set();
  const legacyMaps = [
    'clan_application_panels',
    'clan_panel_configs',
    'clan_clans',
    'clan_applications',
    'clan_ticket_decisions',
    'officer_stats',
    'clan_ticket_vacations',
    'clan_ticket_reminders',
    'permission_roles',
    'cooldowns',
    'cooldowns_user',
    'cooldowns_role'
  ];

  for (const key of legacyMaps) {
    const bucket = parsed[key];
    if (!bucket || typeof bucket !== 'object') continue;
    for (const guildId of Object.keys(bucket)) {
      guildIds.add(guildId);
    }
  }

  for (const guildId of guildIds) {
    const targetPath = getGuildClanStatePath(guildId);
    if (fs.existsSync(targetPath)) continue;
    const nextState = getDefaultClanState();
    nextState.clan_application_panels = parsed.clan_application_panels?.[guildId] ?? {};
    nextState.clan_panel_configs = parsed.clan_panel_configs?.[guildId] ?? {};
    nextState.clan_clans = parsed.clan_clans?.[guildId] ?? {};
    nextState.clan_applications = parsed.clan_applications?.[guildId] ?? {};
    nextState.clan_ticket_decisions = parsed.clan_ticket_decisions?.[guildId] ?? {};
    nextState.officer_stats = parsed.officer_stats?.[guildId] ?? {};
    nextState.clan_ticket_vacations = parsed.clan_ticket_vacations?.[guildId] ?? {};
    nextState.clan_ticket_reminders = parsed.clan_ticket_reminders?.[guildId] ?? {};
    nextState.permission_role_id = parsed.permission_roles?.[guildId] ?? null;
    nextState.cooldowns = parsed.cooldowns?.[guildId] ?? {};
    nextState.cooldowns_user = parsed.cooldowns_user?.[guildId] ?? {};
    nextState.cooldowns_role = parsed.cooldowns_role?.[guildId] ?? {};

    migrateClanState(nextState);
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    fs.writeFileSync(targetPath, JSON.stringify(nextState, null, 2), 'utf8');
  }

  const migratedPath = path.join(dataDir, 'clan_state.legacy.json');
  try {
    fs.renameSync(legacyClanStatePath, migratedPath);
  } catch (e) {
    console.warn('Failed to archive legacy clan_state.json:', e);
  }
}

function ensureLegacyMigration() {
  if (legacyMigrationDone) return;
  legacyMigrationDone = true;
  migrateLegacyWelcomeConfig();
  migrateLegacyClanState();
}

function loadWelcomeConfig(guildId) {
  ensureLegacyMigration();
  const key = String(guildId);
  if (cachedWelcomeConfig.has(key)) return cachedWelcomeConfig.get(key);

  const configPath = getGuildWelcomeConfigPath(key);
  if (!fs.existsSync(configPath)) {
    cachedWelcomeConfig.set(key, null);
    return null;
  }

  const raw = fs.readFileSync(configPath, 'utf8');
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    console.warn(`Invalid welcome-config.json for guild ${key}, resetting:`, e);
    cachedWelcomeConfig.set(key, null);
    return null;
  }

  const entry = parsed && typeof parsed === 'object'
    ? {
        channelId: parsed.channelId ?? null,
        message: parsed.message ?? null
      }
    : null;
  cachedWelcomeConfig.set(key, entry);
  return entry;
}

function persistWelcomeConfig(guildId, config) {
  const configPath = getGuildWelcomeConfigPath(guildId);
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf8');
}

function loadLogConfig(guildId) {
  const key = String(guildId);
  if (cachedLogConfig.has(key)) return cachedLogConfig.get(key);

  const configPath = getGuildLogConfigPath(key);
  if (!fs.existsSync(configPath)) {
    cachedLogConfig.set(key, null);
    return null;
  }

  const raw = fs.readFileSync(configPath, 'utf8');
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    console.warn(`Invalid log-config.json for guild ${key}, resetting:`, e);
    cachedLogConfig.set(key, null);
    return null;
  }

  const entry = parsed && typeof parsed === 'object'
    ? { channelId: parsed.channelId ?? null }
    : null;
  cachedLogConfig.set(key, entry);
  return entry;
}

function persistLogConfig(guildId, config) {
  const configPath = getGuildLogConfigPath(guildId);
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf8');
}

function resolveCommandsConfigKey(guildId) {
  if (!guildId) return null;
  const key = String(guildId).trim();
  return key.length ? key : null;
}

function loadCommandsConfig(guildId) {
  const key = resolveCommandsConfigKey(guildId);
  if (!key) {
    return { commands: [] };
  }
  if (cachedCommandsConfig.has(key)) return cachedCommandsConfig.get(key);

  const configPath = getGuildCommandsConfigPath(key);
  if (!fs.existsSync(configPath)) {
    const fallback = { commands: [] };
    cachedCommandsConfig.set(key, fallback);
    return fallback;
  }

  const raw = fs.readFileSync(configPath, 'utf8');
  try {
    const parsed = JSON.parse(raw);
    cachedCommandsConfig.set(key, parsed);
  } catch (e) {
    console.warn(`Invalid commands-config.json for guild ${key}, resetting:`, e);
    const fallback = { commands: [] };
    cachedCommandsConfig.set(key, fallback);
  }

  return cachedCommandsConfig.get(key);
}

function persistCommandsConfig(guildId) {
  const key = resolveCommandsConfigKey(guildId);
  if (!key) return;
  if (!cachedCommandsConfig.has(key)) return;
  const configPath = getGuildCommandsConfigPath(key);
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, JSON.stringify(cachedCommandsConfig.get(key), null, 2), 'utf8');
}

function loadClanState(guildId) {
  ensureLegacyMigration();
  const key = String(guildId);
  if (cachedClanState.has(key)) return cachedClanState.get(key);

  const clanStatePath = getGuildClanStatePath(key);
  if (!fs.existsSync(clanStatePath)) {
    const fallback = getDefaultClanState();
    cachedClanState.set(key, fallback);
    return fallback;
  }

  const raw = fs.readFileSync(clanStatePath, 'utf8');
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') {
      const fallback = getDefaultClanState();
      cachedClanState.set(key, fallback);
      return fallback;
    }
    const merged = {
      ...getDefaultClanState(),
      ...parsed
    };
    migrateClanState(merged);
    cachedClanState.set(key, merged);
    return merged;
  } catch (e) {
    console.warn(`Invalid clan_state.json for guild ${key}, resetting:`, e);
    const fallback = getDefaultClanState();
    cachedClanState.set(key, fallback);
    return fallback;
  }
}

function migrateClanState(state) {
  const officerStats = state.officer_stats;
  if (!officerStats || typeof officerStats !== 'object' || Array.isArray(officerStats)) {
    state.officer_stats = {};
  } else {
    for (const [userId, stats] of Object.entries(officerStats)) {
      if (!stats || typeof stats !== 'object' || Array.isArray(stats)) {
        delete officerStats[userId];
        continue;
      }
      const normalized = {
        ticketsAccepted: Number(stats.ticketsAccepted) || 0,
        ticketsRejected: Number(stats.ticketsRejected) || 0,
        ticketsRemoved: Number(stats.ticketsRemoved) || 0,
        ticketsMoved: Number(stats.ticketsMoved) || 0,
        totalActions: Number(stats.totalActions) || 0,
        updatedAt: stats.updatedAt ?? null
      };
      officerStats[userId] = normalized;
    }
  }

  const clans = state.clan_clans ?? {};
  if (clans && typeof clans === 'object') {
    for (const clanKey of Object.keys(clans)) {
      const clan = clans[clanKey];
      if (!clan || typeof clan !== 'object') continue;
      if (clan.ticketCategoryId == null && clan.ticketRoomId != null) {
        clan.ticketCategoryId = clan.ticketRoomId;
      }
      if ('ticketRoomId' in clan) {
        delete clan.ticketRoomId;
      }
      clan.reviewRoleId = clan.reviewRoleId != null ? String(clan.reviewRoleId) : null;
      clan.acceptCategoryId = clan.acceptCategoryId != null ? String(clan.acceptCategoryId) : null;
      clan.acceptRoleId = clan.acceptRoleId != null ? String(clan.acceptRoleId) : null;
    }
  }

  const ticketDecisions = state.clan_ticket_decisions;
  if (!ticketDecisions || typeof ticketDecisions !== 'object' || Array.isArray(ticketDecisions)) {
    state.clan_ticket_decisions = {};
    return;
  }

  for (const [channelId, decision] of Object.entries(ticketDecisions)) {
    if (!decision || typeof decision !== 'object' || Array.isArray(decision)) {
      delete ticketDecisions[channelId];
      continue;
    }

    if (!Object.prototype.hasOwnProperty.call(decision, 'activeReviewRoleId')) {
      decision.activeReviewRoleId = null;
    } else if (decision.activeReviewRoleId != null) {
      decision.activeReviewRoleId = String(decision.activeReviewRoleId);
    }

    if (!Object.prototype.hasOwnProperty.call(decision, 'lastMoveAt')) {
      decision.lastMoveAt = null;
    } else if (decision.lastMoveAt == null) {
      decision.lastMoveAt = null;
    } else {
      const normalizedLastMoveAt = String(decision.lastMoveAt);
      const hasIsoShape = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2}))$/.test(normalizedLastMoveAt);
      const parsedTimestamp = new Date(normalizedLastMoveAt).getTime();
      decision.lastMoveAt = hasIsoShape && Number.isFinite(parsedTimestamp)
        ? normalizedLastMoveAt
        : null;
    }

    if (Object.prototype.hasOwnProperty.call(decision, 'reassignedBy') && decision.reassignedBy != null) {
      decision.reassignedBy = String(decision.reassignedBy);
    }
  }
}

function persistClanState(guildId) {
  const key = String(guildId);
  if (!cachedClanState.has(key)) {
    cachedClanState.set(key, getDefaultClanState());
  }
  const clanStatePath = getGuildClanStatePath(key);
  return enqueueClanStateWrite(key, () => atomicWriteJson(clanStatePath, cachedClanState.get(key)));
}

function loadRpsState(guildId) {
  const key = String(guildId);
  if (cachedRpsState.has(key)) return cachedRpsState.get(key);

  const rpsStatePath = getGuildRpsStatePath(key);
  if (!fs.existsSync(rpsStatePath)) {
    const fallback = getDefaultRpsState();
    cachedRpsState.set(key, fallback);
    return fallback;
  }

  const raw = fs.readFileSync(rpsStatePath, 'utf8');
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') {
      const fallback = getDefaultRpsState();
      cachedRpsState.set(key, fallback);
      return fallback;
    }
    const merged = {
      ...getDefaultRpsState(),
      ...parsed
    };
    cachedRpsState.set(key, merged);
    return merged;
  } catch (e) {
    console.warn(`Invalid rps_state.json for guild ${key}, resetting:`, e);
    const fallback = getDefaultRpsState();
    cachedRpsState.set(key, fallback);
    return fallback;
  }
}

function persistRpsState(guildId) {
  const key = String(guildId);
  if (!cachedRpsState.has(key)) {
    cachedRpsState.set(key, getDefaultRpsState());
  }
  const rpsStatePath = getGuildRpsStatePath(key);
  return enqueueRpsStateWrite(key, () => atomicWriteJson(rpsStatePath, cachedRpsState.get(key)));
}

function loadPingRoleState(guildId) {
  const key = String(guildId);
  if (cachedPingRoleState.has(key)) return cachedPingRoleState.get(key);

  const pingRoleStatePath = getGuildPingRoleStatePath(key);
  if (!fs.existsSync(pingRoleStatePath)) {
    const fallback = getDefaultPingRoleState();
    cachedPingRoleState.set(key, fallback);
    return fallback;
  }

  const raw = fs.readFileSync(pingRoleStatePath, 'utf8');
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') {
      const fallback = getDefaultPingRoleState();
      cachedPingRoleState.set(key, fallback);
      return fallback;
    }
    const merged = {
      ...getDefaultPingRoleState(),
      ...parsed
    };
    cachedPingRoleState.set(key, merged);
    return merged;
  } catch (e) {
    console.warn(`Invalid ping_roles.json for guild ${key}, resetting:`, e);
    const fallback = getDefaultPingRoleState();
    cachedPingRoleState.set(key, fallback);
    return fallback;
  }
}

function persistPingRoleState(guildId) {
  const key = String(guildId);
  if (!cachedPingRoleState.has(key)) {
    cachedPingRoleState.set(key, getDefaultPingRoleState());
  }
  const pingRoleStatePath = getGuildPingRoleStatePath(key);
  return enqueuePingRoleStateWrite(key, () => atomicWriteJson(pingRoleStatePath, cachedPingRoleState.get(key)));
}

function loadPingRolePanelConfig(guildId) {
  const key = String(guildId);
  if (cachedPingRolePanelConfig.has(key)) return cachedPingRolePanelConfig.get(key);

  const configPath = getGuildPingRolePanelConfigPath(key);
  if (!fs.existsSync(configPath)) {
    cachedPingRolePanelConfig.set(key, null);
    return null;
  }

  const raw = fs.readFileSync(configPath, 'utf8');
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    console.warn(`Invalid ping_roles_panel.json for guild ${key}, resetting:`, e);
    cachedPingRolePanelConfig.set(key, null);
    return null;
  }

  const entry = parsed && typeof parsed === 'object'
    ? {
        channelId: parsed.channelId ?? null,
        messageId: parsed.messageId ?? null
      }
    : null;
  cachedPingRolePanelConfig.set(key, entry);
  return entry;
}

function persistPingRolePanelConfig(guildId, config) {
  const configPath = getGuildPingRolePanelConfigPath(guildId);
  if (!config) {
    if (fs.existsSync(configPath)) {
      fs.unlinkSync(configPath);
    }
    return;
  }
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf8');
}

function loadNotificationForwardConfig(guildId) {
  const key = String(guildId);
  if (cachedNotificationForwardConfig.has(key)) return cachedNotificationForwardConfig.get(key);

  const configPath = getGuildNotificationForwardConfigPath(key);
  if (!fs.existsSync(configPath)) {
    const fallback = getDefaultNotificationForwardConfig();
    cachedNotificationForwardConfig.set(key, fallback);
    return fallback;
  }

  const raw = fs.readFileSync(configPath, 'utf8');
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    console.warn(`Invalid notification-forward.json for guild ${key}, resetting:`, e);
    const fallback = getDefaultNotificationForwardConfig();
    cachedNotificationForwardConfig.set(key, fallback);
    return fallback;
  }

  const entry = normalizeNotificationForwardConfig(parsed);
  const migrationNeeded = !parsed || typeof parsed !== 'object'
    || !Object.prototype.hasOwnProperty.call(parsed, 'mode')
    || !Object.prototype.hasOwnProperty.call(parsed, 'lastBridgeStatus')
    || !Object.prototype.hasOwnProperty.call(parsed, 'lastDeliveredNotificationSignature');

  if (migrationNeeded) {
    try {
      atomicWriteJsonSync(configPath, entry);
    } catch (e) {
      console.warn(`Failed to migrate notification-forward.json for guild ${key}:`, e);
    }
  }

  cachedNotificationForwardConfig.set(key, entry);
  return entry;
}

function loadPrivateMessageState(guildId) {
  const key = String(guildId);
  if (cachedPrivateMessageState.has(key)) return cachedPrivateMessageState.get(key);

  const statePath = getGuildPrivateMessageStatePath(key);
  if (!fs.existsSync(statePath)) {
    const fallback = getDefaultPrivateMessageState();
    cachedPrivateMessageState.set(key, fallback);
    return fallback;
  }

  const raw = fs.readFileSync(statePath, 'utf8');
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    console.warn(`Invalid private-messages.json for guild ${key}, resetting:`, e);
    const fallback = getDefaultPrivateMessageState();
    cachedPrivateMessageState.set(key, fallback);
    return fallback;
  }

  const fallback = getDefaultPrivateMessageState();
  const entry = parsed && typeof parsed === 'object'
    ? {
        ...fallback,
        ...parsed,
        messages: parsed.messages && typeof parsed.messages === 'object'
          ? parsed.messages
          : {}
      }
    : fallback;
  cachedPrivateMessageState.set(key, entry);
  return entry;
}

function persistNotificationForwardConfig(guildId, config) {
  const key = normalizeGuildIdForScopedData(guildId);
  const configPath = getGuildNotificationForwardConfigPath(key);
  return enqueueNotificationForwardWrite(key, async () => {
    await atomicWriteJson(configPath, normalizeNotificationForwardConfig(config));
  });
}

function persistPrivateMessageState(guildId) {
  const key = String(guildId);
  return enqueuePrivateMessageStateWrite(key, async () => {
    const state = cachedPrivateMessageState.get(key) ?? getDefaultPrivateMessageState();
    await atomicWriteJson(getGuildPrivateMessageStatePath(key), state);
  });
}

export function getClanState(guildId) {
  return loadClanState(guildId);
}

export function setClanState(guildId, nextState) {
  const key = String(guildId);
  const merged = {
    ...getDefaultClanState(),
    ...(nextState && typeof nextState === 'object' ? nextState : {})
  };
  cachedClanState.set(key, merged);
  return persistClanState(key).then(() => cachedClanState.get(key));
}

export function updateClanState(guildId, mutator) {
  const state = loadClanState(guildId);
  if (typeof mutator === 'function') {
    mutator(state);
  }
  return persistClanState(guildId).then(() => state);
}

export function getRpsState(guildId) {
  return loadRpsState(guildId);
}

export function updateRpsState(guildId, mutator) {
  const state = loadRpsState(guildId);
  if (typeof mutator === 'function') {
    mutator(state);
  }
  return persistRpsState(guildId).then(() => state);
}

export function getPingRoleState(guildId) {
  return loadPingRoleState(guildId);
}

export function updatePingRoleState(guildId, mutator) {
  const state = loadPingRoleState(guildId);
  if (typeof mutator === 'function') {
    mutator(state);
  }
  return persistPingRoleState(guildId).then(() => state);
}

export function getPingRolePanelConfig(guildId) {
  const entry = loadPingRolePanelConfig(guildId);
  if (!entry) return null;
  return {
    channelId: entry.channelId ?? null,
    messageId: entry.messageId ?? null
  };
}

export function setPingRolePanelConfig(guildId, config) {
  const key = String(guildId);
  const entry = config && typeof config === 'object'
    ? {
        channelId: config.channelId ?? null,
        messageId: config.messageId ?? null
      }
    : null;
  cachedPingRolePanelConfig.set(key, entry);
  persistPingRolePanelConfig(key, entry);
  return entry;
}

export function getNotificationForwardConfig(guildId) {
  const entry = loadNotificationForwardConfig(guildId);
  return normalizeNotificationForwardConfig(entry);
}

export function getPrivateMessageState(guildId) {
  const state = loadPrivateMessageState(guildId);
  return {
    schemaVersion: Number(state.schemaVersion) || 1,
    messages: state.messages && typeof state.messages === 'object' ? state.messages : {}
  };
}

export function updatePrivateMessageState(guildId, mutator) {
  const state = loadPrivateMessageState(guildId);
  if (typeof mutator === 'function') {
    mutator(state);
  }
  if (!state.messages || typeof state.messages !== 'object') {
    state.messages = {};
  }
  return persistPrivateMessageState(guildId).then(() => state);
}

export function setNotificationForwardConfig(guildId, config) {
  const key = normalizeGuildIdForScopedData(guildId);
  const entry = normalizeNotificationForwardConfig(config);
  cachedNotificationForwardConfig.set(key, entry);
  return persistNotificationForwardConfig(key, entry).then(() => entry);
}

export function getWelcomeConfig(guildId) {
  const entry = loadWelcomeConfig(guildId);
  if (!entry) return null;
  return {
    channelId: entry.channelId ?? null,
    message: entry.message ?? null
  };
}

export function setWelcomeConfig(guildId, config) {
  const entry = {
    channelId: config.channelId ?? null,
    message: config.message ?? null
  };
  const key = String(guildId);
  cachedWelcomeConfig.set(key, entry);
  persistWelcomeConfig(key, entry);
  return entry;
}

export function getLogConfig(guildId) {
  const entry = loadLogConfig(guildId);
  if (!entry) return null;
  return {
    channelId: entry.channelId ?? null
  };
}

export function setLogConfig(guildId, config) {
  const entry = {
    channelId: config.channelId ?? null
  };
  const key = String(guildId);
  cachedLogConfig.set(key, entry);
  persistLogConfig(key, entry);
  return entry;
}

export function getCommandsConfig(guildId) {
  const config = loadCommandsConfig(guildId);
  return {
    commands: Array.isArray(config.commands) ? config.commands : []
  };
}

export function setCommandsConfig(guildId, commands) {
  const config = loadCommandsConfig(guildId);
  config.commands = Array.isArray(commands) ? commands : [];
  const key = resolveCommandsConfigKey(guildId);
  if (key) {
    cachedCommandsConfig.set(key, config);
  }
  persistCommandsConfig(key);
  return config;
}

export function getPermissionRoleId(guildId) {
  const state = loadClanState(guildId);
  return state.permission_role_id ?? null;
}

export function setPermissionRoleId(guildId, roleId) {
  return updateClanState(guildId, (state) => {
    state.permission_role_id = roleId || null;
  }).then((state) => state.permission_role_id ?? null);
}

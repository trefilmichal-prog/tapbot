import fs from 'node:fs';
import path from 'node:path';

const rootDir = path.resolve(process.cwd());
const dataDir = path.join(rootDir, 'data');
const legacyWelcomeConfigPath = path.join(dataDir, 'welcome-config.json');
const commandsConfigPath = path.join(dataDir, 'commands-config.json');
const legacyClanStatePath = path.join(dataDir, 'clan_state.json');
const guildsDir = path.join(dataDir, 'guilds');

const cachedWelcomeConfig = new Map();
let cachedCommandsConfig = null;
const cachedClanState = new Map();
const clanStateWriteQueues = new Map();
const cachedRpsState = new Map();
const rpsStateWriteQueues = new Map();
const cachedPingRoleState = new Map();
const pingRoleStateWriteQueues = new Map();
let legacyMigrationDone = false;

function getDefaultClanState() {
  return {
    schemaVersion: 1,
    clan_application_panels: {},
    clan_panel_configs: {},
    clan_clans: {},
    clan_applications: {},
    clan_ticket_decisions: {},
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

async function atomicWriteJson(targetPath, data) {
  await fs.promises.mkdir(path.dirname(targetPath), { recursive: true });
  const tempName = `${path.basename(targetPath)}.${process.pid}.${Date.now()}.tmp`;
  const tempPath = path.join(path.dirname(targetPath), tempName);
  await fs.promises.writeFile(tempPath, JSON.stringify(data, null, 2), 'utf8');
  await fs.promises.rename(tempPath, targetPath);
}

function getGuildDir(guildId) {
  return path.join(guildsDir, String(guildId));
}

function getGuildWelcomeConfigPath(guildId) {
  return path.join(getGuildDir(guildId), 'welcome-config.json');
}

function getGuildClanStatePath(guildId) {
  return path.join(getGuildDir(guildId), 'clan_state.json');
}

function getGuildRpsStatePath(guildId) {
  return path.join(getGuildDir(guildId), 'rps_state.json');
}

function getGuildPingRoleStatePath(guildId) {
  return path.join(getGuildDir(guildId), 'ping_roles.json');
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

function loadCommandsConfig() {
  if (cachedCommandsConfig) return cachedCommandsConfig;

  if (!fs.existsSync(commandsConfigPath)) {
    cachedCommandsConfig = { commands: [] };
    return cachedCommandsConfig;
  }

  const raw = fs.readFileSync(commandsConfigPath, 'utf8');
  try {
    cachedCommandsConfig = JSON.parse(raw);
  } catch (e) {
    console.warn('Invalid commands-config.json, resetting:', e);
    cachedCommandsConfig = { commands: [] };
  }

  return cachedCommandsConfig;
}

function persistCommandsConfig() {
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(commandsConfigPath, JSON.stringify(cachedCommandsConfig, null, 2), 'utf8');
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
  const clans = state.clan_clans ?? {};
  if (!clans || typeof clans !== 'object') return;
  for (const clanKey of Object.keys(clans)) {
    const clan = clans[clanKey];
    if (!clan || typeof clan !== 'object') continue;
    if (clan.ticketCategoryId == null && clan.ticketRoomId != null) {
      clan.ticketCategoryId = clan.ticketRoomId;
    }
    if ('ticketRoomId' in clan) {
      delete clan.ticketRoomId;
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

export function getCommandsConfig() {
  const config = loadCommandsConfig();
  return {
    commands: Array.isArray(config.commands) ? config.commands : []
  };
}

export function setCommandsConfig(commands) {
  const config = loadCommandsConfig();
  config.commands = Array.isArray(commands) ? commands : [];
  persistCommandsConfig();
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

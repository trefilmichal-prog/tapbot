import fs from 'node:fs';
import path from 'node:path';

const rootDir = path.resolve(process.cwd());
const dataDir = path.join(rootDir, 'data');
const welcomeConfigPath = path.join(dataDir, 'welcome-config.json');
const commandsConfigPath = path.join(dataDir, 'commands-config.json');
const clanStatePath = path.join(dataDir, 'clan_state.json');

let cachedWelcomeConfig = null;
let cachedCommandsConfig = null;
let cachedClanState = null;
let clanStateWriteQueue = Promise.resolve();

function getDefaultClanState() {
  return {
    schemaVersion: 1,
    clan_application_panels: {},
    clan_panel_configs: {},
    clan_clans: {},
    clan_applications: {},
    clan_tickets: {},
    clan_ticket_vacations: {},
    clan_ticket_reminders: {},
    cooldowns: {},
    cooldowns_user: {},
    cooldowns_role: {}
  };
}

async function atomicWriteJson(targetPath, data) {
  await fs.promises.mkdir(path.dirname(targetPath), { recursive: true });
  const tempName = `${path.basename(targetPath)}.${process.pid}.${Date.now()}.tmp`;
  const tempPath = path.join(path.dirname(targetPath), tempName);
  await fs.promises.writeFile(tempPath, JSON.stringify(data, null, 2), 'utf8');
  await fs.promises.rename(tempPath, targetPath);
}

function enqueueClanStateWrite(task) {
  clanStateWriteQueue = clanStateWriteQueue.then(task, task);
  return clanStateWriteQueue;
}

function loadWelcomeConfig() {
  if (cachedWelcomeConfig) return cachedWelcomeConfig;

  if (!fs.existsSync(welcomeConfigPath)) {
    cachedWelcomeConfig = {};
    return cachedWelcomeConfig;
  }

  const raw = fs.readFileSync(welcomeConfigPath, 'utf8');
  try {
    cachedWelcomeConfig = JSON.parse(raw);
  } catch (e) {
    console.warn('Invalid welcome-config.json, resetting:', e);
    cachedWelcomeConfig = {};
  }

  return cachedWelcomeConfig;
}

function persistWelcomeConfig() {
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(welcomeConfigPath, JSON.stringify(cachedWelcomeConfig, null, 2), 'utf8');
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

function loadClanState() {
  if (cachedClanState) return cachedClanState;

  if (!fs.existsSync(clanStatePath)) {
    cachedClanState = getDefaultClanState();
    return cachedClanState;
  }

  const raw = fs.readFileSync(clanStatePath, 'utf8');
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') {
      cachedClanState = getDefaultClanState();
    } else {
      cachedClanState = {
        ...getDefaultClanState(),
        ...parsed
      };
      migrateClanState(cachedClanState);
    }
  } catch (e) {
    console.warn('Invalid clan_state.json, resetting:', e);
    cachedClanState = getDefaultClanState();
  }

  return cachedClanState;
}

function migrateClanState(state) {
  const clansByGuild = state.clan_clans ?? {};
  for (const guildId of Object.keys(clansByGuild)) {
    const clans = clansByGuild[guildId];
    if (!clans || typeof clans !== 'object') continue;
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
}

function persistClanState() {
  if (!cachedClanState) {
    cachedClanState = getDefaultClanState();
  }
  return enqueueClanStateWrite(() => atomicWriteJson(clanStatePath, cachedClanState));
}

export function getClanState() {
  return loadClanState();
}

export function setClanState(nextState) {
  cachedClanState = {
    ...getDefaultClanState(),
    ...(nextState && typeof nextState === 'object' ? nextState : {})
  };
  return persistClanState().then(() => cachedClanState);
}

export function updateClanState(mutator) {
  const state = loadClanState();
  if (typeof mutator === 'function') {
    mutator(state);
  }
  return persistClanState().then(() => state);
}

export function getWelcomeConfig(guildId) {
  const configs = loadWelcomeConfig();
  const entry = configs[guildId];
  if (!entry) return null;
  return {
    channelId: entry.channelId ?? null,
    message: entry.message ?? null
  };
}

export function setWelcomeConfig(guildId, config) {
  const configs = loadWelcomeConfig();
  configs[guildId] = {
    channelId: config.channelId ?? null,
    message: config.message ?? null
  };
  persistWelcomeConfig();
  return configs[guildId];
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

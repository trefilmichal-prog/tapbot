import fs from 'node:fs';
import path from 'node:path';

const rootDir = path.resolve(process.cwd());
const dataDir = path.join(rootDir, 'data');
const welcomeConfigPath = path.join(dataDir, 'welcome-config.json');
const commandsConfigPath = path.join(dataDir, 'commands-config.json');

let cachedWelcomeConfig = null;
let cachedCommandsConfig = null;

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

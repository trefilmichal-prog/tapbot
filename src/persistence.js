import fs from 'node:fs';
import path from 'node:path';

const rootDir = path.resolve(process.cwd());
const dataDir = path.join(rootDir, 'data');
const welcomeConfigPath = path.join(dataDir, 'welcome-config.json');

let cachedWelcomeConfig = null;

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

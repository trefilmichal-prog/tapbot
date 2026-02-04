import fs from 'node:fs';
import path from 'node:path';

export function loadConfig() {
  const root = path.resolve(process.cwd());
  const cfgPath = path.join(root, 'config.json');

  if (!fs.existsSync(cfgPath)) {
    const err = new Error('Missing config.json. Run: npm run setup');
    err.code = 'MISSING_CONFIG';
    throw err;
  }

  const raw = fs.readFileSync(cfgPath, 'utf8');

  let cfg = null;
  try {
    cfg = JSON.parse(raw);
  } catch (e) {
    const err = new Error('config.json is not valid JSON. Run again: npm run setup');
    err.code = 'INVALID_CONFIG_JSON';
    throw err;
  }

  const token = (cfg && cfg.token ? String(cfg.token) : '').trim();
  const clientId = (cfg && cfg.clientId ? String(cfg.clientId) : '').trim();
  const guildIdRaw = (cfg && cfg.guildId ? String(cfg.guildId) : '').trim();
  const welcomeChannelIdRaw = (cfg && cfg.welcomeChannelId ? String(cfg.welcomeChannelId) : '').trim();
  const guildId = guildIdRaw === '' ? null : guildIdRaw;
  const welcomeChannelId = welcomeChannelIdRaw === '' ? null : welcomeChannelIdRaw;

  if (!token) {
    const err = new Error('config.json is missing token. Run: npm run setup');
    err.code = 'MISSING_TOKEN';
    throw err;
  }
  if (!clientId) {
    const err = new Error('config.json is missing clientId (Application ID). Run: npm run setup');
    err.code = 'MISSING_CLIENT_ID';
    throw err;
  }

  return { token, clientId, guildId, welcomeChannelId };
}

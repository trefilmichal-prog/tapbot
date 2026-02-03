import fs from 'node:fs';
import path from 'node:path';

export function loadConfig() {
  const root = path.resolve(process.cwd());
  const cfgPath = path.join(root, 'config.json');

  if (!fs.existsSync(cfgPath)) {
    const err = new Error('Chybí config.json. Spusť: npm run setup');
    err.code = 'MISSING_CONFIG';
    throw err;
  }

  const raw = fs.readFileSync(cfgPath, 'utf8');

  let cfg = null;
  try {
    cfg = JSON.parse(raw);
  } catch (e) {
    const err = new Error('config.json není validní JSON. Spusť znovu: npm run setup');
    err.code = 'INVALID_CONFIG_JSON';
    throw err;
  }

  const token = (cfg && cfg.token ? String(cfg.token) : '').trim();
  const clientId = (cfg && cfg.clientId ? String(cfg.clientId) : '').trim();
  const guildIdRaw = (cfg && cfg.guildId ? String(cfg.guildId) : '').trim();
  const guildId = guildIdRaw === '' ? null : guildIdRaw;

  if (!token) {
    const err = new Error('V config.json chybí token. Spusť: npm run setup');
    err.code = 'MISSING_TOKEN';
    throw err;
  }
  if (!clientId) {
    const err = new Error('V config.json chybí clientId (Application ID). Spusť: npm run setup');
    err.code = 'MISSING_CLIENT_ID';
    throw err;
  }

  return { token, clientId, guildId };
}

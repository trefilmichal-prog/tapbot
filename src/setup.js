import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';

function ask(rl, question) {
  return new Promise(resolve => rl.question(question, answer => resolve(answer)));
}

function writeJson(filePath, data) {
  const json = JSON.stringify(data, null, 2) + '\n';
  fs.writeFileSync(filePath, json, { encoding: 'utf8', mode: 0o600 });
}

(async () => {
  const root = path.resolve(process.cwd());
  const cfgPath = path.join(root, 'config.json');

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  try {
    console.log('=== Discord.js setup ===');
    console.log('Enter the values. Guild ID is optional (for faster dev deploys).');

    const token = String(await ask(rl, 'Bot token: ')).trim();
    const clientId = String(await ask(rl, 'Application ID (Client ID): ')).trim();
    const guildId = String(await ask(rl, 'Guild ID (optional, Enter = empty): ')).trim();

    if (!token) {
      console.error('Token is required.');
      process.exitCode = 1;
      return;
    }
    if (!clientId) {
      console.error('Application ID (Client ID) is required.');
      process.exitCode = 1;
      return;
    }

    const cfg = { token, clientId, guildId: guildId || '' };

    try {
      writeJson(cfgPath, cfg);
    } catch (e) {
      console.error('Failed to save config.json:', e && e.message ? e.message : e);
      process.exitCode = 1;
      return;
    }

    console.log('OK: config.json saved.');
    console.log('Next step: npm run deploy');
  } catch (e) {
    console.error('Setup error:', e && e.message ? e.message : e);
    process.exitCode = 1;
  } finally {
    rl.close();
  }
})();

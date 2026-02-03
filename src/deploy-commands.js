import { REST, Routes } from 'discord.js';
import { loadConfig } from './config.js';

const commands = [
  {
    name: 'ping',
    description: 'Replies with Pong!'
  }
];

(async () => {
  let cfg;
  try {
    cfg = loadConfig();
  } catch (e) {
    console.error(e.message || e);
    process.exitCode = 1;
    return;
  }

  const rest = new REST({ version: '10' }).setToken(cfg.token);

  try {
    console.log('Started refreshing application (/) commands...');

    if (cfg.guildId) {
      await rest.put(
        Routes.applicationGuildCommands(cfg.clientId, cfg.guildId),
        { body: commands }
      );
      console.log('Successfully reloaded guild (/) commands.');
    } else {
      await rest.put(
        Routes.applicationCommands(cfg.clientId),
        { body: commands }
      );
      console.log('Successfully reloaded global (/) commands.');
    }
  } catch (error) {
    console.error('Deploy failed:', error);
    process.exitCode = 1;
  }
})();

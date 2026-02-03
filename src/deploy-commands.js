import { REST, Routes } from 'discord.js';
import { ApplicationCommandOptionType, ChannelType } from 'discord-api-types/v10';
import { loadConfig } from './config.js';

const commands = [
  {
    name: 'ping',
    description: 'Replies with Pong!'
  },
  {
    name: 'config',
    description: 'Nastavení bota',
    options: [
      {
        type: ApplicationCommandOptionType.Subcommand,
        name: 'update',
        description: 'Aktualizuje bota'
      },
      {
        type: ApplicationCommandOptionType.Subcommand,
        name: 'verze',
        description: 'Zobrazí verzi bota'
      },
      {
        type: ApplicationCommandOptionType.Subcommand,
        name: 'welcome',
        description: 'Nastav uvítací zprávu',
        options: [
          {
            type: ApplicationCommandOptionType.Channel,
            name: 'channel',
            description: 'Textový kanál pro uvítání',
            required: true,
            channel_types: [ChannelType.GuildText]
          },
          {
            type: ApplicationCommandOptionType.String,
            name: 'message',
            description: 'Volitelná uvítací zpráva',
            required: false
          }
        ]
      }
    ]
  },
  {
    name: 'test',
    description: 'Testovací příkazy',
    options: [
      {
        type: ApplicationCommandOptionType.Subcommand,
        name: 'welcome',
        description: 'Manuálně odešle uvítací zprávu'
      }
    ]
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

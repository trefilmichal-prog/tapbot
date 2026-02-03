import { REST, Routes } from 'discord.js';
import { ApplicationCommandOptionType, ChannelType } from 'discord-api-types/v10';
import { loadConfig } from './config.js';
import { getCommandsConfig, setCommandsConfig } from './persistence.js';

export const defaultCommands = [
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
        description: 'Aktualizuje bota',
        options: [
          {
            type: ApplicationCommandOptionType.Boolean,
            name: 'batch-restart',
            description: 'Použije restart přes .bat skript místo pm2 restart',
            required: false
          }
        ]
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

export function buildCommandsPayload() {
  const stored = getCommandsConfig();
  const storedCommands = Array.isArray(stored.commands) ? stored.commands : [];
  const storedSerialized = JSON.stringify(storedCommands);
  const defaultSerialized = JSON.stringify(defaultCommands);
  if (storedSerialized !== defaultSerialized) {
    setCommandsConfig(defaultCommands);
    return defaultCommands;
  }
  return storedCommands;
}

export async function syncApplicationCommands({ token, clientId, guildId }) {
  const rest = new REST({ version: '10' }).setToken(token);
  const commands = buildCommandsPayload();
  const existing = await rest.get(
    guildId
      ? Routes.applicationGuildCommands(clientId, guildId)
      : Routes.applicationCommands(clientId)
  );
  const existingNames = new Set(
    Array.isArray(existing)
      ? existing.map((command) => command.name)
      : []
  );
  const newlyRegistered = commands.reduce(
    (count, command) => count + (existingNames.has(command.name) ? 0 : 1),
    0
  );

  if (guildId) {
    await rest.put(
      Routes.applicationGuildCommands(clientId, guildId),
      { body: commands }
    );
  } else {
    await rest.put(
      Routes.applicationCommands(clientId),
      { body: commands }
    );
  }

  return { total: commands.length, newlyRegistered };
}

async function runDeploy() {
  let cfg;
  try {
    cfg = loadConfig();
  } catch (e) {
    console.error(e.message || e);
    process.exitCode = 1;
    return;
  }

  try {
    console.log('Started refreshing application (/) commands...');
    const result = await syncApplicationCommands({
      token: cfg.token,
      clientId: cfg.clientId,
      guildId: cfg.guildId
    });
    const target = cfg.guildId ? 'guild' : 'global';
    console.log(
      `Successfully reloaded ${target} (/) commands. Total: ${result.total}, new: ${result.newlyRegistered}`
    );
  } catch (error) {
    console.error('Deploy failed:', error);
    process.exitCode = 1;
  }
}

if (process.argv[1] && process.argv[1].endsWith('deploy-commands.js')) {
  runDeploy();
}

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
        name: 'permissions',
        description: 'Nastaví roli s oprávněním na správu',
        options: [
          {
            type: ApplicationCommandOptionType.Role,
            name: 'role',
            description: 'Role s oprávněním (ponech prázdné pro reset)',
            required: false
          }
        ]
      },
      {
        type: ApplicationCommandOptionType.Subcommand,
        name: 'logs',
        description: 'Nastaví logovací kanál',
        options: [
          {
            type: ApplicationCommandOptionType.Channel,
            name: 'channel',
            description: 'Textový kanál pro logy (ponech prázdné pro reset)',
            required: false,
            channel_types: [ChannelType.GuildText]
          }
        ]
      },
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
  },
  {
    name: 'ping_roles',
    description: 'Správa ping rolí a routování',
    options: [
      {
        type: ApplicationCommandOptionType.Subcommand,
        name: 'choose',
        description: 'Vybere ping role pomocí menu'
      },
      {
        type: ApplicationCommandOptionType.Subcommand,
        name: 'panel',
        description: 'Odešle nebo aktualizuje ping role panel',
        options: [
          {
            type: ApplicationCommandOptionType.Channel,
            name: 'channel',
            description: 'Textový kanál pro ping role panel',
            required: true,
            channel_types: [ChannelType.GuildText]
          }
        ]
      },
      {
        type: ApplicationCommandOptionType.SubcommandGroup,
        name: 'roles',
        description: 'Správa dostupných rolí',
        options: [
          {
            type: ApplicationCommandOptionType.Subcommand,
            name: 'set',
            description: 'Nastaví seznam dostupných rolí',
            options: [
              {
                type: ApplicationCommandOptionType.Role,
                name: 'role_1',
                description: 'Role 1',
                required: false
              },
              {
                type: ApplicationCommandOptionType.Role,
                name: 'role_2',
                description: 'Role 2',
                required: false
              },
              {
                type: ApplicationCommandOptionType.Role,
                name: 'role_3',
                description: 'Role 3',
                required: false
              },
              {
                type: ApplicationCommandOptionType.Role,
                name: 'role_4',
                description: 'Role 4',
                required: false
              },
              {
                type: ApplicationCommandOptionType.Role,
                name: 'role_5',
                description: 'Role 5',
                required: false
              }
            ]
          },
          {
            type: ApplicationCommandOptionType.Subcommand,
            name: 'add',
            description: 'Přidá role do seznamu',
            options: [
              {
                type: ApplicationCommandOptionType.Role,
                name: 'role_1',
                description: 'Role 1',
                required: false
              },
              {
                type: ApplicationCommandOptionType.Role,
                name: 'role_2',
                description: 'Role 2',
                required: false
              },
              {
                type: ApplicationCommandOptionType.Role,
                name: 'role_3',
                description: 'Role 3',
                required: false
              },
              {
                type: ApplicationCommandOptionType.Role,
                name: 'role_4',
                description: 'Role 4',
                required: false
              },
              {
                type: ApplicationCommandOptionType.Role,
                name: 'role_5',
                description: 'Role 5',
                required: false
              }
            ]
          },
          {
            type: ApplicationCommandOptionType.Subcommand,
            name: 'remove',
            description: 'Odebere role ze seznamu',
            options: [
              {
                type: ApplicationCommandOptionType.Role,
                name: 'role_1',
                description: 'Role 1',
                required: false
              },
              {
                type: ApplicationCommandOptionType.Role,
                name: 'role_2',
                description: 'Role 2',
                required: false
              },
              {
                type: ApplicationCommandOptionType.Role,
                name: 'role_3',
                description: 'Role 3',
                required: false
              },
              {
                type: ApplicationCommandOptionType.Role,
                name: 'role_4',
                description: 'Role 4',
                required: false
              },
              {
                type: ApplicationCommandOptionType.Role,
                name: 'role_5',
                description: 'Role 5',
                required: false
              }
            ]
          },
          {
            type: ApplicationCommandOptionType.Subcommand,
            name: 'list',
            description: 'Vypíše dostupné role'
          }
        ]
      },
      {
        type: ApplicationCommandOptionType.SubcommandGroup,
        name: 'route',
        description: 'Správa routování do kanálů',
        options: [
          {
            type: ApplicationCommandOptionType.Subcommand,
            name: 'set',
            description: 'Nastaví roli pro kanál',
            options: [
              {
                type: ApplicationCommandOptionType.Channel,
                name: 'channel',
                description: 'Textový kanál',
                required: true,
                channel_types: [ChannelType.GuildText]
              },
              {
                type: ApplicationCommandOptionType.Role,
                name: 'role',
                description: 'Role pro tento kanál',
                required: true
              }
            ]
          },
          {
            type: ApplicationCommandOptionType.Subcommand,
            name: 'remove',
            description: 'Odstraní routu pro kanál',
            options: [
              {
                type: ApplicationCommandOptionType.Channel,
                name: 'channel',
                description: 'Textový kanál',
                required: true,
                channel_types: [ChannelType.GuildText]
              }
            ]
          },
          {
            type: ApplicationCommandOptionType.Subcommand,
            name: 'list',
            description: 'Vypíše seznam rout'
          }
        ]
      }
    ]
  },
  {
    name: 'clan_panel',
    description: 'Správa clan panelu',
    options: [
      {
        type: ApplicationCommandOptionType.Subcommand,
        name: 'post',
        description: 'Odešle clan panel do kanálu',
        options: [
          {
            type: ApplicationCommandOptionType.Channel,
            name: 'channel',
            description: 'Textový kanál pro clan panel',
            required: true,
            channel_types: [ChannelType.GuildText]
          }
        ]
      },
      {
        type: ApplicationCommandOptionType.Subcommand,
        name: 'edit',
        description: 'Upraví popisek clan panelu'
      },
      {
        type: ApplicationCommandOptionType.SubcommandGroup,
        name: 'clan',
        description: 'Správa klanů',
        options: [
          {
            type: ApplicationCommandOptionType.Subcommand,
            name: 'add',
            description: 'Přidá nový klan',
            options: [
              {
                type: ApplicationCommandOptionType.String,
                name: 'name',
                description: 'Název klanu',
                required: true
              },
              {
                type: ApplicationCommandOptionType.String,
                name: 'tag',
                description: 'Tag klanu',
                required: false
              },
              {
                type: ApplicationCommandOptionType.String,
                name: 'description',
                description: 'Popis klanu',
                required: false
              },
              {
                type: ApplicationCommandOptionType.Channel,
                name: 'ticket_room',
                description: 'Ticket kanál pro klan',
                required: false,
                channel_types: [ChannelType.GuildCategory]
              },
              {
                type: ApplicationCommandOptionType.Role,
                name: 'review_role',
                description: 'Role pro review žádostí',
                required: false
              },
              {
                type: ApplicationCommandOptionType.Channel,
                name: 'accept_category',
                description: 'Kategorie pro přijaté',
                required: false,
                channel_types: [ChannelType.GuildCategory]
              },
              {
                type: ApplicationCommandOptionType.Integer,
                name: 'order_position',
                description: 'Pořadí klanu v seznamu',
                required: false
              }
            ]
          },
          {
            type: ApplicationCommandOptionType.Subcommand,
            name: 'edit',
            description: 'Upraví existující klan',
            options: [
              {
                type: ApplicationCommandOptionType.String,
                name: 'name',
                description: 'Název klanu',
                required: true
              },
              {
                type: ApplicationCommandOptionType.String,
                name: 'tag',
                description: 'Nový tag klanu',
                required: false
              },
              {
                type: ApplicationCommandOptionType.String,
                name: 'description',
                description: 'Nový popis klanu',
                required: false
              },
              {
                type: ApplicationCommandOptionType.Channel,
                name: 'ticket_room',
                description: 'Nový ticket kanál pro klan',
                required: false,
                channel_types: [ChannelType.GuildCategory]
              },
              {
                type: ApplicationCommandOptionType.Role,
                name: 'review_role',
                description: 'Nová role pro review žádostí',
                required: false
              },
              {
                type: ApplicationCommandOptionType.Channel,
                name: 'accept_category',
                description: 'Nová kategorie pro přijaté',
                required: false,
                channel_types: [ChannelType.GuildCategory]
              },
              {
                type: ApplicationCommandOptionType.Integer,
                name: 'order_position',
                description: 'Nové pořadí klanu v seznamu',
                required: false
              }
            ]
          },
          {
            type: ApplicationCommandOptionType.Subcommand,
            name: 'delete',
            description: 'Smaže klan',
            options: [
              {
                type: ApplicationCommandOptionType.String,
                name: 'name',
                description: 'Název klanu',
                required: true
              }
            ]
          },
          {
            type: ApplicationCommandOptionType.Subcommand,
            name: 'list',
            description: 'Vypíše klany'
          }
        ]
      },
      {
        type: ApplicationCommandOptionType.Subcommand,
        name: 'ticket_reminders',
        description: 'Zapne nebo vypne ticket reminders',
        options: [
          {
            type: ApplicationCommandOptionType.Boolean,
            name: 'enabled',
            description: 'Zapnout připomínky',
            required: true
          }
        ]
      }
    ]
  },
  {
    name: 'rps',
    description: 'Rock Paper Scissors',
    options: [
      {
        type: ApplicationCommandOptionType.Subcommand,
        name: 'play',
        description: 'Zahraj si rock paper scissors',
        options: [
          {
            type: ApplicationCommandOptionType.User,
            name: 'opponent',
            description: 'Volitelný soupeř',
            required: false
          }
        ]
      },
      {
        type: ApplicationCommandOptionType.Subcommand,
        name: 'stats',
        description: 'Zobrazí statistiky'
      },
      {
        type: ApplicationCommandOptionType.Subcommand,
        name: 'reset',
        description: 'Resetuje statistiky'
      }
    ]
  }
];

export function buildCommandsPayload(guildId) {
  const stored = getCommandsConfig(guildId);
  const storedCommands = Array.isArray(stored.commands) ? stored.commands : [];
  const storedSerialized = JSON.stringify(storedCommands);
  const defaultSerialized = JSON.stringify(defaultCommands);
  if (storedSerialized !== defaultSerialized) {
    setCommandsConfig(guildId, defaultCommands);
    return defaultCommands;
  }
  return storedCommands;
}

export async function syncApplicationCommands({ token, clientId, guildId }) {
  const rest = new REST({ version: '10' }).setToken(token);
  const commands = buildCommandsPayload(guildId);
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

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
    description: 'Bot configuration',
    options: [
      {
        type: ApplicationCommandOptionType.Subcommand,
        name: 'permissions',
        description: 'Sets the role with management permissions',
        options: [
          {
            type: ApplicationCommandOptionType.Role,
            name: 'role',
            description: 'Role with permission (leave empty to reset)',
            required: false
          }
        ]
      },
      {
        type: ApplicationCommandOptionType.Subcommand,
        name: 'logs',
        description: 'Sets the log channel',
        options: [
          {
            type: ApplicationCommandOptionType.Channel,
            name: 'channel',
            description: 'Text channel for logs (leave empty to reset)',
            required: false,
            channel_types: [ChannelType.GuildText]
          }
        ]
      },
      {
        type: ApplicationCommandOptionType.Subcommand,
        name: 'update',
        description: 'Updates the bot',
        options: [
          {
            type: ApplicationCommandOptionType.Boolean,
            name: 'batch-restart',
            description: 'Use a .bat script restart instead of pm2 restart',
            required: false
          }
        ]
      },
      {
        type: ApplicationCommandOptionType.Subcommand,
        name: 'verze',
        description: 'Shows the bot version'
      },
      {
        type: ApplicationCommandOptionType.Subcommand,
        name: 'welcome',
        description: 'Configure the welcome message',
        options: [
          {
            type: ApplicationCommandOptionType.Channel,
            name: 'channel',
            description: 'Text channel for welcome messages',
            required: true,
            channel_types: [ChannelType.GuildText]
          },
          {
            type: ApplicationCommandOptionType.String,
            name: 'message',
            description: 'Optional welcome message',
            required: false
          }
        ]
      },
      {
        type: ApplicationCommandOptionType.Subcommand,
        name: 'welcome_room',
        description: 'Configure welcome messages by channel ID',
        options: [
          {
            type: ApplicationCommandOptionType.String,
            name: 'channel_id',
            description: 'ID of the text channel for welcome messages',
            required: true
          },
          {
            type: ApplicationCommandOptionType.String,
            name: 'message',
            description: 'Optional welcome message',
            required: false
          }
        ]
      }
    ]
  },
  {
    name: 'test',
    description: 'Test commands',
    options: [
      {
        type: ApplicationCommandOptionType.Subcommand,
        name: 'welcome',
        description: 'Manually sends a welcome message'
      }
    ]
  },
  {
    name: 'ping_roles',
    description: 'Manage ping roles and routing',
    options: [
      {
        type: ApplicationCommandOptionType.Subcommand,
        name: 'choose',
        description: 'Select ping roles from a menu'
      },
      {
        type: ApplicationCommandOptionType.Subcommand,
        name: 'panel',
        description: 'Posts or updates the ping role panel',
        options: [
          {
            type: ApplicationCommandOptionType.Channel,
            name: 'channel',
            description: 'Text channel for the ping role panel',
            required: true,
            channel_types: [ChannelType.GuildText]
          }
        ]
      },
      {
        type: ApplicationCommandOptionType.SubcommandGroup,
        name: 'roles',
        description: 'Manage available roles',
        options: [
          {
            type: ApplicationCommandOptionType.Subcommand,
            name: 'set',
            description: 'Set the list of available roles',
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
            description: 'Add roles to the list',
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
            description: 'Remove roles from the list',
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
            description: 'List available roles'
          }
        ]
      },
      {
        type: ApplicationCommandOptionType.SubcommandGroup,
        name: 'route',
        description: 'Manage routing to channels',
        options: [
          {
            type: ApplicationCommandOptionType.Subcommand,
            name: 'set',
            description: 'Set a role for a channel',
            options: [
              {
                type: ApplicationCommandOptionType.Channel,
                name: 'channel',
                description: 'Text channel',
                required: true,
                channel_types: [ChannelType.GuildText]
              },
              {
                type: ApplicationCommandOptionType.Role,
                name: 'role',
                description: 'Role for this channel',
                required: true
              }
            ]
          },
          {
            type: ApplicationCommandOptionType.Subcommand,
            name: 'remove',
            description: 'Remove a route for a channel',
            options: [
              {
                type: ApplicationCommandOptionType.Channel,
                name: 'channel',
                description: 'Text channel',
                required: true,
                channel_types: [ChannelType.GuildText]
              }
            ]
          },
          {
            type: ApplicationCommandOptionType.Subcommand,
            name: 'list',
            description: 'List routes'
          }
        ]
      }
    ]
  },
  {
    name: 'clan_panel',
    description: 'Manage the clan panel',
    options: [
      {
        type: ApplicationCommandOptionType.Subcommand,
        name: 'post',
        description: 'Post the clan panel to a channel',
        options: [
          {
            type: ApplicationCommandOptionType.Channel,
            name: 'channel',
            description: 'Text channel for the clan panel',
            required: true,
            channel_types: [ChannelType.GuildText]
          }
        ]
      },
      {
        type: ApplicationCommandOptionType.Subcommand,
        name: 'edit',
        description: 'Edit the clan panel description'
      },
      {
        type: ApplicationCommandOptionType.SubcommandGroup,
        name: 'clan',
        description: 'Manage clans',
        options: [
          {
            type: ApplicationCommandOptionType.Subcommand,
            name: 'add',
            description: 'Add a new clan',
            options: [
              {
                type: ApplicationCommandOptionType.String,
                name: 'name',
                description: 'Clan name',
                required: true
              },
              {
                type: ApplicationCommandOptionType.String,
                name: 'tag',
                description: 'Clan tag',
                required: false
              },
              {
                type: ApplicationCommandOptionType.String,
                name: 'description',
                description: 'Clan description',
                required: false
              },
              {
                type: ApplicationCommandOptionType.Channel,
                name: 'ticket_room',
                description: 'Ticket channel for the clan',
                required: false,
                channel_types: [ChannelType.GuildCategory]
              },
              {
                type: ApplicationCommandOptionType.Role,
                name: 'review_role',
                description: 'Role for reviewing applications',
                required: false
              },
              {
                type: ApplicationCommandOptionType.Channel,
                name: 'accept_category',
                description: 'Category for accepted tickets',
                required: false,
                channel_types: [ChannelType.GuildCategory]
              },
              {
                type: ApplicationCommandOptionType.Role,
                name: 'accept_role',
                description: 'Role assigned to accepted applicants',
                required: false
              },
              {
                type: ApplicationCommandOptionType.Integer,
                name: 'order_position',
                description: 'Clan order in the list',
                required: false
              }
            ]
          },
          {
            type: ApplicationCommandOptionType.Subcommand,
            name: 'edit',
            description: 'Edit an existing clan',
            options: [
              {
                type: ApplicationCommandOptionType.String,
                name: 'name',
                description: 'Clan name',
                required: true
              },
              {
                type: ApplicationCommandOptionType.String,
                name: 'tag',
                description: 'New clan tag',
                required: false
              },
              {
                type: ApplicationCommandOptionType.String,
                name: 'description',
                description: 'New clan description',
                required: false
              },
              {
                type: ApplicationCommandOptionType.Channel,
                name: 'ticket_room',
                description: 'New ticket channel for the clan',
                required: false,
                channel_types: [ChannelType.GuildCategory]
              },
              {
                type: ApplicationCommandOptionType.Role,
                name: 'review_role',
                description: 'New role for reviewing applications',
                required: false
              },
              {
                type: ApplicationCommandOptionType.Channel,
                name: 'accept_category',
                description: 'New category for accepted tickets',
                required: false,
                channel_types: [ChannelType.GuildCategory]
              },
              {
                type: ApplicationCommandOptionType.Role,
                name: 'accept_role',
                description: 'New role assigned to accepted applicants',
                required: false
              },
              {
                type: ApplicationCommandOptionType.Integer,
                name: 'order_position',
                description: 'New clan order in the list',
                required: false
              }
            ]
          },
          {
            type: ApplicationCommandOptionType.Subcommand,
            name: 'delete',
            description: 'Delete a clan',
            options: [
              {
                type: ApplicationCommandOptionType.String,
                name: 'name',
                description: 'Clan name',
                required: true
              }
            ]
          },
          {
            type: ApplicationCommandOptionType.Subcommand,
            name: 'list',
            description: 'List clans'
          }
        ]
      },
      {
        type: ApplicationCommandOptionType.Subcommand,
        name: 'ticket_reminders',
        description: 'Enable or disable ticket reminders',
        options: [
          {
            type: ApplicationCommandOptionType.Boolean,
            name: 'enabled',
            description: 'Enable reminders',
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
        description: 'Play rock paper scissors',
        options: [
          {
            type: ApplicationCommandOptionType.User,
            name: 'opponent',
            description: 'Optional opponent',
            required: false
          }
        ]
      },
      {
        type: ApplicationCommandOptionType.Subcommand,
        name: 'stats',
        description: 'Show statistics'
      },
      {
        type: ApplicationCommandOptionType.Subcommand,
        name: 'reset',
        description: 'Reset statistics'
      }
    ]
  },
  {
    name: 'admin',
    description: 'Administrative officer tools',
    options: [
      {
        type: ApplicationCommandOptionType.Subcommand,
        name: 'stats',
        description: 'Show officer ticket statistics',
        options: [
          {
            type: ApplicationCommandOptionType.User,
            name: 'nick',
            description: 'Officer to inspect',
            required: true
          }
        ]
      }
    ]
  },
  {
    name: 'settings',
    description: 'Ticket settings controls',
    options: [
      {
        type: ApplicationCommandOptionType.Subcommand,
        name: 'menu',
        description: 'Open the ticket settings menu in the current ticket channel'
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

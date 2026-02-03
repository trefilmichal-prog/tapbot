import { Client, Events, GatewayIntentBits, GuildMember, PermissionsBitField, ButtonStyle } from 'discord.js';
import { ChannelType, ComponentType, MessageFlags, SeparatorSpacingSize } from 'discord-api-types/v10';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { loadConfig } from './config.js';
import { getClanState, getWelcomeConfig, setWelcomeConfig, updateClanState } from './persistence.js';
import { runUpdate } from './update.js';
import { syncApplicationCommands } from './deploy-commands.js';

process.on('unhandledRejection', (reason) => {
  console.error('Unhandled promise rejection:', reason);
});

let cfg;
try {
  cfg = loadConfig();
} catch (e) {
  console.error(e.message || e);
  process.exit(1);
}

const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers] });
const CLAN_PANEL_ADMIN_ROLE_ID = '1468192944975515759';

client.on(Events.ClientReady, (readyClient) => {
  console.log(`Logged in as ${readyClient.user.tag}`);
  (async () => {
    try {
      const result = await syncApplicationCommands({
        token: cfg.token,
        clientId: cfg.clientId,
        guildId: cfg.guildId
      });
      console.log(
        `Startup command sync complete. Loaded: ${result.total}, new: ${result.newlyRegistered}`
      );
    } catch (error) {
      console.error('Startup command sync failed:', error);
    }
  })();
});

async function resolveWelcomeSettings(member) {
  const guildConfig = getWelcomeConfig(member.guild.id);
  const welcomeChannelId = guildConfig?.channelId ?? cfg.welcomeChannelId;
  if (welcomeChannelId) {
    try {
      const channel = await member.guild.channels.fetch(welcomeChannelId);
      if (channel && channel.isTextBased()) {
        return { channel, message: guildConfig?.message ?? null };
      }
    } catch (e) {
      console.warn(`Failed to fetch welcome channel ${welcomeChannelId}:`, e);
    }
  }

  const systemChannel = member.guild.systemChannel;
  if (systemChannel && systemChannel.isTextBased()) {
    return { channel: systemChannel, message: guildConfig?.message ?? null };
  }

  return null;
}

function resolveWelcomeMessage(configMessage) {
  return configMessage && configMessage.trim()
    ? configMessage.trim()
    : 'We are happy you joined. Feel free to introduce yourself!';
}

function buildWelcomeComponents(member, welcomeMessage) {
  const avatarUrl = member.user.displayAvatarURL({ extension: 'png', size: 256 });
  return [
    {
      type: ComponentType.Container,
      components: [
        {
          type: ComponentType.MediaGallery,
          items: [
            {
              type: ComponentType.MediaGalleryItem,
              media: {
                url: avatarUrl,
              },
            },
          ],
        },
        {
          type: ComponentType.TextDisplay,
          content: `Welcome to ${member.guild.name}, <@${member.id}>!`,
        },
        {
          type: ComponentType.Separator,
          divider: true,
          spacing: SeparatorSpacingSize.Small,
        },
        {
          type: ComponentType.TextDisplay,
          content: welcomeMessage,
        },
      ],
    },
  ];
}

function buildTextComponents(content) {
  return [
    {
      type: ComponentType.Container,
      components: [
        {
          type: ComponentType.TextDisplay,
          content
        }
      ]
    }
  ];
}

function hasClanPanelPermission(member) {
  return member.permissions.has(PermissionsBitField.Flags.Administrator)
    || member.roles.cache.has(CLAN_PANEL_ADMIN_ROLE_ID);
}

function sortClansForDisplay(clans) {
  return clans.slice().sort((a, b) => {
    const aHasOrder = Number.isFinite(a.orderPosition);
    const bHasOrder = Number.isFinite(b.orderPosition);
    if (aHasOrder && bHasOrder && a.orderPosition !== b.orderPosition) {
      return a.orderPosition - b.orderPosition;
    }
    if (aHasOrder !== bHasOrder) {
      return aHasOrder ? -1 : 1;
    }
    const nameComparison = (a.name ?? '').localeCompare(b.name ?? '', 'cs', {
      sensitivity: 'base'
    });
    if (nameComparison !== 0) return nameComparison;
    const createdComparison = (a.createdAt ?? '').localeCompare(b.createdAt ?? '');
    if (createdComparison !== 0) return createdComparison;
    return (a.tag ?? '').localeCompare(b.tag ?? '');
  });
}

function buildClanPanelComponents(guild, clanMap) {
  const clans = sortClansForDisplay(Object.values(clanMap ?? {}));
  const listText = clans.length
    ? clans
        .map((clan) => {
          const tag = clan.tag ? ` [${clan.tag}]` : '';
          const desc = clan.description ? ` — ${clan.description}` : '';
          return `• ${clan.name}${tag}${desc}`;
        })
        .join('\n')
    : 'Zatím nejsou evidovány žádné klany.';

  return [
    {
      type: ComponentType.Container,
      components: [
        {
          type: ComponentType.TextDisplay,
          content: `Clan panel · ${guild.name}`
        },
        {
          type: ComponentType.Separator,
          divider: true,
          spacing: SeparatorSpacingSize.Small
        },
        {
          type: ComponentType.TextDisplay,
          content: listText
        },
        {
          type: ComponentType.ActionRow,
          components: [
            {
              type: ComponentType.Button,
              style: ButtonStyle.Primary,
              custom_id: 'clan_panel_apply',
              label: 'Chci se přidat'
            }
          ]
        }
      ]
    }
  ];
}

function ensureGuildClanState(state, guildId) {
  if (!state.clan_clans[guildId]) {
    state.clan_clans[guildId] = {};
  }
  if (!state.clan_panel_configs[guildId]) {
    state.clan_panel_configs[guildId] = {};
  }
  if (!state.clan_ticket_reminders[guildId]) {
    state.clan_ticket_reminders[guildId] = {};
  }
  return state;
}

async function getBotVersion() {
  const versionPath = path.resolve(process.cwd(), 'verze.txt');
  try {
    const raw = await fs.readFile(versionPath, 'utf8');
    const trimmed = raw.trim();
    const parsed = Number.parseInt(trimmed, 10);
    if (!Number.isFinite(parsed) || String(parsed) !== trimmed || parsed <= 0) {
      await fs.writeFile(versionPath, '1', 'utf8');
      return '1';
    }
    return trimmed;
  } catch (e) {
    if (e && e.code === 'ENOENT') {
      await fs.writeFile(versionPath, '1', 'utf8');
      return '1';
    }
    throw e;
  }
}

async function sendWelcomeMessage(member, settings) {
  const welcomeMessage = resolveWelcomeMessage(settings.message);
  const welcomeComponents = buildWelcomeComponents(member, welcomeMessage);
  await settings.channel.send({
    components: welcomeComponents,
    flags: MessageFlags.IsComponentsV2
  });
}

client.on(Events.GuildMemberAdd, async (member) => {
  const settings = await resolveWelcomeSettings(member);
  if (!settings) return;

  try {
    await sendWelcomeMessage(member, settings);
  } catch (e) {
    console.error('Failed to send welcome message:', e);
  }
});

client.on(Events.InteractionCreate, async (interaction) => {
  try {
    if (!interaction.isChatInputCommand()) return;

    if (interaction.commandName === 'config') {
      if (!interaction.inGuild() || !(interaction.member instanceof GuildMember)) {
        await interaction.reply({
          components: buildTextComponents('Tento příkaz lze použít jen na serveru.'),
          flags: MessageFlags.IsComponentsV2,
          ephemeral: true
        });
        return;
      }

      if (!interaction.member.roles.cache.has('1468192944975515759')) {
        await interaction.reply({
          components: buildTextComponents('Nemáš oprávnění použít tento příkaz.'),
          flags: MessageFlags.IsComponentsV2,
          ephemeral: true
        });
        return;
      }

      const subcommand = interaction.options.getSubcommand();
      if (subcommand === 'verze') {
        const version = await getBotVersion();
        await interaction.reply({
          components: buildTextComponents(`Verze bota: ${version}`),
          flags: MessageFlags.IsComponentsV2
        });
        return;
      }

      if (subcommand === 'update') {
        const batchRestart = interaction.options.getBoolean('batch-restart') ?? false;
        await interaction.reply({
          components: [
            {
              type: ComponentType.Container,
              components: [
                {
                  type: ComponentType.TextDisplay,
                  content: 'Aktualizace spuštěna. Bot po dokončení nasadí příkazy a restartuje se.'
                }
              ]
            }
          ],
          flags: MessageFlags.IsComponentsV2,
          ephemeral: true
        });

        try {
          const updateResult = await runUpdate({ deployCommands: true, batchRestart });
          if (updateResult?.deployResult && !updateResult.deployResult.ok) {
            console.warn('Deploy commands during update failed; startup sync will retry.');
          }
        } catch (e) {
          console.error('Update failed:', e);
          try {
            await interaction.followUp({
              components: buildTextComponents(
                'Aktualizace selhala nebo se nepodařilo restartovat. Podívej se do logů.'
              ),
              flags: MessageFlags.IsComponentsV2,
              ephemeral: true
            });
          } catch (followUpError) {
            console.error('Failed to send update failure notice:', followUpError);
          }
        }
        return;
      }

      if (subcommand === 'welcome') {
        const channel = interaction.options.getChannel('channel', true);
        if (!channel || channel.type !== ChannelType.GuildText) {
          await interaction.reply({
            components: buildTextComponents('Prosím vyber textový kanál.'),
            flags: MessageFlags.IsComponentsV2,
            ephemeral: true
          });
          return;
        }

        const messageRaw = interaction.options.getString('message');
        const message = messageRaw && messageRaw.trim() ? messageRaw.trim() : null;

        setWelcomeConfig(interaction.guildId, {
          channelId: channel.id,
          message
        });

        await interaction.reply({
          components: buildTextComponents('Uvítání bylo uloženo.'),
          flags: MessageFlags.IsComponentsV2,
          ephemeral: true
        });
      }
      return;
    }

    if (interaction.commandName === 'ping') {
      await interaction.reply({
        components: buildTextComponents('Pong!'),
        flags: MessageFlags.IsComponentsV2
      });
    }

    if (interaction.commandName === 'test') {
      const subcommand = interaction.options.getSubcommand();
      if (subcommand === 'welcome') {
        if (!interaction.inGuild()) {
          await interaction.reply({
            components: buildTextComponents('Tento příkaz lze použít jen na serveru.'),
            flags: MessageFlags.IsComponentsV2,
            ephemeral: true
          });
          return;
        }

        const member = interaction.member ?? await interaction.guild.members.fetch(interaction.user.id);
        const settings = await resolveWelcomeSettings(member);
        if (!settings) {
          await interaction.reply({
            components: buildTextComponents('Není nastaven uvítací kanál.'),
            flags: MessageFlags.IsComponentsV2,
            ephemeral: true
          });
          return;
        }

        try {
          await sendWelcomeMessage(member, settings);
          await interaction.reply({
            components: buildTextComponents('Uvítací zpráva byla odeslána.'),
            flags: MessageFlags.IsComponentsV2,
            ephemeral: true
          });
        } catch (e) {
          console.error('Failed to send manual welcome message:', e);
          await interaction.reply({
            components: buildTextComponents('Nepodařilo se odeslat uvítací zprávu.'),
            flags: MessageFlags.IsComponentsV2,
            ephemeral: true
          });
        }
      }
    }

    if (interaction.commandName === 'clan_panel') {
      if (!interaction.inGuild() || !(interaction.member instanceof GuildMember)) {
        await interaction.reply({
          components: buildTextComponents('Tento příkaz lze použít jen na serveru.'),
          flags: MessageFlags.IsComponentsV2,
          ephemeral: true
        });
        return;
      }

      if (!hasClanPanelPermission(interaction.member)) {
        await interaction.reply({
          components: buildTextComponents('Nemáš oprávnění použít clan panel.'),
          flags: MessageFlags.IsComponentsV2,
          ephemeral: true
        });
        return;
      }

      const subcommandGroup = interaction.options.getSubcommandGroup(false);
      const subcommand = interaction.options.getSubcommand(true);
      const guildId = interaction.guildId;

      if (subcommandGroup === 'clan') {
        if (subcommand === 'add') {
          const name = interaction.options.getString('name', true).trim();
          const tag = interaction.options.getString('tag')?.trim() ?? null;
          const description = interaction.options.getString('description')?.trim() ?? null;
          const ticketRoomOption = interaction.options.getChannel('ticket_room');
          const reviewRoleOption = interaction.options.getRole('review_role');
          const acceptCategoryOption = interaction.options.getChannel('accept_category');
          const orderPosition = interaction.options.getInteger('order_position');
          const ticketCategoryId = ticketRoomOption?.type === ChannelType.GuildCategory
            ? ticketRoomOption.id
            : null;
          const acceptCategoryId = acceptCategoryOption?.type === ChannelType.GuildCategory
            ? acceptCategoryOption.id
            : null;
          const reviewRoleId = reviewRoleOption?.id ?? null;
          let existed = false;

          await updateClanState((state) => {
            ensureGuildClanState(state, guildId);
            const entry = state.clan_clans[guildId];
            if (entry[name]) {
              existed = true;
              return;
            }
            entry[name] = {
              name,
              tag,
              description,
              ticketCategoryId,
              reviewRoleId,
              acceptCategoryId,
              orderPosition: orderPosition ?? null,
              createdAt: new Date().toISOString()
            };
          });

          await interaction.reply({
            components: buildTextComponents(
              existed ? `Klan "${name}" už existuje.` : `Klan "${name}" byl přidán.`
            ),
            flags: MessageFlags.IsComponentsV2,
            ephemeral: true
          });
          return;
        }

        if (subcommand === 'edit') {
          const name = interaction.options.getString('name', true).trim();
          const tag = interaction.options.getString('tag')?.trim() ?? null;
          const description = interaction.options.getString('description')?.trim() ?? null;
          const ticketRoomOption = interaction.options.getChannel('ticket_room');
          const reviewRoleOption = interaction.options.getRole('review_role');
          const acceptCategoryOption = interaction.options.getChannel('accept_category');
          const orderPositionOption = interaction.options.getInteger('order_position');
          const ticketCategoryId = ticketRoomOption?.type === ChannelType.GuildCategory
            ? ticketRoomOption.id
            : null;
          const acceptCategoryId = acceptCategoryOption?.type === ChannelType.GuildCategory
            ? acceptCategoryOption.id
            : null;
          const reviewRoleId = reviewRoleOption?.id ?? null;
          let found = false;

          await updateClanState((state) => {
            ensureGuildClanState(state, guildId);
            const entry = state.clan_clans[guildId];
            if (!entry[name]) return;
            found = true;
            entry[name] = {
              ...entry[name],
              tag: tag ?? entry[name].tag ?? null,
              description: description ?? entry[name].description ?? null,
              ticketCategoryId: ticketRoomOption
                ? ticketCategoryId
                : entry[name].ticketCategoryId ?? null,
              reviewRoleId: reviewRoleOption ? reviewRoleId : entry[name].reviewRoleId ?? null,
              acceptCategoryId: acceptCategoryOption
                ? acceptCategoryId
                : entry[name].acceptCategoryId ?? null,
              orderPosition: orderPositionOption ?? entry[name].orderPosition ?? null,
              updatedAt: new Date().toISOString()
            };
          });

          await interaction.reply({
            components: buildTextComponents(
              found ? `Klan "${name}" byl upraven.` : `Klan "${name}" nebyl nalezen.`
            ),
            flags: MessageFlags.IsComponentsV2,
            ephemeral: true
          });
          return;
        }

        if (subcommand === 'delete') {
          const name = interaction.options.getString('name', true).trim();
          let removed = false;

          await updateClanState((state) => {
            ensureGuildClanState(state, guildId);
            if (state.clan_clans[guildId][name]) {
              delete state.clan_clans[guildId][name];
              removed = true;
            }
          });

          await interaction.reply({
            components: buildTextComponents(
              removed ? `Klan "${name}" byl smazán.` : `Klan "${name}" nebyl nalezen.`
            ),
            flags: MessageFlags.IsComponentsV2,
            ephemeral: true
          });
          return;
        }

        if (subcommand === 'list') {
          const state = getClanState();
          const clans = sortClansForDisplay(Object.values(state.clan_clans[guildId] ?? {}));
          const listText = clans.length
            ? clans.map((clan) => {
                const tag = clan.tag ? ` [${clan.tag}]` : '';
                const desc = clan.description ? ` — ${clan.description}` : '';
                return `• ${clan.name}${tag}${desc}`;
              }).join('\n')
            : 'Zatím nejsou evidovány žádné klany.';

          await interaction.reply({
            components: buildTextComponents(listText),
            flags: MessageFlags.IsComponentsV2,
            ephemeral: true
          });
          return;
        }
      }

      if (subcommand === 'post') {
        const channel = interaction.options.getChannel('channel', true);
        if (!channel || channel.type !== ChannelType.GuildText) {
          await interaction.reply({
            components: buildTextComponents('Prosím vyber textový kanál.'),
            flags: MessageFlags.IsComponentsV2,
            ephemeral: true
          });
          return;
        }

        const state = getClanState();
        const clanMap = state.clan_clans[guildId] ?? {};
        const panelMessage = await channel.send({
          components: buildClanPanelComponents(interaction.guild, clanMap),
          flags: MessageFlags.IsComponentsV2
        });

        await updateClanState((nextState) => {
          ensureGuildClanState(nextState, guildId);
          nextState.clan_panel_configs[guildId] = {
            channelId: channel.id,
            messageId: panelMessage.id,
            updatedAt: new Date().toISOString()
          };
        });

        await interaction.reply({
          components: buildTextComponents('Clan panel byl odeslán a uložen.'),
          flags: MessageFlags.IsComponentsV2,
          ephemeral: true
        });
        return;
      }

      if (subcommand === 'ticket_reminders') {
        const enabled = interaction.options.getBoolean('enabled', true);
        await updateClanState((state) => {
          ensureGuildClanState(state, guildId);
          state.clan_ticket_reminders[guildId] = {
            enabled,
            updatedAt: new Date().toISOString()
          };
        });

        await interaction.reply({
          components: buildTextComponents(
            enabled ? 'Ticket reminders byly zapnuty.' : 'Ticket reminders byly vypnuty.'
          ),
          flags: MessageFlags.IsComponentsV2,
          ephemeral: true
        });
      }
    }
  } catch (e) {
    console.error('Interaction error:', e);
    try {
      if (interaction && interaction.isRepliable && interaction.isRepliable()) {
        if (interaction.deferred || interaction.replied) {
          await interaction.followUp({
            components: buildTextComponents('Došlo k chybě při zpracování.'),
            flags: MessageFlags.IsComponentsV2,
            ephemeral: true
          });
        } else {
          await interaction.reply({
            components: buildTextComponents('Došlo k chybě při zpracování.'),
            flags: MessageFlags.IsComponentsV2,
            ephemeral: true
          });
        }
      }
    } catch (e2) {
      // Ignore secondary failures
    }
  }
});

client.login(cfg.token).catch((e) => {
  console.error('Login failed:', e);
  process.exit(1);
});

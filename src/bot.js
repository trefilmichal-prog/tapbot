import {
  Client,
  Events,
  GatewayIntentBits,
  GuildMember,
  PermissionsBitField,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  ActionRowBuilder
} from 'discord.js';
import {
  ButtonStyle,
  ChannelType,
  ComponentType,
  MessageFlags,
  SeparatorSpacingSize
} from 'discord-api-types/v10';
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
const CLAN_PANEL_EDIT_MODAL_ID = 'clan_panel_edit_modal';
const CLAN_PANEL_DESCRIPTION_INPUT_ID = 'clan_panel_description_input';
const CLAN_PANEL_SELECT_ID = 'clan_panel_select';
const CLAN_TICKET_MODAL_PREFIX = 'clan_ticket_modal:';
const CLAN_TICKET_REBIRTHS_INPUT_ID = 'clan_ticket_rebirths_input';
const CLAN_TICKET_GAMEPASSES_INPUT_ID = 'clan_ticket_gamepasses_input';
const CLAN_TICKET_HOURS_INPUT_ID = 'clan_ticket_hours_input';
const CLAN_TICKET_DECISION_PREFIX = 'clan_ticket_decision:';
const CLAN_TICKET_DECISION_TOGGLE = 'toggle';
const CLAN_TICKET_DECISION_ACCEPT = 'accept';
const CLAN_TICKET_DECISION_REJECT = 'reject';
const TICKET_STATUS_EMOJI = {
  awaiting: '🟡',
  [CLAN_TICKET_DECISION_ACCEPT]: '🟢',
  [CLAN_TICKET_DECISION_REJECT]: '🔴'
};

client.on(Events.ClientReady, (readyClient) => {
  console.log(`Logged in as ${readyClient.user.tag}`);
  (async () => {
    try {
      await refreshClanPanelsOnStartup(readyClient);
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

function sanitizeTicketChannelBase(rawName) {
  return rawName
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 90);
}

function stripTicketStatusPrefix(name) {
  if (!name) return '';
  const emojiPrefixes = Object.values(TICKET_STATUS_EMOJI);
  let nextName = name;
  for (const emoji of emojiPrefixes) {
    const prefixPattern = new RegExp(`^${emoji}(?:[ -]+)?`);
    if (prefixPattern.test(nextName)) {
      nextName = nextName.replace(prefixPattern, '');
      break;
    }
  }
  return nextName;
}

function formatTicketChannelName(statusEmoji, baseName) {
  const strippedBase = stripTicketStatusPrefix(baseName);
  const normalizedBase = strippedBase.replace(/^[ -]+/, '').replace(/[ -]+$/, '');
  if (!normalizedBase) {
    return statusEmoji;
  }
  return `${statusEmoji}-${normalizedBase}`;
}

async function renameTicketChannelStatus(channel, statusEmoji) {
  if (!channel || typeof channel.setName !== 'function') return;
  const currentName = channel.name ?? '';
  const baseName = stripTicketStatusPrefix(currentName) || currentName;
  const nextName = formatTicketChannelName(statusEmoji, baseName);
  if (nextName && currentName !== nextName) {
    await channel.setName(nextName);
  }
}

function buildClanPanelComponents(guild, clanMap, panelDescription) {
  const clans = sortClansForDisplay(Object.values(clanMap ?? {}));
  const trimmedDescription = typeof panelDescription === 'string'
    ? panelDescription.trim()
    : '';
  const resolvedDescription = trimmedDescription || 'Bez popisku.';
  const selectOptions = clans.length
    ? clans.map((clan) => ({
        label: clan.name,
        value: clan.name
      }))
    : [
        {
          label: 'Zatím nejsou evidovány žádné klany.',
          value: 'no_clans_available'
        }
      ];

  return [
    {
      type: ComponentType.Container,
      components: [
        {
          type: ComponentType.TextDisplay,
          content: resolvedDescription
        },
        {
          type: ComponentType.Separator,
          divider: true,
          spacing: SeparatorSpacingSize.Small
        },
        {
          type: ComponentType.ActionRow,
          components: [
            {
              type: ComponentType.StringSelect,
              custom_id: CLAN_PANEL_SELECT_ID,
              placeholder: `Vyber klan (${guild.name})`,
              options: selectOptions,
              disabled: clans.length === 0
            }
          ]
        }
      ]
    }
  ];
}

function buildTicketSummary(answers, decision) {
  const decisionText = decision?.status
    ? `**Decision:** ${decision.status === CLAN_TICKET_DECISION_ACCEPT ? 'Accepted ✅' : 'Rejected ❌'}
**Reviewer:** <@${decision.decidedBy}>
**Updated:** ${decision.updatedAt}`
    : null;
  const disableButtons = Boolean(decision?.status);
  const controlsExpanded = Boolean(decision?.controlsExpanded);
  const actionRows = controlsExpanded
    ? [
        {
          type: ComponentType.ActionRow,
          components: [
            {
              type: ComponentType.Button,
              custom_id: `${CLAN_TICKET_DECISION_PREFIX}${CLAN_TICKET_DECISION_TOGGLE}`,
              label: '⚙️',
              style: ButtonStyle.Secondary
            }
          ]
        },
        {
          type: ComponentType.ActionRow,
          components: [
            {
              type: ComponentType.Button,
              custom_id: `${CLAN_TICKET_DECISION_PREFIX}${CLAN_TICKET_DECISION_ACCEPT}`,
              label: 'Accept',
              style: ButtonStyle.Success,
              disabled: disableButtons
            },
            {
              type: ComponentType.Button,
              custom_id: `${CLAN_TICKET_DECISION_PREFIX}${CLAN_TICKET_DECISION_REJECT}`,
              label: 'Reject',
              style: ButtonStyle.Danger,
              disabled: disableButtons
            }
          ]
        }
      ]
    : [
        {
          type: ComponentType.ActionRow,
          components: [
            {
              type: ComponentType.Button,
              custom_id: `${CLAN_TICKET_DECISION_PREFIX}${CLAN_TICKET_DECISION_TOGGLE}`,
              label: '⚙️',
              style: ButtonStyle.Secondary
            }
          ]
        }
      ];
  return [
    {
      type: ComponentType.Container,
      components: [
        {
          type: ComponentType.TextDisplay,
          content: [
            '✨ **CLAN APPLICATION** ✨',
            '_Please fill this out and send the required screenshots._',
            '',
            `**How many rebirths do you have?**`,
            `> ${answers.rebirths}`,
            '',
            '**What gamepasses do you have?**',
            `> ${answers.gamepasses}`,
            '',
            '**How many hours a day do you play?**',
            `> ${answers.hours}`
          ].join('\n')
        },
        {
          type: ComponentType.Separator,
          divider: true,
          spacing: SeparatorSpacingSize.Small
        },
        ...(decisionText
          ? [
              {
                type: ComponentType.TextDisplay,
                content: decisionText
              },
              {
                type: ComponentType.Separator,
                divider: true,
                spacing: SeparatorSpacingSize.Small
              }
            ]
          : []),
        ...actionRows
      ]
    }
  ];
}

function buildRequiredScreenshotsNotice(reviewRoleId) {
  return [
    {
      type: ComponentType.Container,
      components: [
        {
          type: ComponentType.TextDisplay,
          content: [
            '**Required screenshots:**',
            '🐾 Pet team',
            '🎟️ Gamepasses',
            '🔁 Rebirths',
            '',
            '✂️ **IMPORTANT:** Crop your screenshots so your **Roblox username is clearly visible!** 👤✅ ⚙️',
            '',
            `Review role: <@&${reviewRoleId}>`
          ].join('\n')
        }
      ]
    }
  ];
}

function buildTicketModal(clanName) {
  const rebirthsInput = new TextInputBuilder()
    .setCustomId(CLAN_TICKET_REBIRTHS_INPUT_ID)
    .setLabel('How many rebirths do you have?')
    .setStyle(TextInputStyle.Short)
    .setRequired(true);

  const gamepassesInput = new TextInputBuilder()
    .setCustomId(CLAN_TICKET_GAMEPASSES_INPUT_ID)
    .setLabel('What gamepasses do you have?')
    .setStyle(TextInputStyle.Paragraph)
    .setRequired(true);

  const hoursInput = new TextInputBuilder()
    .setCustomId(CLAN_TICKET_HOURS_INPUT_ID)
    .setLabel('How many hours a day do you play?')
    .setStyle(TextInputStyle.Short)
    .setRequired(true);

  return new ModalBuilder()
    .setCustomId(`${CLAN_TICKET_MODAL_PREFIX}${encodeURIComponent(clanName)}`)
    .setTitle(`Join ${clanName}`)
    .addComponents(
      new ActionRowBuilder().addComponents(rebirthsInput),
      new ActionRowBuilder().addComponents(gamepassesInput),
      new ActionRowBuilder().addComponents(hoursInput)
    );
}

async function refreshClanPanelForGuild(guild, guildId) {
  const state = getClanState();
  const panelConfig = state.clan_panel_configs?.[guildId];
  if (!panelConfig?.channelId || !panelConfig?.messageId) return;

  let channel;
  try {
    channel = await guild.channels.fetch(panelConfig.channelId);
  } catch (error) {
    console.warn(`Failed to fetch clan panel channel ${panelConfig.channelId}:`, error);
  }

  if (!channel || !channel.isTextBased()) {
    await updateClanState((nextState) => {
      if (nextState.clan_panel_configs?.[guildId]) {
        nextState.clan_panel_configs[guildId] = {};
      }
    });
    return;
  }

  let message;
  try {
    message = await channel.messages.fetch(panelConfig.messageId);
  } catch (error) {
    console.warn(`Failed to fetch clan panel message ${panelConfig.messageId}:`, error);
  }

  if (!message) {
    await updateClanState((nextState) => {
      if (nextState.clan_panel_configs?.[guildId]) {
        nextState.clan_panel_configs[guildId] = {};
      }
    });
    return;
  }

  const clanMap = state.clan_clans?.[guildId] ?? {};
  const panelDescription = panelConfig?.description ?? null;
  try {
    await message.edit({
      components: buildClanPanelComponents(guild, clanMap, panelDescription),
      flags: MessageFlags.IsComponentsV2
    });
  } catch (error) {
    console.warn(`Failed to refresh clan panel message ${panelConfig.messageId}:`, error);
  }
}

async function refreshClanPanelsOnStartup(readyClient) {
  const state = getClanState();
  const panelConfigs = state.clan_panel_configs ?? {};
  const invalidGuildIds = [];

  for (const [guildId, config] of Object.entries(panelConfigs)) {
    if (!config?.channelId || !config?.messageId) continue;

    let guild;
    try {
      guild = await readyClient.guilds.fetch(guildId);
    } catch (error) {
      console.warn(`Failed to fetch guild ${guildId} for clan panel refresh:`, error);
      invalidGuildIds.push(guildId);
      continue;
    }

    let channel;
    try {
      channel = await guild.channels.fetch(config.channelId);
    } catch (error) {
      console.warn(`Failed to fetch clan panel channel ${config.channelId}:`, error);
      invalidGuildIds.push(guildId);
      continue;
    }

    if (!channel || !channel.isTextBased()) {
      invalidGuildIds.push(guildId);
      continue;
    }

    let message;
    try {
      message = await channel.messages.fetch(config.messageId);
    } catch (error) {
      console.warn(`Failed to fetch clan panel message ${config.messageId}:`, error);
      invalidGuildIds.push(guildId);
      continue;
    }

    const clanMap = state.clan_clans?.[guildId] ?? {};
    const panelDescription = config?.description ?? null;
    try {
      await message.edit({
        components: buildClanPanelComponents(guild, clanMap, panelDescription),
        flags: MessageFlags.IsComponentsV2
      });
    } catch (error) {
      console.warn(`Failed to refresh clan panel message ${config.messageId}:`, error);
    }
  }

  if (invalidGuildIds.length) {
    await updateClanState((nextState) => {
      for (const guildId of invalidGuildIds) {
        if (nextState.clan_panel_configs?.[guildId]) {
          nextState.clan_panel_configs[guildId] = {};
        }
      }
    });
  }
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
  if (!state.clan_ticket_decisions[guildId]) {
    state.clan_ticket_decisions[guildId] = {};
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
    if (interaction.isModalSubmit()) {
      if (interaction.customId.startsWith(CLAN_TICKET_MODAL_PREFIX)) {
        if (!interaction.inGuild() || !(interaction.member instanceof GuildMember)) {
          await interaction.reply({
            components: buildTextComponents('Tento dialog lze použít jen na serveru.'),
            flags: MessageFlags.IsComponentsV2,
            ephemeral: true
          });
          return;
        }

        const clanName = decodeURIComponent(
          interaction.customId.slice(CLAN_TICKET_MODAL_PREFIX.length)
        );
        const state = getClanState();
        const clan = state.clan_clans?.[interaction.guildId]?.[clanName];
        if (!clan) {
          await interaction.reply({
            components: buildTextComponents('Vybraný klan nebyl nalezen.'),
            flags: MessageFlags.IsComponentsV2,
            ephemeral: true
          });
          return;
        }

        if (!clan.ticketCategoryId) {
          await interaction.reply({
            components: buildTextComponents('K tomuto klanu není nastavená ticket kategorie.'),
            flags: MessageFlags.IsComponentsV2,
            ephemeral: true
          });
          return;
        }

        if (!clan.reviewRoleId) {
          await interaction.reply({
            components: buildTextComponents('K tomuto klanu není nastavená review role.'),
            flags: MessageFlags.IsComponentsV2,
            ephemeral: true
          });
          return;
        }

        let ticketCategory;
        try {
          ticketCategory = await interaction.guild.channels.fetch(clan.ticketCategoryId);
        } catch (error) {
          console.warn(`Failed to fetch ticket category ${clan.ticketCategoryId}:`, error);
        }

        if (!ticketCategory || ticketCategory.type !== ChannelType.GuildCategory) {
          await interaction.reply({
            components: buildTextComponents('Ticket kategorie nebyla nalezena.'),
            flags: MessageFlags.IsComponentsV2,
            ephemeral: true
          });
          return;
        }

        const rebirths = interaction.fields.getTextInputValue(CLAN_TICKET_REBIRTHS_INPUT_ID);
        const gamepasses = interaction.fields.getTextInputValue(CLAN_TICKET_GAMEPASSES_INPUT_ID);
        const hours = interaction.fields.getTextInputValue(CLAN_TICKET_HOURS_INPUT_ID);

        const adminRoles = interaction.guild.roles.cache
          .filter((role) => role.permissions.has(PermissionsBitField.Flags.Administrator))
          .map((role) => ({
            id: role.id,
            allow: [
              PermissionsBitField.Flags.ViewChannel,
              PermissionsBitField.Flags.SendMessages,
              PermissionsBitField.Flags.ReadMessageHistory
            ]
          }));

        let ticketChannel;
        try {
          const playerName = interaction.member.displayName || interaction.user.username;
          const rawChannelName = `${clanName} - ${playerName}`;
          const channelBaseName = sanitizeTicketChannelBase(rawChannelName) || interaction.user.id;
          const channelName = formatTicketChannelName(TICKET_STATUS_EMOJI.awaiting, channelBaseName);

          ticketChannel = await interaction.guild.channels.create({
            name: channelName,
            type: ChannelType.GuildText,
            parent: ticketCategory.id,
            permissionOverwrites: [
              {
                id: interaction.guild.roles.everyone.id,
                deny: [PermissionsBitField.Flags.ViewChannel]
              },
              {
                id: interaction.user.id,
                allow: [
                  PermissionsBitField.Flags.ViewChannel,
                  PermissionsBitField.Flags.SendMessages,
                  PermissionsBitField.Flags.ReadMessageHistory
                ]
              },
              {
                id: clan.reviewRoleId,
                allow: [
                  PermissionsBitField.Flags.ViewChannel,
                  PermissionsBitField.Flags.SendMessages,
                  PermissionsBitField.Flags.ReadMessageHistory
                ]
              },
              ...adminRoles
            ]
          });
        } catch (error) {
          console.error('Failed to create ticket channel:', error);
          await interaction.reply({
            components: buildTextComponents('Nepodařilo se vytvořit ticket.'),
            flags: MessageFlags.IsComponentsV2,
            ephemeral: true
          });
          return;
        }

        const summaryMessage = await ticketChannel.send({
          components: buildTicketSummary({
            rebirths,
            gamepasses,
            hours
          }),
          flags: MessageFlags.IsComponentsV2
        });

        await ticketChannel.send({
          components: buildRequiredScreenshotsNotice(clan.reviewRoleId),
          flags: MessageFlags.IsComponentsV2
        });

        await updateClanState((state) => {
          ensureGuildClanState(state, interaction.guildId);
          state.clan_ticket_decisions[interaction.guildId][ticketChannel.id] = {
            clanName,
            applicantId: interaction.user.id,
            messageId: summaryMessage.id,
            answers: {
              rebirths,
              gamepasses,
              hours
            },
            status: null,
            decidedBy: null,
            updatedAt: null,
            controlsExpanded: false,
            createdAt: new Date().toISOString()
          };
        });

        await interaction.reply({
          components: buildTextComponents(`Ticket byl vytvořen: <#${ticketChannel.id}>`),
          flags: MessageFlags.IsComponentsV2,
          ephemeral: true
        });
        return;
      }

      if (interaction.customId !== CLAN_PANEL_EDIT_MODAL_ID) return;
      if (!interaction.inGuild() || !(interaction.member instanceof GuildMember)) {
        await interaction.reply({
          components: buildTextComponents('Tento dialog lze použít jen na serveru.'),
          flags: MessageFlags.IsComponentsV2,
          ephemeral: true
        });
        return;
      }

      if (!hasClanPanelPermission(interaction.member)) {
        await interaction.reply({
          components: buildTextComponents('Nemáš oprávnění upravit clan panel.'),
          flags: MessageFlags.IsComponentsV2,
          ephemeral: true
        });
        return;
      }

      const rawDescription = interaction.fields.getTextInputValue(CLAN_PANEL_DESCRIPTION_INPUT_ID);
      const description = rawDescription && rawDescription.trim()
        ? rawDescription.trim()
        : null;

      await updateClanState((state) => {
        ensureGuildClanState(state, interaction.guildId);
        state.clan_panel_configs[interaction.guildId] = {
          ...state.clan_panel_configs[interaction.guildId],
          description,
          updatedAt: new Date().toISOString()
        };
      });

      await refreshClanPanelForGuild(interaction.guild, interaction.guildId);

      await interaction.reply({
        components: buildTextComponents('Popisek clan panelu byl uložen.'),
        flags: MessageFlags.IsComponentsV2,
        ephemeral: true
      });
      return;
    }

    if (interaction.isStringSelectMenu()) {
      if (interaction.customId !== CLAN_PANEL_SELECT_ID) return;
      if (!interaction.inGuild() || !(interaction.member instanceof GuildMember)) {
        await interaction.reply({
          components: buildTextComponents('Tento výběr lze použít jen na serveru.'),
          flags: MessageFlags.IsComponentsV2,
          ephemeral: true
        });
        return;
      }

      const selectedClan = interaction.values[0];
      if (!selectedClan || selectedClan === 'no_clans_available') {
        await interaction.reply({
          components: buildTextComponents('Nejsou k dispozici žádné klany k výběru.'),
          flags: MessageFlags.IsComponentsV2,
          ephemeral: true
        });
        return;
      }

      const state = getClanState();
      const clan = state.clan_clans?.[interaction.guildId]?.[selectedClan];
      if (!clan) {
        await interaction.reply({
          components: buildTextComponents('Vybraný klan nebyl nalezen.'),
          flags: MessageFlags.IsComponentsV2,
          ephemeral: true
        });
        return;
      }

      const modal = buildTicketModal(selectedClan);
      await interaction.showModal(modal);
      return;
    }

    if (interaction.isButton()) {
      if (!interaction.customId.startsWith(CLAN_TICKET_DECISION_PREFIX)) return;
      if (!interaction.inGuild() || !(interaction.member instanceof GuildMember)) {
        await interaction.reply({
          components: buildTextComponents('Tuto akci lze použít jen na serveru.'),
          flags: MessageFlags.IsComponentsV2,
          ephemeral: true
        });
        return;
      }

      const action = interaction.customId.slice(CLAN_TICKET_DECISION_PREFIX.length);
      if (![CLAN_TICKET_DECISION_TOGGLE, CLAN_TICKET_DECISION_ACCEPT, CLAN_TICKET_DECISION_REJECT]
        .includes(action)) {
        await interaction.reply({
          components: buildTextComponents('Neplatná akce pro ticket.'),
          flags: MessageFlags.IsComponentsV2,
          ephemeral: true
        });
        return;
      }

      const state = getClanState();
      const ticketEntry = state.clan_ticket_decisions?.[interaction.guildId]?.[interaction.channelId];
      if (!ticketEntry) {
        await interaction.reply({
          components: buildTextComponents('Ticket nebyl nalezen nebo už není aktivní.'),
          flags: MessageFlags.IsComponentsV2,
          ephemeral: true
        });
        return;
      }

      const clan = state.clan_clans?.[interaction.guildId]?.[ticketEntry.clanName];
      if (!clan) {
        await interaction.reply({
          components: buildTextComponents('Klan pro tento ticket nebyl nalezen.'),
          flags: MessageFlags.IsComponentsV2,
          ephemeral: true
        });
        return;
      }

      const hasReviewPermission = Boolean(
        clan.reviewRoleId && interaction.member.roles.cache.has(clan.reviewRoleId)
      );
      if (!hasReviewPermission) {
        await interaction.reply({
          components: buildTextComponents(
            'Nemáš oprávnění rozhodovat o tomto ticketu. Je nutné mít review roli klanu.'
          ),
          flags: MessageFlags.IsComponentsV2,
          ephemeral: true
        });
        return;
      }

      if (action === CLAN_TICKET_DECISION_TOGGLE) {
        await updateClanState((nextState) => {
          ensureGuildClanState(nextState, interaction.guildId);
          const entry = nextState.clan_ticket_decisions[interaction.guildId][interaction.channelId];
          if (!entry) return;
          entry.controlsExpanded = !entry.controlsExpanded;
        });

        const refreshedState = getClanState();
        const refreshedEntry = refreshedState.clan_ticket_decisions?.[interaction.guildId]?.[
          interaction.channelId
        ];
        if (refreshedEntry?.messageId && interaction.channel?.isTextBased()) {
          try {
            const message = await interaction.channel.messages.fetch(refreshedEntry.messageId);
            await message.edit({
              components: buildTicketSummary(refreshedEntry.answers ?? {}, refreshedEntry),
              flags: MessageFlags.IsComponentsV2
            });
          } catch (error) {
            console.warn('Failed to update ticket summary message:', error);
          }
        }

        await interaction.reply({
          components: buildTextComponents(
            refreshedEntry?.controlsExpanded ? 'Ovládání ticketu bylo rozbaleno.' : 'Ovládání ticketu bylo sbaleno.'
          ),
          flags: MessageFlags.IsComponentsV2,
          ephemeral: true
        });
        return;
      }

      if (ticketEntry.status) {
        await interaction.reply({
          components: buildTextComponents('O tomto ticketu už bylo rozhodnuto.'),
          flags: MessageFlags.IsComponentsV2,
          ephemeral: true
        });
        return;
      }

      const updatedAt = new Date().toISOString();
      await updateClanState((nextState) => {
        ensureGuildClanState(nextState, interaction.guildId);
        const entry = nextState.clan_ticket_decisions[interaction.guildId][interaction.channelId];
        if (!entry) return;
        entry.status = action;
        entry.decidedBy = interaction.user.id;
        entry.updatedAt = updatedAt;
      });

      if (action === CLAN_TICKET_DECISION_ACCEPT && clan.acceptCategoryId) {
        try {
          await interaction.channel?.setParent(clan.acceptCategoryId, {
            lockPermissions: false
          });
        } catch (error) {
          console.warn('Failed to move accepted ticket channel:', error);
        }
      }

      const statusEmoji = TICKET_STATUS_EMOJI[action];
      if (statusEmoji) {
        try {
          await renameTicketChannelStatus(interaction.channel, statusEmoji);
        } catch (error) {
          console.warn('Failed to rename ticket channel:', error);
        }
      }

      const refreshedState = getClanState();
      const refreshedEntry = refreshedState.clan_ticket_decisions?.[interaction.guildId]?.[
        interaction.channelId
      ];
      if (refreshedEntry?.messageId && interaction.channel?.isTextBased()) {
        try {
          const message = await interaction.channel.messages.fetch(refreshedEntry.messageId);
          await message.edit({
            components: buildTicketSummary(refreshedEntry.answers ?? {}, refreshedEntry),
            flags: MessageFlags.IsComponentsV2
          });
        } catch (error) {
          console.warn('Failed to update ticket summary message:', error);
        }
      }

      await interaction.reply({
        components: buildTextComponents(
          action === CLAN_TICKET_DECISION_ACCEPT
            ? 'Ticket byl označen jako přijatý.'
            : 'Ticket byl označen jako zamítnutý.'
        ),
        flags: MessageFlags.IsComponentsV2,
        ephemeral: true
      });
      return;
    }

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

          if (!existed) {
            await refreshClanPanelForGuild(interaction.guild, guildId);
          }

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

          if (found) {
            await refreshClanPanelForGuild(interaction.guild, guildId);
          }

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

          if (removed) {
            await refreshClanPanelForGuild(interaction.guild, guildId);
          }

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

      if (!subcommandGroup && subcommand === 'edit') {
        const state = getClanState();
        const panelDescription = state.clan_panel_configs?.[guildId]?.description ?? '';
        const input = new TextInputBuilder()
          .setCustomId(CLAN_PANEL_DESCRIPTION_INPUT_ID)
          .setLabel('Popisek clan panelu')
          .setStyle(TextInputStyle.Paragraph)
          .setRequired(false)
          .setMaxLength(1000);

        if (panelDescription && panelDescription.trim()) {
          input.setValue(panelDescription.trim());
        }

        const modal = new ModalBuilder()
          .setCustomId(CLAN_PANEL_EDIT_MODAL_ID)
          .setTitle('Upravit clan panel')
          .addComponents(new ActionRowBuilder().addComponents(input));

        await interaction.showModal(modal);
        return;
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
        const panelDescription = state.clan_panel_configs?.[guildId]?.description ?? null;
        const panelMessage = await channel.send({
          components: buildClanPanelComponents(interaction.guild, clanMap, panelDescription),
          flags: MessageFlags.IsComponentsV2
        });

        await updateClanState((nextState) => {
          ensureGuildClanState(nextState, guildId);
          nextState.clan_panel_configs[guildId] = {
            ...nextState.clan_panel_configs[guildId],
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

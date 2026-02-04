import {
  Client,
  Events,
  GatewayIntentBits,
  GuildMember,
  Partials,
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
import {
  getClanState,
  getLogConfig,
  getPingRoleState,
  getRpsState,
  getPermissionRoleId,
  getWelcomeConfig,
  setLogConfig,
  setPermissionRoleId,
  setWelcomeConfig,
  updateClanState,
  updatePingRoleState,
  updateRpsState
} from './persistence.js';
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

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ],
  partials: [Partials.Message, Partials.Channel]
});
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
const CLAN_TICKET_DECISION_REMOVE = 'remove';
const PING_ROLES_SELECT_ID = 'ping_roles_select';
const RPS_CHOICE_PREFIX = 'rps:choose:';
const RPS_MOVES = ['rock', 'paper', 'scissors'];
const RPS_MOVE_META = {
  rock: { label: 'Rock', emoji: '🪨' },
  paper: { label: 'Paper', emoji: '📄' },
  scissors: { label: 'Scissors', emoji: '✂️' }
};
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

function formatLogContent(content) {
  if (content === null || typeof content === 'undefined') {
    return '*(not available)*';
  }
  const trimmed = String(content).trim();
  return trimmed ? trimmed : '*(empty)*';
}

function formatMessageTimestamp(timestampMs) {
  if (!Number.isFinite(timestampMs)) return 'Unknown';
  const seconds = Math.floor(timestampMs / 1000);
  return `<t:${seconds}:F>`;
}

function buildMessageLogComponents({ title, messageId, channelId, author, createdTimestamp, content }) {
  const authorLabel = author
    ? `<@${author.id}> (${author.tag ?? author.username ?? 'Unknown'})`
    : 'Unknown';
  const headerLines = [
    title,
    `Author: ${authorLabel}`,
    `Channel: <#${channelId}>`,
    `Message ID: ${messageId}`,
    `Created: ${formatMessageTimestamp(createdTimestamp)}`
  ];
  const bodyLines = content ? [content] : [];

  return [
    {
      type: ComponentType.Container,
      components: [
        {
          type: ComponentType.TextDisplay,
          content: headerLines.join('\n')
        },
        {
          type: ComponentType.Separator,
          divider: true,
          spacing: SeparatorSpacingSize.Small
        },
        {
          type: ComponentType.TextDisplay,
          content: bodyLines.join('\n')
        }
      ]
    }
  ];
}

async function fetchMessageIfPartial(message) {
  if (!message?.partial) return message;
  try {
    return await message.fetch();
  } catch (error) {
    console.warn('Failed to fetch partial message:', error);
    return message;
  }
}

async function resolveLogChannel(clientInstance, guildId, channelId) {
  if (!guildId || !channelId) return null;
  try {
    const guild = await clientInstance.guilds.fetch(guildId);
    const channel = await guild.channels.fetch(channelId);
    if (channel && channel.isTextBased()) {
      return channel;
    }
  } catch (error) {
    console.warn(`Failed to resolve log channel ${channelId}:`, error);
  }
  return null;
}

function getRpsMoveLabel(move) {
  const meta = RPS_MOVE_META[move];
  return meta ? `${meta.emoji} ${meta.label}` : move;
}

function resolveRpsOutcome(challengerMove, opponentMove) {
  if (challengerMove === opponentMove) return 'draw';
  if (
    (challengerMove === 'rock' && opponentMove === 'scissors')
    || (challengerMove === 'paper' && opponentMove === 'rock')
    || (challengerMove === 'scissors' && opponentMove === 'paper')
  ) {
    return 'challenger';
  }
  return 'opponent';
}

function buildRpsMessageComponents(game, state) {
  const challengerMention = `<@${game.challengerId}>`;
  const opponentMention = game.opponentId ? `<@${game.opponentId}>` : 'Bot';
  const challengerMove = game.moves?.[game.challengerId] ?? null;
  const opponentMove = game.opponentId
    ? game.moves?.[game.opponentId] ?? null
    : game.moves?.bot ?? null;
  const isComplete = game.status === 'complete';
  const challengerStatus = challengerMove ? '✅' : '⏳';
  const opponentStatus = opponentMove ? '✅' : '⏳';
  const statusLine = isComplete
    ? '✅ Game finished.'
    : '🕹️ Make your choice!';
  const resultLines = [];

  if (isComplete) {
    const outcome = game.result?.outcome ?? 'draw';
    if (outcome === 'draw') {
      resultLines.push('**Result:** Draw 🤝');
    } else if (outcome === 'challenger') {
      resultLines.push(`**Result:** ${challengerMention} wins 🎉`);
    } else if (outcome === 'opponent') {
      resultLines.push(`**Result:** ${opponentMention} wins 🎉`);
    }
    if (challengerMove) {
      resultLines.push(`${challengerMention} played ${getRpsMoveLabel(challengerMove)}.`);
    }
    if (opponentMove) {
      resultLines.push(`${opponentMention} played ${getRpsMoveLabel(opponentMove)}.`);
    }
  }

  const scoreLines = [];
  const challengerScore = state.scores?.[game.challengerId];
  if (challengerScore) {
    scoreLines.push(
      `${challengerMention} — ✅ ${challengerScore.wins} | ❌ ${challengerScore.losses} | 🤝 ${challengerScore.draws}`
    );
  }
  if (game.opponentId) {
    const opponentScore = state.scores?.[game.opponentId];
    if (opponentScore) {
      scoreLines.push(
        `${opponentMention} — ✅ ${opponentScore.wins} | ❌ ${opponentScore.losses} | 🤝 ${opponentScore.draws}`
      );
    }
  }

  return [
    {
      type: ComponentType.Container,
      components: [
        {
          type: ComponentType.TextDisplay,
          content: [
            '🎮 **Rock Paper Scissors**',
            `Challenger: ${challengerMention} ${challengerStatus}`,
            `Opponent: ${opponentMention} ${opponentStatus}`,
            statusLine,
            '',
            ...resultLines,
            ...(resultLines.length ? [''] : []),
            ...(scoreLines.length ? ['**Scoreboard**', ...scoreLines] : [])
          ].filter(Boolean).join('\n')
        },
        {
          type: ComponentType.Separator,
          divider: true,
          spacing: SeparatorSpacingSize.Small
        },
        {
          type: ComponentType.ActionRow,
          components: RPS_MOVES.map((move) => ({
            type: ComponentType.Button,
            custom_id: `${RPS_CHOICE_PREFIX}${game.gameId}:${move}`,
            label: RPS_MOVE_META[move]?.label ?? move,
            style: ButtonStyle.Primary,
            disabled: isComplete
          }))
        }
      ]
    }
  ];
}

function ensureRpsState(state) {
  if (!state.active_games) {
    state.active_games = {};
  }
  if (!state.scores) {
    state.scores = {};
  }
  return state;
}

function ensurePingRoleState(state) {
  if (!state.available_roles) {
    state.available_roles = [];
  }
  if (!state.user_selections) {
    state.user_selections = {};
  }
  if (!state.channel_routes) {
    state.channel_routes = {};
  }
  return state;
}

function hasAdminPermission(member) {
  const storedRoleId = getPermissionRoleId(member.guild.id);
  return member.permissions.has(PermissionsBitField.Flags.Administrator)
    || (storedRoleId ? member.roles.cache.has(storedRoleId) : false);
}

function hasClanPanelPermission(member) {
  return hasAdminPermission(member);
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
            label: 'No clans are registered yet.',
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
              placeholder: `Select a clan (${guild.name})`,
              options: selectOptions,
              disabled: clans.length === 0
            }
          ]
        }
      ]
    }
  ];
}

function buildPingRoleSelectComponents(guild, state, memberId) {
  ensurePingRoleState(state);
  const availableRoleEntries = state.available_roles
    .map((roleId) => guild.roles.cache.get(roleId))
    .filter(Boolean);
  const selectedRoles = new Set(state.user_selections?.[memberId] ?? []);
  const limitedRoles = availableRoleEntries.slice(0, 25);
  const options = limitedRoles.length
    ? limitedRoles.map((role) => ({
        label: role.name,
        value: role.id,
        default: selectedRoles.has(role.id)
      }))
    : [
        {
          label: 'Žádné role nejsou k dispozici.',
          value: 'no_roles_available'
        }
      ];
  const maxValues = limitedRoles.length ? Math.min(limitedRoles.length, 25) : 1;
  const extraRolesCount = availableRoleEntries.length - limitedRoles.length;
  const descriptionLines = [
    'Vyber si ping role, které chceš používat.',
    extraRolesCount > 0 ? `Zobrazuji jen prvních 25 rolí (skryto ${extraRolesCount}).` : null
  ].filter(Boolean);

  return [
    {
      type: ComponentType.Container,
      components: [
        {
          type: ComponentType.TextDisplay,
          content: descriptionLines.join('\n')
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
              custom_id: PING_ROLES_SELECT_ID,
              placeholder: 'Vyber ping role',
              min_values: 0,
              max_values: maxValues,
              options,
              disabled: limitedRoles.length === 0
            }
          ]
        }
      ]
    }
  ];
}

function buildTicketSummary(answers, decision) {
  const decisionText = decision?.status
    ? `**Decision:** ${decision.status === CLAN_TICKET_DECISION_ACCEPT
      ? 'Accepted ✅'
      : decision.status === CLAN_TICKET_DECISION_REJECT
        ? 'Rejected ❌'
        : 'Removed 🗑️'}
**Reviewer:** <@${decision.decidedBy}>`
    : null;
  const disableButtons = Boolean(decision?.status);
  const disableRemove = decision?.status === CLAN_TICKET_DECISION_REMOVE;
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
            },
            {
              type: ComponentType.Button,
              custom_id: `${CLAN_TICKET_DECISION_PREFIX}${CLAN_TICKET_DECISION_REMOVE}`,
              label: 'Remove ticket',
              style: ButtonStyle.Secondary,
              disabled: disableRemove
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

function collectRoleOptionIds(options) {
  const roleIds = [];
  for (let i = 1; i <= 5; i += 1) {
    const role = options.getRole(`role_${i}`);
    if (role?.id) {
      roleIds.push(role.id);
    }
  }
  return roleIds;
}

function formatRoleList(roleIds) {
  if (!roleIds.length) {
    return 'Žádné role nejsou nastavené.';
  }
  return roleIds.map((roleId) => `• <@&${roleId}>`).join('\n');
}

function formatRouteList(routes) {
  const entries = Object.entries(routes ?? {});
  if (!entries.length) {
    return 'Žádné routy nejsou nastavené.';
  }
  return entries
    .map(([channelId, roleId]) => `• <#${channelId}> → <@&${roleId}>`)
    .join('\n');
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
  const state = getClanState(guildId);
  const panelConfig = state.clan_panel_configs;
  if (!panelConfig?.channelId || !panelConfig?.messageId) return;

  let channel;
  try {
    channel = await guild.channels.fetch(panelConfig.channelId);
  } catch (error) {
    console.warn(`Failed to fetch clan panel channel ${panelConfig.channelId}:`, error);
  }

  if (!channel || !channel.isTextBased()) {
    await updateClanState(guildId, (nextState) => {
      if (nextState.clan_panel_configs) {
        nextState.clan_panel_configs = {};
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
    await updateClanState(guildId, (nextState) => {
      if (nextState.clan_panel_configs) {
        nextState.clan_panel_configs = {};
      }
    });
    return;
  }

  const clanMap = state.clan_clans ?? {};
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
  const invalidGuildIds = [];
  const guildIds = readyClient.guilds.cache.map((guild) => guild.id);

  for (const guildId of guildIds) {
    const state = getClanState(guildId);
    const config = state.clan_panel_configs;
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

    const clanMap = state.clan_clans ?? {};
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
    for (const guildId of invalidGuildIds) {
      await updateClanState(guildId, (nextState) => {
        if (nextState.clan_panel_configs) {
          nextState.clan_panel_configs = {};
        }
      });
    }
  }
}

function ensureGuildClanState(state) {
  if (!state.clan_clans) {
    state.clan_clans = {};
  }
  if (!state.clan_panel_configs) {
    state.clan_panel_configs = {};
  }
  if (!state.clan_ticket_reminders) {
    state.clan_ticket_reminders = {};
  }
  if (!state.clan_ticket_decisions) {
    state.clan_ticket_decisions = {};
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

client.on(Events.MessageCreate, async (message) => {
  if (!message.inGuild()) return;
  if (message.author?.bot) return;
  if (message.channel?.type !== ChannelType.GuildText) return;

  const state = getPingRoleState(message.guild.id);
  ensurePingRoleState(state);
  const roleId = state.channel_routes?.[message.channel.id];
  if (!roleId) return;

  const contentParts = [`<@&${roleId}>`];
  if (message.content) {
    contentParts.push(message.content);
  }
  const files = message.attachments?.size
    ? message.attachments.map((attachment) => ({
        attachment: attachment.url,
        name: attachment.name ?? undefined
      }))
    : [];

  try {
    await message.delete();
  } catch (error) {
    console.warn('Failed to delete routed message:', error);
  }

  try {
    await message.channel.send({
      content: contentParts.join(' '),
      files,
      allowedMentions: {
        roles: [roleId],
        users: [],
        repliedUser: false
      }
    });
  } catch (error) {
    console.warn('Failed to relay routed message:', error);
  }
});

client.on(Events.MessageDelete, async (message) => {
  if (!message.guildId) return;
  const config = getLogConfig(message.guildId);
  const logChannelId = config?.channelId ?? null;
  if (!logChannelId) return;
  if (message.channelId === logChannelId) return;

  const resolvedMessage = await fetchMessageIfPartial(message);
  const author = resolvedMessage.author ?? null;
  if (author?.bot) return;

  const logChannel = await resolveLogChannel(client, message.guildId, logChannelId);
  if (!logChannel) return;

  const components = buildMessageLogComponents({
    title: '🗑️ **Message deleted**',
    messageId: resolvedMessage.id ?? message.id,
    channelId: resolvedMessage.channelId ?? message.channelId,
    author,
    createdTimestamp: resolvedMessage.createdTimestamp ?? null,
    content: `**Content:** ${formatLogContent(resolvedMessage.content)}`
  });

  try {
    await logChannel.send({
      components,
      flags: MessageFlags.IsComponentsV2
    });
  } catch (error) {
    console.warn('Failed to send message delete log:', error);
  }
});

client.on(Events.MessageUpdate, async (oldMessage, newMessage) => {
  const guildId = newMessage.guildId ?? oldMessage.guildId;
  if (!guildId) return;
  const config = getLogConfig(guildId);
  const logChannelId = config?.channelId ?? null;
  if (!logChannelId) return;
  const sourceChannelId = newMessage.channelId ?? oldMessage.channelId;
  if (sourceChannelId === logChannelId) return;

  const resolvedOldMessage = await fetchMessageIfPartial(oldMessage);
  const resolvedNewMessage = await fetchMessageIfPartial(newMessage);
  const author = resolvedNewMessage.author ?? resolvedOldMessage.author ?? null;
  if (author?.bot) return;

  const logChannel = await resolveLogChannel(client, guildId, logChannelId);
  if (!logChannel) return;

  const beforeContent = formatLogContent(resolvedOldMessage.content);
  const afterContent = formatLogContent(resolvedNewMessage.content);
  const components = buildMessageLogComponents({
    title: '✏️ **Message updated**',
    messageId: resolvedNewMessage.id ?? resolvedOldMessage.id ?? newMessage.id ?? oldMessage.id,
    channelId: resolvedNewMessage.channelId ?? resolvedOldMessage.channelId ?? sourceChannelId,
    author,
    createdTimestamp: resolvedNewMessage.createdTimestamp ?? resolvedOldMessage.createdTimestamp ?? null,
    content: `**Before:** ${beforeContent}\n\n**After:** ${afterContent}`
  });

  try {
    await logChannel.send({
      components,
      flags: MessageFlags.IsComponentsV2
    });
  } catch (error) {
    console.warn('Failed to send message update log:', error);
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
        const state = getClanState(interaction.guildId);
        const clan = state.clan_clans?.[clanName];
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

        await updateClanState(interaction.guildId, (state) => {
          ensureGuildClanState(state);
          state.clan_ticket_decisions[ticketChannel.id] = {
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

      await updateClanState(interaction.guildId, (state) => {
        ensureGuildClanState(state);
        state.clan_panel_configs = {
          ...state.clan_panel_configs,
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
      if (interaction.customId === PING_ROLES_SELECT_ID) {
        if (!interaction.inGuild() || !(interaction.member instanceof GuildMember)) {
          await interaction.reply({
            components: buildTextComponents('Tento výběr lze použít jen na serveru.'),
            flags: MessageFlags.IsComponentsV2,
            ephemeral: true
          });
          return;
        }

        const state = getPingRoleState(interaction.guildId);
        ensurePingRoleState(state);
        const availableRoles = new Set(state.available_roles);
        const previousSelections = Array.isArray(state.user_selections?.[interaction.member.id])
          ? state.user_selections[interaction.member.id]
          : [];
        const filteredPreviousSelections = previousSelections.filter((roleId) => availableRoles.has(roleId));
        const selectedRoleIds = interaction.values.filter((roleId) => availableRoles.has(roleId));
        const invalidSelections = interaction.values.filter((roleId) => !availableRoles.has(roleId));

        await updatePingRoleState(interaction.guildId, (nextState) => {
          ensurePingRoleState(nextState);
          nextState.user_selections[interaction.member.id] = selectedRoleIds;
        });

        const selectedSet = new Set(selectedRoleIds);
        const previousSet = new Set(filteredPreviousSelections);
        const rolesToAdd = selectedRoleIds.filter((roleId) => !previousSet.has(roleId));
        const rolesToRemove = filteredPreviousSelections.filter((roleId) => !selectedSet.has(roleId));

        try {
          if (rolesToAdd.length) {
            await interaction.member.roles.add(rolesToAdd);
          }
          if (rolesToRemove.length) {
            await interaction.member.roles.remove(rolesToRemove);
          }
        } catch (error) {
          console.error('Failed to update ping roles for member:', error);
          await interaction.reply({
            components: buildTextComponents('Nepodařilo se upravit role.'),
            flags: MessageFlags.IsComponentsV2,
            ephemeral: true
          });
          return;
        }

        const responseLines = [
          'Tvůj výběr byl uložen.',
          rolesToAdd.length ? `Přidáno rolí: ${rolesToAdd.length}.` : null,
          rolesToRemove.length ? `Odebráno rolí: ${rolesToRemove.length}.` : null,
          invalidSelections.length ? 'Některé vybrané role nejsou dostupné.' : null
        ].filter(Boolean);

        await interaction.reply({
          components: buildTextComponents(responseLines.join('\n')),
          flags: MessageFlags.IsComponentsV2,
          ephemeral: true
        });
        return;
      }

      if (interaction.customId !== CLAN_PANEL_SELECT_ID) return;
      if (!interaction.inGuild() || !(interaction.member instanceof GuildMember)) {
        await interaction.reply({
          components: buildTextComponents('This selection can only be used in a server.'),
          flags: MessageFlags.IsComponentsV2,
          ephemeral: true
        });
        return;
      }

      const selectedClan = interaction.values[0];
      if (!selectedClan || selectedClan === 'no_clans_available') {
        await interaction.reply({
          components: buildTextComponents('No clans are available to select.'),
          flags: MessageFlags.IsComponentsV2,
          ephemeral: true
        });
        return;
      }

      const state = getClanState(interaction.guildId);
      const clan = state.clan_clans?.[selectedClan];
      if (!clan) {
        await interaction.reply({
          components: buildTextComponents('The selected clan was not found.'),
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
      if (interaction.customId.startsWith(RPS_CHOICE_PREFIX)) {
        if (!interaction.inGuild() || !(interaction.member instanceof GuildMember)) {
          await interaction.reply({
            components: buildTextComponents('Tuto akci lze použít jen na serveru.'),
            flags: MessageFlags.IsComponentsV2,
            ephemeral: true
          });
          return;
        }

        const parts = interaction.customId.split(':');
        const gameId = parts[2];
        const move = parts[3];
        if (!gameId || !RPS_MOVES.includes(move)) {
          await interaction.reply({
            components: buildTextComponents('Neplatná volba pro RPS.'),
            flags: MessageFlags.IsComponentsV2,
            ephemeral: true
          });
          return;
        }

        const state = getRpsState(interaction.guildId);
        ensureRpsState(state);
        const game = state.active_games?.[gameId];
        if (!game) {
          await interaction.reply({
            components: buildTextComponents('Tato hra už není aktivní.'),
            flags: MessageFlags.IsComponentsV2,
            ephemeral: true
          });
          return;
        }

        const allowedPlayers = [game.challengerId, game.opponentId].filter(Boolean);
        if (!allowedPlayers.includes(interaction.user.id)) {
          await interaction.reply({
            components: buildTextComponents('Do této hry nejsi zapojen.'),
            flags: MessageFlags.IsComponentsV2,
            ephemeral: true
          });
          return;
        }

        if (game.status === 'complete') {
          await interaction.reply({
            components: buildTextComponents('Tato hra už byla dokončena.'),
            flags: MessageFlags.IsComponentsV2,
            ephemeral: true
          });
          return;
        }

        if (game.moves?.[interaction.user.id]) {
          await interaction.reply({
            components: buildTextComponents('Své rozhodnutí už jsi poslal.'),
            flags: MessageFlags.IsComponentsV2,
            ephemeral: true
          });
          return;
        }

        await updateRpsState(interaction.guildId, (nextState) => {
          ensureRpsState(nextState);
          const activeGame = nextState.active_games?.[gameId];
          if (!activeGame) return;
          activeGame.moves = activeGame.moves ?? {};
          activeGame.moves[interaction.user.id] = move;
          activeGame.updatedAt = new Date().toISOString();

          if (!activeGame.opponentId) {
            const botMove = RPS_MOVES[Math.floor(Math.random() * RPS_MOVES.length)];
            activeGame.moves.bot = botMove;
          }

          const challengerMove = activeGame.moves?.[activeGame.challengerId];
          const opponentMove = activeGame.opponentId
            ? activeGame.moves?.[activeGame.opponentId]
            : activeGame.moves?.bot;

          if (challengerMove && opponentMove) {
            const outcome = resolveRpsOutcome(challengerMove, opponentMove);
            activeGame.status = 'complete';
            activeGame.result = {
              outcome,
              challengerMove,
              opponentMove
            };
            activeGame.completedAt = new Date().toISOString();

            const ensureScore = (userId) => {
              if (!userId) return null;
              if (!nextState.scores[userId]) {
                nextState.scores[userId] = { wins: 0, losses: 0, draws: 0 };
              }
              return nextState.scores[userId];
            };

            const challengerScore = ensureScore(activeGame.challengerId);
            const opponentScore = activeGame.opponentId ? ensureScore(activeGame.opponentId) : null;

            if (outcome === 'draw') {
              if (challengerScore) challengerScore.draws += 1;
              if (opponentScore) opponentScore.draws += 1;
            } else if (outcome === 'challenger') {
              if (challengerScore) challengerScore.wins += 1;
              if (opponentScore) opponentScore.losses += 1;
            } else if (outcome === 'opponent') {
              if (challengerScore) challengerScore.losses += 1;
              if (opponentScore) opponentScore.wins += 1;
            }

            const now = new Date().toISOString();
            if (challengerScore) challengerScore.updatedAt = now;
            if (opponentScore) opponentScore.updatedAt = now;
          }

          nextState.last_message = {
            channelId: activeGame.channelId ?? interaction.channelId,
            messageId: activeGame.messageId ?? interaction.message?.id ?? null,
            updatedAt: new Date().toISOString()
          };
        });

        const updatedState = getRpsState(interaction.guildId);
        const updatedGame = updatedState.active_games?.[gameId];
        if (!updatedGame) {
          await interaction.reply({
            components: buildTextComponents('Tato hra už není dostupná.'),
            flags: MessageFlags.IsComponentsV2,
            ephemeral: true
          });
          return;
        }

        await interaction.update({
          components: buildRpsMessageComponents(updatedGame, updatedState),
          flags: MessageFlags.IsComponentsV2
        });
        return;
      }

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
      if (![CLAN_TICKET_DECISION_TOGGLE, CLAN_TICKET_DECISION_ACCEPT, CLAN_TICKET_DECISION_REJECT, CLAN_TICKET_DECISION_REMOVE]
        .includes(action)) {
        await interaction.reply({
          components: buildTextComponents('Neplatná akce pro ticket.'),
          flags: MessageFlags.IsComponentsV2,
          ephemeral: true
        });
        return;
      }

      const state = getClanState(interaction.guildId);
      const ticketEntry = state.clan_ticket_decisions?.[interaction.channelId];
      if (!ticketEntry) {
        await interaction.reply({
          components: buildTextComponents('Ticket nebyl nalezen nebo už není aktivní.'),
          flags: MessageFlags.IsComponentsV2,
          ephemeral: true
        });
        return;
      }

      const clan = state.clan_clans?.[ticketEntry.clanName];
      if (!clan) {
        await interaction.reply({
          components: buildTextComponents('Klan pro tento ticket nebyl nalezen.'),
          flags: MessageFlags.IsComponentsV2,
          ephemeral: true
        });
        return;
      }

      const hasReviewPermission = hasAdminPermission(interaction.member)
        || Boolean(clan.reviewRoleId && interaction.member.roles.cache.has(clan.reviewRoleId));
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
        await updateClanState(interaction.guildId, (nextState) => {
          ensureGuildClanState(nextState);
          const entry = nextState.clan_ticket_decisions[interaction.channelId];
          if (!entry) return;
          entry.controlsExpanded = !entry.controlsExpanded;
        });

        const refreshedState = getClanState(interaction.guildId);
        const refreshedEntry = refreshedState.clan_ticket_decisions?.[interaction.channelId];
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

      if (ticketEntry.status && action !== CLAN_TICKET_DECISION_REMOVE) {
        await interaction.reply({
          components: buildTextComponents('O tomto ticketu už bylo rozhodnuto.'),
          flags: MessageFlags.IsComponentsV2,
          ephemeral: true
        });
        return;
      }

      const updatedAt = new Date().toISOString();
      await updateClanState(interaction.guildId, (nextState) => {
        ensureGuildClanState(nextState);
        const entry = nextState.clan_ticket_decisions[interaction.channelId];
        if (!entry) return;
        entry.status = action;
        entry.decidedBy = interaction.user.id;
        entry.updatedAt = updatedAt;
      });

      if (action === CLAN_TICKET_DECISION_REMOVE) {
        const refreshedState = getClanState(interaction.guildId);
        const refreshedEntry = refreshedState.clan_ticket_decisions?.[interaction.channelId];
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

        if (interaction.channel) {
          try {
            await interaction.channel.delete('Clan ticket removed.');
          } catch (error) {
            console.warn('Failed to delete removed ticket channel:', error);
          }
        }

        await interaction.reply({
          components: buildTextComponents('Ticket byl odstraněn.'),
          flags: MessageFlags.IsComponentsV2,
          ephemeral: true
        });
        return;
      }

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

      const refreshedState = getClanState(interaction.guildId);
      const refreshedEntry = refreshedState.clan_ticket_decisions?.[interaction.channelId];
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
            ? `<@${refreshedEntry.applicantId}> Ticket was accepted.`
            : `<@${refreshedEntry.applicantId}> Ticket was rejected.`
        ),
        flags: MessageFlags.IsComponentsV2,
        ephemeral: true
      });
      return;
    }

    if (!interaction.isChatInputCommand()) return;

    if (interaction.commandName === 'rps') {
      if (!interaction.inGuild() || !(interaction.member instanceof GuildMember)) {
        await interaction.reply({
          components: buildTextComponents('Tento příkaz lze použít jen na serveru.'),
          flags: MessageFlags.IsComponentsV2,
          ephemeral: true
        });
        return;
      }

      const subcommand = interaction.options.getSubcommand(true);
      if (subcommand === 'play') {
        const opponent = interaction.options.getUser('opponent');
        if (opponent && opponent.id === interaction.user.id) {
          await interaction.reply({
            components: buildTextComponents('Nemůžeš hrát sám se sebou.'),
            flags: MessageFlags.IsComponentsV2,
            ephemeral: true
          });
          return;
        }

        if (opponent?.bot && opponent.id !== client.user?.id) {
          await interaction.reply({
            components: buildTextComponents('S jinými boty se hrát nedá.'),
            flags: MessageFlags.IsComponentsV2,
            ephemeral: true
          });
          return;
        }

        const gameId = interaction.id;
        const game = {
          gameId,
          channelId: interaction.channelId,
          messageId: null,
          challengerId: interaction.user.id,
          opponentId: opponent?.id ?? null,
          moves: {},
          status: 'pending',
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString()
        };

        await updateRpsState(interaction.guildId, (state) => {
          ensureRpsState(state);
          state.active_games[gameId] = game;
        });

        const response = await interaction.reply({
          components: buildRpsMessageComponents(game, getRpsState(interaction.guildId)),
          flags: MessageFlags.IsComponentsV2,
          fetchReply: true
        });

        await updateRpsState(interaction.guildId, (state) => {
          ensureRpsState(state);
          const activeGame = state.active_games?.[gameId];
          if (!activeGame) return;
          activeGame.messageId = response?.id ?? null;
          activeGame.channelId = response?.channelId ?? interaction.channelId;
          activeGame.updatedAt = new Date().toISOString();
          state.last_message = {
            channelId: activeGame.channelId,
            messageId: activeGame.messageId,
            updatedAt: new Date().toISOString()
          };
        });
        return;
      }

      if (subcommand === 'stats') {
        const state = getRpsState(interaction.guildId);
        ensureRpsState(state);
        const entries = Object.entries(state.scores ?? {});
        const sorted = entries.sort(([, a], [, b]) => {
          const winDiff = (b.wins ?? 0) - (a.wins ?? 0);
          if (winDiff !== 0) return winDiff;
          const lossDiff = (a.losses ?? 0) - (b.losses ?? 0);
          if (lossDiff !== 0) return lossDiff;
          return (b.draws ?? 0) - (a.draws ?? 0);
        });

        const lines = sorted.length
          ? sorted.slice(0, 10).map(([userId, score], index) => (
            `${index + 1}. <@${userId}> — ✅ ${score.wins ?? 0} | ❌ ${score.losses ?? 0} | 🤝 ${score.draws ?? 0}`
          ))
          : ['Zatím tu nejsou žádné odehrané hry.'];

        await interaction.reply({
          components: buildTextComponents(['🏆 **RPS Statistiky**', '', ...lines].join('\n')),
          flags: MessageFlags.IsComponentsV2
        });
        return;
      }

      if (subcommand === 'reset') {
        await updateRpsState(interaction.guildId, (state) => {
          state.active_games = {};
          state.scores = {};
          state.last_message = {
            channelId: null,
            messageId: null,
            updatedAt: new Date().toISOString()
          };
        });

        await interaction.reply({
          components: buildTextComponents('RPS statistiky byly resetovány.'),
          flags: MessageFlags.IsComponentsV2,
          ephemeral: true
        });
      }
      return;
    }

    if (interaction.commandName === 'config') {
      if (!interaction.inGuild() || !(interaction.member instanceof GuildMember)) {
        await interaction.reply({
          components: buildTextComponents('Tento příkaz lze použít jen na serveru.'),
          flags: MessageFlags.IsComponentsV2,
          ephemeral: true
        });
        return;
      }

      if (!hasAdminPermission(interaction.member)) {
        await interaction.reply({
          components: buildTextComponents('Nemáš oprávnění použít tento příkaz.'),
          flags: MessageFlags.IsComponentsV2,
          ephemeral: true
        });
        return;
      }

      const subcommand = interaction.options.getSubcommand();
      if (subcommand === 'permissions') {
        const role = interaction.options.getRole('role');
        const storedRoleId = await setPermissionRoleId(interaction.guildId, role?.id ?? null);
        const response = storedRoleId
          ? `Role pro oprávnění byla nastavena na <@&${storedRoleId}>.`
          : 'Role pro oprávnění byla odstraněna.';
        await interaction.reply({
          components: buildTextComponents(response),
          flags: MessageFlags.IsComponentsV2,
          ephemeral: true
        });
        return;
      }
      if (subcommand === 'logs') {
        const channel = interaction.options.getChannel('channel');
        if (channel && channel.type !== ChannelType.GuildText) {
          await interaction.reply({
            components: buildTextComponents('Prosím vyber textový kanál.'),
            flags: MessageFlags.IsComponentsV2,
            ephemeral: true
          });
          return;
        }

        const storedChannelId = channel?.id ?? null;
        setLogConfig(interaction.guildId, { channelId: storedChannelId });

        const response = storedChannelId
          ? `Logovací kanál byl nastaven na <#${storedChannelId}>.`
          : 'Logovací kanál byl odstraněn.';
        await interaction.reply({
          components: buildTextComponents(response),
          flags: MessageFlags.IsComponentsV2,
          ephemeral: true
        });
        return;
      }
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

    if (interaction.commandName === 'ping_roles') {
      if (!interaction.inGuild() || !(interaction.member instanceof GuildMember)) {
        await interaction.reply({
          components: buildTextComponents('Tento příkaz lze použít jen na serveru.'),
          flags: MessageFlags.IsComponentsV2,
          ephemeral: true
        });
        return;
      }

      const directSubcommand = interaction.options.getSubcommand(false);
      if (directSubcommand === 'choose') {
        const state = getPingRoleState(interaction.guildId);
        ensurePingRoleState(state);
        await interaction.reply({
          components: buildPingRoleSelectComponents(
            interaction.guild,
            state,
            interaction.member.id
          ),
          flags: MessageFlags.IsComponentsV2,
          ephemeral: true
        });
        return;
      }

      if (!hasAdminPermission(interaction.member)) {
        await interaction.reply({
          components: buildTextComponents('Nemáš oprávnění použít tento příkaz.'),
          flags: MessageFlags.IsComponentsV2,
          ephemeral: true
        });
        return;
      }

      const subcommandGroup = interaction.options.getSubcommandGroup(true);
      const subcommand = interaction.options.getSubcommand(true);

      if (subcommandGroup === 'roles') {
        const roleIds = collectRoleOptionIds(interaction.options);

        if (subcommand === 'set') {
          await updatePingRoleState(interaction.guildId, (state) => {
            ensurePingRoleState(state);
            const uniqueRoles = Array.from(new Set(roleIds));
            state.available_roles = uniqueRoles;
            const allowed = new Set(uniqueRoles);
            for (const channelId of Object.keys(state.channel_routes)) {
              if (!allowed.has(state.channel_routes[channelId])) {
                delete state.channel_routes[channelId];
              }
            }
          });

          await interaction.reply({
            components: buildTextComponents(
              roleIds.length
                ? `Dostupné role byly nastaveny (${roleIds.length}).`
                : 'Seznam rolí byl vymazán.'
            ),
            flags: MessageFlags.IsComponentsV2,
            ephemeral: true
          });
          return;
        }

        if (subcommand === 'add') {
          if (!roleIds.length) {
            await interaction.reply({
              components: buildTextComponents('Vyber alespoň jednu roli pro přidání.'),
              flags: MessageFlags.IsComponentsV2,
              ephemeral: true
            });
            return;
          }

          await updatePingRoleState(interaction.guildId, (state) => {
            ensurePingRoleState(state);
            const existing = new Set(state.available_roles);
            for (const roleId of roleIds) {
              if (!existing.has(roleId)) {
                state.available_roles.push(roleId);
                existing.add(roleId);
              }
            }
          });

          await interaction.reply({
            components: buildTextComponents(`Role byly přidány (${roleIds.length}).`),
            flags: MessageFlags.IsComponentsV2,
            ephemeral: true
          });
          return;
        }

        if (subcommand === 'remove') {
          if (!roleIds.length) {
            await interaction.reply({
              components: buildTextComponents('Vyber alespoň jednu roli pro odebrání.'),
              flags: MessageFlags.IsComponentsV2,
              ephemeral: true
            });
            return;
          }

          await updatePingRoleState(interaction.guildId, (state) => {
            ensurePingRoleState(state);
            const toRemove = new Set(roleIds);
            state.available_roles = state.available_roles.filter((roleId) => !toRemove.has(roleId));
            for (const channelId of Object.keys(state.channel_routes)) {
              if (toRemove.has(state.channel_routes[channelId])) {
                delete state.channel_routes[channelId];
              }
            }
          });

          await interaction.reply({
            components: buildTextComponents(`Role byly odebrány (${roleIds.length}).`),
            flags: MessageFlags.IsComponentsV2,
            ephemeral: true
          });
          return;
        }

        if (subcommand === 'list') {
          const state = getPingRoleState(interaction.guildId);
          ensurePingRoleState(state);
          await interaction.reply({
            components: buildTextComponents(formatRoleList(state.available_roles)),
            flags: MessageFlags.IsComponentsV2,
            ephemeral: true
          });
          return;
        }
      }

      if (subcommandGroup === 'route') {
        if (subcommand === 'set') {
          const channel = interaction.options.getChannel('channel', true);
          const role = interaction.options.getRole('role', true);
          if (!channel || channel.type !== ChannelType.GuildText) {
            await interaction.reply({
              components: buildTextComponents('Prosím vyber textový kanál.'),
              flags: MessageFlags.IsComponentsV2,
              ephemeral: true
            });
            return;
          }

          const state = getPingRoleState(interaction.guildId);
          ensurePingRoleState(state);
          if (!state.available_roles.includes(role.id)) {
            await interaction.reply({
              components: buildTextComponents('Tato role není v seznamu dostupných rolí.'),
              flags: MessageFlags.IsComponentsV2,
              ephemeral: true
            });
            return;
          }

          await updatePingRoleState(interaction.guildId, (nextState) => {
            ensurePingRoleState(nextState);
            nextState.channel_routes[channel.id] = role.id;
          });

          await interaction.reply({
            components: buildTextComponents(`Routa nastavena: <#${channel.id}> → <@&${role.id}>.`),
            flags: MessageFlags.IsComponentsV2,
            ephemeral: true
          });
          return;
        }

        if (subcommand === 'remove') {
          const channel = interaction.options.getChannel('channel', true);
          if (!channel || channel.type !== ChannelType.GuildText) {
            await interaction.reply({
              components: buildTextComponents('Prosím vyber textový kanál.'),
              flags: MessageFlags.IsComponentsV2,
              ephemeral: true
            });
            return;
          }

          let removed = false;
          await updatePingRoleState(interaction.guildId, (state) => {
            ensurePingRoleState(state);
            if (state.channel_routes[channel.id]) {
              delete state.channel_routes[channel.id];
              removed = true;
            }
          });

          await interaction.reply({
            components: buildTextComponents(
              removed
                ? `Routa pro <#${channel.id}> byla odstraněna.`
                : 'Pro tento kanál není žádná routa.'
            ),
            flags: MessageFlags.IsComponentsV2,
            ephemeral: true
          });
          return;
        }

        if (subcommand === 'list') {
          const state = getPingRoleState(interaction.guildId);
          ensurePingRoleState(state);
          await interaction.reply({
            components: buildTextComponents(formatRouteList(state.channel_routes)),
            flags: MessageFlags.IsComponentsV2,
            ephemeral: true
          });
        }
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

          await updateClanState(guildId, (state) => {
            ensureGuildClanState(state);
            const entry = state.clan_clans;
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

          await updateClanState(guildId, (state) => {
            ensureGuildClanState(state);
            const entry = state.clan_clans;
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

          await updateClanState(guildId, (state) => {
            ensureGuildClanState(state);
            if (state.clan_clans[name]) {
              delete state.clan_clans[name];
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
          const state = getClanState(guildId);
          const clans = sortClansForDisplay(Object.values(state.clan_clans ?? {}));
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
        const state = getClanState(guildId);
        const panelDescription = state.clan_panel_configs?.description ?? '';
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

        const state = getClanState(guildId);
        const clanMap = state.clan_clans ?? {};
        const panelDescription = state.clan_panel_configs?.description ?? null;
        const panelMessage = await channel.send({
          components: buildClanPanelComponents(interaction.guild, clanMap, panelDescription),
          flags: MessageFlags.IsComponentsV2
        });

        await updateClanState(guildId, (nextState) => {
          ensureGuildClanState(nextState);
          nextState.clan_panel_configs = {
            ...nextState.clan_panel_configs,
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
        await updateClanState(guildId, (state) => {
          ensureGuildClanState(state);
          state.clan_ticket_reminders = {
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

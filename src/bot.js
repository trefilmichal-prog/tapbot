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
  getPingRolePanelConfig,
  getPrivateMessageState,
  getRpsState,
  getPermissionRoleId,
  getWelcomeConfig,
  getNotificationForwardConfig,
  setLogConfig,
  setNotificationForwardConfig,
  setPingRolePanelConfig,
  setPermissionRoleId,
  setWelcomeConfig,
  updateClanState,
  updatePrivateMessageState,
  updatePingRoleState,
  updateRpsState
} from './persistence.js';
import { runUpdate } from './update.js';
import { syncApplicationCommands } from './deploy-commands.js';
import { readWindowsToastNotifications } from './windows-notifications.js';
import {
  checkWinRtBridgeAvailability,
  onWinRtBridgeConnectionState,
  onWinRtBridgeEvent,
  startWinRtNotificationPush
} from './winrt-notifications-bridge.js';

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
const CLAN_TICKET_ROBLOX_NICK_INPUT_ID = 'clan_ticket_roblox_nick_input';
const CLAN_TICKET_DECISION_PREFIX = 'clan_ticket_decision:';
const CLAN_TICKET_PRIVATE_DECISION_PREFIX = 'clan_ticket_private_decision:';
const CLAN_TICKET_PUBLIC_MENU_ID = 'clan_ticket_public_menu_open';
const CLAN_TICKET_REASSIGN_PREFIX = 'clan_ticket_reassign:';
const CLAN_TICKET_DECISION_ACCEPT = 'accept';
const CLAN_TICKET_DECISION_REJECT = 'reject';
const CLAN_TICKET_DECISION_REMOVE = 'remove';
const CLAN_TICKET_DECISION_REASSIGN = 'reassign';
const TICKET_MOVE_COOLDOWN_MS = 10 * 60 * 1000;
const PING_ROLES_SELECT_ID = 'ping_roles_select';
const PRIVATE_MESSAGE_READ_PREFIX = 'pm:read:';
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

function buildPrivateMessageCreatedComponents({ fromUserId, toUserId }) {
  return [
    {
      type: ComponentType.Container,
      components: [
        {
          type: ComponentType.TextDisplay,
          content: '✉️ **New private message**'
        },
        {
          type: ComponentType.TextDisplay,
          content: `From: <@${fromUserId}>\nTo: <@${toUserId}>\nClick Read to view the message content.`
        }
      ]
    }
  ];
}

function buildPrivateMessageReadButton(messageId) {
  return [
    {
      type: ComponentType.ActionRow,
      components: [
        {
          type: ComponentType.Button,
          custom_id: `${PRIVATE_MESSAGE_READ_PREFIX}${messageId}`,
          label: 'Read',
          style: ButtonStyle.Primary
        }
      ]
    }
  ];
}

function buildPrivateMessageContentComponents(entry) {
  return [
    {
      type: ComponentType.Container,
      components: [
        {
          type: ComponentType.TextDisplay,
          content: '✉️ **Private message content**'
        },
        {
          type: ComponentType.TextDisplay,
          content: `From: <@${entry.fromUserId}>\nTo: <@${entry.toUserId}>\n\n${entry.content}`
        }
      ]
    }
  ];
}

client.on(Events.ClientReady, (readyClient) => {
  console.log(`Logged in as ${readyClient.user.tag}`);
  (async () => {
    try {
      await logWinRtBridgeStatus();
      await refreshClanPanelsOnStartup(readyClient);
      await refreshPingRolePanelsOnStartup(readyClient);
      await startNotificationForwardPolling(readyClient);
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

async function logWinRtBridgeStatus() {
  if (process.platform !== 'win32') {
    return;
  }

  const status = await checkWinRtBridgeAvailability();
  if (status.available) {
    console.log(`WINRT notification helper ready: ${status.helperPath}`);
    return;
  }

  console.warn(`WINRT notification helper unavailable: ${status.reason}`);
}

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

function sanitizeMentionLikeTokens(content) {
  if (content === null || typeof content === 'undefined') {
    return content;
  }

  return String(content)
    .replace(/<@([!&]?\d+)>/g, '<@\u200b$1>')
    .replace(/@everyone/g, '@\u200beveryone')
    .replace(/@here/g, '@\u200bhere');
}

function formatLogAuthorLabel(author) {
  if (!author) return 'Unknown';
  const username = author.tag ?? author.username ?? 'Unknown';
  return `${username} (ID: ${author.id})`;
}

function formatMessageTimestamp(timestampMs) {
  if (!Number.isFinite(timestampMs)) return 'Unknown';
  const seconds = Math.floor(timestampMs / 1000);
  return `<t:${seconds}:F>`;
}

function formatNotificationTimestamp(isoTimestamp) {
  if (!isoTimestamp) return 'Unknown';
  const parsed = new Date(isoTimestamp);
  if (Number.isNaN(parsed.getTime())) return 'Unknown';
  return `<t:${Math.floor(parsed.getTime() / 1000)}:R>`;
}

function normalizeTicketDecisionStatus(status) {
  if (!status || status === 'awaiting') return 'awaiting';
  if (status === CLAN_TICKET_DECISION_ACCEPT) return CLAN_TICKET_DECISION_ACCEPT;
  if (status === CLAN_TICKET_DECISION_REJECT) return CLAN_TICKET_DECISION_REJECT;
  if (status === CLAN_TICKET_DECISION_REMOVE) return CLAN_TICKET_DECISION_REMOVE;
  return 'awaiting';
}

function formatTicketDecisionStatusLabel(status) {
  const normalizedStatus = normalizeTicketDecisionStatus(status);
  if (normalizedStatus === CLAN_TICKET_DECISION_ACCEPT) return 'Accepted ✅';
  if (normalizedStatus === CLAN_TICKET_DECISION_REJECT) return 'Rejected ❌';
  if (normalizedStatus === CLAN_TICKET_DECISION_REMOVE) return 'Removed 🗑️';
  return 'Awaiting 🟡';
}

function formatTicketDecisionTimestamp(isoTimestamp) {
  if (!isoTimestamp) return 'Unknown';
  const parsed = new Date(isoTimestamp);
  if (Number.isNaN(parsed.getTime())) return 'Unknown';
  const seconds = Math.floor(parsed.getTime() / 1000);
  return `<t:${seconds}:F> (<t:${seconds}:R>)`;
}

function hasSettingsOverviewPermission(member, state) {
  if (hasAdminPermission(member)) {
    return true;
  }

  const candidateRoleIds = new Set();
  for (const entry of Object.values(state?.clan_ticket_decisions ?? {})) {
    if (entry?.activeReviewRoleId) {
      candidateRoleIds.add(entry.activeReviewRoleId);
    }
  }
  for (const clan of Object.values(state?.clan_clans ?? {})) {
    if (clan?.reviewRoleId) {
      candidateRoleIds.add(clan.reviewRoleId);
    }
  }

  for (const roleId of candidateRoleIds) {
    if (member.roles.cache.has(roleId)) {
      return true;
    }
  }
  return false;
}

function resolveTicketReviewRoleId(state, entry) {
  if (!entry) return null;
  if (entry.activeReviewRoleId) {
    return entry.activeReviewRoleId;
  }
  const clan = state?.clan_clans?.[entry.clanName];
  return clan?.reviewRoleId ?? null;
}

function canMemberViewTicketInOverview(member, state, entry) {
  if (hasAdminPermission(member)) {
    return true;
  }
  const reviewRoleId = resolveTicketReviewRoleId(state, entry);
  return Boolean(reviewRoleId && member.roles.cache.has(reviewRoleId));
}

function buildTicketOverviewComponents(ticketEntries, filters = {}) {
  const headerLines = [
    '📋 **Ticket overview**',
    `Total entries: **${ticketEntries.length}**`
  ];

  const filterLines = [];
  if (filters.statusFilter) {
    filterLines.push(`Status filter: **${formatTicketDecisionStatusLabel(filters.statusFilter)}**`);
  }
  if (filters.clanFilter) {
    filterLines.push(`Clan filter: **${filters.clanFilter}**`);
  }

  const bodyLines = ticketEntries.map(([channelId, entry], index) => {
    const status = normalizeTicketDecisionStatus(entry?.status);
    const reviewerId = entry?.decidedBy ? `<@${entry.decidedBy}>` : '—';
    const decisionTime = formatTicketDecisionTimestamp(entry?.updatedAt ?? entry?.createdAt ?? null);
    return [
      `**${index + 1}.** <#${channelId}>`,
      `Clan: **${entry?.clanName ?? 'Unknown'}**`,
      `Status: ${formatTicketDecisionStatusLabel(status)}`,
      `Decided by: ${reviewerId}`,
      `Time: ${decisionTime}`,
      ''
    ].join('\n');
  });

  const chunks = [];
  let currentChunk = '';
  const maxChunkLength = 3500;
  for (const lineBlock of bodyLines) {
    const nextChunk = currentChunk ? `${currentChunk}\n${lineBlock}` : lineBlock;
    if (nextChunk.length > maxChunkLength && currentChunk) {
      chunks.push(currentChunk);
      currentChunk = lineBlock;
    } else {
      currentChunk = nextChunk;
    }
  }
  if (currentChunk) {
    chunks.push(currentChunk);
  }

  if (!chunks.length) {
    chunks.push('No tickets matched the selected filters.');
  }

  return [
    {
      type: ComponentType.Container,
      components: [
        {
          type: ComponentType.TextDisplay,
          content: [...headerLines, ...filterLines].join('\n')
        },
        {
          type: ComponentType.Separator,
          divider: true,
          spacing: SeparatorSpacingSize.Small
        },
        ...chunks.map((chunk) => ({
          type: ComponentType.TextDisplay,
          content: chunk
        }))
      ]
    }
  ];
}

function buildNotificationReadResponse(notifications) {
  const header = ['📣 **Windows Notifications**', ''];
  const lines = notifications.slice(0, 8).flatMap((item, index) => ([
    `**${index + 1}.** ${item.title ?? '(no title)'}`,
    `App: ${item.app ?? 'Unknown app'}`,
    `Time: ${formatNotificationTimestamp(item.timestamp)}`,
    item.body ? `Body: ${item.body}` : 'Body: *(empty)*',
    ''
  ]));

  if (notifications.length > 8) {
    lines.push(`...and ${notifications.length - 8} more notifications.`);
  }

  return [...header, ...lines].join('\n');
}


function buildForwardNotificationMessage(item) {
  return [
    '📣 **New Windows Notification**',
    '',
    `**Title:** ${item.title ?? '(no title)'}`,
    `**App:** ${item.app ?? 'Unknown app'}`,
    `**Time:** ${formatNotificationTimestamp(item.timestamp)}`,
    `**Body:** ${item.body ?? '*(empty)*'}`
  ].join('\n');
}

function buildNotificationSignature(item) {
  return [
    item?.timestamp ?? '',
    item?.app ?? '',
    item?.title ?? '',
    item?.body ?? ''
  ].join('|');
}

const NOTIFICATION_FORWARD_POLL_INTERVAL_MS = 2000;
const NOTIFICATION_SIGNATURE_HISTORY_LIMIT = 500;
const NOTIFICATION_FORWARD_ERROR_LOG_INTERVAL_MS = 60 * 1000;
let notificationForwardPollTimer = null;
let notificationForwardPollingFallbackActive = false;
const notificationForwardSeenByGuild = new Map();
const lastNotificationForwardErrorByGuild = new Map();
const notificationForwardSystemAlertSentByGuild = new Map();

function normalizeNotificationForForward(rawItem) {
  if (!rawItem || typeof rawItem !== 'object') {
    return null;
  }

  const title = typeof rawItem.title === 'string' && rawItem.title.trim() ? rawItem.title.trim() : null;
  const app = typeof rawItem.app === 'string' && rawItem.app.trim() ? rawItem.app.trim() : 'Unknown app';
  const timestamp = typeof rawItem.timestamp === 'string' ? rawItem.timestamp : null;
  const hasBody = typeof rawItem.body === 'string';
  const body = hasBody
    ? (rawItem.body.trim() ? rawItem.body.trim() : null)
    : null;

  return {
    title,
    app,
    timestamp,
    body
  };
}

function extractNotificationsFromBridgeEvent(eventPayload) {
  if (!eventPayload || typeof eventPayload !== 'object') {
    return [];
  }

  const eventType = typeof eventPayload.type === 'string'
    ? eventPayload.type
    : (typeof eventPayload.event === 'string' ? eventPayload.event : '');

  if (eventType === 'notification' && eventPayload.notification && typeof eventPayload.notification === 'object') {
    return [eventPayload.notification];
  }

  if ((eventType === 'notifications' || eventType === 'notification_batch') && Array.isArray(eventPayload.notifications)) {
    return eventPayload.notifications;
  }

  if (Array.isArray(eventPayload.notifications)) {
    return eventPayload.notifications;
  }

  if (eventPayload.notification && typeof eventPayload.notification === 'object') {
    return [eventPayload.notification];
  }

  return [];
}

function buildSortedUniqueForwardNotifications(rawItems) {
  const uniqueBySignature = new Map();
  for (const rawItem of rawItems) {
    const normalizedItem = normalizeNotificationForForward(rawItem);
    if (!normalizedItem) {
      continue;
    }

    const signature = buildNotificationSignature(normalizedItem);
    uniqueBySignature.set(signature, normalizedItem);
  }

  return [...uniqueBySignature.values()]
    .sort((a, b) => (new Date(a.timestamp ?? 0).getTime() || 0) - (new Date(b.timestamp ?? 0).getTime() || 0));
}

function shouldLogNotificationForwardError(guildId, errorCode, message) {
  const safeErrorCode = errorCode ?? 'UNKNOWN';
  const safeMessage = message ?? 'Unknown error';
  const errorKey = `${guildId}:${safeErrorCode}:${safeMessage}`;
  const now = Date.now();
  const lastLoggedAt = lastNotificationForwardErrorByGuild.get(errorKey) ?? 0;
  if (now - lastLoggedAt < NOTIFICATION_FORWARD_ERROR_LOG_INTERVAL_MS) {
    return false;
  }
  lastNotificationForwardErrorByGuild.set(errorKey, now);
  return true;
}

function shouldSendNotificationForwardSystemAlert(errorCode) {
  return errorCode === 'ACCESS_DENIED' || errorCode === 'API_UNAVAILABLE';
}

async function sendNotificationForwardSystemAlert(guildId, guild, config, result) {
  if (!config.channelId || !shouldSendNotificationForwardSystemAlert(result.errorCode)) {
    return;
  }

  const alertKey = `${guildId}:${result.errorCode}:${config.channelId}`;
  if (notificationForwardSystemAlertSentByGuild.has(alertKey)) {
    return;
  }

  let channel;
  try {
    channel = await guild.channels.fetch(config.channelId);
  } catch (error) {
    console.warn(`Failed to fetch notification forward channel ${config.channelId}:`, error);
    return;
  }

  if (!channel || !channel.isTextBased()) {
    return;
  }

  try {
    await channel.send({
      components: buildTextComponents(
        `⚠️ Notification forwarding is enabled, but host notifications cannot be read (${result.errorCode}). ${result.message ?? ''}`.trim()
      ),
      flags: MessageFlags.IsComponentsV2
    });
    notificationForwardSystemAlertSentByGuild.set(alertKey, Date.now());
  } catch (error) {
    console.warn(`Failed to send notification forwarding system alert to guild ${guildId}:`, error);
  }
}

function clearNotificationForwardSystemAlertsForGuild(guildId) {
  for (const key of notificationForwardSystemAlertSentByGuild.keys()) {
    if (key.startsWith(`${guildId}:`)) {
      notificationForwardSystemAlertSentByGuild.delete(key);
    }
  }
}

function pruneNotificationSignatureSet(signatureSet) {
  while (signatureSet.size > NOTIFICATION_SIGNATURE_HISTORY_LIMIT) {
    const firstKey = signatureSet.values().next().value;
    if (!firstKey) break;
    signatureSet.delete(firstKey);
  }
}

async function initializeNotificationForwardCache(readyClient) {
  const result = await readWindowsToastNotifications();
  if (!result.ok || !result.notifications.length) {
    return;
  }

  const sortedUniqueNotifications = buildSortedUniqueForwardNotifications(result.notifications);

  for (const [guildId] of readyClient.guilds.cache) {
    const config = getNotificationForwardConfig(guildId);
    if (!config.enabled || !config.channelId) continue;
    const signatureSet = new Set(sortedUniqueNotifications.map(buildNotificationSignature));
    pruneNotificationSignatureSet(signatureSet);
    notificationForwardSeenByGuild.set(guildId, signatureSet);
  }
}

async function dispatchForwardNotificationsToGuilds(readyClient, notifications) {
  if (!notifications.length) {
    return;
  }

  for (const [guildId, guild] of readyClient.guilds.cache) {
    const config = getNotificationForwardConfig(guildId);
    if (!config.enabled || !config.channelId) continue;

    clearNotificationForwardSystemAlertsForGuild(guildId);

    const signatureSet = notificationForwardSeenByGuild.get(guildId) ?? new Set();
    notificationForwardSeenByGuild.set(guildId, signatureSet);

    let channel;
    try {
      channel = await guild.channels.fetch(config.channelId);
    } catch (error) {
      console.warn(`Failed to fetch notification forward channel ${config.channelId}:`, error);
      continue;
    }

    if (!channel || !channel.isTextBased()) {
      continue;
    }

    for (const notification of notifications) {
      const signature = buildNotificationSignature(notification);
      if (signatureSet.has(signature)) {
        continue;
      }

      signatureSet.add(signature);
      pruneNotificationSignatureSet(signatureSet);
      try {
        await channel.send({
          components: buildTextComponents(buildForwardNotificationMessage(notification)),
          flags: MessageFlags.IsComponentsV2
        });
      } catch (error) {
        console.warn(`Failed to forward notification to guild ${guildId}:`, error);
      }
    }
  }
}

async function runNotificationForwardTick(readyClient) {
  const result = await readWindowsToastNotifications();
  if (!result.ok) {
    for (const [guildId, guild] of readyClient.guilds.cache) {
      const config = getNotificationForwardConfig(guildId);
      if (!config.enabled || !config.channelId) continue;

      if (shouldLogNotificationForwardError(guildId, result.errorCode, result.message)) {
        console.warn('Notification forwarding read failed.', {
          guildId,
          channelId: config.channelId,
          errorCode: result.errorCode ?? 'UNKNOWN',
          message: result.message ?? 'Unknown error'
        });
      }

      await sendNotificationForwardSystemAlert(guildId, guild, config, result);
    }
    return;
  }

  if (result.notifications.length === 0) {
    return;
  }

  const sortedNotifications = buildSortedUniqueForwardNotifications(result.notifications);
  await dispatchForwardNotificationsToGuilds(readyClient, sortedNotifications);
}

async function beginNotificationForwardPollingFallback(readyClient) {
  if (notificationForwardPollTimer) {
    clearInterval(notificationForwardPollTimer);
    notificationForwardPollTimer = null;
  }

  notificationForwardPollingFallbackActive = true;
  notificationForwardPollTimer = setInterval(() => {
    runNotificationForwardTick(readyClient).catch((error) => {
      console.warn('Notification forward poll failed:', error);
    });
  }, NOTIFICATION_FORWARD_POLL_INTERVAL_MS);
}

function stopNotificationForwardPollingFallback() {
  if (notificationForwardPollTimer) {
    clearInterval(notificationForwardPollTimer);
    notificationForwardPollTimer = null;
  }

  notificationForwardPollingFallbackActive = false;
}

async function startNotificationForwardPolling(readyClient) {
  onWinRtBridgeConnectionState((state) => {
    if (state?.connected) {
      stopNotificationForwardPollingFallback();
      return;
    }

    if (!notificationForwardPollingFallbackActive) {
      void beginNotificationForwardPollingFallback(readyClient);
    }
  });

  onWinRtBridgeEvent((payload) => {
    const eventNotifications = buildSortedUniqueForwardNotifications(extractNotificationsFromBridgeEvent(payload));
    if (!eventNotifications.length) {
      return;
    }

    stopNotificationForwardPollingFallback();
    void dispatchForwardNotificationsToGuilds(readyClient, eventNotifications);
  });

  await initializeNotificationForwardCache(readyClient);

  const subscribeResult = await startWinRtNotificationPush();
  if (!subscribeResult.ok) {
    await beginNotificationForwardPollingFallback(readyClient);
    console.warn(`Failed to start daemon notification push mode. Falling back to polling. ${subscribeResult.message ?? ''}`.trim());
    return;
  }

  stopNotificationForwardPollingFallback();
}


function formatOfficerStatsDisplay(userId, stats) {
  const safeStats = stats && typeof stats === 'object' ? stats : {};
  return [
    `Officer: <@${userId}>`,
    '',
    `✅ Accepted tickets: ${Number(safeStats.ticketsAccepted) || 0}`,
    `❌ Rejected tickets: ${Number(safeStats.ticketsRejected) || 0}`,
    `🗑️ Removed tickets: ${Number(safeStats.ticketsRemoved) || 0}`,
    `🔁 Moved tickets: ${Number(safeStats.ticketsMoved) || 0}`,
    `📊 Total actions: ${Number(safeStats.totalActions) || 0}`,
    safeStats.updatedAt ? `🕒 Updated: <t:${Math.floor(new Date(safeStats.updatedAt).getTime() / 1000)}:R>` : '🕒 Updated: never'
  ].join('\n');
}

function formatCooldownRemaining(remainingMs) {
  const safeRemainingMs = Math.max(0, Number(remainingMs) || 0);
  const totalSeconds = Math.ceil(safeRemainingMs / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes <= 0) {
    return `${seconds} s`;
  }
  if (seconds === 0) {
    return `${minutes} min`;
  }
  return `${minutes} min ${seconds} s`;
}

function isValidDiscordSnowflake(value) {
  return typeof value === 'string' && /^\d{17,20}$/.test(value.trim());
}

function normalizeDiscordSnowflake(value) {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmedValue = value.trim();
  return isValidDiscordSnowflake(trimmedValue) ? trimmedValue : null;
}

async function ensureTicketApplicantAccess(channel, applicantId) {
  if (!channel?.permissionOverwrites || typeof channel.permissionOverwrites.edit !== 'function') {
    console.warn('Unable to ensure applicant access: channel does not support permission overwrites.');
    return {
      ok: false,
      warning: 'Applicant channel access could not be verified for this channel type.'
    };
  }

  if (!isValidDiscordSnowflake(applicantId)) {
    console.warn('Unable to ensure applicant access: applicantId is invalid.', {
      channelId: channel?.id ?? null,
      applicantId
    });
    return {
      ok: false,
      warning: 'Applicant ID is invalid, so applicant access could not be restored automatically.'
    };
  }

  try {
    await channel.permissionOverwrites.edit(applicantId.trim(), {
      ViewChannel: true,
      SendMessages: true,
      ReadMessageHistory: true
    });
    return { ok: true, warning: null };
  } catch (error) {
    console.warn(`Failed to ensure applicant access for ${applicantId}:`, error);
    return {
      ok: false,
      warning: 'Applicant access overwrite could not be applied automatically.'
    };
  }
}

function deriveApplicantIdFromTicketEntry(entry) {
  if (!entry || typeof entry !== 'object') {
    return null;
  }

  const directCandidateFields = [
    entry.applicantId,
    entry.userId,
    entry.authorId,
    entry.ownerId,
    entry.createdBy
  ];

  for (const candidate of directCandidateFields) {
    const normalizedCandidate = normalizeDiscordSnowflake(candidate);
    if (normalizedCandidate) {
      return normalizedCandidate;
    }
  }

  const answerCandidateFields = [
    entry.answers?.applicantId,
    entry.answers?.userId,
    entry.answers?.authorId,
    entry.answers?.discordId,
    entry.answers?.discordUserId,
    entry.answers?.memberId
  ];
  for (const candidate of answerCandidateFields) {
    const normalizedCandidate = normalizeDiscordSnowflake(candidate);
    if (normalizedCandidate) {
      return normalizedCandidate;
    }
  }

  return null;
}

async function recoverTicketApplicantId(channel, entry) {
  const inferredFromEntry = deriveApplicantIdFromTicketEntry(entry);
  if (inferredFromEntry) {
    return { applicantId: inferredFromEntry, source: 'ticket_payload' };
  }

  const summaryMessageId = normalizeDiscordSnowflake(entry?.messageId);
  if (summaryMessageId && channel?.isTextBased()) {
    try {
      const summaryMessage = await channel.messages.fetch(summaryMessageId);
      const messageMetadataCandidates = [
        summaryMessage?.interactionMetadata?.user?.id,
        summaryMessage?.interaction?.user?.id,
        summaryMessage?.messageReference?.authorId,
        summaryMessage?.mentions?.users?.first?.()?.id
      ];

      for (const candidate of messageMetadataCandidates) {
        const normalizedCandidate = normalizeDiscordSnowflake(candidate);
        if (normalizedCandidate) {
          return { applicantId: normalizedCandidate, source: 'summary_message' };
        }
      }
    } catch (error) {
      console.warn('Failed to fetch ticket summary message while recovering applicantId.', {
        channelId: channel?.id ?? null,
        messageId: summaryMessageId,
        errorCode: error?.code ?? null
      });
    }
  }

  if (!channel?.permissionOverwrites?.cache) {
    return { applicantId: null, source: null };
  }

  const memberOverwriteCandidates = channel.permissionOverwrites.cache
    .filter((overwrite) => (overwrite.type === 1 || overwrite.type === 'member'))
    .filter((overwrite) => overwrite.allow.has(PermissionsBitField.Flags.ViewChannel))
    .filter((overwrite) => overwrite.allow.has(PermissionsBitField.Flags.SendMessages))
    .map((overwrite) => overwrite.id)
    .filter((id) => id !== channel?.client?.user?.id)
    .filter((id) => isValidDiscordSnowflake(id));

  for (const memberId of memberOverwriteCandidates) {
    try {
      const member = await channel.guild.members.fetch(memberId);
      if (member?.user && !member.user.bot) {
        return { applicantId: memberId, source: 'permission_overwrite' };
      }
    } catch {
      // Ignore stale overwrite IDs and continue with the next candidate.
    }
  }

  return { applicantId: null, source: null };
}

function buildMessageLogComponents({ title, messageId, channelId, author, createdTimestamp, content }) {
  const authorLabel = formatLogAuthorLabel(author);
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

function prunePingRoleSelections(state, allowedRoles) {
  if (!state.user_selections || typeof state.user_selections !== 'object') {
    state.user_selections = {};
    return;
  }
  for (const [userId, selections] of Object.entries(state.user_selections)) {
    if (!Array.isArray(selections)) {
      state.user_selections[userId] = [];
      continue;
    }
    state.user_selections[userId] = selections.filter((roleId) => allowedRoles.has(roleId));
  }
}

async function removeRolesFromMembers(guild, roleIds) {
  if (!guild || !roleIds.length) return;
  let members;
  try {
    members = await guild.members.fetch();
  } catch (error) {
    console.warn('Failed to fetch guild members for ping role cleanup:', error);
    return;
  }

  const removalTasks = [];
  for (const member of members.values()) {
    const rolesToRemove = roleIds.filter((roleId) => member.roles.cache.has(roleId));
    if (!rolesToRemove.length) continue;
    removalTasks.push(
      member.roles.remove(rolesToRemove).catch((error) => {
        console.warn(`Failed to remove ping roles from ${member.id}:`, error);
      })
    );
  }

  if (removalTasks.length) {
    await Promise.allSettled(removalTasks);
  }
}

function hasAdminPermission(member) {
  const storedRoleId = getPermissionRoleId(member.guild.id);
  return member.permissions.has(PermissionsBitField.Flags.Administrator)
    || (storedRoleId ? member.roles.cache.has(storedRoleId) : false);
}

function hasClanPanelPermission(member) {
  return hasAdminPermission(member);
}

function hasPingRolesPermission(member) {
  const storedRoleId = getPermissionRoleId(member.guild.id);
  return Boolean(storedRoleId && member.roles.cache.has(storedRoleId));
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

function getTicketStatusEmojiFromName(name) {
  if (!name) return null;
  const emojiPrefixes = Object.values(TICKET_STATUS_EMOJI);
  for (const emoji of emojiPrefixes) {
    const prefixPattern = new RegExp(`^${emoji}(?:[ -]+)?`);
    if (prefixPattern.test(name)) {
      return emoji;
    }
  }
  return null;
}

function replaceTicketClanInBaseName({ currentName, currentClanName, selectedClanName }) {
  const sanitizedSelectedClan = sanitizeTicketChannelBase(selectedClanName);
  if (!sanitizedSelectedClan) return null;

  const strippedCurrentName = stripTicketStatusPrefix(currentName ?? '');
  const sanitizedBase = sanitizeTicketChannelBase(strippedCurrentName);
  const sanitizedCurrentClan = sanitizeTicketChannelBase(currentClanName ?? '');

  let nameRemainder = sanitizedBase;
  if (sanitizedCurrentClan && sanitizedBase === sanitizedCurrentClan) {
    nameRemainder = '';
  } else if (sanitizedCurrentClan && sanitizedBase.startsWith(`${sanitizedCurrentClan}-`)) {
    nameRemainder = sanitizedBase.slice(sanitizedCurrentClan.length + 1);
  } else {
    nameRemainder = sanitizedBase.replace(/^[^-]+-?/, '');
  }

  const rebuiltBase = sanitizeTicketChannelBase(
    nameRemainder ? `${sanitizedSelectedClan}-${nameRemainder}` : sanitizedSelectedClan
  );
  return rebuiltBase || sanitizedSelectedClan;
}

function buildReassignedTicketChannelName({ currentName, currentClanName, selectedClanName }) {
  const statusEmoji = getTicketStatusEmojiFromName(currentName) ?? TICKET_STATUS_EMOJI.awaiting;
  const replacedBase = replaceTicketClanInBaseName({
    currentName,
    currentClanName,
    selectedClanName
  });
  if (!replacedBase || !/^[a-z0-9-]+$/.test(replacedBase)) {
    return null;
  }

  const maxBaseLength = Math.max(1, 100 - `${statusEmoji}-`.length);
  const limitedBase = replacedBase.slice(0, maxBaseLength);
  if (!limitedBase || !/^[a-z0-9-]+$/.test(limitedBase)) {
    return null;
  }

  const nextName = formatTicketChannelName(statusEmoji, limitedBase);
  if (!nextName || nextName.length > 100) {
    return null;
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
  const resolvedDescription = trimmedDescription || 'No description.';
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
  const selectedRoles = memberId
    ? new Set(state.user_selections?.[memberId] ?? [])
    : new Set();
  const limitedRoles = availableRoleEntries.slice(0, 25);
  const options = limitedRoles.length
    ? limitedRoles.map((role) => ({
        label: role.name,
        value: role.id,
        default: selectedRoles.has(role.id)
      }))
    : [
        {
          label: 'No roles are available.',
          value: 'no_roles_available'
        }
      ];
  const maxValues = limitedRoles.length ? Math.min(limitedRoles.length, 25) : 1;
  const extraRolesCount = availableRoleEntries.length - limitedRoles.length;
  const descriptionLines = [
    'Choose the ping roles you want to use.',
    extraRolesCount > 0 ? `Showing only the first 25 roles (hidden ${extraRolesCount}).` : null
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
              placeholder: 'Select ping roles',
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
  const activeReviewRoleId = decision?.activeReviewRoleId ?? null;
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
  const disableReassign = Boolean(
    decision?.status && decision.status !== CLAN_TICKET_DECISION_ACCEPT
  );
  const actionRows = [
    {
      type: ComponentType.ActionRow,
      components: [
        {
          type: ComponentType.Button,
          custom_id: CLAN_TICKET_PUBLIC_MENU_ID,
          label: '⚙️',
          style: ButtonStyle.Secondary,
          disabled: disableButtons && disableReassign && disableRemove
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
            '**What is your Roblox nickname?**',
            `> ${answers.robloxNick ?? 'Not provided'}`,
            '',
            `**How many rebirths do you have?**`,
            `> ${answers.rebirths}`,
            '',
            '**What gamepasses do you have?**',
            `> ${answers.gamepasses}`,
            '',
            '**How many hours a day do you play?**',
            `> ${answers.hours}`,
            '',
            `**Current review role:** ${activeReviewRoleId ? `<@&${activeReviewRoleId}>` : 'Not set'}`
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

function buildPrivateTicketSettingsMenu(activeReviewRoleId, decision) {
  const disableButtons = Boolean(decision?.status);
  const disableRemove = decision?.status === CLAN_TICKET_DECISION_REMOVE;
  const disableReassign = Boolean(
    decision?.status && decision.status !== CLAN_TICKET_DECISION_ACCEPT
  );
  return [
    {
      type: ComponentType.Container,
      components: [
        {
          type: ComponentType.TextDisplay,
          content: [
            `Ticket settings menu opened privately for <@${decision?.openedBy ?? decision?.decidedBy ?? '0'}>.`,
            `Active review role: ${activeReviewRoleId ? `<@&${activeReviewRoleId}>` : 'Not set'}.`
          ].join('\n')
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
              type: ComponentType.Button,
              custom_id: `${CLAN_TICKET_PRIVATE_DECISION_PREFIX}${CLAN_TICKET_DECISION_ACCEPT}`,
              label: 'Accept',
              style: ButtonStyle.Success,
              disabled: disableButtons
            },
            {
              type: ComponentType.Button,
              custom_id: `${CLAN_TICKET_PRIVATE_DECISION_PREFIX}${CLAN_TICKET_DECISION_REJECT}`,
              label: 'Reject',
              style: ButtonStyle.Danger,
              disabled: disableButtons
            },
            {
              type: ComponentType.Button,
              custom_id: `${CLAN_TICKET_PRIVATE_DECISION_PREFIX}${CLAN_TICKET_DECISION_REASSIGN}`,
              label: 'Move/assign review role',
              style: ButtonStyle.Primary,
              disabled: disableReassign
            },
            {
              type: ComponentType.Button,
              custom_id: `${CLAN_TICKET_PRIVATE_DECISION_PREFIX}${CLAN_TICKET_DECISION_REMOVE}`,
              label: 'Remove ticket',
              style: ButtonStyle.Secondary,
              disabled: disableRemove
            }
          ]
        }
      ]
    }
  ];
}

function buildReassignClanOptions(clanMap, selectedClanName) {
  const clans = sortClansForDisplay(Object.values(clanMap ?? {}));
  const clanOptions = clans
    .slice(0, 25)
    .map((clan) => ({
      label: clan.name.slice(0, 100),
      value: clan.name,
      default: clan.name === selectedClanName
    }));

  if (!clanOptions.length) {
    return [
      {
        label: 'No clans are available',
        value: 'no_clans_available'
      }
    ];
  }

  return clanOptions;
}

function buildReviewRoleSelectComponents(channelId, selectedClanName, options) {
  const hasRoles = options.some((option) => option.value !== 'no_clans_available');
  return [
    {
      type: ComponentType.Container,
      components: [
        {
          type: ComponentType.TextDisplay,
          content: 'Select the clan to move this ticket to.'
        },
        {
          type: ComponentType.ActionRow,
          components: [
            {
              type: ComponentType.StringSelect,
              custom_id: `${CLAN_TICKET_REASSIGN_PREFIX}${channelId}`,
              placeholder: selectedClanName
                ? 'Choose a different clan'
                : 'Choose a clan',
              min_values: 1,
              max_values: 1,
              options,
              disabled: !hasRoles
            }
          ]
        }
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

function formatEffectiveReviewRoleText(reviewRoleId) {
  return reviewRoleId ? `<@&${reviewRoleId}>` : 'Not set';
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
    return 'No roles are set.';
  }
  return roleIds.map((roleId) => `• <@&${roleId}>`).join('\n');
}

function formatRouteList(routes) {
  const entries = Object.entries(routes ?? {});
  if (!entries.length) {
    return 'No routes are set.';
  }
  return entries
    .map(([channelId, roleId]) => `• <#${channelId}> → <@&${roleId}>`)
    .join('\n');
}

function buildTicketModal(clanName) {
  const robloxNickInput = new TextInputBuilder()
    .setCustomId(CLAN_TICKET_ROBLOX_NICK_INPUT_ID)
    .setLabel('What is your Roblox nickname?')
    .setStyle(TextInputStyle.Short)
    .setRequired(true)
    .setMaxLength(32);

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
      new ActionRowBuilder().addComponents(robloxNickInput),
      new ActionRowBuilder().addComponents(rebirthsInput),
      new ActionRowBuilder().addComponents(gamepassesInput),
      new ActionRowBuilder().addComponents(hoursInput)
    );
}

async function refreshPingRolePanelForGuild(guild, guildId) {
  const panelConfig = getPingRolePanelConfig(guildId);
  if (!panelConfig?.channelId || !panelConfig?.messageId) return;

  let channel;
  try {
    channel = await guild.channels.fetch(panelConfig.channelId);
  } catch (error) {
    console.warn(`Failed to fetch ping roles panel channel ${panelConfig.channelId}:`, error);
  }

  if (!channel || !channel.isTextBased()) {
    setPingRolePanelConfig(guildId, null);
    return;
  }

  let message;
  try {
    message = await channel.messages.fetch(panelConfig.messageId);
  } catch (error) {
    console.warn(`Failed to fetch ping roles panel message ${panelConfig.messageId}:`, error);
  }

  if (!message) {
    setPingRolePanelConfig(guildId, null);
    return;
  }

  const state = getPingRoleState(guildId);
  ensurePingRoleState(state);
  try {
    await message.edit({
      components: buildPingRoleSelectComponents(guild, state, null),
      flags: MessageFlags.IsComponentsV2
    });
  } catch (error) {
    console.warn(`Failed to refresh ping roles panel message ${panelConfig.messageId}:`, error);
  }
}

async function refreshPingRolePanelsOnStartup(readyClient) {
  const invalidGuildIds = [];
  const guildIds = readyClient.guilds.cache.map((guild) => guild.id);

  for (const guildId of guildIds) {
    const panelConfig = getPingRolePanelConfig(guildId);
    if (!panelConfig?.channelId || !panelConfig?.messageId) continue;

    let guild;
    try {
      guild = await readyClient.guilds.fetch(guildId);
    } catch (error) {
      console.warn(`Failed to fetch guild ${guildId} for ping roles panel refresh:`, error);
      invalidGuildIds.push(guildId);
      continue;
    }

    let channel;
    try {
      channel = await guild.channels.fetch(panelConfig.channelId);
    } catch (error) {
      console.warn(`Failed to fetch ping roles panel channel ${panelConfig.channelId}:`, error);
      invalidGuildIds.push(guildId);
      continue;
    }

    if (!channel || !channel.isTextBased()) {
      invalidGuildIds.push(guildId);
      continue;
    }

    let message;
    try {
      message = await channel.messages.fetch(panelConfig.messageId);
    } catch (error) {
      console.warn(`Failed to fetch ping roles panel message ${panelConfig.messageId}:`, error);
      invalidGuildIds.push(guildId);
      continue;
    }

    if (!message) {
      invalidGuildIds.push(guildId);
      continue;
    }

    const state = getPingRoleState(guildId);
    ensurePingRoleState(state);
    try {
      await message.edit({
        components: buildPingRoleSelectComponents(guild, state, null),
        flags: MessageFlags.IsComponentsV2
      });
    } catch (error) {
      console.warn(`Failed to refresh ping roles panel message ${panelConfig.messageId}:`, error);
    }
  }

  if (invalidGuildIds.length) {
    for (const guildId of invalidGuildIds) {
      setPingRolePanelConfig(guildId, null);
    }
  }
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
  if (!state.officer_stats) {
    state.officer_stats = {};
  }
  return state;
}

function getOfficerStatsEntry(state, userId) {
  ensureGuildClanState(state);
  if (!state.officer_stats[userId] || typeof state.officer_stats[userId] !== 'object') {
    state.officer_stats[userId] = {
      ticketsAccepted: 0,
      ticketsRejected: 0,
      ticketsRemoved: 0,
      ticketsMoved: 0,
      totalActions: 0,
      updatedAt: null
    };
  }
  return state.officer_stats[userId];
}

function incrementOfficerAction(state, userId, actionKey) {
  if (!userId || !actionKey) return;
  const stats = getOfficerStatsEntry(state, userId);
  stats[actionKey] = (Number(stats[actionKey]) || 0) + 1;
  stats.totalActions = (Number(stats.totalActions) || 0) + 1;
  stats.updatedAt = new Date().toISOString();
}

function isTicketOpenForReviewRoleSync(ticketEntry) {
  const status = ticketEntry?.status ?? null;
  return !status || status === 'awaiting' || status === CLAN_TICKET_DECISION_ACCEPT;
}

async function syncOpenTicketReviewRoleForClan(guild, guildId, clanName, oldRoleId, newRoleId) {
  if (!guild || !guildId || !clanName) {
    return {
      syncedTickets: 0,
      failedChannelUpdates: 0
    };
  }

  const state = getClanState(guildId);
  const ticketEntries = Object.entries(state.clan_ticket_decisions ?? {}).filter(([, entry]) => {
    if (!entry || entry.clanName !== clanName) return false;
    return isTicketOpenForReviewRoleSync(entry);
  });

  let failedChannelUpdates = 0;
  for (const [channelId] of ticketEntries) {
    let channel;
    try {
      channel = await guild.channels.fetch(channelId);
    } catch (error) {
      console.warn(`Failed to fetch ticket channel ${channelId} for review role sync:`, error);
      failedChannelUpdates += 1;
      continue;
    }

    if (!channel?.permissionOverwrites) {
      failedChannelUpdates += 1;
      continue;
    }

    try {
      if (oldRoleId && oldRoleId !== newRoleId) {
        await channel.permissionOverwrites.edit(oldRoleId, {
          ViewChannel: false,
          SendMessages: false,
          ReadMessageHistory: false
        });
      }
      if (newRoleId) {
        await channel.permissionOverwrites.edit(newRoleId, {
          ViewChannel: true,
          SendMessages: true,
          ReadMessageHistory: true
        });
      }
    } catch (error) {
      console.warn(`Failed to sync review role permissions in ticket channel ${channelId}:`, error);
      failedChannelUpdates += 1;
    }
  }

  if (ticketEntries.length) {
    const openTicketIds = new Set(ticketEntries.map(([channelId]) => channelId));
    await updateClanState(guildId, (nextState) => {
      ensureGuildClanState(nextState);
      for (const [channelId, entry] of Object.entries(nextState.clan_ticket_decisions ?? {})) {
        if (!entry || !openTicketIds.has(channelId)) continue;
        entry.activeReviewRoleId = newRoleId ?? null;
        entry.updatedAt = new Date().toISOString();
      }
    });
  }

  return {
    syncedTickets: ticketEntries.length,
    failedChannelUpdates
  };
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
    content: `**Content:** ${formatLogContent(sanitizeMentionLikeTokens(resolvedMessage.content))}`
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

  const beforeContent = formatLogContent(sanitizeMentionLikeTokens(resolvedOldMessage.content));
  const afterContent = formatLogContent(sanitizeMentionLikeTokens(resolvedNewMessage.content));
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
      flags: MessageFlags.IsComponentsV2,
      allowedMentions: {
        parse: [],
        users: [],
        roles: [],
        repliedUser: false
      }
    });
  } catch (error) {
    console.warn('Failed to send message update log:', error);
  }
});

client.on(Events.InteractionCreate, async (interaction) => {
  try {
    if (interaction.isModalSubmit()) {
      if (interaction.customId.startsWith(CLAN_TICKET_MODAL_PREFIX)) {
        if (!interaction.inGuild()) {
          await interaction.reply({
            components: buildTextComponents('This dialog can only be used in a server.'),
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
            components: buildTextComponents('The selected clan was not found.'),
            flags: MessageFlags.IsComponentsV2,
            ephemeral: true
          });
          return;
        }

        if (!clan.ticketCategoryId) {
          await interaction.reply({
            components: buildTextComponents('No ticket category is set for this clan.'),
            flags: MessageFlags.IsComponentsV2,
            ephemeral: true
          });
          return;
        }

        if (!clan.reviewRoleId) {
          await interaction.reply({
            components: buildTextComponents('No review role is set for this clan.'),
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
            components: buildTextComponents('Ticket category was not found.'),
            flags: MessageFlags.IsComponentsV2,
            ephemeral: true
          });
          return;
        }

        const rebirths = interaction.fields.getTextInputValue(CLAN_TICKET_REBIRTHS_INPUT_ID);
        const gamepasses = interaction.fields.getTextInputValue(CLAN_TICKET_GAMEPASSES_INPUT_ID);
        const hours = interaction.fields.getTextInputValue(CLAN_TICKET_HOURS_INPUT_ID);
        const robloxNick = interaction.fields
          .getTextInputValue(CLAN_TICKET_ROBLOX_NICK_INPUT_ID)
          .trim();
        const robloxNickForNickname = robloxNick ? robloxNick.slice(0, 32) : '';

        let member = interaction.member instanceof GuildMember ? interaction.member : null;
        if (!member) {
          try {
            member = await interaction.guild.members.fetch(interaction.user.id);
          } catch (error) {
            console.warn(`Failed to fetch member ${interaction.user.id} for clan ticket:`, error);
          }
        }

        if (!member) {
          await interaction.reply({
            components: buildTextComponents('Unable to resolve your server member profile.'),
            flags: MessageFlags.IsComponentsV2,
            ephemeral: true
          });
          return;
        }

        let nicknameUpdateFailed = false;
        if (robloxNickForNickname) {
          try {
            await member.setNickname(robloxNickForNickname, 'Roblox nick from clan ticket');
          } catch (error) {
            nicknameUpdateFailed = true;
            console.warn(
              `Failed to update nickname for ${interaction.user.id} in guild ${interaction.guildId}:`,
              error
            );
          }
        }

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
          const fallbackPlayerName = member.displayName || interaction.user.username;
          const ticketPlayerName = robloxNickForNickname || fallbackPlayerName;
          const rawChannelName = `${clanName} - ${ticketPlayerName}`;
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
            components: buildTextComponents('Failed to create ticket.'),
            flags: MessageFlags.IsComponentsV2,
            ephemeral: true
          });
          return;
        }

        const summaryMessage = await ticketChannel.send({
          components: buildTicketSummary(
            {
              robloxNick,
              rebirths,
              gamepasses,
              hours
            },
            {
              activeReviewRoleId: clan.reviewRoleId
            }
          ),
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
              robloxNick: robloxNickForNickname,
              rebirths,
              gamepasses,
              hours
            },
            status: null,
            decidedBy: null,
            updatedAt: null,
            activeReviewRoleId: clan.reviewRoleId,
            lastMoveAt: null,
            createdAt: new Date().toISOString()
          };
        });

        const ticketCreatedMessage = nicknameUpdateFailed
          ? `Ticket was created: <#${ticketChannel.id}>\n⚠️ Ticket was created, but your nickname could not be updated.`
          : robloxNickForNickname
            ? `Ticket was created: <#${ticketChannel.id}>\n✅ Your nickname was updated to **${robloxNickForNickname}**.`
            : `Ticket was created: <#${ticketChannel.id}>`;

        await interaction.reply({
          components: buildTextComponents(ticketCreatedMessage),
          flags: MessageFlags.IsComponentsV2,
          ephemeral: true
        });
        return;
      }

      if (interaction.customId !== CLAN_PANEL_EDIT_MODAL_ID) return;
      if (!interaction.inGuild() || !(interaction.member instanceof GuildMember)) {
        await interaction.reply({
          components: buildTextComponents('This dialog can only be used in a server.'),
          flags: MessageFlags.IsComponentsV2,
          ephemeral: true
        });
        return;
      }

      if (!hasClanPanelPermission(interaction.member)) {
        await interaction.reply({
          components: buildTextComponents('You do not have permission to edit the clan panel.'),
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
        components: buildTextComponents('Clan panel description saved.'),
        flags: MessageFlags.IsComponentsV2,
        ephemeral: true
      });
      return;
    }

    if (interaction.isStringSelectMenu()) {
      if (interaction.customId.startsWith(CLAN_TICKET_REASSIGN_PREFIX)) {
        if (!interaction.inGuild() || !(interaction.member instanceof GuildMember)) {
          await interaction.reply({
            components: buildTextComponents('This selection can only be used in a server.'),
            flags: MessageFlags.IsComponentsV2,
            ephemeral: true
          });
          return;
        }

        const targetChannelId = interaction.customId.slice(CLAN_TICKET_REASSIGN_PREFIX.length);
        if (!targetChannelId || targetChannelId !== interaction.channelId) {
          await interaction.reply({
            components: buildTextComponents('This move selector is no longer valid for this channel.'),
            flags: MessageFlags.IsComponentsV2,
            ephemeral: true
          });
          return;
        }

        const selectedClanName = interaction.values[0];
        if (!selectedClanName || selectedClanName === 'no_clans_available') {
          await interaction.reply({
            components: buildTextComponents('No valid clan was selected.'),
            flags: MessageFlags.IsComponentsV2,
            ephemeral: true
          });
          return;
        }

        const state = getClanState(interaction.guildId);
        const ticketEntry = state.clan_ticket_decisions?.[interaction.channelId];
        if (!ticketEntry) {
          await interaction.reply({
            components: buildTextComponents('Ticket was not found or is no longer active.'),
            flags: MessageFlags.IsComponentsV2,
            ephemeral: true
          });
          return;
        }

        const lastMoveTimestamp = ticketEntry.lastMoveAt ? new Date(ticketEntry.lastMoveAt).getTime() : NaN;
        if (Number.isFinite(lastMoveTimestamp)) {
          const elapsedSinceLastMoveMs = Date.now() - lastMoveTimestamp;
          if (elapsedSinceLastMoveMs < TICKET_MOVE_COOLDOWN_MS) {
            const remaining = formatCooldownRemaining(TICKET_MOVE_COOLDOWN_MS - elapsedSinceLastMoveMs);
            await interaction.reply({
              components: buildTextComponents(`Move is on cooldown. Time remaining: ${remaining}.`),
              flags: MessageFlags.IsComponentsV2,
              ephemeral: true
            });
            return;
          }
        }

        if (ticketEntry.status && ticketEntry.status !== CLAN_TICKET_DECISION_ACCEPT) {
          await interaction.reply({
            components: buildTextComponents('This ticket has already been decided and can no longer be moved.'),
            flags: MessageFlags.IsComponentsV2,
            ephemeral: true
          });
          return;
        }

        const clan = state.clan_clans?.[ticketEntry.clanName];
        if (!clan) {
          await interaction.reply({
            components: buildTextComponents('Clan for this ticket was not found.'),
            flags: MessageFlags.IsComponentsV2,
            ephemeral: true
          });
          return;
        }

        const effectiveReviewRoleId = ticketEntry.activeReviewRoleId ?? clan.reviewRoleId;
        const hasReviewPermission = hasAdminPermission(interaction.member)
          || Boolean(effectiveReviewRoleId && interaction.member.roles.cache.has(effectiveReviewRoleId));
        if (!hasReviewPermission) {
          await interaction.reply({
            components: buildTextComponents(
              `You do not have permission to change the ticket review role. Required active review role: ${formatEffectiveReviewRoleText(effectiveReviewRoleId)}.`
            ),
            flags: MessageFlags.IsComponentsV2,
            ephemeral: true
          });
          return;
        }

        const targetClan = state.clan_clans?.[selectedClanName];
        if (!targetClan) {
          await interaction.reply({
            components: buildTextComponents('Selected clan no longer exists.'),
            flags: MessageFlags.IsComponentsV2,
            ephemeral: true
          });
          return;
        }

        const nextReviewRoleId = targetClan.reviewRoleId ?? null;
        const shouldMoveAcceptedTicket = ticketEntry.status === CLAN_TICKET_DECISION_ACCEPT;
        const targetCategoryIdForMove = shouldMoveAcceptedTicket
          ? targetClan.acceptCategoryId ?? null
          : null;
        const previousAcceptRoleId = clan.acceptRoleId ?? null;
        const nextAcceptRoleId = targetClan.acceptRoleId ?? null;
        const nextChannelName = buildReassignedTicketChannelName({
          currentName: interaction.channel?.name ?? '',
          currentClanName: ticketEntry.clanName,
          selectedClanName
        });

        if (!nextChannelName) {
          await interaction.reply({
            components: buildTextComponents('Unable to rename ticket channel for the selected clan.'),
            flags: MessageFlags.IsComponentsV2,
            ephemeral: true
          });
          return;
        }

        let applicantAccessWarning = null;
        if (interaction.channel?.isTextBased()) {
          try {
            if (effectiveReviewRoleId && effectiveReviewRoleId !== nextReviewRoleId) {
              await interaction.channel.permissionOverwrites.edit(effectiveReviewRoleId, {
                ViewChannel: false,
                SendMessages: false,
                ReadMessageHistory: false
              });
            }
            if (nextReviewRoleId) {
              await interaction.channel.permissionOverwrites.edit(nextReviewRoleId, {
                ViewChannel: true,
                SendMessages: true,
                ReadMessageHistory: true
              });
            }
            if (targetCategoryIdForMove) {
              try {
                await interaction.channel.setParent(targetCategoryIdForMove, {
                  lockPermissions: false
                });
                const applicantAccessResult = await ensureTicketApplicantAccess(
                  interaction.channel,
                  ticketEntry.applicantId
                );
                if (!applicantAccessResult.ok) {
                  applicantAccessWarning = applicantAccessResult.warning;
                }
              } catch (error) {
                console.warn('Failed to move ticket channel for clan reassignment:', error);
                await interaction.reply({
                  components: buildTextComponents('Move failed because the channel could not be moved to the target category. Please check bot permissions (Manage Channels / Manage Roles) and try again.'),
                  flags: MessageFlags.IsComponentsV2,
                  ephemeral: true
                });
                return;
              }
            }
            if (interaction.channel.name !== nextChannelName) {
              await interaction.channel.setName(nextChannelName);
            }
          } catch (error) {
            console.warn('Failed to update ticket channel permissions for new clan review role:', error);
            await interaction.reply({
              components: buildTextComponents('Move failed because channel update (including rename) could not be completed.'),
              flags: MessageFlags.IsComponentsV2,
              ephemeral: true
            });
            return;
          }
        } else {
          await interaction.reply({
            components: buildTextComponents('Move failed because this channel type cannot be renamed.'),
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
          entry.clanName = selectedClanName;
          entry.activeReviewRoleId = nextReviewRoleId;
          entry.lastMoveAt = updatedAt;
          entry.reassignedBy = interaction.user.id;
          entry.updatedAt = updatedAt;
          incrementOfficerAction(nextState, interaction.user.id, 'ticketsMoved');
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
            console.warn('Failed to update ticket summary message after review-role change:', error);
          }
        }

        let applicantRoleChangeSuffix = '';
        if (shouldMoveAcceptedTicket && refreshedEntry?.applicantId) {
          try {
            const applicantMember = await interaction.guild.members.fetch(refreshedEntry.applicantId);
            if (previousAcceptRoleId && previousAcceptRoleId !== nextAcceptRoleId) {
              await applicantMember.roles.remove(previousAcceptRoleId).catch(() => null);
            }
            if (nextAcceptRoleId && !applicantMember.roles.cache.has(nextAcceptRoleId)) {
              await applicantMember.roles.add(nextAcceptRoleId);
            }
            applicantRoleChangeSuffix = ` Applicant role updated from ${formatEffectiveReviewRoleText(previousAcceptRoleId)} to ${formatEffectiveReviewRoleText(nextAcceptRoleId)}.`;
          } catch (error) {
            console.warn('Failed to update applicant accepted role after ticket move:', error);
            applicantRoleChangeSuffix = ' Applicant role could not be updated automatically.';
          }
        }

        const moveSuffix = shouldMoveAcceptedTicket
          ? targetCategoryIdForMove
            ? ` Accepted ticket was moved to <#${targetCategoryIdForMove}>.`
            : ' Accepted ticket was not moved because the selected clan has no accept category set.'
          : '';
        const applicantAccessSuffix = applicantAccessWarning
          ? ` Move completed with warning: ${applicantAccessWarning}`
          : '';

        if (shouldMoveAcceptedTicket && refreshedEntry?.applicantId && interaction.channel?.isTextBased()) {
          await interaction.channel.send({
            components: buildTextComponents(
              `<@${refreshedEntry.applicantId}> Your accepted ticket was moved to **${selectedClanName}**.`
            ),
            flags: MessageFlags.IsComponentsV2
          });
        }

        await interaction.reply({
          components: buildTextComponents(`Ticket clan updated to **${selectedClanName}**. Channel renamed to **${nextChannelName}**. Review role changed from ${formatEffectiveReviewRoleText(effectiveReviewRoleId)} to ${formatEffectiveReviewRoleText(nextReviewRoleId)}.${moveSuffix}${applicantRoleChangeSuffix}${applicantAccessSuffix}`),
          flags: MessageFlags.IsComponentsV2,
          ephemeral: true
        });
        return;
      }

      if (interaction.customId === PING_ROLES_SELECT_ID) {
        if (!interaction.inGuild() || !(interaction.member instanceof GuildMember)) {
          await interaction.reply({
            components: buildTextComponents('This selection can only be used in a server.'),
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
            components: buildTextComponents('Failed to update roles.'),
            flags: MessageFlags.IsComponentsV2,
            ephemeral: true
          });
          return;
        }

        const responseLines = [
          'Your selection has been saved.',
          rolesToAdd.length ? `Roles added: ${rolesToAdd.length}.` : null,
          rolesToRemove.length ? `Roles removed: ${rolesToRemove.length}.` : null,
          invalidSelections.length ? 'Some selected roles are not available.' : null
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
      if (interaction.customId.startsWith(PRIVATE_MESSAGE_READ_PREFIX)) {
        if (!interaction.inGuild() || !(interaction.member instanceof GuildMember)) {
          await interaction.reply({
            components: buildTextComponents('This action can only be used in a server.'),
            flags: MessageFlags.IsComponentsV2,
            ephemeral: true
          });
          return;
        }

        const messageId = interaction.customId.slice(PRIVATE_MESSAGE_READ_PREFIX.length);
        if (!messageId) {
          await interaction.reply({
            components: buildTextComponents('Invalid private message identifier.'),
            flags: MessageFlags.IsComponentsV2,
            ephemeral: true
          });
          return;
        }

        const state = getPrivateMessageState(interaction.guildId);
        const entry = state.messages?.[messageId];
        if (!entry) {
          await interaction.reply({
            components: buildTextComponents('This private message was not found.'),
            flags: MessageFlags.IsComponentsV2,
            ephemeral: true
          });
          return;
        }

        const canRead = hasAdminPermission(interaction.member)
          || entry.fromUserId === interaction.user.id
          || entry.toUserId === interaction.user.id;
        if (!canRead) {
          await interaction.reply({
            components: buildTextComponents('You are not allowed to read this private message.'),
            flags: MessageFlags.IsComponentsV2,
            ephemeral: true
          });
          return;
        }

        await interaction.reply({
          components: buildPrivateMessageContentComponents(entry),
          flags: MessageFlags.IsComponentsV2,
          ephemeral: true
        });
        return;
      }

      if (interaction.customId.startsWith(RPS_CHOICE_PREFIX)) {
        if (!interaction.inGuild() || !(interaction.member instanceof GuildMember)) {
          await interaction.reply({
            components: buildTextComponents('This action can only be used in a server.'),
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
            components: buildTextComponents('Invalid RPS choice.'),
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
            components: buildTextComponents('This game is no longer active.'),
            flags: MessageFlags.IsComponentsV2,
            ephemeral: true
          });
          return;
        }

        const allowedPlayers = [game.challengerId, game.opponentId].filter(Boolean);
        if (!allowedPlayers.includes(interaction.user.id)) {
          await interaction.reply({
            components: buildTextComponents('You are not part of this game.'),
            flags: MessageFlags.IsComponentsV2,
            ephemeral: true
          });
          return;
        }

        if (game.status === 'complete') {
          await interaction.reply({
            components: buildTextComponents('This game has already finished.'),
            flags: MessageFlags.IsComponentsV2,
            ephemeral: true
          });
          return;
        }

        if (game.moves?.[interaction.user.id]) {
          await interaction.reply({
            components: buildTextComponents('You have already submitted your choice.'),
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
            components: buildTextComponents('This game is no longer available.'),
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

      const isPublicMenuOpenAction = interaction.customId === CLAN_TICKET_PUBLIC_MENU_ID;
      const isPublicTicketDecisionAction = interaction.customId.startsWith(CLAN_TICKET_DECISION_PREFIX);
      const isPrivateTicketDecisionAction = interaction.customId.startsWith(CLAN_TICKET_PRIVATE_DECISION_PREFIX);
      if (!isPublicMenuOpenAction && !isPublicTicketDecisionAction && !isPrivateTicketDecisionAction) return;
      if (!interaction.inGuild() || !(interaction.member instanceof GuildMember)) {
        await interaction.reply({
          components: buildTextComponents('This action can only be used in a server.'),
          flags: MessageFlags.IsComponentsV2,
          ephemeral: true
        });
        return;
      }

      const action = isPrivateTicketDecisionAction
        ? interaction.customId.slice(CLAN_TICKET_PRIVATE_DECISION_PREFIX.length)
        : isPublicTicketDecisionAction
          ? interaction.customId.slice(CLAN_TICKET_DECISION_PREFIX.length)
          : null;
      if ([
        CLAN_TICKET_DECISION_ACCEPT,
        CLAN_TICKET_DECISION_REJECT,
        CLAN_TICKET_DECISION_REASSIGN,
        CLAN_TICKET_DECISION_REMOVE
      ].includes(action) === false && !isPublicMenuOpenAction) {
        await interaction.reply({
          components: buildTextComponents('Invalid ticket action.'),
          flags: MessageFlags.IsComponentsV2,
          ephemeral: true
        });
        return;
      }

      const state = getClanState(interaction.guildId);
      const ticketEntry = state.clan_ticket_decisions?.[interaction.channelId];
      if (!ticketEntry) {
        await interaction.reply({
          components: buildTextComponents('Ticket was not found or is no longer active.'),
          flags: MessageFlags.IsComponentsV2,
          ephemeral: true
        });
        return;
      }

      const clan = state.clan_clans?.[ticketEntry.clanName];
      if (!clan) {
        await interaction.reply({
          components: buildTextComponents('Clan for this ticket was not found.'),
          flags: MessageFlags.IsComponentsV2,
          ephemeral: true
        });
        return;
      }

      const effectiveReviewRoleId = ticketEntry.activeReviewRoleId ?? clan.reviewRoleId;
      const hasReviewPermission = hasAdminPermission(interaction.member)
        || Boolean(effectiveReviewRoleId && interaction.member.roles.cache.has(effectiveReviewRoleId));
      if (!hasReviewPermission) {
        await interaction.reply({
          components: buildTextComponents(
            `You do not have permission to decide on this ticket. Required active review role: ${formatEffectiveReviewRoleText(effectiveReviewRoleId)}.`
          ),
          flags: MessageFlags.IsComponentsV2,
          ephemeral: true
        });
        return;
      }

      if (isPublicMenuOpenAction) {
        await interaction.reply({
          components: buildPrivateTicketSettingsMenu(effectiveReviewRoleId, {
            ...ticketEntry,
            openedBy: interaction.user.id
          }),
          flags: MessageFlags.IsComponentsV2,
          ephemeral: true
        });
        return;
      }

      if (action === CLAN_TICKET_DECISION_REASSIGN) {
        if (ticketEntry.status && ticketEntry.status !== CLAN_TICKET_DECISION_ACCEPT) {
          await interaction.reply({
            components: buildTextComponents('This ticket has already been decided and can no longer be moved.'),
            flags: MessageFlags.IsComponentsV2,
            ephemeral: true
          });
          return;
        }

        const options = buildReassignClanOptions(state.clan_clans, ticketEntry.clanName);
        await interaction.reply({
          components: buildReviewRoleSelectComponents(interaction.channelId, ticketEntry.clanName, options),
          flags: MessageFlags.IsComponentsV2,
          ephemeral: true
        });
        return;
      }

      if (ticketEntry.status && action !== CLAN_TICKET_DECISION_REMOVE) {
        await interaction.reply({
          components: buildTextComponents('This ticket has already been decided.'),
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
        if (action === CLAN_TICKET_DECISION_ACCEPT) {
          incrementOfficerAction(nextState, interaction.user.id, 'ticketsAccepted');
        }
        if (action === CLAN_TICKET_DECISION_REJECT) {
          incrementOfficerAction(nextState, interaction.user.id, 'ticketsRejected');
        }
        if (action === CLAN_TICKET_DECISION_REMOVE) {
          incrementOfficerAction(nextState, interaction.user.id, 'ticketsRemoved');
        }
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
          components: buildTextComponents('Ticket was removed.'),
          flags: MessageFlags.IsComponentsV2,
          ephemeral: true
        });
        return;
      }

      let acceptMoveSyncWarning = null;
      let acceptApplicantAccessWarning = null;
      if (action === CLAN_TICKET_DECISION_ACCEPT && clan.acceptCategoryId) {
        try {
          await interaction.channel?.setParent(clan.acceptCategoryId, {
            lockPermissions: false
          });
          const applicantAccessResult = await ensureTicketApplicantAccess(
            interaction.channel,
            ticketEntry.applicantId
          );
          if (!applicantAccessResult.ok) {
            acceptApplicantAccessWarning = applicantAccessResult.warning;
            console.warn(`Accepted ticket applicant access warning (${interaction.channelId}): ${acceptApplicantAccessWarning}`);
          }
        } catch (error) {
          console.warn('Failed to move accepted ticket channel:', error);
          acceptMoveSyncWarning = 'Ticket was accepted, but moving to the accept category failed. Please check bot permissions (Manage Channels / Manage Roles).';
          console.warn(`Accepted ticket move warning (${interaction.channelId}): ${acceptMoveSyncWarning}`);
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
      if (action === CLAN_TICKET_DECISION_ACCEPT && clan.acceptRoleId && refreshedEntry?.applicantId) {
        try {
          const applicantMember = await interaction.guild.members.fetch(refreshedEntry.applicantId);
          await applicantMember.roles.add(clan.acceptRoleId);
        } catch (error) {
          console.warn('Failed to assign accept role to applicant:', error);
        }
      }
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

      if (action === CLAN_TICKET_DECISION_ACCEPT && refreshedEntry?.applicantId && interaction.channel?.isTextBased()) {
        await interaction.channel.send({
          components: buildTextComponents(
            `<@${refreshedEntry.applicantId}> Your ticket was accepted.`
          ),
          flags: MessageFlags.IsComponentsV2
        });
      }

      const reviewerWarnings = [];
      if (acceptMoveSyncWarning) {
        reviewerWarnings.push(`⚠️ ${acceptMoveSyncWarning}`);
      }
      if (acceptApplicantAccessWarning) {
        reviewerWarnings.push(`⚠️ Applicant access warning: ${acceptApplicantAccessWarning}`);
      }

      await interaction.reply({
        components: buildTextComponents(
          reviewerWarnings.length
            ? `Decision saved.\n\n${reviewerWarnings.join('\n')}`
            : 'Decision saved.'
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
          components: buildTextComponents('This command can only be used in a server.'),
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
            components: buildTextComponents('You cannot play against yourself.'),
            flags: MessageFlags.IsComponentsV2,
            ephemeral: true
          });
          return;
        }

        if (opponent?.bot && opponent.id !== client.user?.id) {
          await interaction.reply({
            components: buildTextComponents('You cannot play against other bots.'),
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
          : ['No games have been played yet.'];

        await interaction.reply({
          components: buildTextComponents(['🏆 **RPS Stats**', '', ...lines].join('\n')),
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
          components: buildTextComponents('RPS stats have been reset.'),
          flags: MessageFlags.IsComponentsV2,
          ephemeral: true
        });
      }
      return;
    }

    if (interaction.commandName === 'config') {
      if (!interaction.inGuild() || !(interaction.member instanceof GuildMember)) {
        await interaction.reply({
          components: buildTextComponents('This command can only be used in a server.'),
          flags: MessageFlags.IsComponentsV2,
          ephemeral: true
        });
        return;
      }

      if (!hasAdminPermission(interaction.member)) {
        await interaction.reply({
          components: buildTextComponents('You do not have permission to use this command.'),
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
          ? `Permission role was set to <@&${storedRoleId}>.`
          : 'Permission role was cleared.';
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
            components: buildTextComponents('Please select a text channel.'),
            flags: MessageFlags.IsComponentsV2,
            ephemeral: true
          });
          return;
        }

        const storedChannelId = channel?.id ?? null;
        setLogConfig(interaction.guildId, { channelId: storedChannelId });

        const response = storedChannelId
          ? `Log channel was set to <#${storedChannelId}>.`
          : 'Log channel was cleared.';
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
          components: buildTextComponents(`Bot version: ${version}`),
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
                  content: 'Update started. The bot will deploy commands and restart when finished.'
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
                'Update failed or restart did not complete. Check the logs.'
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

      if (subcommand === 'ticket_visibility_sync') {
        const state = getClanState(interaction.guildId);
        ensureGuildClanState(state);

        let processed = 0;
        let updated = 0;
        let failed = 0;
        let skipped = 0;
        let recoveredApplicantIds = 0;

        for (const [channelId, entry] of Object.entries(state.clan_ticket_decisions ?? {})) {
          processed += 1;
          if (!entry || typeof entry !== 'object') {
            skipped += 1;
            continue;
          }

          const clan = state.clan_clans?.[entry.clanName];
          if (!clan) {
            console.warn('Skipping ticket visibility sync entry because clan configuration is missing.', {
              channelId,
              clanName: entry.clanName
            });
            skipped += 1;
            continue;
          }

          const ticketCategoryId = normalizeDiscordSnowflake(clan.ticketCategoryId);
          if (!ticketCategoryId) {
            console.warn('Skipping ticket visibility sync entry because ticket category is missing in clan config.', {
              channelId,
              clanName: entry.clanName,
              ticketCategoryId: clan.ticketCategoryId
            });
            skipped += 1;
            continue;
          }

          let channel;
          try {
            channel = await interaction.guild.channels.fetch(channelId);
          } catch (error) {
            const isUnknownChannelError = Number(error?.code) === 10003;
            if (isUnknownChannelError) {
              console.warn('Removing stale ticket visibility sync entry because channel no longer exists.', {
                channelId
              });
              await updateClanState(interaction.guildId, (nextState) => {
                ensureGuildClanState(nextState);
                if (nextState.clan_ticket_decisions && Object.prototype.hasOwnProperty.call(nextState.clan_ticket_decisions, channelId)) {
                  delete nextState.clan_ticket_decisions[channelId];
                }
              });
              skipped += 1;
              continue;
            }
            console.warn(`Failed to fetch channel ${channelId} during ticket visibility sync:`, error);
            failed += 1;
            continue;
          }

          let ticketCategory;
          try {
            ticketCategory = await interaction.guild.channels.fetch(ticketCategoryId);
          } catch (error) {
            console.warn('Skipping ticket visibility sync entry because ticket category fetch failed.', {
              channelId,
              ticketCategoryId,
              errorCode: error?.code ?? null
            });
            skipped += 1;
            continue;
          }

          if (!ticketCategory || ticketCategory.type !== ChannelType.GuildCategory) {
            console.warn('Skipping ticket visibility sync entry because ticket category is missing or invalid.', {
              channelId,
              ticketCategoryId,
              categoryType: ticketCategory?.type ?? null
            });
            skipped += 1;
            continue;
          }

          if (!channel?.permissionOverwrites) {
            console.warn('Skipping ticket visibility sync entry because target channel does not support permission overwrites.', {
              channelId
            });
            skipped += 1;
            continue;
          }

          let applicantId = normalizeDiscordSnowflake(entry.applicantId);
          if (!applicantId) {
            const recoveryResult = await recoverTicketApplicantId(channel, entry);
            if (recoveryResult.applicantId) {
              applicantId = recoveryResult.applicantId;
              const nowIso = new Date().toISOString();
              await updateClanState(interaction.guildId, (nextState) => {
                ensureGuildClanState(nextState);
                const targetEntry = nextState.clan_ticket_decisions?.[channelId];
                if (!targetEntry || typeof targetEntry !== 'object') {
                  return;
                }
                targetEntry.applicantId = recoveryResult.applicantId;
                targetEntry.updatedAt = nowIso;
              });
              recoveredApplicantIds += 1;
              console.warn('Recovered missing ticket applicantId during ticket visibility sync.', {
                channelId,
                recoveredApplicantId: recoveryResult.applicantId,
                source: recoveryResult.source
              });
            } else {
              console.warn('Skipping ticket visibility sync entry due to unrecoverable applicantId.', {
                channelId,
                applicantId: entry.applicantId,
                messageId: entry?.messageId ?? null
              });
              skipped += 1;
              continue;
            }
          }

          const categoryOverwrites = ticketCategory.permissionOverwrites.cache
            .filter((overwrite) => overwrite.id !== applicantId)
            .map((overwrite) => ({
              id: overwrite.id,
              type: overwrite.type,
              allow: overwrite.allow.bitfield,
              deny: overwrite.deny.bitfield
            }));

          const reviewRoleId = normalizeDiscordSnowflake(clan.reviewRoleId);
          const reviewRoleTarget = reviewRoleId
            ? interaction.guild.roles.resolve(reviewRoleId)
              ?? await interaction.guild.roles.fetch(reviewRoleId).catch(() => null)
            : null;

          const applicantOverwriteTarget =
            interaction.guild.members.resolve(applicantId)
            ?? interaction.guild.roles.resolve(applicantId)
            ?? await interaction.guild.members.fetch(applicantId).catch(() => null)
            ?? await interaction.guild.roles.fetch(applicantId).catch(() => null)
            ?? await client.users.fetch(applicantId).catch(() => null);

          if (!applicantOverwriteTarget) {
            console.warn('Skipping ticket visibility sync entry because applicant is not resolvable as a guild member/user/role.', {
              channelId,
              applicantId,
              ticketCategoryId
            });
            skipped += 1;
            continue;
          }

          try {
            await channel.permissionOverwrites.set(categoryOverwrites);
            await channel.permissionOverwrites.edit(applicantOverwriteTarget, {
              ViewChannel: true,
              SendMessages: true,
              ReadMessageHistory: true
            });

            if (reviewRoleTarget) {
              await channel.permissionOverwrites.edit(reviewRoleTarget, {
                ViewChannel: true,
                SendMessages: true,
                ReadMessageHistory: true
              });
            } else if (reviewRoleId) {
              console.warn('Ticket visibility sync could not resolve clan review role while syncing ticket channel.', {
                channelId,
                reviewRoleId,
                clanName: entry.clanName
              });
            }
          } catch (error) {
            if (error?.name === 'DiscordAPIError' && (error?.code === 10009 || error?.code === 10011 || error?.code === 50035)) {
              console.warn('Skipping ticket visibility sync entry due to inconsistent data while applying category overwrites.', {
                channelId,
                applicantId,
                ticketCategoryId,
                errorCode: error.code
              });
              skipped += 1;
              continue;
            }
            console.warn(`Failed to update permission overwrites for channel ${channelId}:`, error);
            failed += 1;
            continue;
          }

          const nowIso = new Date().toISOString();
          await updateClanState(interaction.guildId, (nextState) => {
            ensureGuildClanState(nextState);
            const targetEntry = nextState.clan_ticket_decisions?.[channelId];
            if (!targetEntry || typeof targetEntry !== 'object') {
              return;
            }
            targetEntry.activeReviewRoleId = normalizeDiscordSnowflake(clan.reviewRoleId) ?? null;
            targetEntry.updatedAt = nowIso;
          });
          updated += 1;
        }

        const summary = [
          '🔄 **Ticket visibility sync finished**',
          `Processed: **${processed}**`,
          `Updated: **${updated}**`,
          `Failed: **${failed}**`,
          `Skipped: **${skipped}**`,
          `RecoveredApplicantIds: **${recoveredApplicantIds}**`
        ].join('\n');

        await interaction.reply({
          components: buildTextComponents(summary),
          flags: MessageFlags.IsComponentsV2,
          ephemeral: true
        });
        return;
      }

      if (subcommand === 'welcome' || subcommand === 'welcome_room') {
        let channelId;

        if (subcommand === 'welcome') {
          const channel = interaction.options.getChannel('channel', true);
          if (!channel || channel.type !== ChannelType.GuildText) {
            await interaction.reply({
              components: buildTextComponents('Please select a text channel.'),
              flags: MessageFlags.IsComponentsV2,
              ephemeral: true
            });
            return;
          }
          channelId = channel.id;
        } else {
          const channelIdRaw = interaction.options.getString('channel_id', true).trim();
          if (!/^\d{17,20}$/.test(channelIdRaw)) {
            await interaction.reply({
              components: buildTextComponents('Please provide a valid Discord channel ID.'),
              flags: MessageFlags.IsComponentsV2,
              ephemeral: true
            });
            return;
          }

          let channel = null;
          try {
            channel = await interaction.guild.channels.fetch(channelIdRaw);
          } catch (e) {
            channel = null;
          }

          if (!channel || channel.type !== ChannelType.GuildText) {
            await interaction.reply({
              components: buildTextComponents('Channel not found or is not a text channel in this server.'),
              flags: MessageFlags.IsComponentsV2,
              ephemeral: true
            });
            return;
          }
          channelId = channel.id;
        }

        const messageRaw = interaction.options.getString('message');
        const message = messageRaw && messageRaw.trim() ? messageRaw.trim() : null;

        setWelcomeConfig(interaction.guildId, {
          channelId,
          message
        });

        await interaction.reply({
          components: buildTextComponents(`Welcome settings saved for <#${channelId}>.`),
          flags: MessageFlags.IsComponentsV2,
          ephemeral: true
        });
      }
      return;
    }



    if (interaction.commandName === 'admin') {
      if (!interaction.inGuild() || !(interaction.member instanceof GuildMember)) {
        await interaction.reply({
          components: buildTextComponents('This command can only be used in a server.'),
          flags: MessageFlags.IsComponentsV2,
          ephemeral: true
        });
        return;
      }

      if (!hasAdminPermission(interaction.member)) {
        await interaction.reply({
          components: buildTextComponents('You do not have permission to use this command.'),
          flags: MessageFlags.IsComponentsV2,
          ephemeral: true
        });
        return;
      }

      const subcommand = interaction.options.getSubcommand(true);
      if (subcommand === 'stats') {
        const officer = interaction.options.getUser('nick', true);
        const state = getClanState(interaction.guildId);
        ensureGuildClanState(state);
        const stats = state.officer_stats?.[officer.id] ?? {
          ticketsAccepted: 0,
          ticketsRejected: 0,
          ticketsRemoved: 0,
          ticketsMoved: 0,
          totalActions: 0,
          updatedAt: null
        };

        await interaction.reply({
          components: buildTextComponents(formatOfficerStatsDisplay(officer.id, stats)),
          flags: MessageFlags.IsComponentsV2
        });
        return;
      }
    }

    if (interaction.commandName === 'settings') {
      if (!interaction.inGuild() || !(interaction.member instanceof GuildMember)) {
        await interaction.reply({
          components: buildTextComponents('This command can only be used in a server.'),
          flags: MessageFlags.IsComponentsV2,
          ephemeral: true
        });
        return;
      }

      const subcommand = interaction.options.getSubcommand(true);
      const state = getClanState(interaction.guildId);
      ensureGuildClanState(state);

      if (subcommand === 'all') {
        if (!hasSettingsOverviewPermission(interaction.member, state)) {
          await interaction.reply({
            components: buildTextComponents('You do not have permission to view ticket overview.'),
            flags: MessageFlags.IsComponentsV2,
            ephemeral: true
          });
          return;
        }

        const statusFilter = interaction.options.getString('status');
        const clanFilterRaw = interaction.options.getString('clan');
        const clanFilter = clanFilterRaw && clanFilterRaw.trim() ? clanFilterRaw.trim() : null;

        const ticketEntries = Object.entries(state.clan_ticket_decisions ?? {})
          .filter(([, entry]) => Boolean(entry))
          .filter(([, entry]) => canMemberViewTicketInOverview(interaction.member, state, entry))
          .filter(([, entry]) => {
            if (statusFilter && normalizeTicketDecisionStatus(entry.status) !== statusFilter) {
              return false;
            }
            if (clanFilter && (entry.clanName ?? '').toLowerCase() !== clanFilter.toLowerCase()) {
              return false;
            }
            return true;
          })
          .sort((a, b) => {
            const aTs = new Date(a[1]?.updatedAt ?? a[1]?.createdAt ?? 0).getTime() || 0;
            const bTs = new Date(b[1]?.updatedAt ?? b[1]?.createdAt ?? 0).getTime() || 0;
            return bTs - aTs;
          });

        await interaction.reply({
          components: buildTicketOverviewComponents(ticketEntries, {
            statusFilter,
            clanFilter
          }),
          flags: MessageFlags.IsComponentsV2,
          ephemeral: true
        });
        return;
      }

      if (subcommand !== 'menu') return;

      const ticketEntry = state.clan_ticket_decisions?.[interaction.channelId];
      if (!ticketEntry) {
        await interaction.reply({
          components: buildTextComponents('This channel is not an active clan ticket.'),
          flags: MessageFlags.IsComponentsV2,
          ephemeral: true
        });
        return;
      }

      const clan = state.clan_clans?.[ticketEntry.clanName];
      if (!clan) {
        await interaction.reply({
          components: buildTextComponents('Clan for this ticket was not found.'),
          flags: MessageFlags.IsComponentsV2,
          ephemeral: true
        });
        return;
      }

      const effectiveReviewRoleId = ticketEntry.activeReviewRoleId ?? clan.reviewRoleId;
      const hasReviewPermission = hasAdminPermission(interaction.member)
        || Boolean(effectiveReviewRoleId && interaction.member.roles.cache.has(effectiveReviewRoleId));
      if (!hasReviewPermission) {
        await interaction.reply({
          components: buildTextComponents(
            `You do not have permission to open ticket settings. Required active review role: ${formatEffectiveReviewRoleText(effectiveReviewRoleId)}.`
          ),
          flags: MessageFlags.IsComponentsV2,
          ephemeral: true
        });
        return;
      }

      await interaction.reply({
        components: buildPrivateTicketSettingsMenu(effectiveReviewRoleId, {
          ...ticketEntry,
          openedBy: interaction.user.id
        }),
        flags: MessageFlags.IsComponentsV2,
        ephemeral: true
      });
      return;
    }

    if (interaction.commandName === 'ping_roles') {
      if (!interaction.inGuild() || !(interaction.member instanceof GuildMember)) {
        await interaction.reply({
          components: buildTextComponents('This command can only be used in a server.'),
          flags: MessageFlags.IsComponentsV2,
          ephemeral: true
        });
        return;
      }

      if (!hasPingRolesPermission(interaction.member)) {
        await interaction.reply({
          components: buildTextComponents('You do not have permission to use this command.'),
          flags: MessageFlags.IsComponentsV2,
          ephemeral: true
        });
        return;
      }

      const directSubcommand = interaction.options.getSubcommand(false);
      if (directSubcommand === 'panel') {
        if (!hasAdminPermission(interaction.member)) {
          await interaction.reply({
            components: buildTextComponents('You do not have permission to use this command.'),
            flags: MessageFlags.IsComponentsV2,
            ephemeral: true
          });
          return;
        }

        const channel = interaction.options.getChannel('channel', true);
        if (!channel || channel.type !== ChannelType.GuildText) {
          await interaction.reply({
            components: buildTextComponents('Please select a text channel.'),
            flags: MessageFlags.IsComponentsV2,
            ephemeral: true
          });
          return;
        }

        const state = getPingRoleState(interaction.guildId);
        ensurePingRoleState(state);
        const panelConfig = getPingRolePanelConfig(interaction.guildId);
        let panelMessage = null;

        if (panelConfig?.channelId === channel.id && panelConfig?.messageId) {
          try {
            panelMessage = await channel.messages.fetch(panelConfig.messageId);
          } catch (error) {
            console.warn(`Failed to fetch existing ping roles panel ${panelConfig.messageId}:`, error);
          }
        }

        if (panelMessage) {
          await panelMessage.edit({
            components: buildPingRoleSelectComponents(interaction.guild, state, null),
            flags: MessageFlags.IsComponentsV2
          });
        } else {
          panelMessage = await channel.send({
            components: buildPingRoleSelectComponents(interaction.guild, state, null),
            flags: MessageFlags.IsComponentsV2
          });
        }

        setPingRolePanelConfig(interaction.guildId, {
          channelId: channel.id,
          messageId: panelMessage.id
        });

        await interaction.reply({
          components: buildTextComponents('Ping role panel saved.'),
          flags: MessageFlags.IsComponentsV2,
          ephemeral: true
        });
        return;
      }

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
          components: buildTextComponents('You do not have permission to use this command.'),
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
          const previousState = getPingRoleState(interaction.guildId);
          ensurePingRoleState(previousState);
          const previousRoles = [...previousState.available_roles];

          const updatedState = await updatePingRoleState(interaction.guildId, (state) => {
            ensurePingRoleState(state);
            const uniqueRoles = Array.from(new Set(roleIds));
            state.available_roles = uniqueRoles;
            const allowed = new Set(uniqueRoles);
            for (const channelId of Object.keys(state.channel_routes)) {
              if (!allowed.has(state.channel_routes[channelId])) {
                delete state.channel_routes[channelId];
              }
            }
            prunePingRoleSelections(state, allowed);
          });

          const removedRoles = previousRoles.filter(
            (roleId) => !updatedState.available_roles.includes(roleId)
          );
          await removeRolesFromMembers(interaction.guild, removedRoles);

          await interaction.reply({
            components: buildTextComponents(
              roleIds.length
                ? `Available roles set (${roleIds.length}).`
                : 'Role list was cleared.'
            ),
            flags: MessageFlags.IsComponentsV2,
            ephemeral: true
          });
          return;
        }

        if (subcommand === 'add') {
          if (!roleIds.length) {
            await interaction.reply({
              components: buildTextComponents('Select at least one role to add.'),
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
            components: buildTextComponents(`Roles added (${roleIds.length}).`),
            flags: MessageFlags.IsComponentsV2,
            ephemeral: true
          });
          return;
        }

        if (subcommand === 'remove') {
          if (!roleIds.length) {
            await interaction.reply({
              components: buildTextComponents('Select at least one role to remove.'),
              flags: MessageFlags.IsComponentsV2,
              ephemeral: true
            });
            return;
          }

          const previousState = getPingRoleState(interaction.guildId);
          ensurePingRoleState(previousState);
          const previousRoles = [...previousState.available_roles];

          const updatedState = await updatePingRoleState(interaction.guildId, (state) => {
            ensurePingRoleState(state);
            const toRemove = new Set(roleIds);
            state.available_roles = state.available_roles.filter((roleId) => !toRemove.has(roleId));
            const allowed = new Set(state.available_roles);
            for (const channelId of Object.keys(state.channel_routes)) {
              if (toRemove.has(state.channel_routes[channelId])) {
                delete state.channel_routes[channelId];
              }
            }
            prunePingRoleSelections(state, allowed);
          });

          const removedRoles = previousRoles.filter(
            (roleId) => !updatedState.available_roles.includes(roleId)
          );
          await removeRolesFromMembers(interaction.guild, removedRoles);

          await interaction.reply({
            components: buildTextComponents(`Roles removed (${roleIds.length}).`),
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
              components: buildTextComponents('Please select a text channel.'),
              flags: MessageFlags.IsComponentsV2,
              ephemeral: true
            });
            return;
          }

          const state = getPingRoleState(interaction.guildId);
          ensurePingRoleState(state);
          if (!state.available_roles.includes(role.id)) {
            await interaction.reply({
              components: buildTextComponents('That role is not in the list of available roles.'),
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
            components: buildTextComponents(`Route set: <#${channel.id}> → <@&${role.id}>.`),
            flags: MessageFlags.IsComponentsV2,
            ephemeral: true
          });
          return;
        }

        if (subcommand === 'remove') {
          const channel = interaction.options.getChannel('channel', true);
          if (!channel || channel.type !== ChannelType.GuildText) {
            await interaction.reply({
              components: buildTextComponents('Please select a text channel.'),
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
                ? `Route for <#${channel.id}> was removed.`
                : 'There is no route for this channel.'
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

    if (interaction.commandName === 'notifications') {
      if (!interaction.inGuild() || !(interaction.member instanceof GuildMember)) {
        await interaction.reply({
          components: buildTextComponents('This command can only be used in a server.'),
          flags: MessageFlags.IsComponentsV2,
          ephemeral: true
        });
        return;
      }

      if (!hasAdminPermission(interaction.member)) {
        await interaction.reply({
          components: buildTextComponents('You do not have permission to use this command.'),
          flags: MessageFlags.IsComponentsV2,
          ephemeral: true
        });
        return;
      }

      const subcommand = interaction.options.getSubcommand(true);
      if (subcommand === 'start') {
        const channel = interaction.options.getChannel('channel', true);
        if (!channel || channel.type !== ChannelType.GuildText) {
          await interaction.reply({
            components: buildTextComponents('Please select a text channel.'),
            flags: MessageFlags.IsComponentsV2,
            ephemeral: true
          });
          return;
        }

        setNotificationForwardConfig(interaction.guildId, {
          enabled: true,
          channelId: channel.id
        });
        notificationForwardSeenByGuild.delete(interaction.guildId);
        clearNotificationForwardSystemAlertsForGuild(interaction.guildId);

        await interaction.reply({
          components: buildTextComponents(`Automatic notification forwarding was enabled for <#${channel.id}>.`),
          flags: MessageFlags.IsComponentsV2,
          ephemeral: true
        });
        return;
      }

      if (subcommand === 'stop') {
        setNotificationForwardConfig(interaction.guildId, {
          enabled: false,
          channelId: null
        });
        notificationForwardSeenByGuild.delete(interaction.guildId);
        clearNotificationForwardSystemAlertsForGuild(interaction.guildId);

        await interaction.reply({
          components: buildTextComponents('Automatic notification forwarding was disabled.'),
          flags: MessageFlags.IsComponentsV2,
          ephemeral: true
        });
        return;
      }

      if (subcommand === 'status') {
        const config = getNotificationForwardConfig(interaction.guildId);
        const statusMessage = config.enabled && config.channelId
          ? `Forwarding is enabled to <#${config.channelId}>.`
          : 'Forwarding is currently disabled.';
        await interaction.reply({
          components: buildTextComponents(statusMessage),
          flags: MessageFlags.IsComponentsV2,
          ephemeral: true
        });
        return;
      }

      if (subcommand === 'read') {
        const result = await readWindowsToastNotifications();

        if (!result.ok) {
          let message = result.message || 'Failed to read notifications.';
          if (result.errorCode === 'UNSUPPORTED_PLATFORM') {
            message = 'Unsupported platform: this command works only when the bot is running on Windows.';
          } else if (result.errorCode === 'ACCESS_DENIED') {
            message = `Access denied: ${result.message}`;
          } else if (result.errorCode === 'API_UNAVAILABLE') {
            message = 'Windows notification API is unavailable in this environment.';
          }

          await interaction.reply({
            components: buildTextComponents(message),
            flags: MessageFlags.IsComponentsV2,
            ephemeral: true
          });
          return;
        }

        if (!result.notifications.length) {
          await interaction.reply({
            components: buildTextComponents('No notifications were found in Windows Action Center.'),
            flags: MessageFlags.IsComponentsV2,
            ephemeral: true
          });
          return;
        }

        await interaction.reply({
          components: buildTextComponents(buildNotificationReadResponse(result.notifications)),
          flags: MessageFlags.IsComponentsV2,
          ephemeral: true
        });
      }
      return;
    }

    if (interaction.commandName === 'sz') {
      if (!interaction.inGuild() || !(interaction.member instanceof GuildMember)) {
        await interaction.reply({
          components: buildTextComponents('This command can only be used in a server.'),
          flags: MessageFlags.IsComponentsV2,
          ephemeral: true
        });
        return;
      }

      const subcommand = interaction.options.getSubcommand(true);
      if (subcommand === 'send') {
        const targetUser = interaction.options.getUser('to', true);
        const rawMessage = interaction.options.getString('message', true);
        const content = rawMessage.trim();

        if (!content) {
          await interaction.reply({
            components: buildTextComponents('Message content cannot be empty.'),
            flags: MessageFlags.IsComponentsV2,
            ephemeral: true
          });
          return;
        }

        if (targetUser.id === interaction.user.id) {
          await interaction.reply({
            components: buildTextComponents('You cannot send a private message to yourself.'),
            flags: MessageFlags.IsComponentsV2,
            ephemeral: true
          });
          return;
        }

        if (targetUser.bot) {
          await interaction.reply({
            components: buildTextComponents('You cannot send a private message to bots.'),
            flags: MessageFlags.IsComponentsV2,
            ephemeral: true
          });
          return;
        }

        const privateMessageId = `${Date.now()}_${interaction.id}`;
        await updatePrivateMessageState(interaction.guildId, (state) => {
          state.messages = state.messages ?? {};
          state.messages[privateMessageId] = {
            id: privateMessageId,
            fromUserId: interaction.user.id,
            toUserId: targetUser.id,
            content,
            createdAt: new Date().toISOString()
          };
        });

        await interaction.reply({
          components: [
            ...buildPrivateMessageCreatedComponents({
              fromUserId: interaction.user.id,
              toUserId: targetUser.id
            }),
            ...buildPrivateMessageReadButton(privateMessageId)
          ],
          flags: MessageFlags.IsComponentsV2
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
            components: buildTextComponents('This command can only be used in a server.'),
            flags: MessageFlags.IsComponentsV2,
            ephemeral: true
          });
          return;
        }

        const member = interaction.member ?? await interaction.guild.members.fetch(interaction.user.id);
        const settings = await resolveWelcomeSettings(member);
        if (!settings) {
          await interaction.reply({
            components: buildTextComponents('No welcome channel is configured.'),
            flags: MessageFlags.IsComponentsV2,
            ephemeral: true
          });
          return;
        }

        try {
          await sendWelcomeMessage(member, settings);
          await interaction.reply({
            components: buildTextComponents('Welcome message was sent.'),
            flags: MessageFlags.IsComponentsV2,
            ephemeral: true
          });
        } catch (e) {
          console.error('Failed to send manual welcome message:', e);
          await interaction.reply({
            components: buildTextComponents('Failed to send welcome message.'),
            flags: MessageFlags.IsComponentsV2,
            ephemeral: true
          });
        }
      }
    }

    if (interaction.commandName === 'clan_panel') {
      if (!interaction.inGuild() || !(interaction.member instanceof GuildMember)) {
        await interaction.reply({
          components: buildTextComponents('This command can only be used in a server.'),
          flags: MessageFlags.IsComponentsV2,
          ephemeral: true
        });
        return;
      }

      if (!hasClanPanelPermission(interaction.member)) {
        await interaction.reply({
          components: buildTextComponents('You do not have permission to use the clan panel.'),
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
          const acceptRoleOption = interaction.options.getRole('accept_role');
          const orderPosition = interaction.options.getInteger('order_position');
          const ticketCategoryId = ticketRoomOption?.type === ChannelType.GuildCategory
            ? ticketRoomOption.id
            : null;
          const acceptCategoryId = acceptCategoryOption?.type === ChannelType.GuildCategory
            ? acceptCategoryOption.id
            : null;
          const reviewRoleId = reviewRoleOption?.id ?? null;
          const acceptRoleId = acceptRoleOption?.id ?? null;
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
              acceptRoleId,
              orderPosition: orderPosition ?? null,
              createdAt: new Date().toISOString()
            };
          });

          if (!existed) {
            await refreshClanPanelForGuild(interaction.guild, guildId);
          }

          await interaction.reply({
            components: buildTextComponents(
              existed ? `Clan "${name}" already exists.` : `Clan "${name}" was added.`
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
          const acceptRoleOption = interaction.options.getRole('accept_role');
          const orderPositionOption = interaction.options.getInteger('order_position');
          const ticketCategoryId = ticketRoomOption?.type === ChannelType.GuildCategory
            ? ticketRoomOption.id
            : null;
          const acceptCategoryId = acceptCategoryOption?.type === ChannelType.GuildCategory
            ? acceptCategoryOption.id
            : null;
          const reviewRoleId = reviewRoleOption?.id ?? null;
          const acceptRoleId = acceptRoleOption?.id ?? null;
          let found = false;
          let previousReviewRoleId = null;
          let nextReviewRoleId = null;

          await updateClanState(guildId, (state) => {
            ensureGuildClanState(state);
            const entry = state.clan_clans;
            if (!entry[name]) return;
            found = true;
            previousReviewRoleId = entry[name].reviewRoleId ?? null;
            nextReviewRoleId = reviewRoleOption ? reviewRoleId : entry[name].reviewRoleId ?? null;
            entry[name] = {
              ...entry[name],
              tag: tag ?? entry[name].tag ?? null,
              description: description ?? entry[name].description ?? null,
              ticketCategoryId: ticketRoomOption
                ? ticketCategoryId
                : entry[name].ticketCategoryId ?? null,
              reviewRoleId: nextReviewRoleId,
              acceptCategoryId: acceptCategoryOption
                ? acceptCategoryId
                : entry[name].acceptCategoryId ?? null,
              acceptRoleId: acceptRoleOption ? acceptRoleId : entry[name].acceptRoleId ?? null,
              orderPosition: orderPositionOption ?? entry[name].orderPosition ?? null,
              updatedAt: new Date().toISOString()
            };
          });

          let syncResult = null;
          if (found && previousReviewRoleId !== nextReviewRoleId) {
            syncResult = await syncOpenTicketReviewRoleForClan(
              interaction.guild,
              guildId,
              name,
              previousReviewRoleId,
              nextReviewRoleId
            );
            console.log(
              `Clan ${name} review role synced for ${syncResult.syncedTickets} open ticket(s). Failed channel updates: ${syncResult.failedChannelUpdates}.`
            );
          }

          if (found) {
            await refreshClanPanelForGuild(interaction.guild, guildId);
          }

          const syncSummary = syncResult
            ? ` Review-role sync: ${syncResult.syncedTickets} ticket(s) updated, ${syncResult.failedChannelUpdates} channel update(s) failed.`
            : '';

          await interaction.reply({
            components: buildTextComponents(
              found
                ? `Clan "${name}" was updated.${syncSummary}`
                : `Clan "${name}" was not found.`
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
              removed ? `Clan "${name}" was deleted.` : `Clan "${name}" was not found.`
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
            : 'No clans have been registered yet.';

          await interaction.reply({
            components: buildTextComponents(listText),
            flags: MessageFlags.IsComponentsV2,
            ephemeral: true
          });
          return;
        }
      }

      if (!subcommandGroup && subcommand === 'edit') {
        const directText = interaction.options.getString('text', false);
        if (typeof directText === 'string') {
          const description = directText.trim() ? directText.trim() : null;

          await updateClanState(guildId, (state) => {
            ensureGuildClanState(state);
            state.clan_panel_configs = {
              ...state.clan_panel_configs,
              description,
              updatedAt: new Date().toISOString()
            };
          });

          await refreshClanPanelForGuild(interaction.guild, guildId);

          await interaction.reply({
            components: buildTextComponents('Clan panel description saved.'),
            flags: MessageFlags.IsComponentsV2,
            ephemeral: true
          });
          return;
        }

        const state = getClanState(guildId);
        const panelDescription = state.clan_panel_configs?.description ?? '';
        const input = new TextInputBuilder()
          .setCustomId(CLAN_PANEL_DESCRIPTION_INPUT_ID)
          .setLabel('Clan panel description')
          .setStyle(TextInputStyle.Paragraph)
          .setRequired(false)
          .setMaxLength(1000);

        if (panelDescription && panelDescription.trim()) {
          input.setValue(panelDescription.trim());
        }

        const modal = new ModalBuilder()
          .setCustomId(CLAN_PANEL_EDIT_MODAL_ID)
          .setTitle('Edit clan panel')
          .addComponents(new ActionRowBuilder().addComponents(input));

        await interaction.showModal(modal);
        return;
      }

      if (subcommand === 'post') {
        const channel = interaction.options.getChannel('channel', true);
        if (!channel || channel.type !== ChannelType.GuildText) {
          await interaction.reply({
            components: buildTextComponents('Please select a text channel.'),
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
          components: buildTextComponents('Clan panel was posted and saved.'),
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
            enabled ? 'Ticket reminders were enabled.' : 'Ticket reminders were disabled.'
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
            components: buildTextComponents('An error occurred while processing.'),
            flags: MessageFlags.IsComponentsV2,
            ephemeral: true
          });
        } else {
          await interaction.reply({
            components: buildTextComponents('An error occurred while processing.'),
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

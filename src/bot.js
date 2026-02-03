import { Client, Events, GatewayIntentBits, GuildMember } from 'discord.js';
import { ChannelType, ComponentType, MessageFlags, SeparatorSpacingSize } from 'discord-api-types/v10';
import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { loadConfig } from './config.js';
import { getWelcomeConfig, setWelcomeConfig } from './persistence.js';
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

async function runDeployScript() {
  const cwd = process.cwd();
  let npmCommand = 'npm';
  let npmArgs = ['run', 'deploy'];
  let resolvedPath = npmCommand;
  let useShell = false;

  if (process.platform === 'win32') {
    const npmCliPath = path.resolve(cwd, 'node_modules', 'npm', 'bin', 'npm-cli.js');
    try {
      await fs.access(npmCliPath);
      npmCommand = process.execPath;
      npmArgs = [npmCliPath, ...npmArgs];
      resolvedPath = npmCliPath;
    } catch {
      npmCommand = 'npm.cmd';
      resolvedPath = npmCommand;
      useShell = true;
    }
  }

  return new Promise((resolve, reject) => {
    const child = spawn(npmCommand, npmArgs, {
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      cwd,
      shell: useShell
    });
    const stdoutChunks = [];
    const stderrChunks = [];

    child.stdout.on('data', (chunk) => stdoutChunks.push(chunk));
    child.stderr.on('data', (chunk) => stderrChunks.push(chunk));
    child.on('error', (error) => {
      console.error(`Failed to spawn npm (resolved: ${resolvedPath}, cwd: ${cwd}).`, error);
      reject(error);
    });
    child.on('close', (code, signal) => {
      resolve({
        code,
        signal,
        stdout: Buffer.concat(stdoutChunks).toString('utf8'),
        stderr: Buffer.concat(stderrChunks).toString('utf8')
      });
    });
  });
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
          const updateResult = await runUpdate({ deployCommands: true });
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

      if (subcommand === 'deploy') {
        await interaction.reply({
          components: buildTextComponents('Deploy spuštěn. Chvilku strpení...'),
          flags: MessageFlags.IsComponentsV2,
          ephemeral: true
        });

        try {
          const deployResult = await runDeployScript();
          if (deployResult.stdout) {
            console.log('Deploy stdout:', deployResult.stdout.trim());
          }
          if (deployResult.stderr) {
            console.warn('Deploy stderr:', deployResult.stderr.trim());
          }

          if (deployResult.code !== 0) {
            console.error(`Deploy failed with code ${deployResult.code ?? 'unknown'}.`);
            await interaction.followUp({
              components: buildTextComponents('Deploy selhal. Podívej se do logů.'),
              flags: MessageFlags.IsComponentsV2,
              ephemeral: true
            });
            return;
          }

          const result = await syncApplicationCommands({
            token: cfg.token,
            clientId: cfg.clientId,
            guildId: cfg.guildId
          });
          console.log(
            `Config deploy command sync complete. Loaded: ${result.total}, new: ${result.newlyRegistered}`
          );

          await interaction.followUp({
            components: buildTextComponents(
              `Deploy dokončen. Načteno ${result.total} příkazů, nově ${result.newlyRegistered}.`
            ),
            flags: MessageFlags.IsComponentsV2,
            ephemeral: true
          });
        } catch (e) {
          console.error('Deploy failed:', e);
          await interaction.followUp({
            components: buildTextComponents('Deploy selhal. Podívej se do logů.'),
            flags: MessageFlags.IsComponentsV2,
            ephemeral: true
          });
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

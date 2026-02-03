import { Client, Events, GatewayIntentBits } from 'discord.js';
import { loadConfig } from './config.js';

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

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

client.on(Events.ClientReady, (readyClient) => {
  console.log(`Logged in as ${readyClient.user.tag}`);
});

client.on(Events.InteractionCreate, async (interaction) => {
  try {
    if (!interaction.isChatInputCommand()) return;

    if (interaction.commandName === 'ping') {
      await interaction.reply('Pong!');
    }
  } catch (e) {
    console.error('Interaction error:', e);
    try {
      if (interaction && interaction.isRepliable && interaction.isRepliable()) {
        if (interaction.deferred || interaction.replied) {
          await interaction.followUp({ content: 'Došlo k chybě při zpracování.', ephemeral: true });
        } else {
          await interaction.reply({ content: 'Došlo k chybě při zpracování.', ephemeral: true });
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

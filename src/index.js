import 'dotenv/config';
import { Client, GatewayIntentBits, Partials, Events } from 'discord.js';
import { loadConfig } from './config.js';
import { openDb } from './db/index.js';
import { modules } from './modules.js';
import { collectModules, routeInteraction } from './core/loader.js';
import { fetchGuildMembers } from './core/members.js';
import { startScheduler } from './core/scheduler.js';

process.on('unhandledRejection', (err) => console.error('Unhandled rejection:', err));

const config = loadConfig();
const db = await openDb(config.databaseUrl);
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildExpressions,
    GatewayIntentBits.GuildModeration,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.AutoModerationExecution,
  ],
  partials: [Partials.Message, Partials.Channel, Partials.GuildMember, Partials.User],
});
const ctx = { db, client };
const registry = collectModules(modules);
ctx.commands = registry.commands;

for (const event of registry.events) {
  const run = async (...args) => {
    try {
      await event.execute(ctx, ...args);
    } catch (err) {
      console.error(`Event ${event.name} failed:`, err);
    }
  };
  if (event.once) client.once(event.name, run);
  else client.on(event.name, run);
}

client.on(Events.InteractionCreate, (interaction) => routeInteraction(interaction, ctx, registry));
client.on(Events.Error, (err) => console.error('Discord client error:', err));
client.once(Events.ClientReady, async (c) => {
  console.log(`Logged in as ${c.user.tag}`);
  startScheduler(ctx, registry);
  for (const guild of c.guilds.cache.values()) await fetchGuildMembers(guild);
});
client.on(Events.GuildCreate, (guild) => fetchGuildMembers(guild));

await client.login(config.token);

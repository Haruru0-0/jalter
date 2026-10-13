import 'dotenv/config';
import { Client, GatewayIntentBits, Partials, Events } from 'discord.js';
import { loadConfig } from './config.js';
import { openDb } from './db/index.js';
import { modules } from './modules.js';
import { collectModules, routeInteraction } from './core/loader.js';

const config = loadConfig();
const db = await openDb(config.databaseUrl);
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
  partials: [Partials.Message, Partials.Channel],
});
const ctx = { db, client };
const registry = collectModules(modules);

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
client.once(Events.ClientReady, (c) => console.log(`Logged in as ${c.user.tag}`));

await client.login(config.token);

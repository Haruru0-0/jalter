import 'dotenv/config';
import { REST, Routes } from 'discord.js';
import { loadConfig } from './config.js';
import { modules } from './modules.js';
import { collectModules } from './core/loader.js';

const config = loadConfig();
const { commands } = collectModules(modules);
const body = [...commands.values()].map((c) => c.data.toJSON());
const rest = new REST().setToken(config.token);
const route = config.devGuildId
  ? Routes.applicationGuildCommands(config.clientId, config.devGuildId)
  : Routes.applicationCommands(config.clientId);
await rest.put(route, { body });
console.log(`Registered ${body.length} commands ${config.devGuildId ? 'to the dev guild' : 'globally'}.`);

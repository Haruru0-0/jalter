import { getLang, t } from '../i18n/index.js';
import { ephemeral } from './replies.js';

export function collectModules(modules) {
  const commands = new Map();
  const components = new Map();
  const events = [];
  for (const mod of modules) {
    for (const command of mod.commands ?? []) {
      const name = command.data.name;
      if (commands.has(name)) throw new Error(`Duplicate command: ${name}`);
      commands.set(name, command);
      if (command.components) {
        const { prefix } = command.components;
        if (components.has(prefix)) throw new Error(`Duplicate component prefix: ${prefix}`);
        components.set(prefix, command.components);
      }
    }
    events.push(...(mod.events ?? []));
  }
  return { commands, components, events };
}

export async function routeInteraction(interaction, ctx, registry) {
  try {
    if (interaction.isChatInputCommand() || interaction.isContextMenuCommand()) {
      await registry.commands.get(interaction.commandName)?.execute(interaction, ctx);
      return;
    }
    if (interaction.customId) {
      const prefix = interaction.customId.split(':')[0];
      await registry.components.get(prefix)?.handle(interaction, ctx);
    }
  } catch (err) {
    console.error('Interaction failed:', err);
    try {
      const lang = interaction.guildId ? await getLang(ctx.db, interaction.guildId) : 'en';
      const payload = ephemeral(t(lang, 'common.error'));
      if (interaction.replied || interaction.deferred) await interaction.followUp(payload);
      else await interaction.reply(payload);
    } catch {
      // nothing more we can do
    }
  }
}

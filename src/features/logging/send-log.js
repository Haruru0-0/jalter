import { getFeature, setFeature } from '../../db/settings.js';
import { ensureChannel, ensurePrivateCategory, serialize, withBackoff } from '../../core/auto-channel.js';
import { categoryOf } from './events.js';
import { fetchSendable, trySend } from '../../core/send.js';
import { getLang } from '../../i18n/index.js';
import { withExecutor } from './format.js';
import { isEventEnabled, isIgnored, resolveChannelId } from './config.js';

// Creates the log channel for an event's category and saves it. The whole logging creation path runs one
// at a time per guild (categories share the Logs category and the saved config), with a failure backoff per
// category. Returns the channel id, or null when creation failed. Never throws.
async function createLogChannel(ctx, guildId, event) {
  const category = categoryOf(event);
  return serialize(`${guildId}:logging`, () => withBackoff(`${guildId}:${category}`, async () => {
    const made = [];
    try {
      const { config } = await getFeature(ctx.db, guildId, 'logging');
      const existing = resolveChannelId(config, event);
      if (existing) return existing;
      const guild = ctx.client.guilds.cache.get(guildId) ?? (await ctx.client.guilds.fetch(guildId));
      let categoryId = config.categoryId;
      const parent = categoryId ? await guild.channels.fetch(categoryId).catch(() => null) : null;
      if (!parent) {
        const created = await ensurePrivateCategory(guild, 'Logs');
        if (!created) return null;
        made.push(created);
        categoryId = created.id;
      }
      const channel = await ensureChannel(guild, {
        name: category === 'default' ? 'logs' : `${category}-logs`,
        parentId: categoryId,
      });
      if (!channel) {
        for (const c of made) await c.delete?.().catch(() => {});
        return null;
      }
      made.push(channel);
      const channels = { ...(config.channels ?? {}), [category]: channel.id };
      await setFeature(ctx.db, guildId, 'logging', { config: { channels, categoryId } });
      return channel.id;
    } catch (err) {
      console.warn(`Could not create log channel in ${guildId}: ${err.message}`);
      for (const c of made.reverse()) await Promise.resolve(c.delete?.()).catch(() => {});
      return null;
    }
  }));
}

export async function sendLog(ctx, guildId, event, embed, opts = {}) {
  try {
    const { enabled, config } = await getFeature(ctx.db, guildId, 'logging');
    if (!enabled) return null;
    if (!isEventEnabled(config, event)) return null;
    if (opts.ignore && isIgnored(config, opts.ignore)) return null;
    if (opts.sourceChannelId && Object.values(config.channels ?? {}).includes(opts.sourceChannelId)) return null;
    const channelId = resolveChannelId(config, event) ?? (await createLogChannel(ctx, guildId, event));
    if (!channelId) return null;
    const channel = await fetchSendable(ctx.client, channelId);
    if (!channel) {
      console.warn(`Log channel for ${event} missing in guild ${guildId}`);
      return null;
    }
    let finalEmbed = embed;
    if (opts.executor) {
      const executorId = await opts.executor().catch(() => null);
      if (executorId) finalEmbed = withExecutor(embed, executorId, await getLang(ctx.db, guildId));
    }
    const message = await trySend(channel, { embeds: [{ ...finalEmbed, timestamp: new Date().toISOString() }], allowedMentions: { parse: [] } });
    return message ? { channelId: message.channelId, messageId: message.id } : null;
  } catch (err) {
    console.warn(`Could not write log in ${guildId}: ${err.message}`);
    return null;
  }
}

// Wraps an event handler so it can never throw into the event loop.
export function safe(name, handler) {
  return async (ctx, ...args) => {
    try {
      await handler(ctx, ...args);
    } catch (err) {
      console.warn(`Logging handler ${name} failed: ${err.message}`);
    }
  };
}

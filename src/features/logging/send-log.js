import { getFeature } from '../../db/settings.js';
import { fetchSendable, trySend } from '../../core/send.js';
import { getLang } from '../../i18n/index.js';
import { withExecutor } from './format.js';
import { isEventEnabled, isIgnored, resolveChannelId } from './config.js';

export async function sendLog(ctx, guildId, event, embed, opts = {}) {
  try {
    const { enabled, config } = await getFeature(ctx.db, guildId, 'logging');
    if (!enabled) return null;
    if (!isEventEnabled(config, event)) return null;
    if (opts.ignore && isIgnored(config, opts.ignore)) return null;
    const channelId = resolveChannelId(config, event);
    if (!channelId) return null;
    if (opts.sourceChannelId && Object.values(config.channels ?? {}).includes(opts.sourceChannelId)) return null;
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

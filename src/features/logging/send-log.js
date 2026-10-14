import { getFeature } from '../../db/settings.js';
import { fetchSendable, trySend } from '../../core/send.js';
import { isEventEnabled, isIgnored, resolveChannelId } from './config.js';

export async function sendLog(ctx, guildId, event, embed, opts = {}) {
  try {
    const { enabled, config } = await getFeature(ctx.db, guildId, 'logging');
    if (!enabled) return;
    if (!isEventEnabled(config, event)) return;
    if (opts.ignore && isIgnored(config, opts.ignore)) return;
    const channelId = resolveChannelId(config, event);
    if (!channelId) return;
    if (opts.sourceChannelId && Object.values(config.channels ?? {}).includes(opts.sourceChannelId)) return;
    const channel = await fetchSendable(ctx.client, channelId);
    if (!channel) {
      console.warn(`Log channel for ${event} missing in guild ${guildId}`);
      return;
    }
    await trySend(channel, { embeds: [{ ...embed, timestamp: new Date().toISOString() }], allowedMentions: { parse: [] } });
  } catch (err) {
    console.warn(`Could not write log in ${guildId}: ${err.message}`);
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

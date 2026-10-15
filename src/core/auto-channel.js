import { ChannelType, PermissionFlagsBits } from 'discord.js';

const inflight = new Map();

/** Runs `fn` once per key at a time: callers arriving while it runs share its promise. */
export function singleFlight(key, fn) {
  const running = inflight.get(key);
  if (running) return running;
  const promise = (async () => fn())().finally(() => inflight.delete(key));
  inflight.set(key, promise);
  return promise;
}

export const BACKOFF_MS = 10 * 60 * 1000;
const retryAfter = new Map();
let now = () => Date.now();

/** Tests only: replaces the clock (pass nothing to restore it) and forgets all failures. */
export function resetBackoff(clock) {
  retryAfter.clear();
  now = clock ?? (() => Date.now());
}

/**
 * Runs `fn` (which returns a truthy value on success and null on failure) unless this key failed less than
 * 10 minutes ago, in which case it returns null without calling it. A success clears the failure.
 */
export async function withBackoff(key, fn) {
  if ((retryAfter.get(key) ?? 0) > now()) return null;
  const result = await fn();
  if (result) retryAfter.delete(key);
  else retryAfter.set(key, now() + BACKOFF_MS);
  return result;
}

/** Creates a text channel (needs Manage Channels). Returns the channel, or null after a warning. Never throws. */
export async function ensureChannel(guild, { name, parentId, type = ChannelType.GuildText }) {
  try {
    const options = { name, type };
    if (parentId) options.parent = parentId;
    return await guild.channels.create(options);
  } catch (err) {
    console.warn(`Could not create channel ${name} in ${guild?.id}: ${err.message}`);
    return null;
  }
}

/** Creates a category only the bot can see. Returns it, or null after a warning. */
export async function ensurePrivateCategory(guild, name) {
  try {
    return await guild.channels.create({
      name,
      type: ChannelType.GuildCategory,
      permissionOverwrites: [
        { id: guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
        { id: guild.members.me.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages] },
      ],
    });
  } catch (err) {
    console.warn(`Could not create category ${name} in ${guild?.id}: ${err.message}`);
    return null;
  }
}

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

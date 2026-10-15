import { getFeature, setFeature } from '../../db/settings.js';
import { ensureChannel } from '../../core/auto-channel.js';
import { DEFAULT_MESSAGE } from './kinds.js';

export const AUTO_CHANNEL_NAME = { greet: 'welcome', leave: 'goodbye', boost: 'boosts' };

export async function getKindConfig(db, guildId, kind) {
  const { enabled, config } = await getFeature(db, guildId, kind);
  return { enabled, config };
}

export async function setChannel(db, guildId, kind, channelId) {
  const { config } = await getKindConfig(db, guildId, kind);
  await setFeature(db, guildId, kind, {
    enabled: true,
    config: { channelId, message: config.message ?? DEFAULT_MESSAGE[kind] },
  });
}

/**
 * `none` / `disable` turn the kind off; any other text is stored.
 * Returns 'disabled' | 'saved' | 'saved-needs-channel', or { status: 'created', channelId } when no channel
 * was chosen and a guild is given, so a public channel was made and the kind turned on.
 */
export async function applyMessage(db, guildId, kind, text, guild) {
  const trimmed = text.trim();
  if (['none', 'disable'].includes(trimmed.toLowerCase())) {
    await setFeature(db, guildId, kind, { enabled: false });
    return 'disabled';
  }
  const { config } = await getKindConfig(db, guildId, kind);
  if (config.channelId) {
    await setFeature(db, guildId, kind, { enabled: true, config: { message: text } });
    return 'saved';
  }
  const channel = guild ? await ensureChannel(guild, { name: AUTO_CHANNEL_NAME[kind] }) : null;
  if (channel) {
    await setFeature(db, guildId, kind, { enabled: true, config: { message: text, channelId: channel.id } });
    return { status: 'created', channelId: channel.id };
  }
  await setFeature(db, guildId, kind, { config: { message: text } });
  return 'saved-needs-channel';
}

export const setCard = (db, guildId, kind, on) =>
  setFeature(db, guildId, kind, { config: { card: Boolean(on) } });

export const setDm = (db, guildId, kind, on) =>
  setFeature(db, guildId, kind, { config: { dm: Boolean(on) } });

/** `value` is an image link or stored image name; null removes the background. */
export async function setBackground(db, guildId, kind, value) {
  if (value == null) {
    await db.query(
      "UPDATE guild_settings SET config = config - 'background' WHERE guild_id = $1 AND feature = $2",
      [guildId, kind],
    );
    return;
  }
  await setFeature(db, guildId, kind, { config: { background: value } });
}

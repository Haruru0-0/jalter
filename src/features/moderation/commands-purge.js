import { SlashCommandBuilder, ChannelType, MessageFlags, ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';
import { getFeature } from '../../db/settings.js';
import { guard } from '../../core/guard.js';
import { ephemeral } from '../../core/replies.js';
import { t } from '../../i18n/index.js';
import { readConfig } from './config.js';
import { checkToolAccess, logTool, postNotice } from './tools-common.js';
import { moveChannelId, mediaHoldsChannel } from './channel-move.js';

const CONFIRM_TTL_MS = 120_000;
const CHANNEL_TYPES = [ChannelType.GuildText, ChannelType.GuildAnnouncement];
// No SendMessages: a locked channel denies it to the bot too; the notice in the copy is best effort.
const CHANNEL_BOT_PERMISSIONS = ['ViewChannel', 'ManageChannels', 'ManageRoles'];

const REASON_MAX = 400;
const COUNT_MAX = 100;
const PAGE_SIZE = 100;
const SCAN_MAX = 500;
const MAX_AGE_MS = 1_209_600_000; // Discord's bulk-delete limit: 14 days

const MESSAGE_TYPES = [
  ChannelType.GuildText, ChannelType.GuildAnnouncement,
  ChannelType.PublicThread, ChannelType.PrivateThread, ChannelType.AnnouncementThread,
];

/**
 * Pure selection of what to delete. Newest first; pinned and too-old messages are skipped (and counted),
 * the filters apply before counting, and it stops at `count` matches.
 */
export function selectPurgeTargets(messages, { count, userId = null, botsOnly = false, nowMs = Date.now() }) {
  const ordered = [...messages].sort((a, b) => b.createdTimestamp - a.createdTimestamp);
  const toDelete = [];
  let skippedOld = 0;
  let skippedPinned = 0;
  for (const m of ordered) {
    if (toDelete.length >= count) break;
    if (userId && m.author?.id !== userId) continue;
    if (botsOnly && !m.author?.bot) continue;
    if (m.pinned) { skippedPinned += 1; continue; }
    if (nowMs - m.createdTimestamp > MAX_AGE_MS) { skippedOld += 1; continue; }
    toDelete.push(m);
  }
  return { toDelete, skippedOld, skippedPinned };
}

function buildPurge() {
  return new SlashCommandBuilder().setName('purge').setDescription('Delete messages in bulk')
    .addSubcommand((s) => s.setName('messages').setDescription('Delete recent messages in this channel')
      .addIntegerOption((o) => o.setName('count').setDescription('How many messages to delete').setRequired(true).setMinValue(1).setMaxValue(COUNT_MAX))
      .addUserOption((o) => o.setName('user').setDescription('Only delete messages from this member'))
      .addBooleanOption((o) => o.setName('bots').setDescription('Only delete messages written by bots'))
      .addStringOption((o) => o.setName('reason').setDescription('Why (kept in the mod log)').setMaxLength(REASON_MAX)))
    .addSubcommand((s) => s.setName('channel').setDescription('Delete a channel and recreate it empty')
      .addChannelOption((o) => o.setName('channel').setDescription('Channel to purge (default: this one)').addChannelTypes(...CHANNEL_TYPES))
      .addStringOption((o) => o.setName('reason').setDescription('Why (kept in the mod log)').setMaxLength(REASON_MAX)));
}

/** Newest-first scan of up to SCAN_MAX messages, skipping the command's own reply. */
async function fetchRecent(channel, interaction) {
  const all = [];
  let before;
  while (all.length < SCAN_MAX) {
    const page = [...(await channel.messages.fetch({ limit: PAGE_SIZE, ...(before ? { before } : {}) })).values()];
    all.push(...page);
    if (page.length < PAGE_SIZE) break;
    before = page.reduce((oldest, m) => (m.createdTimestamp < oldest.createdTimestamp ? m : oldest)).id;
  }
  return all.filter((m) => m.interaction?.id !== interaction.id && m.interactionMetadata?.id !== interaction.id);
}

async function executeMessages(interaction, ctx) {
  const lang = await guard(interaction, ctx, 'moderation', { requireManager: false });
  if (!lang) return;
  const { config: raw } = await getFeature(ctx.db, interaction.guildId, 'moderation');
  const config = readConfig(raw);
  const channel = interaction.channel;
  const typeOk = Boolean(channel) && MESSAGE_TYPES.includes(channel.type);
  const access = checkToolAccess({
    interaction, action: 'purge', config, channel: typeOk ? channel : null,
    botPermissions: ['ViewChannel', 'ReadMessageHistory', 'ManageMessages'],
  });
  if (!access.ok) {
    await interaction.reply(ephemeral(t(lang, `moderation.tools.err.${access.reason}`)));
    return;
  }
  const count = interaction.options.getInteger('count', true);
  const user = interaction.options.getUser('user');
  const botsOnly = interaction.options.getBoolean('bots') ?? false;
  const reason = interaction.options.getString('reason');
  if (user && botsOnly) {
    await interaction.reply(ephemeral(t(lang, 'moderation.tools.purge.pick_one')));
    return;
  }
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  let picked;
  let deleted = 0;
  try {
    const recent = await fetchRecent(channel, interaction);
    picked = selectPurgeTargets(recent, { count, userId: user?.id ?? null, botsOnly, nowMs: Date.now() });
    if (picked.toDelete.length) {
      const result = await channel.bulkDelete(picked.toDelete, true);
      deleted = result?.size ?? picked.toDelete.length;
    }
  } catch (err) {
    console.warn(`Purge failed: ${err?.code ?? ''} ${err?.message}`);
    await interaction.editReply({ content: t(lang, 'moderation.tools.err.failed') });
    return;
  }

  if (deleted === 0) {
    const none = t(lang, 'moderation.tools.purge.none');
    await interaction.editReply({ content: picked.skippedOld || picked.skippedPinned ? `${none}\n${skipNote(lang, picked)}` : none });
    return;
  }
  const lines = [t(lang, 'moderation.tools.purge.reply', { count: deleted })];
  if (deleted < count) lines.push(t(lang, 'moderation.tools.purge.note_fewer', { found: deleted, count }));
  if (picked.skippedOld || picked.skippedPinned) lines.push(skipNote(lang, picked));
  await logTool(ctx, interaction.guild, lang, {
    tool: 'purge', actorId: interaction.user.id, channelId: channel.id,
    detail: t(lang, 'moderation.tools.purge.reply', { count: deleted }), reason,
  });
  await interaction.editReply({ content: lines.join('\n') });
}

const skipNote = (lang, p) => t(lang, 'moderation.tools.purge.note_skipped', { old: p.skippedOld, pinned: p.skippedPinned });

async function execute(interaction, ctx) {
  switch (interaction.options.getSubcommand()) {
    case 'messages': return executeMessages(interaction, ctx);
    case 'channel': return executeChannel(interaction, ctx);
    default: return undefined;
  }
}

// Reasons are too long for a custom id; keep them in memory until the confirm expires.
const pendingReasons = new Map();
const inFlight = new Set();
const dropReasons = (userId) => {
  for (const k of pendingReasons.keys()) if (k.startsWith(userId + ':')) pendingReasons.delete(k);
};
const reasonKey = (userId, channelId, createdAt) => `${userId}:${channelId}:${createdAt}`;

/** Shared by the command and the Confirm press. Returns an i18n key under moderation.tools, or null. */
async function channelProblem(interaction, ctx, channel) {
  const { config: raw } = await getFeature(ctx.db, interaction.guildId, 'moderation');
  const typeOk = Boolean(channel) && CHANNEL_TYPES.includes(channel.type);
  const access = checkToolAccess({
    interaction, action: 'purgeall', config: readConfig(raw), channel: typeOk ? channel : null,
    botPermissions: CHANNEL_BOT_PERMISSIONS,
  });
  if (!access.ok) return `err.${access.reason}`;
  const { guild } = interaction;
  if (channel.id === guild.rulesChannelId || channel.id === guild.publicUpdatesChannelId) return 'purge.protected';
  if (await mediaHoldsChannel(ctx.db, guild.id, channel.id)) return 'purge.media_here';
  return null;
}

async function executeChannel(interaction, ctx) {
  const lang = await guard(interaction, ctx, 'moderation', { requireManager: false });
  if (!lang) return;
  const channel = interaction.options.getChannel('channel') ?? interaction.channel;
  const problem = await channelProblem(interaction, ctx, channel);
  if (problem) {
    await interaction.reply(ephemeral(t(lang, `moderation.tools.${problem}`)));
    return;
  }
  const createdAt = Date.now();
  const reason = interaction.options.getString('reason');
  if (reason) {
    const key = reasonKey(interaction.user.id, channel.id, createdAt);
    pendingReasons.set(key, reason);
    setTimeout(() => pendingReasons.delete(key), CONFIRM_TTL_MS + 5000).unref?.();
  }
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`purge:ok:${interaction.user.id}:${channel.id}:${createdAt}`)
      .setLabel(t(lang, 'moderation.tools.purge.confirm')).setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId(`purge:no:${interaction.user.id}`)
      .setLabel(t(lang, 'moderation.tools.purge.cancel')).setStyle(ButtonStyle.Secondary),
  );
  await interaction.reply(ephemeral({
    content: t(lang, 'moderation.tools.purge.warning', { channel: `<#${channel.id}>` }),
    components: [row],
  }));
}

async function handle(interaction, ctx) {
  const [, action, userId, channelId, createdRaw] = interaction.customId.split(':');
  if (!interaction.isButton?.() || !['ok', 'no'].includes(action)) return;
  const lang = await guard(interaction, ctx, 'moderation', { requireManager: false });
  if (!lang) return;
  if (interaction.user.id !== userId) {
    await interaction.reply(ephemeral(t(lang, 'moderation.tools.purge.not_yours')));
    return;
  }
  if (action === 'no') {
    dropReasons(userId);
    await interaction.update({ content: t(lang, 'moderation.tools.purge.cancelled'), components: [] });
    return;
  }
  const createdAt = Number(createdRaw);
  const age = Date.now() - createdAt;
  if (!Number.isFinite(age) || age > CONFIRM_TTL_MS || age < -5000) {
    dropReasons(userId);
    await interaction.update({ content: t(lang, 'moderation.tools.purge.expired'), components: [] });
    return;
  }
  if (inFlight.has(channelId)) {
    await interaction.reply(ephemeral(t(lang, 'moderation.tools.purge.in_progress')));
    return;
  }
  inFlight.add(channelId);
  try {
    await interaction.deferUpdate();
    await runConfirm(interaction, ctx, lang, userId, channelId, createdAt);
  } catch (err) {
    console.warn('Purge channel: confirm failed: '+err?.message);
    try {
      await interaction.editReply({ content: t(lang, 'moderation.tools.err.failed'), components: [] });
    } catch (editErr) {
      console.warn('Purge channel: could not report failure: '+editErr?.message);
    }
  } finally {
    inFlight.delete(channelId);
  }
}

async function runConfirm(interaction, ctx, lang, userId, channelId, createdAt) {
  const finish = (content) => interaction.editReply({ content, components: [] });
  const { guild } = interaction;
  const old = guild.channels.cache.get(channelId) ?? await guild.channels.fetch(channelId).catch(() => null);
  if (!old) {
    await finish(t(lang, 'moderation.tools.purge.gone'));
    return;
  }
  const problem = await channelProblem(interaction, ctx, old);
  if (problem) {
    await finish(t(lang, `moderation.tools.${problem}`));
    return;
  }
  const key = reasonKey(userId, channelId, createdAt);
  const reason = pendingReasons.get(key) ?? null;
  pendingReasons.delete(key);
  const auditReason = `Purged by ${userId}${reason ? `: ${reason}` : ''}`.slice(0, 512);

  let clone;
  try {
    clone = await old.clone({ reason: auditReason });
  } catch (err) {
    console.warn(`Purge channel: clone failed: ${err?.code ?? ''} ${err?.message}`);
    await finish(t(lang, 'moderation.tools.err.failed'));
    return;
  }
  const mention = `<#${clone.id}>`;
  let positionFailed = false;
  try {
    await clone.setPosition(old.position);
  } catch (err) {
    console.warn(`Purge channel: position failed: ${err?.message}`);
    positionFailed = true;
  }
  try {
    await moveChannelId(ctx.db, guild.id, old.id, clone.id);
  } catch (err) {
    console.warn(`Purge channel: settings move failed: ${err?.message}`);
    let removed = true;
    try {
      await clone.delete(auditReason);
    } catch (delErr) {
      console.warn(`Purge channel: clone cleanup failed: ${delErr?.message}`);
      removed = false;
    }
    await finish(removed
      ? t(lang, 'moderation.tools.purge.move_failed')
      : t(lang, 'moderation.tools.purge.move_failed_clone_left', { channel: mention }));
    return;
  }
  // From here on the channels have changed: a failed edit must never reach the "nothing was changed" path.
  // (The confirm message may have lived in the channel just deleted.)
  const finishChanged = async (content) => {
    try {
      await finish(content);
    } catch (err) {
      console.warn(`Purge channel: could not edit the result: ${err?.message}`);
    }
  };
  try {
    await old.delete(auditReason);
  } catch (err) {
    console.warn(`Purge channel: old channel delete failed: ${err?.code ?? ''} ${err?.message}`);
    const partial = t(lang, 'moderation.tools.purge.old_delete_failed', { channel: mention });
    await logTool(ctx, guild, lang, {
      tool: 'purge channel', actorId: userId, channelId: clone.id, detail: partial, reason,
    });
    await finishChanged(partial);
    return;
  }
  const posted = await postNotice(clone, { content: t(lang, 'moderation.tools.purge.notice') });
  const done = t(lang, 'moderation.tools.purge.done', { channel: mention });
  await logTool(ctx, guild, lang, {
    tool: 'purge channel', actorId: userId, channelId: clone.id, detail: done, reason,
  });
  const lines = [done];
  if (positionFailed) lines.push(t(lang, 'moderation.tools.purge.position_failed'));
  if (!posted) lines.push(t(lang, 'moderation.tools.notice_failed'));
  await finishChanged(lines.join('\n'));
}

export const purgeCommand = { data: buildPurge(), execute, components: { prefix: 'purge', handle } };

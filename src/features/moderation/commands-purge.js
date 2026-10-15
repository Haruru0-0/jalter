import { SlashCommandBuilder, ChannelType, MessageFlags } from 'discord.js';
import { getFeature } from '../../db/settings.js';
import { guard } from '../../core/guard.js';
import { ephemeral } from '../../core/replies.js';
import { t } from '../../i18n/index.js';
import { readConfig } from './config.js';
import { checkToolAccess, logTool } from './tools-common.js';

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
    default: return undefined;
  }
}

export const purgeCommand = { data: buildPurge(), execute };

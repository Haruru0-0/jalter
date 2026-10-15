import { SlashCommandBuilder } from 'discord.js';
import { getFeature } from '../../db/settings.js';
import { guard } from '../../core/guard.js';
import { ephemeral } from '../../core/replies.js';
import { t } from '../../i18n/index.js';
import { readConfig } from './config.js';
import { canUseAction } from './rules.js';
import { formatCase } from './format.js';
import {
  listWarnings, editWarning, deactivateWarning, clearWarnings, topWarnings, getCase, setCaseReason,
} from './store.js';

const REASON_MAX = 400;
const LIST_MAX = 25;
const TOP_MAX = 10;
const LINE_REASON_MAX = 100;
// Discord caps message content at 2000; leave room for the tail line.
const LIST_BUDGET = 1900;

const warnings = new SlashCommandBuilder()
  .setName('warnings')
  .setDescription('View and manage warnings')
  .addSubcommand((s) => s.setName('list').setDescription('List active warnings')
    .addUserOption((o) => o.setName('user').setDescription('The user (default: you)')))
  .addSubcommand((s) => s.setName('edit').setDescription('Change the reason of a warning')
    .addIntegerOption((o) => o.setName('id').setDescription('The warning id (its case number)').setRequired(true).setMinValue(1))
    .addStringOption((o) => o.setName('reason').setDescription('The new reason').setRequired(true).setMaxLength(REASON_MAX)))
  .addSubcommand((s) => s.setName('delete').setDescription('Remove one warning')
    .addIntegerOption((o) => o.setName('id').setDescription('The warning id (its case number)').setRequired(true).setMinValue(1)))
  .addSubcommand((s) => s.setName('clear').setDescription('Remove all active warnings of a user')
    .addUserOption((o) => o.setName('user').setDescription('The user (mention or ID)').setRequired(true)))
  .addSubcommand((s) => s.setName('top').setDescription('Show the users with the most active warnings'));

const reason = new SlashCommandBuilder()
  .setName('reason')
  .setDescription('Change the reason of a moderation case')
  .addIntegerOption((o) => o.setName('case').setDescription('The case number').setRequired(true).setMinValue(1))
  .addStringOption((o) => o.setName('reason').setDescription('The new reason').setRequired(true).setMaxLength(REASON_MAX));

async function load(interaction, ctx) {
  const lang = await guard(interaction, ctx, 'moderation', { requireManager: false });
  if (!lang) return null;
  const { config: raw } = await getFeature(ctx.db, interaction.guildId, 'moderation');
  return { lang, config: readConfig(raw) };
}

const deny = (interaction, lang) => interaction.reply(ephemeral(t(lang, 'moderation.err.not_allowed')));
const reply = (interaction, content) => interaction.reply(ephemeral(content));

function clip(text) {
  const flat = text.replace(/\s+/g, ' ');
  return flat.length > LINE_REASON_MAX ? `${flat.slice(0, LINE_REASON_MAX - 1)}…` : flat;
}

function warningLine(lang, w) {
  return t(lang, 'moderation.warnings.line', {
    number: w.number,
    date: `<t:${Math.floor(w.createdAt / 1000)}:d>`,
    moderator: w.moderatorId,
    reason: w.reason ? clip(w.reason) : t(lang, 'moderation.case.noReason'),
  });
}

async function list(interaction, ctx, lang, config) {
  const picked = interaction.options.getUser('user');
  const userId = picked?.id ?? interaction.user.id;
  if (userId !== interaction.user.id && !canUseAction(interaction.member, 'warnings', config)) {
    return deny(interaction, lang);
  }
  const rows = await listWarnings(ctx.db, interaction.guildId, userId);
  if (rows.length === 0) return reply(interaction, t(lang, 'moderation.warnings.none', { user: userId }));
  const lines = [t(lang, 'moderation.warnings.header', { user: userId, count: rows.length })];
  let shown = 0;
  let length = lines[0].length;
  for (const w of rows.slice(0, LIST_MAX)) {
    const line = warningLine(lang, w);
    if (length + line.length + 1 > LIST_BUDGET) break;
    lines.push(line);
    length += line.length + 1;
    shown += 1;
  }
  if (rows.length > shown) lines.push(t(lang, 'moderation.warnings.more', { count: rows.length - shown }));
  return reply(interaction, lines.join('\n'));
}

async function top(interaction, ctx, lang) {
  const rows = await topWarnings(ctx.db, interaction.guildId, TOP_MAX);
  if (rows.length === 0) return reply(interaction, t(lang, 'moderation.warnings.top_none'));
  const lines = [t(lang, 'moderation.warnings.top_header')];
  rows.forEach((r, i) => lines.push(t(lang, 'moderation.warnings.top_line', { rank: i + 1, user: r.userId, count: r.count })));
  return reply(interaction, lines.join('\n'));
}

async function executeWarnings(interaction, ctx) {
  const loaded = await load(interaction, ctx);
  if (!loaded) return;
  const { lang, config } = loaded;
  const sub = interaction.options.getSubcommand();
  if (sub === 'list') return list(interaction, ctx, lang, config);
  if (!canUseAction(interaction.member, 'warnings', config)) return deny(interaction, lang);

  const guildId = interaction.guildId;
  if (sub === 'top') return top(interaction, ctx, lang);
  if (sub === 'clear') {
    const user = interaction.options.getUser('user', true);
    const count = await clearWarnings(ctx.db, guildId, user.id);
    return reply(interaction, t(lang, 'moderation.warnings.cleared', { count, user: user.id }));
  }
  const id = interaction.options.getInteger('id', true);
  if (sub === 'edit') {
    const text = interaction.options.getString('reason', true).trim();
    if (text === '') return reply(interaction, t(lang, 'moderation.err.reason_required'));
    const ok = await editWarning(ctx.db, guildId, id, text);
    return reply(interaction, ok
      ? t(lang, 'moderation.warnings.edited', { number: id })
      : t(lang, 'moderation.err.no_such_warning'));
  }
  const ok = await deactivateWarning(ctx.db, guildId, id);
  return reply(interaction, ok
    ? t(lang, 'moderation.warnings.deleted', { number: id })
    : t(lang, 'moderation.err.no_such_warning'));
}

/** Best effort: the case is already updated, so any failure here is ignored. */
async function refreshLogMessage(ctx, modCase, lang) {
  if (!modCase.logChannelId || !modCase.logMessageId) return;
  try {
    const channel = await ctx.client.channels.fetch(modCase.logChannelId);
    const message = await channel.messages.fetch(modCase.logMessageId);
    await message.edit({ embeds: [formatCase(modCase, lang)], allowedMentions: { parse: [] } });
  } catch {
    // The log message may be deleted or the channel gone; nothing to do.
  }
}

async function executeReason(interaction, ctx) {
  const loaded = await load(interaction, ctx);
  if (!loaded) return;
  const { lang, config } = loaded;
  if (!canUseAction(interaction.member, 'reason', config)) return deny(interaction, lang);

  const number = interaction.options.getInteger('case', true);
  const text = interaction.options.getString('reason', true).trim();
  if (text === '') return reply(interaction, t(lang, 'moderation.err.reason_required'));
  const ok = await setCaseReason(ctx.db, interaction.guildId, number, text);
  if (!ok) return reply(interaction, t(lang, 'moderation.err.no_such_case'));
  const updated = await getCase(ctx.db, interaction.guildId, number);
  if (updated) await refreshLogMessage(ctx, updated, lang);
  return reply(interaction, t(lang, 'moderation.reason.done', { number }));
}

export const warningCommands = [
  { data: warnings, execute: executeWarnings },
  { data: reason, execute: executeReason },
];

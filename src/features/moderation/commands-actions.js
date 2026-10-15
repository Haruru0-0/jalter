import { SlashCommandBuilder, MessageFlags } from 'discord.js';
import { getFeature } from '../../db/settings.js';
import { guard } from '../../core/guard.js';
import { ephemeral } from '../../core/replies.js';
import { parseDuration, formatDuration } from '../../core/duration.js';
import { t } from '../../i18n/index.js';
import { readConfig } from './config.js';
import { canUseAction } from './rules.js';
import { runAction } from './actions.js';

const REASON_MAX = 400;
const DURATION_MAX = 32;

const DEFS = [
  { name: 'warn', description: 'Warn a member', duration: false },
  { name: 'timeout', description: 'Time a member out', duration: true },
  { name: 'untimeout', description: 'Remove a member\'s timeout', duration: false },
  { name: 'mute', description: 'Give a member the mute role', duration: true },
  { name: 'unmute', description: 'Remove the mute role from a member', duration: false },
  { name: 'kick', description: 'Kick a member from the server', duration: false },
  { name: 'ban', description: 'Ban a user from the server', duration: true, deleteDays: true },
  { name: 'unban', description: 'Unban a user', duration: false },
];

function build(def) {
  const b = new SlashCommandBuilder().setName(def.name).setDescription(def.description);
  b.addUserOption((o) => o.setName('user').setDescription('The user (mention or ID)').setRequired(true));
  if (def.duration) {
    b.addStringOption((o) => o.setName('duration')
      .setDescription('For example 30m, 2h or 7d; empty for the default').setMaxLength(DURATION_MAX));
  }
  if (def.deleteDays) {
    b.addIntegerOption((o) =>
      o.setName('delete_days').setDescription('Days of their messages to delete (0 to 7)').setMinValue(0).setMaxValue(7));
  }
  b.addStringOption((o) => o.setName('reason').setDescription('Why').setMaxLength(REASON_MAX));
  return b;
}

const UNKNOWN_MEMBER = 10007;

async function fetchMember(guild, id) {
  try {
    return await guild.members.fetch(id);
  } catch (err) {
    // Not in the server: the engine decides what that means for the action. Any other failure
    // must not pass as "not a member", or the hierarchy checks would be skipped.
    if (err?.code === UNKNOWN_MEMBER) return null;
    throw err;
  }
}

function successText(lang, type, modCase, warnings) {
  const lines = [];
  if (modCase) {
    const key = type === 'warn' ? 'moderation.done.warn' : 'moderation.done';
    lines.push(t(lang, key, { type: t(lang, `moderation.type.${type}`), number: modCase.number }));
    if (modCase.durationMs) {
      lines.push(t(lang, 'moderation.done.duration', { duration: formatDuration(modCase.durationMs / 1000) }));
    }
  } else {
    lines.push(t(lang, 'moderation.done.nocase', { type: t(lang, `moderation.type.${type}`) }));
  }
  for (const w of warnings) lines.push(t(lang, `moderation.warning.${w}`));
  return lines.join('\n');
}

function makeCommand(def) {
  const type = def.name;
  async function execute(interaction, ctx) {
    const lang = await guard(interaction, ctx, 'moderation', { requireManager: false });
    if (!lang) return;
    const { config: raw } = await getFeature(ctx.db, interaction.guildId, 'moderation');
    const config = readConfig(raw);
    if (!canUseAction(interaction.member, type, config)) {
      await interaction.reply(ephemeral(t(lang, 'moderation.err.not_allowed')));
      return;
    }

    let durationSeconds = null;
    if (def.duration) {
      const text = interaction.options.getString('duration');
      if (text !== null && text !== undefined && text.trim() !== '') {
        durationSeconds = parseDuration(text);
        if (durationSeconds === null) {
          await interaction.reply(ephemeral(t(lang, 'moderation.err.bad_duration')));
          return;
        }
      }
    }

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const user = interaction.options.getUser('user', true);
    const target = await fetchMember(interaction.guild, user.id);
    const result = await runAction(ctx, {
      guild: interaction.guild,
      actor: interaction.member,
      type,
      targetId: user.id,
      target,
      reason: interaction.options.getString('reason'),
      durationSeconds,
      deleteDays: def.deleteDays ? interaction.options.getInteger('delete_days') : null,
      config,
      lang,
    });

    const content = result.ok
      ? successText(lang, type, result.modCase, result.warnings)
      : t(lang, `moderation.err.${result.reason}`);
    await interaction.editReply({ content });
  }
  return { data: build(def), execute };
}

export const actionCommands = DEFS.map(makeCommand);

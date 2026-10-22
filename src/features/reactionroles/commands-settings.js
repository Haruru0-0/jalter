import { ActionRowBuilder, ButtonBuilder, ButtonStyle, MessageFlags } from 'discord.js';
import { ephemeral } from '../../core/replies.js';
import { getLang, t } from '../../i18n/index.js';
import { scheduleJob, cancelJobs } from '../../core/scheduler.js';
import { parseDuration, formatDuration } from '../../core/duration.js';
import { canManage } from '../../core/permissions.js';
import { TYPES, SELFDESTRUCT_JOB, typeAllowedForStyle } from './config.js';
import { getMessage, listMessages, updateMessage, deleteMessage, deleteGuildMessages, clearEntries } from './store.js';
import { syncMessage, refreshEmbed } from './render.js';
import { fetchDiscordMessage, loadMessage, messageIdOption, refuseMissingPermission } from './setup.js';
import { logReactionRoles } from './log.js';

const logged = (interaction, ctx, lang, message, action, detail) =>
  logReactionRoles(ctx, interaction.guild, lang, { action, actorId: interaction.user.id, messageId: message.messageId, detail });

async function type(interaction, ctx, lang) {
  const message = await loadMessage(interaction, ctx, lang);
  if (!message) return;
  const next = interaction.options.getString('type');
  if (!typeAllowedForStyle(next, message.style)) return interaction.reply(ephemeral(t(lang, 'reactionroles.reversedNeedsReactions')));
  if (message.style === 'reactions') {
    // The bot may have lost a permission since setup: check again before the message changes behaviour.
    const channel = await interaction.guild.channels.fetch(message.channelId).catch(() => null);
    if (await refuseMissingPermission(interaction, lang, channel, { style: message.style, type: next })) return;
  }
  // Existing role holders keep their roles: only later picks follow the new type.
  await updateMessage(ctx.db, message.messageId, { type: next });
  const fresh = await getMessage(ctx.db, message.messageId);
  const discordMessage = await fetchDiscordMessage(interaction.guild, fresh);
  if (discordMessage) await syncMessage(ctx, fresh, discordMessage); // a menu's max selection depends on the type
  await logged(interaction, ctx, lang, message, 'type', next);
  return interaction.reply(ephemeral(t(lang, 'common.saved')));
}

async function limit(interaction, ctx, lang) {
  const message = await loadMessage(interaction, ctx, lang);
  if (!message) return;
  const n = interaction.options.getInteger('number');
  await updateMessage(ctx.db, message.messageId, { limit: n > 0 ? n : null });
  await logged(interaction, ctx, lang, message, 'limit', String(n));
  return interaction.reply(ephemeral(t(lang, 'common.saved')));
}

// whitelist / blacklist share one handler: the subcommand decides which list.
function listHandler(listName) {
  return async (interaction, ctx, lang) => {
    const message = await loadMessage(interaction, ctx, lang);
    if (!message) return;
    const mode = interaction.options.getString('mode');
    const role = interaction.options.getRole('role');
    let list = [...message[listName]];
    if (mode === 'clear') list = [];
    else if (!role) return interaction.reply(ephemeral(t(lang, 'reactionroles.list.needRole')));
    else if (mode === 'add') list = [...new Set([...list, role.id])];
    else list = list.filter((id) => id !== role.id);
    await updateMessage(ctx.db, message.messageId, { [listName]: list });
    await logged(interaction, ctx, lang, message, listName, mode);
    return interaction.reply(ephemeral(t(lang, 'common.saved')));
  };
}

async function selfdestruct(interaction, ctx, lang) {
  const message = await loadMessage(interaction, ctx, lang);
  if (!message) return;
  const text = interaction.options.getString('duration').trim().toLowerCase();
  if (text === '0' || text === 'off') {
    await cancelJobs(ctx.db, { guildId: interaction.guildId, type: SELFDESTRUCT_JOB, key: message.messageId });
    await updateMessage(ctx.db, message.messageId, { selfdestructAt: null });
    await logged(interaction, ctx, lang, message, 'selfdestruct', 'off');
    return interaction.reply(ephemeral(t(lang, 'common.saved')));
  }
  const seconds = parseDuration(text);
  if (!seconds) return interaction.reply(ephemeral(t(lang, 'reactionroles.badDuration')));
  const dueAt = Date.now() + seconds * 1000;
  await scheduleJob(ctx.db, { guildId: interaction.guildId, type: SELFDESTRUCT_JOB, key: message.messageId, payload: {}, dueAt });
  await updateMessage(ctx.db, message.messageId, { selfdestructAt: new Date(dueAt) });
  await logged(interaction, ctx, lang, message, 'selfdestruct', formatDuration(seconds));
  return interaction.reply(ephemeral(t(lang, 'reactionroles.selfdestructSet', { time: formatDuration(seconds) })));
}

async function refresh(interaction, ctx, lang) {
  const message = await loadMessage(interaction, ctx, lang);
  if (!message) return;
  if (!message.embedName) return interaction.reply(ephemeral(t(lang, 'reactionroles.noEmbedName')));
  const discordMessage = await fetchDiscordMessage(interaction.guild, message);
  if (!discordMessage) return interaction.reply(ephemeral(t(lang, 'reactionroles.gone')));
  const result = await refreshEmbed(ctx, interaction, lang, message, discordMessage);
  if (result.error) return interaction.reply(ephemeral(t(lang, `reactionroles.embed.${result.error}`)));
  await logged(interaction, ctx, lang, message, 'refresh');
  return interaction.reply(ephemeral(t(lang, 'common.saved')));
}

async function fix(interaction, ctx, lang) {
  let targets;
  if (interaction.options.getString('message_id')) {
    const message = await loadMessage(interaction, ctx, lang);
    if (!message) return;
    targets = [message];
  } else {
    targets = await listMessages(ctx.db, interaction.guildId);
  }
  // Every target is fetched and synced on Discord: acknowledge first.
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  let fixed = 0;
  for (const m of targets) {
    const discordMessage = await fetchDiscordMessage(interaction.guild, m);
    if (discordMessage && (await syncMessage(ctx, m, discordMessage)).ok) fixed += 1;
  }
  await logReactionRoles(ctx, interaction.guild, lang, {
    action: 'fix', actorId: interaction.user.id, messageId: targets.length === 1 ? targets[0].messageId : 'all', detail: String(fixed),
  });
  return interaction.editReply(t(lang, 'reactionroles.fixed', { count: fixed }));
}

async function purge(interaction, ctx, lang) {
  const id = interaction.options.getString('message_id');
  let count = 0;
  if (id) {
    if (!(await loadMessage(interaction, ctx, lang))) return;
  } else {
    count = (await listMessages(ctx.db, interaction.guildId)).length;
    if (!count) return interaction.reply(ephemeral(t(lang, 'reactionroles.show.none')));
  }
  const ok = new ButtonBuilder().setCustomId(`reactionroles:purge:ok:${interaction.user.id}:${id ?? 'all'}`)
    .setLabel(t(lang, 'reactionroles.purge.confirm')).setStyle(ButtonStyle.Danger);
  const no = new ButtonBuilder().setCustomId(`reactionroles:purge:no:${interaction.user.id}`)
    .setLabel(t(lang, 'reactionroles.purge.cancel')).setStyle(ButtonStyle.Secondary);
  return interaction.reply(ephemeral({
    content: t(lang, id ? 'reactionroles.purge.askOne' : 'reactionroles.purge.askAll', { id, count }),
    components: [new ActionRowBuilder().addComponents(ok, no)],
  }));
}

/**
 * Confirm / Cancel buttons of `purge`. Only the staff member who ran the command may press them.
 * One message: its roles are removed and the Discord message loses its controls. All: every stored message is forgotten.
 * The Discord messages themselves are never deleted.
 */
export async function handlePurge(interaction, ctx) {
  const [, , answer, userId, target] = interaction.customId.split(':');
  const lang = await getLang(ctx.db, interaction.guildId);
  if (interaction.user.id !== userId || !(await canManage(ctx.db, interaction.member))) {
    return interaction.reply({ content: t(lang, 'reactionroles.notYours'), flags: MessageFlags.Ephemeral });
  }
  if (answer !== 'ok') return interaction.update({ content: t(lang, 'reactionroles.purge.cancelled'), components: [] });
  // Stripping a message's controls can take up to 20 reaction removals: acknowledge first, then edit the prompt.
  await interaction.deferUpdate();
  let content;
  if (target === 'all') {
    const ids = await deleteGuildMessages(ctx.db, interaction.guildId);
    await cancelJobs(ctx.db, { guildId: interaction.guildId, type: SELFDESTRUCT_JOB });
    content = t(lang, 'reactionroles.purge.done', { count: ids.length });
  } else {
    const message = await getMessage(ctx.db, target);
    if (!message || message.guildId !== interaction.guildId) {
      return interaction.editReply({ content: t(lang, 'reactionroles.gone'), components: [] });
    }
    const removed = await clearEntries(ctx.db, target);
    const discordMessage = await fetchDiscordMessage(interaction.guild, message);
    if (discordMessage) await syncMessage(ctx, await getMessage(ctx.db, target), discordMessage);
    content = t(lang, 'reactionroles.purge.doneOne', { count: removed });
  }
  await logReactionRoles(ctx, interaction.guild, lang, { action: 'purge', actorId: interaction.user.id, messageId: target });
  return interaction.editReply({ content, components: [] });
}

const UNKNOWN_CHANNEL = 10003;
const UNKNOWN_MESSAGE = 10008;

// Only "unknown channel / message" means the Discord message is gone; any other failure must reach the scheduler for a retry.
async function orGone(promise) {
  try {
    return await promise;
  } catch (err) {
    if (err?.code === UNKNOWN_CHANNEL || err?.code === UNKNOWN_MESSAGE) return null;
    throw err;
  }
}

/** Deletes the Discord message (already gone counts as done), then its stored rows. Other failures are rethrown to retry. */
export async function destructJob(ctx, job) {
  const message = await getMessage(ctx.db, job.key);
  if (!message) return;
  const channel = await orGone(ctx.client.channels.fetch(message.channelId));
  const discordMessage = channel && (await orGone(channel.messages.fetch(message.messageId)));
  if (discordMessage) await orGone(discordMessage.delete());
  await deleteMessage(ctx.db, job.key);
}

export const jobs = { [SELFDESTRUCT_JOB]: destructJob };

const listGroup = (name) => (s) =>
  s.setName(name).setDescription(`Roles for the ${name}`)
    .addStringOption(messageIdOption)
    .addStringOption((o) => o.setName('mode').setDescription('What to do').setRequired(true)
      .addChoices({ name: 'add', value: 'add' }, { name: 'remove', value: 'remove' }, { name: 'clear', value: 'clear' }))
    .addRoleOption((o) => o.setName('role').setDescription('The role'));

/** Adds the settings subcommands to the /reactionroles builder. */
export function settingsSubcommands(builder) {
  return builder
    .addSubcommand((s) => s.setName('type').setDescription('Change how a role message behaves')
      .addStringOption(messageIdOption)
      .addStringOption((o) => o.setName('type').setDescription('New type').setRequired(true)
        .addChoices(...TYPES.map((v) => ({ name: v, value: v })))))
    .addSubcommand((s) => s.setName('limit').setDescription('Most roles a member may hold from a message (0 = no limit)')
      .addStringOption(messageIdOption)
      .addIntegerOption((o) => o.setName('number').setDescription('The limit').setMinValue(0).setMaxValue(20).setRequired(true)))
    .addSubcommand(listGroup('whitelist'))
    .addSubcommand(listGroup('blacklist'))
    .addSubcommand((s) => s.setName('selfdestruct').setDescription('Delete the message after a delay (off to cancel)')
      .addStringOption(messageIdOption)
      .addStringOption((o) => o.setName('duration').setDescription('For example 1h, or off').setRequired(true)))
    .addSubcommand((s) => s.setName('refresh').setDescription('Re-render the message from its named embed')
      .addStringOption(messageIdOption))
    .addSubcommand((s) => s.setName('fix').setDescription('Re-add missing reactions, buttons or dropdown')
      .addStringOption((o) => o.setName('message_id').setDescription('Id of the role message (default: all)')))
    .addSubcommand((s) => s.setName('purge').setDescription('Remove the roles of one role message, or forget all of them')
      .addStringOption((o) => o.setName('message_id').setDescription('Id of the role message (default: all)')));
}

export const settingsHandlers = {
  type, limit, whitelist: listHandler('whitelist'), blacklist: listHandler('blacklist'), selfdestruct, refresh, fix, purge,
};

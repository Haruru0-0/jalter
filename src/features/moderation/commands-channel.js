import { SlashCommandBuilder, ChannelType, MessageFlags } from 'discord.js';
import { getFeature } from '../../db/settings.js';
import { guard } from '../../core/guard.js';
import { ephemeral } from '../../core/replies.js';
import { formatDuration } from '../../core/duration.js';
import { t } from '../../i18n/index.js';
import { readConfig } from './config.js';
import { checkToolAccess, postNotice, logTool } from './tools-common.js';

const REASON_MAX = 400;
const SLOWMODE_MAX = 21600;

const THREAD_TYPES = [ChannelType.PublicThread, ChannelType.PrivateThread, ChannelType.AnnouncementThread];
const SLOWMODE_TYPES = [ChannelType.GuildText, ...THREAD_TYPES];
const LOCK_TYPES = [ChannelType.GuildText, ChannelType.GuildAnnouncement];

const isThread = (channel) => THREAD_TYPES.includes(channel?.type);

function addReason(b) {
  return b.addStringOption((o) => o.setName('reason').setDescription('Why (shown in the channel)').setMaxLength(REASON_MAX));
}

function buildSlowmode() {
  return addReason(new SlashCommandBuilder().setName('slowmode').setDescription('Set or clear the slowmode of a channel')
    .addIntegerOption((o) => o.setName('seconds')
      .setDescription('Seconds between messages (0 turns it off)').setRequired(true).setMinValue(0).setMaxValue(SLOWMODE_MAX))
    .addChannelOption((o) => o.setName('channel')
      .setDescription('The channel (default: this one)').addChannelTypes(...SLOWMODE_TYPES)));
}

function buildLock(name, description) {
  return addReason(new SlashCommandBuilder().setName(name).setDescription(description)
    .addChannelOption((o) => o.setName('channel')
      .setDescription('The channel (default: this one)').addChannelTypes(...LOCK_TYPES)));
}

/** Shared front half: guard, config, channel pick, access check. Returns null after replying on refusal. */
async function open(interaction, ctx, action, { types, extraBotPerms = () => [] }) {
  const lang = await guard(interaction, ctx, 'moderation', { requireManager: false });
  if (!lang) return null;
  const { config: raw } = await getFeature(ctx.db, interaction.guildId, 'moderation');
  const config = readConfig(raw);
  const channel = interaction.options.getChannel('channel') ?? interaction.channel;
  const typeOk = Boolean(channel) && types.includes(channel.type);
  const botPermissions = ['ViewChannel', isThread(channel) ? 'SendMessagesInThreads' : 'SendMessages', ...extraBotPerms(channel)];
  const access = checkToolAccess({ interaction, action, config, channel: typeOk ? channel : null, botPermissions });
  if (!access.ok) {
    await interaction.reply(ephemeral(t(lang, `moderation.tools.err.${access.reason}`)));
    return null;
  }
  return { lang, channel, reason: interaction.options.getString('reason') };
}

/** Back half: notice, log line, ephemeral reply. */
async function finish(interaction, ctx, { lang, channel, reason }, { tool, detail, notice, reply }) {
  const noticeText = reason ? `${notice}\n${t(lang, 'moderation.tools.notice.reason', { reason })}` : notice;
  const posted = await postNotice(channel, { content: noticeText, allowedMentions: { parse: [] } });
  await logTool(ctx, interaction.guild, lang, { tool, actorId: interaction.user.id, channelId: channel.id, detail, reason });
  const content = posted ? reply : `${reply}\n${t(lang, 'moderation.tools.notice_failed')}`;
  await interaction.editReply({ content });
}

async function failed(interaction, lang, err) {
  console.warn(`Channel tool failed: ${err?.code ?? ''} ${err?.message}`);
  await interaction.editReply({ content: t(lang, 'moderation.tools.err.failed') });
}

async function executeSlowmode(interaction, ctx) {
  const o = await open(interaction, ctx, 'slowmode', {
    types: SLOWMODE_TYPES,
    extraBotPerms: (c) => (isThread(c) ? ['ManageThreads'] : []),
  });
  if (!o) return;
  const { lang, channel, reason } = o;
  const seconds = interaction.options.getInteger('seconds', true);
  const value = seconds === 0 ? t(lang, 'moderation.tools.slowmode.off') : formatDuration(seconds);
  const mention = `<#${channel.id}>`;
  if ((channel.rateLimitPerUser ?? 0) === seconds) {
    await interaction.reply(ephemeral(t(lang, 'moderation.tools.slowmode.already', { channel: mention, value })));
    return;
  }
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  try {
    await channel.setRateLimitPerUser(seconds, reason ?? undefined);
  } catch (err) {
    await failed(interaction, lang, err);
    return;
  }
  await finish(interaction, ctx, o, {
    tool: 'slowmode',
    detail: value,
    notice: t(lang, 'moderation.tools.slowmode.notice', { value, user: `<@${interaction.user.id}>` }),
    reply: t(lang, 'moderation.tools.slowmode.reply', { channel: mention, value }),
  });
}

function makeLockCommand(name, locking) {
  async function execute(interaction, ctx) {
    const o = await open(interaction, ctx, name, { types: LOCK_TYPES, extraBotPerms: () => ['ManageRoles'] });
    if (!o) return;
    const { lang, channel, reason } = o;
    const mention = `<#${channel.id}>`;
    const denied = Boolean(channel.permissionOverwrites.cache.get(interaction.guild.id)?.deny?.has('SendMessages'));
    if (denied === locking) {
      await interaction.reply(ephemeral(t(lang, `moderation.tools.${name}.already`, { channel: mention })));
      return;
    }
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    try {
      await channel.permissionOverwrites.edit(
        interaction.guild.roles.everyone,
        { SendMessages: locking ? false : null },
        { reason: reason ?? undefined },
      );
    } catch (err) {
      await failed(interaction, lang, err);
      return;
    }
    await finish(interaction, ctx, o, {
      tool: name,
      detail: null,
      notice: t(lang, `moderation.tools.${name}.notice`, { user: `<@${interaction.user.id}>` }),
      reply: t(lang, `moderation.tools.${name}.reply`, { channel: mention }),
    });
  }
  return execute;
}

export const channelCommands = [
  { data: buildSlowmode(), execute: executeSlowmode },
  { data: buildLock('lock', 'Stop everyone from sending messages in a channel'), execute: makeLockCommand('lock', true) },
  { data: buildLock('unlock', 'Let everyone send messages in a channel again'), execute: makeLockCommand('unlock', false) },
];

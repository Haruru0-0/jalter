import {
  SlashCommandBuilder, ChannelType, Events, ActionRowBuilder, ModalBuilder, TextInputBuilder, TextInputStyle,
  MessageFlags,
} from 'discord.js';
import { getFeature, setFeature } from '../../db/settings.js';
import { guard } from '../../core/guard.js';
import { ephemeral } from '../../core/replies.js';
import { fetchSendable, trySend } from '../../core/send.js';
import { safeMentions } from '../../core/mentions.js';
import { renderTemplate } from '../../core/templates.js';
import { resolveImage } from '../media/images.js';
import { buildWelcomePayload, DEFAULT_TEXT } from './payload.js';
import { renderCard } from './card.js';
import { t } from '../../i18n/index.js';

const EVENTS = ['join', 'leave', 'boost'];

async function sendWelcome(ctx, member, event, cfg, vars) {
  const channel = await fetchSendable(ctx.client, cfg.channelId);
  if (!channel) {
    console.warn(`Welcome channel for ${event} missing in guild ${member.guild.id}`);
    return;
  }
  const images = {};
  if (cfg.embed?.image) images.image = await resolveImage(ctx.db, ctx.client, member.guild.id, cfg.embed.image);
  let card = null;
  if (cfg.style === 'card') {
    const background = cfg.background
      ? await resolveImage(ctx.db, ctx.client, member.guild.id, cfg.background)
      : undefined;
    card = await renderCard({
      username: vars.username,
      avatarUrl: member.user.displayAvatarURL({ extension: 'png', size: 256 }) || undefined,
      serverName: vars.server,
      background,
    });
  }
  const payload = buildWelcomePayload(cfg, vars, { images, card });
  await trySend(channel, {
    ...payload,
    allowedMentions: event === 'leave' ? safeMentions() : { parse: [], users: [member.id] },
  });
}

// Never throws: a missing channel, a failed send or closed DMs only log a warning.
export async function handleMember(ctx, member, event) {
  try {
    const { enabled, config } = await getFeature(ctx.db, member.guild.id, 'welcome');
    const cfg = config[event];
    if (!enabled || !cfg?.enabled) return;

    const vars = {
      user: `<@${member.id}>`,
      username: member.user.username,
      server: member.guild.name,
      count: member.guild.memberCount,
      boosts: member.guild.premiumSubscriptionCount ?? 0,
    };

    try {
      await sendWelcome(ctx, member, event, cfg, vars);
    } catch (err) {
      console.warn(`Welcome ${event} failed:`, err.message);
    }

    if (cfg.dm?.enabled && event !== 'leave') {
      try {
        await member.send({ content: renderTemplate(cfg.dm.text, vars) });
      } catch (err) {
        console.warn(`Welcome DM failed for ${member.id}:`, err.message);
      }
    }
  } catch (err) {
    console.warn(`Welcome ${event} failed:`, err.message);
  }
}

const eventOption = (o) =>
  o.setName('event').setDescription('Which message')
    .addChoices(...EVENTS.map((e) => ({ name: e, value: e }))).setRequired(true);

const data = new SlashCommandBuilder()
  .setName('welcome')
  .setDescription('Welcome, leave and boost messages')
  .addSubcommand((s) =>
    s.setName('setup').setDescription('Turn a message on and choose its channel')
      .addStringOption(eventOption)
      .addChannelOption((o) =>
        o.setName('channel').setDescription('Where to post')
          .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement).setRequired(true)))
  .addSubcommand((s) =>
    s.setName('style').setDescription('Choose text, embed or card')
      .addStringOption(eventOption)
      .addStringOption((o) =>
        o.setName('style').setDescription('Message style')
          .addChoices(...['text', 'embed', 'card'].map((x) => ({ name: x, value: x }))).setRequired(true)))
  .addSubcommand((s) =>
    s.setName('message').setDescription('Edit the message text').addStringOption(eventOption))
  .addSubcommand((s) =>
    s.setName('dm').setDescription('Also send the member a direct message')
      .addStringOption(eventOption)
      .addStringOption((o) =>
        o.setName('state').setDescription('On or off')
          .addChoices({ name: 'on', value: 'on' }, { name: 'off', value: 'off' }).setRequired(true)))
  .addSubcommand((s) =>
    s.setName('test').setDescription('Send a test message using your account').addStringOption(eventOption))
  .addSubcommand((s) =>
    s.setName('disable').setDescription('Turn a message off').addStringOption(eventOption));

async function currentEvent(ctx, guildId, event) {
  const { config } = await getFeature(ctx.db, guildId, 'welcome');
  return config[event] ?? {};
}

async function updateEvent(ctx, guildId, event, patch) {
  const current = await currentEvent(ctx, guildId, event);
  await setFeature(ctx.db, guildId, 'welcome', { config: { [event]: { ...current, ...patch } } });
}

async function execute(interaction, ctx) {
  const sub = interaction.options.getSubcommand();
  const event = interaction.options.getString('event', true);
  const guildId = interaction.guildId;

  if (sub === 'setup') {
    const lang = await guard(interaction, ctx, 'welcome', { requireEnabled: false });
    if (!lang) return;
    const channel = interaction.options.getChannel('channel', true);
    const current = await currentEvent(ctx, guildId, event);
    await setFeature(ctx.db, guildId, 'welcome', { enabled: true });
    await updateEvent(ctx, guildId, event, {
      enabled: true,
      channelId: channel.id,
      style: current.style ?? 'text',
      text: current.text ?? DEFAULT_TEXT[event],
    });
    return interaction.reply(ephemeral(t(lang, 'welcome.setupDone', { event, channel: `<#${channel.id}>` })));
  }

  const lang = await guard(interaction, ctx, 'welcome');
  if (!lang) return;
  const current = await currentEvent(ctx, guildId, event);
  if (!current.channelId) return interaction.reply(ephemeral(t(lang, 'welcome.noChannel')));

  if (sub === 'style') {
    const style = interaction.options.getString('style', true);
    const patch = { style };
    if (style === 'embed' && !current.embed) {
      patch.embed = { title: 'Welcome {username}', description: DEFAULT_TEXT[event] };
    }
    await updateEvent(ctx, guildId, event, patch);
    return interaction.reply(ephemeral(t(lang, 'common.saved')));
  }

  if (sub === 'message') {
    const input = new TextInputBuilder()
      .setCustomId('text').setLabel(t(lang, 'welcome.messageLabel').slice(0, 45))
      .setStyle(TextInputStyle.Paragraph).setMaxLength(2000).setRequired(true)
      .setValue((current.text ?? DEFAULT_TEXT[event]).slice(0, 2000));
    const modal = new ModalBuilder()
      .setCustomId(`welcome:msg:${event}`)
      .setTitle(t(lang, 'welcome.modalTitle').slice(0, 45))
      .addComponents(new ActionRowBuilder().addComponents(input));
    return interaction.showModal(modal);
  }

  if (sub === 'dm') {
    const on = interaction.options.getString('state', true) === 'on';
    await updateEvent(ctx, guildId, event, {
      dm: { enabled: on, text: current.dm?.text ?? DEFAULT_TEXT[event] },
    });
    return interaction.reply(ephemeral(t(lang, 'common.saved')));
  }

  if (sub === 'test') {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    await handleMember(ctx, interaction.member, event);
    return interaction.editReply(t(lang, 'welcome.testSent'));
  }

  if (sub === 'disable') {
    await updateEvent(ctx, guildId, event, { enabled: false });
    return interaction.reply(ephemeral(t(lang, 'common.saved')));
  }
}

async function handle(interaction, ctx) {
  const [, action, event] = interaction.customId.split(':');
  if (action !== 'msg' || !interaction.isModalSubmit() || !EVENTS.includes(event)) return;
  const lang = await guard(interaction, ctx, 'welcome');
  if (!lang) return;
  const text = interaction.fields.getTextInputValue('text');
  await updateEvent(ctx, interaction.guildId, event, { text });
  await interaction.reply(ephemeral(t(lang, 'common.saved')));
}

export const commands = [{ data, execute, components: { prefix: 'welcome', handle } }];

export const events = [
  { name: Events.GuildMemberAdd, execute: (ctx, member) => handleMember(ctx, member, 'join') },
  { name: Events.GuildMemberRemove, execute: (ctx, member) => handleMember(ctx, member, 'leave') },
  {
    name: Events.GuildMemberUpdate,
    execute: (ctx, oldMember, newMember) => {
      if (oldMember.partial) return;
      if (!oldMember.premiumSince && newMember.premiumSince) return handleMember(ctx, newMember, 'boost');
    },
  },
];

import { SlashCommandBuilder, ChannelType, PermissionFlagsBits, MessageFlags } from 'discord.js';
import { getFeature, setFeature } from '../../db/settings.js';
import { guard } from '../../core/guard.js';
import { handleToggle, toggleSubcommands } from '../../core/toggle.js';
import { ephemeral } from '../../core/replies.js';
import { t } from '../../i18n/index.js';
import { CATEGORIES, EVENTS } from './events.js';
import { toggleEvent, addIgnore, removeIgnore, setupPlan, encodeSettings, decodeSettings } from './config.js';

const categoryChoices = CATEGORIES.map((c) => ({ name: c, value: c }));
const eventChoices = [...Object.keys(EVENTS), 'all'].map((e) => ({ name: e, value: e }));

const data = toggleSubcommands(
  new SlashCommandBuilder()
    .setName('logging')
    .setDescription('Log server activity to channels'),
)
  .addSubcommand((s) =>
    s.setName('set').setDescription('Choose the channel for a log category')
      .addStringOption((o) =>
        o.setName('category').setDescription('Which kind of log').setRequired(true)
          .addChoices(...categoryChoices))
      .addChannelOption((o) =>
        o.setName('channel').setDescription('Where the logs go').setRequired(true)
          .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)))
  .addSubcommand((s) =>
    s.setName('clear').setDescription('Stop logging a category')
      .addStringOption((o) =>
        o.setName('category').setDescription('Which kind of log').setRequired(true)
          .addChoices(...categoryChoices)))
  .addSubcommand((s) =>
    s.setName('event').setDescription('Turn one kind of log (or all of them) on or off')
      .addStringOption((o) =>
        o.setName('event').setDescription('Which event').setRequired(true).addChoices(...eventChoices))
      .addBooleanOption((o) =>
        o.setName('enabled').setDescription('On or off').setRequired(true)))
  .addSubcommand((s) =>
    s.setName('ignore').setDescription('Stop logging messages from a channel or member')
      .addChannelOption((o) => o.setName('channel').setDescription('Channel to ignore'))
      .addUserOption((o) => o.setName('member').setDescription('Member to ignore')))
  .addSubcommand((s) =>
    s.setName('unignore').setDescription('Log messages from a channel or member again')
      .addChannelOption((o) => o.setName('channel').setDescription('Channel to stop ignoring'))
      .addUserOption((o) => o.setName('member').setDescription('Member to stop ignoring')))
  .addSubcommand((s) =>
    s.setName('prefix-add').setDescription('Ignore messages that start with a prefix')
      .addStringOption((o) =>
        o.setName('prefix').setDescription('For example !').setRequired(true).setMaxLength(10)))
  .addSubcommand((s) =>
    s.setName('prefix-remove').setDescription('Stop ignoring a message prefix')
      .addStringOption((o) =>
        o.setName('prefix').setDescription('The prefix to remove').setRequired(true).setMaxLength(10)))
  .addSubcommand((s) =>
    s.setName('setup').setDescription('Create a private Logs category with a channel for each kind of log'))
  .addSubcommand((s) =>
    s.setName('export').setDescription('Get a code that copies your event toggles and prefixes elsewhere'))
  .addSubcommand((s) =>
    s.setName('import').setDescription('Apply a code from /logging export to this server')
      .addStringOption((o) =>
        o.setName('code').setDescription('The code from /logging export').setRequired(true).setMaxLength(2000)))
  .addSubcommand((s) =>
    s.setName('status').setDescription('Show the logging channels, toggles and ignore lists'));

function categoryLine(lang, config, category) {
  const channels = config.channels ?? {};
  if (channels[category]) return `<#${channels[category]}>`;
  if (category === 'default') return t(lang, 'logging.statusNotSet');
  let fallback = null;
  if (category === 'join' && channels.members) fallback = 'members';
  else if (channels.default) fallback = 'default';
  if (!fallback) return t(lang, 'logging.statusNotSet');
  return t(lang, 'logging.statusFallback', { category: fallback });
}

function listOrNone(lang, items) {
  return items.length ? items.join(', ') : t(lang, 'logging.statusNone');
}

function statusEmbed(lang, enabled, config) {
  const ignore = config.ignore ?? {};
  return {
    title: t(lang, 'logging.statusTitle'),
    description: t(lang, enabled ? 'logging.statusOn' : 'logging.statusOff'),
    fields: [
      {
        name: t(lang, 'logging.statusChannels'),
        value: CATEGORIES.map((c) => `${c}: ${categoryLine(lang, config, c)}`).join('\n'),
      },
      { name: t(lang, 'logging.statusDisabled'), value: listOrNone(lang, config.disabledEvents ?? []) },
      {
        name: t(lang, 'logging.statusIgnoredChannels'),
        value: listOrNone(lang, (ignore.channels ?? []).map((id) => `<#${id}>`)),
      },
      {
        name: t(lang, 'logging.statusIgnoredMembers'),
        value: listOrNone(lang, (ignore.members ?? []).map((id) => `<@${id}>`)),
      },
      {
        name: t(lang, 'logging.statusPrefixes'),
        value: listOrNone(lang, (ignore.prefixes ?? []).map((p) => `\`${p}\``)),
      },
    ],
  };
}

async function runIgnore(interaction, ctx, lang, config, sub) {
  const channel = interaction.options.getChannel('channel');
  const member = interaction.options.getUser('member');
  if (!channel && !member) {
    await interaction.reply(ephemeral(t(lang, 'logging.ignoreNeedTarget')));
    return;
  }
  const change = sub === 'ignore' ? addIgnore : removeIgnore;
  let ignore = config.ignore ?? {};
  if (channel) ignore = change({ ignore }, 'channels', channel.id);
  if (member) ignore = change({ ignore }, 'members', member.id);
  await setFeature(ctx.db, interaction.guildId, 'logging', { config: { ignore } });
  const targets = [channel && `<#${channel.id}>`, member && `<@${member.id}>`].filter(Boolean).join(' ');
  const key = sub === 'ignore' ? 'logging.ignoreAdded' : 'logging.ignoreRemoved';
  await interaction.reply(ephemeral(t(lang, key, { targets })));
}

async function runPrefix(interaction, ctx, lang, config, sub) {
  const prefix = interaction.options.getString('prefix', true).trim();
  const adding = sub === 'prefix-add';
  if (adding && !prefix) {
    await interaction.reply(ephemeral(t(lang, 'logging.prefixEmpty')));
    return;
  }
  const ignore = (adding ? addIgnore : removeIgnore)({ ignore: config.ignore }, 'prefixes', prefix);
  await setFeature(ctx.db, interaction.guildId, 'logging', { config: { ignore } });
  const key = adding ? 'logging.prefixAdded' : 'logging.prefixRemoved';
  await interaction.reply(ephemeral(t(lang, key, { prefix })));
}

async function runSetup(interaction, ctx, lang, config) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const { guild } = interaction;
  const created = [];
  try {
    const category = await guild.channels.create({
      name: 'Logs',
      type: ChannelType.GuildCategory,
      permissionOverwrites: [
        { id: guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
        { id: guild.members.me.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages] },
      ],
    });
    created.push(category);
    const channels = { ...(config.channels ?? {}) };
    for (const { name, category: key } of setupPlan()) {
      const channel = await guild.channels.create({ name, type: ChannelType.GuildText, parent: category.id });
      created.push(channel);
      channels[key] = channel.id;
    }
    await setFeature(ctx.db, interaction.guildId, 'logging', { enabled: true, config: { channels } });
  } catch {
    for (const channel of created.reverse()) await channel.delete?.().catch(() => {});
    await interaction.editReply(t(lang, 'logging.setupFailed'));
    return;
  }
  await interaction.editReply(t(lang, 'logging.setupDone', { category: `<#${created[0].id}>` }));
}

async function execute(interaction, ctx) {
  const sub = interaction.options.getSubcommand();
  if (sub === 'enable' || sub === 'disable') return handleToggle(interaction, ctx, 'logging');
  const lang = await guard(interaction, ctx, 'logging', { requireEnabled: false });
  if (!lang) return;
  const { enabled, config } = await getFeature(ctx.db, interaction.guildId, 'logging');
  if (sub === 'status') {
    await interaction.reply(ephemeral({ embeds: [statusEmbed(lang, enabled, config)] }));
    return;
  }
  if (sub === 'setup') return runSetup(interaction, ctx, lang, config);
  if (sub === 'export') {
    await interaction.reply(ephemeral(t(lang, 'logging.exportDone', { code: encodeSettings(config) })));
    return;
  }
  if (sub === 'import') {
    const decoded = decodeSettings(interaction.options.getString('code', true));
    if (!decoded) {
      await interaction.reply(ephemeral(t(lang, 'logging.importInvalid')));
      return;
    }
    const ignore = { ...(config.ignore ?? {}), prefixes: decoded.prefixes };
    await setFeature(ctx.db, interaction.guildId, 'logging', { config: { disabledEvents: decoded.disabledEvents, ignore } });
    await interaction.reply(ephemeral(t(lang, 'logging.importDone')));
    return;
  }
  if (sub === 'event') {
    const event = interaction.options.getString('event', true);
    const on = interaction.options.getBoolean('enabled', true);
    const disabledEvents = toggleEvent(config, event, on);
    await setFeature(ctx.db, interaction.guildId, 'logging', { config: { disabledEvents } });
    await interaction.reply(ephemeral(t(lang, on ? 'logging.eventOn' : 'logging.eventOff', { event })));
    return;
  }
  if (sub === 'ignore' || sub === 'unignore') return runIgnore(interaction, ctx, lang, config, sub);
  if (sub === 'prefix-add' || sub === 'prefix-remove') return runPrefix(interaction, ctx, lang, config, sub);
  const category = interaction.options.getString('category', true);
  const channels = { ...(config.channels ?? {}) };
  if (sub === 'set') {
    const channel = interaction.options.getChannel('channel', true);
    channels[category] = channel.id;
    await setFeature(ctx.db, interaction.guildId, 'logging', { enabled: true, config: { channels } });
    await interaction.reply(ephemeral(t(lang, 'logging.set', { category, channel: `<#${channel.id}>` })));
    return;
  }
  delete channels[category];
  await setFeature(ctx.db, interaction.guildId, 'logging', { config: { channels } });
  await interaction.reply(ephemeral(t(lang, 'logging.cleared', { category })));
}

export const commands = [{ data, execute }];

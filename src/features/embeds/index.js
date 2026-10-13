import { SlashCommandBuilder, ChannelType } from 'discord.js';
import { guard } from '../../core/guard.js';
import { ephemeral } from '../../core/replies.js';
import { capList } from '../../core/lists.js';
import { t } from '../../i18n/index.js';
import { validateEmbed } from './model.js';
import { sendEmbedSpec } from './render.js';
import { errorText } from './spec.js';
import { applyEdit } from './edit.js';
import { showPanel } from './panel.js';
import {
  normalizeEmbedName, createEmbed, getEmbed, saveEmbed, listEmbeds, deleteEmbed,
} from './store.js';

const CHANNEL_TYPES = [ChannelType.GuildText, ChannelType.GuildAnnouncement];
const IMAGE_HELP = 'A link, a stored image name or a placeholder';

const nameOption = (o) =>
  o.setName('embed').setDescription('The embed name').setMaxLength(16).setRequired(true);
const strOpt = (name, description, max) => (o) => {
  o.setName(name).setDescription(description);
  return max ? o.setMaxLength(max) : o;
};

// Adds an `edit <name>` subcommand whose first (required) option is the embed name.
const editSub = (g, name, description, build = (s) => s) =>
  g.addSubcommand((s) => build(s.setName(name).setDescription(description).addStringOption(nameOption)));

const data = new SlashCommandBuilder()
  .setName('embed')
  .setDescription('Create, edit and post named embeds')
  .addSubcommand((s) =>
    s.setName('create').setDescription('Create a new empty embed')
      .addStringOption((o) => o.setName('name').setDescription('A name of 1 to 16 characters').setMaxLength(16).setRequired(true)))
  .addSubcommandGroup((g) => {
    g.setName('edit').setDescription('Edit a part of an embed');
    editSub(g, 'all', 'Edit the whole embed with buttons');
    editSub(g, 'author', 'Set or remove the author', (s) => s
      .addStringOption(strOpt('text', 'Author text (leave empty to remove)', 256))
      .addStringOption(strOpt('icon', `Author icon: ${IMAGE_HELP}`)));
    editSub(g, 'title', 'Set or remove the title', (s) => s.addStringOption(strOpt('title', 'Title (leave empty to remove)', 256)));
    editSub(g, 'description', 'Set or remove the description', (s) =>
      s.addStringOption(strOpt('description', 'Description (leave empty to remove)', 4000)));
    editSub(g, 'thumbnail', 'Set or remove the thumbnail', (s) => s.addStringOption(strOpt('image', IMAGE_HELP)));
    editSub(g, 'image', 'Set or remove the large image', (s) => s.addStringOption(strOpt('image', IMAGE_HELP)));
    editSub(g, 'color', 'Set or remove the color', (s) => s.addStringOption(strOpt('color', 'Color like #5865F2', 7)));
    editSub(g, 'footer', 'Set or remove the footer', (s) => s.addStringOption(strOpt('text', 'Footer text (leave empty to remove)', 2048)));
    editSub(g, 'timestamp', 'Show or hide the time the embed was posted', (s) =>
      s.addBooleanOption((o) => o.setName('timestamp').setDescription('Show the time').setRequired(true)));
    g.addSubcommand((s) =>
      s.setName('field').setDescription('Add a field')
        .addStringOption(nameOption)
        .addStringOption((o) => o.setName('name').setDescription('Field name').setMaxLength(256).setRequired(true))
        .addStringOption((o) => o.setName('value').setDescription('Field text').setMaxLength(1024).setRequired(true))
        .addBooleanOption((o) => o.setName('inline').setDescription('Show side by side')));
    editSub(g, 'clear-fields', 'Remove all fields');
    return g;
  })
  .addSubcommand((s) => s.setName('list').setDescription('List the embeds of this server'))
  .addSubcommand((s) =>
    s.setName('delete').setDescription('Delete an embed').addStringOption(nameOption))
  .addSubcommand((s) =>
    s.setName('show').setDescription('Post an embed in a channel')
      .addStringOption(nameOption)
      .addChannelOption((o) =>
        o.setName('channel').setDescription('Where to post it (defaults to this channel)').addChannelTypes(...CHANNEL_TYPES)));

// Reads the `embed` option, replies on a bad or unknown name, returns { name, spec } or null.
async function loadEmbed(interaction, ctx, lang) {
  const name = normalizeEmbedName(interaction.options.getString('embed', true));
  if (!name) {
    await interaction.reply(ephemeral(t(lang, 'embeds.badName')));
    return null;
  }
  const spec = await getEmbed(ctx.db, interaction.guildId, name);
  if (!spec) {
    await interaction.reply(ephemeral(t(lang, 'embeds.notFound', { name })));
    return null;
  }
  return { name, spec };
}

// A stored image name must exist; links and placeholders pass. Returns true when the value is usable.
async function imageUsable(interaction, ctx, lang, value) {
  const v = (value ?? '').trim();
  if (!v || /^https?:\/\//i.test(v) || v.includes('{')) return true;
  const { rowCount } = await ctx.db.query(
    'SELECT 1 FROM media_items WHERE guild_id = $1 AND name = $2', [interaction.guildId, v]);
  if (rowCount) return true;
  await interaction.reply(ephemeral(t(lang, 'media.unknown', { name: v })));
  return false;
}

function readEdit(interaction, sub) {
  const o = interaction.options;
  switch (sub) {
    case 'author': return { text: o.getString('text'), icon: o.getString('icon') };
    case 'title': return o.getString('title');
    case 'description': return o.getString('description');
    case 'thumbnail':
    case 'image': return o.getString('image');
    case 'color': return o.getString('color');
    case 'footer': return o.getString('text');
    case 'timestamp': return o.getBoolean('timestamp', true);
    case 'field':
      return { name: o.getString('name', true), value: o.getString('value', true), inline: o.getBoolean('inline') ?? false };
    default: return undefined;
  }
}

async function editPart(interaction, ctx, lang, sub) {
  const loaded = await loadEmbed(interaction, ctx, lang);
  if (!loaded) return;
  const value = readEdit(interaction, sub);
  let image = null;
  if (sub === 'author') image = value.icon;
  else if (sub === 'thumbnail' || sub === 'image') image = value;
  if (image && !(await imageUsable(interaction, ctx, lang, image))) return;
  const result = applyEdit(loaded.spec, sub, value);
  if (!result.ok) return interaction.reply(ephemeral(errorText(lang, result.errors)));
  await saveEmbed(ctx.db, interaction.guildId, loaded.name, result.spec);
  return interaction.reply(ephemeral(t(lang, 'common.saved')));
}

async function execute(interaction, ctx) {
  const lang = await guard(interaction, ctx, 'embeds', { requireEnabled: false });
  if (!lang) return;
  const group = interaction.options.getSubcommandGroup(false);
  const sub = interaction.options.getSubcommand();
  const guildId = interaction.guildId;

  if (group === 'edit') {
    if (sub === 'all') {
      const loaded = await loadEmbed(interaction, ctx, lang);
      return loaded && showPanel(interaction, ctx, lang, loaded.name);
    }
    return editPart(interaction, ctx, lang, sub);
  }

  if (sub === 'create') {
    const name = normalizeEmbedName(interaction.options.getString('name', true));
    if (!name) return interaction.reply(ephemeral(t(lang, 'embeds.badName')));
    if (!(await createEmbed(ctx.db, guildId, name))) {
      return interaction.reply(ephemeral(t(lang, 'embeds.exists', { name })));
    }
    return showPanel(interaction, ctx, lang, name);
  }

  if (sub === 'list') {
    const names = await listEmbeds(ctx.db, guildId);
    const text = names.length
      ? capList(names.map((n) => `\`${n}\``), { more: (count) => t(lang, 'common.more', { count }) })
      : t(lang, 'embeds.none');
    return interaction.reply(ephemeral(text));
  }

  if (sub === 'delete') {
    const name = normalizeEmbedName(interaction.options.getString('embed', true));
    if (!name) return interaction.reply(ephemeral(t(lang, 'embeds.badName')));
    const removed = await deleteEmbed(ctx.db, guildId, name);
    return interaction.reply(ephemeral(t(lang, removed ? 'embeds.deleted' : 'embeds.notFound', { name })));
  }

  if (sub === 'show') {
    const loaded = await loadEmbed(interaction, ctx, lang);
    if (!loaded) return;
    const check = validateEmbed(loaded.spec);
    if (!check.ok) return interaction.reply(ephemeral(errorText(lang, check.errors)));
    const channelId = interaction.options.getChannel('channel')?.id ?? interaction.channelId;
    return sendEmbedSpec(interaction, ctx, lang, loaded.spec, channelId);
  }
}

export const commands = [{ data, execute }];
export const events = [];

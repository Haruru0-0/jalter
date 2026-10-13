import {
  SlashCommandBuilder, ChannelType, ActionRowBuilder, ModalBuilder, TextInputBuilder,
  TextInputStyle, ButtonBuilder, ButtonStyle, MessageFlags,
} from 'discord.js';
import { guard } from '../../core/guard.js';
import { handleToggle, toggleSubcommands } from '../../core/toggle.js';
import { ephemeral } from '../../core/replies.js';
import { capList } from '../../core/lists.js';
import { t } from '../../i18n/index.js';
import { validateEmbed } from './model.js';
import { buildEmbedPayload, sendEmbedSpec } from './send.js';
import { putDraft, getDraft, clearDraft, draftKey } from './drafts.js';
import { saveTemplate, getTemplate, listTemplates, deleteTemplate } from './templates.js';
import { specFromFields, quickSpec, errorText, appendField, parseInline } from './spec.js';

const CHANNEL_TYPES = [ChannelType.GuildText, ChannelType.GuildAnnouncement];

function textInput(id, label, style, value, { required = false, max } = {}) {
  const input = new TextInputBuilder().setCustomId(id).setLabel(label).setStyle(style).setRequired(required);
  if (value) input.setValue(value);
  if (max) input.setMaxLength(max);
  return new ActionRowBuilder().addComponents(input);
}

export function builderModal(lang, channelId, spec = {}) {
  const img = spec.image?.type === 'url' ? spec.image.url : spec.image?.name;
  return new ModalBuilder()
    .setCustomId(`embeds:modal:${channelId}`)
    .setTitle(t(lang, 'embeds.modalTitle'))
    .addComponents(
      textInput('title', t(lang, 'embeds.title'), TextInputStyle.Short, spec.title, { max: 256 }),
      textInput('description', t(lang, 'embeds.description'), TextInputStyle.Paragraph, spec.description, { max: 4000 }),
      textInput('color', t(lang, 'embeds.color'), TextInputStyle.Short, spec.color, { max: 7 }),
      textInput('footer', t(lang, 'embeds.footer'), TextInputStyle.Short, spec.footer, { max: 2048 }),
      textInput('image', t(lang, 'embeds.image'), TextInputStyle.Short, img),
    );
}

export function templateNameModal(lang) {
  return new ModalBuilder()
    .setCustomId('embeds:tplmodal')
    .setTitle(t(lang, 'embeds.saveTemplate'))
    .addComponents(
      textInput('name', t(lang, 'embeds.templateName'), TextInputStyle.Short, '', { required: true, max: 100 }),
    );
}

export function fieldModal(lang, channelId) {
  return new ModalBuilder()
    .setCustomId(`embeds:fieldmodal:${channelId}`)
    .setTitle(t(lang, 'embeds.fieldModalTitle'))
    .addComponents(
      textInput('name', t(lang, 'embeds.fieldName'), TextInputStyle.Short, '', { required: true, max: 256 }),
      textInput('value', t(lang, 'embeds.fieldValue'), TextInputStyle.Paragraph, '', { required: true, max: 1024 }),
      textInput('inline', t(lang, 'embeds.fieldInline'), TextInputStyle.Short, '', { max: 10 }),
    );
}

async function showPreview(interaction, ctx, lang, spec, channelId) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  try {
    let payload;
    try {
      payload = await buildEmbedPayload(ctx, interaction.guildId, spec);
    } catch (err) {
      if (err.message !== 'image-not-found') throw err;
      return await interaction.editReply(t(lang, 'embeds.imageMissing'));
    }
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`embeds:edit:${channelId}`).setLabel(t(lang, 'embeds.edit')).setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId(`embeds:field:${channelId}`).setLabel(t(lang, 'embeds.addField')).setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId(`embeds:send:${channelId}`).setLabel(t(lang, 'embeds.send')).setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId('embeds:tpl').setLabel(t(lang, 'embeds.saveTemplate')).setStyle(ButtonStyle.Primary),
    );
    return await interaction.editReply({ content: t(lang, 'embeds.previewHint'), ...payload, components: [row] });
  } catch (err) {
    console.error('Embed preview failed:', err);
    return interaction.editReply(t(lang, 'embeds.previewFailed')).catch(() => {});
  }
}

const data = toggleSubcommands(
  new SlashCommandBuilder()
    .setName('embed')
    .setDescription('Build, save and post embeds')
    .addSubcommand((s) =>
      s.setName('builder').setDescription('Build an embed step by step with a preview')
        .addChannelOption((o) =>
          o.setName('channel').setDescription('Where to post it (defaults to this channel)').addChannelTypes(...CHANNEL_TYPES)))
    .addSubcommand((s) =>
      s.setName('quick').setDescription('Post a simple embed right away')
        .addStringOption((o) => o.setName('title').setDescription('Embed title').setMaxLength(256).setRequired(true))
        .addStringOption((o) => o.setName('description').setDescription('Embed text').setMaxLength(4000).setRequired(true))
        .addStringOption((o) => o.setName('color').setDescription('Color like #5865F2').setMaxLength(7))
        .addStringOption((o) => o.setName('image').setDescription('Image link or stored image name'))
        .addChannelOption((o) =>
          o.setName('channel').setDescription('Where to post it (defaults to this channel)').addChannelTypes(...CHANNEL_TYPES)))
    .addSubcommandGroup((g) =>
      g.setName('template').setDescription('Saved embed templates')
        .addSubcommand((s) =>
          s.setName('use').setDescription('Post a saved template')
            .addStringOption((o) => o.setName('name').setDescription('Template name').setMaxLength(100).setRequired(true))
            .addChannelOption((o) =>
              o.setName('channel').setDescription('Where to post it (defaults to this channel)').addChannelTypes(...CHANNEL_TYPES)))
        .addSubcommand((s) => s.setName('list').setDescription('List saved templates'))
        .addSubcommand((s) =>
          s.setName('delete').setDescription('Delete a saved template')
            .addStringOption((o) => o.setName('name').setDescription('Template name').setMaxLength(100).setRequired(true)))),
);

async function execute(interaction, ctx) {
  const group = interaction.options.getSubcommandGroup(false);
  const sub = interaction.options.getSubcommand();
  if (!group && (sub === 'enable' || sub === 'disable')) return handleToggle(interaction, ctx, 'embeds');

  const lang = await guard(interaction, ctx, 'embeds');
  if (!lang) return;
  const guildId = interaction.guildId;
  const channelId = () => interaction.options.getChannel('channel')?.id ?? interaction.channelId;

  if (!group && sub === 'builder') {
    // A new build starts clean; the modal submit keeps fields only from the current draft.
    clearDraft(draftKey(guildId, interaction.user.id));
    return interaction.showModal(builderModal(lang, channelId()));
  }

  if (!group && sub === 'quick') {
    const spec = quickSpec({
      title: interaction.options.getString('title', true),
      description: interaction.options.getString('description', true),
      color: interaction.options.getString('color'),
      image: interaction.options.getString('image'),
    });
    return sendEmbedSpec(interaction, ctx, lang, spec, channelId(), 'embeds');
  }

  if (group === 'template') {
    if (sub === 'list') {
      const names = await listTemplates(ctx.db, guildId);
      const text = names.length
        ? capList(names.map((n) => `\`${n}\``), { more: (count) => t(lang, 'common.more', { count }) })
        : t(lang, 'embeds.noTemplates');
      return interaction.reply(ephemeral(text));
    }
    const name = interaction.options.getString('name', true).trim();
    if (sub === 'use') {
      const spec = await getTemplate(ctx.db, guildId, name);
      if (!spec) return interaction.reply(ephemeral(t(lang, 'embeds.noTemplate')));
      return sendEmbedSpec(interaction, ctx, lang, spec, channelId(), 'embeds');
    }
    if (sub === 'delete') {
      const removed = await deleteTemplate(ctx.db, guildId, name);
      return interaction.reply(ephemeral(t(lang, removed ? 'embeds.templateDeleted' : 'embeds.noTemplate')));
    }
  }
}

async function handle(interaction, ctx) {
  const lang = await guard(interaction, ctx, 'embeds');
  if (!lang) return;
  const [, action, channelId] = interaction.customId.split(':');
  const key = draftKey(interaction.guildId, interaction.user.id);

  if (action === 'modal' && interaction.isModalSubmit()) {
    let spec;
    try {
      spec = specFromFields((id) => interaction.fields.getTextInputValue(id));
    } catch {
      return interaction.reply(ephemeral(t(lang, 'embeds.imageMissing')));
    }
    // The builder form has no field inputs, so an edit keeps the fields already added.
    const previous = getDraft(key);
    if (previous?.fields?.length) spec.fields = previous.fields;
    const check = validateEmbed(spec);
    if (!check.ok) return interaction.reply(ephemeral(errorText(lang, check.errors)));
    putDraft(key, spec);
    return showPreview(interaction, ctx, lang, spec, channelId);
  }

  if (action === 'edit' && interaction.isButton()) {
    const spec = getDraft(key);
    if (!spec) return interaction.reply(ephemeral(t(lang, 'embeds.draftExpired')));
    return interaction.showModal(builderModal(lang, channelId, spec));
  }

  if (action === 'field' && interaction.isButton()) {
    if (!getDraft(key)) return interaction.reply(ephemeral(t(lang, 'embeds.draftExpired')));
    return interaction.showModal(fieldModal(lang, channelId));
  }

  if (action === 'fieldmodal' && interaction.isModalSubmit()) {
    const spec = getDraft(key);
    if (!spec) return interaction.reply(ephemeral(t(lang, 'embeds.draftExpired')));
    const result = appendField(spec, {
      name: interaction.fields.getTextInputValue('name'),
      value: interaction.fields.getTextInputValue('value'),
      inline: parseInline(interaction.fields.getTextInputValue('inline')),
    });
    if (!result.ok) return interaction.reply(ephemeral(errorText(lang, result.errors)));
    putDraft(key, result.spec);
    return showPreview(interaction, ctx, lang, result.spec, channelId);
  }

  if (action === 'send' && interaction.isButton()) {
    const spec = getDraft(key);
    if (!spec) return interaction.reply(ephemeral(t(lang, 'embeds.draftExpired')));
    const sent = await sendEmbedSpec(interaction, ctx, lang, spec, channelId, 'embeds');
    if (sent) clearDraft(key);
    return;
  }

  if (action === 'tpl' && interaction.isButton()) {
    if (!getDraft(key)) return interaction.reply(ephemeral(t(lang, 'embeds.draftExpired')));
    return interaction.showModal(templateNameModal(lang));
  }

  if (action === 'tplmodal' && interaction.isModalSubmit()) {
    const spec = getDraft(key);
    if (!spec) return interaction.reply(ephemeral(t(lang, 'embeds.draftExpired')));
    const name = interaction.fields.getTextInputValue('name').trim();
    if (!name) return interaction.reply(ephemeral(t(lang, 'embeds.noTemplate')));
    await saveTemplate(ctx.db, interaction.guildId, name, spec);
    return interaction.reply(ephemeral(t(lang, 'embeds.templateSaved')));
  }
}

export const commands = [{ data, execute, components: { prefix: 'embeds', handle } }];
export const events = [];

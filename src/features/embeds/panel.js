import {
  ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, ModalBuilder, TextInputBuilder, TextInputStyle,
} from 'discord.js';
import { guard } from '../../core/guard.js';
import { ephemeral } from '../../core/replies.js';
import { buildVars } from '../../core/placeholders.js';
import { t } from '../../i18n/index.js';
import { imageSource, validateEmbed } from './model.js';
import { buildEmbedPayload, sendEmbedSpec } from './render.js';
import { errorText, parseInline } from './spec.js';
import { applyEdit, applyEdits } from './edit.js';
import { normalizeEmbedName, getEmbed, saveEmbed } from './store.js';

const IMAGE_MAX = 1000;
const { Short, Paragraph } = TextInputStyle;

function textInput(id, label, style, value, { required = false, max } = {}) {
  const input = new TextInputBuilder().setCustomId(id).setLabel(label).setStyle(style).setRequired(required);
  if (max) input.setMaxLength(max);
  if (value) input.setValue(max ? String(value).slice(0, max) : String(value));
  return new ActionRowBuilder().addComponents(input);
}

// The yes/no answer in the panel language; parseInline reads every one of these.
const YES_NO = { en: ['yes', 'no'], fr: ['oui', 'non'], ar: ['نعم', 'لا'] };
const yesNo = (lang, on) => (YES_NO[lang] ?? YES_NO.en)[on ? 0 : 1];

// Each form: its title key and its inputs as [id, label key, style, prefill(spec), options].
const MODALS = {
  text: ['embeds.modalText', [
    ['title', 'embeds.title', Short, (s) => s.title, { max: 256 }],
    ['description', 'embeds.description', Paragraph, (s) => s.description, { max: 4000 }],
    ['footer', 'embeds.footer', Paragraph, (s) => s.footer, { max: 2048 }],
  ]],
  look: ['embeds.modalLook', [
    ['color', 'embeds.color', Short, (s) => s.color, { max: 7 }],
    ['timestamp', 'embeds.timestampYesNo', Short, (s, lang) => yesNo(lang, s.timestamp), { max: 10 }],
  ]],
  author: ['embeds.modalAuthor', [
    ['text', 'embeds.authorText', Short, (s) => s.author?.text, { max: 256 }],
    ['icon', 'embeds.authorIcon', Short, (s) => imageSource(s.author?.icon), { max: IMAGE_MAX }],
  ]],
  images: ['embeds.modalImages', [
    ['thumbnail', 'embeds.thumbnail', Short, (s) => imageSource(s.thumbnail), { max: IMAGE_MAX }],
    ['image', 'embeds.image', Short, (s) => imageSource(s.image), { max: IMAGE_MAX }],
  ]],
  // A new field each time: nothing is prefilled.
  field: ['embeds.modalField', [
    ['name', 'embeds.fieldName', Short, () => '', { max: 256, required: true }],
    ['value', 'embeds.fieldValue', Paragraph, () => '', { max: 1024, required: true }],
    ['inline', 'embeds.fieldInline', Short, () => '', { max: 10 }],
  ]],
};

/** The form that edits one part of the embed `name`, prefilled from `spec`. */
export function panelModal(lang, part, name, spec = {}) {
  const [titleKey, inputs] = MODALS[part];
  return new ModalBuilder()
    .setCustomId(`embeds:m:${part}:${name}`)
    .setTitle(t(lang, titleKey))
    .addComponents(...inputs.map(([id, label, style, prefill, opts]) =>
      textInput(id, t(lang, label), style, prefill(spec, lang), opts)));
}

/** Maps a submitted form to `applyEdits` input. `get(id)` returns the raw input. Null for an unknown form. */
export function editsFromModal(part, get) {
  switch (part) {
    case 'text': return [['title', get('title')], ['description', get('description')], ['footer', get('footer')]];
    case 'look': return [['color', get('color')], ['timestamp', parseInline(get('timestamp'))]];
    case 'author': return [['author', { text: get('text'), icon: get('icon') }]];
    case 'images': return [['thumbnail', get('thumbnail')], ['image', get('image')]];
    case 'field': return [['field', { name: get('name'), value: get('value'), inline: parseInline(get('inline')) }]];
    default: return null;
  }
}

const button = (action, name, label, style = ButtonStyle.Secondary) =>
  new ButtonBuilder().setCustomId(`embeds:b:${action}:${name}`).setLabel(label).setStyle(style);

function panelRows(lang, name) {
  return [
    new ActionRowBuilder().addComponents(
      button('text', name, t(lang, 'embeds.partText')),
      button('look', name, t(lang, 'embeds.partLook')),
      button('author', name, t(lang, 'embeds.partAuthor')),
      button('images', name, t(lang, 'embeds.partImages')),
      button('field', name, t(lang, 'embeds.addField')),
    ),
    new ActionRowBuilder().addComponents(
      button('clear', name, t(lang, 'embeds.clearFields'), ButtonStyle.Danger),
      button('show', name, t(lang, 'embeds.showHere'), ButtonStyle.Success),
    ),
  ];
}

// The preview embed rendered for the invoker, or a line that says why there is none.
async function preview(ctx, interaction, lang, spec) {
  const check = validateEmbed(spec);
  if (!check.ok && check.errors.includes('embeds.err.empty')) return { note: t(lang, 'embeds.panelEmpty') };
  try {
    const vars = buildVars({ user: interaction.user, member: interaction.member, guild: interaction.guild, lang });
    return { embeds: (await buildEmbedPayload(ctx, interaction.guildId, spec, vars)).embeds };
  } catch (err) {
    if (err.message === 'image-not-found') return { note: t(lang, 'embeds.imageMissing') };
    if (err.message === 'embed-invalid') {
      return { note: `${t(lang, 'embeds.previewFailed')}\n${errorText(lang, err.errors)}` };
    }
    console.error('Embed panel preview failed:', err);
    return { note: t(lang, 'embeds.previewFailed') };
  }
}

const CARD_COLOR = 0x2b2d31;

/** The panel message body: the preview (when there is one), then a card with the hint and any note, then the buttons. */
export async function panelPayload(ctx, interaction, lang, name, spec) {
  const { embeds = [], note } = await preview(ctx, interaction, lang, spec);
  const card = new EmbedBuilder()
    .setColor(CARD_COLOR)
    .setDescription([t(lang, 'embeds.panelHint', { name }), note].filter(Boolean).join('\n\n'));
  return { embeds: [...embeds, card], components: panelRows(lang, name) };
}

/** The public reply to `/embed create`: how to use the new embed, then the same panel. Not ephemeral. */
export async function createPayload(ctx, interaction, lang, name, spec) {
  const panel = await panelPayload(ctx, interaction, lang, name, spec);
  return { ...panel, content: t(lang, 'embeds.createdGuide', { name }) };
}

export async function showPanel(interaction, ctx, lang, name, spec) {
  return interaction.reply(ephemeral(await panelPayload(ctx, interaction, lang, name, spec)));
}

const PART_BUTTONS = new Set(Object.keys(MODALS));

/** Component handler for the `embeds` prefix: `embeds:b:<action>:<name>` and `embeds:m:<part>:<name>`. */
export async function handlePanel(interaction, ctx) {
  const lang = await guard(interaction, ctx, 'embeds', { requireEnabled: false });
  if (!lang) return;
  const [, kind, action, rawName] = interaction.customId.split(':');
  const isButton = kind === 'b' && interaction.isButton();
  const isModal = kind === 'm' && interaction.isModalSubmit();
  if (!isButton && !isModal) return;

  const name = normalizeEmbedName(rawName);
  if (!name) return interaction.reply(ephemeral(t(lang, 'embeds.badName')));
  const guildId = interaction.guildId;
  const notFound = () => interaction.reply(ephemeral(t(lang, 'embeds.notFound', { name })));
  const spec = await getEmbed(ctx.db, guildId, name);
  if (!spec) return notFound();

  if (isButton) {
    if (PART_BUTTONS.has(action)) return interaction.showModal(panelModal(lang, action, name, spec));
    if (action === 'show') return sendEmbedSpec(interaction, ctx, lang, spec, interaction.channelId);
    if (action === 'clear') {
      const result = applyEdit(spec, 'clear-fields');
      if (!result.ok) return interaction.reply(ephemeral(errorText(lang, result.errors)));
      if (!(await saveEmbed(ctx.db, guildId, name, result.spec))) return notFound();
      return interaction.update(await panelPayload(ctx, interaction, lang, name, result.spec));
    }
    return;
  }

  const edits = editsFromModal(action, (id) => interaction.fields.getTextInputValue(id));
  if (!edits) return;
  const result = applyEdits(spec, edits);
  if (!result.ok) return interaction.reply(ephemeral(errorText(lang, result.errors)));
  if (!(await saveEmbed(ctx.db, guildId, name, result.spec))) return notFound();
  const payload = await panelPayload(ctx, interaction, lang, name, result.spec);
  return interaction.isFromMessage() ? interaction.update(payload) : interaction.reply(ephemeral(payload));
}

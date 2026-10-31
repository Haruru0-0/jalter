// /autoresponder button add|edit|remove|list: the stored buttons that rules attach with {addbutton:name}.
// Plain function declarations only: commands.js and this file import each other, and declarations are hoisted.
import { ModalBuilder, TextInputBuilder, TextInputStyle, ActionRowBuilder } from 'discord.js';
import { ephemeral } from '../../../core/replies.js';
import { t } from '../../../i18n/index.js';
import { fitLines } from '../../reactionroles/setup.js';
import { parseEmoji } from '../../reactionroles/config.js';
import { compileScript, MAX_SCRIPT } from '../script/compile.js';
import { errorLines, log, withWarnings } from '../commands.js';
import { createButton, getButton, listButtons, updateButton, deleteButton } from './store.js';
import { checkButtonInput, isButtonName, MAX_LABEL, STYLES, LIMITATIONS } from './model.js';

const PREFIX = 'autoresponder';
const MAX_REPLY = 2000;
const MAX_EMOJI = 64;
const DEFAULT_STYLE = 'blue';
const LIMIT_CODE = { none: 'n', limited: 'l', strict: 's' };
const CODE_LIMIT = Object.fromEntries(Object.entries(LIMIT_CODE).map(([k, v]) => [v, k]));
const key = (k) => `autoresponder.button.${k}`;
const oneLine = (s) => String(s).replace(/\s+/g, ' ');

/** The two-character flags of a modal id: invoker_only (0|1) then the limitation (n|l|s). */
export const encodeFlags = (invokerOnly, limitations) => `${invokerOnly ? 1 : 0}${LIMIT_CODE[limitations] ?? 'n'}`;

function decodeFlags(flags) {
  const m = /^([01])([nls])$/.exec(String(flags));
  return m ? { invokerOnly: m[1] === '1', limitations: CODE_LIMIT[m[2]] } : null;
}

export const buttonModalId = (action, name, style, invokerOnly, limitations) =>
  `${PREFIX}:m:${action}:${name}:${style}:${encodeFlags(invokerOnly, limitations)}`;

const input = (lang, id, label, style, max, required, value) => {
  const field = new TextInputBuilder().setCustomId(id).setLabel(t(lang, key(`modal.${label}`)))
    .setStyle(style).setMaxLength(max).setRequired(required);
  if (value) field.setValue(String(value).slice(0, max));
  return new ActionRowBuilder().addComponents(field);
};

function buttonModal(lang, customId, title, { label = '', emoji = '', script = '' } = {}) {
  return new ModalBuilder().setCustomId(customId).setTitle(t(lang, key(`modal.title.${title}`))).addComponents(
    input(lang, 'label', 'label', TextInputStyle.Short, MAX_LABEL, true, label),
    input(lang, 'emoji', 'emoji', TextInputStyle.Short, MAX_EMOJI, false, emoji),
    input(lang, 'script', 'script', TextInputStyle.Paragraph, MAX_SCRIPT, true, script),
  );
}

const reply = (interaction, text) => interaction.reply(ephemeral(text));
const badName = (interaction, lang, name) =>
  reply(interaction, t(lang, 'autoresponder.error.BUTTON_NAME_INVALID', { detail: `"${String(name ?? '').slice(0, 40)}"` }).trim());

async function buttonAdd(interaction, ctx, lang) {
  const name = interaction.options.getString('name');
  if (!isButtonName(name)) return badName(interaction, lang, name);
  const style = interaction.options.getString('style') ?? DEFAULT_STYLE;
  const invokerOnly = interaction.options.getBoolean('invoker_only') ?? false;
  const limitations = interaction.options.getString('limitations') ?? 'none';
  const verdict = checkButtonInput({ name, label: 'x', style, limitations });
  if (!verdict.ok) return reply(interaction, t(lang, key(verdict.code)));
  return interaction.showModal(buttonModal(lang, buttonModalId('btnadd', name, style, invokerOnly, limitations), 'add'));
}

async function buttonEdit(interaction, ctx, lang) {
  const name = interaction.options.getString('name');
  if (!isButtonName(name)) return badName(interaction, lang, name);
  const found = await getButton(ctx.db, interaction.guildId, name);
  if (!found) return reply(interaction, t(lang, key('gone'), { name }));
  const style = interaction.options.getString('style') ?? found.style;
  const invokerOnly = interaction.options.getBoolean('invoker_only') ?? found.invokerOnly;
  const limitations = interaction.options.getString('limitations') ?? found.limitations;
  const verdict = checkButtonInput({ name, label: found.label, style, limitations });
  if (!verdict.ok) return reply(interaction, t(lang, key(verdict.code)));
  return interaction.showModal(buttonModal(lang, buttonModalId('btnedit', name, style, invokerOnly, limitations), 'edit', found));
}

async function buttonRemove(interaction, ctx, lang) {
  const name = interaction.options.getString('name');
  if (!isButtonName(name)) return badName(interaction, lang, name);
  // Posted messages keep their buttons until they expire; a press then answers "expired".
  const removed = await deleteButton(ctx.db, interaction.guildId, name);
  if (!removed) return reply(interaction, t(lang, key('gone'), { name }));
  await log(ctx, interaction, lang, 'btnremove', name, '');
  return reply(interaction, t(lang, key('removed'), { name }));
}

const describe = (lang, b) => t(lang, key('list.line'), {
  name: b.name, style: b.style, limit: b.limitations, invoker: t(lang, b.invokerOnly ? 'common.on' : 'common.off'),
  label: oneLine(b.label), emoji: b.emoji ? ` ${b.emoji}` : '',
});

async function buttonList(interaction, ctx, lang) {
  const buttons = await listButtons(ctx.db, interaction.guildId);
  const text = buttons.length ? fitLines(lang, buttons.map((b) => describe(lang, b)), MAX_REPLY) : t(lang, key('list.none'));
  return reply(interaction, text);
}

export const BUTTON_HANDLERS = { add: buttonAdd, edit: buttonEdit, remove: buttonRemove, list: buttonList };

const failureText = (lang, errors) =>
  fitLines(lang, [t(lang, 'autoresponder.errors.head'), ...errorLines(lang, errors)], MAX_REPLY);

/** Saves a button modal. Everything in the id is re-validated: the id is never trusted. */
export async function submitButtonModal(interaction, ctx, lang, action) {
  const [, , , name, style, flags] = interaction.customId.split(':');
  const decoded = decodeFlags(flags);
  if (!isButtonName(name)) return badName(interaction, lang, name);
  if (!decoded) return reply(interaction, t(lang, key('BUTTON_LIMITATION_INVALID')));
  const { invokerOnly, limitations } = decoded;
  const label = interaction.fields.getTextInputValue('label');
  const rawEmoji = (interaction.fields.getTextInputValue('emoji') ?? '').trim();
  const script = interaction.fields.getTextInputValue('script');

  const verdict = checkButtonInput({ name, label, style, limitations });
  if (!verdict.ok) return reply(interaction, t(lang, key(verdict.code)));
  let emoji = null;
  if (rawEmoji !== '') {
    const parsed = parseEmoji(rawEmoji, interaction.guild);
    if (parsed.error) return reply(interaction, failureText(lang, [{ code: 'INVALID_EMOJI', detail: rawEmoji.slice(0, 60), pos: 0 }]));
    emoji = parsed.emoji;
  }

  const existing = await getButton(ctx.db, interaction.guildId, name);
  if (action === 'btnedit' && !existing) return reply(interaction, t(lang, key('gone'), { name }));
  if (action === 'btnadd' && existing) return reply(interaction, t(lang, key('exists'), { name }));

  const result = await compileScript(script, { db: ctx.db, guild: interaction.guild, writer: interaction.member, buttonScript: true });
  if (!result.ok) return reply(interaction, failureText(lang, result.errors));

  const detail = oneLine(label).slice(0, 100);
  if (action === 'btnedit') {
    const stored = await updateButton(ctx.db, interaction.guildId, name, {
      label, emoji, style, script, compiled: result.compiled, invokerOnly, limitations,
    });
    if (!stored) return reply(interaction, t(lang, key('gone'), { name }));
    await log(ctx, interaction, lang, 'btnedit', name, detail);
    return reply(interaction, withWarnings(lang, t(lang, key('updated'), { name }), result.warnings));
  }
  const created = await createButton(ctx.db, {
    guildId: interaction.guildId, name, label, emoji, style, script, compiled: result.compiled,
    invokerOnly, limitations, createdBy: interaction.user.id,
  });
  if (created === 'full') return reply(interaction, t(lang, key('full')));
  if (created === 'exists') return reply(interaction, t(lang, key('exists'), { name }));
  await log(ctx, interaction, lang, 'btnadd', name, detail);
  return reply(interaction, withWarnings(lang, t(lang, key('created'), { name }), result.warnings));
}

export const STYLE_CHOICES = Object.keys(STYLES);
export const LIMITATION_CHOICES = LIMITATIONS;

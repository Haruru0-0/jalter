// The builder's interaction router. Every component and modal of the panel passes through handleBuilder:
// id parse, opener check, manager guard, then the draft lookup, in that order.
import { ModalBuilder, TextInputBuilder, TextInputStyle, ActionRowBuilder } from 'discord.js';
import { guard } from '../../../core/guard.js';
import { ephemeral } from '../../../core/replies.js';
import { getLang, t } from '../../../i18n/index.js';
import { fitLines } from '../../reactionroles/setup.js';
import { createRule } from '../store.js';
import { invalidate } from '../cache.js';
import { checkTrigger, MATCH_MODES, MAX_TRIGGER_LENGTH } from '../match.js';
import { compileScript } from '../script/compile.js';
import { errorLines, log } from '../commands.js';
import { newDraft, patch, setTrigger } from './draft.js';
import { generateScript } from './generate.js';
import { drafts } from './drafts.js';
import { builderId, parseBuilderId, panelPayload, PAGES, DESTINATIONS } from './panel.js';

const MAX_REPLY = 2000;
const LOG_DETAIL_MAX = 100;
const key = (k) => `autoresponder.builder.${k}`;
const oneLine = (s) => String(s).replace(/\s+/g, ' ');

const refuse = (interaction, lang, k) => interaction.reply(ephemeral(t(lang, k)));

// A refusal that must not touch the panel: acknowledge the click, then send a separate ephemeral message.
async function sideMessage(interaction, text) {
  if (!interaction.deferred && !interaction.replied) await interaction.deferUpdate();
  return interaction.followUp(ephemeral(text));
}

/**
 * Applies `nextDraft` tentatively: regenerates the script and compiles it with the pressing member as writer.
 * On errors the entry is left unchanged and the errors go out as an ephemeral follow-up; on success the draft is
 * stored and `rerender(entry)` redraws the panel. Returns true when the change was applied.
 */
export async function tryChange(interaction, ctx, lang, entry, nextDraft, rerender) {
  const result = await compileScript(generateScript(nextDraft), { db: ctx.db, guild: interaction.guild, writer: interaction.member });
  if (!result.ok) {
    await sideMessage(interaction, fitLines(lang, [t(lang, key('refused')), ...errorLines(lang, result.errors)], MAX_REPLY));
    return false;
  }
  const fresh = drafts.update(entry.panelId, { draft: nextDraft });
  if (!fresh) {
    await refuse(interaction, lang, key('expired'));
    return false;
  }
  await rerender(fresh);
  return true;
}

const redraw = (interaction, lang) => (entry) => interaction.update(panelPayload(lang, entry));

const textModal = (lang, customId, { name, title, label, style, max, required, value }) => {
  const input = new TextInputBuilder().setCustomId(name).setLabel(t(lang, key(label))).setStyle(style)
    .setMaxLength(max).setRequired(required);
  if (value) input.setValue(value);
  return new ModalBuilder().setCustomId(customId).setTitle(t(lang, key(title))).addComponents(new ActionRowBuilder().addComponents(input));
};

// ---- controls: each answers the interaction itself ----

function nav(interaction, ctx, lang, entry) {
  const page = interaction.values?.[0];
  if (!PAGES.includes(page)) return undefined;
  const fresh = drafts.update(entry.panelId, { page, pending: null });
  return fresh ? interaction.update(panelPayload(lang, fresh)) : refuse(interaction, lang, key('expired'));
}

async function mode(interaction, ctx, lang, entry) {
  const value = interaction.values?.[0];
  if (!MATCH_MODES.includes(value)) return undefined;
  const { draft } = entry;
  if (draft.trigger.trim() !== '') {
    const verdict = checkTrigger(draft.trigger, value);
    if (!verdict.ok) return sideMessage(interaction, t(lang, `autoresponder.badTrigger.${verdict.code}`));
  }
  return tryChange(interaction, ctx, lang, entry, patch(draft, { matchMode: value }), redraw(interaction, lang));
}

function dest(interaction, ctx, lang, entry) {
  const value = interaction.values?.[0];
  if (!DESTINATIONS.includes(value)) return undefined;
  return tryChange(interaction, ctx, lang, entry, patch(entry.draft, { dest: value }), redraw(interaction, lang));
}

function channel(interaction, ctx, lang, entry) {
  const value = interaction.values?.[0];
  if (!value) return undefined;
  return tryChange(interaction, ctx, lang, entry, patch(entry.draft, { channelId: value }), redraw(interaction, lang));
}

const toggle = (field) => (interaction, ctx, lang, entry) =>
  tryChange(interaction, ctx, lang, entry, patch(entry.draft, { [field]: !entry.draft[field] }), redraw(interaction, lang));

function triggerButton(interaction, ctx, lang, entry) {
  return interaction.showModal(textModal(lang, builderId('mtrigger', entry.userId, entry.panelId), {
    name: 'trigger', title: 'modal.trigger', label: 'input.trigger', style: TextInputStyle.Short,
    max: MAX_TRIGGER_LENGTH, required: true, value: entry.draft.trigger,
  }));
}

function textButton(interaction, ctx, lang, entry) {
  return interaction.showModal(textModal(lang, builderId('mtext', entry.userId, entry.panelId), {
    name: 'text', title: 'modal.text', label: 'input.text', style: TextInputStyle.Paragraph,
    max: MAX_REPLY, required: false, value: entry.draft.text,
  }));
}

function submitTrigger(interaction, ctx, lang, entry) {
  const trigger = interaction.fields.getTextInputValue('trigger');
  const verdict = checkTrigger(trigger, entry.draft.matchMode);
  if (!verdict.ok) return refuse(interaction, lang, `autoresponder.badTrigger.${verdict.code}`);
  return tryChange(interaction, ctx, lang, entry, setTrigger(entry.draft, trigger), redraw(interaction, lang));
}

function submitText(interaction, ctx, lang, entry) {
  const text = interaction.fields.getTextInputValue('text');
  return tryChange(interaction, ctx, lang, entry, patch(entry.draft, { text }), redraw(interaction, lang));
}

function cancel(interaction, ctx, lang, entry) {
  drafts.drop(entry.panelId);
  return interaction.update({ content: t(lang, key('cancelled')), components: [] });
}

// Stores the whole rule or nothing. beginSave is the lock: a second press finds the panel busy or gone.
async function save(interaction, ctx, lang, entry) {
  const claimed = drafts.beginSave(entry.panelId);
  if (!claimed) return refuse(interaction, lang, key('expired'));
  let done = false;
  try {
    await interaction.deferUpdate();
    const { draft } = claimed;
    const verdict = checkTrigger(draft.trigger, draft.matchMode);
    if (!verdict.ok) return await interaction.followUp(ephemeral(t(lang, `autoresponder.badTrigger.${verdict.code}`)));
    const script = generateScript(draft);
    const result = await compileScript(script, { db: ctx.db, guild: interaction.guild, writer: interaction.member });
    if (!result.ok) {
      const lines = [t(lang, 'autoresponder.errors.head'), ...errorLines(lang, result.errors)];
      return await interaction.followUp(ephemeral(fitLines(lang, lines, MAX_REPLY)));
    }
    const created = await createRule(ctx.db, {
      guildId: interaction.guildId, trigger: draft.trigger, matchMode: draft.matchMode, script,
      compiled: result.compiled, createdBy: interaction.user.id,
    });
    if (created === 'full') return await interaction.followUp(ephemeral(t(lang, 'autoresponder.full')));
    done = true;
    invalidate(interaction.guildId);
    await log(ctx, interaction, lang, 'add', created.id,
      `${oneLine(draft.trigger).slice(0, LOG_DETAIL_MAX)} (${t(lang, key('logDetail'))})`);
    drafts.endSave(entry.panelId, true);
    return await interaction.editReply({ content: t(lang, key('saved'), { id: created.id }), components: [] });
  } finally {
    if (!done) drafts.endSave(entry.panelId, false);
  }
}

const ACTIONS = {
  nav, mode, dest, channel, delete: toggle('deleteTrigger'), silent: toggle('silent'),
  trigger: triggerButton, text: textButton, mtrigger: submitTrigger, mtext: submitText, cancel, save,
};

/** `/autoresponder builder`: opens a fresh panel for the caller (replacing any earlier one). */
export async function openBuilder(interaction, ctx, lang) {
  const panelId = drafts.open(interaction.guildId, interaction.user.id, newDraft());
  return interaction.reply(ephemeral(panelPayload(lang, drafts.get(panelId))));
}

/** Routes every `autoresponder:b:*` component and modal submit. */
export async function handleBuilder(interaction, ctx) {
  const ids = parseBuilderId(interaction.customId);
  if (!ids) return undefined;
  const early = interaction.guildId ? await getLang(ctx.db, interaction.guildId) : 'en';
  if (interaction.user.id !== ids.userId) return refuse(interaction, early, key('notYours'));
  const lang = await guard(interaction, ctx, 'autoresponder');
  if (!lang) return undefined;
  const entry = drafts.get(ids.panelId);
  if (!entry || entry.guildId !== interaction.guildId || entry.userId !== interaction.user.id) {
    return refuse(interaction, lang, key('expired'));
  }
  const action = Object.hasOwn(ACTIONS, ids.action) ? ACTIONS[ids.action] : null;
  return action?.(interaction, ctx, lang, entry);
}

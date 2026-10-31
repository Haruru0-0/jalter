// The builder's interaction router. Every component and modal of the panel passes through handleBuilder:
// id parse, opener check, manager guard, then the draft lookup, in that order.
import { ModalBuilder, TextInputBuilder, TextInputStyle, ActionRowBuilder } from 'discord.js';
import { guard } from '../../../core/guard.js';
import { ephemeral } from '../../../core/replies.js';
import { getLang, t } from '../../../i18n/index.js';
import { fitLines } from '../../reactionroles/setup.js';
import { createRule } from '../store.js';
import { listEmbeds } from '../../embeds/store.js';
import { listButtons } from '../buttons/store.js';
import { invalidate } from '../cache.js';
import { checkTrigger, matchRule, MATCH_MODES, MAX_TRIGGER_LENGTH } from '../match.js';
import { describeRunFor } from '../dryrun.js';
import { compileScript, MAX_SCRIPT } from '../script/compile.js';
import { errorLines, log, withWarnings } from '../commands.js';
import {
  addAction, addArgCheck, addButton, addGate, addRandom, newDraft, patch, removeAction, removeArgCheck, removeButton, removeGate, removeRandom, setArgType, setTrigger, toScriptMode,
} from './draft.js';
import { generateScript } from './generate.js';
import { drafts } from './drafts.js';
import {
  builderId, parseBuilderId, panelPayload, PAGES, DESTINATIONS,
  GATE_KINDS, ACTION_KINDS, ROLE_ACTIONS, REACT_ACTIONS, ROLE_GATES, PERM_GATES, CHANNEL_GATES, MAX_PICK, MAX_GATES, PERMISSIONS, MAX_EMBED_OPTIONS, MAX_BUTTON_OPTIONS,
  COND_KINDS, ARG_KIND, ARG_TYPE_CHOICES, ARGTYPE_PREFIX, RANDOM_KINDS, argTypeTarget, userArgNumbers,
} from './panel.js';

const MAX_REPLY = 2000;
const MAX_SAMPLE = 1000;
const LOG_DETAIL_MAX = 100;
const key = (k) => `autoresponder.builder.${k}`;
const oneLine = (s) => String(s).replace(/\s+/g, ' ');

const refuse = (interaction, lang, k) => interaction.reply(ephemeral(t(lang, k)));
// The compile warnings as the text editor shows them, for Try it (the success line itself is not wanted there).
const warningLines = (lang, warnings) => withWarnings(lang, '', warnings).split('\n').slice(1);

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
  const result = await compileScript(generateScript(nextDraft), { db: ctx.db, guild: interaction.guild, writer: interaction.member, matchMode: nextDraft.matchMode });
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

const textModal = (lang, customId, { name, title, label, style, max, required, value, placeholder }) => {
  const input = new TextInputBuilder().setCustomId(name).setLabel(t(lang, key(label))).setStyle(style)
    .setMaxLength(max).setRequired(required);
  if (value) input.setValue(value);
  if (placeholder) input.setPlaceholder(placeholder);
  return new ModalBuilder().setCustomId(customId).setTitle(t(lang, key(title))).addComponents(new ActionRowBuilder().addComponents(input));
};

// ---- controls: each answers the interaction itself ----

async function nav(interaction, ctx, lang, entry) {
  const page = interaction.values?.[0];
  if (!PAGES.includes(page)) return noop(interaction, lang, entry);
  // The saved buttons are read when the page opens (like the embed picker); picks are by index into this list.
  const buttonNames = page === 'buttons' ? (await listButtons(ctx.db, interaction.guildId)).map((b) => b.name) : null;
  const fresh = drafts.update(entry.panelId, { page, pending: null, target: null, buttonNames });
  return fresh ? interaction.update(panelPayload(lang, fresh)) : refuse(interaction, lang, key('expired'));
}

async function mode(interaction, ctx, lang, entry) {
  const value = interaction.values?.[0];
  if (!MATCH_MODES.includes(value)) return noop(interaction, lang, entry);
  const { draft } = entry;
  if (draft.trigger.trim() !== '') {
    const verdict = checkTrigger(draft.trigger, value);
    if (!verdict.ok) return sideMessage(interaction, t(lang, `autoresponder.badTrigger.${verdict.code}`));
  }
  return tryChange(interaction, ctx, lang, entry, patch(draft, { matchMode: value }), redraw(interaction, lang));
}

function dest(interaction, ctx, lang, entry) {
  const value = interaction.values?.[0];
  if (!DESTINATIONS.includes(value)) return noop(interaction, lang, entry);
  return tryChange(interaction, ctx, lang, entry, patch(entry.draft, { dest: value }), redraw(interaction, lang));
}

function channel(interaction, ctx, lang, entry) {
  const ids = pickedIds(interaction, 1);
  if (!ids) return noop(interaction, lang, entry);
  return tryChange(interaction, ctx, lang, entry, patch(entry.draft, { channelId: ids[0] }), redraw(interaction, lang));
}

// "Send to a channel" with no channel picked would generate no {sendto} and quietly reply in place.
const needsChannel = (draft) => draft.mode !== 'script' && draft.dest === 'channel' && !draft.channelId;

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

// ---- conditions ----

const SNOWFLAKE = /^\d{17,20}$/;
const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;
const noop = (interaction, lang, entry) => interaction.update(panelPayload(lang, entry));
const clearPending = (interaction, lang) => (entry) =>
  interaction.update(panelPayload(lang, drafts.update(entry.panelId, { pending: null, target: null }) ?? entry));

// A modal-only action reached any other way (a forged id) gets the expired answer, never an exception.
const modalOnly = (fn) => (interaction, ctx, lang, entry) =>
  (interaction.isModalSubmit?.() ? fn(interaction, ctx, lang, entry) : refuse(interaction, lang, key('expired')));

// Picker values become ids only when they are well-formed snowflakes: nothing else may reach the script.
function pickedIds(interaction, max) {
  const ids = [...new Set(interaction.values ?? [])];
  return ids.length > 0 && ids.length <= max && ids.every((v) => SNOWFLAKE.test(v)) ? ids : null;
}

// The script grammar has no escape for a closing brace in an argument.
const hasBrace = (text) => String(text).includes('}');

async function applyGate(interaction, ctx, lang, entry, gate) {
  const next = addGate(entry.draft, gate);
  if (next.gates.length > MAX_GATES) return sideMessage(interaction, t(lang, key('tooMany')));
  return tryChange(interaction, ctx, lang, entry, next, clearPending(interaction, lang));
}

function cond(interaction, ctx, lang, entry) {
  const value = interaction.values?.[0];
  if (!COND_KINDS.includes(value)) return noop(interaction, lang, entry);
  const fresh = drafts.update(entry.panelId, { pending: value });
  return fresh ? interaction.update(panelPayload(lang, fresh)) : refuse(interaction, lang, key('expired'));
}

function coolButton(interaction, ctx, lang, entry) {
  if (entry.pending !== 'cooldown') return noop(interaction, lang, entry);
  return interaction.showModal(textModal(lang, builderId('mcooldown', entry.userId, entry.panelId), {
    name: 'seconds', title: 'cond.modal.cooldown', label: 'cond.input.seconds', style: TextInputStyle.Short,
    max: 10, required: true,
  }));
}

function permButton(interaction, ctx, lang, entry) {
  if (!PERM_GATES.includes(entry.pending)) return noop(interaction, lang, entry);
  return interaction.showModal(textModal(lang, builderId('mperm', entry.userId, entry.panelId), {
    name: 'perm', title: 'cond.modal.perm', label: 'cond.input.perm', style: TextInputStyle.Short,
    max: 40, required: true,
  }));
}

function submitCooldown(interaction, ctx, lang, entry) {
  const seconds = interaction.fields.getTextInputValue('seconds').trim();
  if (hasBrace(seconds)) return refuse(interaction, lang, key('noBrace'));
  return applyGate(interaction, ctx, lang, entry, { fn: 'cooldown', seconds });
}

function submitPerm(interaction, ctx, lang, entry) {
  if (!PERM_GATES.includes(entry.pending)) return refuse(interaction, lang, key('expired'));
  const perm = interaction.fields.getTextInputValue('perm').trim();
  if (hasBrace(perm)) return refuse(interaction, lang, key('noBrace'));
  // A pipe would split one typed permission into two arguments while the summary shows one.
  if (perm.includes('|')) return refuse(interaction, lang, key('noPipe'));
  return applyGate(interaction, ctx, lang, entry, { fn: entry.pending, perms: [perm] });
}

function pickRole(interaction, ctx, lang, entry) {
  if (ROLE_ACTIONS.includes(entry.pending)) {
    const ids = pickedIds(interaction, 1);
    if (!ids) return noop(interaction, lang, entry);
    // The target is re-checked against the draft: only the N of a member argument can reach the script.
    const target = userArgNumbers(entry.draft).includes(entry.target) ? { target: entry.target } : {};
    return applyAction(interaction, ctx, lang, entry, { fn: entry.pending, id: ids[0], ...target });
  }
  if (!ROLE_GATES.includes(entry.pending)) return noop(interaction, lang, entry);
  const ids = pickedIds(interaction, MAX_PICK);
  return ids ? applyGate(interaction, ctx, lang, entry, { fn: entry.pending, ids }) : noop(interaction, lang, entry);
}

function pickPerm(interaction, ctx, lang, entry) {
  const perm = interaction.values?.[0];
  if (!PERM_GATES.includes(entry.pending) || !PERMISSIONS.includes(perm)) return noop(interaction, lang, entry);
  return applyGate(interaction, ctx, lang, entry, { fn: entry.pending, perms: [perm] });
}

function pickChannel(interaction, ctx, lang, entry) {
  if (!CHANNEL_GATES.includes(entry.pending)) return noop(interaction, lang, entry);
  const ids = pickedIds(interaction, MAX_PICK);
  return ids ? applyGate(interaction, ctx, lang, entry, { fn: entry.pending, ids }) : noop(interaction, lang, entry);
}

function pickUser(interaction, ctx, lang, entry) {
  if (entry.pending !== 'requireuser') return noop(interaction, lang, entry);
  const ids = pickedIds(interaction, MAX_PICK);
  return ids ? applyGate(interaction, ctx, lang, entry, { fn: 'requireuser', ids }) : noop(interaction, lang, entry);
}

// Gates are "0", "1", ...; argument checks share the select as "a0", "a1", ....
function removeGateAt(interaction, ctx, lang, entry) {
  const raw = interaction.values?.[0] ?? '';
  const isCheck = raw.startsWith('a');
  const digits = isCheck ? raw.slice(1) : raw;
  const index = /^\d{1,3}$/.test(digits) ? Number(digits) : -1;
  const list = isCheck ? entry.draft.argChecks : entry.draft.gates;
  if (index < 0 || index >= list.length) return noop(interaction, lang, entry);
  const next = isCheck ? removeArgCheck(entry.draft, index) : removeGate(entry.draft, index);
  return tryChange(interaction, ctx, lang, entry, next, redraw(interaction, lang));
}

// ---- argument checks: the word number, then its type ----

const inArgFlow = (entry) => entry.pending === ARG_KIND || argTypeTarget(entry) !== null;

// A refusal for text that never reaches the compiler, in the same shape as the compiler's own.
const badInput = (interaction, lang, code, detail) =>
  interaction.reply(ephemeral(fitLines(lang, [t(lang, key('refused')), ...errorLines(lang, [{ code, detail, pos: 0 }])], MAX_REPLY)));

function argNumberButton(interaction, ctx, lang, entry) {
  if (!inArgFlow(entry)) return noop(interaction, lang, entry);
  return interaction.showModal(textModal(lang, builderId('margn', entry.userId, entry.panelId), {
    name: 'n', title: 'cond.modal.argn', label: 'cond.input.argn', style: TextInputStyle.Short, max: 3, required: true,
  }));
}

function submitArgNumber(interaction, ctx, lang, entry) {
  if (!inArgFlow(entry)) return refuse(interaction, lang, key('expired'));
  const raw = interaction.fields.getTextInputValue('n').trim();
  if (hasBrace(raw)) return refuse(interaction, lang, key('noBrace'));
  if (!/^\d{1,3}$/.test(raw)) return badInput(interaction, lang, 'ARG_INDEX_INVALID', raw);
  const n = Number(raw);
  const toTypeStep = (fresh) =>
    interaction.update(panelPayload(lang, drafts.update(fresh.panelId, { pending: `${ARGTYPE_PREFIX}${n}`, target: null }) ?? fresh));
  return tryChange(interaction, ctx, lang, entry, addArgCheck(entry.draft, { n, type: null }), toTypeStep);
}

function pickArgType(interaction, ctx, lang, entry) {
  const n = argTypeTarget(entry);
  const value = interaction.values?.[0];
  if (n === null || !ARG_TYPE_CHOICES.includes(value)) return noop(interaction, lang, entry);
  return tryChange(interaction, ctx, lang, entry, setArgType(entry.draft, n, value === 'any' ? null : value), redraw(interaction, lang));
}

// ---- role target: a transient choice that the next role pick applies ----

function pickTarget(interaction, ctx, lang, entry) {
  if (!ROLE_ACTIONS.includes(entry.pending)) return noop(interaction, lang, entry);
  const value = interaction.values?.[0];
  let target = null;
  if (value !== 'none') {
    const n = /^\d{1,2}$/.test(value ?? '') ? Number(value) : -1;
    if (!userArgNumbers(entry.draft).includes(n)) return noop(interaction, lang, entry);
    target = n;
  }
  const fresh = drafts.update(entry.panelId, { target });
  return fresh ? interaction.update(panelPayload(lang, fresh)) : refuse(interaction, lang, key('expired'));
}

// ---- random values ----

const MAX_LIST_TEXT = 1000;
const INTEGER = /^-?\d{1,12}$/;
const WEIGHT = /^(\d{1,6}(?:\.\d{1,6})?)\s*%?$/;
const textLines = (text) => String(text).split(/\r?\n/).map((l) => l.trim()).filter((l) => l !== '');

const multiModal = (lang, customId, title, inputs) => {
  const modal = new ModalBuilder().setCustomId(customId).setTitle(t(lang, key(title)));
  for (const { name, label, style, max } of inputs) {
    modal.addComponents(new ActionRowBuilder().addComponents(
      new TextInputBuilder().setCustomId(name).setLabel(t(lang, key(label))).setStyle(style).setMaxLength(max).setRequired(true)));
  }
  return modal;
};

const listInput = (name, label) => ({ name, label, style: TextInputStyle.Paragraph, max: MAX_LIST_TEXT });
const RANDOM_MODALS = {
  range: {
    id: 'mrange', title: 'random.modal.range',
    inputs: [
      { name: 'min', label: 'random.input.min', style: TextInputStyle.Short, max: 14 },
      { name: 'max', label: 'random.input.max', style: TextInputStyle.Short, max: 14 },
    ],
  },
  choose: { id: 'mchoose', title: 'random.modal.choose', inputs: [listInput('options', 'random.input.options')] },
  weightedchoose: { id: 'mweighted', title: 'random.modal.weighted', inputs: [listInput('weights', 'random.input.weights')] },
  lockedchoose: { id: 'mlocked', title: 'random.modal.locked', inputs: [listInput('values', 'random.input.values')] },
};

function pickRandomKind(interaction, ctx, lang, entry) {
  const value = interaction.values?.[0];
  if (!RANDOM_KINDS.includes(value)) return noop(interaction, lang, entry);
  const spec = RANDOM_MODALS[value];
  return interaction.showModal(multiModal(lang, builderId(spec.id, entry.userId, entry.panelId), spec.title, spec.inputs));
}

const applyRandom = (interaction, ctx, lang, entry, list, item) =>
  tryChange(interaction, ctx, lang, entry, addRandom(entry.draft, list, item), redraw(interaction, lang));

function submitRange(interaction, ctx, lang, entry) {
  const min = interaction.fields.getTextInputValue('min').trim();
  const max = interaction.fields.getTextInputValue('max').trim();
  if (hasBrace(min) || hasBrace(max)) return refuse(interaction, lang, key('noBrace'));
  if (!INTEGER.test(min) || !INTEGER.test(max)) return badInput(interaction, lang, 'RANGE_INVALID', `${min}-${max}`);
  return applyRandom(interaction, ctx, lang, entry, 'range', { min: Number(min), max: Number(max) });
}

// One entry per line. The grammar has no escape for a closing brace, and the pipe separates the arguments.
function listFrom(interaction, lang, field) {
  const items = textLines(interaction.fields.getTextInputValue(field));
  if (items.some(hasBrace)) return { refusal: refuse(interaction, lang, key('noBrace')) };
  if (items.some((l) => l.includes('|'))) return { refusal: refuse(interaction, lang, key('noPipeList')) };
  return { items };
}

function submitChoose(interaction, ctx, lang, entry) {
  const { items, refusal } = listFrom(interaction, lang, 'options');
  if (refusal) return refusal;
  return applyRandom(interaction, ctx, lang, entry, 'choose', { kind: 'choose', options: items });
}

function submitWeighted(interaction, ctx, lang, entry) {
  const { items, refusal } = listFrom(interaction, lang, 'weights');
  if (refusal) return refusal;
  // "60" and "60%" both mean 60 percent; anything else goes through as typed and the compiler refuses it.
  const weights = items.map((w) => { const m = WEIGHT.exec(w); return m ? Number(m[1]) : w; });
  return applyRandom(interaction, ctx, lang, entry, 'weighted', { kind: 'weighted', weights });
}

function submitLocked(interaction, ctx, lang, entry) {
  const { items, refusal } = listFrom(interaction, lang, 'values');
  if (refusal) return refusal;
  return applyRandom(interaction, ctx, lang, entry, 'locked', items);
}

// Values are "r<i>" (range), "c<i>" (choice or weighted choice) and "l<i>" (locked choice).
const RANDOM_FIELDS = { r: 'ranges', c: 'choosers', l: 'locked' };

function removeRandomAt(interaction, ctx, lang, entry) {
  const m = /^([rcl])(\d{1,3})$/.exec(interaction.values?.[0] ?? '');
  const field = m ? RANDOM_FIELDS[m[1]] : null;
  if (!field || Number(m[2]) >= entry.draft.random[field].length) return noop(interaction, lang, entry);
  return tryChange(interaction, ctx, lang, entry, removeRandom(entry.draft, field, Number(m[2])), redraw(interaction, lang));
}

// ---- actions ----

const applyAction = (interaction, ctx, lang, entry, action) =>
  tryChange(interaction, ctx, lang, entry, addAction(entry.draft, action), clearPending(interaction, lang));

function act(interaction, ctx, lang, entry) {
  const value = interaction.values?.[0];
  if (!ACTION_KINDS.includes(value)) return noop(interaction, lang, entry);
  const fresh = drafts.update(entry.panelId, { pending: value, target: null });
  return fresh ? interaction.update(panelPayload(lang, fresh)) : refuse(interaction, lang, key('expired'));
}

function nickButton(interaction, ctx, lang, entry) {
  if (entry.pending !== 'setnick') return noop(interaction, lang, entry);
  return interaction.showModal(textModal(lang, builderId('mnick', entry.userId, entry.panelId), {
    name: 'nick', title: 'act.modal.nick', label: 'act.input.nick', style: TextInputStyle.Short, max: 32, required: true,
  }));
}

function emojiButton(interaction, ctx, lang, entry) {
  if (!REACT_ACTIONS.includes(entry.pending)) return noop(interaction, lang, entry);
  return interaction.showModal(textModal(lang, builderId('memoji', entry.userId, entry.panelId), {
    name: 'emoji', title: 'act.modal.emoji', label: 'act.input.emoji', style: TextInputStyle.Short, max: 64, required: true,
  }));
}

function submitNick(interaction, ctx, lang, entry) {
  if (entry.pending !== 'setnick') return refuse(interaction, lang, key('expired'));
  const text = interaction.fields.getTextInputValue('nick').trim();
  if (hasBrace(text)) return refuse(interaction, lang, key('noBrace'));
  return applyAction(interaction, ctx, lang, entry, { fn: 'setnick', text });
}

function submitEmoji(interaction, ctx, lang, entry) {
  if (!REACT_ACTIONS.includes(entry.pending)) return refuse(interaction, lang, key('expired'));
  const emoji = interaction.fields.getTextInputValue('emoji').trim();
  if (hasBrace(emoji)) return refuse(interaction, lang, key('noBrace'));
  return applyAction(interaction, ctx, lang, entry, { fn: entry.pending, emoji });
}

function removeActionAt(interaction, ctx, lang, entry) {
  const raw = interaction.values?.[0];
  const index = /^\d{1,3}$/.test(raw ?? '') ? Number(raw) : -1;
  if (index < 0 || index >= entry.draft.actions.length) return noop(interaction, lang, entry);
  return tryChange(interaction, ctx, lang, entry, removeAction(entry.draft, index), redraw(interaction, lang));
}

// ---- reply options: embed and delete-reply ----

const toReplyPage = (interaction, lang) => (entry) =>
  interaction.update(panelPayload(lang, drafts.update(entry.panelId, { page: 'reply', embedNames: null }) ?? entry));

async function embedButton(interaction, ctx, lang, entry) {
  const embedNames = await listEmbeds(ctx.db, interaction.guildId);
  const fresh = drafts.update(entry.panelId, { page: 'embed', pending: null, embedNames });
  return fresh ? interaction.update(panelPayload(lang, fresh)) : refuse(interaction, lang, key('expired'));
}

function back(interaction, ctx, lang, entry) {
  const to = interaction.customId.split(':')[5] === 'review' ? 'review' : 'reply';
  const fresh = drafts.update(entry.panelId, { page: to, embedNames: null });
  return fresh ? interaction.update(panelPayload(lang, fresh)) : refuse(interaction, lang, key('expired'));
}

function pickEmbed(interaction, ctx, lang, entry) {
  if (entry.page !== 'embed') return noop(interaction, lang, entry);
  const value = interaction.values?.[0];
  if (value === 'none') return tryChange(interaction, ctx, lang, entry, patch(entry.draft, { embed: null }), toReplyPage(interaction, lang));
  if (value === 'plain') {
    return interaction.showModal(textModal(lang, builderId('mcolor', entry.userId, entry.panelId), {
      name: 'color', title: 'modal.color', label: 'input.color', style: TextInputStyle.Short, max: 7, required: false,
      value: entry.draft.embed?.color ?? undefined,
    }));
  }
  const index = /^n(\d{1,2})$/.exec(value ?? '') ? Number(value.slice(1)) : -1;
  const name = index >= 0 && index < MAX_EMBED_OPTIONS ? entry.embedNames?.[index] : undefined;
  if (!name) return noop(interaction, lang, entry);
  return tryChange(interaction, ctx, lang, entry, patch(entry.draft, { embed: { kind: 'named', name } }), toReplyPage(interaction, lang));
}

function submitColor(interaction, ctx, lang, entry) {
  const color = interaction.fields.getTextInputValue('color').trim();
  if (hasBrace(color)) return refuse(interaction, lang, key('noBrace'));
  // Without a leading # the compiler would read the text as an embed name, so the shape is checked here.
  if (color !== '' && !HEX_COLOR.test(color)) {
    return interaction.reply(ephemeral(fitLines(lang, [t(lang, key('refused')), ...errorLines(lang, [{ code: 'BAD_ARGUMENT', detail: color, pos: 0 }])], MAX_REPLY)));
  }
  return tryChange(interaction, ctx, lang, entry, patch(entry.draft, { embed: { kind: 'plain', color: color || null } }), toReplyPage(interaction, lang));
}

function delReplyButton(interaction, ctx, lang, entry) {
  return interaction.showModal(textModal(lang, builderId('mdelreply', entry.userId, entry.panelId), {
    name: 'seconds', title: 'modal.delreply', label: 'input.delreply', style: TextInputStyle.Short, max: 10, required: false,
    value: entry.draft.deleteReplyAfter ? String(entry.draft.deleteReplyAfter) : undefined,
  }));
}

function submitDelReply(interaction, ctx, lang, entry) {
  const seconds = interaction.fields.getTextInputValue('seconds').trim();
  if (hasBrace(seconds)) return refuse(interaction, lang, key('noBrace'));
  return tryChange(interaction, ctx, lang, entry, patch(entry.draft, { deleteReplyAfter: seconds || null }), redraw(interaction, lang));
}

// ---- buttons: saved buttons by name, link buttons by modal ----

function pickStoredButton(interaction, ctx, lang, entry) {
  if (entry.page !== 'buttons') return noop(interaction, lang, entry);
  const value = interaction.values?.[0] ?? '';
  const index = /^n(\d{1,2})$/.test(value) ? Number(value.slice(1)) : -1;
  const name = index >= 0 && index < MAX_BUTTON_OPTIONS ? entry.buttonNames?.[index] : undefined;
  if (!name) return noop(interaction, lang, entry);
  return tryChange(interaction, ctx, lang, entry, addButton(entry.draft, { kind: 'stored', name }), redraw(interaction, lang));
}

function linkButton(interaction, ctx, lang, entry) {
  if (entry.page !== 'buttons') return noop(interaction, lang, entry);
  const field = (name, label, max, required) => new ActionRowBuilder().addComponents(
    new TextInputBuilder().setCustomId(name).setLabel(t(lang, key(label))).setStyle(TextInputStyle.Short).setMaxLength(max).setRequired(required));
  return interaction.showModal(new ModalBuilder().setCustomId(builderId('mlink', entry.userId, entry.panelId))
    .setTitle(t(lang, key('modal.link')))
    .addComponents(field('label', 'input.linklabel', 80, true), field('url', 'input.linkurl', 512, true), field('emoji', 'input.linkemoji', 64, false)));
}

function submitLink(interaction, ctx, lang, entry) {
  const label = interaction.fields.getTextInputValue('label').trim();
  const url = interaction.fields.getTextInputValue('url').trim();
  const emoji = (interaction.fields.getTextInputValue('emoji') ?? '').trim();
  if ([label, url, emoji].some(hasBrace)) return refuse(interaction, lang, key('noBrace'));
  // The pipe separates the arguments of the call, so it cannot be part of one.
  if ([label, url, emoji].some((v) => v.includes('|'))) return refuse(interaction, lang, key('noPipe'));
  if (label === '') return badInput(interaction, lang, 'BAD_ARGUMENT', label);
  return tryChange(interaction, ctx, lang, entry, addButton(entry.draft, { kind: 'link', label, url, emoji: emoji || null }), redraw(interaction, lang));
}

function removeButtonAt(interaction, ctx, lang, entry) {
  const raw = interaction.values?.[0];
  const index = /^\d{1,2}$/.test(raw ?? '') ? Number(raw) : -1;
  if (index < 0 || index >= (entry.draft.buttons ?? []).length) return noop(interaction, lang, entry);
  return tryChange(interaction, ctx, lang, entry, removeButton(entry.draft, index), redraw(interaction, lang));
}

// ---- Try it: a dry run of the draft against a sample message. Reads only; nothing is written or sent. ----

function tryButton(interaction, ctx, lang, entry) {
  return interaction.showModal(textModal(lang, builderId('mtry', entry.userId, entry.panelId), {
    name: 'sample', title: 'modal.try', label: 'input.sample', style: TextInputStyle.Paragraph, max: MAX_SAMPLE, required: true,
  }));
}

async function submitTry(interaction, ctx, lang, entry) {
  const sample = interaction.fields.getTextInputValue('sample');
  const { draft } = entry;
  if (needsChannel(draft)) return refuse(interaction, lang, key('needChannel'));
  const script = generateScript(draft);
  const result = await compileScript(script, { db: ctx.db, guild: interaction.guild, writer: interaction.member, matchMode: draft.matchMode });
  if (!result.ok) {
    return interaction.reply(ephemeral(fitLines(lang, [t(lang, 'autoresponder.errors.head'), ...errorLines(lang, result.errors)], MAX_REPLY)));
  }
  const verdict = draft.trigger.trim() === '' ? { ok: true } : checkTrigger(draft.trigger, draft.matchMode);
  if (!verdict.ok) return interaction.reply(ephemeral(t(lang, `autoresponder.badTrigger.${verdict.code}`)));
  const matched = matchRule({ trigger: draft.trigger, matchMode: draft.matchMode, enabled: true }, sample);
  const lines = [t(lang, key(matched ? 'try.match' : 'try.nomatch'))];
  if (!matched) lines.push(t(lang, key('try.wouldRun')));
  lines.push(...await describeRunFor(lang, {
    compiled: result.compiled, text: sample, member: interaction.member, guild: interaction.guild,
    channel: interaction.channel, channelId: interaction.channelId, author: interaction.user,
  }, { rule: { trigger: draft.trigger, matchMode: draft.matchMode }, db: ctx.db }));
  lines.push(...warningLines(lang, result.warnings));
  return interaction.reply(ephemeral({ content: fitLines(lang, lines, MAX_REPLY), allowedMentions: { parse: [] } }));
}

// ---- script text: the one-way switch to script mode ----

function basicsButton(interaction, ctx, lang, entry) {
  const fresh = drafts.update(entry.panelId, { page: 'basics', pending: null });
  return fresh ? interaction.update(panelPayload(lang, fresh)) : refuse(interaction, lang, key('expired'));
}

function scriptButton(interaction, ctx, lang, entry) {
  const script = generateScript(entry.draft);
  const fits = script.length <= MAX_SCRIPT;
  return interaction.showModal(textModal(lang, builderId('mscript', entry.userId, entry.panelId), {
    name: 'script', title: 'modal.script', label: 'input.script', style: TextInputStyle.Paragraph, max: MAX_SCRIPT, required: true,
    value: fits ? script : undefined, placeholder: fits ? undefined : t(lang, key('script.tooLong')),
  }));
}

// Compiles the edited text as the writer; on success the draft becomes a script-mode draft and stays one.
function submitScript(interaction, ctx, lang, entry) {
  const script = interaction.fields.getTextInputValue('script');
  const toReview = (fresh) => interaction.update(panelPayload(lang, drafts.update(fresh.panelId, { page: 'review', pending: null }) ?? fresh));
  return tryChange(interaction, ctx, lang, entry, toScriptMode(entry.draft, script), toReview);
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
    if (needsChannel(draft)) return await interaction.followUp(ephemeral(t(lang, key('needChannel'))));
    const script = generateScript(draft);
    const result = await compileScript(script, { db: ctx.db, guild: interaction.guild, writer: interaction.member, matchMode: draft.matchMode });
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
    return await interaction.editReply({ content: withWarnings(lang, t(lang, key('saved'), { id: created.id }), result.warnings), components: [] });
  } finally {
    if (!done) drafts.endSave(entry.panelId, false);
  }
}

const ACTIONS = {
  nav, mode, dest, channel, delete: toggle('deleteTrigger'), silent: toggle('silent'),
  trigger: triggerButton, text: textButton, mtrigger: modalOnly(submitTrigger), mtext: modalOnly(submitText), cancel, save,
  cond, bcool: coolButton, bperm: permButton, mcooldown: modalOnly(submitCooldown), mperm: modalOnly(submitPerm),
  prole: pickRole, pperm: pickPerm, pchan: pickChannel, puser: pickUser, rmgate: removeGateAt,
  bembed: embedButton, bback: back, embed: pickEmbed, mcolor: modalOnly(submitColor),
  btry: tryButton, mtry: modalOnly(submitTry), bbasics: basicsButton, bscript: scriptButton, mscript: modalOnly(submitScript),
  bdelreply: delReplyButton, mdelreply: modalOnly(submitDelReply),
  bargn: argNumberButton, margn: modalOnly(submitArgNumber), parg: pickArgType, tgt: pickTarget,
  rnd: pickRandomKind, mrange: modalOnly(submitRange), mchoose: modalOnly(submitChoose), mweighted: modalOnly(submitWeighted),
  mlocked: modalOnly(submitLocked), rmrnd: removeRandomAt,
  pbtn: pickStoredButton, blink: linkButton, mlink: modalOnly(submitLink), rmbtn: removeButtonAt,
  act, bnick: nickButton, bemoji: emojiButton, mnick: modalOnly(submitNick), memoji: modalOnly(submitEmoji), rmact: removeActionAt,
};

const SCRIPT_MODE_ACTIONS = new Set(['trigger', 'mtrigger', 'mode', 'bbasics', 'bback', 'btry', 'mtry', 'bscript', 'mscript', 'save', 'cancel']);

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
  // An unknown action (a forged id) still gets an answer, so the click never shows "interaction failed".
  if (!action) return refuse(interaction, lang, key('expired'));
  // A script-mode draft has no guided controls: anything outside this set (a forged id) just redraws the panel.
  if (entry.draft.mode === 'script' && !SCRIPT_MODE_ACTIONS.has(ids.action)) return noop(interaction, lang, entry);
  return action(interaction, ctx, lang, entry);
}

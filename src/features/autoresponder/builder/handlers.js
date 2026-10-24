// The builder's interaction router. Every component and modal of the panel passes through handleBuilder:
// id parse, opener check, manager guard, then the draft lookup, in that order.
import { ModalBuilder, TextInputBuilder, TextInputStyle, ActionRowBuilder } from 'discord.js';
import { guard } from '../../../core/guard.js';
import { ephemeral } from '../../../core/replies.js';
import { getLang, t } from '../../../i18n/index.js';
import { fitLines } from '../../reactionroles/setup.js';
import { createRule } from '../store.js';
import { listEmbeds } from '../../embeds/store.js';
import { invalidate } from '../cache.js';
import { checkTrigger, matchRule, MATCH_MODES, MAX_TRIGGER_LENGTH } from '../match.js';
import { describeRun } from '../dryrun.js';
import { compileScript, MAX_SCRIPT } from '../script/compile.js';
import { errorLines, log } from '../commands.js';
import { addAction, addGate, newDraft, patch, removeAction, removeGate, setTrigger, toScriptMode } from './draft.js';
import { generateScript } from './generate.js';
import { drafts } from './drafts.js';
import {
  builderId, parseBuilderId, panelPayload, PAGES, DESTINATIONS,
  GATE_KINDS, ACTION_KINDS, ROLE_ACTIONS, REACT_ACTIONS, ROLE_GATES, PERM_GATES, CHANNEL_GATES, MAX_PICK, MAX_GATES, PERMISSIONS, MAX_EMBED_OPTIONS,
} from './panel.js';

const MAX_REPLY = 2000;
const MAX_SAMPLE = 1000;
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

const textModal = (lang, customId, { name, title, label, style, max, required, value, placeholder }) => {
  const input = new TextInputBuilder().setCustomId(name).setLabel(t(lang, key(label))).setStyle(style)
    .setMaxLength(max).setRequired(required);
  if (value) input.setValue(value);
  if (placeholder) input.setPlaceholder(placeholder);
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

// ---- conditions ----

const SNOWFLAKE = /^\d{17,20}$/;
const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;
const noop = (interaction, lang, entry) => interaction.update(panelPayload(lang, entry));
const clearPending = (interaction, lang) => (entry) =>
  interaction.update(panelPayload(lang, drafts.update(entry.panelId, { pending: null }) ?? entry));

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
  if (!GATE_KINDS.includes(value)) return noop(interaction, lang, entry);
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
  return applyGate(interaction, ctx, lang, entry, { fn: entry.pending, perms: [perm] });
}

function pickRole(interaction, ctx, lang, entry) {
  if (ROLE_ACTIONS.includes(entry.pending)) {
    const ids = pickedIds(interaction, 1);
    return ids ? applyAction(interaction, ctx, lang, entry, { fn: entry.pending, id: ids[0] }) : noop(interaction, lang, entry);
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

function removeGateAt(interaction, ctx, lang, entry) {
  const raw = interaction.values?.[0];
  const index = /^\d{1,3}$/.test(raw ?? '') ? Number(raw) : -1;
  if (index < 0 || index >= entry.draft.gates.length) return noop(interaction, lang, entry);
  return tryChange(interaction, ctx, lang, entry, removeGate(entry.draft, index), redraw(interaction, lang));
}

// ---- actions ----

const applyAction = (interaction, ctx, lang, entry, action) =>
  tryChange(interaction, ctx, lang, entry, addAction(entry.draft, action), clearPending(interaction, lang));

function act(interaction, ctx, lang, entry) {
  const value = interaction.values?.[0];
  if (!ACTION_KINDS.includes(value)) return noop(interaction, lang, entry);
  const fresh = drafts.update(entry.panelId, { pending: value });
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

// ---- Try it: a dry run of the draft against a sample message. Reads only; nothing is written or sent. ----

function tryButton(interaction, ctx, lang, entry) {
  return interaction.showModal(textModal(lang, builderId('mtry', entry.userId, entry.panelId), {
    name: 'sample', title: 'modal.try', label: 'input.sample', style: TextInputStyle.Paragraph, max: MAX_SAMPLE, required: true,
  }));
}

async function submitTry(interaction, ctx, lang, entry) {
  const sample = interaction.fields.getTextInputValue('sample');
  const { draft } = entry;
  const script = generateScript(draft);
  const result = await compileScript(script, { db: ctx.db, guild: interaction.guild, writer: interaction.member });
  if (!result.ok) {
    return interaction.reply(ephemeral(fitLines(lang, [t(lang, 'autoresponder.errors.head'), ...errorLines(lang, result.errors)], MAX_REPLY)));
  }
  const verdict = draft.trigger.trim() === '' ? { ok: true } : checkTrigger(draft.trigger, draft.matchMode);
  if (!verdict.ok) return interaction.reply(ephemeral(t(lang, `autoresponder.badTrigger.${verdict.code}`)));
  const matched = matchRule({ trigger: draft.trigger, matchMode: draft.matchMode, enabled: true }, sample);
  const lines = [t(lang, key(matched ? 'try.match' : 'try.nomatch'))];
  if (!matched) lines.push(t(lang, key('try.wouldRun')));
  lines.push(...describeRun(lang, {
    compiled: result.compiled, text: sample, member: interaction.member, guild: interaction.guild,
    channel: interaction.channel, channelId: interaction.channelId, author: interaction.user,
  }));
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
  cond, bcool: coolButton, bperm: permButton, mcooldown: modalOnly(submitCooldown), mperm: modalOnly(submitPerm),
  prole: pickRole, pperm: pickPerm, pchan: pickChannel, puser: pickUser, rmgate: removeGateAt,
  bembed: embedButton, bback: back, embed: pickEmbed, mcolor: modalOnly(submitColor),
  btry: tryButton, mtry: modalOnly(submitTry), bbasics: basicsButton, bscript: scriptButton, mscript: modalOnly(submitScript),
  bdelreply: delReplyButton, mdelreply: modalOnly(submitDelReply),
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
  // A script-mode draft has no guided controls: anything outside this set (a forged id) just redraws the panel.
  if (entry.draft.mode === 'script' && !SCRIPT_MODE_ACTIONS.has(ids.action)) return action ? noop(interaction, lang, entry) : undefined;
  return action?.(interaction, ctx, lang, entry);
}

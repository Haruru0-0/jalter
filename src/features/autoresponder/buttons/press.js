// A press on an autoresponder button: member-facing, so it only needs the feature to be on (no manager check).
// Order (design spec, "What a press checks"): deferUpdate, feature on, record alive, rule exists and is enabled,
// stored button exists, invoker and throttle, the limited/strict claim, the button script's gates, then {cooldown}.
// Every refusal is an ephemeral follow-up; the public reply is posted by executePlan.
import { getLang, t } from '../../../i18n/index.js';
import { isEnabled } from '../../../core/registry.js';
import { ephemeral } from '../../../core/replies.js';
import { componentEmoji } from '../../reactionroles/config.js';
import { getRule } from '../store.js';
import { evaluate } from '../script/evaluate.js';
import { prepareButtonRun } from '../script/run.js';
import { buildScriptVars } from '../script/placeholders.js';
import { executePlan } from '../execute.js';
import { logRunError } from '../log.js';
import { getButton, getMessageRecord, claimPress, claimButtonCooldown } from './store.js';
import { parseButtonId, pressDecision, createPressThrottle, buildRows } from './model.js';

const FK_VIOLATION = '23503';
const defaultThrottle = createPressThrottle();

// What the posted message shows after a claim: the entries of the record with their current labels. A stored button
// that was removed since keeps its slot (custom ids are indexes) but is shown disabled.
async function renderRows(ctx, record, deps) {
  const find = deps.getButton ?? getButton;
  const pressed = [...record.pressed];
  const entries = [];
  for (const [i, e] of record.buttons.entries()) {
    if (e.kind === 'link') { entries.push(e); continue; }
    const found = await find(ctx.db, record.guildId, e.name).catch(() => null);
    if (!found) pressed.push(i);
    entries.push(found
      ? { kind: 'stored', name: e.name, label: found.label, emoji: found.emoji, style: found.style }
      : { kind: 'stored', name: e.name, label: e.name, emoji: null, style: 'grey' });
  }
  return buildRows(record.messageId, entries, { locked: record.locked, pressed }, componentEmoji);
}

// After a deferUpdate, editReply edits the message the button is on.
async function refreshButtons(interaction, ctx, messageId, deps, now) {
  try {
    const fresh = await (deps.getMessageRecord ?? getMessageRecord)(ctx.db, messageId, now);
    if (!fresh) return;
    await interaction.editReply({ components: await renderRows(ctx, fresh, deps) });
  } catch (err) {
    console.warn(`Autoresponder could not update the buttons: ${err?.message ?? err}`);
  }
}

// executePlan wants a message-like object. This one is the message that carries the button; if that message is gone
// a reply falls back to a plain send in the same channel.
function replyTarget(interaction, guild, channel, messageId) {
  const msg = interaction.message;
  return {
    id: messageId,
    guild,
    channel,
    channelId: interaction.channelId,
    delete: () => msg.delete(),
    react: (emoji) => msg.react(emoji),
    async reply(payload) {
      try {
        return await msg.reply(payload);
      } catch {
        const { failIfNotExists, ...rest } = payload;
        void failIfNotExists;
        return channel.send(rest);
      }
    },
  };
}

async function press(interaction, ctx, deps, lang, say) {
  const parsed = parseButtonId(interaction.customId);
  const { guildId } = interaction;
  const presser = interaction.user;
  const now = deps.now?.() ?? Date.now();

  if (!(await isEnabled(ctx.db, guildId, 'autoresponder'))) return say('expired');
  const record = await (deps.getMessageRecord ?? getMessageRecord)(ctx.db, parsed.messageId, now);
  if (!record || record.guildId !== guildId) return say('expired');
  // Defence in depth: the id must belong to the message and channel the press came from.
  if (interaction.message?.id !== parsed.messageId) return say('expired');
  if (interaction.channelId && record.channelId && interaction.channelId !== record.channelId) return say('expired');
  const rule = await getRule(ctx.db, guildId, record.ruleId);
  if (!rule || !rule.enabled) return say('expired');
  // parseButtonId does not bound the index; a link entry has no custom id, so only a stored one can be pressed.
  const entry = parsed.index < record.buttons.length ? record.buttons[parsed.index] : null;
  if (entry?.kind !== 'stored') return say('expired');
  const button = await (deps.getButton ?? getButton)(ctx.db, guildId, entry.name);
  if (!button) return say('expired');

  const decision = pressDecision({ record, button, presserId: presser.id, now, throttle: deps.throttle ?? defaultThrottle });
  if (!decision.ok) return say(decision.reason);

  const guild = interaction.guild;
  const member = interaction.member?.roles?.cache ? interaction.member : await guild.members.fetch(presser.id);
  const channel = interaction.channel ?? interaction.message?.channel;
  // "The member" is the presser. buildScriptVars reads the author from the message, so it gets a presser-based one.
  const asMessage = { id: record.messageId, author: presser, content: '', channel, channelId: interaction.channelId, url: interaction.message?.url ?? '' };
  const vars = buildScriptVars({ message: asMessage, member, guild, lang });
  // Stored words are re-checked now (a stored user who left fails); random values: see prepareButtonRun for the merge.
  const prepared = await prepareButtonRun({ compiled: button.compiled, wordsText: record.words, storedDraws: record.draws, guild, rng: deps.rng });
  const plan = evaluate(button.compiled, { member, channelId: interaction.channelId, vars, ...prepared });

  if (plan.status === 'skip') {
    if (plan.gate === 'arg') return say('arg', { n: String(plan.arg.n), type: t(lang, `autoresponder.argtype.${plan.arg.type ?? 'word'}`) });
    return say('gate');
  }

  // Gates and word checks are read-only, so they are answered before anything is claimed: a member who fails them
  // must not use up a limited button or lock a strict message for everyone.
  const claim = await claimPress(ctx.db, record.messageId, parsed.index, button.limitations, now);
  if (!claim.ok) {
    if (claim.reason === 'gone') return say('expired');
    await say(claim.reason);
    await refreshButtons(interaction, ctx, record.messageId, deps, now);
    return;
  }
  if (button.limitations !== 'none') await refreshButtons(interaction, ctx, record.messageId, deps, now);

  if (plan.cooldown) {
    let claimed;
    try {
      claimed = await claimButtonCooldown(ctx.db, record.messageId, parsed.index, presser.id, plan.cooldown, now);
    } catch (err) {
      if (err?.code === FK_VIOLATION) return say('expired'); // the record was pruned while this press ran
      throw err;
    }
    if (!claimed.ok) return say('cooldown', { seconds: String(Math.ceil(claimed.retryAfterMs / 1000)) });
  }

  const run = deps.executePlan ?? executePlan;
  const { errors } = await run(ctx, {
    rule, message: replyTarget(interaction, guild, channel, record.messageId), member, plan, lang, vars,
    // A chained reply (the script attaches buttons) is for the presser, with the original words and draws carried on.
    invokerId: presser.id, buttonState: { words: record.words, draws: record.draws },
  }, deps);
  if (errors?.length) await (deps.logRunError ?? logRunError)(ctx, guild, lang, { ruleId: rule.id, errors });
}

/** Handles `autoresponder:p:<messageId>:<index>`. Never throws. */
export async function handlePress(interaction, ctx, deps = {}) {
  const parsed = parseButtonId(interaction.customId);
  if (!parsed || !interaction.guildId || !interaction.isButton?.()) return;
  try {
    await interaction.deferUpdate();
  } catch (err) {
    console.warn(`Autoresponder press could not be acknowledged: ${err?.message ?? err}`);
    return;
  }
  let lang = 'en';
  const say = async (key, vars) => {
    try {
      await interaction.followUp(ephemeral(t(lang, `autoresponder.press.${key}`, vars)));
    } catch (err) {
      console.warn(`Autoresponder press notice failed: ${err?.message ?? err}`);
    }
  };
  try {
    lang = await getLang(ctx.db, interaction.guildId);
    await press(interaction, ctx, deps, lang, say);
  } catch (err) {
    console.warn(`Autoresponder press failed: ${err?.message ?? err}`);
    await say('error');
  }
}

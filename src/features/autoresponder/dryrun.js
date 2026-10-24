// Dry run of a compiled rule for one member: which gates pass, what text it would send and what it would do.
// Pure: it reads nothing from the database and calls no Discord write.
import { t } from '../../i18n/index.js';
import { evaluate } from './script/evaluate.js';
import { buildScriptVars } from './script/placeholders.js';
import { renderPlaceholders } from '../../core/placeholders.js';

const MAX_TEST_TEXT = 700;

const tt = (lang, key, vars) => t(lang, `autoresponder.test.${key}`, vars);
const oneLine = (s) => String(s).replace(/\s+/g, ' ');
const GATE_LABEL = { requirerole: 'requirerole', denyrole: 'denyrole', requireperm: 'requireperm', denyperm: 'denyperm', requirechannel: 'requirechannel', denychannel: 'denychannel', requireuser: 'requireuser' };

// Each gate is judged on its own through evaluate, so the report names every pass and fail.
function gateLines(lang, compiled, evalCtx) {
  const lines = [];
  for (const gate of compiled.gates) {
    if (gate.fn === 'cooldown') { lines.push(tt(lang, 'gate.cooldown', { seconds: gate.seconds })); continue; }
    const verdict = evaluate({ ...compiled, gates: [gate] }, evalCtx);
    lines.push(tt(lang, verdict.status === 'skip' ? 'gate.fail' : 'gate.pass', { gate: GATE_LABEL[gate.fn] ?? gate.fn }));
  }
  return lines;
}

// The actions in the order executePlan runs them, without running any.
function actionLines(lang, plan, vars) {
  const { flags } = plan;
  const acts = plan.actions ?? [];
  const lines = [];
  const add = (key, detail) => lines.push(tt(lang, `action.${key}`, { detail }));
  if (flags.delete) add('delete');
  for (const a of acts.filter((x) => x.fn === 'addrole' || x.fn === 'removerole')) add(a.fn, `<@&${a.roleId}>`);
  for (const a of acts.filter((x) => x.fn === 'setnick')) add('setnick', oneLine(renderPlaceholders(a.text, vars)).trim());
  if (!flags.delete) for (const a of acts.filter((x) => x.fn === 'react')) add('react', a.emoji);
  const hasMessage = plan.text.length > 0 || !!flags.embed;
  if (hasMessage) {
    if (flags.embed) add('embed', flags.embed.kind === 'named' ? flags.embed.name : 'plain');
    if (flags.dm) add('dm');
    else if (flags.sendTo) add('sendto', `<#${flags.sendTo}>`);
    else add(flags.delete ? 'replyChannel' : 'reply');
    for (const a of acts.filter((x) => x.fn === 'reactreply')) add('reactreply', a.emoji);
    if (flags.deleteReplyAfter) add('delete_reply', flags.deleteReplyAfter);
  }
  if (flags.silent) add('silent');
  return lines.length ? lines : [tt(lang, 'action.none')];
}

/**
 * The report lines for one compiled rule: the gate lines, then (when no gate fails) the rendered text
 * and the action list. `text` is the message the member would type.
 */
export function describeRun(lang, { compiled, text, member, guild, channel, channelId, author }) {
  const message = { id: '', url: '', content: text, author, channel, channelId };
  const vars = buildScriptVars({ message, member, guild, lang });
  const evalCtx = { member, channelId, vars };
  const plan = evaluate(compiled, evalCtx);

  const lines = [];
  const gates = gateLines(lang, compiled, evalCtx);
  if (gates.length) lines.push(tt(lang, 'gates'), ...gates);
  if (plan.status === 'run') {
    const shown = plan.text.length > MAX_TEST_TEXT ? `${plan.text.slice(0, MAX_TEST_TEXT - 1)}…` : plan.text;
    lines.push(tt(lang, 'text'), shown || tt(lang, 'text.empty'), tt(lang, 'actions'), ...actionLines(lang, plan, vars));
  }
  return lines;
}

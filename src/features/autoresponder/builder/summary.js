// The readable summary of a draft, one line per setting. Pure: text only.
import { t } from '../../../i18n/index.js';

const key = (k) => `autoresponder.builder.${k}`;
const oneLine = (s) => String(s).replace(/\s+/g, ' ');
const MAX_TEXT_SHOWN = 200;

const mention = {
  requirerole: (id) => `<@&${id}>`, denyrole: (id) => `<@&${id}>`, addrole: (id) => `<@&${id}>`, removerole: (id) => `<@&${id}>`,
  requirechannel: (id) => `<#${id}>`, denychannel: (id) => `<#${id}>`,
  requireuser: (id) => `<@${id}>`,
};

function gateValue(g) {
  if (g.fn === 'cooldown') return String(g.seconds);
  if (g.perms) return g.perms.join(', ');
  return g.ids.map(mention[g.fn]).join(', ');
}

function actionValue(a) {
  if (a.id) return a.target ? `${mention[a.fn](a.id)} → [$${a.target}]` : mention[a.fn](a.id);
  return oneLine(a.emoji ?? a.text ?? '');
}

function embedValue(lang, embed) {
  if (embed.kind === 'named') return embed.name;
  return embed.color ?? t(lang, key('notSet'));
}

export function summaryLines(lang, d) {
  const none = t(lang, key('notSet'));
  const lines = [t(lang, key('sum.trigger'), { mode: d.matchMode, value: d.trigger ? oneLine(d.trigger) : none })];
  if (d.mode === 'script') {
    lines.push(t(lang, key('sum.script')), `\`\`\`\n${String(d.scriptText).replace(/`/g, "'")}\n\`\`\``);
    return lines;
  }
  const text = oneLine(d.text);
  lines.push(t(lang, key('sum.text'), { value: text ? (text.length > MAX_TEXT_SHOWN ? `${text.slice(0, MAX_TEXT_SHOWN)}…` : text) : none }));
  lines.push(t(lang, key(`sum.dest.${d.dest}`), { value: d.channelId ? `<#${d.channelId}>` : none }));
  if (d.embed) lines.push(t(lang, key('sum.embed'), { value: embedValue(lang, d.embed) }));
  if (d.deleteTrigger) lines.push(t(lang, key('sum.delete')));
  if (d.deleteReplyAfter) lines.push(t(lang, key('sum.delete_reply'), { value: d.deleteReplyAfter }));
  if (d.silent) lines.push(t(lang, key('sum.silent')));
  for (const g of d.gates) lines.push(t(lang, key(`sum.${g.fn}`), { value: gateValue(g) }));
  for (const a of d.actions) lines.push(t(lang, key(`sum.${a.fn}`), { value: actionValue(a) }));
  for (const c of d.argChecks ?? []) {
    lines.push(c.type
      ? t(lang, key('sum.requirearg'), { n: c.n, type: t(lang, key(`cond.argtype.${c.type}`)) })
      : t(lang, key('sum.requirearg.any'), { n: c.n }));
  }
  const random = d.random ?? { ranges: [], choosers: [], locked: [] };
  for (const r of random.ranges) lines.push(t(lang, key('sum.range'), { min: r.min, max: r.max }));
  for (const c of random.choosers) {
    lines.push(c.kind === 'weighted'
      ? t(lang, key('sum.weighted'), { value: c.weights.map((w) => (typeof w === 'number' ? `${w}%` : oneLine(w))).join(', ') })
      : t(lang, key('sum.choose'), { value: c.options.map(oneLine).join(', ') }));
  }
  for (const values of random.locked) lines.push(t(lang, key('sum.locked'), { value: values.map(oneLine).join(', ') }));
  if (d.deleteTrigger && d.actions.some((a) => a.fn === 'react')) lines.push(t(lang, key('sum.note.deleteReact')));
  return lines;
}

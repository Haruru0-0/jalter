// The builder panel: custom ids and the message payload for each page.
import {
  ActionRowBuilder, ButtonBuilder, ButtonStyle, ChannelSelectMenuBuilder, ChannelType, RoleSelectMenuBuilder,
  StringSelectMenuBuilder, UserSelectMenuBuilder,
} from 'discord.js';
import { t } from '../../../i18n/index.js';
import { fitLines } from '../../reactionroles/setup.js';
import { MATCH_MODES } from '../match.js';
import { summaryLines } from './summary.js';
import { newDraft } from './draft.js';

const CONTENT_LIMIT = 2000;
const key = (k) => `autoresponder.builder.${k}`;

// Later tasks insert their pages before `review`, which stays last.
export const PAGES = ['basics', 'reply', 'conditions', 'actions', 'random', 'review'];
export const DESTINATIONS = ['reply', 'dm', 'channel'];

export const GATE_KINDS = ['cooldown', 'requirerole', 'denyrole', 'requireperm', 'denyperm', 'requirechannel', 'denychannel', 'requireuser'];
export const ARG_KIND = 'requirearg';
export const COND_KINDS = [...GATE_KINDS, ARG_KIND];
export const ARG_TYPE_CHOICES = ['any', 'user', 'channel', 'color', 'role', 'number'];
export const RANDOM_KINDS = ['range', 'choose', 'weightedchoose', 'lockedchoose'];
export const ARGTYPE_PREFIX = 'argtype:';
export const ROLE_GATES = ['requirerole', 'denyrole'];
export const PERM_GATES = ['requireperm', 'denyperm'];
export const CHANNEL_GATES = ['requirechannel', 'denychannel'];
export const ACTION_KINDS = ['addrole', 'removerole', 'setnick', 'react', 'reactreply'];
export const ROLE_ACTIONS = ['addrole', 'removerole'];
export const REACT_ACTIONS = ['react', 'reactreply'];
export const MAX_PICK = 10;
export const MAX_GATES = 25;
export const PERMISSIONS = [
  'ManageMessages', 'ManageRoles', 'ManageChannels', 'ManageGuild', 'ManageNicknames', 'KickMembers', 'BanMembers',
  'ModerateMembers', 'Administrator', 'MentionEveryone', 'SendMessages', 'AttachFiles', 'EmbedLinks', 'AddReactions',
  'UseExternalEmojis', 'ViewChannel', 'Connect', 'Speak', 'ReadMessageHistory', 'ManageThreads', 'ManageEvents',
  'ManageWebhooks', 'CreateInstantInvite',
];
const MAX_LABEL = 100;
export const MAX_EMBED_OPTIONS = 23; // the select holds 25: "no embed", "plain colour", then these

/** autoresponder:b:<action>:<userId>:<panelId>[:<extra>] (well under Discord's 100 characters). */
export const builderId = (action, userId, panelId, extra) =>
  ['autoresponder', 'b', action, userId, panelId, extra].filter((p) => p !== undefined).join(':');

export function parseBuilderId(customId) {
  const [prefix, kind, action, userId, panelId, extra] = String(customId).split(':');
  if (prefix !== 'autoresponder' || kind !== 'b' || !action || !userId || !panelId) return null;
  return { action, userId, panelId, extra };
}

export const pageOf = (entry) => (PAGES.includes(entry.page) ? entry.page : PAGES[0]);

const row = (...components) => new ActionRowBuilder().addComponents(...components);
const button = (lang, id, label, style = ButtonStyle.Secondary) =>
  new ButtonBuilder().setCustomId(id).setLabel(t(lang, key(`btn.${label}`))).setStyle(style);
const select = (lang, id, placeholder, options, current) =>
  new StringSelectMenuBuilder().setCustomId(id).setPlaceholder(t(lang, key(`ph.${placeholder}`)))
    .addOptions(options.map((o) => ({ ...o, default: o.value === current })));

// Same shape as `select`, with full i18n keys (the conditions and actions pages keep their own namespaces).
const pick = (lang, id, ph, options, current) =>
  new StringSelectMenuBuilder().setCustomId(id).setPlaceholder(t(lang, key(ph)))
    .addOptions(options.map((o) => ({ ...o, default: o.value === current })));
const btn = (lang, id, label, style = ButtonStyle.Secondary) =>
  new ButtonBuilder().setCustomId(id).setLabel(t(lang, key(label))).setStyle(style);

/** One option per item, labelled with the summary line the item produces (the last line of a one-item draft). */
const lineOf = (lang, partial) => summaryLines(lang, { ...newDraft(), ...partial }).at(-1).slice(0, MAX_LABEL);

function removeOptions(lang, field, items) {
  return items.slice(0, MAX_GATES).map((item, index) => ({ label: lineOf(lang, { [field]: [item] }), value: String(index) }));
}

// Conditions and argument checks share one remove select: gates are "0", "1", ..., argument checks "a0", "a1", ....
function conditionRemoveOptions(lang, draft) {
  const gates = removeOptions(lang, 'gates', draft.gates);
  const checks = draft.argChecks.slice(0, MAX_GATES - gates.length)
    .map((c, index) => ({ label: lineOf(lang, { argChecks: [c] }), value: `a${index}` }));
  return [...gates, ...checks];
}

/** The N of every argument check that must be a member: the only valid role targets. */
export const userArgNumbers = (draft) => draft.argChecks.filter((c) => c.type === 'user').map((c) => c.n);

/** The N a pending "argtype:N" view is about, when the draft still has that check. */
export function argTypeTarget(entry) {
  if (typeof entry.pending !== 'string' || !entry.pending.startsWith(ARGTYPE_PREFIX)) return null;
  const n = Number(entry.pending.slice(ARGTYPE_PREFIX.length));
  return entry.draft.argChecks.some((c) => c.n === n) ? n : null;
}

function conditionRows(lang, entry) {
  const { userId, panelId, draft } = entry;
  const id = (action) => builderId(action, userId, panelId);
  const argN = argTypeTarget(entry);
  const kind = COND_KINDS.includes(entry.pending) ? entry.pending : (argN === null ? null : ARG_KIND);
  const rows = [row(pick(lang, id('cond'), 'cond.ph.kind',
    COND_KINDS.map((k) => ({ label: t(lang, key(`cond.kind.${k}`)), value: k })), kind))];
  if (argN !== null) {
    const current = entry.draft.argChecks.find((c) => c.n === argN).type ?? 'any';
    rows.push(row(pick(lang, id('parg'), 'cond.ph.argtype',
      ARG_TYPE_CHOICES.map((k) => ({ label: t(lang, key(`cond.argtype.${k}`)), value: k })), current)));
  } else if (kind === ARG_KIND) rows.push(row(btn(lang, id('bargn'), 'cond.btn.argn', ButtonStyle.Primary)));
  else if (kind === 'cooldown') rows.push(row(btn(lang, id('bcool'), 'cond.btn.cooldown', ButtonStyle.Primary)));
  else if (ROLE_GATES.includes(kind)) {
    rows.push(row(new RoleSelectMenuBuilder().setCustomId(id('prole')).setPlaceholder(t(lang, key('cond.ph.role')))
      .setMinValues(1).setMaxValues(MAX_PICK)));
  } else if (PERM_GATES.includes(kind)) {
    rows.push(row(pick(lang, id('pperm'), 'cond.ph.perm', PERMISSIONS.map((p) => ({ label: p, value: p })))));
    rows.push(row(btn(lang, id('bperm'), 'cond.btn.permOther')));
  } else if (CHANNEL_GATES.includes(kind)) {
    rows.push(row(new ChannelSelectMenuBuilder().setCustomId(id('pchan')).setPlaceholder(t(lang, key('cond.ph.channel')))
      .setChannelTypes(ChannelType.GuildText).setMinValues(1).setMaxValues(MAX_PICK)));
  } else if (kind === 'requireuser') {
    rows.push(row(new UserSelectMenuBuilder().setCustomId(id('puser')).setPlaceholder(t(lang, key('cond.ph.user')))
      .setMinValues(1).setMaxValues(MAX_PICK)));
  }
  if (draft.gates.length || draft.argChecks.length) {
    rows.push(row(pick(lang, id('rmgate'), 'cond.ph.remove', conditionRemoveOptions(lang, draft))));
  }
  return rows;
}

function actionRows(lang, entry) {
  const { userId, panelId, draft } = entry;
  const id = (action) => builderId(action, userId, panelId);
  const kind = ACTION_KINDS.includes(entry.pending) ? entry.pending : null;
  const rows = [row(pick(lang, id('act'), 'act.ph.kind',
    ACTION_KINDS.map((k) => ({ label: t(lang, key(`act.kind.${k}`)), value: k })), kind))];
  if (ROLE_ACTIONS.includes(kind)) {
    rows.push(row(new RoleSelectMenuBuilder().setCustomId(id('prole')).setPlaceholder(t(lang, key('act.ph.role')))
      .setMinValues(1).setMaxValues(1)));
    const targets = userArgNumbers(draft);
    if (targets.length) {
      rows.push(row(pick(lang, id('tgt'), 'act.ph.target', [
        { label: t(lang, key('act.target.none')), value: 'none' },
        ...targets.map((n) => ({ label: t(lang, key('act.target.n'), { n }), value: String(n) })),
      ], entry.target ? String(entry.target) : 'none')));
    }
  } else if (kind === 'setnick') rows.push(row(btn(lang, id('bnick'), 'act.btn.nick', ButtonStyle.Primary)));
  else if (REACT_ACTIONS.includes(kind)) rows.push(row(btn(lang, id('bemoji'), 'act.btn.emoji', ButtonStyle.Primary)));
  if (draft.actions.length) rows.push(row(pick(lang, id('rmact'), 'act.ph.remove', removeOptions(lang, 'actions', draft.actions))));
  return rows;
}

function randomRows(lang, entry) {
  const { userId, panelId, draft } = entry;
  const id = (action) => builderId(action, userId, panelId);
  const rows = [row(pick(lang, id('rnd'), 'random.ph.kind',
    RANDOM_KINDS.map((k) => ({ label: t(lang, key(`random.kind.${k}`)), value: k }))))];
  const { ranges, choosers, locked } = draft.random;
  const options = [
    ...ranges.map((r, i) => ({ label: lineOf(lang, { random: { ranges: [r], choosers: [], locked: [] } }), value: `r${i}` })),
    ...choosers.map((c, i) => ({ label: lineOf(lang, { random: { ranges: [], choosers: [c], locked: [] } }), value: `c${i}` })),
    ...locked.map((l, i) => ({ label: lineOf(lang, { random: { ranges: [], choosers: [], locked: [l] } }), value: `l${i}` })),
  ];
  if (options.length) rows.push(row(pick(lang, id('rmrnd'), 'random.ph.remove', options.slice(0, 25))));
  return rows;
}

/** The tokens the reply text can use, numbered when there are several: [range], [range2], [choice], [lockedchoice]. */
export function randomTokens(random) {
  const list = (name, count) => Array.from({ length: count }, (_, i) => `[${name}${i === 0 ? '' : i + 1}]`);
  return [...list('range', random.ranges.length), ...list('choice', random.choosers.length), ...list('lockedchoice', random.locked.length)];
}

function pageRows(lang, entry, page) {
  const { userId, panelId, draft } = entry;
  const id = (action) => builderId(action, userId, panelId);
  if (page === 'basics') {
    return [
      row(button(lang, id('trigger'), 'trigger', ButtonStyle.Primary)),
      row(select(lang, id('mode'), 'mode',
        MATCH_MODES.map((m) => ({ label: t(lang, key(`mode.${m}`)), value: m })), draft.matchMode)),
    ];
  }
  if (page === 'reply') {
    const toggle = (action, on, label) => button(lang, id(action), label, on ? ButtonStyle.Success : ButtonStyle.Secondary);
    const rows = [
      row(button(lang, id('text'), 'text', ButtonStyle.Primary), toggle('delete', draft.deleteTrigger, 'delete'), toggle('silent', draft.silent, 'silent'),
        button(lang, id('bembed'), 'embed'), button(lang, id('bdelreply'), 'delreply')),
      row(select(lang, id('dest'), 'dest',
        DESTINATIONS.map((d) => ({ label: t(lang, key(`dest.${d}`)), value: d })), draft.dest)),
    ];
    if (draft.dest === 'channel') {
      rows.push(row(new ChannelSelectMenuBuilder().setCustomId(id('channel')).setPlaceholder(t(lang, key('ph.channel')))
        .setChannelTypes(ChannelType.GuildText).setMinValues(1).setMaxValues(1)));
    }
    return rows;
  }
  if (page === 'conditions') return conditionRows(lang, entry);
  if (page === 'actions') return actionRows(lang, entry);
  if (page === 'random') return randomRows(lang, entry);
  const tail = [button(lang, id('save'), 'save', ButtonStyle.Success), button(lang, id('cancel'), 'cancel', ButtonStyle.Danger)];
  const head = [button(lang, id('btry'), 'try'), button(lang, id('bscript'), 'script')];
  // Script mode keeps Basics reachable for the trigger and match mode.
  return [row(...head, ...(draft.mode === 'script' ? [btn(lang, id('bbasics'), 'page.basics')] : []), ...tail)];
}

// The embed picker: no embed, a plain colour, then saved embeds by index into entry.embedNames (the list read when the view opened).
function embedView(lang, entry) {
  const id = (action, extra) => builderId(action, entry.userId, entry.panelId, extra);
  const names = entry.embedNames ?? [];
  const options = [
    { label: t(lang, key('embed.none')), value: 'none' },
    { label: t(lang, key('embed.plain')), value: 'plain' },
    ...names.slice(0, MAX_EMBED_OPTIONS).map((name, index) => ({ label: name.slice(0, MAX_LABEL), value: `n${index}` })),
  ];
  const lines = [t(lang, key('head'), { page: t(lang, key('page.embed')) }), ...summaryLines(lang, entry.draft)];
  if (names.length > MAX_EMBED_OPTIONS) lines.push(t(lang, key('embed.more'), { shown: MAX_EMBED_OPTIONS, total: names.length }));
  return {
    content: fitLines(lang, lines, CONTENT_LIMIT),
    components: [row(pick(lang, id('embed'), 'ph.embed', options)), row(btn(lang, id('bback', 'reply'), 'btn.back'))],
    allowedMentions: { parse: [] },
  };
}

// Script mode: only Review (and Basics for the trigger) exist; the summary is the script in a code block that is
// clipped, with a note, so the whole message fits.
function scriptPayload(lang, entry) {
  const page = entry.page === 'basics' ? 'basics' : 'review';
  const [triggerLine, label] = summaryLines(lang, entry.draft);
  const fixed = [t(lang, key('head'), { page: t(lang, key(`page.${page}`)) }), triggerLine, label].join('\n');
  const code = String(entry.draft.scriptText).replace(/`/g, "'");
  const block = (text) => `\n\`\`\`\n${text}\n\`\`\``;
  let content = fixed + block(code);
  if (content.length > CONTENT_LIMIT) {
    const note = t(lang, key('sum.scriptClipped'));
    const room = CONTENT_LIMIT - fixed.length - block('').length - note.length - 1;
    content = `${fixed}${block(`${code.slice(0, Math.max(0, room - 1))}…`)}\n${note}`;
  }
  const rows = pageRows(lang, entry, page);
  if (page === 'basics') rows.push(row(btn(lang, builderId('bback', entry.userId, entry.panelId, 'review'), 'btn.back')));
  return { content, components: rows, allowedMentions: { parse: [] } };
}

function randomNote(lang, draft) {
  const tokens = randomTokens(draft.random);
  return tokens.length ? t(lang, key('random.note'), { tokens: tokens.join(', ') }) : t(lang, key('random.note.none'));
}

/** { content, components, allowedMentions } for the entry's current page. */
export function panelPayload(lang, entry) {
  if (entry.draft.mode === 'script') return scriptPayload(lang, entry);
  if (entry.page === 'embed') return embedView(lang, entry);
  const page = pageOf(entry);
  const nav = select(lang, builderId('nav', entry.userId, entry.panelId), 'nav',
    PAGES.map((p) => ({ label: t(lang, key(`page.${p}`)), value: p })), page);
  const head = t(lang, key('head'), { page: t(lang, key(`page.${page}`)) });
  return {
    content: fitLines(lang, [head, ...summaryLines(lang, entry.draft), ...(page === 'random' ? [randomNote(lang, entry.draft)] : [])], CONTENT_LIMIT),
    components: [row(nav), ...pageRows(lang, entry, page)],
    allowedMentions: { parse: [] },
  };
}

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
export const PAGES = ['basics', 'reply', 'conditions', 'actions', 'review'];
export const DESTINATIONS = ['reply', 'dm', 'channel'];

export const GATE_KINDS = ['cooldown', 'requirerole', 'denyrole', 'requireperm', 'denyperm', 'requirechannel', 'denychannel', 'requireuser'];
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
function removeOptions(lang, field, items) {
  return items.slice(0, MAX_GATES).map((item, index) => {
    const lines = summaryLines(lang, { ...newDraft(), [field]: [item] });
    return { label: lines.at(-1).slice(0, MAX_LABEL), value: String(index) };
  });
}

function conditionRows(lang, entry) {
  const { userId, panelId, draft } = entry;
  const id = (action) => builderId(action, userId, panelId);
  const kind = GATE_KINDS.includes(entry.pending) ? entry.pending : null;
  const rows = [row(pick(lang, id('cond'), 'cond.ph.kind',
    GATE_KINDS.map((k) => ({ label: t(lang, key(`cond.kind.${k}`)), value: k })), kind))];
  if (kind === 'cooldown') rows.push(row(btn(lang, id('bcool'), 'cond.btn.cooldown', ButtonStyle.Primary)));
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
  if (draft.gates.length) rows.push(row(pick(lang, id('rmgate'), 'cond.ph.remove', removeOptions(lang, 'gates', draft.gates))));
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
  } else if (kind === 'setnick') rows.push(row(btn(lang, id('bnick'), 'act.btn.nick', ButtonStyle.Primary)));
  else if (REACT_ACTIONS.includes(kind)) rows.push(row(btn(lang, id('bemoji'), 'act.btn.emoji', ButtonStyle.Primary)));
  if (draft.actions.length) rows.push(row(pick(lang, id('rmact'), 'act.ph.remove', removeOptions(lang, 'actions', draft.actions))));
  return rows;
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
      row(button(lang, id('text'), 'text', ButtonStyle.Primary), toggle('delete', draft.deleteTrigger, 'delete'), toggle('silent', draft.silent, 'silent')),
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
  return [row(button(lang, id('save'), 'save', ButtonStyle.Success), button(lang, id('cancel'), 'cancel', ButtonStyle.Danger))];
}

/** { content, components, allowedMentions } for the entry's current page. */
export function panelPayload(lang, entry) {
  const page = pageOf(entry);
  const nav = select(lang, builderId('nav', entry.userId, entry.panelId), 'nav',
    PAGES.map((p) => ({ label: t(lang, key(`page.${p}`)), value: p })), page);
  const head = t(lang, key('head'), { page: t(lang, key(`page.${page}`)) });
  return {
    content: fitLines(lang, [head, ...summaryLines(lang, entry.draft)], CONTENT_LIMIT),
    components: [row(nav), ...pageRows(lang, entry, page)],
    allowedMentions: { parse: [] },
  };
}

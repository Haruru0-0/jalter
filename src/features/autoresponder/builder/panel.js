// The builder panel: custom ids and the message payload for each page.
import {
  ActionRowBuilder, ButtonBuilder, ButtonStyle, ChannelSelectMenuBuilder, ChannelType, StringSelectMenuBuilder,
} from 'discord.js';
import { t } from '../../../i18n/index.js';
import { fitLines } from '../../reactionroles/setup.js';
import { MATCH_MODES } from '../match.js';
import { summaryLines } from './summary.js';

const CONTENT_LIMIT = 2000;
const key = (k) => `autoresponder.builder.${k}`;

// Later tasks insert their pages before `review`, which stays last.
export const PAGES = ['basics', 'reply', 'review'];
export const DESTINATIONS = ['reply', 'dm', 'channel'];

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

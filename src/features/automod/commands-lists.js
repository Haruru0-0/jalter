import { t } from '../../i18n/index.js';
import { capList } from '../../core/lists.js';
import { addToList, removeFromList, RULES } from './config.js';
import { listHistory } from './history.js';
import { effectiveWords } from './detect-words.js';
import { normalizeText } from './normalize.js';
import { reply } from './commands.js';

const WORD_MIN = 2;
const WORD_MAX = 100;
const LIST_TEXT_MAX = 350;
const HISTORY_LIMIT = 10;
const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const TLD = /^(?:[a-z]{2,}|xn--[a-z0-9-]+)$/;

/** Lowercased domain, or null when it is not a plain hostname (no scheme, path, port or userinfo). */
export function cleanDomain(raw) {
  const v = String(raw ?? '').trim().toLowerCase();
  if (!v || v.length > 253) return null;
  const labels = v.split('.');
  if (labels.length < 2 || !labels.every((l) => LABEL.test(l)) || !TLD.test(labels.at(-1))) return null;
  return v;
}

const cleanServerId = (raw) => {
  const v = String(raw ?? '').trim();
  return /^\d{17,20}$/.test(v) ? v : null;
};

/** Normalised word, or null when it is empty or outside 2-100 characters. */
export function cleanWord(raw) {
  const v = normalizeText(String(raw ?? '')).trim();
  return v.length >= WORD_MIN && v.length <= WORD_MAX ? v : null;
}

const builtinWords = () => effectiveWords({ useBuiltin: true, removedBuiltin: [], custom: [] });

/** Adds the lists, exemptions and history subcommands to the /automod builder. */
export function extendWithLists(builder) {
  const word = (o) => o.setName('word').setDescription('The word or phrase').setMaxLength(200).setRequired(true);
  const pattern = (o) => o.setName('pattern').setDescription('A regular expression, up to 250 characters')
    .setMaxLength(250).setRequired(true);
  const type = (o) => o.setName('type').setDescription('Links or invites').setRequired(true)
    .addChoices({ name: 'links', value: 'links' }, { name: 'invites', value: 'invites' });
  const state = (o) => o.setName('state').setDescription('On or off').setRequired(true)
    .addChoices({ name: 'on', value: 'on' }, { name: 'off', value: 'off' });
  return builder
    .addSubcommandGroup((g) => g.setName('exempt').setDescription('Roles and channels auto-mod ignores')
      .addSubcommand((s) => s.setName('add-role').setDescription('Exempt a role')
        .addRoleOption((o) => o.setName('role').setDescription('The role').setRequired(true)))
      .addSubcommand((s) => s.setName('remove-role').setDescription('Remove a role exemption')
        .addRoleOption((o) => o.setName('role').setDescription('The role').setRequired(true)))
      .addSubcommand((s) => s.setName('add-channel').setDescription('Exempt a channel')
        .addChannelOption((o) => o.setName('channel').setDescription('The channel').setRequired(true)))
      .addSubcommand((s) => s.setName('remove-channel').setDescription('Remove a channel exemption')
        .addChannelOption((o) => o.setName('channel').setDescription('The channel').setRequired(true))))
    .addSubcommandGroup((g) => g.setName('words').setDescription('The banned words list')
      .addSubcommand((s) => s.setName('add').setDescription('Add a custom banned word').addStringOption(word))
      .addSubcommand((s) => s.setName('remove').setDescription('Remove a custom banned word').addStringOption(word))
      .addSubcommand((s) => s.setName('builtin-remove').setDescription('Stop banning a built-in word').addStringOption(word))
      .addSubcommand((s) => s.setName('builtin-restore').setDescription('Ban a removed built-in word again').addStringOption(word))
      .addSubcommand((s) => s.setName('builtin').setDescription('Use the built-in word list or not').addStringOption(state))
      .addSubcommand((s) => s.setName('list').setDescription('Show custom words and removed built-in words')))
    .addSubcommandGroup((g) => g.setName('patterns').setDescription('Regex patterns the words rule also matches')
      .addSubcommand((s) => s.setName('add').setDescription('Add a regex pattern').addStringOption(pattern))
      .addSubcommand((s) => s.setName('remove').setDescription('Remove a regex pattern').addStringOption(pattern))
      .addSubcommand((s) => s.setName('list').setDescription('Show the regex patterns')))
    .addSubcommand((s) => s.setName('domains').setDescription('Manage allowed and blocked links or invite servers')
      .addStringOption(type)
      .addStringOption((o) => o.setName('list').setDescription('Allow list or block list').setRequired(true)
        .addChoices({ name: 'allow', value: 'allow' }, { name: 'block', value: 'block' }))
      .addStringOption((o) => o.setName('action').setDescription('Add or remove').setRequired(true)
        .addChoices({ name: 'add', value: 'add' }, { name: 'remove', value: 'remove' }))
      .addStringOption((o) => o.setName('value').setDescription('A domain like example.com, or a server id')
        .setMaxLength(253).setRequired(true)))
    .addSubcommand((s) => s.setName('mode').setDescription('Block everything except the allow list')
      .addStringOption(type).addStringOption(state))
    .addSubcommand((s) => s.setName('history').setDescription('Show recent auto-mod actions')
      .addUserOption((o) => o.setName('user').setDescription('Only this member')));
}

const failText = (lang, reason) => t(lang, `automod.lists.${['exists', 'missing', 'full'].includes(reason) ? reason : 'invalid'}`);

/** Runs a list change and replies with `okKey` or the localized failure reason. */
async function change(i, { lang, config, save }, mutate, path, value, okKey, vars) {
  const result = mutate(config, path, value);
  if (!result.ok) return reply(i, failText(lang, result.reason));
  await save(result.config);
  return reply(i, t(lang, okKey, vars));
}

function exemptHandler(path, mutate, okKey, read, mention) {
  return (i, args) => {
    const item = read(i);
    if (path === 'exemptRoles' && mutate === addToList && item.id === i.guildId) {
      return reply(i, t(args.lang, 'automod.lists.everyone'));
    }
    return change(i, args, mutate, path, item.id, okKey, { item: mention(item.id) });
  };
}

const role = (i) => i.options.getRole('role', true);
const channel = (i) => i.options.getChannel('channel', true);
const roleMention = (id) => `<@&${id}>`;
const channelMention = (id) => `<#${id}>`;

const wordHandler = (mutate, path, okKey, extra) => async (i, args) => {
  const word = cleanWord(i.options.getString('word', true));
  if (!word) return reply(i, t(args.lang, 'automod.lists.bad_word'));
  if (extra && !extra(word)) return reply(i, t(args.lang, 'automod.lists.not_builtin'));
  return change(i, args, mutate, path, word, okKey, { word });
};

const wordList = (items, lang) => capList(items.map((w) => `\`${w.replaceAll('`', "'")}\``), {
  max: LIST_TEXT_MAX, more: (count) => t(lang, 'automod.lists.more', { count }),
});

const patternFail = (lang, reason) => t(lang, ['too_long', 'invalid', 'exists', 'full'].includes(reason)
  ? `automod.patterns.${reason}` : 'automod.lists.missing');

const patternHandler = (mutate, okKey) => async (i, args) => {
  const pattern = i.options.getString('pattern', true);
  const result = mutate(args.config, 'words.patterns', pattern);
  if (!result.ok) return reply(i, patternFail(args.lang, result.reason));
  await args.save(result.config);
  return reply(i, t(args.lang, okKey, { pattern: pattern.replaceAll('`', "'") }));
};

const ruleName = (lang, r) => (RULES.includes(r) ? t(lang, `automod.rule.${r}`) : String(r));

export const listGroupHandlers = {
  exempt: {
    'add-role': exemptHandler('exemptRoles', addToList, 'automod.lists.role_added', role, roleMention),
    'remove-role': exemptHandler('exemptRoles', removeFromList, 'automod.lists.role_removed', role, roleMention),
    'add-channel': exemptHandler('exemptChannels', addToList, 'automod.lists.channel_added', channel, channelMention),
    'remove-channel': exemptHandler('exemptChannels', removeFromList, 'automod.lists.channel_removed', channel, channelMention),
  },
  words: {
    add: wordHandler(addToList, 'words.custom', 'automod.lists.word_added'),
    remove: wordHandler(removeFromList, 'words.custom', 'automod.lists.word_removed'),
    'builtin-remove': wordHandler(addToList, 'words.removedBuiltin', 'automod.lists.builtin_removed', (w) => builtinWords().includes(w)),
    'builtin-restore': wordHandler(removeFromList, 'words.removedBuiltin', 'automod.lists.builtin_restored'),

    async builtin(i, { lang, config, save }) {
      const on = i.options.getString('state', true) === 'on';
      const words = { ...config.rules.words, useBuiltin: on };
      await save({ ...config, rules: { ...config.rules, words } });
      return reply(i, t(lang, on ? 'automod.lists.builtin_on' : 'automod.lists.builtin_off'));
    },

    list(i, { lang, config }) {
      const { custom, removedBuiltin, useBuiltin } = config.rules.words;
      const none = t(lang, 'automod.lists.none');
      return reply(i, [
        `**${t(lang, 'automod.lists.words_title')}**`,
        t(lang, 'automod.lists.words_custom', { count: custom.length, words: custom.length ? wordList(custom, lang) : none }),
        t(lang, 'automod.lists.words_removed', { count: removedBuiltin.length, words: removedBuiltin.length ? wordList(removedBuiltin, lang) : none }),
        t(lang, 'automod.lists.words_builtin', {
          count: builtinWords().length,
          state: t(lang, useBuiltin ? 'common.on' : 'common.off'),
        }),
      ].join('\n'));
    },
  },
  patterns: {
    add: patternHandler(addToList, 'automod.patterns.added'),
    remove: patternHandler(removeFromList, 'automod.patterns.removed'),

    list(i, { lang, config }) {
      const { patterns } = config.rules.words;
      return reply(i, [
        `**${t(lang, 'automod.patterns.title')}**`,
        t(lang, 'automod.patterns.count', { count: patterns.length, patterns: patterns.length ? wordList(patterns, lang) : t(lang, 'automod.lists.none') }),
      ].join('\n'));
    },
  },
};

export const listHandlers = {
  async domains(i, args) {
    const { lang } = args;
    const type = i.options.getString('type', true);
    const list = i.options.getString('list', true);
    const adding = i.options.getString('action', true) === 'add';
    if (!['links', 'invites'].includes(type) || !['allow', 'block'].includes(list)) {
      return reply(i, t(lang, 'automod.lists.invalid'));
    }
    const raw = i.options.getString('value', true);
    const value = type === 'invites' ? cleanServerId(raw) : cleanDomain(raw);
    if (!value) return reply(i, t(lang, type === 'invites' ? 'automod.lists.bad_server' : 'automod.lists.bad_domain'));
    return change(i, args, adding ? addToList : removeFromList, `${type}.${list}`, value,
      adding ? 'automod.lists.domain_added' : 'automod.lists.domain_removed',
      { value, rule: ruleName(lang, type), list: t(lang, `automod.lists.name_${list}`) });
  },

  async mode(i, { lang, config, save }) {
    const type = i.options.getString('type', true);
    const on = i.options.getString('state', true) === 'on';
    if (!['links', 'invites'].includes(type)) return reply(i, t(lang, 'automod.lists.invalid'));
    const rules = { ...config.rules, [type]: { ...config.rules[type], blockAllExceptAllowed: on } };
    await save({ ...config, rules });
    return reply(i, t(lang, on ? 'automod.lists.mode_on' : 'automod.lists.mode_off', { rule: ruleName(lang, type) }));
  },

  async history(i, { ctx, lang }) {
    const user = i.options.getUser('user');
    const rows = await listHistory(ctx.db, i.guildId, { userId: user?.id ?? null, limit: HISTORY_LIMIT });
    if (rows.length === 0) return reply(i, t(lang, 'automod.history.empty'));
    const lines = rows.map((r) => t(lang, 'automod.history.line', {
      user: `<@${r.userId}>`,
      rules: (Array.isArray(r.rules) ? r.rules : []).map((x) => ruleName(lang, x)).join(', ') || '-',
      actions: (Array.isArray(r.actions) ? r.actions : []).join(', ') || '-',
      case: r.caseNumber == null ? '-' : `#${r.caseNumber}`,
      time: `<t:${Math.floor(new Date(r.createdAt).getTime() / 1000)}:R>`,
    }));
    return reply(i, [`**${t(lang, 'automod.history.title')}**`, ...lines].join('\n'));
  },
};

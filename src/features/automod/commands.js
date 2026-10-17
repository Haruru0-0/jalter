import { SlashCommandBuilder, ChannelType } from 'discord.js';
import { getFeature, setFeature } from '../../db/settings.js';
import { guard } from '../../core/guard.js';
import { handleToggle, toggleSubcommands } from '../../core/toggle.js';
import { ephemeral } from '../../core/replies.js';
import { parseDuration, formatDuration } from '../../core/duration.js';
import { capList } from '../../core/lists.js';
import { t } from '../../i18n/index.js';
import {
  readConfig, setSteps, addToList, removeFromList, MAX_NATIVE_RULES, RULES, SPAM_CHECKS, MAX_STEPS,
  STRIKES_MIN, STRIKES_MAX, WINDOW_MIN, WINDOW_MAX, TIMEOUT_MIN, TIMEOUT_MAX, AGE_MIN, AGE_MAX, ROLE_MIN, ROLE_MAX,
} from './config.js';
import { botCanGive, isDangerousRole, callerCanGive } from '../../core/role-safety.js';
import { listNativeRules } from './native.js';

const SPAM_NAMES = Object.keys(SPAM_CHECKS);
/** The primary number of each spam check, which /automod spam-limit sets. */
const PRIMARY = { burst: 'messages', identical: 'count', caps: 'percent', emoji: 'max', mentions: 'max', attachments: 'count', linkRate: 'count' };

/**
 * Parses `3:warn,5:timeout:10m,8:timeout:1d`. Returns { ok, steps } or { ok: false, reason }.
 * Timeout length is optional (the config default applies); warn takes no length.
 */
export function parseSteps(text) {
  const parts = String(text ?? '').split(',').map((p) => p.trim());
  if (parts.length === 0 || parts.length > MAX_STEPS || parts.some((p) => p === '')) return { ok: false, reason: 'count' };
  const seen = new Set();
  const steps = [];
  for (const part of parts) {
    const [strikesText, action, length, ...rest] = part.split(':').map((p) => p.trim());
    if (rest.length || !/^\d+$/.test(strikesText ?? '')) return { ok: false, reason: 'format' };
    const strikes = Number(strikesText);
    if (strikes < STRIKES_MIN || strikes > STRIKES_MAX) return { ok: false, reason: 'strikes' };
    if (seen.has(strikes)) return { ok: false, reason: 'duplicate' };
    seen.add(strikes);
    if (action === 'warn') {
      if (length !== undefined) return { ok: false, reason: 'format' };
      steps.push({ strikes, action: 'warn', timeoutSeconds: null });
    } else if (action === 'timeout') {
      let seconds = null;
      if (length !== undefined) {
        seconds = parseDuration(length);
        if (seconds === null || seconds < TIMEOUT_MIN || seconds > TIMEOUT_MAX) return { ok: false, reason: 'timeout' };
      }
      steps.push({ strikes, action: 'timeout', timeoutSeconds: seconds });
    } else {
      return { ok: false, reason: 'action' };
    }
  }
  return { ok: true, steps };
}

const stateOption = (o) =>
  o.setName('state').setDescription('On or off').setRequired(true)
    .addChoices({ name: 'on', value: 'on' }, { name: 'off', value: 'off' });
const ruleOption = (o) =>
  o.setName('rule').setDescription('The rule').setRequired(true)
    .addChoices(...RULES.map((r) => ({ name: r, value: r })));
const nativeIdOption = (o) =>
  o.setName('id').setDescription('The AutoMod rule id (see /automod native list)').setMaxLength(32).setRequired(true);
const checkOption = (o) =>
  o.setName('check').setDescription('The spam check').setRequired(true)
    .addChoices(...SPAM_NAMES.map((c) => ({ name: c, value: c })));

/** Adds the settings subcommands to the builder. */
export function addSettingsSubcommands(builder) {
  return toggleSubcommands(builder)
    .addSubcommand((s) => s.setName('status').setDescription('Show the auto-mod settings'))
    .addSubcommand((s) =>
      s.setName('rule').setDescription('Turn a rule on or off').addStringOption(ruleOption).addStringOption(stateOption))
    .addSubcommand((s) =>
      s.setName('delete').setDescription('Delete offending messages for a rule')
        .addStringOption(ruleOption).addStringOption(stateOption))
    .addSubcommand((s) =>
      s.setName('steps').setDescription('Set what happens at each strike count for a rule')
        .addStringOption(ruleOption)
        .addStringOption((o) =>
          o.setName('steps').setDescription('For example 3:warn,5:timeout:10m,8:timeout:1d')
            .setMaxLength(200).setRequired(true)))
    .addSubcommand((s) =>
      s.setName('window').setDescription('Set how long strikes are counted for a rule')
        .addStringOption(ruleOption)
        .addStringOption((o) =>
          o.setName('duration').setDescription('For example 10m or 1h (10 seconds to 1 day)')
            .setMaxLength(32).setRequired(true)))
    .addSubcommand((s) =>
      s.setName('spam-check').setDescription('Turn a spam check on or off')
        .addStringOption(checkOption).addStringOption(stateOption))
    .addSubcommand((s) =>
      s.setName('spam-limit').setDescription('Set the main limit of a spam check')
        .addStringOption(checkOption)
        .addIntegerOption((o) =>
          o.setName('value').setDescription('The new limit').setMinValue(1).setMaxValue(100).setRequired(true)))
    .addSubcommand((s) =>
      s.setName('nickname').setDescription('Check member names for banned words')
        .addStringOption(stateOption))
    .addSubcommand((s) =>
      s.setName('age').setDescription('Limit a rule to new accounts or recent joiners')
        .addStringOption(ruleOption)
        .addStringOption((o) =>
          o.setName('kind').setDescription('Which age to limit').setRequired(true)
            .addChoices({ name: 'account', value: 'account' }, { name: 'joined', value: 'joined' }))
        .addStringOption((o) =>
          o.setName('duration').setDescription('For example 7d or 1h, or off to clear the limit')
            .setMaxLength(32).setRequired(true)))
    .addSubcommand((s) =>
      s.setName('role').setDescription('Give a role for a while when a rule takes action')
        .addStringOption(ruleOption)
        .addRoleOption((o) => o.setName('role').setDescription('The role to give'))
        .addBooleanOption((o) => o.setName('off').setDescription('Stop giving a role'))
        .addStringOption((o) =>
          o.setName('duration').setDescription('How long they keep it, like 10m or 1d (1 minute to 7 days)')
            .setMaxLength(32)))
    .addSubcommand((s) =>
      s.setName('honeypot').setDescription('Punish anyone who posts in a trap channel')
        .addChannelOption((o) =>
          o.setName('channel').setDescription('The trap channel')
            .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement))
        .addBooleanOption((o) => o.setName('off').setDescription('Stop using a trap channel')))
    .addSubcommandGroup((g) => g.setName('native').setDescription('React to the rules of Discord AutoMod')
      .addSubcommand((s) => s.setName('list').setDescription('Show the AutoMod rules of this server'))
      .addSubcommand((s) => s.setName('add-rule').setDescription('React only to this AutoMod rule')
        .addStringOption(nativeIdOption))
      .addSubcommand((s) => s.setName('remove-rule').setDescription('Stop reacting to this AutoMod rule')
        .addStringOption(nativeIdOption)));
}

export const reply = (interaction, content) => {
  const payload = ephemeral({ content, allowedMentions: { parse: [] } });
  return interaction.deferred || interaction.replied ? interaction.editReply(payload) : interaction.reply(payload);
};

const withRule = (config, rule, patch) => ({
  ...config,
  rules: { ...config.rules, [rule]: { ...config.rules[rule], ...patch } },
});

const stepText = (lang, s) => (s.action === 'warn'
  ? t(lang, 'automod.settings.step_warn', { strikes: s.strikes })
  : t(lang, 'automod.settings.step_timeout', { strikes: s.strikes, duration: formatDuration(s.timeoutSeconds) }));

const STATUS_MAX = 1900;
const EXEMPT_CAP = 120;
const ENTRY_CAP = 80;

export function statusText(lang, enabled, config) {
  const onOff = (v) => t(lang, v ? 'common.on' : 'common.off');
  const lines = [
    `**${t(lang, 'automod.settings.status_title')}**`,
    t(lang, enabled ? 'automod.settings.status_on' : 'automod.settings.status_off'),
  ];
  const none = t(lang, 'automod.settings.none');
  const listOf = (items, max) => (items.length
    ? capList(items, { max, more: (count) => t(lang, 'common.more', { count }) })
    : none);
  lines.push(t(lang, 'automod.settings.exempt_roles', { list: listOf(config.exemptRoles.map((id) => `<@&${id}>`), EXEMPT_CAP) }));
  lines.push(t(lang, 'automod.settings.exempt_channels', { list: listOf(config.exemptChannels.map((id) => `<#${id}>`), EXEMPT_CAP) }));
  for (const rule of RULES) {
    const r = config.rules[rule];
    lines.push(`**${t(lang, `automod.rule.${rule}`)}**: ${onOff(r.enabled)}`);
    lines.push(t(lang, 'automod.settings.rule_line', {
      delete: onOff(r.delete),
      window: formatDuration(r.windowSeconds),
      steps: r.steps.map((s) => stepText(lang, s)).join(', '),
    }));
    const { accountYoungerThanSeconds: account, joinedWithinSeconds: joined } = r.age;
    if (account !== null || joined !== null) {
      lines.push(t(lang, 'automod.settings.age_line', {
        account: account === null ? none : formatDuration(account),
        joined: joined === null ? none : formatDuration(joined),
      }));
    }
    if (r.giveRole.roleId) {
      lines.push(t(lang, 'automod.settings.role_line', { role: `<@&${r.giveRole.roleId}>`, duration: formatDuration(r.giveRole.seconds) }));
    }
    if (rule === 'spam') {
      for (const name of SPAM_NAMES) {
        const c = r[name];
        lines.push(`${name}: ${onOff(c.enabled)} (${t(lang, `automod.settings.limit_${name}`, c)})`);
      }
    }
    if (rule === 'honeypot') {
      lines.push(t(lang, 'automod.settings.honeypot_line', { channel: r.channelId ? `<#${r.channelId}>` : none }));
    }
    if (rule === 'native') {
      lines.push(t(lang, 'automod.settings.native_line', { rules: r.ruleIds.length ? r.ruleIds.join(', ') : t(lang, 'automod.settings.native_all') }));
    }
    if (rule === 'links' || rule === 'invites') {
      lines.push(t(lang, r.blockAllExceptAllowed ? 'automod.settings.mode_allowlist' : 'automod.settings.mode_blocklist'));
      lines.push(t(lang, 'automod.settings.allow_line', { count: r.allow.length, list: listOf(r.allow, ENTRY_CAP) }));
      lines.push(t(lang, 'automod.settings.block_line', { count: r.block.length, list: listOf(r.block, ENTRY_CAP) }));
    }
  }
  lines.push(`**${t(lang, 'automod.settings.nickname')}**: ${onOff(config.nickname.enabled)}`);
  const out = lines.join('\n');
  return out.length > STATUS_MAX ? `${out.slice(0, STATUS_MAX - 1)}…` : out;
}

/** Each handler gets (interaction, { ctx, lang, enabled, config, save }) and replies. */
export const settingsHandlers = {
  status: (i, { lang, enabled, config }) => reply(i, statusText(lang, enabled, config)),

  async rule(i, { lang, config, save }) {
    const rule = i.options.getString('rule', true);
    const on = i.options.getString('state', true) === 'on';
    if (!RULES.includes(rule)) return reply(i, t(lang, 'automod.settings.bad_rule'));
    await save(withRule(config, rule, { enabled: on }));
    return reply(i, t(lang, on ? 'automod.settings.rule_on' : 'automod.settings.rule_off', { rule: t(lang, `automod.rule.${rule}`) }));
  },

  async delete(i, { lang, config, save }) {
    const rule = i.options.getString('rule', true);
    const on = i.options.getString('state', true) === 'on';
    if (!RULES.includes(rule)) return reply(i, t(lang, 'automod.settings.bad_rule'));
    await save(withRule(config, rule, { delete: on }));
    return reply(i, t(lang, on ? 'automod.settings.delete_on' : 'automod.settings.delete_off', { rule: t(lang, `automod.rule.${rule}`) }));
  },

  async steps(i, { lang, config, save }) {
    const rule = i.options.getString('rule', true);
    const parsed = parseSteps(i.options.getString('steps', true));
    if (!RULES.includes(rule) || !parsed.ok) return reply(i, t(lang, 'automod.settings.bad_steps'));
    const result = setSteps(config, rule, parsed.steps);
    if (!result.ok) return reply(i, t(lang, 'automod.settings.bad_steps'));
    await save(result.config);
    const steps = result.config.rules[rule].steps.map((s) => stepText(lang, s)).join(', ');
    return reply(i, t(lang, 'automod.settings.steps_set', { rule: t(lang, `automod.rule.${rule}`), steps }));
  },

  async window(i, { lang, config, save }) {
    const rule = i.options.getString('rule', true);
    const seconds = parseDuration(i.options.getString('duration', true));
    if (!RULES.includes(rule) || seconds === null || seconds < WINDOW_MIN || seconds > WINDOW_MAX) {
      return reply(i, t(lang, 'automod.settings.bad_window'));
    }
    await save(withRule(config, rule, { windowSeconds: seconds }));
    return reply(i, t(lang, 'automod.settings.window_set', { rule: t(lang, `automod.rule.${rule}`), duration: formatDuration(seconds) }));
  },

  async 'spam-check'(i, { lang, config, save }) {
    const check = i.options.getString('check', true);
    const on = i.options.getString('state', true) === 'on';
    if (!SPAM_NAMES.includes(check)) return reply(i, t(lang, 'automod.settings.bad_check'));
    await save(withRule(config, 'spam', { [check]: { ...config.rules.spam[check], enabled: on } }));
    return reply(i, t(lang, on ? 'automod.settings.check_on' : 'automod.settings.check_off', { check }));
  },

  async 'spam-limit'(i, { lang, config, save }) {
    const check = i.options.getString('check', true);
    const value = i.options.getInteger('value', true);
    if (!SPAM_NAMES.includes(check)) return reply(i, t(lang, 'automod.settings.bad_check'));
    const field = PRIMARY[check];
    const [min, max] = SPAM_CHECKS[check][field];
    if (!Number.isInteger(value) || value < min || value > max) {
      return reply(i, t(lang, 'automod.settings.bad_limit', { min, max }));
    }
    await save(withRule(config, 'spam', { [check]: { ...config.rules.spam[check], [field]: value } }));
    return reply(i, t(lang, 'automod.settings.limit_set', { check, value }));
  },

  async age(i, { lang, config, save }) {
    const rule = i.options.getString('rule', true);
    const kind = i.options.getString('kind', true);
    const input = i.options.getString('duration', true).trim().toLowerCase();
    const field = kind === 'account' ? 'accountYoungerThanSeconds' : kind === 'joined' ? 'joinedWithinSeconds' : null;
    const seconds = input === 'off' ? null : parseDuration(input);
    if (!RULES.includes(rule) || !field || (input !== 'off' && (seconds === null || seconds < AGE_MIN || seconds > AGE_MAX))) {
      return reply(i, t(lang, 'automod.settings.bad_age'));
    }
    await save(withRule(config, rule, { age: { ...config.rules[rule].age, [field]: seconds } }));
    const name = t(lang, `automod.rule.${rule}`);
    if (seconds === null) return reply(i, t(lang, `automod.settings.age_${kind}_off`, { rule: name }));
    return reply(i, t(lang, `automod.settings.age_${kind}_set`, { rule: name, duration: formatDuration(seconds) }));
  },

  async role(i, { lang, config, save }) {
    const rule = i.options.getString('rule', true);
    if (!RULES.includes(rule)) return reply(i, t(lang, 'automod.settings.bad_rule'));
    const name = t(lang, `automod.rule.${rule}`);
    const current = config.rules[rule].giveRole;
    if (i.options.getBoolean('off') === true) {
      await save(withRule(config, rule, { giveRole: { ...current, roleId: null } }));
      return reply(i, t(lang, 'automod.settings.role_off', { rule: name }));
    }
    const role = i.options.getRole('role');
    if (!role) return reply(i, t(lang, 'automod.settings.role_missing'));
    const input = i.options.getString('duration');
    const seconds = input === null ? current.seconds : parseDuration(input);
    if (seconds === null || seconds < ROLE_MIN || seconds > ROLE_MAX) return reply(i, t(lang, 'automod.settings.bad_role_duration'));
    if (role.id === i.guildId) return reply(i, t(lang, 'automod.settings.role_everyone'));
    if (role.managed) return reply(i, t(lang, 'automod.settings.role_managed'));
    if (!botCanGive(i.guild, role)) return reply(i, t(lang, 'automod.settings.role_too_high'));
    if (isDangerousRole(role)) return reply(i, t(lang, 'automod.settings.role_dangerous'));
    if (!callerCanGive(i.guild, i.member, role)) return reply(i, t(lang, 'automod.settings.role_above_you'));
    await save(withRule(config, rule, { giveRole: { roleId: role.id, seconds } }));
    return reply(i, t(lang, 'automod.settings.role_set', { rule: name, role: `<@&${role.id}>`, duration: formatDuration(seconds) }));
  },

  async honeypot(i, { lang, config, save }) {
    if (i.options.getBoolean('off') === true) {
      await save(withRule(config, 'honeypot', { channelId: null }));
      return reply(i, t(lang, 'automod.settings.honeypot_off'));
    }
    const channel = i.options.getChannel('channel');
    if (!channel) return reply(i, t(lang, 'automod.settings.honeypot_missing'));
    // The bot must see the channel and be able to delete what lands in it.
    const perms = channel.permissionsFor?.(i.guild?.members?.me);
    if (!perms?.has('ViewChannel') || !perms.has('ManageMessages')) return reply(i, t(lang, 'automod.settings.honeypot_no_access'));
    await save(withRule(config, 'honeypot', { channelId: channel.id }));
    // An exempt channel (or one under an exempt category) is never checked, so the trap would not fire.
    const exempt = config.exemptChannels.includes(channel.id) || (channel.parentId && config.exemptChannels.includes(channel.parentId));
    const note = exempt ? ` ${t(lang, 'automod.settings.honeypot_exempt')}` : '';
    return reply(i, t(lang, 'automod.settings.honeypot_set', { channel: `<#${channel.id}>` }) + note);
  },

  async nickname(i, { lang, config, save }) {
    const on = i.options.getString('state', true) === 'on';
    await save({ ...config, nickname: { enabled: on } });
    return reply(i, t(lang, on ? 'automod.settings.nickname_on' : 'automod.settings.nickname_off'));
  },
};

const SNOWFLAKE = /^\d{17,20}$/;

/** Handlers of /automod native: each gets (interaction, { lang, config, save }). */
export const nativeHandlers = {
  async list(i, { lang, config }) {
    const rules = await listNativeRules(i.guild);
    if (!rules.length) return reply(i, t(lang, 'automod.native.none'));
    const onOff = (v) => t(lang, v ? 'common.on' : 'common.off');
    const lines = rules.map((r) => t(lang, 'automod.native.line', { id: r.id, name: r.name, state: onOff(r.enabled) }));
    const tracked = config.rules.native.ruleIds;
    const out = [
      `**${t(lang, 'automod.native.title')}**`,
      ...lines,
      t(lang, 'automod.settings.native_line', { rules: tracked.length ? tracked.join(', ') : t(lang, 'automod.settings.native_all') }),
    ].join('\n');
    return reply(i, out.length > STATUS_MAX ? `${out.slice(0, STATUS_MAX - 1)}…` : out);
  },

  async 'add-rule'(i, { lang, config, save }) {
    const id = String(i.options.getString('id', true)).trim();
    if (!SNOWFLAKE.test(id)) return reply(i, t(lang, 'automod.native.bad_id'));
    const result = addToList(config, 'native.ruleIds', id);
    if (!result.ok) {
      return reply(i, t(lang, result.reason === 'exists' ? 'automod.native.exists' : 'automod.native.full', { max: MAX_NATIVE_RULES }));
    }
    await save(result.config);
    return reply(i, t(lang, 'automod.native.added', { id }));
  },

  async 'remove-rule'(i, { lang, config, save }) {
    const id = String(i.options.getString('id', true)).trim();
    if (!SNOWFLAKE.test(id)) return reply(i, t(lang, 'automod.native.bad_id'));
    const result = removeFromList(config, 'native.ruleIds', id);
    if (!result.ok) return reply(i, t(lang, 'automod.native.missing'));
    await save(result.config);
    return reply(i, t(lang, 'automod.native.removed', { id }));
  },
};

/**
 * Builds the /automod command. Task 12 passes `extend` (adds subcommands/groups to the builder)
 * and `handlers` ({ subName: fn }) and/or `groupHandlers` ({ groupName: { subName: fn } }).
 */
export function createAutomodCommand({ extend = (b) => b, handlers = {}, groupHandlers = {} } = {}) {
  const data = extend(addSettingsSubcommands(
    new SlashCommandBuilder().setName('automod').setDescription('Auto-mod settings'),
  ));
  const table = { ...settingsHandlers, ...handlers };
  const groups = { native: nativeHandlers, ...groupHandlers };

  async function execute(interaction, ctx) {
    const sub = interaction.options.getSubcommand();
    const group = interaction.options.getSubcommandGroup?.() ?? null;
    if (!group && (sub === 'enable' || sub === 'disable')) return handleToggle(interaction, ctx, 'automod');
    const lang = await guard(interaction, ctx, 'automod', { requireEnabled: false });
    if (!lang) return;
    const guildId = interaction.guildId;
    const { enabled, config: raw } = await getFeature(ctx.db, guildId, 'automod');
    const config = readConfig(raw);
    const save = (next) => setFeature(ctx.db, guildId, 'automod', { config: readConfig(next) });
    const handler = group ? (Object.hasOwn(groups, group) && Object.hasOwn(groups[group], sub) ? groups[group][sub] : undefined) : Object.hasOwn(table, sub) ? table[sub] : undefined;
    if (!handler) return reply(interaction, t(lang, 'automod.error.generic'));
    return handler(interaction, { ctx, lang, enabled, config, save });
  }

  return { data, execute };
}

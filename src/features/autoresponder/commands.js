import {
  SlashCommandBuilder, ModalBuilder, TextInputBuilder, TextInputStyle, ActionRowBuilder,
} from 'discord.js';
import { guard } from '../../core/guard.js';
import { handleToggle } from '../../core/toggle.js';
import { ephemeral } from '../../core/replies.js';
import { t } from '../../i18n/index.js';
import { fitLines } from '../reactionroles/setup.js';
import { createRule, getRule, listRules, updateRule, deleteRule } from './store.js';
import { invalidate } from './cache.js';
import { clearRuleCooldowns } from './cooldown.js';
import { checkTrigger, chooseRule, MATCH_MODES, MAX_TRIGGER_LENGTH } from './match.js';
import { compileScript, MAX_SCRIPT } from './script/compile.js';
import { logAutoresponder } from './log.js';
import { describeRunFor } from './dryrun.js';
import { openBuilder, handleBuilder } from './builder/handlers.js';
import { handlePress } from './buttons/press.js';
import { BUTTON_HANDLERS, submitButtonModal, STYLE_CHOICES, LIMITATION_CHOICES } from './buttons/setup.js';

const PREFIX = 'autoresponder';
const MAX_ERROR_LINES = 10;
const MAX_REPLY = 2000;
const MAX_TEST_MESSAGE = 1000;

const idOption = (o) => o.setName('id').setDescription('Id of the rule').setMinValue(1).setRequired(true);
const matchOption = (required) => (o) =>
  o.setName('match').setDescription('How the trigger is compared with the message')
    .addChoices(...MATCH_MODES.map((m) => ({ name: m, value: m }))).setRequired(required);

export function buildData() {
  return new SlashCommandBuilder()
    .setName('autoresponder')
    .setDescription('Reply automatically to messages that match a trigger')
    .addSubcommand((s) => s.setName('enable').setDescription('Turn the autoresponder on'))
    .addSubcommand((s) => s.setName('disable').setDescription('Turn the autoresponder off'))
    .addSubcommand((s) => s.setName('add').setDescription('Add a rule').addStringOption(matchOption(false)))
    .addSubcommand((s) => s.setName('edit').setDescription('Edit the trigger and script of a rule').addIntegerOption(idOption))
    .addSubcommand((s) =>
      s.setName('editmatchmode').setDescription('Change how a rule matches').addIntegerOption(idOption).addStringOption(matchOption(true)))
    .addSubcommand((s) => s.setName('toggle').setDescription('Turn one rule on or off').addIntegerOption(idOption))
    .addSubcommand((s) => s.setName('remove').setDescription('Delete a rule').addIntegerOption(idOption))
    .addSubcommand((s) => s.setName('list').setDescription('List the rules'))
    .addSubcommand((s) => s.setName('show').setDescription('Show one rule in detail').addIntegerOption(idOption))
    .addSubcommand((s) =>
      s.setName('test').setDescription('Try a message against the rules without sending anything')
        .addStringOption((o) => o.setName('message').setDescription('What a member would type').setMaxLength(MAX_TEST_MESSAGE).setRequired(true)))
    .addSubcommand((s) => s.setName('builder').setDescription('Build a rule with buttons and menus'))
    .addSubcommandGroup((g) => g.setName('button').setDescription('Manage the buttons that replies can carry')
      .addSubcommand((s) => buttonOptions(s.setName('add').setDescription('Create a button').addStringOption(buttonName)))
      .addSubcommand((s) => buttonOptions(s.setName('edit').setDescription('Edit a button').addStringOption(buttonName)))
      .addSubcommand((s) => s.setName('remove').setDescription('Delete a button').addStringOption(buttonName))
      .addSubcommand((s) => s.setName('list').setDescription('List the buttons')));
}

const buttonName = (o) => o.setName('name').setDescription('Name of the button (a-z, 0-9, _ and -, up to 16)').setMaxLength(16).setRequired(true);
const buttonOptions = (sub) => sub
  .addStringOption((o) => o.setName('style').setDescription('Colour of the button')
    .addChoices(...STYLE_CHOICES.map((c) => ({ name: c, value: c }))))
  .addBooleanOption((o) => o.setName('invoker_only').setDescription('Only the member who triggered the reply can press it'))
  .addStringOption((o) => o.setName('limitations').setDescription('How many presses are allowed per message')
    .addChoices(...LIMITATION_CHOICES.map((c) => ({ name: c, value: c }))));

const state = (lang, enabled) => t(lang, enabled ? 'common.on' : 'common.off');
const oneLine = (s) => String(s).replace(/\s+/g, ' ');

// Replies "gone" and returns null when the id is unknown or belongs to another server.
async function loadRule(interaction, ctx, lang) {
  const rule = await getRule(ctx.db, interaction.guildId, interaction.options.getInteger('id'));
  if (!rule) await interaction.reply(ephemeral(t(lang, 'autoresponder.gone')));
  return rule;
}

const modalFor = (lang, customId, { trigger = '', script = '' } = {}) => {
  const trig = new TextInputBuilder().setCustomId('trigger').setLabel(t(lang, 'autoresponder.modal.trigger'))
    .setStyle(TextInputStyle.Short).setMaxLength(MAX_TRIGGER_LENGTH).setRequired(true);
  const body = new TextInputBuilder().setCustomId('script').setLabel(t(lang, 'autoresponder.modal.script'))
    .setStyle(TextInputStyle.Paragraph).setMaxLength(MAX_SCRIPT).setRequired(true);
  if (trigger) trig.setValue(trigger);
  if (script) body.setValue(script);
  return new ModalBuilder().setCustomId(customId).setTitle(t(lang, 'autoresponder.modal.title'))
    .addComponents(new ActionRowBuilder().addComponents(trig), new ActionRowBuilder().addComponents(body));
};

export const log = (ctx, interaction, lang, action, ruleId, detail) =>
  logAutoresponder(ctx, interaction.guild, lang, { action: t(lang, `autoresponder.action.${action}`), actorId: interaction.user.id, ruleId, detail });

async function add(interaction, ctx, lang) {
  const match = interaction.options.getString('match') ?? 'exact';
  return interaction.showModal(modalFor(lang, `${PREFIX}:m:add:${match}`));
}

async function edit(interaction, ctx, lang) {
  const rule = await loadRule(interaction, ctx, lang);
  if (!rule) return;
  return interaction.showModal(modalFor(lang, `${PREFIX}:m:edit:${rule.id}`, rule));
}

async function editmatchmode(interaction, ctx, lang) {
  const rule = await loadRule(interaction, ctx, lang);
  if (!rule) return;
  const mode = interaction.options.getString('match');
  const verdict = checkTrigger(rule.trigger, mode);
  if (!verdict.ok) return interaction.reply(ephemeral(t(lang, `autoresponder.badTrigger.${verdict.code}`)));
  // Only the mode-dependent error blocks the change ({requirearg} in a mode without words). Anything else the
  // recompile reports (a role above this admin, a deleted role, embed or channel) is not caused by the mode,
  // and the compiled result is thrown away: only matchMode is stored.
  const result = await compileScript(rule.script, { db: ctx.db, guild: interaction.guild, writer: interaction.member, matchMode: mode });
  const modeErrors = result.ok ? [] : result.errors.filter((e) => e.code === 'NO_ARGUMENTS_IN_MODE');
  if (modeErrors.length) return interaction.reply(ephemeral(failureText(lang, modeErrors)));
  await updateRule(ctx.db, interaction.guildId, rule.id, { matchMode: mode });
  invalidate(interaction.guildId);
  await log(ctx, interaction, lang, 'editmatchmode', rule.id, mode);
  return interaction.reply(ephemeral(withWarnings(lang, t(lang, 'autoresponder.matchChanged', { id: rule.id, mode }), result.warnings ?? [])));
}

async function toggle(interaction, ctx, lang) {
  const rule = await loadRule(interaction, ctx, lang);
  if (!rule) return;
  const enabled = !rule.enabled;
  await updateRule(ctx.db, interaction.guildId, rule.id, { enabled });
  invalidate(interaction.guildId);
  await log(ctx, interaction, lang, 'toggle', rule.id, state(lang, enabled));
  return interaction.reply(ephemeral(t(lang, 'autoresponder.toggled', { id: rule.id, state: state(lang, enabled) })));
}

async function remove(interaction, ctx, lang) {
  const rule = await loadRule(interaction, ctx, lang);
  if (!rule) return;
  await deleteRule(ctx.db, interaction.guildId, rule.id);
  await clearRuleCooldowns(ctx.db, rule.id);
  invalidate(interaction.guildId);
  await log(ctx, interaction, lang, 'remove', rule.id, oneLine(rule.trigger).slice(0, 100));
  return interaction.reply(ephemeral(t(lang, 'autoresponder.removed', { id: rule.id })));
}

const describe = (lang, r) =>
  t(lang, 'autoresponder.list.line', { id: r.id, state: state(lang, r.enabled), mode: r.matchMode, trigger: oneLine(r.trigger) });

async function list(interaction, ctx, lang) {
  const rules = await listRules(ctx.db, interaction.guildId);
  const text = rules.length ? fitLines(lang, rules.map((r) => describe(lang, r)), MAX_REPLY) : t(lang, 'autoresponder.list.none');
  return interaction.reply(ephemeral(text));
}

async function show(interaction, ctx, lang) {
  const rule = await loadRule(interaction, ctx, lang);
  if (!rule) return;
  const head = t(lang, 'autoresponder.show.head', {
    id: rule.id, state: state(lang, rule.enabled), mode: rule.matchMode, trigger: oneLine(rule.trigger),
  });
  const room = MAX_REPLY - head.length - 1;
  const script = rule.script.length > room ? `${rule.script.slice(0, Math.max(0, room - 1))}…` : rule.script;
  return interaction.reply(ephemeral(`${head}\n${script}`));
}

const tt = (lang, key, vars) => t(lang, `autoresponder.test.${key}`, vars);
// A disabled rule is only a fallback: the rule that would really run wins when there is one.
function pickRule(rules, content) {
  const live = chooseRule(rules, content);
  if (live) return live;
  const asIfOn = chooseRule(rules.map((r) => ({ ...r, enabled: true })), content);
  return asIfOn ? rules.find((r) => r.id === asIfOn.id) : null;
}

// Dry run: reads the store and runs the pure pipeline. It writes nothing and calls no Discord write.
async function dryRun(interaction, ctx, lang) {
  const content = interaction.options.getString('message');
  const rules = await listRules(ctx.db, interaction.guildId);
  const rule = pickRule(rules, content);
  if (!rule) return interaction.reply(ephemeral(tt(lang, 'none')));

  const lines = [tt(lang, 'rule', { id: rule.id, trigger: oneLine(rule.trigger), mode: rule.matchMode })];
  if (!rule.enabled) lines.push(tt(lang, 'disabled'));
  lines.push(...await describeRunFor(lang, {
    compiled: rule.compiled, text: content, member: interaction.member, guild: interaction.guild,
    channel: interaction.channel, channelId: interaction.channelId, author: interaction.user,
  }, { rule, db: ctx.db }));
  return interaction.reply(ephemeral(fitLines(lang, lines, MAX_REPLY)));
}

const HANDLERS = { add, edit, editmatchmode, toggle, remove, list, show, test: dryRun, builder: openBuilder };

export function errorLines(lang, errors) {
  return errors.slice(0, MAX_ERROR_LINES).map((e) => {
    const detail = e.detail ? `"${e.detail}"` : '';
    const text = t(lang, `autoresponder.error.${e.code}`, { detail }).trim();
    // e.pos is a zero-based offset; people count characters from 1.
    return t(lang, 'autoresponder.errors.line', { pos: (e.pos ?? 0) + 1, text });
  });
}

const failureText = (lang, errors) =>
  fitLines(lang, [t(lang, 'autoresponder.errors.head'), ...errorLines(lang, errors)], MAX_REPLY);

// Warnings go after the success text, one line each, without repeating a code.
export function withWarnings(lang, text, warnings = []) {
  const codes = [...new Set(warnings.map((w) => w.code))];
  return [text, ...codes.map((c) => t(lang, `autoresponder.warning.${c}`))].join('\n');
}

// Saves the modal: validates the trigger and compiles the script as the submitting member.
async function submitModal(interaction, ctx, lang, kind, arg) {
  const trigger = interaction.fields.getTextInputValue('trigger');
  const script = interaction.fields.getTextInputValue('script');
  let rule = null;
  let matchMode = arg;
  if (kind === 'edit') {
    rule = await getRule(ctx.db, interaction.guildId, Number(arg));
    if (!rule) return interaction.reply(ephemeral(t(lang, 'autoresponder.gone')));
    matchMode = rule.matchMode;
  }
  const verdict = checkTrigger(trigger, matchMode);
  if (!verdict.ok) return interaction.reply(ephemeral(t(lang, `autoresponder.badTrigger.${verdict.code}`)));
  const result = await compileScript(script, { db: ctx.db, guild: interaction.guild, writer: interaction.member, matchMode });
  if (!result.ok) return interaction.reply(ephemeral(failureText(lang, result.errors)));
  const detail = oneLine(trigger).slice(0, 100);
  if (kind === 'edit') {
    await updateRule(ctx.db, interaction.guildId, rule.id, { trigger, script, compiled: result.compiled });
    await clearRuleCooldowns(ctx.db, rule.id);
    invalidate(interaction.guildId);
    await log(ctx, interaction, lang, 'edit', rule.id, detail);
    return interaction.reply(ephemeral(withWarnings(lang, t(lang, 'autoresponder.updated', { id: rule.id }), result.warnings)));
  }
  const created = await createRule(ctx.db, {
    guildId: interaction.guildId, trigger, matchMode, script, compiled: result.compiled, createdBy: interaction.user.id,
  });
  if (created === 'full') return interaction.reply(ephemeral(t(lang, 'autoresponder.full')));
  invalidate(interaction.guildId);
  await log(ctx, interaction, lang, 'add', created.id, detail);
  return interaction.reply(ephemeral(withWarnings(lang, t(lang, 'autoresponder.created', { id: created.id }), result.warnings)));
}

/** Routes every `autoresponder:*` component: the add and edit modal submissions. */
async function handle(interaction, ctx) {
  const [, kind, action, arg] = interaction.customId.split(':');
  // Member-facing: a press needs the feature on, not Manage Server, so it is routed before any guard.
  if (kind === 'p') return handlePress(interaction, ctx);
  if (kind === 'b') return handleBuilder(interaction, ctx);
  const buttonModal = action === 'btnadd' || action === 'btnedit';
  if (kind !== 'm' || !interaction.isModalSubmit() || !(buttonModal || ['add', 'edit'].includes(action))) return;
  const lang = await guard(interaction, ctx, 'autoresponder');
  if (!lang) return;
  if (buttonModal) return submitButtonModal(interaction, ctx, lang, action);
  return submitModal(interaction, ctx, lang, action, arg);
}

export function createAutoresponderCommand() {
  return {
    data: buildData(),
    components: { prefix: PREFIX, handle },
    async execute(interaction, ctx) {
      const group = interaction.options.getSubcommandGroup?.(false) ?? null;
      const sub = interaction.options.getSubcommand();
      if (group === 'button') {
        const lang = await guard(interaction, ctx, 'autoresponder');
        if (!lang) return;
        return BUTTON_HANDLERS[sub]?.(interaction, ctx, lang);
      }
      if (sub === 'enable' || sub === 'disable') {
        await handleToggle(interaction, ctx, 'autoresponder');
        invalidate(interaction.guildId);
        return;
      }
      const lang = await guard(interaction, ctx, 'autoresponder');
      if (!lang) return;
      return HANDLERS[sub]?.(interaction, ctx, lang);
    },
  };
}

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
import { checkTrigger, MATCH_MODES, MAX_TRIGGER_LENGTH } from './match.js';
import { compileScript, MAX_SCRIPT } from './script/compile.js';
import { logAutoresponder } from './log.js';

const PREFIX = 'autoresponder';
const MAX_ERROR_LINES = 10;
const MAX_REPLY = 2000;

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
    .addSubcommand((s) => s.setName('show').setDescription('Show one rule in detail').addIntegerOption(idOption));
}

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

const log = (ctx, interaction, lang, action, ruleId, detail) =>
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
  await updateRule(ctx.db, interaction.guildId, rule.id, { matchMode: mode });
  invalidate(interaction.guildId);
  await log(ctx, interaction, lang, 'editmatchmode', rule.id, mode);
  return interaction.reply(ephemeral(t(lang, 'autoresponder.matchChanged', { id: rule.id, mode })));
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

const HANDLERS = { add, edit, editmatchmode, toggle, remove, list, show };

function errorLines(lang, errors) {
  return errors.slice(0, MAX_ERROR_LINES).map((e) => {
    const detail = e.detail ? `"${e.detail}"` : '';
    const text = t(lang, `autoresponder.error.${e.code}`, { detail }).trim();
    return t(lang, 'autoresponder.errors.line', { pos: e.pos ?? 0, text });
  });
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
  const result = await compileScript(script, { db: ctx.db, guild: interaction.guild, writer: interaction.member });
  if (!result.ok) {
    const lines = [t(lang, 'autoresponder.errors.head'), ...errorLines(lang, result.errors)];
    return interaction.reply(ephemeral(fitLines(lang, lines, MAX_REPLY)));
  }
  const detail = oneLine(trigger).slice(0, 100);
  if (kind === 'edit') {
    await updateRule(ctx.db, interaction.guildId, rule.id, { trigger, script, compiled: result.compiled });
    await clearRuleCooldowns(ctx.db, rule.id);
    invalidate(interaction.guildId);
    await log(ctx, interaction, lang, 'edit', rule.id, detail);
    return interaction.reply(ephemeral(t(lang, 'autoresponder.updated', { id: rule.id })));
  }
  const created = await createRule(ctx.db, {
    guildId: interaction.guildId, trigger, matchMode, script, compiled: result.compiled, createdBy: interaction.user.id,
  });
  if (created === 'full') return interaction.reply(ephemeral(t(lang, 'autoresponder.full')));
  invalidate(interaction.guildId);
  await log(ctx, interaction, lang, 'add', created.id, detail);
  return interaction.reply(ephemeral(t(lang, 'autoresponder.created', { id: created.id })));
}

/** Routes every `autoresponder:*` component: the add and edit modal submissions. */
async function handle(interaction, ctx) {
  const [, kind, action, arg] = interaction.customId.split(':');
  if (kind !== 'm' || !interaction.isModalSubmit() || !['add', 'edit'].includes(action)) return;
  const lang = await guard(interaction, ctx, 'autoresponder');
  if (!lang) return;
  return submitModal(interaction, ctx, lang, action, arg);
}

export function createAutoresponderCommand() {
  return {
    data: buildData(),
    components: { prefix: PREFIX, handle },
    async execute(interaction, ctx) {
      const sub = interaction.options.getSubcommand();
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

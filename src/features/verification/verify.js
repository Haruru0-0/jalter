import {
  ActionRowBuilder, AttachmentBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, ModalBuilder,
  TextInputBuilder, TextInputStyle,
} from 'discord.js';
import { getFeature } from '../../db/settings.js';
import { getLang, t } from '../../i18n/index.js';
import { botCanGive } from '../../core/role-safety.js';
import { ephemeral } from '../../core/replies.js';
import { readConfig } from './config.js';
import { logVerification } from './log.js';
import { handleSetupButton } from './commands.js';
import { CODE_LENGTH, createChallengeStore } from './captcha.js';
import { renderCaptcha } from './captcha-image.js';

export const VERIFY_BUTTON_ID = 'verification:go';

// Clicks being processed right now (guild:user): a concurrent double click is answered "already".
const inFlight = new Set();

/** Gives the Verified role to a member. Never throws; logs once on success. */
export async function verifyMember(ctx, guild, member, { method, actorId } = {}, deps = { logVerification }) {
  if (!member?.roles) return { ok: false, reason: 'discord_error' };
  const key = `${guild.id}:${member.id}`;
  if (inFlight.has(key)) return { ok: false, reason: 'already' };
  inFlight.add(key);
  try {
    const { config } = await getFeature(ctx.db, guild.id, 'verification');
    const cfg = readConfig(config);
    if (!cfg.roleId) return { ok: false, reason: 'no_role' };
    let role = guild.roles.cache.get(cfg.roleId) ?? null;
    if (!role) role = await guild.roles.fetch(cfg.roleId).catch(() => null);
    if (!role) return { ok: false, reason: 'no_role' };
    if (!botCanGive(guild, role)) return { ok: false, reason: 'role_too_high' };
    if (member.roles.cache.has(role.id)) return { ok: false, reason: 'already' };
    try {
      await member.roles.add(role.id, 'Verification');
    } catch (err) {
      console.warn('verification: could not add role:', err?.message ?? err);
      return { ok: false, reason: 'discord_error' };
    }
    const lang = await getLang(ctx.db, guild.id);
    await deps.logVerification(ctx, guild.id, lang, {
      kind: method === 'manual' ? 'manual_verify' : 'verified',
      userId: member.id,
      actorId,
      detail: method === 'manual' ? undefined : method,
    });
    return { ok: true };
  } catch (err) {
    console.warn('verification: verify failed:', err?.message ?? err);
    return { ok: false, reason: 'discord_error' };
  } finally {
    inFlight.delete(key);
  }
}

/** Posts the single Verify button message; returns its id, or null when it could not be sent. */
export async function postPanel(ctx, guild, channel, lang) {
  const embed = new EmbedBuilder()
    .setTitle(t(lang, 'verification.panel.title'))
    .setDescription(t(lang, 'verification.panel.description'));
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(VERIFY_BUTTON_ID)
      .setLabel(t(lang, 'verification.button.verify')).setStyle(ButtonStyle.Success),
  );
  try {
    const message = await channel.send({ embeds: [embed], components: [row] });
    return message?.id ?? null;
  } catch (err) {
    console.warn('verification: could not post the panel:', err?.message ?? err);
    return null;
  }
}

const REASON_KEY = {
  no_role: 'verification.msg.no_role',
  role_too_high: 'verification.msg.role_too_high',
  already: 'verification.msg.already',
  discord_error: 'verification.msg.error',
};

// One store per process: captcha codes live in memory only.
const challengeStore = createChallengeStore();

const CAPTCHA_LIVE_STATES = ['rolling_out', 'active'];
const CAPTCHA_FAIL_KEY = {
  no_role: 'verification.captcha.no_role',
  role_too_high: 'verification.captcha.role_too_high',
  discord_error: 'verification.captcha.error',
};
const seconds = (ms) => Math.max(1, Math.ceil(ms / 1000));
const en = (key, vars) => t('en', key, vars);

function verifyAgainRow() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(VERIFY_BUTTON_ID)
      .setLabel(en('verification.captcha.verify')).setStyle(ButtonStyle.Success),
  );
}

/** The feature must be on and past setup; returns the config or null. */
async function liveCaptchaConfig(ctx, guildId) {
  const { enabled, config } = await getFeature(ctx.db, guildId, 'verification');
  const cfg = readConfig(config);
  return enabled && CAPTCHA_LIVE_STATES.includes(cfg.state) ? cfg : null;
}

async function handleCaptchaStart(interaction, cfg, lang, deps) {
  const store = deps?.store ?? challengeStore;
  const render = deps?.render ?? renderCaptcha;
  const say = (payload) => interaction.editReply(payload);
  let member;
  try {
    member = await interaction.guild.members.fetch({ user: interaction.user.id, force: true });
  } catch {
    return say({ content: en('verification.captcha.error') });
  }
  if (cfg.roleId && member.roles.cache.has(cfg.roleId)) return say({ content: t(lang, 'verification.msg.already') });

  const userId = interaction.user.id;
  const issued = store.issue(interaction.guildId, userId);
  if (issued.code == null) {
    return say({ content: en('verification.captcha.cooldown', { seconds: seconds(issued.cooldownLeft) }) });
  }
  let png;
  try {
    png = await render(issued.code);
  } catch (err) {
    console.warn('verification: captcha render failed:', err?.message ?? err);
    store.clear(interaction.guildId, userId);
    return say({ content: en('verification.captcha.error') });
  }
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`verification:enter:${userId}`)
      .setLabel(en('verification.captcha.enter')).setStyle(ButtonStyle.Primary),
  );
  return say({
    content: en('verification.captcha.prompt'),
    files: [new AttachmentBuilder(png, { name: 'captcha.png' })],
    components: [row],
  });
}

/** verification:enter:<userId> - opens the code modal, only for the user the code was issued to. */
async function handleCaptchaEnter(interaction, ctx, ownerId) {
  if (interaction.user.id !== ownerId) {
    return interaction.reply(ephemeral(en('verification.captcha.not_yours')));
  }
  const lang = await getLang(ctx.db, interaction.guildId);
  if (!(await liveCaptchaConfig(ctx, interaction.guildId))) {
    return interaction.reply(ephemeral(t(lang, 'verification.msg.off')));
  }
  const input = new TextInputBuilder().setCustomId('code')
    .setLabel(en('verification.captcha.modal_label')).setStyle(TextInputStyle.Short)
    .setMinLength(CODE_LENGTH).setMaxLength(CODE_LENGTH).setRequired(true);
  const modal = new ModalBuilder().setCustomId(`verification:code:${ownerId}`)
    .setTitle(en('verification.captcha.modal_title'))
    .addComponents(new ActionRowBuilder().addComponents(input));
  return interaction.showModal(modal);
}

/** verification:code:<userId> - checks the typed code. */
async function handleCaptchaCode(interaction, ctx, ownerId, deps) {
  if (interaction.user.id !== ownerId) {
    return interaction.reply(ephemeral(en('verification.captcha.not_yours')));
  }
  const store = deps?.store ?? challengeStore;
  const guildId = interaction.guildId;
  const lang = await getLang(ctx.db, guildId);
  const cfg = await liveCaptchaConfig(ctx, guildId);
  if (!cfg) return interaction.reply(ephemeral(t(lang, 'verification.msg.off')));

  await interaction.deferReply(ephemeral({}));
  const say = (payload) => interaction.editReply(payload);
  let member;
  try {
    member = await interaction.guild.members.fetch({ user: ownerId, force: true });
  } catch {
    return say({ content: en('verification.captcha.error') });
  }
  if (cfg.roleId && member.roles.cache.has(cfg.roleId)) return say({ content: t(lang, 'verification.msg.already') });

  const outcome = store.check(guildId, ownerId, interaction.fields.getTextInputValue('code'));
  if (outcome === 'ok') {
    const result = await verifyMember(ctx, interaction.guild, member, { method: 'captcha' },
      { logVerification: deps?.logVerification ?? logVerification });
    if (result.ok) return say({ content: en('verification.captcha.verified') });
    if (result.reason === 'already') return say({ content: t(lang, 'verification.msg.already') });
    return say({ content: en(CAPTCHA_FAIL_KEY[result.reason] ?? 'verification.captcha.error') });
  }
  if (outcome === 'wrong') {
    return say({ content: en('verification.captcha.wrong', { left: store.triesLeft(guildId, ownerId) }) });
  }
  if (outcome === 'cooldown') {
    return say({
      content: en('verification.captcha.cooldown', { seconds: seconds(store.cooldownLeft(guildId, ownerId)) }),
      components: [verifyAgainRow()],
    });
  }
  return say({ content: en('verification.captcha.expired'), components: [verifyAgainRow()] });
}

export async function handleVerifyButton(interaction, ctx, deps) {
  const guildId = interaction.guildId;
  const lang = guildId ? await getLang(ctx.db, guildId) : 'en';
  const reply = (key) => interaction.reply(ephemeral(t(lang, key)));
  if (!interaction.guild) return reply('common.guildOnly');
  const { enabled, config } = await getFeature(ctx.db, guildId, 'verification');
  const cfg = readConfig(config);
  if (!enabled || cfg.state === 'none') return reply('verification.msg.off');
  if (cfg.mode === 'captcha' && !CAPTCHA_LIVE_STATES.includes(cfg.state)) return reply('verification.msg.off');

  // Everything after this can be slow (role add, mod log): acknowledge first, answer with editReply.
  await interaction.deferReply(ephemeral({}));
  const say = (key) => interaction.editReply({ content: t(lang, key) });
  if (cfg.mode === 'captcha') return handleCaptchaStart(interaction, cfg, lang, deps);

  let member;
  try {
    member = await interaction.guild.members.fetch({ user: interaction.user.id, force: true });
  } catch {
    return say('verification.msg.error');
  }
  if (cfg.roleId && member.roles.cache.has(cfg.roleId)) return say('verification.msg.already');

  const result = await verifyMember(ctx, interaction.guild, member, { method: 'button' }, deps);
  return say(result.ok ? 'verification.msg.verified' : REASON_KEY[result.reason]);
}

/** Entry for the `verification` component prefix; later tasks add branches on the second segment. */
export async function handle(interaction, ctx, deps) {
  const [, action, step] = interaction.customId.split(':');
  if (action === 'go') return handleVerifyButton(interaction, ctx, deps);
  if ((action === 'enter' || action === 'code') && step) {
    if (!interaction.guild) return interaction.reply(ephemeral(t('en', 'common.guildOnly')));
    return action === 'enter'
      ? handleCaptchaEnter(interaction, ctx, step)
      : handleCaptchaCode(interaction, ctx, step, deps);
  }
  if (action === 'setup' && (step === 'ok' || step === 'no')) return handleSetupButton(interaction, ctx);
  const lang = interaction.guildId ? await getLang(ctx.db, interaction.guildId) : 'en';
  return interaction.reply(ephemeral(t(lang, 'verification.msg.unavailable')));
}

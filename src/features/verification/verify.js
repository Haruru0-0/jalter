import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder } from 'discord.js';
import { getFeature } from '../../db/settings.js';
import { getLang, t } from '../../i18n/index.js';
import { botCanGive } from '../../core/role-safety.js';
import { ephemeral } from '../../core/replies.js';
import { readConfig } from './config.js';
import { logVerification } from './log.js';

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

export async function handleVerifyButton(interaction, ctx, deps) {
  const guildId = interaction.guildId;
  const lang = guildId ? await getLang(ctx.db, guildId) : 'en';
  const reply = (key) => interaction.reply(ephemeral(t(lang, key)));
  if (!interaction.guild) return reply('common.guildOnly');
  const { enabled, config } = await getFeature(ctx.db, guildId, 'verification');
  const cfg = readConfig(config);
  if (!enabled || cfg.state === 'none') return reply('verification.msg.off');

  // Everything after this can be slow (role add, mod log): acknowledge first, answer with editReply.
  await interaction.deferReply(ephemeral({}));
  const say = (key) => interaction.editReply({ content: t(lang, key) });
  if (cfg.mode === 'captcha') return say('verification.msg.not_available');

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
export async function handle(interaction, ctx) {
  const [, action] = interaction.customId.split(':');
  if (action === 'go') return handleVerifyButton(interaction, ctx);
  const lang = interaction.guildId ? await getLang(ctx.db, interaction.guildId) : 'en';
  return interaction.reply(ephemeral(t(lang, 'verification.msg.unavailable')));
}

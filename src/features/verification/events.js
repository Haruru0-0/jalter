// Bots and new channels follow the gate once verification is running.
import { Events } from 'discord.js';
import { getFeature } from '../../db/settings.js';
import { getLang } from '../../i18n/index.js';
import { safe } from '../logging/send-log.js';
import { readConfig } from './config.js';
import { gateChannel, revertChannel } from './apply.js';
import { logVerification } from './log.js';
import { verifyMember } from './verify.js';

// `failed` keeps running too: the gate stays on the channels it reached (same ruling as the
// verify button and the captcha), so new bots and new channels must follow it.
const RUNNING = new Set(['rolling_out', 'active', 'failed']);

// A bot join is routine: the grant is not worth a mod-log line.
const silent = { logVerification: async () => {} };

async function runningConfig(ctx, guildId) {
  const { enabled, config } = await getFeature(ctx.db, guildId, 'verification');
  const cfg = readConfig(config);
  return enabled && RUNNING.has(cfg.state) ? { cfg, grantDone: config?.grantDone === true } : null;
}

/** Builds the event list; tests pass fakes for the collaborators. */
export function createEvents(deps = {}) {
  const verify = deps.verifyMember ?? verifyMember;
  const gate = deps.gateChannel ?? gateChannel;
  const revert = deps.revertChannel ?? revertChannel;
  const log = deps.logVerification ?? logVerification;

  const onMemberAdd = safe('verificationMemberAdd', async (ctx, member) => {
    if (!member?.user?.bot || !member.guild) return;
    if (!(await runningConfig(ctx, member.guild.id))) return;
    await verify(ctx, member.guild, member, { method: 'join' }, silent);
  });

  const onChannelCreate = safe('verificationChannelCreate', async (ctx, channel) => {
    const guild = channel?.guild;
    if (!guild || !channel.permissionOverwrites || channel.isThread?.()) return;
    const running = await runningConfig(ctx, guild.id);
    if (!running) return;
    // Never gate before the grant is finished: until then the gate job (which fetches every
    // channel when it starts) reaches this channel itself.
    if (running.cfg.state !== 'active' && !running.grantDone) return;
    // gateChannel only answers 'skipped' for expected cases (list kind skip, private, deleted,
    // nothing to change); a missing permission surfaces as 'failed'. A channel created inside a
    // gated category copies its gated overwrites: gateChannel records the category's original.
    const result = await gate(ctx, guild, channel, running.cfg);
    if (result === 'failed') {
      const lang = await getLang(ctx.db, guild.id);
      await log(ctx, guild.id, lang, { kind: 'gate_failed', detail: `<#${channel.id}>` });
      return;
    }
    // `/verification remove` (state none) may have started while this gate ran and listed the
    // records already: put the channel back.
    if (result === 'changed') {
      const { config } = await getFeature(ctx.db, guild.id, 'verification');
      if (readConfig(config).state === 'none') await revert(ctx, guild, channel);
    }
  });

  return [
    { name: Events.GuildMemberAdd, execute: onMemberAdd },
    { name: Events.ChannelCreate, execute: onChannelCreate },
  ];
}

export const events = createEvents();

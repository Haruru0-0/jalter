// Bots and new channels follow the gate once verification is running.
import { Events } from 'discord.js';
import { getFeature } from '../../db/settings.js';
import { getLang } from '../../i18n/index.js';
import { safe } from '../logging/send-log.js';
import { readConfig } from './config.js';
import { gateChannel } from './apply.js';
import { logVerification } from './log.js';
import { verifyMember } from './verify.js';

const RUNNING = new Set(['rolling_out', 'active']);

// A bot join is routine: the grant is not worth a mod-log line.
const silent = { logVerification: async () => {} };

async function runningConfig(ctx, guildId) {
  const { enabled, config } = await getFeature(ctx.db, guildId, 'verification');
  const cfg = readConfig(config);
  return enabled && RUNNING.has(cfg.state) ? cfg : null;
}

/** Builds the event list; tests pass fakes for the three collaborators. */
export function createEvents(deps = {}) {
  const verify = deps.verifyMember ?? verifyMember;
  const gate = deps.gateChannel ?? gateChannel;
  const log = deps.logVerification ?? logVerification;

  const onMemberAdd = safe('verificationMemberAdd', async (ctx, member) => {
    if (!member?.user?.bot || !member.guild) return;
    if (!(await runningConfig(ctx, member.guild.id))) return;
    await verify(ctx, member.guild, member, { method: 'join' }, silent);
  });

  const onChannelCreate = safe('verificationChannelCreate', async (ctx, channel) => {
    const guild = channel?.guild;
    if (!guild || !channel.permissionOverwrites || channel.isThread?.()) return;
    const cfg = await runningConfig(ctx, guild.id);
    if (!cfg) return;
    // gateChannel only answers 'skipped' for expected cases (list kind skip, private,
    // synced child, nothing to change); a missing permission surfaces as 'failed'.
    const result = await gate(ctx, guild, channel, cfg);
    if (result === 'failed') {
      const lang = await getLang(ctx.db, guild.id);
      await log(ctx, guild.id, lang, { kind: 'gate_failed', detail: `<#${channel.id}>` });
    }
  });

  return [
    { name: Events.GuildMemberAdd, execute: onMemberAdd },
    { name: Events.ChannelCreate, execute: onChannelCreate },
  ];
}

export const events = createEvents();

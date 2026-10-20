// The join-rate detector.
//
// A burst of human joins inside the detection window starts a lockdown. While the lockdown is
// on, a young account that joins is kicked straight away and is not counted. Bots are never
// counted and never kicked.
import { Events } from 'discord.js';
import { safe } from '../logging/send-log.js';
import { getFeature } from '../../db/settings.js';
import { readConfig } from './config.js';
import { joins, startAntiraidSweep } from './joins.js';
import { startLockdown, kickYoungJoin } from './lockdown.js';

export function createEvents(deps = {}) {
  const store = deps.joins ?? joins;
  const now = deps.now ?? Date.now;
  const start = deps.startLockdown ?? startLockdown;
  const kick = deps.kickYoungJoin ?? kickYoungJoin;
  const sweep = deps.startSweep ?? startAntiraidSweep;

  const onMemberAdd = safe('antiraidMemberAdd', async (ctx, member) => {
    const guild = member?.guild;
    if (!guild?.id) return;
    if (member.user?.bot) return;
    const { enabled, config } = await getFeature(ctx.db, guild.id, 'antiraid');
    if (!enabled) return;
    const cfg = readConfig(config);

    // The prune timer only starts once a join is really handled.
    sweep(store);

    if (cfg.state === 'locked') {
      // A young account that joins during a lockdown is removed at once. It is not counted:
      // the join list is cleared when the lockdown ends.
      await kick(ctx, guild, member, deps);
      return;
    }

    const windowMs = cfg.windowSeconds * 1000;
    const at = now();
    const count = store.record(
      guild.id,
      { userId: member.id, createdAt: member.user?.createdTimestamp },
      at,
      windowMs,
    );
    if (count < cfg.joins) return;
    await start(ctx, guild, {
      trigger: 'auto',
      startedBy: 'auto',
      joinedCount: count,
      candidates: store.recent(guild.id, at, windowMs),
    }, deps);
  });

  return [{ name: Events.GuildMemberAdd, execute: onMemberAdd }];
}

export const events = createEvents();

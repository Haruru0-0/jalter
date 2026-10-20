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
import { startLockdown, endLockdown, kickYoungJoin } from './lockdown.js';

export function createEvents(deps = {}) {
  const store = deps.joins ?? joins;
  const now = deps.now ?? Date.now;
  const start = deps.startLockdown ?? startLockdown;
  const end = deps.endLockdown ?? endLockdown;
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

    // A lock past its end time (the end job was lost or is late) is ended now, and this join
    // follows the idle path.
    let locked = cfg.state === 'locked';
    if (locked && cfg.lockedUntil && cfg.lockedUntil <= now()) {
      // Only the expired lockdown seen here: a newer one may start before this end runs.
      await end(ctx, guild, { by: 'timer', lockedUntil: cfg.lockedUntil }, deps);
      locked = false;
    }

    if (locked) {
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
    const result = await start(ctx, guild, {
      trigger: 'auto',
      startedBy: 'auto',
      joinedCount: count,
      candidates: store.recent(guild.id, at, windowMs),
    }, deps);
    // Another join won the race to start the lockdown: this one is a join during a lockdown.
    if (result?.reason === 'already_locked') await kick(ctx, guild, member, deps);
  });

  return [{ name: Events.GuildMemberAdd, execute: onMemberAdd }];
}

export const events = createEvents();

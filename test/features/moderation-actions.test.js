import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { Events } from 'discord.js';
import { runAction, jobs, events, reapplyMute } from '../../src/features/moderation/actions.js';
import { formatCase, dmText } from '../../src/features/moderation/format.js';
import { createCase, getCase, isCurrentlyMuted } from '../../src/features/moderation/store.js';
import { readConfig } from '../../src/features/moderation/config.js';
import { setFeature } from '../../src/db/settings.js';
import { runDueJobs, claimDue } from '../../src/core/scheduler.js';
import { testDb } from '../helpers/db.js';

const realWarn = console.warn;
let db;
before(async () => { db = await testDb(); });
beforeEach(async () => {
  console.warn = () => {};
  await db.query('TRUNCATE guild_settings, scheduled_jobs, mod_cases, mod_counters');
});
after(async () => { console.warn = realWarn; await db.end(); });

const discordError = (status, code) => Object.assign(new Error(`HTTP ${status}`), { status, code });

function fakeMember(id, position, calls, opts = {}) {
  const roleIds = new Set(opts.roles ?? []);
  return {
    id,
    user: { id, bot: false },
    roles: {
      highest: { position },
      cache: { has: (r) => roleIds.has(r) },
      add: async (r, why) => { calls.push(['roles.add', id, r, why]); if (opts.fail) throw opts.fail; roleIds.add(r); },
      remove: async (r, why) => { calls.push(['roles.remove', id, r, why]); if (opts.fail) throw opts.fail; roleIds.delete(r); },
    },
    send: async (text) => { calls.push(['dm', id, text]); if (opts.dmFail) throw new Error('closed'); },
    timeout: async (ms, why) => { calls.push(['timeout', id, ms, why]); if (opts.fail) throw opts.fail; },
    kick: async (why) => { calls.push(['kick', id, why]); if (opts.fail) throw opts.fail; },
  };
}

function setup({ banned = [], muteRole = 'MUTE', botFail } = {}) {
  const calls = [];
  const members = new Map();
  const bannedSet = new Set(banned);
  const guild = {
    id: 'g1', name: 'Guild', ownerId: 'owner',
    roles: { cache: new Map(muteRole ? [[muteRole, { id: muteRole }]] : []) },
    bans: {
      fetch: async (id) => {
        if (!bannedSet.has(id)) throw discordError(404, 10026);
        return { user: { id } };
      },
    },
    members: {
      me: { id: 'bot', roles: { highest: { position: 10 } } },
      fetch: async (id) => {
        const m = members.get(id);
        if (!m) throw discordError(404, 10007);
        return m;
      },
      ban: async (id, opts) => { calls.push(['ban', id, opts]); if (botFail) throw botFail; bannedSet.add(id); },
      unban: async (id, why) => { calls.push(['unban', id, why]); if (botFail) throw botFail; bannedSet.delete(id); },
    },
  };
  const logged = [];
  const ctx = {
    db,
    client: {
      user: { id: 'bot' },
      guilds: { cache: new Map([['g1', guild]]) },
      channels: {
        fetch: async () => ({
          isTextBased: () => true,
          send: async (p) => { logged.push(p); return { id: `m${logged.length}`, channelId: 'LOG' }; },
        }),
      },
    },
  };
  const actor = fakeMember('mod', 5, calls);
  const add = (id, position = 1, opts) => { const m = fakeMember(id, position, calls, opts); members.set(id, m); return m; };
  return { calls, guild, ctx, actor, add, logged, bannedSet, members };
}

const cfg = (over = {}) => readConfig({ muteRoleId: 'MUTE', ...over });
const params = (s, over = {}) => ({
  guild: s.guild, actor: s.actor, type: 'warn', targetId: 'u1', target: null,
  reason: 'because', durationSeconds: null, config: cfg(), lang: 'en', ...over,
});
const count = async () => Number((await db.query('SELECT count(*) FROM mod_cases')).rows[0].count);
const discordCalls = (calls) => calls.filter((c) => c[0] !== 'dm');

async function enableLogging() {
  await setFeature(db, 'g1', 'logging', { enabled: true, config: { channels: { default: 'LOG' } } });
}

test('refusals create no case, make no Discord call and consume no number', async () => {
  const s = setup();
  const target = s.add('u1', 1);
  const high = s.add('u2', 9);
  const cases = [
    [{ targetId: 'owner', type: 'ban' }, 'owner'],
    [{ targetId: 'mod', type: 'kick' }, 'self'],
    [{ targetId: 'bot', type: 'ban' }, 'bot_self'],
    [{ targetId: 'u2', target: high, type: 'kick' }, 'actor_hierarchy'],
    [{ type: 'ban', reason: '', targetId: 'u1', target }, 'reason_required'],
    [{ type: 'timeout', durationSeconds: 5, targetId: 'u1', target }, 'too_short'],
    [{ type: 'timeout', durationSeconds: 3_000_000, targetId: 'u1', target }, 'too_long'],
    [{ type: 'kick', targetId: 'u9', target: null }, 'not_in_server'],
    [{ type: 'mute', targetId: 'u1', target, config: cfg({ muteRoleId: null }) }, 'no_mute_role'],
  ];
  for (const [over, reason] of cases) {
    const res = await runAction(s.ctx, params(s, { target: null, ...over }));
    assert.deepEqual([res.ok, res.reason], [false, reason], reason);
  }
  const gone = setup({ muteRole: null });
  gone.add('u1');
  const res = await runAction(gone.ctx, params(gone, { type: 'mute', target: gone.members.get('u1') }));
  assert.equal(res.reason, 'no_mute_role');
  const banned = setup({ banned: ['u3'] });
  assert.equal((await runAction(banned.ctx, params(banned, { type: 'ban', targetId: 'u3' }))).reason, 'already_banned');
  assert.equal((await runAction(banned.ctx, params(banned, { type: 'unban', targetId: 'u4' }))).reason, 'not_banned');
  assert.equal(await count(), 0);
  assert.deepEqual(discordCalls(s.calls), []);
  assert.deepEqual(banned.calls, []);
});

test('already_muted is refused', async () => {
  const s = setup();
  const target = s.add('u1');
  await createCase(db, { guildId: 'g1', type: 'mute', targetId: 'u1', moderatorId: 'mod', reason: 'x' });
  const res = await runAction(s.ctx, params(s, { type: 'mute', target }));
  assert.equal(res.reason, 'already_muted');
  assert.equal(await count(), 1);
  assert.deepEqual(s.calls, []);
});

test('reason is required only for punishments and relaxed by config', async () => {
  const s = setup();
  const target = s.add('u1');
  for (const type of ['untimeout', 'unmute']) {
    const res = await runAction(s.ctx, params(s, { type, target, reason: null }));
    assert.equal(res.ok, true, type);
  }
  assert.equal((await runAction(s.ctx, params(s, { type: 'unban', targetId: 'u7', reason: null }))).reason, 'not_banned');
  assert.equal((await runAction(s.ctx, params(s, { type: 'kick', target, reason: '   ' }))).reason, 'reason_required');
  const relaxed = await runAction(s.ctx, params(s, { type: 'kick', target, reason: null, config: cfg({ reasonRequired: false }) }));
  assert.equal(relaxed.ok, true);
});

test('successful actions create the right case and call Discord', async () => {
  const s = setup();
  const target = s.add('u1');
  const warn = await runAction(s.ctx, params(s, { type: 'warn', target }));
  assert.equal(warn.ok, true);
  assert.equal(warn.modCase.number, 1);
  assert.equal(warn.modCase.type, 'warn');
  assert.deepEqual(warn.warnings, []);
  assert.deepEqual(discordCalls(s.calls), []);

  const to = await runAction(s.ctx, params(s, { type: 'timeout', target, durationSeconds: 600 }));
  assert.equal(to.modCase.durationMs, 600_000);
  assert.ok(to.modCase.endsAt > Date.now());
  assert.equal(s.calls.find((c) => c[0] === 'timeout')[2], 600_000);

  await runAction(s.ctx, params(s, { type: 'untimeout', target, reason: null }));
  assert.equal(s.calls.find((c) => c[0] === 'timeout' && c[2] === null)[1], 'u1');

  const mute = await runAction(s.ctx, params(s, { type: 'mute', target }));
  assert.equal(mute.modCase.type, 'mute');
  assert.deepEqual(s.calls.find((c) => c[0] === 'roles.add').slice(0, 3), ['roles.add', 'u1', 'MUTE']);
  assert.equal(await isCurrentlyMuted(db, 'g1', 'u1', Date.now()), true);
  await runAction(s.ctx, params(s, { type: 'unmute', target, reason: null }));
  assert.equal(s.calls.find((c) => c[0] === 'roles.remove')[2], 'MUTE');
  assert.equal(await isCurrentlyMuted(db, 'g1', 'u1', Date.now()), false);

  const kick = await runAction(s.ctx, params(s, { type: 'kick', target }));
  assert.equal(kick.modCase.type, 'kick');
  assert.equal(s.calls.filter((c) => c[0] === 'kick').length, 1);
  assert.equal(kick.modCase.number, 6);
});

test('ban uses delete days from the call or the config; unban works for non-members', async () => {
  const s = setup();
  const target = s.add('u1');
  await runAction(s.ctx, params(s, { type: 'ban', target, deleteDays: 3 }));
  assert.equal(s.calls.find((c) => c[0] === 'ban')[2].deleteMessageSeconds, 3 * 86400);
  await runAction(s.ctx, params(s, { type: 'ban', targetId: 'u5', config: cfg({ banDeleteDays: 2 }) }));
  assert.equal(s.calls.filter((c) => c[0] === 'ban')[1][2].deleteMessageSeconds, 2 * 86400);
  const un = await runAction(s.ctx, params(s, { type: 'unban', targetId: 'u5', reason: null }));
  assert.equal(un.ok, true);
  assert.equal(un.modCase.type, 'unban');
  assert.equal(s.calls.find((c) => c[0] === 'unban')[1], 'u5');
});

test('a Discord error gives discord_refused and consumes no case number', async () => {
  const s = setup();
  const target = s.add('u1', 1, { fail: discordError(403, 50013) });
  const res = await runAction(s.ctx, params(s, { type: 'kick', target }));
  assert.deepEqual([res.ok, res.reason], [false, 'discord_refused']);
  assert.equal(await count(), 0);
  const banFail = setup({ botFail: discordError(500) });
  assert.equal((await runAction(banFail.ctx, params(banFail, { type: 'ban' }))).reason, 'discord_refused');
  const ok = await runAction(s.ctx, params(s, { type: 'warn', target }));
  assert.equal(ok.modCase.number, 1);
});

test('DM is sent when on, skipped when off, and a closed DM only warns', async () => {
  const s = setup();
  const target = s.add('u1', 1, { dmFail: true });
  const res = await runAction(s.ctx, params(s, { type: 'warn', target, reason: 'spam' }));
  assert.equal(res.ok, true);
  assert.deepEqual(res.warnings, ['dm_failed']);
  const dm = s.calls.find((c) => c[0] === 'dm');
  assert.match(dm[2], /spam/);
  const quiet = setup();
  const t2 = quiet.add('u1');
  await runAction(quiet.ctx, params(quiet, { type: 'warn', target: t2, config: cfg({ dm: false }) }));
  await runAction(quiet.ctx, params(quiet, { type: 'untimeout', target: t2 }));
  assert.equal(quiet.calls.filter((c) => c[0] === 'dm').length, 0);
});

test('kick and ban DM the member before the action', async () => {
  const s = setup();
  const target = s.add('u1');
  await runAction(s.ctx, params(s, { type: 'kick', target }));
  assert.deepEqual(s.calls.map((c) => c[0]), ['dm', 'kick']);
});

test('timed ban schedules mod.unban, a second replaces it, manual unban cancels it', async () => {
  const s = setup();
  s.add('u1');
  await runAction(s.ctx, params(s, { type: 'ban', durationSeconds: 3600 }));
  let rows = (await db.query('SELECT * FROM scheduled_jobs')).rows;
  assert.equal(rows.length, 1);
  assert.deepEqual([rows[0].type, rows[0].key, rows[0].payload], ['mod.unban', 'u1', { userId: 'u1' }]);
  const first = new Date(rows[0].due_at).getTime();
  s.bannedSet.clear();
  await runAction(s.ctx, params(s, { type: 'ban', durationSeconds: 7200 }));
  rows = (await db.query('SELECT * FROM scheduled_jobs')).rows;
  assert.equal(rows.length, 1);
  assert.ok(new Date(rows[0].due_at).getTime() > first);
  await runAction(s.ctx, params(s, { type: 'unban', reason: null }));
  assert.equal((await db.query('SELECT * FROM scheduled_jobs')).rowCount, 0);
});

test('timed mute schedules mod.unmute; unmute cancels; an untimed mute cancels a pending job', async () => {
  const s = setup();
  const target = s.add('u1');
  await runAction(s.ctx, params(s, { type: 'mute', target, durationSeconds: 600 }));
  const rows = (await db.query('SELECT * FROM scheduled_jobs')).rows;
  assert.deepEqual([rows[0].type, rows[0].key], ['mod.unmute', 'u1']);
  await runAction(s.ctx, params(s, { type: 'unmute', target, reason: null }));
  assert.equal((await db.query('SELECT * FROM scheduled_jobs')).rowCount, 0);
  await runAction(s.ctx, params(s, { type: 'mute', target, durationSeconds: 600 }));
  await db.query("UPDATE mod_cases SET ends_at = now() - interval '1 minute' WHERE type = 'mute'");
  await runAction(s.ctx, params(s, { type: 'mute', target }));
  assert.equal((await db.query('SELECT * FROM scheduled_jobs')).rowCount, 0);
});

test('a scheduling failure does not fail the action', async () => {
  const s = setup();
  s.add('u1');
  const broken = { ...s.ctx, db: { query: async (sql, ...rest) => {
    if (/scheduled_jobs/.test(sql)) throw new Error('db down');
    return db.query(sql, ...rest);
  } } };
  const res = await runAction(broken, params(s, { type: 'ban', durationSeconds: 3600 }));
  assert.equal(res.ok, true);
  assert.ok(res.warnings.includes('schedule_failed'));
});

test('a case save failure is a warning, not a failure', async () => {
  const s = setup();
  const target = s.add('u1');
  const broken = { ...s.ctx, db: { query: async (sql, ...rest) => {
    if (/INSERT INTO mod_cases/.test(sql)) throw new Error('db down');
    return db.query(sql, ...rest);
  } } };
  const res = await runAction(broken, params(s, { type: 'kick', target }));
  assert.equal(res.ok, true);
  assert.equal(res.modCase, null);
  assert.ok(res.warnings.includes('case_not_saved'));
  assert.equal(s.calls.filter((c) => c[0] === 'kick').length, 1);
});

test('the mod log location is stored on the case, and logging off does not fail', async () => {
  const s = setup();
  const target = s.add('u1');
  await enableLogging();
  const res = await runAction(s.ctx, params(s, { type: 'warn', target }));
  assert.equal(s.logged.length, 1);
  assert.equal(s.logged[0].embeds[0].title, 'Case #1: Warn');
  const stored = await getCase(db, 'g1', res.modCase.number);
  assert.deepEqual([stored.logChannelId, stored.logMessageId], ['LOG', 'm1']);
  await setFeature(db, 'g1', 'logging', { enabled: false });
  const off = await runAction(s.ctx, params(s, { type: 'warn', target }));
  assert.equal(off.ok, true);
  assert.deepEqual(off.warnings, []);
  assert.equal(s.logged.length, 1);
});

test('expireBan unbans, writes a bot case, and is a no-op the second time', async () => {
  const s = setup({ banned: ['u1'] });
  await createCase(db, { guildId: 'g1', type: 'ban', targetId: 'u1', moderatorId: 'mod', reason: 'x' });
  await enableLogging();
  const job = { guildId: 'g1', type: 'mod.unban', key: 'u1', payload: { userId: 'u1' } };
  await jobs['mod.unban'](s.ctx, job);
  assert.equal(s.calls.filter((c) => c[0] === 'unban').length, 1);
  const c = await getCase(db, 'g1', 2);
  assert.deepEqual([c.type, c.moderatorId, c.targetId, c.reason], ['unban', 'bot', 'u1', 'Timed action expired']);
  assert.equal(s.logged.length, 1);
  await jobs['mod.unban'](s.ctx, job);
  assert.equal(s.calls.filter((x) => x[0] === 'unban').length, 1);
  assert.equal(await count(), 2);
});

test('expiry runs even when the moderation feature is off, in the guild language', async () => {
  const s = setup({ banned: ['u1'] });
  await setFeature(db, 'g1', 'language', { config: { lang: 'fr' } });
  await jobs['mod.unban'](s.ctx, { guildId: 'g1', payload: { userId: 'u1' } });
  const c = await getCase(db, 'g1', 1);
  assert.notEqual(c.reason, 'Timed action expired');
  assert.ok(c.reason.length > 0);
});

const expiredMute = () => createCase(db, {
  guildId: 'g1', type: 'mute', targetId: 'u1', moderatorId: 'mod', reason: 'x',
  durationMs: 60000, endsAt: Date.now() - 1000,
});

test('expireMute removes the role even after ends_at, and is a no-op once unmuted', async () => {
  const s = setup();
  s.add('u1', 1, { roles: ['MUTE'] });
  await setFeature(db, 'g1', 'moderation', { enabled: true, config: { muteRoleId: 'MUTE' } });
  await expiredMute();
  const job = { guildId: 'g1', payload: { userId: 'u1' } };
  await jobs['mod.unmute'](s.ctx, job);
  assert.equal(s.calls.filter((c) => c[0] === 'roles.remove').length, 1);
  const c = await getCase(db, 'g1', 2);
  assert.deepEqual([c.type, c.moderatorId], ['unmute', 'bot']);
  await jobs['mod.unmute'](s.ctx, job);
  assert.equal(s.calls.filter((x) => x[0] === 'roles.remove').length, 1);
  assert.equal(await count(), 2);
});

test('expireMute leaves a permanent mute made after the timed mute ended alone', async () => {
  const s = setup();
  s.add('u1', 1, { roles: ['MUTE'] });
  await setFeature(db, 'g1', 'moderation', { enabled: true, config: { muteRoleId: 'MUTE' } });
  await expiredMute();
  await createCase(db, { guildId: 'g1', type: 'mute', targetId: 'u1', moderatorId: 'mod', reason: 'again' });
  await jobs['mod.unmute'](s.ctx, { guildId: 'g1', payload: { userId: 'u1' } });
  assert.deepEqual(s.calls, []);
  assert.equal(await count(), 2);
  assert.equal((await getCase(db, 'g1', 2)).type, 'mute');
});

test('expireMute leaves a newer timed mute that has not ended alone', async () => {
  const s = setup();
  s.add('u1', 1, { roles: ['MUTE'] });
  await setFeature(db, 'g1', 'moderation', { enabled: true, config: { muteRoleId: 'MUTE' } });
  await expiredMute();
  await createCase(db, {
    guildId: 'g1', type: 'mute', targetId: 'u1', moderatorId: 'mod', reason: 'again',
    durationMs: 3_600_000, endsAt: Date.now() + 3_600_000,
  });
  await jobs['mod.unmute'](s.ctx, { guildId: 'g1', payload: { userId: 'u1' } });
  assert.deepEqual(s.calls, []);
  assert.equal(await count(), 2);
});

test('expireMute removes the role of a timed mute whose case was never saved', async () => {
  const s = setup();
  s.add('u1', 1, { roles: ['MUTE'] });
  await setFeature(db, 'g1', 'moderation', { enabled: true, config: { muteRoleId: 'MUTE' } });
  await jobs['mod.unmute'](s.ctx, { guildId: 'g1', payload: { userId: 'u1' } });
  assert.deepEqual(s.calls.map((c) => c.slice(0, 3)), [['roles.remove', 'u1', 'MUTE']]);
  const c = await getCase(db, 'g1', 1);
  assert.deepEqual([c.type, c.moderatorId], ['unmute', 'bot']);
});

test('expireMute does nothing when the member no longer has the mute role', async () => {
  const s = setup();
  s.add('u1');
  await setFeature(db, 'g1', 'moderation', { enabled: true, config: { muteRoleId: 'MUTE' } });
  await expiredMute();
  await jobs['mod.unmute'](s.ctx, { guildId: 'g1', payload: { userId: 'u1' } });
  assert.deepEqual(s.calls, []);
  assert.equal(await count(), 1);
});

test('expireMute finishes quietly when the member or the role is gone', async () => {
  const s = setup();
  await setFeature(db, 'g1', 'moderation', { enabled: true, config: { muteRoleId: 'MUTE' } });
  await expiredMute();
  await jobs['mod.unmute'](s.ctx, { guildId: 'g1', payload: { userId: 'u1' } });
  s.add('u1', 1, { roles: ['MUTE'] });
  s.guild.roles.cache.clear();
  await jobs['mod.unmute'](s.ctx, { guildId: 'g1', payload: { userId: 'u1' } });
  assert.deepEqual(s.calls, []);
  assert.equal(await count(), 1);
});

test('a 403 finishes the job, a 500 throws so the scheduler retries', async () => {
  const s = setup({ banned: ['u1'], botFail: discordError(403, 50013) });
  await jobs['mod.unban'](s.ctx, { guildId: 'g1', payload: { userId: 'u1' } });
  const s2 = setup({ banned: ['u1'], botFail: discordError(500) });
  await assert.rejects(jobs['mod.unban'](s2.ctx, { guildId: 'g1', payload: { userId: 'u1' } }));
  const s3 = setup();
  s3.add('u1', 1, { fail: discordError(500), roles: ['MUTE'] });
  await setFeature(db, 'g1', 'moderation', { config: { muteRoleId: 'MUTE' } });
  await expiredMute();
  await assert.rejects(jobs['mod.unmute'](s3.ctx, { guildId: 'g1', payload: { userId: 'u1' } }));
  s3.members.get('u1').roles.remove = async () => { throw discordError(403, 50013); };
  await jobs['mod.unmute'](s3.ctx, { guildId: 'g1', payload: { userId: 'u1' } });
  assert.equal(await count(), 1);
  const s4 = setup();
  s4.guild.members.fetch = async () => { throw discordError(503); };
  await assert.rejects(jobs['mod.unmute'](s4.ctx, { guildId: 'g1', payload: { userId: 'u1' } }));
});

test('the scheduler runs a due mod.unban end to end', async () => {
  const s = setup({ banned: ['u1'] });
  await createCase(db, { guildId: 'g1', type: 'ban', targetId: 'u1', moderatorId: 'mod', reason: 'x' });
  await db.query(
    `INSERT INTO scheduled_jobs (guild_id, type, key, payload, due_at)
     VALUES ('g1', 'mod.unban', 'u1', '{"userId":"u1"}', now() - interval '1 minute')`);
  await runDueJobs(s.ctx, { jobs: new Map(Object.entries(jobs)), housekeeping: [] });
  assert.equal(s.bannedSet.has('u1'), false);
  assert.equal((await db.query('SELECT * FROM scheduled_jobs')).rowCount, 0);
  assert.equal((await claimDue(db, Date.now(), { types: ['mod.unban'] })).length, 0);
});

test('reapplyMute re-adds the role for a muted rejoiner only when enabled and muted', async () => {
  const s = setup();
  const member = { ...fakeMember('u1', 1, s.calls), guild: s.guild };
  await reapplyMute(s.ctx, member);
  assert.deepEqual(s.calls, []);
  await createCase(db, { guildId: 'g1', type: 'mute', targetId: 'u1', moderatorId: 'mod', reason: 'x' });
  await setFeature(db, 'g1', 'moderation', { enabled: false, config: { muteRoleId: 'MUTE' } });
  await reapplyMute(s.ctx, member);
  assert.deepEqual(s.calls, []);
  await setFeature(db, 'g1', 'moderation', { enabled: true });
  await reapplyMute(s.ctx, member);
  assert.deepEqual(s.calls.map((c) => c.slice(0, 3)), [['roles.add', 'u1', 'MUTE']]);
});

test('reapplyMute and its event never throw', async () => {
  const s = setup();
  await createCase(db, { guildId: 'g1', type: 'mute', targetId: 'u1', moderatorId: 'mod', reason: 'x' });
  await setFeature(db, 'g1', 'moderation', { enabled: true, config: { muteRoleId: 'MUTE' } });
  const member = { ...fakeMember('u1', 1, s.calls, { fail: discordError(403) }), guild: s.guild };
  await reapplyMute(s.ctx, member);
  assert.equal(events[0].name, Events.GuildMemberAdd);
  await events[0].execute(s.ctx, { guild: null });
});

test('formatCase and dmText', () => {
  const modCase = {
    number: 7, type: 'ban', targetId: 'u1', moderatorId: 'mod', reason: 'spam', durationMs: 3_600_000,
  };
  const embed = formatCase(modCase, 'en');
  assert.equal(embed.title, 'Case #7: Ban');
  const flat = JSON.stringify(embed);
  assert.match(flat, /<@u1>/);
  assert.match(flat, /<@mod>/);
  assert.match(flat, /spam/);
  assert.match(flat, /1h/);
  const noDuration = formatCase({ ...modCase, durationMs: null, reason: null }, 'fr');
  assert.ok(!JSON.stringify(noDuration).includes('1h'));
  const text = dmText('en', 'ban', { guildName: 'Guild', reason: 'spam', durationSeconds: 3600, caseNumber: 7 });
  assert.match(text, /Guild/);
  assert.match(text, /spam/);
  assert.match(text, /1h/);
});

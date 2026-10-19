import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { Events } from 'discord.js';
import { testDb } from '../helpers/db.js';
import { getFeature, setFeature } from '../../src/db/settings.js';
import { createEvents } from '../../src/features/verification/events.js';
import { verifyMember } from '../../src/features/verification/verify.js';
import { createVerificationCommand } from '../../src/features/verification/commands.js';
import { WARN_JOB, KICK_JOB } from '../../src/features/verification/unverified.js';

let db;
before(async () => { db = await testDb(); });
beforeEach(async () => {
  await db.query('TRUNCATE guild_settings');
  await db.query('DELETE FROM scheduled_jobs');
});
after(async () => { await db.end?.(); });

const G = 'g1';
const NOW = 1_800_000_000_000;
const ctx = () => ({ db, client: { user: { id: 'bot1' }, guilds: { cache: new Map() } } });

async function setup(config = {}, enabled = true) {
  await setFeature(db, G, 'verification', {
    enabled,
    config: { mode: 'button', roleId: 'rv', state: 'active', unverifiedPolicy: 'kick', kickAfterSeconds: 7200, ...config },
  });
}

const jobs = async () => (await db.query(
  `SELECT type, key, payload, (EXTRACT(EPOCH FROM due_at) * 1000)::float8 AS due FROM scheduled_jobs ORDER BY type, key`,
)).rows.map((r) => ({ type: r.type, key: r.key, payload: r.payload, due: Math.round(r.due) }));

const events = () => createEvents({ now: () => NOW });
const ev = (name) => events().find((e) => e.name === name).execute;
const human = (id = 'u1', joinedTimestamp = NOW - 1000) => ({
  id, joinedTimestamp, user: { bot: false }, guild: { id: G }, roles: { cache: new Map() },
});

test('a joining human is queued for kick under policy kick', async () => {
  await setup();
  await ev(Events.GuildMemberAdd)(ctx(), human());
  assert.deepEqual(await jobs(), [{
    type: KICK_JOB, key: 'u1', due: NOW - 1000 + 7200_000,
    payload: { policy: 'kick', kickAt: NOW - 1000 + 7200_000, kickAfter: 7200 },
  }]);
});

test('a joining human gets warn and kick jobs under warn_kick with kickAt in both payloads', async () => {
  await setup({ unverifiedPolicy: 'warn_kick', kickAfterSeconds: 7200, warnAfterSeconds: 1800 });
  await ev(Events.GuildMemberAdd)(ctx(), human());
  const kickAt = NOW - 1000 + 7200_000;
  const payload = { policy: 'warn_kick', kickAt, kickAfter: 7200 };
  assert.deepEqual(await jobs(), [
    { type: KICK_JOB, key: 'u1', due: kickAt, payload },
    { type: WARN_JOB, key: 'u1', due: NOW - 1000 + 1800_000, payload },
  ]);
});

test('warn defaults to half the kick time and a missing join time counts from now', async () => {
  await setup({ unverifiedPolicy: 'warn_kick', kickAfterSeconds: 7200 });
  await ev(Events.GuildMemberAdd)(ctx(), human('u1', null));
  const rows = await jobs();
  assert.equal(rows.find((r) => r.type === WARN_JOB).due, NOW + 3600_000);
});

test('a due time is never earlier than now', async () => {
  await setup({ unverifiedPolicy: 'warn_kick', kickAfterSeconds: 7200 });
  await ev(Events.GuildMemberAdd)(ctx(), human('u1', NOW - 10 * 86400_000));
  const rows = await jobs();
  assert.deepEqual(rows.map((r) => r.due), [NOW, NOW]);
});

test('policy none queues nothing', async () => {
  await setup({ unverifiedPolicy: 'none' });
  await ev(Events.GuildMemberAdd)(ctx(), human());
  assert.deepEqual(await jobs(), []);
});

test('a joining bot is never queued', async () => {
  await setup();
  const bot = { ...human('b1'), user: { bot: true } };
  await ev(Events.GuildMemberAdd)(ctx(), bot);
  assert.deepEqual(await jobs(), []);
});

test('nothing is queued when state is none or the feature is off', async () => {
  for (const [cfg, enabled] of [[{ state: 'none' }, true], [{ state: 'active' }, false]]) {
    await setup(cfg, enabled);
    await ev(Events.GuildMemberAdd)(ctx(), human());
    assert.deepEqual(await jobs(), []);
  }
});

test('humans are queued while rolling out and after a failed rollout', async () => {
  for (const state of ['rolling_out', 'failed']) {
    await db.query('DELETE FROM scheduled_jobs');
    await setup({ state });
    await ev(Events.GuildMemberAdd)(ctx(), human());
    assert.equal((await jobs()).length, 1, state);
  }
});

test('a rejoin replaces the jobs (same key)', async () => {
  await setup();
  await ev(Events.GuildMemberAdd)(ctx(), human('u1', NOW - 5000));
  await ev(Events.GuildMemberAdd)(ctx(), human('u1', NOW));
  const rows = await jobs();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].due, NOW + 7200_000);
});

function verifyFixture({ failAdd = false } = {}) {
  const role = { id: 'rv', position: 1, managed: false };
  const guild = {
    id: G,
    roles: { cache: new Map([['rv', role]]), fetch: async () => role },
    members: { me: { roles: { highest: { position: 5 } } } },
  };
  const cache = new Map();
  const m = {
    id: 'u1',
    roles: {
      cache,
      add: async (rid) => { if (failAdd) throw new Error('boom'); cache.set(rid, { id: rid }); },
    },
  };
  return { guild, m };
}
const quiet = { logVerification: async () => {} };

test('successful verifyMember cancels that member jobs and a failed one does not', async () => {
  await setup({ unverifiedPolicy: 'warn_kick' });
  await ev(Events.GuildMemberAdd)(ctx(), human('u1'));
  await ev(Events.GuildMemberAdd)(ctx(), human('u2'));
  assert.equal((await jobs()).length, 4);

  const bad = verifyFixture({ failAdd: true });
  assert.equal((await verifyMember(ctx(), bad.guild, bad.m, { method: 'button' }, quiet)).ok, false);
  assert.equal((await jobs()).length, 4);

  const good = verifyFixture();
  assert.equal((await verifyMember(ctx(), good.guild, good.m, { method: 'button' }, quiet)).ok, true);
  assert.deepEqual((await jobs()).map((r) => r.key), ['u2', 'u2']);
});

test('a failing cancel never turns a successful verification into an error', async () => {
  await setup();
  const failing = {
    query: (sql, ...rest) => (/scheduled_jobs/.test(sql) ? Promise.reject(new Error('db down')) : db.query(sql, ...rest)),
  };
  const { guild, m } = verifyFixture();
  const result = await verifyMember({ db: failing, client: {} }, guild, m, { method: 'button' }, quiet);
  assert.equal(result.ok, true);
});

test('GuildMemberRemove cancels the member jobs', async () => {
  await setup({ unverifiedPolicy: 'warn_kick' });
  await ev(Events.GuildMemberAdd)(ctx(), human('u1'));
  await ev(Events.GuildMemberAdd)(ctx(), human('u2'));
  await ev(Events.GuildMemberRemove)(ctx(), { id: 'u1', guild: { id: G }, user: { bot: false } });
  assert.deepEqual((await jobs()).map((r) => r.key), ['u2', 'u2']);
});

test('GuildMemberRemove never throws on a partial member', async () => {
  await ev(Events.GuildMemberRemove)({ db: null }, { id: 'u1' });
  await ev(Events.GuildMemberRemove)(ctx(), undefined);
});

const cmd = createVerificationCommand();
function interaction(sub, options = {}) {
  const replies = [];
  const guild = { id: G, channels: { cache: new Map(), fetch: async () => null }, members: { me: { id: 'bot1' } } };
  return {
    replies, guild, guildId: G, user: { id: 'admin' },
    member: { id: 'admin', guild: { id: G }, permissions: { has: () => true }, roles: { cache: new Map(), highest: { position: 10 } } },
    inGuild: () => true,
    options: { getSubcommand: () => sub, getSubcommandGroup: () => null, getString: (n) => options[n] ?? null },
    reply: async (p) => { replies.push(p); },
    deferReply: async () => {},
    editReply: async (p) => { replies.push(p); },
  };
}

async function seedTwo() {
  await setup({ unverifiedPolicy: 'warn_kick' });
  await ev(Events.GuildMemberAdd)(ctx(), human('u1'));
  await ev(Events.GuildMemberAdd)(ctx(), human('u2'));
  assert.equal((await jobs()).length, 4);
}

test('policy none cancels all queued warn and kick jobs', async () => {
  await seedTwo();
  await cmd.execute(interaction('unverified', { policy: 'none' }), ctx());
  assert.deepEqual(await jobs(), []);
});

test('/verification remove cancels all queued warn and kick jobs', async () => {
  await seedTwo();
  await cmd.execute(interaction('remove'), ctx());
  assert.equal((await getFeature(db, G, 'verification')).config.state, 'none');
  assert.deepEqual(await jobs(), []);
});

test('changing kick to warn_kick leaves queued jobs untouched', async () => {
  await setup();
  await ev(Events.GuildMemberAdd)(ctx(), human('u1'));
  const before = await jobs();
  await cmd.execute(interaction('unverified', { policy: 'warn_kick' }), ctx());
  assert.equal((await getFeature(db, G, 'verification')).config.unverifiedPolicy, 'warn_kick');
  assert.deepEqual(await jobs(), before);
});

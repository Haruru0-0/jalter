import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { Events } from 'discord.js';
import { testDb } from '../helpers/db.js';
import { setFeature } from '../../src/db/settings.js';
import { createEvents } from '../../src/features/antiraid/events.js';
import { createJoinStore } from '../../src/features/antiraid/joins.js';

let db;
before(async () => { db = await testDb(); });
beforeEach(async () => {
  await db.query('TRUNCATE guild_settings');
});
after(async () => { await db.end?.(); });

const G = 'g1';
const NOW = 1_700_000_000_000;
const DAY = 86400 * 1000;

function makeMember({ id, bot = false, createdAt = NOW - 1000 } = {}) {
  return {
    id,
    guild: {
      id: G,
      members: { me: { id: 'bot1', guild: { id: G }, roles: { highest: { position: 10 } }, permissions: { has: () => true } } },
    },
    user: { id, bot, createdTimestamp: createdAt },
    roles: { cache: new Map(), highest: { position: 1 } },
    permissions: { has: () => false },
  };
}

// The detector with the lockdown engine behind it replaced by a fake, so the test only sees
// the decisions of the detector. The young-join kick is the real one.
function makeEvents(overrides = {}) {
  const calls = { starts: [], kicked: [], swept: 0 };
  const store = overrides.joins ?? createJoinStore();
  let clock = NOW;
  const deps = {
    joins: store,
    now: () => clock,
    startSweep: (s) => { calls.swept += 1; assert.equal(s, store); },
    startLockdown: async (ctx, guild, options) => {
      calls.starts.push({ guild, options });
      return { ok: true, kicked: 0 };
    },
    runAction: async (ctx, params) => {
      calls.kicked.push(params);
      return { ok: true, modCase: { number: calls.kicked.length }, warnings: [] };
    },
    ...overrides,
  };
  const events = createEvents(deps);
  const handler = events.find((e) => e.name === Events.GuildMemberAdd).execute;
  return {
    handler,
    calls,
    store,
    deps,
    setClock: (value) => { clock = value; },
  };
}

const ctx = () => ({
  db,
  client: { guilds: { cache: new Map([[G, { id: G, members: { me: { id: 'bot1', roles: { highest: { position: 10 } } } } }]]) } },
});

test('the Nth human join inside the window starts one lockdown with the recent joins as candidates', async () => {
  await setFeature(db, G, 'antiraid', { enabled: true, config: { joins: 3, windowSeconds: 60 } });
  const { handler, calls, store } = makeEvents();
  await handler(ctx(), makeMember({ id: 'u1' }));
  await handler(ctx(), makeMember({ id: 'u2' }));
  assert.equal(calls.starts.length, 0, 'nothing before the threshold');
  await handler(ctx(), makeMember({ id: 'u3' }));
  assert.equal(calls.starts.length, 1);
  const start = calls.starts[0];
  assert.equal(start.options.trigger, 'auto');
  assert.equal(start.options.startedBy, 'auto');
  assert.equal(start.options.joinedCount, 3);
  assert.deepEqual(start.options.candidates.map((c) => c.userId), ['u1', 'u2', 'u3']);
  assert.equal(store.size(), 3);
});

test('joins outside the window do not add up', async () => {
  await setFeature(db, G, 'antiraid', { enabled: true, config: { joins: 3, windowSeconds: 60 } });
  const { handler, calls, setClock } = makeEvents();
  await handler(ctx(), makeMember({ id: 'u1' }));
  await handler(ctx(), makeMember({ id: 'u2' }));
  // The clock moves past the window: the first joins do not count any more.
  setClock(NOW + 120_000);
  await handler(ctx(), makeMember({ id: 'u3' }));
  assert.equal(calls.starts.length, 0);
  assert.equal(calls.starts.length, 0, 'the old joins fell out of the window');
});

test('bots are not counted', async () => {
  await setFeature(db, G, 'antiraid', { enabled: true, config: { joins: 3, windowSeconds: 60 } });
  const { handler, calls, store } = makeEvents();
  for (const id of ['b1', 'b2', 'b3']) await handler(ctx(), makeMember({ id, bot: true }));
  assert.equal(calls.starts.length, 0);
  assert.equal(store.size(), 0);
});

test('a disabled feature counts nothing and starts nothing', async () => {
  await setFeature(db, G, 'antiraid', { enabled: false, config: { joins: 3, windowSeconds: 60 } });
  const { handler, calls, store } = makeEvents();
  for (const id of ['u1', 'u2', 'u3']) await handler(ctx(), makeMember({ id }));
  assert.equal(calls.starts.length, 0);
  assert.equal(store.size(), 0);
});

test('a member without a guild is ignored', async () => {
  await setFeature(db, G, 'antiraid', { enabled: true, config: { joins: 3, windowSeconds: 60 } });
  const { handler, calls } = makeEvents();
  await handler(ctx(), { id: 'u1', user: { bot: false, createdTimestamp: NOW } });
  assert.equal(calls.starts.length, 0);
});

test('while locked a young join is kicked and an old join is left alone, and neither is counted', async () => {
  await setFeature(db, G, 'antiraid', {
    enabled: true, config: { joins: 3, windowSeconds: 60, state: 'locked' },
  });
  const { handler, calls, store } = makeEvents();
  await handler(ctx(), makeMember({ id: 'young' }));
  await handler(ctx(), makeMember({ id: 'old', createdAt: NOW - 30 * DAY }));
  assert.equal(calls.kicked.length, 1, 'only the young account is kicked');
  assert.equal(calls.kicked[0].targetId, 'young');
  assert.equal(store.size(), 0, 'neither is counted');
  assert.equal(calls.starts.length, 0);
});

test('a join that loses the start race is kicked', async () => {
  await setFeature(db, G, 'antiraid', { enabled: true, config: { joins: 3, windowSeconds: 60 } });
  const kicked = [];
  const { handler } = makeEvents({
    startLockdown: async () => ({ ok: false, reason: 'already_locked' }),
    kickYoungJoin: async (c, guild, member) => { kicked.push(member.id); },
  });
  await handler(ctx(), makeMember({ id: 'u1' }));
  await handler(ctx(), makeMember({ id: 'u2' }));
  assert.deepEqual(kicked, [], 'nothing before the threshold');
  await handler(ctx(), makeMember({ id: 'u3' }));
  assert.deepEqual(kicked, ['u3']);
});

test('an expired lock is ended on the next join, which then counts as idle', async () => {
  await setFeature(db, G, 'antiraid', {
    enabled: true,
    config: { joins: 3, windowSeconds: 60, state: 'locked', lockedUntil: NOW - 1000 },
  });
  const ends = [];
  const kicked = [];
  const { handler, calls, store } = makeEvents({
    endLockdown: async (c, guild, options) => { ends.push(options); return { ok: true }; },
    kickYoungJoin: async (c, guild, member) => { kicked.push(member.id); },
  });
  await handler(ctx(), makeMember({ id: 'u1' }));
  assert.equal(ends.length, 1);
  assert.equal(ends[0].by, 'timer');
  assert.equal(ends[0].lockedUntil, NOW - 1000, 'only the expired lockdown it saw is ended');
  assert.equal(kicked.length, 0);
  assert.equal(store.size(), 1, 'the join is counted');
  assert.equal(calls.starts.length, 0);
});

test('a live lock still kicks and does not end', async () => {
  await setFeature(db, G, 'antiraid', {
    enabled: true,
    config: { joins: 3, windowSeconds: 60, state: 'locked', lockedUntil: NOW + 60_000 },
  });
  const ends = [];
  const kicked = [];
  const { handler, store } = makeEvents({
    endLockdown: async (c, guild, options) => { ends.push(options); return { ok: true }; },
    kickYoungJoin: async (c, guild, member) => { kicked.push(member.id); },
  });
  await handler(ctx(), makeMember({ id: 'u1' }));
  assert.equal(ends.length, 0);
  assert.deepEqual(kicked, ['u1']);
  assert.equal(store.size(), 0);
});

test('after the lockdown ends the same burst does not start a new one', async () => {
  await setFeature(db, G, 'antiraid', { enabled: true, config: { joins: 3, windowSeconds: 60 } });
  const store = createJoinStore();
  const { handler, calls } = makeEvents({ joins: store });
  await handler(ctx(), makeMember({ id: 'u1' }));
  await handler(ctx(), makeMember({ id: 'u2' }));
  await handler(ctx(), makeMember({ id: 'u3' }));
  assert.equal(calls.starts.length, 1);

  // The lockdown ends: the join list is cleared, so the same burst cannot start a new one.
  store.clear(G);
  await handler(ctx(), makeMember({ id: 'u4' }));
  assert.equal(calls.starts.length, 1);
  assert.equal(store.size(), 1);
});

test('the sweep is started on the first handled join', async () => {
  await setFeature(db, G, 'antiraid', { enabled: true, config: { joins: 5, windowSeconds: 60 } });
  const { handler, calls } = makeEvents();
  await handler(ctx(), makeMember({ id: 'u1' }));
  assert.equal(calls.swept, 1);
});

test('a handler error never throws', async (t) => {
  await setFeature(db, G, 'antiraid', { enabled: true, config: { joins: 3, windowSeconds: 60 } });
  const warn = t.mock.method(console, 'warn', () => {});
  const { handler } = makeEvents({
    startLockdown: async () => { throw new Error('boom'); },
  });
  for (const id of ['u1', 'u2', 'u3']) await handler(ctx(), makeMember({ id }));
  assert.equal(warn.mock.callCount(), 1);
  warn.mock.restore();
});

test('the antiraid module registers the member add event and the end job', async () => {
  const { modules } = await import('../../src/modules.js');
  const { collectModules } = await import('../../src/core/loader.js');
  const registry = collectModules(modules);
  assert.ok(registry.events.some((e) => e.name === Events.GuildMemberAdd));
  assert.ok(registry.jobs.has('antiraid.end'));
});

test('an end that throws on an expired lock never throws out of the handler', async (t) => {
  await setFeature(db, G, 'antiraid', {
    enabled: true,
    config: { joins: 3, windowSeconds: 60, state: 'locked', lockedUntil: NOW - 1000 },
  });
  const warn = t.mock.method(console, 'warn', () => {});
  const kicked = [];
  const { handler, calls } = makeEvents({
    endLockdown: async () => { throw new Error('boom'); },
    kickYoungJoin: async (c, guild, member) => { kicked.push(member.id); },
  });
  await handler(ctx(), makeMember({ id: 'u1' }));
  assert.equal(warn.mock.callCount(), 1);
  assert.deepEqual(kicked, []);
  assert.equal(calls.starts.length, 0);
});

for (const reason of ['disabled', 'schedule_failed']) {
  test(`a start that returns ${reason} kicks nobody`, async () => {
    await setFeature(db, G, 'antiraid', { enabled: true, config: { joins: 3, windowSeconds: 60 } });
    const kicked = [];
    let starts = 0;
    const { handler } = makeEvents({
      startLockdown: async () => { starts += 1; return { ok: false, reason }; },
      kickYoungJoin: async (c, guild, member) => { kicked.push(member.id); },
    });
    for (const id of ['u1', 'u2', 'u3']) await handler(ctx(), makeMember({ id }));
    assert.equal(starts, 1);
    assert.deepEqual(kicked, []);
  });
}

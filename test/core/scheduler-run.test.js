import { test, before, after, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import {
  CLAIM_MS, MAX_ATTEMPTS, BACKOFF_MS, scheduleJob, claimDue, runDueJobs, startScheduler,
} from '../../src/core/scheduler.js';
import { testDb } from '../helpers/db.js';

const NOW = Date.UTC(2026, 0, 1, 12, 0, 0);
let db;
before(async () => { db = await testDb(); });
after(async () => { await db.end(); });
beforeEach(async () => { await db.query('TRUNCATE scheduled_jobs RESTART IDENTITY'); });

const count = async () => Number((await db.query('SELECT count(*) FROM scheduled_jobs')).rows[0].count);
const ctx = (extra = {}) => ({ db, client: { isReady: () => true }, ...extra });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function withWarnings(fn) {
  const warnings = [];
  const spy = mock.method(console, 'warn', (...a) => { warnings.push(a.join(' ')); });
  try {
    await fn(warnings);
  } finally {
    spy.mock.restore();
  }
}

test('a handler that returns completes the job', async () => {
  await scheduleJob(db, { guildId: 'g', type: 'ok', key: 'k', payload: { x: 1 }, dueAt: NOW });
  const seen = [];
  const jobs = new Map([['ok', async (c, job) => { seen.push([c, job]); }]]);
  const c = ctx();
  await runDueJobs(c, { jobs, housekeeping: [] }, { now: NOW });
  assert.equal(seen.length, 1);
  assert.equal(seen[0][0], c);
  assert.equal(seen[0][1].guildId, 'g');
  assert.deepEqual(seen[0][1].payload, { x: 1 });
  assert.equal(await count(), 0);
});

test('a handler that throws is retried later and dropped after 5 attempts', async () => {
  await scheduleJob(db, { guildId: 'g', type: 'bad', key: 'k', dueAt: NOW });
  let calls = 0;
  const jobs = new Map([['bad', async () => { calls += 1; throw new Error('nope'); }]]);
  await withWarnings(async (warnings) => {
    let now = NOW;
    for (let i = 0; i < MAX_ATTEMPTS; i += 1) {
      await runDueJobs(ctx(), { jobs, housekeeping: [] }, { now });
      if (i < MAX_ATTEMPTS - 1) {
        assert.equal(await count(), 1);
        await runDueJobs(ctx(), { jobs, housekeeping: [] }, { now: now + BACKOFF_MS[i] - 1 });
        assert.equal(calls, i + 1, 'not due again before the backoff elapses');
        now += BACKOFF_MS[i];
      }
    }
    assert.equal(calls, MAX_ATTEMPTS);
    assert.equal(await count(), 0);
    assert.equal(warnings.length, MAX_ATTEMPTS);
    assert.match(warnings[0], /bad.*g.*nope/);
    assert.match(warnings[MAX_ATTEMPTS - 1], /dropp/i);
    await runDueJobs(ctx(), { jobs, housekeeping: [] }, { now: now + 10 * 3600000 });
    assert.equal(calls, MAX_ATTEMPTS);
  });
});

test('a job claimed by a crashed run is run again after the claim expires', async () => {
  await scheduleJob(db, { guildId: 'g', type: 'crash', key: 'k', dueAt: NOW });
  const [claimed] = await claimDue(db, NOW, { types: ['crash'] });
  assert.equal(claimed.attempts, 1);
  let seen;
  const jobs = new Map([['crash', async (c, job) => { seen = job; }]]);
  await runDueJobs(ctx(), { jobs, housekeeping: [] }, { now: NOW + CLAIM_MS - 1 });
  assert.equal(seen, undefined);
  await runDueJobs(ctx(), { jobs, housekeeping: [] }, { now: NOW + CLAIM_MS });
  assert.equal(seen.attempts, 2);
  assert.equal(await count(), 0);
});

test('jobs of a type with no handler stay untouched and other jobs still run', async () => {
  await scheduleJob(db, { guildId: 'g', type: 'orphan-type', key: 'k', dueAt: NOW - 1000 });
  await scheduleJob(db, { guildId: 'g', type: 'known', key: 'k', dueAt: NOW });
  let ran = 0;
  const jobs = new Map([['known', async () => { ran += 1; }]]);
  await withWarnings(async (warnings) => {
    await runDueJobs(ctx(), { jobs, housekeeping: [] }, { now: NOW });
    await scheduleJob(db, { guildId: 'g', type: 'known', key: 'k2', dueAt: NOW });
    await runDueJobs(ctx(), { jobs, housekeeping: [] }, { now: NOW });
    assert.equal(ran, 2);
    assert.equal(warnings.filter((w) => w.includes('orphan-type')).length, 1);
  });
  const { rows } = await db.query('SELECT type, attempts, claimed_until FROM scheduled_jobs');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].type, 'orphan-type');
  assert.equal(rows[0].attempts, 0);
  assert.equal(rows[0].claimed_until, null);
});

test('housekeeping runs every tick and a throwing housekeeping function does not stop jobs', async () => {
  await scheduleJob(db, { guildId: 'g', type: 'hk', key: 'k', dueAt: NOW });
  let ran = 0;
  let good = 0;
  const nows = [];
  const jobs = new Map([['hk', async () => { ran += 1; }]]);
  const housekeeping = [
    async () => { throw new Error('hk boom'); },
    async (c, { now }) => { good += 1; nows.push(now); },
  ];
  await withWarnings(async (warnings) => {
    await runDueJobs(ctx(), { jobs, housekeeping }, { now: NOW });
    await runDueJobs(ctx(), { jobs, housekeeping }, { now: NOW + 1 });
    assert.equal(warnings.filter((w) => w.includes('hk boom')).length, 2);
  });
  assert.equal(good, 2);
  assert.deepEqual(nows, [NOW, NOW + 1]);
  assert.equal(ran, 1);
});

test('nothing runs while the client is not ready', async () => {
  await scheduleJob(db, { guildId: 'g', type: 'nr', key: 'k', dueAt: NOW });
  let ran = 0;
  let hk = 0;
  const jobs = new Map([['nr', async () => { ran += 1; }]]);
  const housekeeping = [async () => { hk += 1; }];
  await runDueJobs(ctx({ client: { isReady: () => false } }), { jobs, housekeeping }, { now: NOW });
  assert.equal(ran, 0);
  assert.equal(hk, 0);
  const { rows } = await db.query('SELECT attempts, claimed_until FROM scheduled_jobs');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].attempts, 0);
  assert.equal(rows[0].claimed_until, null);
});

test('one throwing handler does not stop the next job in the batch', async () => {
  await scheduleJob(db, { guildId: 'g', type: 'multi', key: 'a', dueAt: NOW - 2 });
  await scheduleJob(db, { guildId: 'g', type: 'multi', key: 'b', dueAt: NOW - 1 });
  const order = [];
  const jobs = new Map([['multi', async (c, job) => {
    order.push(job.key);
    if (job.key === 'a') throw new Error('first fails');
  }]]);
  await withWarnings(async () => {
    await runDueJobs(ctx(), { jobs, housekeeping: [] }, { now: NOW });
  });
  assert.deepEqual(order, ['a', 'b']);
  const { rows } = await db.query('SELECT key FROM scheduled_jobs');
  assert.deepEqual(rows.map((r) => r.key), ['a']);
});

test('startScheduler ticks on an interval, does not overlap slow ticks and survives a failing tick', async () => {
  let starts = 0;
  let release;
  const gate = new Promise((r) => { release = r; });
  const slowDb = {
    query: async (sql, params) => {
      if (sql.includes('UPDATE scheduled_jobs')) {
        starts += 1;
        if (starts === 1) await gate;
      }
      return db.query(sql, params);
    },
  };
  const jobs = new Map([['slow', async () => {}]]);
  const sched = startScheduler({ db: slowDb, client: { isReady: () => true } }, { jobs, housekeeping: [] }, { intervalMs: 10 });
  await sleep(80);
  assert.equal(starts, 1, 'ticks while the first run is blocked do not start another');
  release();
  await sleep(80);
  assert.ok(starts > 1, 'a later tick starts a new run');
  sched.stop();
  await sleep(30);
  const settled = starts;
  await sleep(60);
  assert.equal(starts, settled, 'no runs start after stop');
});

test('startScheduler keeps ticking after a tick fails', async () => {
  let calls = 0;
  const badDb = { query: async () => { calls += 1; throw new Error('db down'); } };
  const jobs = new Map([['x', async () => {}]]);
  await withWarnings(async (warnings) => {
    const sched = startScheduler({ db: badDb, client: { isReady: () => true } }, { jobs, housekeeping: [] }, { intervalMs: 10 });
    await sleep(80);
    sched.stop();
    assert.ok(calls > 1, 'keeps ticking after a failure');
    assert.ok(warnings.length >= 1);
  });
});

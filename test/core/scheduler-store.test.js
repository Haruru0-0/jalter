import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  CLAIM_MS, MAX_ATTEMPTS, scheduleJob, cancelJobs, claimDue, completeJob, failJob,
  countDueOtherTypes,
} from '../../src/core/scheduler.js';
import { testDb } from '../helpers/db.js';

const NOW = Date.UTC(2026, 0, 1, 12, 0, 0);
let db;
before(async () => { db = await testDb(); });
after(async () => { await db.end(); });
beforeEach(async () => { await db.query('TRUNCATE scheduled_jobs RESTART IDENTITY'); });

const count = async () => Number((await db.query('SELECT count(*) FROM scheduled_jobs')).rows[0].count);
const dueMs = async () =>
  Number((await db.query('SELECT (EXTRACT(EPOCH FROM due_at)*1000)::bigint AS d FROM scheduled_jobs')).rows[0].d);

test('scheduling the same key twice keeps one row with the new due time and reset attempts', async () => {
  await scheduleJob(db, { guildId: 'g', type: 't', key: 'k', payload: { a: 1 }, dueAt: NOW });
  const [first] = await claimDue(db, NOW, { types: ['t'] });
  assert.equal(first.attempts, 1);
  await scheduleJob(db, { guildId: 'g', type: 't', key: 'k', payload: { a: 2 }, dueAt: NOW + 1000 });
  assert.equal(await count(), 1);
  assert.deepEqual(await claimDue(db, NOW, { types: ['t'] }), []);
  const [again] = await claimDue(db, NOW + 1000, { types: ['t'] });
  assert.equal(again.attempts, 1);
  assert.equal(again.dueAt, NOW + 1000);
  assert.deepEqual(again.payload, { a: 2 });
});

test('keyless jobs always insert a new row', async () => {
  await scheduleJob(db, { guildId: 'g', type: 't', dueAt: NOW });
  await scheduleJob(db, { guildId: 'g', type: 't', dueAt: NOW });
  assert.equal(await count(), 2);
});

test('claimDue returns only due jobs of the requested types, oldest first, and sets attempts to 1', async () => {
  await scheduleJob(db, { guildId: 'g', type: 't', key: 'late', dueAt: NOW - 10 });
  await scheduleJob(db, { guildId: 'g', type: 't', key: 'early', dueAt: NOW - 1000 });
  await scheduleJob(db, { guildId: 'g', type: 't', key: 'future', dueAt: NOW + 1 });
  await scheduleJob(db, { guildId: 'g', type: 'other', key: 'x', dueAt: NOW - 5 });
  const jobs = await claimDue(db, NOW, { types: ['t'] });
  assert.deepEqual(jobs.map((j) => j.key), ['early', 'late']);
  assert.ok(jobs.every((j) => j.attempts === 1 && j.guildId === 'g' && j.type === 't'));
  assert.equal(jobs[0].dueAt, NOW - 1000);
});

test('a claimed job is not claimed again until the claim expires, then attempts is 2', async () => {
  await scheduleJob(db, { guildId: 'g', type: 't', key: 'k', dueAt: NOW });
  assert.equal((await claimDue(db, NOW, { types: ['t'] })).length, 1);
  assert.deepEqual(await claimDue(db, NOW + CLAIM_MS - 1, { types: ['t'] }), []);
  const [job] = await claimDue(db, NOW + CLAIM_MS, { types: ['t'] });
  assert.equal(job.attempts, 2);
});

test('claimDue respects limit and skips types not requested', async () => {
  for (let i = 0; i < 5; i++) await scheduleJob(db, { guildId: 'g', type: 't', dueAt: NOW - i });
  await scheduleJob(db, { guildId: 'g', type: 'u', dueAt: NOW });
  assert.equal((await claimDue(db, NOW, { types: ['t'], limit: 3 })).length, 3);
  assert.equal((await claimDue(db, NOW, { types: ['t'] })).length, 2);
  assert.deepEqual(await claimDue(db, NOW, { types: [] }), []);
});

test('two concurrent claimDue calls return disjoint jobs', async () => {
  for (let i = 0; i < 10; i++) await scheduleJob(db, { guildId: 'g', type: 't', dueAt: NOW });
  const [a, b] = await Promise.all([
    claimDue(db, NOW, { types: ['t'], limit: 10 }),
    claimDue(db, NOW, { types: ['t'], limit: 10 }),
  ]);
  const ids = [...a, ...b].map((j) => String(j.id));
  assert.equal(new Set(ids).size, ids.length);
  assert.equal(ids.length, 10);
});

test('completeJob deletes the row', async () => {
  await scheduleJob(db, { guildId: 'g', type: 't', dueAt: NOW });
  const [job] = await claimDue(db, NOW, { types: ['t'] });
  await completeJob(db, job.id);
  assert.equal(await count(), 0);
});

test('failJob reschedules with growing backoff and clears the claim', async () => {
  await scheduleJob(db, { guildId: 'g', type: 't', key: 'k', dueAt: NOW });
  const [job] = await claimDue(db, NOW, { types: ['t'] });
  assert.equal(await failJob(db, job, NOW), 'retry');
  const row = (await db.query('SELECT claimed_until FROM scheduled_jobs')).rows[0];
  assert.equal(await dueMs(), NOW + 60000);
  assert.equal(row.claimed_until, null);
  await failJob(db, { ...job, attempts: 3 }, NOW);
  assert.equal(await dueMs(), NOW + 900000);
});

test('failJob drops the job at attempts 5', async () => {
  await scheduleJob(db, { guildId: 'g', type: 't', key: 'k', dueAt: NOW });
  let now = NOW;
  let result;
  for (let i = 0; i < MAX_ATTEMPTS; i++) {
    const [job] = await claimDue(db, now, { types: ['t'] });
    assert.equal(job.attempts, i + 1);
    result = await failJob(db, job, now);
    now += 3600000;
  }
  assert.equal(result, 'dropped');
  assert.equal(await count(), 0);
});

test('cancelJobs by key, by payload containment and by type only', async () => {
  await scheduleJob(db, { guildId: 'g', type: 't', key: 'a', payload: { roleId: 'r1', u: 1 }, dueAt: NOW });
  await scheduleJob(db, { guildId: 'g', type: 't', key: 'b', payload: { roleId: 'r2' }, dueAt: NOW });
  await scheduleJob(db, { guildId: 'g', type: 't', payload: { roleId: 'r1' }, dueAt: NOW });
  await scheduleJob(db, { guildId: 'h', type: 't', payload: { roleId: 'r1' }, dueAt: NOW });
  assert.equal(await cancelJobs(db, { guildId: 'g', type: 't', key: 'b' }), 1);
  assert.equal(await cancelJobs(db, { guildId: 'g', type: 't', payload: { roleId: 'r1' } }), 2);
  assert.equal(await count(), 1);
  await scheduleJob(db, { guildId: 'g', type: 't', key: 'c', dueAt: NOW });
  assert.equal(await cancelJobs(db, { guildId: 'g', type: 't' }), 1);
  assert.equal(await count(), 1);
});

test('countDueOtherTypes lists due types without a handler', async () => {
  await scheduleJob(db, { guildId: 'g', type: 'known', dueAt: NOW });
  await scheduleJob(db, { guildId: 'g', type: 'mystery', dueAt: NOW });
  await scheduleJob(db, { guildId: 'g', type: 'mystery', dueAt: NOW });
  await scheduleJob(db, { guildId: 'g', type: 'later', dueAt: NOW + 5 });
  assert.deepEqual(await countDueOtherTypes(db, NOW, ['known']), ['mystery']);
});

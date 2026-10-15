import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  createCase, getCase, setCaseLog, setCaseReason, listWarnings, editWarning,
  deactivateWarning, clearWarnings, topWarnings, isCurrentlyMuted,
} from '../../src/features/moderation/store.js';
import { testDb } from '../helpers/db.js';

let db;
before(async () => { db = await testDb(); });
beforeEach(async () => { await db.query('TRUNCATE mod_cases, mod_counters'); });
after(async () => { await db.end(); });

const mk = (over = {}) => createCase(db, {
  guildId: 'g1', type: 'warn', targetId: 'u1', moderatorId: 'm1', reason: 'r', ...over,
});

test('case numbers are per guild and consecutive starting at 1', async () => {
  assert.equal((await mk()).number, 1);
  assert.equal((await mk()).number, 2);
  assert.equal((await mk({ guildId: 'g2' })).number, 1);
  assert.equal((await mk()).number, 3);
});

test('createCase returns the full case', async () => {
  const c = await mk({ type: 'timeout', durationMs: 60000, endsAt: 5000 });
  assert.equal(c.guildId, 'g1');
  assert.equal(c.type, 'timeout');
  assert.equal(c.targetId, 'u1');
  assert.equal(c.moderatorId, 'm1');
  assert.equal(c.reason, 'r');
  assert.equal(c.durationMs, 60000);
  assert.equal(c.endsAt, 5000);
  assert.equal(typeof c.createdAt, 'number');
  assert.equal(c.active, true);
  assert.equal(c.logChannelId, null);
  assert.equal(c.logMessageId, null);
});

test('ten concurrent createCase calls give ten distinct consecutive numbers', async () => {
  const cases = await Promise.all(Array.from({ length: 10 }, () => mk()));
  const nums = cases.map((c) => c.number).sort((a, b) => a - b);
  assert.deepEqual(nums, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
});

test('getCase returns null for an unknown number', async () => {
  assert.equal(await getCase(db, 'g1', 99), null);
  await mk();
  assert.equal((await getCase(db, 'g1', 1)).number, 1);
  assert.equal(await getCase(db, 'g2', 1), null);
});

test('setCaseLog and setCaseReason persist, setCaseReason on a missing case is false', async () => {
  await mk();
  await setCaseLog(db, 'g1', 1, { channelId: 'c1', messageId: 'x1' });
  assert.equal(await setCaseReason(db, 'g1', 1, 'new'), true);
  const c = await getCase(db, 'g1', 1);
  assert.equal(c.logChannelId, 'c1');
  assert.equal(c.logMessageId, 'x1');
  assert.equal(c.reason, 'new');
  assert.equal(await setCaseReason(db, 'g1', 42, 'x'), false);
});

test('listWarnings returns only active warns of that user in order', async () => {
  await mk({ reason: 'a' });
  await mk({ type: 'kick', reason: 'k' });
  await mk({ targetId: 'u2', reason: 'other' });
  await mk({ reason: 'b' });
  await mk({ reason: 'c' });
  await deactivateWarning(db, 'g1', 4);
  const list = await listWarnings(db, 'g1', 'u1');
  assert.deepEqual(list.map((c) => c.reason), ['a', 'c']);
});

test('editWarning and deactivateWarning refuse non-warn and already inactive cases', async () => {
  await mk({ type: 'kick' });
  await mk();
  assert.equal(await editWarning(db, 'g1', 1, 'x'), false);
  assert.equal(await deactivateWarning(db, 'g1', 1), false);
  assert.equal(await editWarning(db, 'g1', 9, 'x'), false);
  assert.equal(await editWarning(db, 'g1', 2, 'edited'), true);
  assert.equal((await getCase(db, 'g1', 2)).reason, 'edited');
  assert.equal(await deactivateWarning(db, 'g1', 2), true);
  assert.equal((await getCase(db, 'g1', 2)).active, false);
  assert.equal(await deactivateWarning(db, 'g1', 2), false);
  assert.equal(await editWarning(db, 'g1', 2, 'again'), false);
});

test('clearWarnings deactivates all and returns the count', async () => {
  await mk();
  await mk();
  await mk({ targetId: 'u2' });
  await mk({ type: 'kick' });
  assert.equal(await clearWarnings(db, 'g1', 'u1'), 2);
  assert.equal((await listWarnings(db, 'g1', 'u1')).length, 0);
  assert.equal((await listWarnings(db, 'g1', 'u2')).length, 1);
  assert.equal(await clearWarnings(db, 'g1', 'u1'), 0);
});

test('topWarnings ranks by active count and honours limit', async () => {
  await mk({ targetId: 'a' });
  await mk({ targetId: 'b' });
  await mk({ targetId: 'b' });
  await mk({ targetId: 'b' });
  await mk({ targetId: 'c' });
  await mk({ targetId: 'c' });
  await mk({ targetId: 'd' });
  await deactivateWarning(db, 'g1', 4);
  await mk({ guildId: 'g2', targetId: 'z' });
  assert.deepEqual(await topWarnings(db, 'g1'), [
    { userId: 'b', count: 2 }, { userId: 'c', count: 2 }, { userId: 'a', count: 1 }, { userId: 'd', count: 1 },
  ].sort((x, y) => y.count - x.count || x.userId.localeCompare(y.userId)));
  const top2 = await topWarnings(db, 'g1', 2);
  assert.equal(top2.length, 2);
  assert.equal(top2[0].count, 2);
});

test('isCurrentlyMuted', async () => {
  const now = 10000;
  assert.equal(await isCurrentlyMuted(db, 'g1', 'u1', now), false);
  await mk({ type: 'mute' });
  assert.equal(await isCurrentlyMuted(db, 'g1', 'u1', now), true);
  await mk({ type: 'unmute' });
  assert.equal(await isCurrentlyMuted(db, 'g1', 'u1', now), false);
  await mk({ type: 'mute', durationMs: 1000, endsAt: 5000 });
  assert.equal(await isCurrentlyMuted(db, 'g1', 'u1', now), false);
  await mk({ type: 'mute', durationMs: 1000, endsAt: 20000 });
  assert.equal(await isCurrentlyMuted(db, 'g1', 'u1', now), true);
  assert.equal(await isCurrentlyMuted(db, 'g1', 'u2', now), false);
});

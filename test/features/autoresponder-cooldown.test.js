import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { testDb } from '../helpers/db.js';
import { resetDb } from '../../src/db/index.js';
import { createRule, deleteRule } from '../../src/features/autoresponder/store.js';
import { claimCooldown, pruneCooldowns, clearRuleCooldowns } from '../../src/features/autoresponder/cooldown.js';

let db;
before(async () => {
  db = await testDb();
});
after(async () => {
  await db.end();
});
beforeEach(async () => {
  await resetDb(db);
});

const base = {
  guildId: 'g1', trigger: 'hello', matchMode: 'contains', script: 'reply hi', compiled: { steps: [] }, createdBy: 'u1',
};
const T = 1_700_000_000_000;
const count = async () => Number((await db.query('SELECT count(*) FROM autoresponder_cooldowns')).rows[0].count);

test('first claim ok, second inside window blocked with positive retryAfterMs', async () => {
  const r = await createRule(db, base);
  assert.deepEqual(await claimCooldown(db, r.id, 'u1', 10, T), { ok: true });
  const second = await claimCooldown(db, r.id, 'u1', 10, T + 3000);
  assert.equal(second.ok, false);
  assert.equal(second.retryAfterMs, 7000);
});

test('claim is ok again after the window', async () => {
  const r = await createRule(db, base);
  await claimCooldown(db, r.id, 'u1', 10, T);
  assert.deepEqual(await claimCooldown(db, r.id, 'u1', 10, T + 10_000), { ok: true });
  assert.equal((await claimCooldown(db, r.id, 'u1', 10, T + 11_000)).ok, false);
});

test('different users and different rules do not interfere', async () => {
  const a = await createRule(db, base);
  const b = await createRule(db, { ...base, trigger: 'other' });
  assert.equal((await claimCooldown(db, a.id, 'u1', 10, T)).ok, true);
  assert.equal((await claimCooldown(db, a.id, 'u2', 10, T)).ok, true);
  assert.equal((await claimCooldown(db, b.id, 'u1', 10, T)).ok, true);
});

test('simultaneous claims give exactly one ok', async () => {
  const r = await createRule(db, base);
  for (let i = 0; i < 20; i++) {
    const user = `user${i}`;
    const results = await Promise.all([
      claimCooldown(db, r.id, user, 30, T),
      claimCooldown(db, r.id, user, 30, T),
    ]);
    assert.equal(results.filter((x) => x.ok).length, 1, `pair ${i}`);
  }
});

test('pruneCooldowns removes only expired rows and returns the count', async () => {
  const r = await createRule(db, base);
  await claimCooldown(db, r.id, 'old1', 10, T);
  await claimCooldown(db, r.id, 'old2', 10, T);
  await claimCooldown(db, r.id, 'live', 100, T);
  const removed = await pruneCooldowns({ db }, { now: T + 20_000 });
  assert.equal(removed, 2);
  assert.equal(await count(), 1);
});

test('deleting a rule cascades its cooldowns; clearRuleCooldowns clears one rule', async () => {
  const a = await createRule(db, base);
  const b = await createRule(db, { ...base, trigger: 'other' });
  await claimCooldown(db, a.id, 'u1', 10, T);
  await claimCooldown(db, b.id, 'u1', 10, T);
  await clearRuleCooldowns(db, a.id);
  assert.equal(await count(), 1);
  await deleteRule(db, 'g1', b.id);
  assert.equal(await count(), 0);
});

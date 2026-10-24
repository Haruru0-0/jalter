import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { testDb } from '../helpers/db.js';
import { resetDb } from '../../src/db/index.js';
import { setFeature } from '../../src/db/settings.js';
import {
  MAX_RULES, createRule, getRule, listRules, updateRule, deleteRule,
} from '../../src/features/autoresponder/store.js';
import { getRules, invalidate, clearCache } from '../../src/features/autoresponder/cache.js';

let db;
before(async () => {
  db = await testDb();
});
after(async () => {
  await db.end();
});
beforeEach(async () => {
  await resetDb(db);
  clearCache();
});

const compiled = { steps: [{ type: 'reply', text: 'hi' }], nested: { a: [1, 2] } };
const base = {
  guildId: 'g1', trigger: 'hello', matchMode: 'contains', script: 'reply hi', compiled, createdBy: 'u1',
};

test('createRule then getRule returns the stored fields', async () => {
  const created = await createRule(db, base);
  assert.equal(typeof created.id, 'number');
  const rule = await getRule(db, 'g1', created.id);
  assert.equal(rule.id, created.id);
  assert.equal(rule.guildId, 'g1');
  assert.equal(rule.trigger, 'hello');
  assert.equal(rule.matchMode, 'contains');
  assert.equal(rule.script, 'reply hi');
  assert.deepEqual(rule.compiled, compiled);
  assert.equal(rule.enabled, true);
  assert.equal(rule.createdBy, 'u1');
  assert.ok(rule.createdAt instanceof Date);
});

test('listRules orders by id and is per guild', async () => {
  const a = await createRule(db, base);
  await createRule(db, { ...base, guildId: 'g2', trigger: 'other' });
  const b = await createRule(db, { ...base, trigger: 'second' });
  const rules = await listRules(db, 'g1');
  assert.deepEqual(rules.map((r) => r.id), [a.id, b.id]);
  assert.equal((await listRules(db, 'g2')).length, 1);
});

test("createRule returns 'full' for the 101st rule of a guild and a second guild is unaffected", async () => {
  assert.equal(MAX_RULES, 100);
  for (let i = 0; i < MAX_RULES; i += 1) assert.equal(typeof (await createRule(db, { ...base, trigger: `t${i}` })), 'object');
  assert.equal(await createRule(db, base), 'full');
  assert.equal(typeof (await createRule(db, { ...base, guildId: 'g2' })), 'object');
});

test("two concurrent createRule calls on a guild at 99 rules produce exactly one 'full'", async () => {
  for (let i = 0; i < MAX_RULES - 1; i += 1) await createRule(db, { ...base, trigger: `t${i}` });
  const results = await Promise.all([createRule(db, base), createRule(db, base)]);
  assert.equal(results.filter((r) => r === 'full').length, 1);
  assert.equal((await listRules(db, 'g1')).length, MAX_RULES);
});

test("updateRule changes only the given keys and returns false for another guild's id", async () => {
  const { id } = await createRule(db, base);
  assert.equal(await updateRule(db, 'g1', id, { trigger: 'bye', enabled: false, compiled: { x: 1 } }), true);
  const rule = await getRule(db, 'g1', id);
  assert.deepEqual(
    [rule.trigger, rule.matchMode, rule.script, rule.enabled, rule.compiled],
    ['bye', 'contains', 'reply hi', false, { x: 1 }],
  );
  assert.equal(await updateRule(db, 'g2', id, { trigger: 'nope' }), false);
  assert.equal((await getRule(db, 'g1', id)).trigger, 'bye');
  assert.equal(await updateRule(db, 'g1', id, {}), false);
});

test('deleteRule is per guild', async () => {
  const { id } = await createRule(db, base);
  assert.equal(await deleteRule(db, 'g2', id), false);
  assert.notEqual(await getRule(db, 'g1', id), null);
  assert.equal(await deleteRule(db, 'g1', id), true);
  assert.equal(await getRule(db, 'g1', id), null);
});

test('getRules returns only enabled rules', async () => {
  await setFeature(db, 'g1', 'autoresponder', { enabled: true });
  const a = await createRule(db, base);
  const b = await createRule(db, { ...base, trigger: 'off' });
  await updateRule(db, 'g1', b.id, { enabled: false });
  assert.deepEqual((await getRules(db, 'g1')).map((r) => r.id), [a.id]);
});

test('getRules returns [] while the feature is off and the rules once it is switched on and invalidate is called', async () => {
  const a = await createRule(db, base);
  assert.deepEqual(await getRules(db, 'g1'), []);
  await setFeature(db, 'g1', 'autoresponder', { enabled: true });
  assert.deepEqual(await getRules(db, 'g1'), []);
  invalidate('g1');
  assert.deepEqual((await getRules(db, 'g1')).map((r) => r.id), [a.id]);
});

function spyQueries(target) {
  const calls = [];
  const original = target.query.bind(target);
  target.query = (...args) => {
    calls.push(args[0]);
    return original(...args);
  };
  return { calls, restore: () => { target.query = original; } };
}

test('a second getRules call does not query the database', async () => {
  await setFeature(db, 'g1', 'autoresponder', { enabled: true });
  await createRule(db, base);
  await getRules(db, 'g1');
  const spy = spyQueries(db);
  try {
    await getRules(db, 'g1');
    assert.equal(spy.calls.length, 0);
  } finally {
    spy.restore();
  }
});

test('a guild with the feature off is cached too: the second call issues no query', async () => {
  await getRules(db, 'g1');
  const spy = spyQueries(db);
  try {
    assert.deepEqual(await getRules(db, 'g1'), []);
    assert.equal(spy.calls.length, 0);
  } finally {
    spy.restore();
  }
});

test('invalidate makes the next call re-read', async () => {
  await setFeature(db, 'g1', 'autoresponder', { enabled: true });
  await createRule(db, base);
  assert.equal((await getRules(db, 'g1')).length, 1);
  await createRule(db, { ...base, trigger: 'more' });
  assert.equal((await getRules(db, 'g1')).length, 1);
  invalidate('g1');
  const spy = spyQueries(db);
  try {
    assert.equal((await getRules(db, 'g1')).length, 2);
    assert.ok(spy.calls.length > 0);
  } finally {
    spy.restore();
  }
});

test('an invalidate that lands while a load is in flight is not overwritten by the stale load', async () => {
  await setFeature(db, 'g1', 'autoresponder', { enabled: true });
  await createRule(db, base);
  const original = db.query.bind(db);
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let first = true;
  db.query = async (...args) => {
    const result = await original(...args);
    if (first && String(args[0]).includes('FROM autoresponder_rules')) {
      first = false;
      await gate;
    }
    return result;
  };
  let pending;
  try {
    pending = getRules(db, 'g1');
    await new Promise((resolve) => setTimeout(resolve, 50));
    await createRule(db, { ...base, trigger: 'new' });
    invalidate('g1');
    release();
    assert.equal((await pending).length, 1);
  } finally {
    release();
    db.query = original;
  }
  assert.equal((await getRules(db, 'g1')).length, 2);
});

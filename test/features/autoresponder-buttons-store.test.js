import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { testDb } from '../helpers/db.js';
import { resetDb } from '../../src/db/index.js';
import { createRule, deleteRule } from '../../src/features/autoresponder/store.js';
import {
  MAX_BUTTONS, createButton, getButton, listButtons, updateButton, deleteButton,
  createMessageRecord, getMessageRecord, claimPress, claimButtonCooldown, pruneButtonMessages,
} from '../../src/features/autoresponder/buttons/store.js';
import { housekeeping } from '../../src/features/autoresponder/index.js';

let db;
before(async () => { db = await testDb(); });
after(async () => { await db.end(); });
beforeEach(async () => { await resetDb(db); });

const T = 1_700_000_000_000;
const DAY = 86_400_000;
const base = {
  guildId: 'g1', name: 'one', label: 'One', emoji: null, style: 'blue', script: 'reply hi',
  compiled: { steps: [] }, invokerOnly: false, limitations: 'none', createdBy: 'u1',
};
const ruleBase = { guildId: 'g1', trigger: 'hello', matchMode: 'contains', script: 'reply hi', compiled: { steps: [] }, createdBy: 'u1' };

async function record(messageId, extra = {}) {
  const rule = extra.ruleId ? { id: extra.ruleId } : await createRule(db, { ...ruleBase, trigger: `t${messageId}` });
  await createMessageRecord(db, {
    messageId, channelId: 'c1', guildId: 'g1', ruleId: rule.id, invokerId: 'u1',
    buttons: [{ kind: 'stored', name: 'one' }, { kind: 'link', label: 'L', url: 'https://example.com' }],
    words: 'a b c', draws: { range: [4], choose: ['x'] }, expiresAt: T + 14 * DAY, ...extra,
  });
  return rule;
}

test('create/get/list/update/delete are scoped by guild', async () => {
  const b = await createButton(db, base);
  assert.equal(b.name, 'one');
  assert.equal(b.guildId, 'g1');
  assert.equal(b.invokerOnly, false);
  assert.equal(b.limitations, 'none');
  assert.deepEqual(b.compiled, { steps: [] });
  assert.ok(b.createdAt);
  await createButton(db, { ...base, guildId: 'g2' });
  assert.equal((await getButton(db, 'g1', 'one')).id, b.id);
  assert.equal(await getButton(db, 'g1', 'nope'), null);
  assert.equal((await listButtons(db, 'g1')).length, 1);
  assert.equal(await updateButton(db, 'g2', 'one', { label: 'Two', invokerOnly: true, limitations: 'strict', compiled: { steps: [1] } }), true);
  assert.equal((await getButton(db, 'g1', 'one')).label, 'One');
  const u = await getButton(db, 'g2', 'one');
  assert.deepEqual([u.label, u.invokerOnly, u.limitations, u.compiled], ['Two', true, 'strict', { steps: [1] }]);
  assert.equal(await updateButton(db, 'g1', 'nope', { label: 'x' }), false);
  assert.equal(await updateButton(db, 'g1', 'one', {}), false);
  assert.equal(await deleteButton(db, 'g1', 'one'), true);
  assert.equal(await deleteButton(db, 'g1', 'one'), false);
  assert.notEqual(await getButton(db, 'g2', 'one'), null);
});

test('duplicate name gives exists', async () => {
  await createButton(db, base);
  assert.equal(await createButton(db, base), 'exists');
  assert.equal(typeof (await createButton(db, { ...base, guildId: 'g2' })), 'object');
});

test('cap of 50 gives full, and a concurrent pair at 49 gives exactly one full', async () => {
  for (let i = 0; i < MAX_BUTTONS - 1; i++) await createButton(db, { ...base, name: `b${i}` });
  const pair = await Promise.all([createButton(db, { ...base, name: 'x' }), createButton(db, { ...base, name: 'y' })]);
  assert.equal(pair.filter((r) => r === 'full').length, 1);
  assert.equal(pair.filter((r) => typeof r === 'object').length, 1);
  assert.equal(await createButton(db, { ...base, name: 'z' }), 'full');
  assert.equal((await listButtons(db, 'g1')).length, 50);
});

test('message record round trip, null when expired', async () => {
  await record('m1');
  const r = await getMessageRecord(db, 'm1', T);
  assert.equal(r.messageId, 'm1');
  assert.equal(r.channelId, 'c1');
  assert.equal(r.guildId, 'g1');
  assert.equal(r.invokerId, 'u1');
  assert.equal(r.words, 'a b c');
  assert.equal(r.locked, false);
  assert.deepEqual(r.pressed, []);
  assert.deepEqual(r.draws, { range: [4], choose: ['x'] });
  assert.equal(r.buttons[1].url, 'https://example.com');
  assert.equal(r.expiresAt, T + 14 * DAY);
  assert.equal(await getMessageRecord(db, 'nope', T), null);
  assert.equal(await getMessageRecord(db, 'm1', T + 14 * DAY), null);
  assert.equal((await getMessageRecord(db, 'm1', T + 14 * DAY - 1)).messageId, 'm1');
});

test('deleting the rule cascades records and cooldowns', async () => {
  const rule = await record('m1');
  await claimButtonCooldown(db, 'm1', 0, 'u1', 10, T);
  await deleteRule(db, 'g1', rule.id);
  assert.equal(Number((await db.query('SELECT count(*) FROM autoresponder_button_messages')).rows[0].count), 0);
  assert.equal(Number((await db.query('SELECT count(*) FROM autoresponder_button_cooldowns')).rows[0].count), 0);
});

test('claimPress none never writes', async () => {
  await record('m1');
  assert.deepEqual(await claimPress(db, 'm1', 0, 'none', T), { ok: true });
  assert.deepEqual(await claimPress(db, 'm1', 0, 'none', T), { ok: true });
  const r = await getMessageRecord(db, 'm1', T);
  assert.deepEqual([r.locked, r.pressed], [false, []]);
});

test('claimPress limited twice: second pressed; other index independent', async () => {
  await record('m1');
  assert.deepEqual(await claimPress(db, 'm1', 0, 'limited', T), { ok: true });
  assert.deepEqual(await claimPress(db, 'm1', 0, 'limited', T), { ok: false, reason: 'pressed' });
  assert.deepEqual(await claimPress(db, 'm1', 1, 'limited', T), { ok: true });
  assert.deepEqual((await getMessageRecord(db, 'm1', T)).pressed, [0, 1]);
});

test('claimPress strict twice: second locked; later limited and none are locked', async () => {
  await record('m1');
  assert.deepEqual(await claimPress(db, 'm1', 0, 'strict', T), { ok: true });
  assert.deepEqual(await claimPress(db, 'm1', 0, 'strict', T), { ok: false, reason: 'locked' });
  assert.deepEqual(await claimPress(db, 'm1', 1, 'limited', T), { ok: false, reason: 'locked' });
  assert.deepEqual(await claimPress(db, 'm1', 2, 'none', T), { ok: false, reason: 'locked' });
  assert.equal((await getMessageRecord(db, 'm1', T)).locked, true);
});

test('claimPress gone when missing or expired', async () => {
  await record('m1');
  for (const lim of ['none', 'limited', 'strict']) {
    assert.deepEqual(await claimPress(db, 'nope', 0, lim, T), { ok: false, reason: 'gone' });
    assert.deepEqual(await claimPress(db, 'm1', 0, lim, T + 15 * DAY), { ok: false, reason: 'gone' });
  }
  assert.deepEqual((await getMessageRecord(db, 'm1', T)).pressed, []);
});

for (const lim of ['limited', 'strict']) {
  test(`20 simultaneous ${lim} pairs give exactly one ok per pair`, async () => {
    const ids = Array.from({ length: 20 }, (_, i) => `p${i}`);
    for (const id of ids) await record(id);
    const results = await Promise.all(ids.map((id) => Promise.all([
      claimPress(db, id, 0, lim, T), claimPress(db, id, 0, lim, T),
    ])));
    for (const pair of results) {
      assert.equal(pair.filter((x) => x.ok).length, 1);
      assert.equal(pair.filter((x) => !x.ok).length, 1);
    }
  });
}

test('claimButtonCooldown ok, running, after window, and simultaneous pair', async () => {
  await record('m1');
  assert.deepEqual(await claimButtonCooldown(db, 'm1', 0, 'u1', 10, T), { ok: true });
  const second = await claimButtonCooldown(db, 'm1', 0, 'u1', 10, T + 3000);
  assert.equal(second.ok, false);
  assert.equal(second.retryAfterMs, 7000);
  assert.deepEqual(await claimButtonCooldown(db, 'm1', 0, 'u1', 10, T + 10_000), { ok: true });
  assert.deepEqual(await claimButtonCooldown(db, 'm1', 1, 'u1', 10, T), { ok: true });
  assert.deepEqual(await claimButtonCooldown(db, 'm1', 0, 'u2', 10, T), { ok: true });
  const pair = await Promise.all([
    claimButtonCooldown(db, 'm1', 5, 'u9', 10, T), claimButtonCooldown(db, 'm1', 5, 'u9', 10, T),
  ]);
  assert.equal(pair.filter((r) => r.ok).length, 1);
});

test('pruneButtonMessages removes only expired rows and returns the count', async () => {
  const rule = await record('old1', { expiresAt: T - 1000 });
  await record('old2', { ruleId: rule.id, expiresAt: T });
  await record('new', { ruleId: rule.id, expiresAt: T + 1000 });
  assert.equal(await pruneButtonMessages({ db }, { now: T }), 2);
  assert.equal((await db.query('SELECT message_id FROM autoresponder_button_messages')).rows.length, 1);
  assert.equal(await pruneButtonMessages({ db }, { now: T }), 0);
});

test('housekeeping includes pruneButtonMessages', () => {
  assert.ok(housekeeping.includes(pruneButtonMessages));
});

test('a strict claim that wrote nothing but finds an open message is refused', async () => {
  const stub = {
    query: async (sql) => (/^\s*UPDATE/.test(sql) ? { rows: [] } : { rows: [{ locked: false, pressed: [] }] }),
  };
  assert.deepEqual(await claimPress(stub, 'm', 0, 'strict', T), { ok: false, reason: 'locked' });
});

test('updateButton ignores inherited keys and undefined values', async () => {
  await createButton(db, base);
  assert.equal(await updateButton(db, 'g1', 'one', { constructor: 'x', toString: 'y' }), false);
  assert.equal(await updateButton(db, 'g1', 'one', { label: undefined, style: undefined }), false);
  assert.equal(await updateButton(db, 'g1', 'one', { label: undefined, style: 'red' }), true);
  const b = await getButton(db, 'g1', 'one');
  assert.deepEqual([b.label, b.style], ['One', 'red']);
});

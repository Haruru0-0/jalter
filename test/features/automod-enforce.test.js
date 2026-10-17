import { test, before, after, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { testDb } from '../helpers/db.js';
import { resetDb } from '../../src/db/index.js';
import { listHistory } from '../../src/features/automod/history.js';
import { readConfig } from '../../src/features/automod/config.js';
import { createStrikeStore } from '../../src/features/automod/strikes.js';
import { enforce } from '../../src/features/automod/enforce.js';

let db;
before(async () => { db = await testDb(); });
after(async () => { await db.end(); });
beforeEach(async () => { await resetDb(db); });

const G = 'g1';
const guild = { id: G, members: { me: { id: 'bot' } } };
const member = { id: 'u1' };

function setup(over = {}) {
  const calls = { runAction: [], sendLog: [] };
  const deps = {
    runAction: async (ctx, p) => {
      calls.runAction.push(p);
      if (over.runActionThrows) throw new Error('boom');
      return { ok: true, modCase: { number: 7 }, warnings: [] };
    },
    sendLog: async (ctx, gid, event, embed) => { calls.sendLog.push({ gid, event, embed }); return null; },
    addHistory: over.addHistory,
    now: () => 1_000_000,
  };
  if (!deps.addHistory) delete deps.addHistory;
  const autoConfig = readConfig({ rules: { words: { enabled: true, steps: [{ strikes: 2, action: 'warn' }] } } });
  const strikes = createStrikeStore();
  const run = (message, findings = [{ rule: 'words', reason: 'bad word' }], who = member) =>
    enforce({ db }, { guild, member: who, message, findings, autoConfig, modConfig: {}, lang: 'en', deps, strikes });
  return { calls, run, strikes };
}

test('enforce with a null message does not try to delete', async () => {
  const s = setup();
  await s.run(null);
  assert.equal(s.calls.sendLog.length, 1);
  const rows = await listHistory(db, G);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].messageId, null);
  assert.deepEqual(rows[0].actions, []);
});

test('enforce warns at the threshold using the findings\' rules', async () => {
  const s = setup();
  await s.run(null);
  assert.equal(s.calls.runAction.length, 0);
  await s.run(null);
  assert.equal(s.calls.runAction.length, 1);
  assert.equal(s.calls.runAction[0].type, 'warn');
  assert.equal(s.calls.runAction[0].targetId, 'u1');
  const rows = await listHistory(db, G);
  assert.deepEqual(rows[0].rules, ['words']);
  assert.equal(rows[0].caseNumber, 7);
});

test('enforce never throws when runAction rejects', async (t) => {
  const warn = mock.method(console, 'warn', () => {});
  t.after(() => warn.mock.restore());
  const s = setup({ runActionThrows: true });
  await s.run(null);
  await s.run(null);
  assert.equal(s.calls.runAction.length, 1);
  assert.equal(s.calls.sendLog.length, 2);
  const rows = await listHistory(db, G);
  assert.equal(rows.length, 2);
  assert.deepEqual(rows[0].actions, []);
  assert.equal(rows[0].caseNumber, null);
});

test('enforce deletes a non-null message when the rule deletes', async () => {
  const s = setup();
  const del = mock.fn(async () => {});
  await s.run({ id: 'm9', channelId: 'c1', delete: del });
  assert.equal(del.mock.callCount(), 1);
  const rows = await listHistory(db, G);
  assert.deepEqual(rows[0].actions, ['delete']);
  assert.equal(rows[0].messageId, 'm9');
});

test('enforce passes a falsy target and still creates a case when the member is gone', async () => {
  const s = setup();
  const message = { id: 'm1', channelId: 'c1', author: { id: 'u1' }, delete: async () => {} };
  await s.run(message, undefined, null);
  await s.run(message, undefined, null);
  assert.equal(s.calls.runAction.length, 1);
  assert.equal(s.calls.runAction[0].target, undefined);
  assert.equal(s.calls.runAction[0].targetId, 'u1');
  assert.equal((await listHistory(db, G))[0].caseNumber, 7);
});

test('enforce skips a finding whose rule is not configured', async () => {
  const s = setup();
  await s.run(null, [{ rule: 'nope', reason: 'x' }, { rule: 'words', reason: 'y' }]);
  assert.deepEqual((await listHistory(db, G))[0].rules, ['words']);
});

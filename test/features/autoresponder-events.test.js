import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { Events } from 'discord.js';
import { testDb } from '../helpers/db.js';
import { resetDb } from '../../src/db/index.js';
import { setFeature } from '../../src/db/settings.js';
import { createRule, deleteRule } from '../../src/features/autoresponder/store.js';
import { clearCache, invalidate } from '../../src/features/autoresponder/cache.js';
import { createEvents, events } from '../../src/features/autoresponder/events.js';
import { chooseRule } from '../../src/features/autoresponder/match.js';
import { beginOutcome, markActed, finishOutcome } from '../../src/core/message-outcome.js';

let db;
before(async () => { db = await testDb(); });
after(async () => { await db.end(); });
beforeEach(async () => {
  await resetDb(db);
  clearCache();
});

const flags = (over = {}) => ({ silent: false, dm: false, delete: false, embed: null, sendTo: null, deleteReplyAfter: null, ...over });
const compiled = (over = {}) => ({ gates: [], template: [{ t: 'text', v: 'hi' }], flags: flags(), actions: [], ...over });
const base = { guildId: 'g1', trigger: 'hello', matchMode: 'includes', script: 'hi', compiled: compiled(), createdBy: 'u1' };
const enable = () => setFeature(db, 'g1', 'autoresponder', { enabled: true });

let seq = 0;
function fakeMessage(over = {}) {
  seq += 1;
  const member = over.member === undefined
    ? { id: 'u2', roles: { cache: new Map() }, permissions: { has: () => false } }
    : over.member;
  const guild = { id: 'g1', name: 'G', members: { fetch: async () => member }, memberCount: 3, iconURL: () => null };
  return {
    id: `msg-${seq}`,
    content: 'hello there',
    channelId: 'c1',
    guild,
    guildId: 'g1',
    member,
    webhookId: null,
    system: false,
    author: { id: 'u2', bot: false, username: 'bob', createdTimestamp: 1, displayAvatarURL: () => 'http://a', tag: 'bob' },
    ...over,
  };
}

function build(over = {}) {
  const calls = { exec: [], notice: [], logError: [], choose: 0 };
  const deps = {
    executePlan: async (ctx, args) => { calls.exec.push(args); return { errors: over.errors ?? [] }; },
    sendGateNotice: async (ctx, msg, lang, info) => { calls.notice.push(info); },
    logRunError: async (ctx, guild, lang, info) => { calls.logError.push(info); },
    chooseRule: (...a) => { calls.choose += 1; return chooseRule(...a); },
    ...over.deps,
  };
  const [event] = createEvents(deps);
  const ctx = { db: over.db ?? db, client: { user: { id: 'bot' } } };
  return { calls, run: (msg) => event.execute(ctx, msg), event };
}

test('exports one MessageCreate event', () => {
  assert.equal(events.length, 1);
  assert.equal(events[0].name, Events.MessageCreate);
});

test('bot, webhook, system, DM and own messages never reach chooseRule', async () => {
  await enable();
  await createRule(db, base);
  const h = build();
  await h.run(fakeMessage({ author: { id: 'x', bot: true } }));
  await h.run(fakeMessage({ webhookId: 'w1' }));
  await h.run(fakeMessage({ system: true }));
  await h.run(fakeMessage({ guild: null }));
  await h.run(fakeMessage({ author: { id: 'bot', bot: false } }));
  assert.equal(h.calls.choose, 0);
  assert.equal(h.calls.exec.length, 0);
});

test('feature off or no rules: no db read after the first cached one, nothing executes', async () => {
  let queries = 0;
  const spy = { query: (...a) => { queries += 1; return db.query(...a); } };
  const h = build({ db: spy });
  await h.run(fakeMessage());
  const after1 = queries;
  await h.run(fakeMessage());
  await h.run(fakeMessage());
  assert.equal(queries, after1);
  assert.equal(h.calls.exec.length, 0);
  assert.equal(h.calls.choose, 0);
  // enabled but without rules
  await enable();
  invalidate('g1');
  queries = 0;
  await h.run(fakeMessage());
  const after2 = queries;
  await h.run(fakeMessage());
  assert.equal(queries, after2);
  assert.equal(h.calls.exec.length, 0);
});

test('no matching rule does nothing', async () => {
  await enable();
  await createRule(db, base);
  const h = build();
  await h.run(fakeMessage({ content: 'goodbye' }));
  assert.equal(h.calls.exec.length, 0);
});

test('a matching rule runs executePlan once with the chosen rule and the evaluated vars', async () => {
  await enable();
  const r = await createRule(db, base);
  const h = build();
  const msg = fakeMessage();
  await h.run(msg);
  assert.equal(h.calls.exec.length, 1);
  const args = h.calls.exec[0];
  assert.equal(args.rule.id, r.id);
  assert.equal(args.message, msg);
  assert.equal(args.plan.status, 'run');
  assert.equal(args.plan.text, 'hi');
  assert.equal(typeof args.vars, 'object');
  assert.equal(args.lang, 'en');
});

test('the longest trigger wins when two rules match', async () => {
  await enable();
  await createRule(db, base);
  const long = await createRule(db, { ...base, trigger: 'hello there' });
  const h = build();
  await h.run(fakeMessage());
  assert.equal(h.calls.exec.length, 1);
  assert.equal(h.calls.exec[0].rule.id, long.id);
});

test('a message auto-mod acted on is not answered', async () => {
  await enable();
  await createRule(db, base);
  const h = build();
  const msg = fakeMessage();
  beginOutcome(msg.id);
  const p = h.run(msg);
  markActed(msg.id);
  finishOutcome(msg.id);
  await p;
  assert.equal(h.calls.exec.length, 0);
});

test('a message auto-mod left clean is answered', async () => {
  await enable();
  await createRule(db, base);
  const h = build();
  const msg = fakeMessage();
  beginOutcome(msg.id);
  const p = h.run(msg);
  finishOutcome(msg.id);
  await p;
  assert.equal(h.calls.exec.length, 1);
});

const roleGate = { fn: 'requirerole', roleIds: ['r1'] };

test('a failed requirerole gate sends one notice, a second inside 30 s sends none', async () => {
  await enable();
  await createRule(db, { ...base, compiled: compiled({ gates: [roleGate] }) });
  const h = build();
  await h.run(fakeMessage());
  await h.run(fakeMessage());
  assert.equal(h.calls.exec.length, 0);
  assert.equal(h.calls.notice.length, 1);
  assert.equal(h.calls.notice[0].kind, 'role');
});

test('{silent} suppresses the role notice', async () => {
  await enable();
  await createRule(db, { ...base, compiled: compiled({ gates: [roleGate], flags: flags({ silent: true }) }) });
  const h = build();
  await h.run(fakeMessage());
  assert.equal(h.calls.notice.length, 0);
  assert.equal(h.calls.exec.length, 0);
});

test('a non-role gate failure sends no notice', async () => {
  await enable();
  await createRule(db, { ...base, compiled: compiled({ gates: [{ fn: 'requirechannel', channelIds: ['zz'] }] }) });
  const h = build();
  await h.run(fakeMessage());
  assert.equal(h.calls.notice.length, 0);
  assert.equal(h.calls.exec.length, 0);
});

const cooldownCompiled = (over = {}) => compiled({ gates: [{ fn: 'cooldown', seconds: 60 }], ...over });

test('two simultaneous messages by one member inside a cooldown run executePlan once', async () => {
  await enable();
  await createRule(db, { ...base, compiled: cooldownCompiled() });
  const h = build();
  await Promise.all([h.run(fakeMessage()), h.run(fakeMessage())]);
  assert.equal(h.calls.exec.length, 1);
  assert.equal(h.calls.notice.length, 1);
  assert.equal(h.calls.notice[0].kind, 'cooldown');
  assert.ok(h.calls.notice[0].seconds >= 1 && h.calls.notice[0].seconds <= 60);
});

test('{silent} suppresses the cooldown notice', async () => {
  await enable();
  await createRule(db, { ...base, compiled: cooldownCompiled({ flags: flags({ silent: true }) }) });
  const h = build();
  await h.run(fakeMessage());
  await h.run(fakeMessage());
  assert.equal(h.calls.exec.length, 1);
  assert.equal(h.calls.notice.length, 0);
});

test('a rule deleted mid-flight (FK error on the cooldown claim) is skipped quietly', async () => {
  await enable();
  const r = await createRule(db, { ...base, compiled: cooldownCompiled() });
  const h = build();
  await h.run(fakeMessage()); // fills the cache
  await deleteRule(db, 'g1', r.id); // the cache still holds the rule
  await h.run(fakeMessage());
  assert.equal(h.calls.exec.length, 1);
  assert.equal(h.calls.notice.length, 0);
  assert.equal(h.calls.logError.length, 0);
});

test('errors from executePlan produce one logRunError call', async () => {
  await enable();
  const r = await createRule(db, base);
  const errors = [{ code: 'CANNOT_DELETE', action: 'delete' }];
  const h = build({ errors });
  await h.run(fakeMessage());
  assert.equal(h.calls.logError.length, 1);
  assert.equal(h.calls.logError[0].ruleId, r.id);
  assert.deepEqual(h.calls.logError[0].errors, errors);
});

test('no logRunError when executePlan reports no errors', async () => {
  await enable();
  await createRule(db, base);
  const h = build();
  await h.run(fakeMessage());
  assert.equal(h.calls.logError.length, 0);
});

test('an exception inside the handler does not escape', async () => {
  await enable();
  await createRule(db, base);
  const h = build({ deps: { executePlan: async () => { throw new Error('boom'); } } });
  await assert.doesNotReject(h.run(fakeMessage()));
});

test('a failed member fetch stops quietly', async () => {
  await enable();
  await createRule(db, base);
  const h = build();
  const msg = fakeMessage({ member: null });
  msg.guild.members.fetch = async () => { throw new Error('unknown member'); };
  await h.run(msg);
  assert.equal(h.calls.exec.length, 0);
});

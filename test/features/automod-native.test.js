import { test, before, after, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Events } from 'discord.js';
import { testDb } from '../helpers/db.js';
import { resetDb } from '../../src/db/index.js';
import { getFeature, setFeature } from '../../src/db/settings.js';
import { readConfig, RULES, MAX_NATIVE_RULES } from '../../src/features/automod/config.js';
import { createNativeHandler, listNativeRules } from '../../src/features/automod/native.js';
import { createEvents } from '../../src/features/automod/events.js';
import { commands } from '../../src/features/automod/index.js';
import { statusText } from '../../src/features/automod/commands.js';
import { t } from '../../src/i18n/index.js';

let db;
before(async () => { db = await testDb(); });
after(async () => { await db.end(); });
beforeEach(async () => { await resetDb(db); });

const G = 'g1';
const R1 = '111111111111111111';
const R2 = '222222222222222222';

test('native is a rule with a warn default, no ids and no delete', () => {
  assert.ok(RULES.includes('native'));
  const n = readConfig({}).rules.native;
  assert.equal(n.enabled, false);
  assert.equal(n.delete, false);
  assert.deepEqual(n.ruleIds, []);
  assert.deepEqual(n.steps, [{ strikes: 3, action: 'warn', timeoutSeconds: null }]);
  assert.deepEqual(readConfig({ rules: { native: { ruleIds: [R1, R1, '', 5, R2] } } }).rules.native.ruleIds, [R1, R2]);
  const many = Array.from({ length: 60 }, (_, k) => String(k + 1));
  assert.equal(readConfig({ rules: { native: { ruleIds: many } } }).rules.native.ruleIds.length, MAX_NATIVE_RULES);
});

const member = (id, { perms = [] } = {}) => ({
  id,
  user: { bot: false },
  permissions: { has: (p) => perms.includes(p) },
  roles: { cache: new Set(), highest: { position: 1 } },
  guild: { id: G },
});

function setup({ members = { u1: member('u1') }, fetchMessage } = {}) {
  const calls = { runAction: [], sendLog: [], history: [], deleted: 0, fetched: 0 };
  const clock = { t: 1_000_000 };
  const guild = {
    id: G,
    ownerId: 'owner',
    members: {
      me: member('bot'),
      fetch: async (id) => { if (!members[id]) throw Object.assign(new Error('Unknown Member'), { code: 10007 }); return members[id]; },
    },
    channels: {
      cache: new Map([['c1', {
        id: 'c1',
        parentId: null,
        messages: {
          fetch: async (id) => {
            calls.fetched++;
            if (fetchMessage) return fetchMessage(id);
            return { id, channelId: 'c1', author: { id: 'u1' }, delete: async () => { calls.deleted++; } };
          },
        },
      }]]),
      fetch: async () => null,
    },
  };
  const handler = createNativeHandler({
    runAction: async (ctx, p) => { calls.runAction.push(p); return { ok: true, modCase: { number: 7 }, warnings: [] }; },
    sendLog: async (ctx, g, kind, payload) => { calls.sendLog.push(payload); return null; },
    addHistory: async (d, row) => { calls.history.push(row); },
    now: () => clock.t,
  });
  const ctx = { db, client: { user: { id: 'bot' } } };
  const exec = (o = {}) => ({
    guild, userId: 'u1', ruleId: R1, ruleTriggerType: 1, content: 'bad', matchedKeyword: 'bad',
    messageId: 'm1', channelId: 'c1', autoModerationRule: { name: 'No bad words' },
    ...o,
  });
  return { handler, ctx, calls, guild, exec, clock };
}
const enable = (native = {}, extra = {}) =>
  setFeature(db, G, 'automod', { enabled: true, config: { rules: { native: { enabled: true, ...native } }, ...extra } });

test('ignores when the rule is off', async () => {
  const s = setup();
  await setFeature(db, G, 'automod', { enabled: true, config: { rules: { native: { enabled: false, steps: [{ strikes: 1, action: 'warn' }] } } } });
  await s.handler.handle(s.ctx, s.exec());
  assert.equal(s.calls.runAction.length + s.calls.sendLog.length + s.calls.history.length, 0);
  const off = setup();
  await setFeature(db, G, 'automod', { enabled: false, config: { rules: { native: { enabled: true } } } });
  await off.handler.handle(off.ctx, off.exec());
  assert.equal(off.calls.sendLog.length + off.calls.history.length, 0);
});

test('ignores a native rule id not in the list', async () => {
  const s = setup();
  await enable({ ruleIds: [R2] });
  await s.handler.handle(s.ctx, s.exec({ ruleId: R1 }));
  assert.equal(s.calls.history.length, 0);
  await s.handler.handle(s.ctx, s.exec({ ruleId: R2 }));
  assert.equal(s.calls.history.length, 1);
});

test('an empty list reacts to all native rules', async () => {
  const s = setup();
  await enable({ ruleIds: [] });
  await s.handler.handle(s.ctx, s.exec({ ruleId: R1 }));
  await s.handler.handle(s.ctx, s.exec({ ruleId: R2 }));
  assert.equal(s.calls.history.length, 2);
  assert.deepEqual(s.calls.history[0].rules, ['native']);
});

test('the same execution twice counts once, and counts again after 5 seconds', async () => {
  const s = setup();
  await enable({ steps: [{ strikes: 2, action: 'warn' }] });
  await s.handler.handle(s.ctx, s.exec());
  await s.handler.handle(s.ctx, s.exec());
  assert.equal(s.calls.history.length, 1);
  assert.equal(s.calls.runAction.length, 0, 'one strike is below the step');
  s.clock.t += 5_001;
  await s.handler.handle(s.ctx, s.exec());
  assert.equal(s.calls.history.length, 2);
  assert.equal(s.calls.runAction.length, 1, 'the second counted strike reaches the step');
});

test('different messages or users are not de-duplicated', async () => {
  const s = setup({ members: { u1: member('u1'), u2: member('u2') } });
  await enable();
  await s.handler.handle(s.ctx, s.exec({ messageId: 'm1' }));
  await s.handler.handle(s.ctx, s.exec({ messageId: 'm2' }));
  await s.handler.handle(s.ctx, s.exec({ userId: 'u2' }));
  assert.equal(s.calls.history.length, 3);
});

test('blocked messages (no message id) are told apart by their content', async () => {
  const s = setup();
  await enable();
  // Block, Alert and Timeout events of one hit carry the same content: one strike.
  await s.handler.handle(s.ctx, s.exec({ messageId: undefined, content: 'bad one' }));
  await s.handler.handle(s.ctx, s.exec({ messageId: undefined, content: 'bad one' }));
  assert.equal(s.calls.history.length, 1);
  // A second blocked message with other content inside 5 s is a separate hit.
  await s.handler.handle(s.ctx, s.exec({ messageId: undefined, content: 'bad two' }));
  assert.equal(s.calls.history.length, 2);
  s.clock.t += 5_001;
  await s.handler.handle(s.ctx, s.exec({ messageId: undefined, content: 'bad one' }));
  assert.equal(s.calls.history.length, 3);
});

test('the de-duplication memory is pruned', async () => {
  const s = setup();
  await enable();
  for (let k = 0; k < 20; k++) await s.handler.handle(s.ctx, s.exec({ messageId: `m${k}` }));
  assert.equal(s.handler.size(), 20);
  s.clock.t += 5_001;
  await s.handler.handle(s.ctx, s.exec({ messageId: 'fresh' }));
  assert.equal(s.handler.size(), 1);
});

test('a missing message still records a strike and logs once', async () => {
  const s = setup();
  await enable({ delete: true });
  await s.handler.handle(s.ctx, s.exec({ messageId: undefined }));
  assert.equal(s.calls.fetched, 0);
  assert.equal(s.calls.sendLog.length, 1);
  assert.equal(s.calls.history.length, 1);
  assert.equal(s.calls.history[0].messageId, null);
  assert.equal(s.calls.runAction.length, 0);
  // Discord reports the message but it is already gone: same outcome
  const gone = setup({ fetchMessage: async () => { throw Object.assign(new Error('Unknown Message'), { code: 10008 }); } });
  await gone.handler.handle(gone.ctx, gone.exec());
  assert.equal(gone.calls.sendLog.length, 1);
  assert.equal(gone.calls.history.length, 1);
});

test('delete on removes the message; delete off leaves it', async () => {
  const on = setup();
  await enable({ delete: true });
  await on.handler.handle(on.ctx, on.exec());
  assert.equal(on.calls.deleted, 1);
  assert.deepEqual(on.calls.history[0].actions, ['delete']);
  const off = setup();
  await enable({ delete: false });
  await off.handler.handle(off.ctx, off.exec());
  assert.equal(off.calls.deleted, 0);
  assert.equal(off.calls.history.length, 1);
});

test('delete off still logs the channel and keeps the message id in history', async () => {
  const s = setup();
  await enable({ delete: false });
  await s.handler.handle(s.ctx, s.exec());
  assert.equal(s.calls.history[0].messageId, 'm1');
  assert.ok(s.calls.sendLog[0].description.includes('<#c1>'));
});

test('a channel the bot cannot see (Missing Access) is ignored without a warning', async () => {
  await enable({ delete: true });
  const warn = mock.method(console, 'warn', () => {});
  try {
    const s = setup({ fetchMessage: async () => { throw Object.assign(new Error('Missing Access'), { code: 50001 }); } });
    await s.handler.handle(s.ctx, s.exec());
    assert.equal(s.calls.history.length, 1);
    assert.equal(warn.mock.callCount(), 0);
  } finally {
    warn.mock.restore();
  }
});

test('a permission error while fetching or deleting is ignored', async () => {
  const denied = () => Object.assign(new Error('Missing Permissions'), { code: 50013 });
  await enable({ delete: true });
  const a = setup({ fetchMessage: async () => { throw denied(); } });
  await a.handler.handle(a.ctx, a.exec());
  assert.equal(a.calls.history.length, 1);
  const b = setup({ fetchMessage: async (id) => ({ id, channelId: 'c1', delete: async () => { throw denied(); } }) });
  await b.handler.handle(b.ctx, b.exec());
  assert.equal(b.calls.history.length, 1);
});

test('reaching the step acts on the member', async () => {
  const s = setup();
  await enable({ steps: [{ strikes: 1, action: 'timeout', timeoutSeconds: 120 }] });
  await s.handler.handle(s.ctx, s.exec());
  assert.equal(s.calls.runAction.length, 1);
  assert.equal(s.calls.runAction[0].type, 'timeout');
  assert.equal(s.calls.runAction[0].durationSeconds, 120);
  assert.equal(s.calls.runAction[0].targetId, 'u1');
});

test('a member who left is skipped', async () => {
  const s = setup({ members: {} });
  await enable();
  await s.handler.handle(s.ctx, s.exec());
  assert.equal(s.calls.history.length + s.calls.sendLog.length + s.calls.runAction.length, 0);
});

test('exempt members are skipped', async () => {
  const s = setup({ members: { u1: member('u1', { perms: ['ManageGuild'] }) } });
  await enable();
  await s.handler.handle(s.ctx, s.exec());
  assert.equal(s.calls.history.length, 0);
});

test('the handler never throws', async () => {
  const s = setup();
  await enable();
  await assert.doesNotReject(s.handler.handle(s.ctx, null));
  await assert.doesNotReject(s.handler.handle(s.ctx, { guild: null }));
  await assert.doesNotReject(s.handler.handle({ db: null }, s.exec()));
  const boom = setup();
  boom.guild.members.fetch = () => { throw new Error('boom'); };
  await assert.doesNotReject(boom.handler.handle(boom.ctx, boom.exec()));
});

const rulesGuild = (fetch) => ({ autoModerationRules: { fetch } });

test('listNativeRules returns id, name and enabled', async () => {
  const guild = rulesGuild(async () => new Map([
    [R1, { id: R1, name: 'Bad words', enabled: true, creatorId: 'x' }],
    [R2, { id: R2, name: 'Spam', enabled: false }],
  ]));
  assert.deepEqual(await listNativeRules(guild), [
    { id: R1, name: 'Bad words', enabled: true },
    { id: R2, name: 'Spam', enabled: false },
  ]);
});

test('listNativeRules without permission returns an empty list', async () => {
  const denied = rulesGuild(async () => { throw Object.assign(new Error('Missing Permissions'), { code: 50013 }); });
  assert.deepEqual(await listNativeRules(denied), []);
  assert.deepEqual(await listNativeRules({}), []);
  assert.deepEqual(await listNativeRules(null), []);
});

// ---- command ----
const cmd = commands[0];
const json = cmd.data.toJSON();

function fake(sub, { strings = {}, rules } = {}) {
  const calls = { reply: [] };
  return {
    calls,
    guildId: G,
    inGuild: () => true,
    member: { permissions: { has: () => true }, guild: { id: G }, roles: { cache: { has: () => false } } },
    guild: { id: G, ...(rules ? rulesGuild(rules) : {}) },
    options: {
      getSubcommand: () => sub,
      getSubcommandGroup: () => 'native',
      getString: (n) => strings[n] ?? null,
    },
    deferred: false,
    replied: false,
    reply: async (p) => { calls.reply.push(p); },
    editReply: async (p) => { calls.reply.push(p); },
  };
}
const text = (i) => i.calls.reply.at(-1).content;
const saved = async () => readConfig((await getFeature(db, G, 'automod')).config).rules.native;

test('structure: the native group has list, add-rule and remove-rule', () => {
  const g = json.options.find((o) => o.name === 'native');
  assert.deepEqual(g.options.map((o) => o.name), ['list', 'add-rule', 'remove-rule']);
});

test('native list command shows ids', async () => {
  const i = fake('list', { rules: async () => new Map([
    [R1, { id: R1, name: 'Bad words', enabled: true }],
    [R2, { id: R2, name: 'Spam', enabled: false }],
  ]) });
  await cmd.execute(i, { db });
  assert.ok(text(i).includes(R1));
  assert.ok(text(i).includes('Bad words'));
  assert.ok(text(i).includes(R2));
  assert.equal(i.calls.reply[0].allowedMentions.parse.length, 0);
});

test('native list with no rules or no permission says the bot needs Manage Server', async () => {
  const i = fake('list', { rules: async () => { throw Object.assign(new Error('Missing Permissions'), { code: 50013 }); } });
  await cmd.execute(i, { db });
  assert.equal(text(i), t('en', 'automod.native.none'));
  assert.ok(/Manage Server/.test(t('en', 'automod.native.none')));
});

test('add-rule stores a snowflake once, remove-rule removes it', async () => {
  const add = fake('add-rule', { strings: { id: ` ${R1} ` } });
  await cmd.execute(add, { db });
  assert.deepEqual((await saved()).ruleIds, [R1]);
  assert.equal(text(add), t('en', 'automod.native.added', { id: R1 }));
  const dup = fake('add-rule', { strings: { id: R1 } });
  await cmd.execute(dup, { db });
  assert.equal(text(dup), t('en', 'automod.native.exists'));
  assert.deepEqual((await saved()).ruleIds, [R1]);
  const rm = fake('remove-rule', { strings: { id: R1 } });
  await cmd.execute(rm, { db });
  assert.deepEqual((await saved()).ruleIds, []);
  assert.equal(text(rm), t('en', 'automod.native.removed', { id: R1 }));
  const missing = fake('remove-rule', { strings: { id: R1 } });
  await cmd.execute(missing, { db });
  assert.equal(text(missing), t('en', 'automod.native.missing'));
});

test('add-rule and remove-rule refuse anything that is not a snowflake', async () => {
  for (const id of ['abc', '12', '1'.repeat(30), '12345678901234567x', '<@123456789012345678>', '']) {
    for (const sub of ['add-rule', 'remove-rule']) {
      const i = fake(sub, { strings: { id } });
      await cmd.execute(i, { db });
      assert.equal(text(i), t('en', 'automod.native.bad_id'), `${sub} ${id}`);
    }
  }
  assert.deepEqual((await saved()).ruleIds, []);
});

test('add-rule stops at the cap', async () => {
  const ids = Array.from({ length: MAX_NATIVE_RULES }, (_, k) => String(100000000000000000n + BigInt(k)));
  await setFeature(db, G, 'automod', { enabled: true, config: { rules: { native: { ruleIds: ids } } } });
  const i = fake('add-rule', { strings: { id: R2 } });
  await cmd.execute(i, { db });
  assert.equal(text(i), t('en', 'automod.native.full', { max: MAX_NATIVE_RULES }));
  assert.equal((await saved()).ruleIds.length, MAX_NATIVE_RULES);
});

test('status shows the native rule, and its label exists in every language', () => {
  const all = statusText('en', true, readConfig({}));
  assert.ok(all.includes(t('en', 'automod.rule.native')));
  const some = statusText('en', true, readConfig({ rules: { native: { ruleIds: [R1] } } }));
  assert.ok(some.includes(R1));
  for (const lang of ['en', 'fr', 'ar']) {
    assert.notEqual(t(lang, 'automod.rule.native'), 'automod.rule.native');
    assert.notEqual(t(lang, 'automod.native.none'), 'automod.native.none');
  }
});

test('the execution event is wired to the native handler and never throws', async () => {
  const seen = [];
  const events = createEvents({ prune() {}, handleMessage: async () => {} }, { handle: async (ctx, e) => { seen.push(e); throw new Error('boom'); } });
  const ev = events.find((e) => e.name === Events.AutoModerationActionExecution);
  assert.ok(ev);
  await assert.doesNotReject(ev.execute({}, { ruleId: R1 }));
  assert.equal(seen.length, 1);
});

test('the client asks for the AutoModerationExecution intent', () => {
  const src = readFileSync(new URL('../../src/index.js', import.meta.url), 'utf8');
  assert.ok(src.includes('GatewayIntentBits.AutoModerationExecution'));
});

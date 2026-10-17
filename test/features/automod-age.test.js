import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { passesAge } from '../../src/features/automod/age.js';
import { commands } from '../../src/features/automod/index.js';
import { createEngine } from '../../src/features/automod/pipeline.js';
import { readConfig } from '../../src/features/automod/config.js';
import { getFeature, setFeature } from '../../src/db/settings.js';
import { resetDb } from '../../src/db/index.js';
import { t } from '../../src/i18n/index.js';
import { testDb } from '../helpers/db.js';

const NOW = 1_000_000_000;
const HOUR = 3600 * 1000;
const member = (accountAgeMs, joinedAgeMs) => ({
  user: { createdTimestamp: NOW - accountAgeMs },
  joinedTimestamp: NOW - joinedAgeMs,
});

test('no limits always passes', () => {
  assert.equal(passesAge(member(1e12, 1e12), { age: { accountYoungerThanSeconds: null, joinedWithinSeconds: null } }, NOW), true);
  assert.equal(passesAge(member(1e12, 1e12), {}, NOW), true);
  assert.equal(passesAge({}, { age: {} }, NOW), true);
});

test('young account passes and old account fails', () => {
  const cfg = { age: { accountYoungerThanSeconds: 86_400, joinedWithinSeconds: null } };
  assert.equal(passesAge(member(HOUR, 1e12), cfg, NOW), true);
  assert.equal(passesAge(member(48 * HOUR, 1e12), cfg, NOW), false);
  assert.equal(passesAge(member(24 * HOUR, 1e12), cfg, NOW), false);
});

test('recent joiner passes and old member fails', () => {
  const cfg = { age: { accountYoungerThanSeconds: null, joinedWithinSeconds: 3600 } };
  assert.equal(passesAge(member(1e12, 60_000), cfg, NOW), true);
  assert.equal(passesAge(member(1e12, 2 * HOUR), cfg, NOW), false);
});

test('both limits must hold', () => {
  const cfg = { age: { accountYoungerThanSeconds: 86_400, joinedWithinSeconds: 3600 } };
  assert.equal(passesAge(member(HOUR, 60_000), cfg, NOW), true);
  assert.equal(passesAge(member(HOUR, 2 * HOUR), cfg, NOW), false);
  assert.equal(passesAge(member(48 * HOUR, 60_000), cfg, NOW), false);
});

test('missing timestamps fail', () => {
  const account = { age: { accountYoungerThanSeconds: 86_400, joinedWithinSeconds: null } };
  const joined = { age: { accountYoungerThanSeconds: null, joinedWithinSeconds: 3600 } };
  assert.equal(passesAge({ joinedTimestamp: NOW }, account, NOW), false);
  assert.equal(passesAge({ user: {}, joinedTimestamp: NOW }, account, NOW), false);
  assert.equal(passesAge({ user: { createdTimestamp: NOW } }, joined, NOW), false);
  assert.equal(passesAge({ user: { createdTimestamp: NOW }, joinedTimestamp: null }, joined, NOW), false);
  assert.equal(passesAge(null, account, NOW), false);
  assert.equal(passesAge(undefined, joined, NOW), false);
});

test('config cleans age limits', () => {
  assert.deepEqual(readConfig({}).rules.spam.age, { accountYoungerThanSeconds: null, joinedWithinSeconds: null });
  const c = readConfig({ rules: { words: { age: { accountYoungerThanSeconds: 3600, joinedWithinSeconds: -5 } }, links: { age: 'x' } } });
  assert.deepEqual(c.rules.words.age, { accountYoungerThanSeconds: 3600, joinedWithinSeconds: null });
  assert.deepEqual(c.rules.links.age, { accountYoungerThanSeconds: null, joinedWithinSeconds: null });
});

let db;
before(async () => { db = await testDb(); });
after(async () => { await db.end(); });
beforeEach(async () => { await resetDb(db); });

test('pipeline skips a rule the member does not match', async () => {
  const G = 'g1';
  const runs = [];
  const engine = createEngine({
    runAction: async (ctx, p) => { runs.push(p); return { ok: true, modCase: { number: 1 }, warnings: [] }; },
    sendLog: async () => null,
    resolveInvite: async () => 'foreign',
    now: () => NOW,
  });
  await setFeature(db, G, 'automod', {
    enabled: true,
    config: { rules: { words: {
      enabled: true, custom: ['badword'], useBuiltin: false,
      steps: [{ strikes: 2, action: 'warn' }],
      age: { accountYoungerThanSeconds: 86_400, joinedWithinSeconds: null },
    } } },
  });
  const guild = { id: G, ownerId: 'owner', members: { me: { id: 'bot', permissions: { has: () => true }, roles: { cache: new Set(), highest: { position: 1 } } } } };
  const msg = (id, m) => ({
    id: 'm', content: 'badword', author: { id, bot: false }, webhookId: null, system: false, guild, guildId: G,
    channelId: 'c1', channel: { id: 'c1', parentId: null },
    member: { id, permissions: { has: () => false }, roles: { cache: new Set(), highest: { position: 1 } }, ...m },
    mentions: { users: { size: 0 }, roles: { size: 0 } }, attachments: { size: 0 }, delete: async () => {},
  });
  const ctx = { db, client: { user: { id: 'bot' } } };
  await engine.handleMessage(ctx, msg('old', member(48 * HOUR, 48 * HOUR)), {});
  await engine.handleMessage(ctx, msg('partial', {}), {});
  assert.equal(engine.strikes.size(), 0);
  await engine.handleMessage(ctx, msg('new', member(HOUR, HOUR)), {});
  assert.equal(engine.strikes.size(), 1);
});

function fake(sub, { strings = {} } = {}) {
  const calls = { reply: [] };
  return {
    calls,
    guildId: 'g1',
    inGuild: () => true,
    member: { permissions: { has: () => true }, guild: { id: 'g1' }, roles: { cache: { has: () => false } } },
    guild: { id: 'g1' },
    options: {
      getSubcommand: () => sub,
      getSubcommandGroup: () => null,
      getString: (n) => strings[n] ?? null,
      getInteger: () => null,
    },
    deferred: false,
    replied: false,
    reply: async (p) => { calls.reply.push(p); },
    editReply: async (p) => { calls.reply.push(p); },
  };
}
const run = (i) => commands[0].execute(i, { db });
const saved = async () => readConfig((await getFeature(db, 'g1', 'automod')).config);

test('age command saves and clears a limit', async () => {
  await run(fake('age', { strings: { rule: 'spam', kind: 'account', duration: '7d' } }));
  assert.equal((await saved()).rules.spam.age.accountYoungerThanSeconds, 604_800);
  await run(fake('age', { strings: { rule: 'spam', kind: 'joined', duration: '1h' } }));
  const c = await saved();
  assert.equal(c.rules.spam.age.joinedWithinSeconds, 3600);
  assert.equal(c.rules.spam.age.accountYoungerThanSeconds, 604_800);
  await run(fake('age', { strings: { rule: 'spam', kind: 'account', duration: 'off' } }));
  assert.equal((await saved()).rules.spam.age.accountYoungerThanSeconds, null);
  assert.equal((await saved()).rules.spam.age.joinedWithinSeconds, 3600);
  const bad = fake('age', { strings: { rule: 'spam', kind: 'account', duration: 'abc' } });
  await run(bad);
  assert.equal(bad.calls.reply.at(-1).content, t('en', 'automod.settings.bad_age'));
  assert.equal((await saved()).rules.spam.age.joinedWithinSeconds, 3600);
});

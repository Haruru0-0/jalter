import { test, before, after, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { testDb } from '../helpers/db.js';
import { resetDb } from '../../src/db/index.js';
import { getFeature, setFeature } from '../../src/db/settings.js';
import { readConfig, RULES } from '../../src/features/automod/config.js';
import { honeypotFinding } from '../../src/features/automod/honeypot.js';
import { createEngine } from '../../src/features/automod/pipeline.js';
import { commands } from '../../src/features/automod/index.js';
import { statusText } from '../../src/features/automod/commands.js';
import { t } from '../../src/i18n/index.js';

let db;
before(async () => { db = await testDb(); });
after(async () => { await db.end(); });
beforeEach(async () => { await resetDb(db); });

const G = 'g1';
const TRAP = 'trap';
const cfgWith = (over = {}) => readConfig({ rules: { honeypot: { enabled: true, channelId: TRAP, ...over } } });

test('honeypot is a rule with a one-strike timeout default and no channel', () => {
  assert.ok(RULES.includes('honeypot'));
  const h = readConfig({}).rules.honeypot;
  assert.equal(h.enabled, false);
  assert.equal(h.channelId, null);
  assert.equal(h.delete, true);
  assert.deepEqual(h.steps, [{ strikes: 1, action: 'timeout', timeoutSeconds: 600 }]);
  assert.equal(readConfig({ rules: { honeypot: { channelId: 5 } } }).rules.honeypot.channelId, null);
  assert.equal(readConfig({ rules: { honeypot: { channelId: '' } } }).rules.honeypot.channelId, null);
});

test('a post in the honeypot channel produces a finding', () => {
  assert.deepEqual(honeypotFinding({ channelId: TRAP }, cfgWith()), { rule: 'honeypot', reason: 'honeypot' });
});

test('a post elsewhere does not', () => {
  assert.equal(honeypotFinding({ channelId: 'other' }, cfgWith()), null);
});

test('a disabled rule or an unset channel does not', () => {
  assert.equal(honeypotFinding({ channelId: TRAP }, cfgWith({ enabled: false })), null);
  assert.equal(honeypotFinding({ channelId: 'x' }, cfgWith({ channelId: null })), null);
  assert.equal(honeypotFinding({ channelId: null }, cfgWith({ channelId: null })), null);
  assert.equal(honeypotFinding(null, cfgWith()), null);
});

const member = (id, { perms = [], roles = [], createdTimestamp, joinedTimestamp } = {}) => ({
  id,
  user: { createdTimestamp },
  joinedTimestamp,
  permissions: { has: (p) => perms.includes(p) },
  roles: { cache: new Set(roles), highest: { position: 1 } },
});

function setup() {
  const calls = { runAction: [], deleted: 0 };
  const guild = { id: G, ownerId: 'owner', members: { me: member('bot') } };
  const engine = createEngine({
    runAction: async (ctx, p) => { calls.runAction.push(p); return { ok: true, modCase: { number: 1 }, warnings: [] }; },
    sendLog: async () => null,
    now: () => 1_000_000,
  });
  const ctx = { db, client: { user: { id: 'bot' } } };
  const msg = (o = {}) => {
    const author = o.author ?? { id: 'u1', bot: false };
    return {
      id: 'm1', content: 'hello', author, webhookId: null, system: false, guild, guildId: G,
      channelId: TRAP, channel: { id: TRAP, parentId: null }, member: member(author.id),
      mentions: { users: { size: 0 }, roles: { size: 0 } }, attachments: { size: 0 },
      delete: async () => { calls.deleted++; },
      ...o,
    };
  };
  return { engine, ctx, calls, msg };
}
const enable = (honeypot = {}, extra = {}) =>
  setFeature(db, G, 'automod', { enabled: true, config: { rules: { honeypot: { enabled: true, channelId: TRAP, ...honeypot } }, ...extra } });

test('the first post deletes and times out with the default steps', async () => {
  const s = setup();
  await enable();
  await s.engine.handleMessage(s.ctx, s.msg(), {});
  assert.equal(s.calls.deleted, 1);
  assert.equal(s.calls.runAction.length, 1);
  assert.equal(s.calls.runAction[0].type, 'timeout');
  assert.equal(s.calls.runAction[0].durationSeconds, 600);
  assert.equal(s.calls.runAction[0].targetId, 'u1');
});

test('an edit or update of a trapped message is not punished again; a fresh post still is', async () => {
  const s = setup();
  await enable();
  // discord.js fires MessageUpdate for an embed unfurl or a pin, with the content unchanged or not.
  await s.engine.handleMessage(s.ctx, s.msg(), { edited: true, oldContent: 'hello' });
  await s.engine.handleMessage(s.ctx, s.msg({ content: 'changed' }), { edited: true, oldContent: 'hello' });
  assert.equal(s.calls.runAction.length, 0);
  assert.equal(s.calls.deleted, 0);
  await s.engine.handleMessage(s.ctx, s.msg({ id: 'm2' }), {});
  assert.equal(s.calls.runAction.length, 1);
  assert.equal(s.calls.deleted, 1);
});

test('a post elsewhere in the same server is left alone', async () => {
  const s = setup();
  await enable();
  await s.engine.handleMessage(s.ctx, s.msg({ channelId: 'c2', channel: { id: 'c2', parentId: null } }), {});
  assert.equal(s.calls.deleted, 0);
  assert.equal(s.calls.runAction.length, 0);
});

test('the honeypot check does not depend on the content', async () => {
  const s = setup();
  await enable();
  await s.engine.handleMessage(s.ctx, s.msg({ content: '' }), {});
  assert.equal(s.calls.runAction.length, 1);
});

test('an exempt member is not punished', async () => {
  const cases = [
    ['Manage Server', member('m', { perms: ['ManageGuild'] }), {}],
    ['Moderate Members', member('m', { perms: ['ModerateMembers'] }), {}],
    ['exempt role', member('m', { roles: ['r1'] }), { exemptRoles: ['r1'] }],
  ];
  for (const [name, mem, extra] of cases) {
    const s = setup();
    await enable({}, extra);
    await s.engine.handleMessage(s.ctx, s.msg({ author: { id: 'm', bot: false }, member: mem }), {});
    assert.equal(s.calls.deleted, 0, name);
    assert.equal(s.calls.runAction.length, 0, name);
  }
  const s = setup();
  await enable({}, { exemptChannels: [TRAP] });
  await s.engine.handleMessage(s.ctx, s.msg(), {});
  assert.equal(s.calls.runAction.length, 0, 'exempt channel');
});

test('bots and the own bot are never punished', async () => {
  const s = setup();
  await enable();
  await s.engine.handleMessage(s.ctx, s.msg({ author: { id: 'x', bot: true } }), {});
  await s.engine.handleMessage(s.ctx, s.msg({ author: { id: 'bot', bot: false } }), {});
  assert.equal(s.calls.runAction.length, 0);
});

test('the age gate applies like for other rules', async () => {
  const s = setup();
  await enable({ age: { accountYoungerThanSeconds: 3600 } });
  const old = member('u1', { createdTimestamp: 1_000_000 - 7_200_000 });
  await s.engine.handleMessage(s.ctx, s.msg({ member: old }), {});
  assert.equal(s.calls.runAction.length, 0);
  const fresh = member('u1', { createdTimestamp: 1_000_000 - 60_000 });
  await s.engine.handleMessage(s.ctx, s.msg({ member: fresh }), {});
  assert.equal(s.calls.runAction.length, 1);
});

test('a deleted honeypot channel leaves a stale setting that does nothing and does not log', async () => {
  const warn = mock.method(console, 'warn', () => {});
  const err = mock.method(console, 'error', () => {});
  try {
    const s = setup();
    await enable({ channelId: 'gone' });
    await s.engine.handleMessage(s.ctx, s.msg({ content: 'hi' }), {});
    assert.equal(s.calls.runAction.length, 0);
    assert.equal(s.calls.deleted, 0);
    assert.ok(statusText('en', true, cfgWith({ channelId: 'gone' })).includes('gone'));
    assert.equal(warn.mock.callCount(), 0);
    assert.equal(err.mock.callCount(), 0);
  } finally {
    warn.mock.restore();
    err.mock.restore();
  }
});

// --- command ---
const cmd = commands[0];
function fake(sub, { channel = null, off = null } = {}) {
  const calls = { reply: [] };
  return {
    calls,
    guildId: G,
    inGuild: () => true,
    member: { permissions: { has: () => true }, guild: { id: G }, roles: { cache: { has: () => false } } },
    guild: { id: G, members: { me: { id: 'bot' } } },
    options: {
      getSubcommand: () => sub,
      getSubcommandGroup: () => null,
      getString: () => null,
      getInteger: () => null,
      getChannel: () => channel,
      getBoolean: () => off,
    },
    deferred: false,
    replied: false,
    reply: async (p) => { calls.reply.push(p); },
    editReply: async (p) => { calls.reply.push(p); },
  };
}
const chan = (perms) => ({ id: 'c9', permissionsFor: () => ({ has: (p) => perms.includes(p) }) });
const saved = async () => readConfig((await getFeature(db, G, 'automod')).config).rules.honeypot;
const text = (i) => i.calls.reply.at(-1).content;

test('/automod honeypot is registered with a channel and an off option', () => {
  const sub = cmd.data.toJSON().options.find((o) => o.name === 'honeypot');
  assert.deepEqual(sub.options.map((o) => o.name), ['channel', 'off']);
  assert.ok(sub.description.length <= 100);
});

test('command sets a channel the bot can see and manage', async () => {
  const i = fake('honeypot', { channel: chan(['ViewChannel', 'ManageMessages']) });
  await cmd.execute(i, { db });
  assert.equal((await saved()).channelId, 'c9');
  assert.equal(text(i), t('en', 'automod.settings.honeypot_set', { channel: '<#c9>' }));
  assert.equal(i.calls.reply[0].allowedMentions.parse.length, 0);
});

test('command refuses a channel the bot cannot manage', async () => {
  for (const perms of [['ViewChannel'], ['ManageMessages'], []]) {
    const i = fake('honeypot', { channel: chan(perms) });
    await cmd.execute(i, { db });
    assert.equal(text(i), t('en', 'automod.settings.honeypot_no_access'));
    assert.equal((await saved()).channelId, null);
  }
  const noPerms = fake('honeypot', { channel: { id: 'c9', permissionsFor: () => null } });
  await cmd.execute(noPerms, { db });
  assert.equal(text(noPerms), t('en', 'automod.settings.honeypot_no_access'));
});

test('command off clears the channel', async () => {
  await cmd.execute(fake('honeypot', { channel: chan(['ViewChannel', 'ManageMessages']) }), { db });
  const i = fake('honeypot', { off: true });
  await cmd.execute(i, { db });
  assert.equal((await saved()).channelId, null);
  assert.equal(text(i), t('en', 'automod.settings.honeypot_off'));
});

test('command with neither a channel nor off asks for one', async () => {
  const i = fake('honeypot');
  await cmd.execute(i, { db });
  assert.equal(text(i), t('en', 'automod.settings.honeypot_missing'));
});

test('status shows the honeypot channel and rule labels exist in every language', () => {
  const lines = statusText('en', true, cfgWith());
  assert.ok(lines.includes(`<#${TRAP}>`));
  for (const lang of ['en', 'fr', 'ar']) {
    assert.notEqual(t(lang, 'automod.rule.honeypot'), 'automod.rule.honeypot');
  }
});

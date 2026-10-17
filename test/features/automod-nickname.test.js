import { test, before, after, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { Events } from 'discord.js';
import { testDb } from '../helpers/db.js';
import { resetDb } from '../../src/db/index.js';
import { setFeature } from '../../src/db/settings.js';
import { checkMember, placeholderName } from '../../src/features/automod/nickname.js';
import { createEngine } from '../../src/features/automod/pipeline.js';
import { createEvents } from '../../src/features/automod/events.js';

let db;
before(async () => { db = await testDb(); });
after(async () => { await db.end(); });
beforeEach(async () => { await resetDb(db); });

const G = 'g1';
const ctx = () => ({ db, client: { user: { id: 'bot' } } });
const enable = (nickname = { enabled: true }, extra = {}) =>
  setFeature(db, G, 'automod', {
    enabled: true,
    config: { rules: { words: { enabled: true, custom: ['badword'], useBuiltin: false } }, nickname, ...extra },
  });

function mk(over = {}) {
  const sets = [];
  const member = {
    id: 'u1',
    nickname: null,
    displayName: 'Fine',
    user: { id: 'u1', username: 'fine', bot: false },
    guild: { id: G },
    permissions: { has: () => false },
    roles: { cache: new Set() },
    setNickname: async (name, reason) => {
      if (over.fail) throw Object.assign(new Error('Missing Permissions'), { code: 50013 });
      sets.push({ name, reason });
    },
    ...over.member,
  };
  return { member, sets };
}
const run = (member, opts = {}) => {
  const logs = [];
  const sendLog = async (c, gid, event, embed) => { logs.push({ gid, event, embed }); return null; };
  return checkMember(ctx(), member, { sendLog, ...opts }).then(() => logs);
};

test('placeholderName matches /^Moderated Nickname \d{4}$/', () => {
  for (let i = 0; i < 20; i++) assert.match(placeholderName(), /^Moderated Nickname \d{4}$/);
});

test('renames a bad nickname', async () => {
  await enable();
  const { member, sets } = mk({ member: { nickname: 'xx badword xx' } });
  const logs = await run(member);
  assert.equal(sets.length, 1);
  assert.match(sets[0].name, /^Moderated Nickname \d{4}$/);
  assert.ok(sets[0].reason);
  assert.equal(logs.length, 1);
  assert.equal(logs[0].event, 'modAction');
  assert.ok(!JSON.stringify(logs[0].embed).includes('@everyone'));
});

test('a pattern match renames a nickname', async () => {
  await setFeature(db, G, 'automod', {
    enabled: true,
    config: { rules: { words: { enabled: true, custom: [], useBuiltin: false, patterns: ['b[a4]d[0-9]+'] } }, nickname: { enabled: true } },
  });
  const { member, sets } = mk({ member: { nickname: 'xx BAD99 xx' } });
  await run(member);
  assert.equal(sets.length, 1);
  assert.match(sets[0].name, /^Moderated Nickname \d{4}$/);
});

test('checks the username when there is no nickname', async () => {
  await enable();
  const { member, sets } = mk({ member: { displayName: 'badword', user: { id: 'u1', username: 'badword', bot: false } } });
  await run(member);
  assert.equal(sets.length, 1);
});

test('a bad username with an acceptable nickname still gets the placeholder, once', async () => {
  await enable();
  const { member, sets } = mk({ member: { nickname: 'Nice', user: { id: 'u1', username: 'badword', bot: false } } });
  await run(member);
  assert.equal(sets.length, 1);
  member.nickname = sets[0].name;
  await run(member, { lastRenamed: new Map() });
  assert.equal(sets.length, 1);
});

test('skips exempt members', async () => {
  await enable();
  const { member, sets } = mk({ member: { nickname: 'badword', permissions: { has: (p) => p === 'ManageGuild' } } });
  const bot = mk({ member: { nickname: 'badword', user: { id: 'b', username: 'b', bot: true } } });
  assert.equal((await run(member)).length, 0);
  await run(bot.member);
  assert.equal(sets.length + bot.sets.length, 0);
});

test('skips when nickname.enabled is false', async () => {
  await enable({ enabled: false });
  const { member, sets } = mk({ member: { nickname: 'badword' } });
  await run(member);
  assert.equal(sets.length, 0);
});

test('skips when the feature is off', async () => {
  const { member, sets } = mk({ member: { nickname: 'badword' } });
  await run(member);
  assert.equal(sets.length, 0);
});

test('does not rename twice within 10 seconds', async () => {
  await enable();
  const { member, sets } = mk({ member: { nickname: 'badword' } });
  const lastRenamed = new Map();
  let t = 1_000_000;
  await run(member, { lastRenamed, now: () => t });
  await run(member, { lastRenamed, now: () => t + 5000 });
  assert.equal(sets.length, 1);
  await run(member, { lastRenamed, now: () => t + 10_001 });
  assert.equal(sets.length, 2);
});

test('the rename cooldown is per guild', async () => {
  await setFeature(db, 'g2', 'automod', {
    enabled: true,
    config: { rules: { words: { enabled: true, custom: ['badword'], useBuiltin: false } }, nickname: { enabled: true } },
  });
  await enable();
  const a = mk({ member: { nickname: 'badword' } });
  const b = mk({ member: { nickname: 'badword', guild: { id: 'g2' } } });
  const lastRenamed = new Map();
  const now = () => 1_000_000;
  await run(a.member, { lastRenamed, now });
  await run(b.member, { lastRenamed, now });
  assert.equal(a.sets.length, 1);
  assert.equal(b.sets.length, 1);
});

test('a failing setNickname does not throw', async () => {
  await enable();
  const warn = mock.method(console, 'warn', () => {});
  const { member } = mk({ fail: true, member: { nickname: 'badword' } });
  const logs = await run(member);
  assert.equal(logs.length, 0);
  assert.ok(warn.mock.callCount() >= 1);
  warn.mock.restore();
});

test('handleMessage checks a member once and a checkMember failure does not stop scanning', async () => {
  await enable();
  const warn = mock.method(console, 'warn', () => {});
  const seen = [];
  const deleted = [];
  const engine = createEngine({
    checkMember: async (c, m) => { seen.push(m.id); throw new Error('boom'); },
    sendLog: async () => null,
    runAction: async () => ({ ok: true, warnings: [] }),
  });
  const { member } = mk();
  const msg = () => ({
    id: 'm', content: 'badword', author: { id: 'u1', bot: false }, guildId: G, channelId: 'c', channel: { id: 'c' },
    guild: { id: G, members: { me: {} } }, member, mentions: { users: { size: 0 }, roles: { size: 0 } },
    attachments: { size: 0 }, delete: async () => { deleted.push(1); },
  });
  await setFeature(db, G, 'automod', { enabled: true, config: { rules: { words: { enabled: true, custom: ['badword'], useBuiltin: false, delete: true } } } });
  await engine.handleMessage(ctx(), msg(), {});
  await engine.handleMessage(ctx(), msg(), {});
  assert.deepEqual(seen, ['u1']);
  assert.equal(deleted.length, 2);
  warn.mock.restore();
});

test('member events call the engine', async () => {
  const calls = [];
  const events = createEvents({ checkMember: async (c, m) => { calls.push(m.id); }, handleMessage() {}, prune() {} });
  const add = events.find((e) => e.name === Events.GuildMemberAdd);
  const upd = events.find((e) => e.name === Events.GuildMemberUpdate);
  await add.execute({}, { id: 'a' });
  await upd.execute({}, { nickname: 'x' }, { id: 'b', nickname: 'y' });
  await upd.execute({}, { nickname: 'y' }, { id: 'c', nickname: 'y' });
  assert.deepEqual(calls, ['a', 'b']);
});

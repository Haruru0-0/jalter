import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { purgeCommand, selectPurgeTargets } from '../../src/features/moderation/commands-purge.js';
import { setFeature } from '../../src/db/settings.js';
import { t } from '../../src/i18n/index.js';
import { testDb } from '../helpers/db.js';

const DAY = 86_400_000;
const NOW = 1_800_000_000_000;
const msg = (id, ageMs, o = {}) => ({
  id, createdTimestamp: NOW - ageMs, pinned: !!o.pinned, author: { id: o.author ?? 'u1', bot: !!o.bot }, ...(o.extra ?? {}),
});
const sel = (messages, o = {}) => selectPurgeTargets(messages, { count: 10, userId: null, botsOnly: false, nowMs: NOW, ...o });
const ids = (r) => r.toDelete.map((m) => m.id);

// ---- selectPurgeTargets ----

test('newest first regardless of input order', () => {
  const r = sel([msg('a', 3000), msg('c', 1000), msg('b', 2000)]);
  assert.deepEqual(ids(r), ['c', 'b', 'a']);
});

test('pinned messages are skipped and counted', () => {
  const r = sel([msg('a', 1000), msg('p', 2000, { pinned: true })]);
  assert.deepEqual(ids(r), ['a']);
  assert.equal(r.skippedPinned, 1);
  assert.equal(r.skippedOld, 0);
});

test('messages older than 14 days are skipped and counted', () => {
  const r = sel([msg('a', 1000), msg('edge', 14 * DAY - 1), msg('old', 14 * DAY + 1), msg('older', 20 * DAY)]);
  assert.deepEqual(ids(r), ['a', 'edge']);
  assert.equal(r.skippedOld, 2);
});

test('user filter keeps only that author', () => {
  const r = sel([msg('a', 1000, { author: 'x' }), msg('b', 2000, { author: 'y' })], { userId: 'x' });
  assert.deepEqual(ids(r), ['a']);
});

test('bots filter keeps only bot authors', () => {
  const r = sel([msg('a', 1000, { bot: true }), msg('b', 2000)], { botsOnly: true });
  assert.deepEqual(ids(r), ['a']);
});

test('count caps the result at the newest matches', () => {
  const r = sel([msg('a', 1000), msg('b', 2000), msg('c', 3000)], { count: 2 });
  assert.deepEqual(ids(r), ['a', 'b']);
});

// ---- structure ----

test('/purge has the messages subcommand with the documented options', () => {
  const j = purgeCommand.data.toJSON();
  assert.equal(j.name, 'purge');
  assert.equal(j.default_member_permissions ?? null, null);
  const sub = j.options.find((o) => o.name === 'messages');
  assert.ok(sub);
  assert.deepEqual(sub.options.map((o) => [o.name, !!o.required]), [['count', true], ['user', false], ['bots', false], ['reason', false]]);
  assert.equal(sub.options[0].min_value, 1);
  assert.equal(sub.options[0].max_value, 100);
  assert.equal(sub.options[3].max_length, 400);
  for (const o of [j, sub, ...sub.options]) assert.ok(o.description.length >= 1 && o.description.length <= 100, o.name);
});

// ---- execute ----

let db;
const realWarn = console.warn;
before(async () => { db = await testDb(); });
beforeEach(async () => {
  console.warn = () => {};
  await db.query('TRUNCATE guild_settings');
  await setFeature(db, 'g1', 'moderation', { enabled: true, config: {} });
  await setFeature(db, 'g1', 'logging', { enabled: true, config: { channels: { default: 'LOG' } } });
});
after(async () => { console.warn = realWarn; await db.end(); });

function fake({
  type = 0, opts = {}, perms = ['ManageMessages'], roles = [], userPerms = ['ViewChannel'],
  botPerms = ['ViewChannel', 'ReadMessageHistory', 'ManageMessages'], messages = [], bulkThrows = false,
} = {}) {
  const calls = { replies: [], bulk: [], fetches: [], sent: [] };
  const sorted = [...messages].sort((a, b) => b.createdTimestamp - a.createdTimestamp);
  const channel = {
    id: 'c1', type,
    permissionsFor: (m) => ({ has: (p) => (m.id === 'bot' ? botPerms : userPerms).includes(p) }),
    messages: {
      fetch: async (o) => {
        calls.fetches.push(o);
        let list = sorted;
        if (o.before) list = list.filter((m) => m.createdTimestamp < sorted.find((x) => x.id === o.before).createdTimestamp);
        return new Map(list.slice(0, o.limit).map((m) => [m.id, m]));
      },
    },
    bulkDelete: async (list, filterOld) => {
      if (bulkThrows) throw new Error('nope');
      calls.bulk.push([list, filterOld]);
      return new Map(list.map((m) => [m.id, m]));
    },
    send: async (p) => { calls.sent.push(p); return {}; },
  };
  const guild = { id: 'g1', members: { me: { id: 'bot' } } };
  const values = { count: 10, reason: null, user: null, bots: null, ...opts };
  const interaction = {
    id: 'i1', guildId: 'g1', guild, channel,
    member: { id: 'mod', permissions: { has: (p) => perms.includes(p) }, roles: { cache: { has: (r) => roles.includes(r) } } },
    user: { id: 'mod' },
    inGuild: () => true,
    options: {
      getSubcommand: () => 'messages',
      getString: (n) => values[n] ?? null,
      getInteger: (n) => values[n] ?? null,
      getBoolean: (n) => values[n] ?? null,
      getUser: (n) => values[n] ?? null,
      getChannel: () => null,
    },
    deferReply: async (o) => { calls.deferred = o; },
    reply: async (p) => { calls.replies.push(p); },
    editReply: async (p) => { calls.replies.push(p); },
  };
  const logs = [];
  const ctx = {
    db,
    client: {
      user: { id: 'bot' },
      guilds: { cache: new Map([['g1', guild]]) },
      channels: { fetch: async () => ({ id: 'LOG', isTextBased: () => true, send: async (p) => { logs.push(p); return { id: 'm', channelId: 'LOG' }; } }) },
    },
  };
  return { interaction, ctx, calls, logs };
}
const run = (f) => purgeCommand.execute(f.interaction, f.ctx);
const last = (f) => f.calls.replies.at(-1).content;
const fresh = (id, ageMs, o = {}) => ({ ...msg(id, 0, o), createdTimestamp: Date.now() - ageMs });
const recent = (n, o = () => ({})) => Array.from({ length: n }, (_, i) => fresh(`m${i}`, (i + 1) * 1000, o(i)));

test('deletes matches, replies privately with the count and writes one log line', async () => {
  const f = fake({ opts: { count: 3, reason: 'spam' }, messages: recent(5) });
  await run(f);
  assert.equal(f.calls.bulk.length, 1);
  assert.equal(f.calls.bulk[0][0].length, 3);
  assert.equal(f.calls.bulk[0][1], true);
  assert.ok(f.calls.deferred.flags !== undefined);
  assert.equal(last(f), t('en', 'moderation.tools.purge.reply', { count: 3 }));
  assert.deepEqual(f.calls.sent, []);
  assert.equal(f.logs.length, 1);
  assert.match(f.logs[0].embeds[0].title, /purge/);
});

test('user and bots together are refused with nothing deleted', async () => {
  const f = fake({ opts: { user: { id: 'x' }, bots: true }, messages: recent(3) });
  await run(f);
  assert.equal(last(f), t('en', 'moderation.tools.purge.pick_one'));
  assert.deepEqual(f.calls.bulk, []);
  assert.deepEqual(f.logs, []);
});

test('the user filter only deletes that member', async () => {
  const f = fake({ opts: { user: { id: 'x' } }, messages: [...recent(2, () => ({ author: 'x' })), fresh('z', 5000, { author: 'y' })] });
  await run(f);
  assert.deepEqual(f.calls.bulk[0][0].map((m) => m.author.id), ['x', 'x']);
});

test('a member without permission is refused', async () => {
  const f = fake({ perms: [], messages: recent(2) });
  await run(f);
  assert.equal(last(f), t('en', 'moderation.tools.err.not_allowed'));
  assert.deepEqual(f.calls.bulk, []);
});

test('the bot lacking ManageMessages or ReadMessageHistory refuses', async () => {
  for (const botPerms of [['ViewChannel', 'ReadMessageHistory'], ['ViewChannel', 'ManageMessages']]) {
    const f = fake({ botPerms, messages: recent(2) });
    await run(f);
    assert.equal(last(f), t('en', 'moderation.tools.err.bot_missing'));
    assert.deepEqual(f.calls.bulk, []);
  }
});

test('the bot does not need Send Messages', async () => {
  const f = fake({ messages: recent(2) });
  await run(f);
  assert.equal(f.calls.bulk.length, 1);
});

test('unsupported channel types are refused; announcements and threads work', async () => {
  const bad = fake({ type: 2, messages: recent(2) });
  await run(bad);
  assert.equal(last(bad), t('en', 'moderation.tools.err.bad_channel'));
  assert.deepEqual(bad.calls.bulk, []);
  for (const type of [0, 5, 10, 11, 12]) {
    const ok = fake({ type, messages: recent(2) });
    await run(ok);
    assert.equal(ok.calls.bulk.length, 1, `type ${type}`);
  }
});

test('fewer found than requested is reported', async () => {
  const f = fake({ opts: { count: 10 }, messages: recent(2) });
  await run(f);
  assert.ok(last(f).startsWith(t('en', 'moderation.tools.purge.reply', { count: 2 })));
  assert.ok(last(f).includes(t('en', 'moderation.tools.purge.note_fewer', { found: 2, count: 10 })));
});

test('old and pinned messages are reported as skipped', async () => {
  const f = fake({ opts: { count: 10 }, messages: [fresh('a', 1000), fresh('o', 15 * DAY), fresh('p', 2000, { pinned: true })] });
  await run(f);
  assert.equal(f.calls.bulk[0][0].length, 1);
  assert.ok(last(f).includes(t('en', 'moderation.tools.purge.note_skipped', { old: 1, pinned: 1 })));
});

test('nothing to delete says so, without bulkDelete or a log line', async () => {
  const f = fake({ messages: [] });
  await run(f);
  assert.deepEqual(f.calls.bulk, []);
  assert.equal(last(f), t('en', 'moderation.tools.purge.none'));
  assert.deepEqual(f.logs, []);
});

test('scans at most 500 messages in pages of 100', async () => {
  const f = fake({ opts: { bots: true, count: 100 }, messages: recent(700) });
  await run(f);
  assert.equal(f.calls.fetches.length, 5);
  assert.ok(f.calls.fetches.every((o) => o.limit === 100));
});

test('the command own interaction message is not counted', async () => {
  const own = fresh('own', 10, { extra: { interaction: { id: 'i1' } } });
  const f = fake({ opts: { count: 5 }, messages: [own, ...recent(2)] });
  await run(f);
  assert.equal(f.calls.bulk[0][0].length, 2);
});

test('a Discord error gives the failed reply and no log line', async () => {
  const f = fake({ bulkThrows: true, messages: recent(2) });
  await run(f);
  assert.equal(last(f), t('en', 'moderation.tools.err.failed'));
  assert.deepEqual(f.logs, []);
});

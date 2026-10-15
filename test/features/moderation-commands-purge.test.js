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
  await db.query('TRUNCATE guild_settings, media_items');
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

// ---- purge channel ----

const okId = (u, c, at) => `purge:ok:${u}:${c}:${at}`;
const addMedia = () => db.query("INSERT INTO media_items (guild_id, name, channel_id, message_id) VALUES ('g1','x','OLD','m')");

function chanFake({
  type = 0, subChannel = 'OLD', perms = ['ManageChannels'], botPerms = ['ViewChannel', 'ManageChannels', 'SendMessages', 'ManageRoles'],
  rules = 'RULES', updates = 'UPD', cloneThrows = false, deleteThrows = false, positionThrows = false, currentId = 'HERE',
} = {}) {
  const calls = { replies: [], updates: [], cloneReasons: [], positions: [], deleted: [], notices: [], deferred: 0 };
  const mk = (id, ty = type) => ({
    id, type: ty, position: 7,
    permissionsFor: (m) => ({ has: (p) => (m.id === 'bot' ? botPerms : ['ViewChannel']).includes(p) }),
  });
  const old = mk('OLD');
  old.clone = async (o) => {
    calls.cloneReasons.push(o?.reason);
    if (cloneThrows) throw new Error('clone nope');
    const c = mk('NEW');
    c.setPosition = async (p) => { if (positionThrows) throw new Error('pos'); calls.positions.push(p); };
    c.delete = async (r) => { calls.deleted.push(['NEW', r]); };
    c.send = async (p) => { calls.notices.push(p); return {}; };
    calls.clone = c;
    return c;
  };
  old.delete = async (r) => { if (deleteThrows) throw new Error('del nope'); calls.deleted.push(['OLD', r]); };
  const here = mk(currentId);
  const all = new Map([['OLD', old], ['RULES', mk('RULES')], ['UPD', mk('UPD')], ['VOICE', mk('VOICE', 2)], [currentId, here]]);
  const guild = {
    id: 'g1', members: { me: { id: 'bot' } }, rulesChannelId: rules, publicUpdatesChannelId: updates,
    channels: { cache: all, fetch: async (id) => all.get(id) ?? null },
  };
  const logs = [];
  const ctx = {
    db,
    client: {
      user: { id: 'bot' }, guilds: { cache: new Map([['g1', guild]]) },
      channels: { fetch: async () => ({ id: 'LOG', isTextBased: () => true, send: async (p) => { logs.push(p); return { id: 'm', channelId: 'LOG' }; } }) },
    },
  };
  const member = { id: 'mod', permissions: { has: (p) => perms.includes(p) }, roles: { cache: { has: () => false } } };
  const base = { guildId: 'g1', guild, member, user: { id: 'mod' }, inGuild: () => true, channel: here };
  const slash = {
    ...base, id: 'i1',
    options: {
      getSubcommand: () => 'channel',
      getChannel: () => (subChannel === null ? null : all.get(subChannel)),
      getString: () => 'cleanup',
    },
    reply: async (p) => { calls.replies.push(p); },
  };
  const button = (customId, user = 'mod') => ({
    ...base, user: { id: user }, customId, isButton: () => true,
    reply: async (p) => { calls.replies.push(p); },
    update: async (p) => { calls.updates.push(p); },
    deferUpdate: async () => { calls.deferred += 1; },
    editReply: async (p) => { calls.updates.push(p); },
  });
  return { slash, button, ctx, calls, logs, all };
}
const comps = purgeCommand.components;
const text = (p) => p.content;

test('/purge channel is declared with optional channel and reason; components prefix purge', () => {
  const j = purgeCommand.data.toJSON();
  const sub = j.options.find((o) => o.name === 'channel');
  assert.ok(sub);
  assert.deepEqual(sub.options.map((o) => [o.name, !!o.required]), [['channel', false], ['reason', false]]);
  assert.deepEqual(sub.options[0].channel_types, [0, 5]);
  assert.equal(sub.options[1].max_length, 400);
  for (const o of [sub, ...sub.options]) assert.ok(o.description.length >= 1 && o.description.length <= 100);
  assert.equal(comps.prefix, 'purge');
  assert.equal(typeof comps.handle, 'function');
});

test('channel: refuses rules and community-updates channels, voice channels and media-held channels (no buttons)', async () => {
  for (const sc of ['RULES', 'UPD']) {
    const f = chanFake({ subChannel: sc });
    await purgeCommand.execute(f.slash, f.ctx);
    assert.equal(text(f.calls.replies[0]), t('en', 'moderation.tools.purge.protected'));
    assert.equal(f.calls.replies[0].components, undefined);
  }
  const v = chanFake({ subChannel: 'VOICE' });
  await purgeCommand.execute(v.slash, v.ctx);
  assert.equal(text(v.calls.replies[0]), t('en', 'moderation.tools.err.bad_channel'));
  assert.equal(v.calls.replies[0].components, undefined);

  await addMedia();
  const m = chanFake();
  await purgeCommand.execute(m.slash, m.ctx);
  assert.equal(text(m.calls.replies[0]), t('en', 'moderation.tools.purge.media_here'));
  assert.equal(m.calls.replies[0].components, undefined);
});

test('channel: permission and bot-permission refusals; ManageRoles is required, SendMessages is not', async () => {
  const a = chanFake({ perms: [] });
  await purgeCommand.execute(a.slash, a.ctx);
  assert.equal(text(a.calls.replies[0]), t('en', 'moderation.tools.err.not_allowed'));
  for (const missing of ['ManageChannels', 'ManageRoles', 'ViewChannel']) {
    const f = chanFake({ botPerms: ['ViewChannel', 'ManageChannels', 'SendMessages', 'ManageRoles'].filter((p) => p !== missing) });
    await purgeCommand.execute(f.slash, f.ctx);
    assert.equal(text(f.calls.replies[0]), t('en', 'moderation.tools.err.bot_missing'), missing);
  }
  const s = chanFake({ botPerms: ['ViewChannel', 'ManageChannels', 'ManageRoles'] });
  await purgeCommand.execute(s.slash, s.ctx);
  assert.equal(s.calls.replies[0].components.length, 1);
});

test('channel: works on a locked channel (bot has no Send Messages); the notice failure is a note', async () => {
  await seedIds();
  const f = chanFake({ botPerms: ['ViewChannel', 'ManageChannels', 'ManageRoles'] });
  const origClone = f.all.get('OLD').clone;
  // The clone copies the @everyone deny, so the notice cannot be posted either.
  f.all.get('OLD').clone = async (o) => { const c = await origClone(o); c.send = async () => { throw new Error('locked'); }; return c; };
  await comps.handle(f.button(okId('mod', 'OLD', Date.now())), f.ctx);
  assert.deepEqual(f.calls.deleted.map((d) => d[0]), ['OLD']);
  const lastText = f.calls.updates.at(-1).content;
  assert.ok(lastText.includes(t('en', 'moderation.tools.purge.done', { channel: '<#NEW>' })));
  assert.ok(lastText.includes(t('en', 'moderation.tools.notice_failed')));
  assert.equal(f.logs.length, 1);
});

test('confirm: an edit failure after the old channel is deleted never reports "failed"', async () => {
  await seedIds();
  // As when the confirm message lived in the purged channel: every edit after the delete fails.
  const f = chanFake();
  const b = f.button(okId('mod', 'OLD', Date.now()));
  const attempts = [];
  b.editReply = async (p) => { attempts.push(p); throw new Error('Unknown Channel'); };
  await comps.handle(b, f.ctx);
  assert.deepEqual(f.calls.deleted.map((d) => d[0]), ['OLD']);
  assert.ok(attempts.length >= 1);
  assert.ok(attempts.every((p) => p.content !== t('en', 'moderation.tools.err.failed')));
});

test('confirm: an edit failure on the old-delete-failed message never reports "failed"', async () => {
  await seedIds();
  const f = chanFake({ deleteThrows: true });
  const b = f.button(okId('mod', 'OLD', Date.now()));
  const attempts = [];
  b.editReply = async (p) => { attempts.push(p); throw new Error('boom'); };
  await comps.handle(b, f.ctx);
  assert.ok(attempts.every((p) => p.content !== t('en', 'moderation.tools.err.failed')));
});

test('channel: shows the warning with the mention and two buttons carrying the ids', async () => {
  const f = chanFake();
  const before = Date.now();
  await purgeCommand.execute(f.slash, f.ctx);
  const r = f.calls.replies[0];
  assert.ok(r.flags !== undefined);
  assert.ok(r.content.includes('<#OLD>'));
  const buttons = r.components[0].toJSON().components;
  assert.equal(buttons.length, 2);
  const m = buttons[0].custom_id.match(/^purge:ok:mod:OLD:(\d+)$/);
  assert.ok(m);
  assert.ok(Number(m[1]) >= before && Number(m[1]) <= Date.now());
  assert.equal(buttons[1].custom_id, 'purge:no:mod');
});

test('channel: defaults to the current channel', async () => {
  const f = chanFake({ subChannel: null, currentId: 'OLD' });
  await purgeCommand.execute(f.slash, f.ctx);
  assert.ok(f.calls.replies[0].components[0].toJSON().components[0].custom_id.startsWith('purge:ok:mod:OLD:'));
});

test('button: pressed by someone else is refused and nothing happens', async () => {
  const f = chanFake();
  await comps.handle(f.button(okId('mod', 'OLD', Date.now()), 'other'), f.ctx);
  assert.equal(text(f.calls.replies[0]), t('en', 'moderation.tools.purge.not_yours'));
  assert.equal(f.calls.clone, undefined);
  const g = chanFake();
  await comps.handle(g.button('purge:no:mod', 'other'), g.ctx);
  assert.equal(text(g.calls.replies[0]), t('en', 'moderation.tools.purge.not_yours'));
  assert.deepEqual(g.calls.updates, []);
});

test('button: expired confirm is refused', async () => {
  const f = chanFake();
  await comps.handle(f.button(okId('mod', 'OLD', Date.now() - 121_000)), f.ctx);
  assert.equal(text(f.calls.updates[0] ?? f.calls.replies[0]), t('en', 'moderation.tools.purge.expired'));
  assert.equal(f.calls.clone, undefined);
  assert.deepEqual(f.calls.deleted, []);
});

test('button: cancel clears the buttons', async () => {
  const f = chanFake();
  await comps.handle(f.button('purge:no:mod'), f.ctx);
  assert.equal(text(f.calls.updates[0]), t('en', 'moderation.tools.purge.cancelled'));
  assert.deepEqual(f.calls.updates[0].components, []);
});

async function seedIds() {
  await setFeature(db, 'g1', 'logging', { enabled: true, config: { channels: { default: 'LOG', join: 'OLD' } } });
  await setFeature(db, 'g1', 'greet', { enabled: true, config: { channelId: 'OLD' } });
}
const cfg = async (feature) => (await db.query('SELECT config FROM guild_settings WHERE guild_id=$1 AND feature=$2', ['g1', feature])).rows[0].config;

test('confirm happy path: clone, position, ids moved, old deleted, notice, one log, result with new mention', async () => {
  await seedIds();
  const f = chanFake({ currentId: 'ELSEWHERE' });
  await comps.handle(f.button(okId('mod', 'OLD', Date.now())), f.ctx);
  assert.equal(f.calls.clone.id, 'NEW');
  assert.deepEqual(f.calls.positions, [7]);
  assert.equal((await cfg('greet')).channelId, 'NEW');
  assert.equal((await cfg('logging')).channels.join, 'NEW');
  assert.deepEqual(f.calls.deleted.map((d) => d[0]), ['OLD']);
  assert.equal(f.calls.notices.length, 1);
  assert.equal(f.logs.length, 1);
  assert.match(f.logs[0].embeds[0].title, /purge channel/);
  assert.ok(JSON.stringify(f.logs[0]).includes('<#NEW>'));
  const last = f.calls.updates.at(-1);
  assert.ok(last.content.includes('<#NEW>'));
  assert.deepEqual(last.components, []);
});

test('confirm wipes the channel from the custom id, not the current channel', async () => {
  const f = chanFake({ currentId: 'HERE' });
  await comps.handle(f.button(okId('mod', 'OLD', Date.now())), f.ctx);
  assert.deepEqual(f.calls.deleted.map((d) => d[0]), ['OLD']);
});

test('confirm re-checks permissions, protected and media at press time', async () => {
  const a = chanFake({ perms: [] });
  await comps.handle(a.button(okId('mod', 'OLD', Date.now())), a.ctx);
  assert.equal(a.calls.clone, undefined);
  assert.deepEqual(a.calls.deleted, []);
  const b = chanFake({ botPerms: ['ViewChannel', 'ManageChannels'] });
  await comps.handle(b.button(okId('mod', 'OLD', Date.now())), b.ctx);
  assert.equal(b.calls.clone, undefined);
  const c = chanFake({ rules: 'OLD' });
  await comps.handle(c.button(okId('mod', 'OLD', Date.now())), c.ctx);
  assert.equal(c.calls.clone, undefined);
  await addMedia();
  const d = chanFake();
  await comps.handle(d.button(okId('mod', 'OLD', Date.now())), d.ctx);
  assert.equal(d.calls.clone, undefined);
});

test('confirm: clone failure moves and deletes nothing', async () => {
  await seedIds();
  const f = chanFake({ cloneThrows: true });
  await comps.handle(f.button(okId('mod', 'OLD', Date.now())), f.ctx);
  assert.equal(f.calls.updates.at(-1).content, t('en', 'moderation.tools.err.failed'));
  assert.equal((await cfg('greet')).channelId, 'OLD');
  assert.deepEqual(f.calls.deleted, []);
  assert.deepEqual(f.logs, []);
});

test('confirm: move failure deletes the clone and keeps the old channel', async () => {
  await seedIds();
  const f = chanFake();
  f.ctx.db = { query: (...a) => db.query(...a), connect: async () => { throw new Error('db down'); } };
  await comps.handle(f.button(okId('mod', 'OLD', Date.now())), f.ctx);
  assert.deepEqual(f.calls.deleted.map((d) => d[0]), ['NEW']);
  assert.equal(f.calls.updates.at(-1).content, t('en', 'moderation.tools.purge.move_failed'));
  assert.equal((await cfg('greet')).channelId, 'OLD');
  assert.deepEqual(f.logs, []);
});

test('confirm: old channel delete failure says settings point at the copy', async () => {
  await seedIds();
  const f = chanFake({ deleteThrows: true });
  await comps.handle(f.button(okId('mod', 'OLD', Date.now())), f.ctx);
  assert.equal((await cfg('greet')).channelId, 'NEW');
  assert.equal(f.calls.updates.at(-1).content, t('en', 'moderation.tools.purge.old_delete_failed', { channel: '<#NEW>' }));
  assert.deepEqual(f.calls.deleted, []);
});

test('confirm: a position failure does not abort and is mentioned', async () => {
  await seedIds();
  const f = chanFake({ positionThrows: true });
  await comps.handle(f.button(okId('mod', 'OLD', Date.now())), f.ctx);
  assert.deepEqual(f.calls.deleted.map((d) => d[0]), ['OLD']);
  assert.ok(f.calls.updates.at(-1).content.includes(t('en', 'moderation.tools.purge.position_failed')));
});

test('confirm: a vanished channel is reported', async () => {
  const f = chanFake();
  f.all.delete('OLD');
  await comps.handle(f.button(okId('mod', 'OLD', Date.now())), f.ctx);
  assert.equal(f.calls.updates.at(-1).content, t('en', 'moderation.tools.purge.gone'));
});

// ---- purge channel: fix round 1 ----

test('concurrent confirms for the same channel run once; the second gets in-progress; guard releases after success', async () => {
  await seedIds();
  const f = chanFake();
  const id = okId('mod', 'OLD', Date.now());
  const b1 = f.button(id);
  const b2 = f.button(id);
  const second = [];
  b2.reply = async (p) => { second.push(p); };
  let release;
  b1.deferUpdate = () => new Promise((r) => { release = r; });
  const first = comps.handle(b1, f.ctx);
  await comps.handle(b2, f.ctx);
  release();
  await first;
  assert.equal(f.calls.cloneReasons.length, 1);
  assert.deepEqual(f.calls.deleted.map((d) => d[0]), ['OLD']);
  assert.equal(second[0].content, t('en', 'moderation.tools.purge.in_progress'));
  // released: a later press runs again (channel reappears)
  const g = chanFake();
  await comps.handle(g.button(id), g.ctx);
  assert.equal(g.calls.cloneReasons.length, 1);
});

test('the in-flight guard is released after a failure so a retry works', async () => {
  const f = chanFake({ cloneThrows: true });
  await comps.handle(f.button(okId('mod', 'OLD', Date.now())), f.ctx);
  const g = chanFake();
  await comps.handle(g.button(okId('mod', 'OLD', Date.now())), g.ctx);
  assert.deepEqual(g.calls.deleted.map((d) => d[0]), ['OLD']);
});

test('an unexpected throw after deferUpdate still edits the message and clears the buttons', async () => {
  const f = chanFake();
  f.ctx.db = { query: async () => { throw new Error('db down'); }, connect: async () => { throw new Error('db down'); } };
  const b = f.button(okId('mod', 'OLD', Date.now()));
  // guard uses db for language; keep it working by failing only later queries
  let n = 0;
  f.ctx.db.query = async (...a) => { n += 1; if (n > 2) throw new Error('db down'); return db.query(...a); };
  await comps.handle(b, f.ctx);
  const last = f.calls.updates.at(-1);
  assert.equal(last.content, t('en', 'moderation.tools.err.failed'));
  assert.deepEqual(last.components, []);
  assert.deepEqual(f.calls.deleted, []);
});

test('old-channel delete failure still writes a log line for the clone', async () => {
  await seedIds();
  const f = chanFake({ deleteThrows: true });
  await comps.handle(f.button(okId('mod', 'OLD', Date.now())), f.ctx);
  assert.equal(f.logs.length, 1);
  assert.ok(JSON.stringify(f.logs[0]).includes('<#NEW>'));
});

test('move failure plus clone cleanup failure tells the moderator a copy remains', async () => {
  await seedIds();
  const f = chanFake();
  f.ctx.db = { query: (...a) => db.query(...a), connect: async () => { throw new Error('db down'); } };
  const origClone = f.all.get('OLD').clone;
  f.all.get('OLD').clone = async (o) => { const c = await origClone(o); c.delete = async () => { throw new Error('nope'); }; return c; };
  await comps.handle(f.button(okId('mod', 'OLD', Date.now())), f.ctx);
  assert.equal(f.calls.updates.at(-1).content, t('en', 'moderation.tools.purge.move_failed_clone_left', { channel: '<#NEW>' }));
  assert.deepEqual(f.calls.deleted, []);
});

test('the reason reaches the audit reason and the log', async () => {
  await seedIds();
  const f = chanFake();
  await purgeCommand.execute(f.slash, f.ctx);
  const cid = f.calls.replies[0].components[0].toJSON().components[0].custom_id;
  await comps.handle(f.button(cid), f.ctx);
  assert.match(f.calls.cloneReasons[0], /cleanup/);
  assert.match(f.calls.deleted[0][1], /cleanup/);
  assert.ok(JSON.stringify(f.logs[0]).includes('cleanup'));
});

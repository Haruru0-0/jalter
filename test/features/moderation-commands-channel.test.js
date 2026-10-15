import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { channelCommands } from '../../src/features/moderation/commands-channel.js';
import { setFeature } from '../../src/db/settings.js';
import { t } from '../../src/i18n/index.js';
import { testDb } from '../helpers/db.js';

const byName = (n) => channelCommands.find((c) => c.data.name === n);

// ---- structure ----

test('the module exposes slowmode, lock and unlock in order', () => {
  assert.deepEqual(channelCommands.map((c) => c.data.name), ['slowmode', 'lock', 'unlock']);
});

test('option names and order match the documented signatures', () => {
  const shape = (n) => byName(n).data.toJSON().options.map((o) => [o.name, !!o.required]);
  assert.deepEqual(shape('slowmode'), [['seconds', true], ['channel', false], ['reason', false]]);
  assert.deepEqual(shape('lock'), [['channel', false], ['reason', false]]);
  assert.deepEqual(shape('unlock'), [['channel', false], ['reason', false]]);
});

test('descriptions are 1-100 chars, required first, no default permissions', () => {
  for (const c of channelCommands) {
    const json = c.data.toJSON();
    assert.ok(json.description.length >= 1 && json.description.length <= 100, json.name);
    assert.equal(json.default_member_permissions ?? null, null, json.name);
    let optional = false;
    for (const o of json.options) {
      assert.ok(o.description.length >= 1 && o.description.length <= 100, `${json.name} ${o.name}`);
      assert.ok(!(optional && o.required), `${json.name} ${o.name} order`);
      if (!o.required) optional = true;
    }
  }
});

test('seconds is an integer 0 to 21600 and reason is at most 400 chars', () => {
  const opts = byName('slowmode').data.toJSON().options;
  const s = opts.find((o) => o.name === 'seconds');
  assert.equal(s.min_value, 0);
  assert.equal(s.max_value, 21600);
  for (const c of channelCommands) {
    assert.equal(c.data.toJSON().options.find((o) => o.name === 'reason').max_length, 400);
  }
});

// ---- execute ----

let db;
const realWarn = console.warn;
before(async () => { db = await testDb(); });
beforeEach(async () => {
  console.warn = () => {};
  await db.query('TRUNCATE guild_settings');
  await setFeature(db, 'g1', 'moderation', { enabled: true, config: {} });
});
after(async () => { console.warn = realWarn; await db.end(); });

const TEXT = 0;
const ANNOUNCEMENT = 5;
const PUBLIC_THREAD = 11;

function fake({
  type = TEXT, opts = {}, perms = ['ManageChannels'], roles = [], botPerms = ['ViewChannel', 'SendMessages', 'ManageChannels'],
  userPerms = ['ViewChannel'], rateLimit = 0, everyoneDeny = false, sendThrows = false,
} = {}) {
  const calls = { replies: [], rate: [], edits: [], sent: [] };
  const everyone = { id: 'g1' };
  const channel = {
    id: 'c1', type, rateLimitPerUser: rateLimit,
    isThread: () => type === PUBLIC_THREAD,
    permissionsFor: (m) => ({ has: (p) => (m.id === 'bot' ? botPerms : userPerms).includes(p) }),
    permissionOverwrites: {
      cache: new Map(everyoneDeny ? [['g1', { deny: { has: (p) => p === 'SendMessages' } }]] : []),
      edit: async (...a) => { calls.edits.push(a); },
    },
    setRateLimitPerUser: async (...a) => { calls.rate.push(a); },
    send: async (p) => { if (sendThrows) throw new Error('nope'); calls.sent.push(p); return {}; },
  };
  const guild = { id: 'g1', roles: { everyone }, members: { me: { id: 'bot' } } };
  const values = { reason: null, channel: null, ...opts };
  const interaction = {
    guildId: 'g1', guild, channel,
    member: { id: 'mod', permissions: { has: (p) => perms.includes(p) }, roles: { cache: { has: (r) => roles.includes(r) } } },
    user: { id: 'mod' },
    inGuild: () => true,
    options: {
      getString: (n) => values[n] ?? null,
      getInteger: (n) => values[n] ?? null,
      getChannel: (n) => values[n] ?? null,
    },
    deferReply: async (o) => { calls.deferred = o; },
    reply: async (p) => { calls.replies.push(p); },
    editReply: async (p) => { calls.replies.push(p); },
  };
  const ctx = { db, client: { user: { id: 'bot' }, guilds: { cache: new Map([['g1', guild]]) }, channels: { fetch: async () => null } } };
  return { interaction, ctx, calls, everyone };
}
const run = (name, f) => byName(name).execute(f.interaction, f.ctx);
const last = (f) => f.calls.replies.at(-1).content;

test('slowmode sets the value, posts one notice and replies privately', async () => {
  const f = fake({ opts: { seconds: 10, reason: 'calm down' } });
  await run('slowmode', f);
  assert.deepEqual(f.calls.rate, [[10, 'calm down']]);
  assert.equal(f.calls.sent.length, 1);
  assert.match(f.calls.sent[0].content, /10s/);
  assert.match(f.calls.sent[0].content, /calm down/);
  assert.match(f.calls.sent[0].content, /<@mod>/);
  assert.ok(f.calls.deferred.flags !== undefined);
  assert.match(last(f), /10s/);
  assert.ok(!last(f).includes(t('en', 'moderation.tools.notice_failed')));
});

test('slowmode 0 turns it off', async () => {
  const f = fake({ rateLimit: 5, opts: { seconds: 0 } });
  await run('slowmode', f);
  assert.equal(f.calls.rate[0][0], 0);
  assert.match(f.calls.sent[0].content, /off/);
});

test('the same slowmode value is a private no-op', async () => {
  const f = fake({ rateLimit: 10, opts: { seconds: 10 } });
  await run('slowmode', f);
  assert.deepEqual(f.calls.rate, []);
  assert.deepEqual(f.calls.sent, []);
  assert.match(last(f), /already/);
});

test('slowmode on an announcement channel is refused', async () => {
  const f = fake({ type: ANNOUNCEMENT, opts: { seconds: 5 } });
  await run('slowmode', f);
  assert.equal(last(f), t('en', 'moderation.tools.err.bad_channel'));
  assert.deepEqual(f.calls.rate, []);
});

test('slowmode works in a thread when the bot can manage threads', async () => {
  const ok = fake({ type: PUBLIC_THREAD, opts: { seconds: 5 }, botPerms: ['ViewChannel', 'SendMessages', 'ManageChannels', 'ManageThreads'] });
  await run('slowmode', ok);
  assert.equal(ok.calls.rate.length, 1);
  const bad = fake({ type: PUBLIC_THREAD, opts: { seconds: 5 } });
  await run('slowmode', bad);
  assert.equal(last(bad), t('en', 'moderation.tools.err.bot_missing'));
  assert.deepEqual(bad.calls.rate, []);
});

test('a member without permission is refused', async () => {
  const f = fake({ perms: [], opts: { seconds: 5 } });
  await run('slowmode', f);
  assert.equal(last(f), t('en', 'moderation.tools.err.not_allowed'));
  assert.deepEqual(f.calls.rate, []);
});

test('a permitted-role holder is allowed', async () => {
  await setFeature(db, 'g1', 'moderation', { config: { permittedRoles: ['R'] } });
  const f = fake({ perms: [], roles: ['R'], opts: { seconds: 5 } });
  await run('slowmode', f);
  assert.equal(f.calls.rate.length, 1);
});

test('the feature being off gives the standard off message', async () => {
  await setFeature(db, 'g1', 'moderation', { enabled: false });
  const f = fake({ opts: { seconds: 5 } });
  await run('slowmode', f);
  assert.match(last(f), /This feature is off/);
  assert.deepEqual(f.calls.rate, []);
});

test('a bot without Manage Channels or Send Messages refuses with no edit call', async () => {
  const f = fake({ botPerms: ['ViewChannel', 'SendMessages'] });
  await run('lock', f);
  assert.equal(last(f), t('en', 'moderation.tools.err.bot_missing'));
  assert.deepEqual(f.calls.edits, []);
  const g = fake({ botPerms: ['ViewChannel', 'ManageChannels'] });
  await run('lock', g);
  assert.equal(last(g), t('en', 'moderation.tools.err.bot_missing'));
  assert.deepEqual(g.calls.edits, []);
});

test('lock denies only SendMessages for @everyone and posts the notice', async () => {
  const f = fake({ opts: { reason: 'raid' } });
  await run('lock', f);
  assert.equal(f.calls.edits.length, 1);
  const [target, change, options] = f.calls.edits[0];
  assert.equal(target, f.interaction.guild.roles.everyone);
  assert.deepEqual(change, { SendMessages: false });
  assert.equal(options.reason, 'raid');
  assert.equal(f.calls.sent.length, 1);
  assert.match(f.calls.sent[0].content, /<@mod>/);
  assert.match(f.calls.sent[0].content, /raid/);
  assert.match(last(f), /<#c1>/);
});

test('locking an already locked channel is a no-op', async () => {
  const f = fake({ everyoneDeny: true });
  await run('lock', f);
  assert.deepEqual(f.calls.edits, []);
  assert.deepEqual(f.calls.sent, []);
  assert.equal(last(f), t('en', 'moderation.tools.lock.already', { channel: '<#c1>' }));
});

test('unlock clears only SendMessages for @everyone', async () => {
  const f = fake({ everyoneDeny: true });
  await run('unlock', f);
  assert.deepEqual(f.calls.edits[0][1], { SendMessages: null });
  assert.equal(f.calls.sent.length, 1);
});

test('unlocking an unlocked channel is a no-op', async () => {
  const f = fake();
  await run('unlock', f);
  assert.deepEqual(f.calls.edits, []);
  assert.deepEqual(f.calls.sent, []);
  assert.equal(last(f), t('en', 'moderation.tools.unlock.already', { channel: '<#c1>' }));
});

test('lock and unlock refuse threads', async () => {
  for (const n of ['lock', 'unlock']) {
    const f = fake({ type: PUBLIC_THREAD, everyoneDeny: true });
    await run(n, f);
    assert.equal(last(f), t('en', 'moderation.tools.err.bad_channel'));
    assert.deepEqual(f.calls.edits, []);
  }
});

test('lock works in an announcement channel', async () => {
  const f = fake({ type: ANNOUNCEMENT });
  await run('lock', f);
  assert.equal(f.calls.edits.length, 1);
});

test('a failing notice adds the note but the change stands', async () => {
  const f = fake({ sendThrows: true, opts: { seconds: 7 } });
  await run('slowmode', f);
  assert.equal(f.calls.rate.length, 1);
  assert.ok(last(f).includes(t('en', 'moderation.tools.notice_failed')));
  const g = fake({ sendThrows: true });
  await run('lock', g);
  assert.equal(g.calls.edits.length, 1);
  assert.ok(last(g).includes(t('en', 'moderation.tools.notice_failed')));
});

test('a Discord failure on the change is reported and nothing is announced', async () => {
  const f = fake();
  f.interaction.channel.permissionOverwrites.edit = async () => { throw new Error('boom'); };
  await run('lock', f);
  assert.equal(last(f), t('en', 'moderation.tools.err.failed'));
  assert.deepEqual(f.calls.sent, []);
});

test('an explicit channel option is used instead of the current channel', async () => {
  const f = fake({ opts: { seconds: 3 } });
  const other = { ...f.interaction.channel, id: 'c2', setRateLimitPerUser: async (...a) => { f.calls.rate.push(['other', ...a]); } };
  f.interaction.options.getChannel = () => other;
  await run('slowmode', f);
  assert.equal(f.calls.rate[0][0], 'other');
});

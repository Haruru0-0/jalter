import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { EVENTS } from '../../src/features/logging/events.js';
import { toggleEvent, addIgnore, removeIgnore, setupPlan, encodeSettings } from '../../src/features/logging/config.js';
import { commands } from '../../src/features/logging/commands.js';
import { getFeature, setFeature } from '../../src/db/settings.js';
import { testDb } from '../helpers/db.js';

let db;
before(async () => { db = await testDb(); });
after(async () => { await db.end(); });

function fakeInteraction(sub, strings = {}, extra = {}) {
  const replies = [];
  return {
    replies,
    guildId: 'g-setup',
    inGuild: () => true,
    member: { guild: { id: 'g-setup' }, permissions: { has: () => true }, roles: { cache: { has: () => false } } },
    options: { getSubcommand: () => sub, getString: (n) => strings[n] ?? null },
    reply: async (o) => { replies.push(o); },
    deferReply: async () => {},
    editReply: async (o) => { replies.push(typeof o === 'string' ? { content: o } : o); },
    ...extra,
  };
}


const ALL = Object.keys(EVENTS);

test('toggling all off disables all 24 events, on clears them', () => {
  assert.deepEqual(toggleEvent({}, 'all', false).sort(), [...ALL].sort());
  assert.deepEqual(toggleEvent({ disabledEvents: ['ban'] }, 'all', true), []);
});

test('toggling one event adds or removes it without duplicates', () => {
  assert.deepEqual(toggleEvent({}, 'ban', false), ['ban']);
  assert.deepEqual(toggleEvent({ disabledEvents: ['ban'] }, 'ban', false), ['ban']);
  assert.deepEqual(toggleEvent({ disabledEvents: ['ban', 'unban'] }, 'ban', true), ['unban']);
});

test('adding the same ignore id twice keeps one entry and keeps other lists', () => {
  const cfg = { ignore: { channels: ['c1'], members: ['u1'], prefixes: ['!'] } };
  const once = addIgnore(cfg, 'channels', 'c2');
  const twice = addIgnore({ ignore: once }, 'channels', 'c2');
  assert.deepEqual(twice.channels, ['c1', 'c2']);
  assert.deepEqual(twice.members, ['u1']);
  assert.deepEqual(twice.prefixes, ['!']);
  assert.deepEqual(addIgnore({}, 'members', 'u9'), { channels: [], members: ['u9'], prefixes: [] });
});

test('removing an absent id is a no-op, a present id is removed', () => {
  const cfg = { ignore: { channels: ['c1'], members: [], prefixes: [] } };
  assert.deepEqual(removeIgnore(cfg, 'channels', 'zzz'), cfg.ignore);
  assert.deepEqual(removeIgnore(cfg, 'channels', 'c1').channels, []);
  assert.deepEqual(removeIgnore({}, 'prefixes', '!'), { channels: [], members: [], prefixes: [] });
});

test('command data respects discord limits', () => {
  const json = commands[0].data.toJSON();
  const names = json.options.map((o) => o.name);
  for (const n of ['event', 'ignore', 'unignore', 'prefix-add', 'prefix-remove', 'status']) {
    assert.ok(names.includes(n), `missing ${n}`);
  }
  for (const o of json.options) {
    assert.ok(o.name.length <= 32);
    assert.ok(o.description.length <= 100, o.name);
  }
  const ev = json.options.find((o) => o.name === 'event');
  const eventOpt = ev.options.find((o) => o.name === 'event');
  assert.equal(eventOpt.choices.length, 25);
  assert.ok(eventOpt.choices.some((c) => c.value === 'all'));
  assert.equal(ev.options.find((o) => o.name === 'enabled').required, true);
  assert.equal(json.options.find((o) => o.name === 'prefix-add').options[0].max_length, 10);
});

test('setupPlan lists the five log channels with their categories', () => {
  const plan = setupPlan();
  assert.equal(plan.length, 5);
  assert.deepEqual(plan.map((p) => p.category), ['messages', 'members', 'join', 'server', 'voice']);
  assert.deepEqual(plan.map((p) => p.name), ['log-messages', 'log-members', 'log-joins', 'log-server', 'log-voice']);
});

test('import with garbage, wrong version or oversized code leaves the config untouched', async () => {
  const config = { channels: { default: 'c1' }, disabledEvents: ['ban'], ignore: { channels: [], members: [], prefixes: ['!'] } };
  await setFeature(db, 'g-setup', 'logging', { enabled: true, config });
  const before = await getFeature(db, 'g-setup', 'logging');
  const wrongVersion = Buffer.from(JSON.stringify({ v: 2, disabledEvents: [], prefixes: [] })).toString('base64url');
  for (const code of ['%%%not-a-code', wrongVersion, 'A'.repeat(2001)]) {
    const i = fakeInteraction('import', { code });
    await commands[0].execute(i, { db });
    assert.match(i.replies[0].content, /valid|invalid|code/i);
    assert.ok(i.replies[0].flags);
    assert.deepEqual(await getFeature(db, 'g-setup', 'logging'), before);
  }
});

test('import with a valid code writes toggles and prefixes but keeps channels and ignore lists', async () => {
  await setFeature(db, 'g-setup', 'logging', { enabled: true, config: {
    channels: { default: 'c1' }, disabledEvents: [], ignore: { channels: ['x'], members: ['u'], prefixes: [] } } });
  const code = encodeSettings({ disabledEvents: ['ban'], ignore: { prefixes: ['?'] } });
  const i = fakeInteraction('import', { code });
  await commands[0].execute(i, { db });
  const { config } = await getFeature(db, 'g-setup', 'logging');
  assert.deepEqual(config.disabledEvents, ['ban']);
  assert.deepEqual(config.ignore, { channels: ['x'], members: ['u'], prefixes: ['?'] });
  assert.deepEqual(config.channels, { default: 'c1' });
});

test('export replies ephemeral with a code that round-trips', async () => {
  const stored = { disabledEvents: ['ban'], ignore: { channels: [], members: [], prefixes: ['?'] } };
  await setFeature(db, 'g-setup', 'logging', { config: stored });
  const i = fakeInteraction('export');
  await commands[0].execute(i, { db });
  assert.ok(i.replies[0].flags);
  assert.ok(i.replies[0].content.includes(encodeSettings(stored)));
});

test('setup failure replies setupFailed and writes nothing', async () => {
  await setFeature(db, 'g-setup', 'logging', { enabled: false, config: { channels: {} } });
  const i = fakeInteraction('setup', {}, {
    guild: {
      members: { me: { id: 'bot' } },
      roles: { everyone: { id: 'g-setup' } },
      channels: { create: async () => { throw new Error('Missing Permissions'); } },
    },
  });
  await commands[0].execute(i, { db });
  assert.match(i.replies[0].content, /permission|Manage Channels/i);
  const { enabled, config } = await getFeature(db, 'g-setup', 'logging');
  assert.equal(enabled, false);
  assert.deepEqual(config.channels, {});
});

test('setup creates the category and five channels and stores them', async () => {
  await setFeature(db, 'g-setup', 'logging', { enabled: false, config: { channels: {} } });
  let n = 0;
  const created = [];
  const i = fakeInteraction('setup', {}, {
    guild: {
      members: { me: { id: 'bot' } },
      roles: { everyone: { id: 'g-setup' } },
      channels: { create: async (o) => { created.push(o); return { id: `ch${++n}` }; } },
    },
  });
  await commands[0].execute(i, { db });
  assert.equal(created.length, 6);
  assert.equal(created[0].name, 'Logs');
  assert.equal(created[1].parent, 'ch1');
  const { enabled, config } = await getFeature(db, 'g-setup', 'logging');
  assert.equal(enabled, true);
  assert.deepEqual(config.channels, { messages: 'ch2', members: 'ch3', join: 'ch4', server: 'ch5', voice: 'ch6' });
});

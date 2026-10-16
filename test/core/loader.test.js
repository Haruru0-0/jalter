import { test, before, after, mock } from 'node:test';
import assert from 'node:assert/strict';
import { collectModules, routeInteraction } from '../../src/core/loader.js';
import { testDb } from '../helpers/db.js';

let db;
before(async () => { db = await testDb(); });
after(async () => { await db.end(); });

const cmd = (name, extra = {}) => ({ data: { name }, execute: async () => {}, ...extra });

test('collectModules rejects duplicate command names', () => {
  assert.throws(
    () => collectModules([{ commands: [cmd('a')] }, { commands: [cmd('a')] }]),
    /Duplicate command/,
  );
});

test('collectModules rejects duplicate component prefixes', () => {
  const c = (n) => cmd(n, { components: { prefix: 'p', handle: async () => {} } });
  assert.throws(() => collectModules([{ commands: [c('a'), c('b')] }]), /Duplicate component/);
});

test('collectModules gathers events', () => {
  const r = collectModules([{ events: [{ name: 'x' }] }, { events: [{ name: 'y' }] }]);
  assert.equal(r.events.length, 2);
});

test('collectModules gathers jobs and housekeeping and rejects a duplicate job type', () => {
  const h1 = async () => {};
  const h2 = async () => {};
  const hk1 = async () => {};
  const hk2 = async () => {};
  const r = collectModules([
    { jobs: { a: h1 }, housekeeping: [hk1] },
    { jobs: { b: h2 }, housekeeping: [hk2] },
    {},
  ]);
  assert.equal(r.jobs.get('a'), h1);
  assert.equal(r.jobs.get('b'), h2);
  assert.equal(r.jobs.size, 2);
  assert.deepEqual(r.housekeeping, [hk1, hk2]);
  assert.throws(
    () => collectModules([{ jobs: { a: h1 } }, { jobs: { a: h2 } }]),
    /Duplicate job type: a/,
  );
});

test('a button reaches the handler registered for its prefix with the full id', async () => {
  let seen;
  const registry = collectModules([{
    commands: [cmd('embed', { components: { prefix: 'embeds', handle: async (i) => { seen = i.customId; } } })],
  }]);
  const interaction = { isChatInputCommand: () => false, isContextMenuCommand: () => false, customId: 'embeds:send:12' };
  await routeInteraction(interaction, { db }, registry);
  assert.equal(seen, 'embeds:send:12');
});

test('a throwing handler produces an ephemeral error reply and does not reject', async () => {
  const replies = [];
  const registry = collectModules([{
    commands: [cmd('boom', { execute: async () => { throw new Error('x'); } })],
  }]);
  const interaction = {
    isChatInputCommand: () => true, commandName: 'boom', guildId: 'g1',
    replied: false, deferred: false,
    reply: async (o) => { replies.push(o); },
  };
  const spy = mock.method(console, 'error', () => {});
  try {
    await routeInteraction(interaction, { db }, registry);
  } finally {
    spy.mock.restore();
  }
  assert.match(replies[0].content, /went wrong/);
});

test('an unknown component id is ignored', async () => {
  const registry = collectModules([]);
  const interaction = { isChatInputCommand: () => false, isContextMenuCommand: () => false, customId: 'zzz:1' };
  await routeInteraction(interaction, { db }, registry);
});

test('routeInteraction sends autocomplete to the command and answers an empty list when it fails', async () => {
  const seen = [];
  const registry = collectModules([{ commands: [
    cmd('ok', { autocomplete: async (i) => { seen.push(i.commandName); } }),
    cmd('bad', { autocomplete: async () => { throw new Error('boom'); } }),
    cmd('plain'),
  ] }]);
  const make = (commandName) => {
    const responses = [];
    return { commandName, responses, isAutocomplete: () => true, isChatInputCommand: () => false,
      isContextMenuCommand: () => false, respond: async (c) => { responses.push(c); } };
  };
  await routeInteraction(make('ok'), { db }, registry);
  assert.deepEqual(seen, ['ok']);
  const warn = mock.method(console, 'error', () => {});
  const bad = make('bad');
  await routeInteraction(bad, { db }, registry);
  assert.deepEqual(bad.responses, [[]]);
  assert.equal(warn.mock.callCount(), 1);
  warn.mock.restore();
  await routeInteraction(make('plain'), { db }, registry);   // no handler: nothing happens, nothing throws
});

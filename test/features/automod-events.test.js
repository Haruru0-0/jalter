import { test, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { Events } from 'discord.js';
import { createEvents, startAutomodSweep, stopAutomodSweep } from '../../src/features/automod/events.js';
import { collectModules } from '../../src/core/loader.js';
import { modules } from '../../src/modules.js';
import { FEATURES } from '../../src/core/registry.js';

afterEach(() => stopAutomodSweep());

function fakeEngine() {
  const calls = [];
  return { calls, handleMessage: async (ctx, message, opts) => { calls.push({ ctx, message, opts }); }, prune() {} };
}
const find = (events, name) => events.find((e) => e.name === name);

test('messageCreate calls the engine with edited false', async () => {
  const engine = fakeEngine();
  const events = createEvents(engine);
  const message = { id: 'm1', guildId: 'g', author: { bot: false } };
  await find(events, Events.MessageCreate).execute({ c: 1 }, message);
  assert.equal(engine.calls.length, 1);
  assert.equal(engine.calls[0].message, message);
  assert.deepEqual(engine.calls[0].opts, { edited: false });
});

test('messageUpdate fetches a partial message and calls with edited true', async () => {
  const engine = fakeEngine();
  const fresh = { id: 'm1', guildId: 'g', author: { bot: false }, content: 'new' };
  const partial = { id: 'm1', partial: true, fetch: async () => fresh };
  await find(createEvents(engine), Events.MessageUpdate).execute({}, { content: 'old' }, partial);
  assert.equal(engine.calls.length, 1);
  assert.equal(engine.calls[0].message, fresh);
  assert.deepEqual(engine.calls[0].opts, { edited: true, oldContent: 'old' });
});

test('messageUpdate with a null or partial old message has an undefined oldContent', async () => {
  const engine = fakeEngine();
  const update = find(createEvents(engine), Events.MessageUpdate);
  const next = { id: 'm', guildId: 'g', author: { bot: false }, content: 'x' };
  await update.execute({}, null, next);
  await update.execute({}, {}, next);
  assert.equal(engine.calls[0].opts.oldContent, undefined);
  assert.equal(engine.calls[1].opts.oldContent, undefined);
  assert.equal(engine.calls[0].opts.edited, true);
});

test('messageUpdate skips silently when the fetch fails, for bots and for DMs', async () => {
  const engine = fakeEngine();
  const update = find(createEvents(engine), Events.MessageUpdate);
  await update.execute({}, {}, { partial: true, fetch: async () => { throw new Error('gone'); } });
  await update.execute({}, {}, { guildId: 'g', author: { bot: true } });
  await update.execute({}, {}, { guildId: null, author: { bot: false } });
  assert.equal(engine.calls.length, 0);
});

test('an engine error is swallowed', async () => {
  const engine = { handleMessage: async () => { throw new Error('boom'); } };
  const events = createEvents(engine);
  const message = { guildId: 'g', author: { bot: false } };
  const warn = mock.method(console, 'warn', () => {});
  await find(events, Events.MessageCreate).execute({}, message);
  await find(events, Events.MessageUpdate).execute({}, {}, message);
  assert.equal(warn.mock.callCount(), 2);
  assert.ok(warn.mock.calls.every((c) => String(c.arguments[0]).includes('boom')));
  warn.mock.restore();
});

test('the sweep prunes every 60 seconds, is unref ed and is created once', (t) => {
  t.mock.timers.enable({ apis: ['setInterval', 'Date'] });
  const pruned = [];
  const engine = { prune: (now) => pruned.push(now) };
  const first = startAutomodSweep(engine);
  assert.equal(startAutomodSweep(engine), first);
  t.mock.timers.tick(120_000);
  assert.equal(pruned.length, 2);
  assert.equal(typeof pruned[0], 'number');
  stopAutomodSweep();
  t.mock.timers.tick(120_000);
  assert.equal(pruned.length, 2);
});

test('loader accepts the automod module', () => {
  const { events } = collectModules(modules);
  const names = events.filter((e) => [Events.MessageCreate, Events.MessageUpdate].includes(e.name));
  assert.ok(names.length >= 2);
  const r = collectModules(modules);
  assert.ok(r.commands.size > 0);
});

test('registry lists automod with command automod', () => {
  const f = FEATURES.find((x) => x.key === 'automod');
  assert.equal(f.command, 'automod');
  assert.equal(f.enableCommand, 'automod enable');
  assert.equal(f.phase, 2);
});

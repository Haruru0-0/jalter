import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EVENTS } from '../../src/features/logging/events.js';
import { toggleEvent, addIgnore, removeIgnore } from '../../src/features/logging/config.js';
import { commands } from '../../src/features/logging/commands.js';

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

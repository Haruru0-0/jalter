import { test } from 'node:test';
import assert from 'node:assert/strict';
import { commands } from '../../src/features/greet/index.js';
import { messageModal } from '../../src/features/greet/index.js';
import { LANGS } from '../../src/i18n/index.js';

const byName = (name) => commands.find((c) => c.data.name === name);
const set = () => byName('set').data.toJSON();
const groupOf = (name) => set().options.find((o) => o.name === name);
const subNames = (g) => g.options.map((o) => o.name);

test('/set and /test serialise', () => {
  assert.doesNotThrow(() => set());
  assert.doesNotThrow(() => byName('test').data.toJSON());
});

test('/set has a group per kind; dm only for greet and boost', () => {
  assert.deepEqual(set().options.map((o) => o.name), ['greet', 'leave', 'boost']);
  for (const kind of ['greet', 'leave', 'boost']) {
    const subs = subNames(groupOf(kind));
    for (const s of ['channel', 'message', 'card', 'background']) assert.ok(subs.includes(s), `${kind} ${s}`);
    assert.equal(subs.includes('dm'), kind !== 'leave');
  }
});

test('message option is optional and limited; channel and card are required', () => {
  const subs = groupOf('greet').options;
  const message = subs.find((s) => s.name === 'message').options[0];
  assert.equal(message.name, 'message');
  assert.ok(!message.required);
  assert.equal(message.max_length, 2000);
  assert.equal(subs.find((s) => s.name === 'channel').options[0].required, true);
  assert.equal(subs.find((s) => s.name === 'card').options[0].required, true);
});

test('/test has the three subcommands', () => {
  assert.deepEqual(byName('test').data.toJSON().options.map((o) => o.name), ['greet', 'leave', 'boost']);
});

test('the message form is valid in every language', () => {
  for (const lang of LANGS) {
    const json = messageModal(lang, 'greet', 'hello').toJSON();
    assert.equal(json.custom_id, 'set:msg:greet');
    assert.ok(json.title.length <= 45);
    const input = json.components[0].components[0];
    assert.ok(input.label.length <= 45);
    assert.equal(input.value, 'hello');
    assert.equal(input.max_length, 2000);
    assert.equal(input.required, true);
  }
});

test('the component prefix is set', () => {
  assert.equal(byName('set').components.prefix, 'set');
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyEdit, applyEdits } from '../../src/features/embeds/edit.js';

test('setting and clearing a text part', () => {
  const a = applyEdit({}, 'title', ' Rules ');
  assert.deepEqual(a, { ok: true, spec: { title: 'Rules' } });
  assert.deepEqual(applyEdit(a.spec, 'title', ''), { ok: true, spec: {} });
  assert.deepEqual(applyEdit(a.spec, 'title', undefined), { ok: true, spec: {} });
});

test('limits and color are checked', () => {
  assert.deepEqual(applyEdit({}, 'title', 'x'.repeat(257)).errors, ['embeds.err.titleTooLong']);
  assert.deepEqual(applyEdit({}, 'color', 'red').errors, ['embeds.err.badColor']);
  assert.deepEqual(applyEdit({}, 'color', '#5865F2'), { ok: true, spec: { color: '#5865F2' } });
});

test('images and thumbnails are stored as raw strings', () => {
  assert.deepEqual(applyEdit({}, 'image', 'https://x.test/a.png').spec, { image: 'https://x.test/a.png' });
  assert.deepEqual(applyEdit({ thumbnail: 'x' }, 'thumbnail', '{server_icon}').spec, { thumbnail: '{server_icon}' });
});

test('timestamp is a boolean part', () => {
  assert.deepEqual(applyEdit({}, 'timestamp', true).spec, { timestamp: true });
  assert.deepEqual(applyEdit({ timestamp: true }, 'timestamp', false).spec, {});
});

test('author needs text; blank text and icon removes it', () => {
  assert.deepEqual(applyEdit({}, 'author', { text: '{user_name}', icon: '{user_avatar}' }).spec,
    { author: { text: '{user_name}', icon: '{user_avatar}' } });
  assert.deepEqual(applyEdit({}, 'author', { icon: 'https://x.test/i.png' }).errors, ['embeds.err.authorNeedsText']);
  assert.deepEqual(applyEdit({ author: { text: 'a' } }, 'author', {}).spec, {});
});

test('fields can be appended, limited to 25, and cleared', () => {
  let spec = {};
  for (let i = 0; i < 25; i += 1) spec = applyEdit(spec, 'field', { name: `n${i}`, value: 'v', inline: false }).spec;
  assert.equal(spec.fields.length, 25);
  assert.deepEqual(applyEdit(spec, 'field', { name: 'x', value: 'v' }).errors, ['embeds.err.tooManyFields']);
  assert.deepEqual(applyEdit(spec, 'clear-fields').spec.fields, undefined);
  assert.deepEqual(applyEdit({}, 'field', { name: '', value: 'v' }).errors, ['embeds.err.fieldEmpty']);
});

test('the input spec is not mutated and applyEdits stops at the first error', () => {
  const spec = { title: 'a' };
  applyEdit(spec, 'title', 'b');
  assert.equal(spec.title, 'a');
  const r = applyEdits({}, [['title', 'ok'], ['color', 'bad'], ['footer', 'never']]);
  assert.equal(r.ok, false);
  assert.deepEqual(applyEdits({}, [['title', 'ok'], ['footer', 'f']]).spec, { title: 'ok', footer: 'f' });
});

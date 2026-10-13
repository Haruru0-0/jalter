import { test } from 'node:test';
import assert from 'node:assert/strict';
import { specFromFields, quickSpec, errorText, parseInline, appendField } from '../../src/features/embeds/spec.js';

const fake = (values) => (id) => values[id] ?? '';

test('specFromFields trims values and skips empty ones', () => {
  const spec = specFromFields(fake({ title: '  Rules ', description: '', color: '#5865F2', footer: '   ', image: '' }));
  assert.deepEqual(spec, { title: 'Rules', color: '#5865F2' });
});

test('specFromFields parses the image as a link or a stored name', () => {
  assert.deepEqual(specFromFields(fake({ image: ' https://x.test/a.png ' })).image, { type: 'url', url: 'https://x.test/a.png' });
  assert.deepEqual(specFromFields(fake({ image: 'banner' })).image, { type: 'stored', name: 'banner' });
});

test('specFromFields tolerates a missing field returning null', () => {
  assert.deepEqual(specFromFields(() => null), {});
});

test('quickSpec builds a spec from command options and skips blanks', () => {
  assert.deepEqual(
    quickSpec({ title: 'Hi', description: 'Body', color: null, image: '  ' }),
    { title: 'Hi', description: 'Body' },
  );
  assert.deepEqual(
    quickSpec({ title: 'Hi', description: 'Body', color: '#ffffff', image: 'logo' }),
    { title: 'Hi', description: 'Body', color: '#ffffff', image: { type: 'stored', name: 'logo' } },
  );
});

test('errorText lists each translated error on its own line', () => {
  assert.equal(
    errorText('en', ['embeds.err.empty', 'embeds.err.badColor']),
    '• The embed needs at least a title, description, image or field.\n• The color must look like #5865F2.',
  );
});

test('parseInline accepts yes in every language and treats anything else as no', () => {
  for (const v of ['yes', 'Y', ' true ', 'oui', 'نعم', '1']) assert.equal(parseInline(v), true, v);
  for (const v of ['no', '', 'non', 'لا', 'maybe', undefined]) assert.equal(parseInline(v), false, String(v));
});

test('appendField adds a field without changing the original spec', () => {
  const spec = { title: 'T' };
  const r = appendField(spec, { name: ' N ', value: ' V ', inline: true });
  assert.equal(r.ok, true);
  assert.deepEqual(r.spec.fields, [{ name: 'N', value: 'V', inline: true }]);
  assert.equal(spec.fields, undefined);
});

test('appendField rejects a 26th field', () => {
  const fields = Array.from({ length: 25 }, (_, i) => ({ name: `n${i}`, value: 'v', inline: false }));
  const r = appendField({ title: 'T', fields }, { name: 'x', value: 'y', inline: false });
  assert.equal(r.ok, false);
  assert.deepEqual(r.errors, ['embeds.err.tooManyFields']);
});

test('appendField rejects a field that is too long or empty', () => {
  assert.deepEqual(appendField({ title: 'T' }, { name: 'n', value: 'v'.repeat(1025) }).errors, ['embeds.err.fieldTooLong']);
  assert.deepEqual(appendField({ title: 'T' }, { name: ' ', value: 'v' }).errors, ['embeds.err.fieldEmpty']);
});

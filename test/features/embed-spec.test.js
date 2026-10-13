import { test } from 'node:test';
import assert from 'node:assert/strict';
import { specFromFields, quickSpec, errorText } from '../../src/features/embeds/spec.js';

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

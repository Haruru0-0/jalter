import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateEmbed, toDiscordEmbed } from '../../src/features/embeds/model.js';

const longer = (n) => 'x'.repeat(n);

test('an empty spec is rejected', () => {
  assert.deepEqual(validateEmbed({}), { ok: false, errors: ['embeds.err.empty'] });
});

test('a title over 256 characters is rejected', () => {
  const r = validateEmbed({ title: longer(257) });
  assert.ok(r.errors.includes('embeds.err.titleTooLong'));
});

test('a description over 4096 characters is rejected', () => {
  assert.ok(validateEmbed({ description: longer(4097) }).errors.includes('embeds.err.descriptionTooLong'));
});

test('more than 25 fields is rejected', () => {
  const fields = Array.from({ length: 26 }, () => ({ name: 'a', value: 'b' }));
  assert.ok(validateEmbed({ fields }).errors.includes('embeds.err.tooManyFields'));
});

test('a field value over 1024 characters is rejected', () => {
  assert.ok(validateEmbed({ fields: [{ name: 'a', value: longer(1025) }] }).errors.includes('embeds.err.fieldTooLong'));
});

test('total size over 6000 characters is rejected', () => {
  const spec = { title: longer(256), description: longer(4000), footer: longer(1745) };
  assert.ok(validateEmbed(spec).errors.includes('embeds.err.tooLarge'));
});

test('a bad color is rejected', () => {
  assert.ok(validateEmbed({ title: 'a', color: 'red' }).errors.includes('embeds.err.badColor'));
});

test('a valid spec passes', () => {
  assert.deepEqual(validateEmbed({ title: 'Hi', description: 'there', color: '#5865F2' }), { ok: true });
});

test('toDiscordEmbed converts color and puts resolved images in place', () => {
  const e = toDiscordEmbed(
    { title: 'Hi', color: '#5865F2', footer: 'f', fields: [{ name: 'a', value: 'b' }] },
    { image: 'https://x.io/i.png', thumbnail: 'https://x.io/t.png' },
  );
  assert.equal(e.title, 'Hi');
  assert.equal(e.color, 0x5865f2);
  assert.deepEqual(e.footer, { text: 'f' });
  assert.deepEqual(e.image, { url: 'https://x.io/i.png' });
  assert.deepEqual(e.thumbnail, { url: 'https://x.io/t.png' });
  assert.deepEqual(e.fields, [{ name: 'a', value: 'b', inline: false }]);
});

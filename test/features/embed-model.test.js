import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateEmbed, toDiscordEmbed, imageSource, renderEmbedSpec } from '../../src/features/embeds/model.js';

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

test('imageSource accepts strings and old image refs', () => {
  assert.equal(imageSource('https://x.test/a.png'), 'https://x.test/a.png');
  assert.equal(imageSource({ type: 'url', url: 'https://x.test/a.png' }), 'https://x.test/a.png');
  assert.equal(imageSource({ type: 'stored', name: 'logo' }), 'logo');
  assert.equal(imageSource(undefined), undefined);
});

test('author text counts toward limits and the icon needs text', () => {
  assert.ok(validateEmbed({ author: { text: 'x'.repeat(257) } }).errors.includes('embeds.err.authorTooLong'));
  assert.ok(validateEmbed({ title: 't', author: { icon: 'https://x.test/a.png' } }).errors.includes('embeds.err.authorNeedsText'));
  const big = { title: 'x'.repeat(256), description: 'x'.repeat(4000), author: { text: 'x'.repeat(256) }, footer: 'x'.repeat(1489) };
  assert.ok(validateEmbed(big).errors.includes('embeds.err.tooLarge'));
});

test('an embed with only an author, only a thumbnail or only a footer is not empty', () => {
  assert.deepEqual(validateEmbed({ author: { text: 'a' } }), { ok: true });
  assert.deepEqual(validateEmbed({ thumbnail: 'https://x.test/t.png' }), { ok: true });
  assert.deepEqual(validateEmbed({ footer: 'f' }), { ok: true });
});

test('allowEmpty lets an empty embed through but still checks limits', () => {
  assert.deepEqual(validateEmbed({}, { allowEmpty: true }), { ok: true });
  assert.ok(validateEmbed({ title: 'x'.repeat(257) }, { allowEmpty: true }).errors.includes('embeds.err.titleTooLong'));
});

test('toDiscordEmbed adds author and timestamp', () => {
  const e = toDiscordEmbed(
    { title: 'T', author: { text: 'Sam' }, timestamp: true },
    { authorIcon: 'https://x.test/i.png' },
    { now: Date.UTC(2026, 0, 2, 3, 4, 5) },
  );
  assert.deepEqual(e.author, { name: 'Sam', icon_url: 'https://x.test/i.png' });
  assert.equal(e.timestamp, '2026-01-02T03:04:05.000Z');
  assert.equal(toDiscordEmbed({ title: 'T' }).timestamp, undefined);
  assert.deepEqual(toDiscordEmbed({ author: { text: 'Sam' } }).author, { name: 'Sam' });
});

test('renderEmbedSpec renders text and image parts without changing the input', () => {
  const spec = {
    title: 'Hi {user_name}', description: '{server_name}', footer: '#{server_membercount_ordinal}',
    author: { text: '{user_name}', icon: '{user_avatar}' },
    thumbnail: '{server_icon}', image: { type: 'stored', name: 'logo' },
    fields: [{ name: '{user_name}', value: '{date}', inline: true }],
  };
  const vars = { user_name: 'Sam', server_name: 'Home', server_membercount_ordinal: '42nd', user_avatar: 'https://a.test/a.png', server_icon: 'https://a.test/g.png', date: 'D' };
  const out = renderEmbedSpec(spec, vars);
  assert.equal(out.title, 'Hi Sam');
  assert.equal(out.description, 'Home');
  assert.equal(out.footer, '#42nd');
  assert.deepEqual(out.author, { text: 'Sam', icon: 'https://a.test/a.png' });
  assert.equal(out.thumbnail, 'https://a.test/g.png');
  assert.equal(out.image, 'logo');
  assert.deepEqual(out.fields, [{ name: 'Sam', value: 'D', inline: true }]);
  assert.equal(spec.title, 'Hi {user_name}');
});

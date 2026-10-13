import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildWelcomePayload, imagePatch } from '../../src/features/welcome/payload.js';

const vars = { user: '<@1>', username: 'Sam', server: 'Home', count: 42 };

test('text style renders placeholders', () => {
  const p = buildWelcomePayload({ style: 'text', text: 'Hi {user}, #{count} in {server}' }, vars, {});
  assert.deepEqual(p, { content: 'Hi <@1>, #42 in Home' });
});

test('embed style renders placeholders inside the embed', () => {
  const p = buildWelcomePayload(
    { style: 'embed', text: '', embed: { title: 'Welcome {username}', color: '#5865F2' } }, vars, {});
  assert.equal(p.embeds[0].title, 'Welcome Sam');
  assert.equal(p.embeds[0].color, 0x5865f2);
});

test('card style attaches the card file and keeps the text', () => {
  const p = buildWelcomePayload({ style: 'card', text: 'Hi {username}' }, vars, { card: Buffer.from('png') });
  assert.equal(p.content, 'Hi Sam');
  assert.equal(p.files[0].name, 'welcome.png');
});

test('embed style uses the editable text as the description and an event title', () => {
  const p = buildWelcomePayload({ style: 'embed', text: 'Bye {username} from {server}' }, vars, { event: 'leave', lang: 'en' });
  assert.equal(p.embeds[0].description, 'Bye Sam from Home');
  assert.equal(p.embeds[0].title, 'Goodbye Sam');
});

test('the default embed title is per event and follows the language', () => {
  const join = buildWelcomePayload({ style: 'embed', text: 'x' }, vars, { event: 'join', lang: 'en' });
  const boost = buildWelcomePayload({ style: 'embed', text: 'x' }, vars, { event: 'boost', lang: 'fr' });
  assert.equal(join.embeds[0].title, 'Welcome Sam');
  assert.equal(boost.embeds[0].title, 'Merci pour le boost, Sam');
});

test('an explicit embed title wins and the edited text still drives the description', () => {
  const p = buildWelcomePayload(
    { style: 'embed', text: 'Edited {user}', embed: { title: 'Hey {username}', description: 'old' } },
    vars, { event: 'join', lang: 'ar' });
  assert.equal(p.embeds[0].title, 'Hey Sam');
  assert.equal(p.embeds[0].description, 'Edited <@1>');
});

test('the embed carries the resolved image', () => {
  const p = buildWelcomePayload({ style: 'embed', text: 'x', embed: { image: { type: 'url', url: 'u' } } },
    vars, { event: 'join', images: { image: 'https://x.test/a.png' } });
  assert.equal(p.embeds[0].image.url, 'https://x.test/a.png');
});

test('imagePatch sets the card background for card style', () => {
  const ref = { type: 'stored', name: 'bg' };
  assert.deepEqual(imagePatch({ style: 'card' }, ref), { background: ref });
  assert.deepEqual(imagePatch({ style: 'card', background: ref }, null), { background: null });
});

test('imagePatch sets the embed image otherwise, creating the embed if needed', () => {
  const ref = { type: 'url', url: 'https://x.test/a.png' };
  assert.deepEqual(imagePatch({ style: 'text' }, ref), { embed: { image: ref } });
  assert.deepEqual(imagePatch({ style: 'embed', embed: { title: 'T' } }, ref), { embed: { title: 'T', image: ref } });
  assert.deepEqual(imagePatch({ style: 'embed', embed: { title: 'T', image: ref } }, null), { embed: { title: 'T' } });
});

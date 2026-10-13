import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildWelcomePayload } from '../../src/features/welcome/payload.js';

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

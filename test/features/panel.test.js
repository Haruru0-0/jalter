import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildPanelEmbed } from '../../src/features/panel/index.js';

test('every phase 1 feature is Off on a fresh guild; core features say Core', () => {
  const { description } = buildPanelEmbed(new Map(), 'en');
  assert.match(description, /Greet messages\*\*: Off \(\/set greet channel\)/);
  assert.match(description, /Leave messages\*\*: Off \(\/set leave channel\)/);
  assert.match(description, /Boost messages\*\*: Off \(\/set boost channel\)/);
  assert.match(description, /Embeds\*\*: Core$/m);
  assert.match(description, /Post message\*\*: Core$/m);
  assert.match(description, /Panel\*\*: Core$/m);
});

test('an enabled feature says On and still shows its setup command', () => {
  const { description } = buildPanelEmbed(new Map([['greet', { enabled: true }]]), 'en');
  assert.match(description, /Greet messages\*\*: On \(\/set greet channel\)/);
});

test('each feature line shows the command that sets it up', () => {
  const { description } = buildPanelEmbed(new Map(), 'en');
  assert.match(description, /Auto role\*\*: Off \(\/autorole add\)/);
  assert.match(description, /Media storage\*\*: Off \(\/media setup\)/);
});

test('later-phase features say Coming soon without a command', () => {
  const { description } = buildPanelEmbed(new Map(), 'en');
  assert.match(description, /Moderation\*\*: Coming soon$/m);
});

test('the text follows the language', () => {
  const { description } = buildPanelEmbed(new Map(), 'fr');
  assert.match(description, /Désactivé \(\/set greet channel\)/);
});

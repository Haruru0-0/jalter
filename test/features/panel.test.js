import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildPanelEmbed } from '../../src/features/panel/index.js';

test('every phase 1 feature is Off on a fresh guild; core features say Core', () => {
  const { description } = buildPanelEmbed(new Map(), 'en');
  assert.match(description, /Welcome and leave\*\*: Off \(\/welcome setup\)/);
  assert.match(description, /Panel\*\*: Core$/m);
});

test('an enabled feature says On and still shows its setup command', () => {
  const { description } = buildPanelEmbed(new Map([['welcome', { enabled: true }]]), 'en');
  assert.match(description, /Welcome and leave\*\*: On \(\/welcome setup\)/);
});

test('each feature line shows the command that sets it up', () => {
  const { description } = buildPanelEmbed(new Map(), 'en');
  assert.match(description, /Embeds\*\*: Off \(\/embed enable\)/);
  assert.match(description, /Auto role\*\*: Off \(\/autorole setup\)/);
  assert.match(description, /Media storage\*\*: Off \(\/media setup\)/);
});

test('later-phase features say Coming soon without a command', () => {
  const { description } = buildPanelEmbed(new Map(), 'en');
  assert.match(description, /Moderation\*\*: Coming soon$/m);
});

test('the text follows the language', () => {
  const { description } = buildPanelEmbed(new Map(), 'fr');
  assert.match(description, /Désactivé \(\/welcome setup\)/);
});

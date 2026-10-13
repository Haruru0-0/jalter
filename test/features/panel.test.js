import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildPanelEmbed } from '../../src/features/panel/index.js';

test('every phase 1 feature is Off on a fresh guild; core features say Core', () => {
  const { description } = buildPanelEmbed(new Map(), 'en');
  assert.match(description, /Welcome and leave\*\*: Off/);
  assert.match(description, /Panel\*\*: Core/);
});

test('an enabled feature says On', () => {
  const { description } = buildPanelEmbed(new Map([['welcome', { enabled: true }]]), 'en');
  assert.match(description, /Welcome and leave\*\*: On/);
});

test('later-phase features say Coming soon', () => {
  const { description } = buildPanelEmbed(new Map(), 'en');
  assert.match(description, /Moderation\*\*: Coming soon/);
});

test('the text follows the language', () => {
  const { description } = buildPanelEmbed(new Map(), 'fr');
  assert.match(description, /Désactivé/);
});

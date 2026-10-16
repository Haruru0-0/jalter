import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MessageFlags } from 'discord.js';
import { listPayload } from '../../src/features/embeds/list.js';
import { LANGS, t } from '../../src/i18n/index.js';

const card = (payload) => payload.embeds[0].data;

test('the list is one ephemeral card with a count title, numbered names and a hint', () => {
  const payload = listPayload('en', ['news', 'rules', 'welcome']);
  assert.equal(payload.flags, MessageFlags.Ephemeral);
  assert.equal(payload.embeds.length, 1);
  assert.equal(card(payload).title, 'Saved embeds (3)');
  assert.ok(card(payload).description.startsWith('1. `news`\n2. `rules`\n3. `welcome`'));
  assert.ok(card(payload).description.endsWith(t('en', 'embeds.listHint')));
});

test('an empty list says there are none and offers /embed create', () => {
  const payload = listPayload('en', []);
  assert.equal(card(payload).title, t('en', 'embeds.listTitleEmpty'));
  assert.equal(card(payload).description, t('en', 'embeds.none'));
});

test('a very long list is cut to fit with a +N more line', () => {
  const names = Array.from({ length: 400 }, (_, n) => `embed-name-${String(n).padStart(4, '0')}`);
  const { description, title } = card(listPayload('en', names));
  assert.ok(description.length <= 4096);
  assert.match(description, /\+\d+ more/);
  assert.equal(title, 'Saved embeds (400)');
});

test('every language gives a title and a description', () => {
  for (const lang of LANGS) {
    const { title, description } = card(listPayload(lang, ['a', 'b']));
    assert.ok(title.includes('2'), lang);
    assert.ok(description.includes('1. `a`'), lang);
  }
});

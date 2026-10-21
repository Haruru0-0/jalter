import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  STYLES, TYPES, MAX_ENTRIES, SELFDESTRUCT_JOB,
  parseEmoji, emojiKey, checkEntryInput, typeAllowedForStyle,
} from '../../src/features/reactionroles/config.js';

// Fake guild: parseEmoji only needs `emojis.cache.get(id)` returning an object with an `available` field.
const guildWith = (emojis) => ({ emojis: { cache: { get: (id) => emojis[id] } } });
const guild = guildWith({
  '11111111111111111': { id: '11111111111111111', name: 'wave', available: true },
  '22222222222222222': { id: '22222222222222222', name: 'broken', available: false },
});

test('STYLES and TYPES list every value the feature accepts', () => {
  assert.deepEqual(STYLES, ['reactions', 'buttons', 'menu']);
  assert.deepEqual(TYPES, ['normal', 'unique', 'verify', 'drop', 'reversed', 'binding', 'lock']);
});

test('MAX_ENTRIES caps how many options a message can carry; SELFDESTRUCT_JOB names the cron job', () => {
  assert.equal(MAX_ENTRIES, 20);
  assert.equal(SELFDESTRUCT_JOB, 'reactionroles.destruct');
});

test('parseEmoji parses a Unicode emoji with the char as both emoji and key', () => {
  const out = parseEmoji('😀', guild);
  assert.deepEqual(out, { emoji: '😀', key: '😀' });
});

test('parseEmoji parses a custom emoji of this guild with the id as key', () => {
  const out = parseEmoji('<:wave:11111111111111111>', guild);
  assert.deepEqual(out, { emoji: '<:wave:11111111111111111>', key: '11111111111111111' });
});

test('parseEmoji parses an animated custom emoji of this guild', () => {
  const out = parseEmoji('<a:wave:11111111111111111>', guild);
  assert.deepEqual(out, { emoji: '<a:wave:11111111111111111>', key: '11111111111111111' });
});

test('parseEmoji rejects a custom emoji from another guild as foreign', () => {
  const out = parseEmoji('<:other:99999999999999999>', guild);
  assert.deepEqual(out, { error: 'foreign' });
});

test('parseEmoji rejects a custom emoji that exists but is unavailable', () => {
  const out = parseEmoji('<:broken:22222222222222222>', guild);
  assert.deepEqual(out, { error: 'foreign' });
});

test('parseEmoji rejects garbage as invalid', () => {
  assert.deepEqual(parseEmoji('', guild), { error: 'invalid' });
  assert.deepEqual(parseEmoji('notanemoji', guild), { error: 'invalid' });
  assert.deepEqual(parseEmoji('<bad', guild), { error: 'invalid' });
});

test('emojiKey returns the id of a custom emoji or the raw string otherwise', () => {
  assert.equal(emojiKey('<:wave:11111111111111111>'), '11111111111111111');
  assert.equal(emojiKey('<a:wave:11111111111111111>'), '11111111111111111');
  assert.equal(emojiKey('😀'), '😀');
});

test('checkEntryInput requires an emoji for reactions and a label or emoji for buttons and menus', () => {
  assert.equal(checkEntryInput('reactions', { emoji: '😀' }), 'ok');
  assert.equal(checkEntryInput('reactions', { label: 'L' }), 'emoji_required');
  assert.equal(checkEntryInput('buttons', { emoji: '😀' }), 'ok');
  assert.equal(checkEntryInput('buttons', { label: 'L' }), 'ok');
  assert.equal(checkEntryInput('buttons', {}), 'label_required');
  assert.equal(checkEntryInput('menu', { emoji: '😀' }), 'ok');
  assert.equal(checkEntryInput('menu', { label: 'L' }), 'ok');
  assert.equal(checkEntryInput('menu', {}), 'label_required');
});

test('typeAllowedForStyle refuses reversed for buttons and menus, allows it on reactions', () => {
  assert.equal(typeAllowedForStyle('reversed', 'buttons'), false);
  assert.equal(typeAllowedForStyle('reversed', 'menu'), false);
  assert.equal(typeAllowedForStyle('reversed', 'reactions'), true);
  assert.equal(typeAllowedForStyle('normal', 'buttons'), true);
  assert.equal(typeAllowedForStyle('unique', 'menu'), true);
});

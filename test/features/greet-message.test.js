import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildContent, ensureNotEmpty } from '../../src/features/greet/message.js';

const vars = { user: '<@1>', user_name: 'Sam', server_name: 'Home' };

test('buildContent renders placeholders and extracts the embed tag', () => {
  assert.deepEqual(buildContent('hi {user}{newline}{embed:Greet_Embed}', { ...vars, newline: '\n' }),
    { content: 'hi <@1>', embedNames: ['greet_embed'] });
  assert.deepEqual(buildContent('{embed:a}', vars), { content: '', embedNames: ['a'] });
});

test('a mention inside a value is just text (allowedMentions decides pings)', () => {
  assert.equal(buildContent('{user_name}', { user_name: '@everyone' }).content, '@everyone');
});

test('ensureNotEmpty never lets a message be empty', () => {
  assert.deepEqual(ensureNotEmpty({}, 'fallback'), { content: 'fallback' });
  assert.deepEqual(ensureNotEmpty({ content: '' }, 'fallback'), { content: 'fallback' });
  assert.deepEqual(ensureNotEmpty({ embeds: [{}] }, 'fallback'), { embeds: [{}] });
  assert.deepEqual(ensureNotEmpty({ files: [{}] }, 'fallback'), { files: [{}] });
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { safeMentions, extractRoleIds } from '../../src/core/mentions.js';

test('safeMentions parses nothing by default', () => {
  assert.deepEqual(safeMentions(), { parse: [] });
});

test('safeMentions allows only the listed roles', () => {
  assert.deepEqual(safeMentions(['1', '2']), { parse: [], roles: ['1', '2'] });
});

test('extractRoleIds finds role mentions and ignores everyone/here', () => {
  assert.deepEqual(extractRoleIds('hi <@&123> and <@&456> @everyone @here'), ['123', '456']);
});

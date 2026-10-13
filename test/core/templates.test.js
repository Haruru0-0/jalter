import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderTemplate } from '../../src/core/templates.js';

test('known placeholders are replaced', () => {
  assert.equal(
    renderTemplate('Hi {user}, welcome to {server}', { user: '<@1>', server: 'Home' }),
    'Hi <@1>, welcome to Home',
  );
});

test('unknown placeholders and placeholders without a value are left alone', () => {
  assert.equal(renderTemplate('{foo} {count}', { count: 7 }), '{foo} 7');
  assert.equal(renderTemplate('{user}', {}), '{user}');
});

test('a value that contains a placeholder is not expanded again', () => {
  assert.equal(renderTemplate('{username}', { username: '{server}', server: 'Home' }), '{server}');
});

test('text without braces is unchanged', () => {
  assert.equal(renderTemplate('plain', { user: 'x' }), 'plain');
});

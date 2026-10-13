import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderCard } from '../../src/features/welcome/card.js';

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47]);

test('renderCard returns a PNG for a Latin name', async () => {
  const buf = await renderCard({ username: 'Sam', serverName: 'Home' });
  assert.deepEqual(buf.subarray(0, 4), PNG);
});

test('renderCard returns a PNG for an Arabic name', async () => {
  const buf = await renderCard({ username: 'أحمد', serverName: 'الخادم' });
  assert.deepEqual(buf.subarray(0, 4), PNG);
});

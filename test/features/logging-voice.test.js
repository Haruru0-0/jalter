import { test } from 'node:test';
import assert from 'node:assert/strict';
import { voiceTransition } from '../../src/features/logging/format.js';

test('voiceTransition classifies channel changes', () => {
  assert.equal(voiceTransition(null, 'A'), 'voiceJoin');
  assert.equal(voiceTransition('A', 'B'), 'voiceMove');
  assert.equal(voiceTransition('A', null), 'voiceLeave');
  assert.equal(voiceTransition('A', 'A'), null);
  assert.equal(voiceTransition(null, null), null);
  assert.equal(voiceTransition(undefined, undefined), null);
});

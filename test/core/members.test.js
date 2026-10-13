import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fetchGuildMembers } from '../../src/core/members.js';

function quiet(fn) {
  return async () => {
    const warn = console.warn;
    const warnings = [];
    console.warn = (...args) => warnings.push(args.join(' '));
    try { await fn(warnings); } finally { console.warn = warn; }
  };
}

test('fetchGuildMembers fetches every member of the guild', async () => {
  let fetched = 0;
  const guild = { id: 'g1', members: { fetch: async () => { fetched += 1; } } };
  assert.equal(await fetchGuildMembers(guild), true);
  assert.equal(fetched, 1);
});

test('fetchGuildMembers logs and returns false when the fetch fails', quiet(async (warnings) => {
  const guild = { id: 'g1', members: { fetch: async () => { throw new Error('timeout'); } } };
  assert.equal(await fetchGuildMembers(guild), false);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /g1/);
}));

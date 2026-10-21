import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildComponents, missingReactions, syncMessage } from '../../src/features/reactionroles/render.js';

const entries = (n) => Array.from({ length: n }, (_, i) => ({ id: i + 1, roleId: `r${i + 1}`, emoji: null, label: `Role ${i + 1}` }));
const msg = (over = {}) => ({ messageId: 'm1', style: 'buttons', type: 'normal', entries: entries(3), ...over });

test('buttons split into rows of five', () => {
  const rows = buildComponents(msg({ entries: entries(12) }), null);
  assert.deepEqual(rows.map((r) => r.components.length), [5, 5, 2]);
  assert.equal(rows[0].components[0].toJSON().custom_id, 'reactionroles:btn:m1:1');
});

test('twenty buttons fit', () => {
  const rows = buildComponents(msg({ entries: entries(20) }), null);
  assert.equal(rows.length, 4);
  assert.ok(rows.every((r) => r.components.length === 5));
});

test('menu max values follow the type', () => {
  const unique = buildComponents(msg({ style: 'menu', type: 'unique', entries: entries(4) }), null)[0].components[0].toJSON();
  assert.equal(unique.max_values, 1);
  assert.equal(unique.min_values, 0);
  assert.equal(unique.custom_id, 'reactionroles:menu:m1');
  const normal = buildComponents(msg({ style: 'menu', entries: entries(4) }), null)[0].components[0].toJSON();
  assert.equal(normal.max_values, 4);
});

test('menu option falls back to the role name', () => {
  const guild = { roles: { cache: new Map([['r1', { name: 'Gamers' }]]) } };
  const rows = buildComponents(msg({ style: 'menu', entries: [{ id: 1, roleId: 'r1', emoji: null, label: null }] }), guild);
  assert.equal(rows[0].components[0].toJSON().options[0].label, 'Gamers');
});

test('reactions style and empty messages render nothing', () => {
  assert.deepEqual(buildComponents(msg({ style: 'reactions' }), null), []);
  assert.deepEqual(buildComponents(msg({ entries: [] }), null), []);
});

function fakeDiscord(reacted) {
  const removed = [];
  const added = [];
  const cache = new Map(reacted.map(([key, me]) => [key, {
    me,
    emoji: { id: null, name: key },
    users: { remove: async (id) => removed.push([key, id]) },
  }]));
  return { removed, added, reactions: { cache }, react: async (e) => added.push(e) };
}

test('missingReactions lists only emoji the bot has not added', () => {
  const m = msg({ style: 'reactions', entries: [{ id: 1, roleId: 'r1', emoji: '🔥' }, { id: 2, roleId: 'r2', emoji: '🌊' }] });
  assert.deepEqual(missingReactions(m, fakeDiscord([['🔥', true]])), ['🌊']);
  assert.deepEqual(missingReactions(m, fakeDiscord([['🔥', false]])), ['🔥', '🌊']);
});

test('syncMessage removes stale own reactions and adds missing ones', async () => {
  const m = msg({ style: 'reactions', entries: [{ id: 1, roleId: 'r1', emoji: '🔥' }] });
  const d = fakeDiscord([['🌊', true]]);
  const res = await syncMessage({ client: { user: { id: 'bot' } } }, m, d);
  assert.deepEqual(res, { ok: true });
  assert.deepEqual(d.removed, [['🌊', 'bot']]);
  assert.deepEqual(d.added, ['🔥']);
});

test('syncMessage reports failures instead of throwing', async () => {
  const edit = { guild: null, edit: async () => { throw new Error('nope'); } };
  assert.deepEqual(await syncMessage({}, msg(), edit), { ok: false, reason: 'cannot_edit' });
  const react = { reactions: { cache: new Map() }, react: async () => { throw new Error('nope'); } };
  const m = msg({ style: 'reactions', entries: [{ id: 1, roleId: 'r1', emoji: '🔥' }] });
  assert.deepEqual(await syncMessage({ client: { user: { id: 'bot' } } }, m, react), { ok: false, reason: 'cannot_react' });
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ChannelType } from 'discord.js';
import { ensureChannel, ensurePrivateCategory, singleFlight, serialize } from '../../src/core/auto-channel.js';

function fakeGuild({ fail = false } = {}) {
  const created = [];
  return {
    created,
    id: 'g1',
    roles: { everyone: { id: 'everyone' } },
    members: { me: { id: 'bot' } },
    channels: {
      create: async (opts) => {
        if (fail) throw new Error('Missing Permissions');
        const channel = { id: `ch${created.length + 1}`, ...opts };
        created.push(channel);
        return channel;
      },
    },
  };
}

test('ensureChannel creates a text channel with name and parent', async () => {
  const guild = fakeGuild();
  const ch = await ensureChannel(guild, { name: 'welcome', parentId: 'cat1' });
  assert.equal(ch.name, 'welcome');
  assert.equal(ch.type, ChannelType.GuildText);
  assert.equal(ch.parent, 'cat1');
});

test('ensureChannel returns null and warns when creation fails', async () => {
  const warn = console.warn;
  const warnings = [];
  console.warn = (...a) => warnings.push(a.join(' '));
  try {
    assert.equal(await ensureChannel(fakeGuild({ fail: true }), { name: 'x' }), null);
    assert.equal(warnings.length, 1);
  } finally { console.warn = warn; }
});

test('ensurePrivateCategory creates a category hidden from everyone', async () => {
  const guild = fakeGuild();
  const cat = await ensurePrivateCategory(guild, 'Logs');
  assert.equal(cat.type, ChannelType.GuildCategory);
  assert.equal(cat.permissionOverwrites.length, 2);
  assert.equal(cat.permissionOverwrites[0].id, 'everyone');
});

test('singleFlight shares one run per key and clears when done', async () => {
  let runs = 0;
  const fn = async () => { runs += 1; await new Promise((r) => setTimeout(r, 10)); return runs; };
  const results = await Promise.all([1, 2, 3].map(() => singleFlight('k', fn)));
  assert.deepEqual(results, [1, 1, 1]);
  assert.equal(await singleFlight('k', fn), 2);
});

test('singleFlight clears the key when the run throws', async () => {
  await assert.rejects(singleFlight('boom', async () => { throw new Error('x'); }));
  assert.equal(await singleFlight('boom', async () => 'ok'), 'ok');
});

test('serialize runs same-key calls one after another and gives each its own result', async () => {
  const order = [];
  const run = (n) => serialize('s', async () => { order.push(`start${n}`); await new Promise((r) => setTimeout(r, 5)); order.push(`end${n}`); return n; });
  assert.deepEqual(await Promise.all([run(1), run(2)]), [1, 2]);
  assert.deepEqual(order, ['start1', 'end1', 'start2', 'end2']);
});

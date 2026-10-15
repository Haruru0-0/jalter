import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { setChannel, applyMessage, setCard, setBackground, setDm, getKindConfig } from '../../src/features/greet/config.js';
import { DEFAULT_MESSAGE } from '../../src/features/greet/kinds.js';
import { testDb } from '../helpers/db.js';

let db;
before(async () => { db = await testDb(); });
beforeEach(async () => { await db.query('TRUNCATE guild_settings'); });
after(async () => { await db.end(); });

test('setChannel turns the kind on with the default message', async () => {
  await setChannel(db, 'g1', 'greet', 'c1');
  const { enabled, config } = await getKindConfig(db, 'g1', 'greet');
  assert.equal(enabled, true);
  assert.equal(config.channelId, 'c1');
  assert.equal(config.message, DEFAULT_MESSAGE.greet);
});

test('setChannel keeps an existing message and kinds are independent', async () => {
  await setChannel(db, 'g1', 'greet', 'c1');
  await applyMessage(db, 'g1', 'greet', 'custom');
  await setChannel(db, 'g1', 'greet', 'c2');
  const greet = await getKindConfig(db, 'g1', 'greet');
  assert.equal(greet.config.message, 'custom');
  assert.equal(greet.config.channelId, 'c2');
  const leave = await getKindConfig(db, 'g1', 'leave');
  assert.equal(leave.enabled, false);
  assert.deepEqual(leave.config, {});
});

test('applyMessage none/disable turns only that kind off and keeps the channel', async () => {
  await setChannel(db, 'g1', 'greet', 'c1');
  await setChannel(db, 'g1', 'leave', 'c2');
  assert.equal(await applyMessage(db, 'g1', 'greet', '  NONE '), 'disabled');
  const greet = await getKindConfig(db, 'g1', 'greet');
  assert.equal(greet.enabled, false);
  assert.equal(greet.config.channelId, 'c1');
  assert.equal(greet.config.message, DEFAULT_MESSAGE.greet);
  assert.equal((await getKindConfig(db, 'g1', 'leave')).enabled, true);
  await setChannel(db, 'g1', 'greet', 'c1');
  assert.equal(await applyMessage(db, 'g1', 'greet', 'Disable'), 'disabled');
  assert.equal((await getKindConfig(db, 'g1', 'greet')).enabled, false);
});

test('applyMessage saves text; without a channel the kind stays off, with one it is enabled', async () => {
  assert.equal(await applyMessage(db, 'g1', 'boost', 'thanks'), 'saved-needs-channel');
  let boost = await getKindConfig(db, 'g1', 'boost');
  assert.equal(boost.enabled, false);
  assert.equal(boost.config.message, 'thanks');
  await setChannel(db, 'g1', 'boost', 'c1');
  assert.equal(await applyMessage(db, 'g1', 'boost', 'thanks again'), 'saved');
  boost = await getKindConfig(db, 'g1', 'boost');
  assert.equal(boost.enabled, true);
  assert.equal(boost.config.message, 'thanks again');
});

test('card, background and dm are saved; background null clears it and keeps the channel', async () => {
  await setChannel(db, 'g1', 'greet', 'c1');
  await setCard(db, 'g1', 'greet', true);
  await setBackground(db, 'g1', 'greet', 'https://x.test/a.png');
  await setDm(db, 'g1', 'greet', true);
  let { config } = await getKindConfig(db, 'g1', 'greet');
  assert.equal(config.card, true);
  assert.equal(config.background, 'https://x.test/a.png');
  assert.equal(config.dm, true);
  await setBackground(db, 'g1', 'greet', null);
  ({ config } = await getKindConfig(db, 'g1', 'greet'));
  assert.equal(config.background, undefined);
  assert.equal(config.channelId, 'c1');
  assert.equal(config.card, true);
});

function fakeGuild({ fail = false } = {}) {
  const created = [];
  return {
    created,
    channels: {
      create: async (opts) => {
        if (fail) throw new Error('Missing Permissions');
        const ch = { id: `n${created.length + 1}`, ...opts };
        created.push(ch);
        return ch;
      },
    },
  };
}

test('applyMessage with a guild and no channel creates a public channel, saves it and enables', async () => {
  const guild = fakeGuild();
  const result = await applyMessage(db, 'g1', 'greet', 'hi', guild);
  assert.deepEqual(result, { status: 'created', channelId: 'n1' });
  assert.equal(guild.created[0].name, 'welcome');
  assert.equal(guild.created[0].permissionOverwrites, undefined);
  const { enabled, config } = await getKindConfig(db, 'g1', 'greet');
  assert.equal(enabled, true);
  assert.equal(config.channelId, 'n1');
  assert.equal(config.message, 'hi');
});

test('auto channel names: leave goodbye, boost boosts', async () => {
  const guild = fakeGuild();
  await applyMessage(db, 'g1', 'leave', 'bye', guild);
  await applyMessage(db, 'g1', 'boost', 'thx', guild);
  assert.deepEqual(guild.created.map((c) => c.name), ['goodbye', 'boosts']);
});

test('applyMessage with a chosen channel creates nothing', async () => {
  const guild = fakeGuild();
  await setChannel(db, 'g1', 'greet', 'c1');
  assert.equal(await applyMessage(db, 'g1', 'greet', 'hi', guild), 'saved');
  assert.equal(guild.created.length, 0);
});

test('applyMessage falls back to saved-needs-channel when creation fails', async () => {
  const warn = console.warn;
  console.warn = () => {};
  try {
    assert.equal(await applyMessage(db, 'g1', 'greet', 'hi', fakeGuild({ fail: true })), 'saved-needs-channel');
  } finally { console.warn = warn; }
  assert.equal((await getKindConfig(db, 'g1', 'greet')).enabled, false);
});

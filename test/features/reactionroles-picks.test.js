import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { Events, MessageFlags } from 'discord.js';
import { testDb } from '../helpers/db.js';
import { resetDb } from '../../src/db/index.js';
import { setFeature } from '../../src/db/settings.js';
import { createEvents } from '../../src/features/reactionroles/events.js';
import { handle } from '../../src/features/reactionroles/components.js';
import { createMessage, addEntry, getMessage, getBinding, setBinding } from '../../src/features/reactionroles/store.js';

let db;
before(async () => {
  db = await testDb();
});
after(async () => {
  await db.end();
});
beforeEach(async () => {
  await resetDb(db);
  await setFeature(db, 'g1', 'reactionroles', { enabled: true });
});

const ROLES = { A: 'Alpha', B: 'Beta', C: 'Gamma' };

function fakeGuild() {
  const roles = new Map(Object.entries(ROLES).map(([id, name]) => [id, { id, name, position: 1 }]));
  return {
    id: 'g1',
    roles: { cache: roles },
    members: { me: { roles: { highest: { position: 10 } } }, fetch: async () => { throw new Error('unused'); } },
    channels: { fetch: async () => null },
  };
}

// A member whose role changes are recorded; `held` are the role ids they start with.
function fakeMember(guild, held = [], id = 'u1') {
  const cache = new Map(held.map((r) => [r, {}]));
  const calls = [];
  const member = {
    id,
    guild,
    calls,
    roles: {
      cache,
      async add(ids) { calls.push(['add', ids]); for (const r of ids) cache.set(r, {}); },
      async remove(ids) { calls.push(['remove', ids]); for (const r of ids) cache.delete(r); },
    },
  };
  guild.members.fetch = async (uid) => {
    if (uid !== id) throw new Error('unknown member');
    return member;
  };
  return member;
}

function fakeReaction(guild, { messageId = 'm1', emoji = { id: null, name: '🅰️' }, partial = false, failFetch = false, others = {} } = {}) {
  const removed = [];
  const makeReaction = (e) => ({ emoji: e, users: { remove: async (uid) => { removed.push([e.id ?? e.name, uid]); } } });
  const cache = new Map(Object.entries(others).map(([key, e]) => [key, makeReaction(e)]));
  const reaction = {
    ...makeReaction(emoji),
    partial,
    fetch: async () => { if (failFetch) throw new Error('gone'); reaction.partial = false; },
    message: { id: messageId, guild, partial: false, fetch: async () => {}, reactions: { cache } },
  };
  return { reaction, removed, cache };
}

const ctx = () => ({ db, client: { user: { id: 'bot' } } });
const handler = (events, name) => events.find((e) => e.name === name).execute;
const user = (id = 'u1', extra = {}) => ({ id, bot: false, partial: false, ...extra });

async function seed({ style = 'reactions', type = 'normal', messageId = 'm1', entries = [['A', '🅰️'], ['B', '🅱️']] } = {}) {
  await createMessage(db, { guildId: 'g1', messageId, channelId: 'c1', style, type, createdBy: 'x' });
  for (const [roleId, emoji] of entries) {
    await addEntry(db, messageId, style === 'reactions' ? { roleId, emoji } : { roleId, label: ROLES[roleId] });
  }
  return getMessage(db, messageId);
}

test('exports one entry per Discord event', () => {
  assert.deepEqual(createEvents().map((e) => e.name), [
    Events.MessageReactionAdd, Events.MessageReactionRemove, Events.MessageDelete, Events.MessageBulkDelete,
    Events.GuildRoleDelete, Events.ChannelDelete, Events.GuildMemberRemove,
  ]);
});

test('reaction add grants the role through applyPick and keeps the reaction', async () => {
  await seed();
  const guild = fakeGuild();
  const member = fakeMember(guild);
  const { reaction, removed } = fakeReaction(guild);
  await handler(createEvents(), Events.MessageReactionAdd)(ctx(), reaction, user());
  assert.deepEqual(member.calls, [['add', ['A']]]);
  assert.deepEqual(removed, []);
});

test('reaction remove takes the role back', async () => {
  await seed();
  const guild = fakeGuild();
  const member = fakeMember(guild, ['A']);
  const { reaction, removed } = fakeReaction(guild);
  await handler(createEvents(), Events.MessageReactionRemove)(ctx(), reaction, user());
  assert.deepEqual(member.calls, [['remove', ['A']]]);
  assert.deepEqual(removed, []);
});

test('verify message grants the role and removes the reaction', async () => {
  await seed({ type: 'verify' });
  const guild = fakeGuild();
  const member = fakeMember(guild);
  const { reaction, removed } = fakeReaction(guild);
  await handler(createEvents(), Events.MessageReactionAdd)(ctx(), reaction, user());
  assert.deepEqual(member.calls, [['add', ['A']]]);
  assert.deepEqual(removed, [['🅰️', 'u1']]);
});

test('a refused pick removes the reaction and changes no role', async () => {
  await seed({ type: 'lock' });
  const guild = fakeGuild();
  const member = fakeMember(guild);
  const { reaction, removed } = fakeReaction(guild);
  await handler(createEvents(), Events.MessageReactionAdd)(ctx(), reaction, user());
  assert.deepEqual(member.calls, []);
  assert.deepEqual(removed, [['🅰️', 'u1']]);
});

test('a unique pick removes the reactions of the roles it replaced, but not the new one', async () => {
  await seed({ type: 'unique' });
  const guild = fakeGuild();
  const member = fakeMember(guild, ['B']);
  const { reaction, removed } = fakeReaction(guild, { others: { '🅱️': { id: null, name: '🅱️' }, '🅰️': { id: null, name: '🅰️' } } });
  await handler(createEvents(), Events.MessageReactionAdd)(ctx(), reaction, user());
  assert.deepEqual(member.calls, [['remove', ['B']], ['add', ['A']]]);
  assert.deepEqual(removed, [['🅱️', 'u1']]);
});

test('reversed: reacting without the role changes nothing; removing the reaction later is the opt-in', async () => {
  await seed({ type: 'reversed' });
  const guild = fakeGuild();
  const member = fakeMember(guild);
  const events = createEvents();
  const add = fakeReaction(guild);
  await handler(events, Events.MessageReactionAdd)(ctx(), add.reaction, user());
  assert.deepEqual([member.calls, add.removed], [[], []]);
  const remove = fakeReaction(guild);
  await handler(events, Events.MessageReactionRemove)(ctx(), remove.reaction, user());
  assert.deepEqual(member.calls, [['add', ['A']]]);
  assert.deepEqual(remove.removed, []);
});

for (const type of ['normal', 'unique']) {
  test(`${type}: reacting while holding the role changes nothing; the member's own removal revokes it`, async () => {
    await seed({ type });
    const guild = fakeGuild();
    const member = fakeMember(guild, ['A']);
    const events = createEvents();
    const add = fakeReaction(guild);
    await handler(events, Events.MessageReactionAdd)(ctx(), add.reaction, user());
    assert.deepEqual([member.calls, add.removed], [[], []]);
    const remove = fakeReaction(guild);
    await handler(events, Events.MessageReactionRemove)(ctx(), remove.reaction, user());
    assert.deepEqual(member.calls, [['remove', ['A']]]);
    assert.deepEqual(remove.removed, []);
  });
}

test('a custom emoji matches its entry by id', async () => {
  await seed({ entries: [['A', '<:wave:123456789012345678>']] });
  const guild = fakeGuild();
  const member = fakeMember(guild);
  const { reaction } = fakeReaction(guild, { emoji: { id: '123456789012345678', name: 'wave' } });
  await handler(createEvents(), Events.MessageReactionAdd)(ctx(), reaction, user());
  assert.deepEqual(member.calls, [['add', ['A']]]);
});

test('a stray emoji on a role message is removed on add only', async () => {
  await seed();
  const guild = fakeGuild();
  const member = fakeMember(guild);
  const stray = { id: null, name: '🍕' };
  const add = fakeReaction(guild, { emoji: stray });
  await handler(createEvents(), Events.MessageReactionAdd)(ctx(), add.reaction, user());
  assert.deepEqual(add.removed, [['🍕', 'u1']]);
  const remove = fakeReaction(guild, { emoji: stray });
  await handler(createEvents(), Events.MessageReactionRemove)(ctx(), remove.reaction, user());
  assert.deepEqual(remove.removed, []);
  assert.deepEqual(member.calls, []);
});

test('bot reactions and the bot own reaction are ignored', async () => {
  await seed();
  const guild = fakeGuild();
  fakeMember(guild, [], 'bot');
  const calls = [];
  const events = createEvents({ applyPick: async (...a) => { calls.push(a); return { ok: true, added: [], removed: [], clearReaction: true }; } });
  const a = fakeReaction(guild);
  await handler(events, Events.MessageReactionAdd)(ctx(), a.reaction, user('other', { bot: true }));
  const b = fakeReaction(guild);
  await handler(events, Events.MessageReactionAdd)(ctx(), b.reaction, user('bot'));
  assert.deepEqual(calls, []);
  assert.deepEqual([...a.removed, ...b.removed], []);
});

test('a reaction on an unknown message does nothing and keeps the reaction', async () => {
  const guild = fakeGuild();
  const member = fakeMember(guild);
  const { reaction, removed } = fakeReaction(guild, { messageId: 'nope' });
  await handler(createEvents(), Events.MessageReactionAdd)(ctx(), reaction, user());
  assert.deepEqual([member.calls, removed], [[], []]);
});

test('a reaction on a buttons message is ignored', async () => {
  await seed({ style: 'buttons' });
  const guild = fakeGuild();
  const member = fakeMember(guild);
  const { reaction, removed } = fakeReaction(guild);
  await handler(createEvents(), Events.MessageReactionAdd)(ctx(), reaction, user());
  assert.deepEqual([member.calls, removed], [[], []]);
});

test('a reaction while the feature is off does nothing, even a stray one', async () => {
  await seed();
  await setFeature(db, 'g1', 'reactionroles', { enabled: false });
  const guild = fakeGuild();
  const member = fakeMember(guild);
  const a = fakeReaction(guild);
  await handler(createEvents(), Events.MessageReactionAdd)(ctx(), a.reaction, user());
  const stray = fakeReaction(guild, { emoji: { id: null, name: '🍕' } });
  await handler(createEvents(), Events.MessageReactionAdd)(ctx(), stray.reaction, user());
  assert.deepEqual([member.calls, a.removed, stray.removed], [[], [], []]);
});

test('a partial reaction is fetched before use', async () => {
  await seed();
  const guild = fakeGuild();
  const member = fakeMember(guild);
  const { reaction } = fakeReaction(guild, { partial: true });
  await handler(createEvents(), Events.MessageReactionAdd)(ctx(), reaction, user());
  assert.deepEqual(member.calls, [['add', ['A']]]);
});

test('a partial reaction or user that fails to fetch is ignored without throwing', async () => {
  await seed();
  const guild = fakeGuild();
  const member = fakeMember(guild);
  const a = fakeReaction(guild, { partial: true, failFetch: true });
  await handler(createEvents(), Events.MessageReactionAdd)(ctx(), a.reaction, user());
  const b = fakeReaction(guild);
  await handler(createEvents(), Events.MessageReactionAdd)(ctx(), b.reaction, user('u1', { partial: true, fetch: async () => { throw new Error('gone'); } }));
  assert.deepEqual([member.calls, a.removed, b.removed], [[], [], []]);
});

test('a member that cannot be fetched is ignored and the reaction stays', async () => {
  await seed();
  const guild = fakeGuild();
  fakeMember(guild);
  const { reaction, removed } = fakeReaction(guild);
  await handler(createEvents(), Events.MessageReactionAdd)(ctx(), reaction, user('stranger'));
  assert.deepEqual(removed, []);
});

test('MessageDelete and MessageBulkDelete forget the stored messages', async () => {
  await seed({ messageId: 'm1' });
  await seed({ messageId: 'm2' });
  await seed({ messageId: 'm3' });
  const events = createEvents();
  await handler(events, Events.MessageDelete)(ctx(), { id: 'm1' });
  assert.equal(await getMessage(db, 'm1'), null);
  await handler(events, Events.MessageBulkDelete)(ctx(), new Map([['m2', {}], ['m3', {}]]));
  assert.deepEqual([await getMessage(db, 'm2'), await getMessage(db, 'm3')], [null, null]);
});

test('ChannelDelete forgets the messages of that channel only', async () => {
  await seed({ messageId: 'm1' });
  await createMessage(db, { guildId: 'g1', messageId: 'm9', channelId: 'c2', style: 'buttons', createdBy: 'x' });
  await handler(createEvents(), Events.ChannelDelete)(ctx(), { id: 'c1', guild: { id: 'g1' } });
  assert.equal(await getMessage(db, 'm1'), null);
  assert.ok(await getMessage(db, 'm9'));
});

test('RoleDelete removes the entry and re-syncs the Discord message', async () => {
  await seed({ style: 'buttons' });
  const edits = [];
  const discordMessage = { guild: fakeGuild(), edit: async (p) => { edits.push(p); } };
  const guild = {
    id: 'g1',
    channels: { fetch: async (id) => (id === 'c1' ? { messages: { fetch: async (m) => (m === 'm1' ? discordMessage : null) } } : null) },
  };
  await handler(createEvents(), Events.GuildRoleDelete)(ctx(), { id: 'A', guild });
  assert.deepEqual((await getMessage(db, 'm1')).entries.map((e) => e.roleId), ['B']);
  assert.equal(edits.length, 1);
  assert.equal(edits[0].components[0].components.length, 1);
});

test('RoleDelete of a role in no message touches nothing', async () => {
  await seed();
  const guild = { id: 'g1', channels: { fetch: async () => { throw new Error('unused'); } } };
  await handler(createEvents(), Events.GuildRoleDelete)(ctx(), { id: 'Z', guild });
  assert.equal((await getMessage(db, 'm1')).entries.length, 2);
});

test('GuildMemberRemove clears that member bindings only', async () => {
  await seed({ type: 'binding' });
  await setBinding(db, { guildId: 'g1', messageId: 'm1', userId: 'u1', roleId: 'A' });
  await setBinding(db, { guildId: 'g1', messageId: 'm1', userId: 'u2', roleId: 'B' });
  await handler(createEvents(), Events.GuildMemberRemove)(ctx(), { id: 'u1', guild: { id: 'g1' } });
  assert.equal(await getBinding(db, 'm1', 'u1'), null);
  assert.equal(await getBinding(db, 'm1', 'u2'), 'B');
});

test('an event handler never throws', async () => {
  const warn = console.warn;
  console.warn = () => {};
  try {
    const events = createEvents({ applyPick: async () => { throw new Error('boom'); } });
    await seed();
    const guild = fakeGuild();
    fakeMember(guild);
    await handler(events, Events.MessageReactionAdd)(ctx(), fakeReaction(guild).reaction, user());
  } finally {
    console.warn = warn;
  }
});

// Interactions.
function fakeInteraction(guild, member, customId, extra = {}) {
  const replies = [];
  return {
    replies,
    guildId: 'g1',
    guild,
    member,
    user: { id: member.id },
    customId,
    reply: async (p) => { replies.push(p); },
    ...extra,
  };
}

test('a button click replies ephemerally with the added role name', async () => {
  const message = await seed({ style: 'buttons' });
  const guild = fakeGuild();
  const member = fakeMember(guild);
  const i = fakeInteraction(guild, member, `reactionroles:btn:m1:${message.entries[0].id}`);
  await handle(i, ctx());
  assert.deepEqual(member.calls, [['add', ['A']]]);
  assert.deepEqual(i.replies, [{ content: 'You now have Alpha.', flags: MessageFlags.Ephemeral }]);
});

test('a second button click removes the role and says so', async () => {
  const message = await seed({ style: 'buttons' });
  const guild = fakeGuild();
  const member = fakeMember(guild, ['A']);
  const i = fakeInteraction(guild, member, `reactionroles:btn:m1:${message.entries[0].id}`);
  await handle(i, ctx());
  assert.deepEqual(member.calls, [['remove', ['A']]]);
  assert.deepEqual(i.replies, [{ content: 'Alpha was removed.', flags: MessageFlags.Ephemeral }]);
});

test('a refused button click replies with the refusal text', async () => {
  const message = await seed({ style: 'buttons', type: 'lock' });
  const guild = fakeGuild();
  const member = fakeMember(guild);
  const i = fakeInteraction(guild, member, `reactionroles:btn:m1:${message.entries[0].id}`);
  await handle(i, ctx());
  assert.deepEqual(member.calls, []);
  assert.deepEqual(i.replies, [{ content: 'You cannot change your roles on this message.', flags: MessageFlags.Ephemeral }]);
});

test('a button of a disabled feature replies that reaction roles are off', async () => {
  const message = await seed({ style: 'buttons' });
  await setFeature(db, 'g1', 'reactionroles', { enabled: false });
  const guild = fakeGuild();
  const member = fakeMember(guild);
  const i = fakeInteraction(guild, member, `reactionroles:btn:m1:${message.entries[0].id}`);
  await handle(i, ctx());
  assert.deepEqual(member.calls, []);
  assert.deepEqual(i.replies, [{ content: 'Reaction roles are off.', flags: MessageFlags.Ephemeral }]);
});

test('a menu of a disabled feature replies that reaction roles are off', async () => {
  await seed({ style: 'menu' });
  await setFeature(db, 'g1', 'reactionroles', { enabled: false });
  const guild = fakeGuild();
  const member = fakeMember(guild);
  const i = fakeInteraction(guild, member, 'reactionroles:menu:m1', { values: ['A'] });
  await handle(i, ctx());
  assert.deepEqual(member.calls, []);
  assert.equal(i.replies[0].content, 'Reaction roles are off.');
});

test('a button whose message or entry was removed replies gone', async () => {
  const message = await seed({ style: 'buttons' });
  const guild = fakeGuild();
  const member = fakeMember(guild);
  const missingMessage = fakeInteraction(guild, member, 'reactionroles:btn:nope:1');
  await handle(missingMessage, ctx());
  const missingEntry = fakeInteraction(guild, member, `reactionroles:btn:m1:${message.entries[0].id + 999}`);
  await handle(missingEntry, ctx());
  assert.deepEqual([missingMessage.replies, missingEntry.replies], [
    [{ content: 'I cannot find that role message.', flags: MessageFlags.Ephemeral }],
    [{ content: 'I cannot find that role message.', flags: MessageFlags.Ephemeral }],
  ]);
  assert.deepEqual(member.calls, []);
});

test('a menu selection adds the chosen roles and removes the unchosen ones', async () => {
  await seed({ style: 'menu' });
  const guild = fakeGuild();
  const member = fakeMember(guild, ['B']);
  const i = fakeInteraction(guild, member, 'reactionroles:menu:m1', { values: ['A'] });
  await handle(i, ctx());
  assert.deepEqual(member.calls, [['remove', ['B']], ['add', ['A']]]);
  assert.deepEqual(i.replies, [{ content: 'You now have Alpha.\nBeta was removed.', flags: MessageFlags.Ephemeral }]);
});

test('an empty menu selection on a verify message removes nothing', async () => {
  await seed({ style: 'menu', type: 'verify' });
  const guild = fakeGuild();
  const member = fakeMember(guild, ['A']);
  const i = fakeInteraction(guild, member, 'reactionroles:menu:m1', { values: [] });
  await handle(i, ctx());
  assert.deepEqual(member.calls, []);
  assert.equal(i.replies.length, 1);
});

test('a member missing from the interaction cache is fetched', async () => {
  const message = await seed({ style: 'buttons' });
  const guild = fakeGuild();
  const member = fakeMember(guild);
  const i = fakeInteraction(guild, { id: 'u1' }, `reactionroles:btn:m1:${message.entries[0].id}`);
  await handle(i, ctx());
  assert.deepEqual(member.calls, [['add', ['A']]]);
});

test('a foreign prefix or a DM is ignored', async () => {
  const guild = fakeGuild();
  const member = fakeMember(guild);
  const other = fakeInteraction(guild, member, 'other:btn:m1:1');
  await handle(other, ctx());
  const dm = fakeInteraction(guild, member, 'reactionroles:btn:m1:1', { guildId: null });
  await handle(dm, ctx());
  assert.deepEqual([other.replies, dm.replies], [[], []]);
});

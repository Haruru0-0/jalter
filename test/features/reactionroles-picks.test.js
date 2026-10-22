import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { Events, MessageFlags } from 'discord.js';
import { testDb } from '../helpers/db.js';
import { resetDb } from '../../src/db/index.js';
import { setFeature } from '../../src/db/settings.js';
import { createEvents } from '../../src/features/reactionroles/events.js';
import { handle } from '../../src/features/reactionroles/components.js';
import { createMessage, addEntry, getMessage, getBinding, setBinding, updateMessage } from '../../src/features/reactionroles/store.js';
import { fakeDiscordMember, heldRoles } from '../helpers/discord-member.js';

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

// A member that behaves like discord.js (see test/helpers/discord-member.js); `held` are the role ids they start with.
function fakeMember(guild, held = [], id = 'u1') {
  return fakeDiscordMember(guild, { id, held });
}

// `fetched` records every REST fetch of the reaction or its message (partials are fetched before use).
function fakeReaction(guild, { messageId = 'm1', emoji = { id: null, name: '🅰️' }, partial = false, messagePartial = false, failFetch = false, others = {} } = {}) {
  const removed = [];
  const fetched = [];
  const makeReaction = (e) => ({ emoji: e, users: { remove: async (uid) => { removed.push([e.id ?? e.name, uid]); } } });
  const cache = new Map(Object.entries(others).map(([key, e]) => [key, makeReaction(e)]));
  const reaction = {
    ...makeReaction(emoji),
    partial,
    fetch: async () => { fetched.push('reaction'); if (failFetch) throw new Error('gone'); reaction.partial = false; },
    message: {
      id: messageId, guildId: guild.id, guild, partial: messagePartial, reactions: { cache },
      fetch: async () => { fetched.push('message'); reaction.message.partial = false; },
    },
  };
  return { reaction, removed, cache, fetched };
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
  assert.deepEqual(member.calls, [['put', 'A']]);
  assert.deepEqual(removed, []);
});

test('reaction remove takes the role back', async () => {
  await seed();
  const guild = fakeGuild();
  const member = fakeMember(guild, ['A']);
  const { reaction, removed } = fakeReaction(guild);
  await handler(createEvents(), Events.MessageReactionRemove)(ctx(), reaction, user());
  assert.deepEqual(member.calls, [['delete', 'A']]);
  assert.deepEqual(removed, []);
});

test('verify message grants the role and removes the reaction', async () => {
  await seed({ type: 'verify' });
  const guild = fakeGuild();
  const member = fakeMember(guild);
  const { reaction, removed } = fakeReaction(guild);
  await handler(createEvents(), Events.MessageReactionAdd)(ctx(), reaction, user());
  assert.deepEqual(member.calls, [['put', 'A']]);
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
  assert.deepEqual(member.calls, [['put', 'A'], ['delete', 'B']]);
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
  assert.deepEqual(member.calls, [['put', 'A']]);
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
    assert.deepEqual(member.calls, [['delete', 'A']]);
    assert.deepEqual(remove.removed, []);
  });
}

test('a custom emoji matches its entry by id', async () => {
  await seed({ entries: [['A', '<:wave:123456789012345678>']] });
  const guild = fakeGuild();
  const member = fakeMember(guild);
  const { reaction } = fakeReaction(guild, { emoji: { id: '123456789012345678', name: 'wave' } });
  await handler(createEvents(), Events.MessageReactionAdd)(ctx(), reaction, user());
  assert.deepEqual(member.calls, [['put', 'A']]);
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
  assert.deepEqual(member.calls, [['put', 'A']]);
});

test('a partial reaction or user that fails to fetch is ignored without throwing', async () => {
  await seed();
  const guild = fakeGuild();
  const member = fakeMember(guild);
  const a = fakeReaction(guild, { partial: true, failFetch: true });
  await handler(createEvents(), Events.MessageReactionAdd)(ctx(), a.reaction, user());
  const b = fakeReaction(guild);
  await handler(createEvents(), Events.MessageReactionAdd)(ctx(), b.reaction, user('u1', { partial: true, bot: null, fetch: async () => { throw new Error('gone'); } }));
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

// I3: a refusal decided after the rules (role gone, bot can no longer give it, Discord error) clears the
// member's reaction; the Remove event that clearing fires finds nothing to change.
for (const [reason, arrange] of [
  ['role_missing', (guild) => { guild.roles.cache.delete('A'); }],
  ['cannot_give', (guild) => { guild.roles.cache.set('A', { id: 'A', name: 'Alpha', position: 50 }); }],
  ['discord_failed', (guild, member) => { member.failOn.add('put'); }],
]) {
  test(`${reason} on a reaction add removes the reaction and the follow-up Remove changes nothing`, async () => {
    await seed();
    const guild = fakeGuild();
    const member = fakeMember(guild);
    arrange(guild, member);
    const events = createEvents();
    const warn = console.warn;
    console.warn = () => {};
    try {
      const add = fakeReaction(guild);
      await handler(events, Events.MessageReactionAdd)(ctx(), add.reaction, user());
      assert.deepEqual(add.removed, [['🅰️', 'u1']]);
      const before = member.calls.length;
      const remove = fakeReaction(guild);
      await handler(events, Events.MessageReactionRemove)(ctx(), remove.reaction, user());
      assert.equal(member.calls.length, before);
      assert.deepEqual(heldRoles(member), []);
    } finally {
      console.warn = warn;
    }
  });
}

// I4: a reaction on a message that is not ours, or while the feature is off, costs no REST call.
test('a reaction on an unknown message or with the feature off fetches nothing', async () => {
  await seed();
  const guild = fakeGuild();
  fakeMember(guild);
  const userFetches = [];
  const partialUser = () => user('u1', { partial: true, bot: null, fetch: async () => { userFetches.push('user'); } });
  const unknown = fakeReaction(guild, { messageId: 'nope', partial: true, messagePartial: true });
  await handler(createEvents(), Events.MessageReactionAdd)(ctx(), unknown.reaction, partialUser());
  await setFeature(db, 'g1', 'reactionroles', { enabled: false });
  const off = fakeReaction(guild, { partial: true, messagePartial: true });
  await handler(createEvents(), Events.MessageReactionAdd)(ctx(), off.reaction, partialUser());
  assert.deepEqual([unknown.fetched, off.fetched, userFetches, guild.members.fetches], [[], [], [], []]);
});

test('a hit hydrates the partials, and a user already known not to be a bot is not fetched', async () => {
  await seed();
  const guild = fakeGuild();
  const member = fakeMember(guild);
  const userFetches = [];
  const r = fakeReaction(guild, { partial: true, messagePartial: true });
  await handler(createEvents(), Events.MessageReactionAdd)(ctx(), r.reaction, user('u1', { partial: true, fetch: async () => { userFetches.push('user'); } }));
  assert.deepEqual(r.fetched, ['reaction', 'message']);
  assert.deepEqual(userFetches, []);
  assert.deepEqual(member.calls, [['put', 'A']]);
});

test('a partial user whose bot flag is unknown is fetched, and a bot is then ignored', async () => {
  await seed();
  const guild = fakeGuild();
  const member = fakeMember(guild);
  const u = user('u1', { partial: true, bot: null });
  u.fetch = async () => { u.bot = true; u.partial = false; };
  await handler(createEvents(), Events.MessageReactionAdd)(ctx(), fakeReaction(guild).reaction, u);
  assert.deepEqual(member.calls, []);
});

// I6: a deleted role leaves the whitelist and blacklist of every message of the guild.
test('RoleDelete strips the role from every whitelist and blacklist of the guild', async () => {
  await seed({ messageId: 'm1' });
  await seed({ messageId: 'm2' });
  await createMessage(db, { guildId: 'g2', messageId: 'm9', channelId: 'c9', style: 'buttons', createdBy: 'x' });
  await updateMessage(db, 'm1', { whitelist: ['Z', 'K'], blacklist: ['Z'] });
  await updateMessage(db, 'm2', { blacklist: ['K', 'Z'] });
  await updateMessage(db, 'm9', { whitelist: ['Z'] });
  const guild = { id: 'g1', channels: { fetch: async () => null } };
  await handler(createEvents(), Events.GuildRoleDelete)(ctx(), { id: 'Z', guild });
  const [m1, m2, m9] = await Promise.all(['m1', 'm2', 'm9'].map((id) => getMessage(db, id)));
  assert.deepEqual([m1.whitelist, m1.blacklist, m2.blacklist, m9.whitelist], [['K'], [], ['K'], ['Z']]);
});

// T7#22: one message that fails to sync does not stop the others.
test('RoleDelete keeps syncing the other messages when one sync fails', async () => {
  await seed({ style: 'buttons', messageId: 'm1' });
  await seed({ style: 'buttons', messageId: 'm2' });
  const edits = [];
  const discordMessage = (id) => ({ guild: fakeGuild(), edit: async (p) => { edits.push([id, p]); } });
  // A fetch that throws outright (not a rejected promise) for m1 escapes the .catch() guards.
  const fetchMessage = (m) => { if (m === 'm1') throw new Error('boom'); return Promise.resolve(discordMessage(m)); };
  const guild = { id: 'g1', channels: { fetch: async () => ({ messages: { fetch: fetchMessage } }) } };
  const warn = console.warn;
  console.warn = () => {};
  try {
    await handler(createEvents(), Events.GuildRoleDelete)(ctx(), { id: 'A', guild });
  } finally {
    console.warn = warn;
  }
  assert.deepEqual(edits.map(([id]) => id), ['m2']);
  assert.deepEqual((await getMessage(db, 'm2')).entries.map((e) => e.roleId), ['B']);
});

// Interactions.
// `replies` holds what the member is shown, from reply() or the editReply() that ends a deferred pick.
// `deferred` records each deferReply, with how many role calls and member fetches had happened by then.
function fakeInteraction(guild, member, customId, extra = {}) {
  const replies = [];
  const deferred = [];
  return {
    replies,
    deferred,
    guildId: 'g1',
    guild,
    member,
    user: { id: member.id },
    customId,
    reply: async (p) => { replies.push(p); },
    deferReply: async (p) => { deferred.push({ ...p, calls: member.calls?.length ?? 0, fetches: guild.members.fetches?.length ?? 0 }); },
    editReply: async (p) => { replies.push(p); },
    ...extra,
  };
}

const DEFERRED = [{ flags: MessageFlags.Ephemeral, calls: 0, fetches: 0 }];

test('a button click replies ephemerally with the added role name', async () => {
  const message = await seed({ style: 'buttons' });
  const guild = fakeGuild();
  const member = fakeMember(guild);
  const i = fakeInteraction(guild, member, `reactionroles:btn:m1:${message.entries[0].id}`);
  await handle(i, ctx());
  assert.deepEqual(member.calls, [['put', 'A']]);
  // I5: acknowledged before the member fetch and the role call, answered with editReply.
  assert.deepEqual(i.deferred, DEFERRED);
  assert.deepEqual(i.replies, ['You now have Alpha.']);
});

test('a second button click removes the role and says so', async () => {
  const message = await seed({ style: 'buttons' });
  const guild = fakeGuild();
  const member = fakeMember(guild, ['A']);
  const i = fakeInteraction(guild, member, `reactionroles:btn:m1:${message.entries[0].id}`);
  await handle(i, ctx());
  assert.deepEqual(member.calls, [['delete', 'A']]);
  assert.deepEqual(i.deferred, DEFERRED);
  assert.deepEqual(i.replies, ['Alpha was removed.']);
});

test('a refused button click replies with the refusal text', async () => {
  const message = await seed({ style: 'buttons', type: 'lock' });
  const guild = fakeGuild();
  const member = fakeMember(guild);
  const i = fakeInteraction(guild, member, `reactionroles:btn:m1:${message.entries[0].id}`);
  await handle(i, ctx());
  assert.deepEqual(member.calls, []);
  assert.deepEqual(i.replies, ['You cannot change your roles on this message.']);
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
  assert.deepEqual(member.calls, [['put', 'A'], ['delete', 'B']]);
  assert.deepEqual(i.deferred, DEFERRED);
  assert.deepEqual(i.replies, ['You now have Alpha.\nBeta was removed.']);
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
  assert.deepEqual(member.calls, [['put', 'A']]);
  assert.deepEqual(i.replies, ['You now have Alpha.']);
});

test('a member who cannot be fetched gets the generic error after the defer', async () => {
  const message = await seed({ style: 'buttons' });
  const guild = fakeGuild();
  fakeMember(guild);
  const i = fakeInteraction(guild, { id: 'stranger' }, `reactionroles:btn:m1:${message.entries[0].id}`);
  await handle(i, ctx());
  assert.equal(i.deferred.length, 1);
  assert.deepEqual(i.replies, ['Something went wrong. Please try again.']);
});

// C1 + C2 through the button route: two quick clicks on a unique message, the cache never catching up.
test('two quick clicks on different buttons of a unique message leave one role', async () => {
  const message = await seed({ style: 'buttons', type: 'unique' });
  const guild = fakeGuild();
  const member = fakeMember(guild, ['A']);
  const click = (roleId) => fakeInteraction(guild, member, `reactionroles:btn:m1:${message.entries.find((e) => e.roleId === roleId).id}`);
  await Promise.all([handle(click('B'), ctx()), handle(click('A'), ctx())]);
  assert.equal(heldRoles(member).length, 1);
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

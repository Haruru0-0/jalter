import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { PermissionFlagsBits as P } from 'discord.js';
import { testDb } from '../helpers/db.js';
import { resetDb } from '../../src/db/index.js';
import { setFeature } from '../../src/db/settings.js';
import { t } from '../../src/i18n/index.js';
import { createEmbed, saveEmbed } from '../../src/features/embeds/store.js';
import { createMessage, getMessage, addEntry } from '../../src/features/reactionroles/store.js';
import { createReactionRolesCommand, checkRoleForSetup as fromCommands } from '../../src/features/reactionroles/commands.js';
import { checkRoleForSetup, loadMessage } from '../../src/features/reactionroles/setup.js';
import { logReactionRoles } from '../../src/features/reactionroles/log.js';
import { commands } from '../../src/features/reactionroles/index.js';

let db;
before(async () => { db = await testDb(); });
beforeEach(async () => { await resetDb(db); });
after(async () => { await db.end(); });

const G = 'g1';
const BOT = 'bot1';
const command = createReactionRolesCommand();
const has = (bits) => ({ bitfield: bits, has: (flag) => (bits & P[flag]) === P[flag] });
const FULL = P.ManageRoles | P.AddReactions | P.ReadMessageHistory | P.ManageMessages;

const role = (id, position = 1, extra = {}) => ({ id, position, managed: false, permissions: { has: () => false }, ...extra });

function fakeDiscordMessage(id, { author = BOT, embeds = [{}], components = [], reactions = [] } = {}) {
  const added = [];
  const edits = [];
  return {
    id, author: { id: author }, embeds, components, added, edits,
    reactions: { cache: new Map(reactions.map((k) => [k, { me: true, emoji: { id: null, name: k }, users: { remove: async () => {} } }])) },
    react: async (emoji) => { added.push(emoji); },
    edit: async (payload) => { edits.push(payload); },
  };
}

function fakeChannel(id, { perms = FULL, messages = [] } = {}) {
  const store = new Map(messages.map((m) => [m.id, m]));
  const sent = [];
  const channel = {
    id, sent, store,
    permissionsFor: () => has(perms),
    send: async (payload) => {
      const m = fakeDiscordMessage(`posted${sent.length + 1}`);
      m.payload = payload;
      sent.push(m);
      store.set(m.id, m);
      return m;
    },
    messages: { fetch: async (mid) => { if (!store.has(mid)) throw new Error('unknown'); return store.get(mid); } },
  };
  return channel;
}

function setup({ botPerms = FULL, channels = [fakeChannel('c1')], roles = [], botTop = 10, callerTop = 8 } = {}) {
  const chans = new Map(channels.map((c) => [c.id, c]));
  const guild = {
    id: G, ownerId: 'owner', name: 'Guild', memberCount: 5, createdTimestamp: 1700000000000, iconURL: () => null,
    members: { me: { id: BOT, permissions: has(botPerms), roles: { highest: { position: botTop } } } },
    channels: { fetch: async (id) => chans.get(id) ?? null },
    roles: { cache: new Map(roles.map((r) => [r.id, r])) },
    emojis: { cache: new Map([['111111111111111111', { id: '111111111111111111', available: true }]]) },
  };
  const logged = [];
  const logChannel = { isTextBased: () => true, send: async (payload) => { logged.push(payload); return { id: 'log1', channelId: 'logch' }; } };
  const ctx = { db, client: { user: { id: BOT }, channels: { fetch: async () => logChannel } } };
  const member = { id: 'staff', permissions: { has: () => true }, roles: { highest: { position: callerTop }, cache: new Map() }, guild };
  return { guild, ctx, member, chans, logged };
}

function fakeInteraction(env, sub, opts = {}, channelId = 'c1') {
  const replies = [];
  const interaction = {
    guildId: G, guild: env.guild, member: env.member, user: { id: 'staff', username: 'staff', displayAvatarURL: () => '' },
    channel: env.chans.get(channelId), replies,
    inGuild: () => true,
    options: {
      getSubcommand: () => sub,
      getString: (n) => opts[n] ?? null,
      getRole: (n) => opts[n] ?? null,
      getChannel: (n) => opts[n] ?? null,
    },
    reply: async (p) => { replies.push(typeof p === 'string' ? p : p.content); },
    deferReply: async () => {},
    editReply: async (p) => { replies.push(typeof p === 'string' ? p : p.content); },
  };
  return interaction;
}

const run = (env, sub, opts, channelId) => {
  const interaction = fakeInteraction(env, sub, opts, channelId);
  return command.execute(interaction, env.ctx).then(() => interaction);
};
const last = (i) => i.replies.at(-1);

async function enable() {
  await setFeature(db, G, 'reactionroles', { enabled: true });
}
async function enableLogging() {
  await setFeature(db, G, 'logging', { enabled: true, config: { channels: { default: 'logch' } } });
}

// ---- structure ----

test('the module exposes one reactionroles command', () => {
  assert.equal(commands.length, 1);
  const json = commands[0].data.toJSON();
  assert.equal(json.name, 'reactionroles');
  assert.deepEqual(json.options.map((o) => o.name), ['enable', 'disable', 'status', 'create', 'adopt', 'add', 'remove', 'show']);
});

test('required options come before optional ones and descriptions fit', () => {
  const json = command.data.toJSON();
  for (const sub of json.options) {
    assert.ok(sub.description.length >= 1 && sub.description.length <= 100);
    let optional = false;
    for (const o of sub.options ?? []) {
      assert.ok(!(optional && o.required), `${sub.name} ${o.name}`);
      if (!o.required) optional = true;
      assert.ok(o.description.length >= 1 && o.description.length <= 100);
    }
  }
});

// ---- checkRoleForSetup ----

test('checkRoleForSetup returns each of the four results', () => {
  const guild = setup().guild;
  const caller = { id: 'u', roles: { highest: { position: 8 } } };
  assert.equal(checkRoleForSetup(guild, caller, role('r1', 3)), 'ok');
  assert.equal(checkRoleForSetup(guild, caller, role('r1', 3, { permissions: { has: (p) => p === 'BanMembers' } })), 'dangerous');
  assert.equal(checkRoleForSetup(guild, caller, role('r1', 10)), 'bot_cannot');
  assert.equal(checkRoleForSetup({ ...guild, members: { me: { roles: { highest: { position: 20 } } } } }, caller, role('r1', 9)), 'caller_cannot');
  assert.equal(fromCommands, checkRoleForSetup);
});

// ---- toggle and guard ----

test('commands reply featureOff when disabled, except enable', async () => {
  const env = setup({ roles: [role('r1')] });
  for (const [sub, opts] of [['status', {}], ['show', {}], ['create', { embed: 'x', style: 'buttons' }], ['add', { message_id: 'm', role: role('r1') }]]) {
    const i = await run(env, sub, opts);
    assert.equal(last(i), t('en', 'common.featureOff', { command: '/reactionroles enable' }), sub);
  }
  const on = await run(env, 'enable');
  assert.equal(last(on), t('en', 'common.enabledMsg', { feature: t('en', 'feature.reactionroles') }));
});

// ---- create ----

test('create with an unknown embed name replies embed.missing', async () => {
  await enable();
  const env = setup();
  const i = await run(env, 'create', { embed: 'nope', style: 'buttons' });
  assert.equal(last(i), t('en', 'reactionroles.embed.missing'));
  assert.notEqual(last(i), 'reactionroles.embed.missing');
});

test('create with type reversed and style buttons is refused', async () => {
  await enable();
  const env = setup();
  const i = await run(env, 'create', { embed: 'x', style: 'buttons', type: 'reversed' });
  assert.equal(last(i), t('en', 'reactionroles.reversedNeedsReactions'));
  assert.notEqual(last(i), 'reactionroles.reversedNeedsReactions');
});

test('create posts the embed, stores the message with its embed name and logs once', async () => {
  await enable();
  await enableLogging();
  await createEmbed(db, G, 'roles');
  await saveEmbed(db, G, 'roles', { title: 'Pick your roles', description: 'Choose below' });
  const env = setup();
  const i = await run(env, 'create', { embed: 'roles', style: 'menu', type: 'unique' });
  const sent = env.chans.get('c1').sent;
  assert.equal(sent.length, 1);
  assert.equal(last(i), t('en', 'reactionroles.created', { id: 'posted1' }));
  const stored = await getMessage(db, 'posted1');
  assert.equal(stored.embedName, 'roles');
  assert.equal(stored.style, 'menu');
  assert.equal(stored.type, 'unique');
  assert.equal(stored.guildId, G);
  assert.equal(env.logged.length, 1);
  assert.equal(env.logged[0].embeds[0].title, t('en', 'reactionroles.log.title', { action: 'create' }));
});

test('create names the missing permission and posts nothing', async () => {
  await enable();
  await createEmbed(db, G, 'roles');
  await saveEmbed(db, G, 'roles', { title: 'Pick', description: 'Choose below' });
  const channel = fakeChannel('c1', { perms: P.ManageRoles });
  const env = setup({ channels: [channel] });
  const i = await run(env, 'create', { embed: 'roles', style: 'reactions' });
  assert.equal(last(i), t('en', 'reactionroles.needPermission', { permission: 'Add Reactions' }));
  assert.match(last(i), /Add Reactions/);
  assert.equal(channel.sent.length, 0);
  assert.equal(await getMessage(db, 'posted1'), null);
});

test('create needs Manage Roles for every style and Manage Messages for a drop reaction message', async () => {
  await enable();
  await createEmbed(db, G, 'roles');
  await saveEmbed(db, G, 'roles', { title: 'Pick', description: 'Choose below' });
  const noRoles = setup({ channels: [fakeChannel('c1', { perms: P.AddReactions | P.ReadMessageHistory })] });
  assert.match(last(await run(noRoles, 'create', { embed: 'roles', style: 'buttons' })), /Manage Roles/);
  const noManage = setup({ channels: [fakeChannel('c1', { perms: P.ManageRoles | P.AddReactions | P.ReadMessageHistory })] });
  assert.match(last(await run(noManage, 'create', { embed: 'roles', style: 'reactions', type: 'drop' })), /Manage Messages/);
  const fine = setup({ channels: [fakeChannel('c1', { perms: P.ManageRoles | P.AddReactions | P.ReadMessageHistory })] });
  assert.equal(last(await run(fine, 'create', { embed: 'roles', style: 'reactions' })), t('en', 'reactionroles.created', { id: 'posted1' }));
});

// ---- adopt ----

test('adopt refuses a message authored by someone else, without an embed, or with components', async () => {
  await enable();
  const channel = fakeChannel('c1', {
    messages: [
      fakeDiscordMessage('other', { author: 'someone' }),
      fakeDiscordMessage('plain', { embeds: [] }),
      fakeDiscordMessage('busy', { components: [{}] }),
    ],
  });
  const env = setup({ channels: [channel] });
  assert.equal(last(await run(env, 'adopt', { message_id: 'other', style: 'buttons' })), t('en', 'reactionroles.adopt.notOurs'));
  assert.equal(last(await run(env, 'adopt', { message_id: 'plain', style: 'buttons' })), t('en', 'reactionroles.adopt.noEmbed'));
  assert.equal(last(await run(env, 'adopt', { message_id: 'busy', style: 'buttons' })), t('en', 'reactionroles.adopt.hasComponents'));
  assert.equal(last(await run(env, 'adopt', { message_id: 'ghost', style: 'buttons' })), t('en', 'reactionroles.gone'));
  assert.equal(await getMessage(db, 'other'), null);
  assert.equal(await getMessage(db, 'plain'), null);
  assert.equal(await getMessage(db, 'busy'), null);
});

test('adopt stores the message without an embed name, syncs it and logs once', async () => {
  await enable();
  await enableLogging();
  const mine = fakeDiscordMessage('mine');
  const env = setup({ channels: [fakeChannel('c1', { messages: [mine] })] });
  const i = await run(env, 'adopt', { message_id: 'mine', style: 'buttons' });
  assert.equal(last(i), t('en', 'reactionroles.adopted', { id: 'mine' }));
  const stored = await getMessage(db, 'mine');
  assert.equal(stored.embedName, null);
  assert.equal(stored.style, 'buttons');
  assert.equal(mine.edits.length, 1, 'syncMessage ran');
  assert.equal(env.logged.length, 1);
  assert.equal(last(await run(env, 'adopt', { message_id: 'mine', style: 'buttons' })), t('en', 'reactionroles.adopt.already'));
});

test('adopt names the missing permission', async () => {
  await enable();
  const env = setup({ channels: [fakeChannel('c1', { perms: P.ManageRoles, messages: [fakeDiscordMessage('mine')] })] });
  const i = await run(env, 'adopt', { message_id: 'mine', style: 'reactions' });
  assert.equal(last(i), t('en', 'reactionroles.needPermission', { permission: 'Add Reactions' }));
  assert.equal(await getMessage(db, 'mine'), null);
});

// ---- add ----

async function stored(style = 'reactions', id = 'm1') {
  await createMessage(db, { guildId: G, messageId: id, channelId: 'c1', style, createdBy: 'u1' });
}

test('add on a reactions message without an emoji replies emoji_required', async () => {
  await enable();
  await stored('reactions');
  const env = setup({ roles: [role('r1', 3)] });
  const i = await run(env, 'add', { message_id: 'm1', role: role('r1', 3) });
  assert.equal(last(i), t('en', 'reactionroles.add.emoji_required'));
  assert.notEqual(last(i), 'reactionroles.add.emoji_required');
  assert.equal((await getMessage(db, 'm1')).entries.length, 0);
});

test('add of a dangerous role is refused and nothing is stored', async () => {
  await enable();
  await stored('buttons');
  const danger = role('r1', 3, { permissions: { has: (p) => p === 'Administrator' } });
  const env = setup({ roles: [danger] });
  const i = await run(env, 'add', { message_id: 'm1', role: danger, label: 'Admin' });
  assert.equal(last(i), t('en', 'reactionroles.add.role.dangerous'));
  assert.equal((await getMessage(db, 'm1')).entries.length, 0);
});

test('add refuses a role the bot or the caller cannot give', async () => {
  await enable();
  await stored('buttons');
  const high = role('r1', 9);
  const env = setup({ roles: [high], botTop: 9 });
  assert.equal(last(await run(env, 'add', { message_id: 'm1', role: high, label: 'x' })), t('en', 'reactionroles.add.role.bot_cannot'));
  const env2 = setup({ roles: [high], botTop: 20, callerTop: 5 });
  assert.equal(last(await run(env2, 'add', { message_id: 'm1', role: high, label: 'x' })), t('en', 'reactionroles.add.role.caller_cannot'));
});

test('add rejects an invalid emoji and a custom emoji from another server', async () => {
  await enable();
  await stored('reactions');
  const r = role('r1', 3);
  const env = setup({ roles: [r] });
  assert.equal(last(await run(env, 'add', { message_id: 'm1', role: r, emoji: 'nope' })), t('en', 'reactionroles.add.emoji.invalid'));
  assert.equal(last(await run(env, 'add', { message_id: 'm1', role: r, emoji: '<:xxx:222222222222222222>' })), t('en', 'reactionroles.add.emoji.foreign'));
});

test('add stores the entry, reacts on the message and logs once', async () => {
  await enable();
  await enableLogging();
  await stored('reactions');
  const r = role('r1', 3);
  const msg = fakeDiscordMessage('m1');
  const env = setup({ roles: [r], channels: [fakeChannel('c1', { messages: [msg] })] });
  const i = await run(env, 'add', { message_id: 'm1', role: r, emoji: '😀' });
  assert.equal(last(i), t('en', 'reactionroles.added'));
  assert.deepEqual((await getMessage(db, 'm1')).entries.map((e) => [e.roleId, e.emoji]), [['r1', '😀']]);
  assert.deepEqual(msg.added, ['😀']);
  assert.equal(env.logged.length, 1);
  assert.deepEqual(env.logged[0].embeds[0].fields.at(-1).value, '<@&r1>');
});

test('add the 21st entry replies full', async () => {
  await enable();
  await stored('buttons');
  for (let i = 0; i < 20; i += 1) await addEntry(db, 'm1', { roleId: `x${i}`, label: `L${i}` });
  const r = role('r1', 3);
  const env = setup({ roles: [r] });
  const i = await run(env, 'add', { message_id: 'm1', role: r, label: 'One more' });
  assert.equal(last(i), t('en', 'reactionroles.add.full'));
  assert.notEqual(last(i), 'reactionroles.add.full');
});

test('add names the missing permission and stores nothing', async () => {
  await enable();
  await stored('buttons');
  const r = role('r1', 3);
  const env = setup({ roles: [r], channels: [fakeChannel('c1', { perms: 0n })] });
  const i = await run(env, 'add', { message_id: 'm1', role: r, label: 'x' });
  assert.equal(last(i), t('en', 'reactionroles.needPermission', { permission: 'Manage Roles' }));
  assert.equal((await getMessage(db, 'm1')).entries.length, 0);
});

test('add and show reply gone for an unknown message and for another guild', async () => {
  await enable();
  await createMessage(db, { guildId: 'other-guild', messageId: 'foreign', channelId: 'c1', style: 'buttons', createdBy: 'u' });
  const r = role('r1', 3);
  const env = setup({ roles: [r] });
  assert.equal(last(await run(env, 'add', { message_id: 'nope', role: r, label: 'x' })), t('en', 'reactionroles.gone'));
  assert.equal(last(await run(env, 'add', { message_id: 'foreign', role: r, label: 'x' })), t('en', 'reactionroles.gone'));
  assert.equal(last(await run(env, 'show', { message_id: 'foreign' })), t('en', 'reactionroles.gone'));
  assert.equal((await getMessage(db, 'foreign')).entries.length, 0);
});

test('loadMessage is the shared guard: returns the message for this guild, null otherwise', async () => {
  await stored('buttons');
  const env = setup();
  const own = fakeInteraction(env, 'show', { message_id: 'm1' });
  assert.equal((await loadMessage(own, env.ctx, 'en')).messageId, 'm1');
  assert.deepEqual(own.replies, []);
  const missing = fakeInteraction(env, 'show', { message_id: 'zz' });
  assert.equal(await loadMessage(missing, env.ctx, 'en'), null);
  assert.deepEqual(missing.replies, [t('en', 'reactionroles.gone')]);
});

// ---- remove ----

test('remove deletes the entry, re-syncs the message and logs once', async () => {
  await enable();
  await enableLogging();
  await stored('buttons');
  await addEntry(db, 'm1', { roleId: 'r1', label: 'One' });
  const msg = fakeDiscordMessage('m1');
  const env = setup({ channels: [fakeChannel('c1', { messages: [msg] })] });
  const i = await run(env, 'remove', { message_id: 'm1', role: role('r1') });
  assert.equal(last(i), t('en', 'reactionroles.removed'));
  assert.equal((await getMessage(db, 'm1')).entries.length, 0);
  assert.equal(msg.edits.length, 1);
  assert.equal(env.logged.length, 1);
  const again = await run(env, 'remove', { message_id: 'm1', role: role('r1') });
  assert.equal(last(again), t('en', 'reactionroles.noSuchEntry'));
  assert.equal(env.logged.length, 1);
});

// ---- show ----

test('show lists the messages, or one message with its entries and rules', async () => {
  await enable();
  const env = setup();
  assert.equal(last(await run(env, 'show', {})), t('en', 'reactionroles.show.none'));
  await stored('buttons');
  await addEntry(db, 'm1', { roleId: 'r1', label: 'One' });
  const all = last(await run(env, 'show', {}));
  assert.equal(all, t('en', 'reactionroles.show.line', { id: 'm1', channel: '<#c1>', style: 'buttons', type: 'normal', count: 1 }));
  const one = last(await run(env, 'show', { message_id: 'm1' }));
  assert.ok(one.includes('One <@&r1>'));
});

test('show includes limit and role lists when they are set', async () => {
  await enable();
  await stored('buttons');
  await db.query(`UPDATE reaction_role_messages SET "limit" = 2, whitelist = '["w1"]', blacklist = '["b1"]' WHERE message_id = 'm1'`);
  const env = setup();
  const text = last(await run(env, 'show', { message_id: 'm1' }));
  assert.ok(text.includes(t('en', 'reactionroles.show.limit', { limit: 2 })));
  assert.ok(text.includes(t('en', 'reactionroles.show.whitelist', { roles: '<@&w1>' })));
  assert.ok(text.includes(t('en', 'reactionroles.show.blacklist', { roles: '<@&b1>' })));
});

// ---- status ----

test('status lists a message whose Discord message no longer exists', async () => {
  await enable();
  await stored('buttons', 'gone1');
  const env = setup();
  const text = last(await run(env, 'status'));
  assert.ok(text.includes(t('en', 'reactionroles.status.head', { count: 1 })));
  assert.ok(text.includes(t('en', 'reactionroles.status.deleted', { id: 'gone1' })));
});

test('status flags an empty message, an ungivable role and missing reactions', async () => {
  await enable();
  await stored('buttons', 'empty1');
  await stored('reactions', 'react1');
  await addEntry(db, 'react1', { roleId: 'gone-role', emoji: '😀' });
  const env = setup({ channels: [fakeChannel('c1', { messages: [fakeDiscordMessage('empty1'), fakeDiscordMessage('react1')] })] });
  const text = last(await run(env, 'status'));
  assert.ok(text.includes(t('en', 'reactionroles.status.empty', { id: 'empty1' })));
  assert.ok(text.includes(t('en', 'reactionroles.status.role', { id: 'react1', role: '<@&gone-role>' })));
  assert.ok(text.includes(t('en', 'reactionroles.status.reactions', { id: 'react1' })));
});

// ---- autocomplete ----

test('autocomplete offers embed names to managers only', async () => {
  await createEmbed(db, G, 'welcome');
  await createEmbed(db, G, 'rules');
  const env = setup();
  const responses = [];
  const base = { guildId: G, member: env.member, options: { getFocused: () => 'wel' }, respond: async (r) => { responses.push(r); } };
  await command.autocomplete(base, env.ctx);
  assert.deepEqual(responses[0], [{ name: 'welcome', value: 'welcome' }]);
  await command.autocomplete({ ...base, member: { ...env.member, permissions: { has: () => false }, roles: { cache: new Map() } } }, env.ctx);
  assert.deepEqual(responses[1], []);
});

// ---- logReactionRoles ----

test('logReactionRoles sends one modAction embed and never throws', async () => {
  const calls = [];
  await logReactionRoles({}, { id: G }, 'en', { action: 'add', actorId: 'u1', messageId: 'm1', detail: '<@&r1>' }, { sendLog: async (...a) => { calls.push(a); } });
  assert.equal(calls.length, 1);
  const [, guildId, event, embed] = calls[0];
  assert.equal(guildId, G);
  assert.equal(event, 'modAction');
  assert.equal(embed.title, t('en', 'reactionroles.log.title', { action: 'add' }));
  assert.equal(embed.fields[0].value, '<@u1>');
  assert.equal(embed.fields[1].value, 'm1');
  assert.equal(embed.fields[2].value, '<@&r1>');
  const warn = console.warn;
  console.warn = () => {};
  try {
    await assert.doesNotReject(logReactionRoles({}, { id: G }, 'fr', { action: 'x', actorId: 'u', messageId: 'm' }, { sendLog: async () => { throw new Error('nope'); } }));
  } finally {
    console.warn = warn;
  }
});

// ---- fix round 1 ----

test('create needs Manage Messages for a reactions binding message', async () => {
  await enable();
  await createEmbed(db, G, 'roles');
  await saveEmbed(db, G, 'roles', { title: 'Pick', description: 'Choose below' });
  const env = setup({ channels: [fakeChannel('c1', { perms: P.ManageRoles | P.AddReactions | P.ReadMessageHistory })] });
  const i = await run(env, 'create', { embed: 'roles', style: 'reactions', type: 'binding' });
  assert.equal(last(i), t('en', 'reactionroles.needPermission', { permission: 'Manage Messages' }));
  assert.equal(env.chans.get('c1').sent.length, 0);
});

async function storeMany(n) {
  for (let i = 0; i < n; i += 1) {
    await createMessage(db, { guildId: G, messageId: `${'9'.repeat(18)}${i}`, channelId: 'c1', style: 'buttons', createdBy: 'u' });
  }
}

test('show with 60 stored messages fits in 2000 characters and ends with the more line', async () => {
  await enable();
  await storeMany(60);
  const env = setup();
  const text = last(await run(env, 'show', {}));
  assert.ok(text.length <= 2000, `length ${text.length}`);
  const shown = text.split('\n').length - 1;
  assert.ok(shown > 0 && shown < 60);
  assert.equal(text.split('\n').at(-1), t('en', 'reactionroles.more', { count: 60 - shown }));
  assert.notEqual(t('en', 'reactionroles.more', { count: 1 }), 'reactionroles.more');
});

test('status defers before fetching and its final text fits in 2000 characters', async () => {
  await enable();
  await storeMany(60);
  const env = setup();
  const events = [];
  const channel = env.chans.get('c1');
  const originalFetch = env.guild.channels.fetch;
  env.guild.channels.fetch = async (id) => { events.push('fetch'); return originalFetch(id); };
  const interaction = fakeInteraction(env, 'status');
  interaction.deferReply = async () => { events.push('defer'); };
  interaction.reply = async () => { events.push('reply'); };
  interaction.editReply = async (p) => { events.push('edit'); interaction.final = typeof p === 'string' ? p : p.content; };
  await command.execute(interaction, env.ctx);
  assert.equal(events[0], 'defer');
  assert.ok(!events.includes('reply'));
  assert.equal(events.at(-1), 'edit');
  assert.ok(channel && interaction.final.length <= 2000, `length ${interaction.final.length}`);
  assert.ok(interaction.final.includes(t('en', 'reactionroles.status.head', { count: 60 })));
  assert.match(interaction.final.split('\n').at(-1), /^\D*\d+/);
});

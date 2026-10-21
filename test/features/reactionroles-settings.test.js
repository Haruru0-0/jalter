import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { testDb } from '../helpers/db.js';
import { resetDb } from '../../src/db/index.js';
import { setFeature } from '../../src/db/settings.js';
import { t } from '../../src/i18n/index.js';
import { createEmbed, saveEmbed } from '../../src/features/embeds/store.js';
import { createMessage, getMessage, addEntry } from '../../src/features/reactionroles/store.js';
import { createReactionRolesCommand } from '../../src/features/reactionroles/commands.js';
import { handlePurge, destructJob } from '../../src/features/reactionroles/commands-settings.js';
import { jobs } from '../../src/features/reactionroles/index.js';
import { SELFDESTRUCT_JOB } from '../../src/features/reactionroles/config.js';

let db;
before(async () => { db = await testDb(); });
beforeEach(async () => { await resetDb(db); });
after(async () => { await db.end(); });

const G = 'g1';
const BOT = 'bot1';
const command = createReactionRolesCommand();

function fakeDiscordMessage(id, { reactions = [] } = {}) {
  const edits = [];
  const removed = [];
  return {
    id, edits, removed, deleted: false,
    reactions: {
      cache: new Map(reactions.map((k) => [k, { me: true, emoji: { id: null, name: k }, users: { remove: async (u) => { removed.push(k + u); } } }])),
    },
    react: async () => {},
    edit: async (payload) => { edits.push(payload); },
    delete: async function del() { this.deleted = true; },
  };
}

function setup({ messages = [fakeDiscordMessage('m1')], allowed = true } = {}) {
  const store = new Map(messages.map((m) => [m.id, m]));
  const channel = { id: 'c1', messages: { fetch: async (id) => { if (!store.has(id)) throw new Error('unknown'); return store.get(id); } } };
  const guild = {
    id: G, name: 'Guild', memberCount: 5, createdTimestamp: 1700000000000, iconURL: () => null,
    members: { me: { id: BOT } },
    channels: { fetch: async (id) => (id === 'c1' ? channel : null) },
    roles: { cache: new Map() },
  };
  const logged = [];
  const logChannel = { isTextBased: () => true, send: async (payload) => { logged.push(payload); return { id: 'log1', channelId: 'logch' }; } };
  const ctx = { db, client: { user: { id: BOT }, channels: { fetch: async (id) => (id === 'c1' ? channel : logChannel) } } };
  const member = { id: 'staff', permissions: { has: () => allowed }, roles: { cache: new Map() }, guild };
  return { guild, ctx, member, store, logged };
}

function fakeInteraction(env, sub, opts = {}) {
  const replies = [];
  return {
    guildId: G, guild: env.guild, member: env.member, user: { id: 'staff', username: 'staff', displayAvatarURL: () => '' }, replies,
    inGuild: () => true,
    options: {
      getSubcommand: () => sub,
      getString: (n) => opts[n] ?? null,
      getInteger: (n) => opts[n] ?? null,
      getRole: (n) => opts[n] ?? null,
    },
    reply: async (p) => { replies.push(p); },
  };
}

const text = (p) => (typeof p === 'string' ? p : p.content);
const run = async (env, sub, opts) => {
  const interaction = fakeInteraction(env, sub, opts);
  await command.execute(interaction, env.ctx);
  return interaction;
};
const last = (i) => text(i.replies.at(-1));

async function enable() {
  await setFeature(db, G, 'reactionroles', { enabled: true });
}
async function enableLogging() {
  await setFeature(db, G, 'logging', { enabled: true, config: { channels: { default: 'logch' } } });
}
const seed = (extra = {}) => createMessage(db, { guildId: G, messageId: 'm1', channelId: 'c1', embedName: null, style: 'buttons', createdBy: 'u', ...extra });
const jobsOf = async (type = SELFDESTRUCT_JOB) => (await db.query('SELECT key FROM scheduled_jobs WHERE type = $1 ORDER BY key', [type])).rows.map((r) => r.key);

// ---- structure ----

test('the settings subcommands are registered and respect Discord option rules', () => {
  const json = command.data.toJSON();
  const names = json.options.map((o) => o.name);
  for (const n of ['type', 'limit', 'whitelist', 'blacklist', 'selfdestruct', 'refresh', 'fix', 'purge']) assert.ok(names.includes(n), n);
  for (const sub of json.options) {
    assert.ok(sub.description.length >= 1 && sub.description.length <= 100);
    let optional = false;
    for (const o of sub.options ?? []) {
      assert.ok(!(optional && o.required), `${sub.name} ${o.name}`);
      if (!o.required) optional = true;
    }
  }
  assert.equal(typeof jobs[SELFDESTRUCT_JOB], 'function');
});

// ---- type ----

test('type reversed on a buttons message is refused and nothing changes', async () => {
  await enable();
  await seed();
  const env = setup();
  const i = await run(env, 'type', { message_id: 'm1', type: 'reversed' });
  assert.equal(last(i), t('en', 'reactionroles.reversedNeedsReactions'));
  assert.equal((await getMessage(db, 'm1')).type, 'normal');
});

test('type changes the stored type, syncs the message and logs, without touching roles', async () => {
  await enable();
  await enableLogging();
  await seed({ style: 'menu' });
  await addEntry(db, 'm1', { roleId: 'r1', label: 'A' });
  const env = setup();
  const i = await run(env, 'type', { message_id: 'm1', type: 'unique' });
  assert.equal(last(i), t('en', 'common.saved'));
  assert.equal((await getMessage(db, 'm1')).type, 'unique');
  assert.equal(env.store.get('m1').edits.length, 1);
  assert.equal(env.logged.length, 1);
});

test('settings refuse a message of another server', async () => {
  await enable();
  await seed({ guildId: 'other' });
  const i = await run(setup(), 'limit', { message_id: 'm1', number: 3 });
  assert.equal(last(i), t('en', 'reactionroles.gone'));
  assert.equal((await getMessage(db, 'm1')).limit, null);
});

// ---- limit ----

test('limit stores the number, and 0 stores none', async () => {
  await enable();
  await seed();
  const env = setup();
  await run(env, 'limit', { message_id: 'm1', number: 2 });
  assert.equal((await getMessage(db, 'm1')).limit, 2);
  await run(env, 'limit', { message_id: 'm1', number: 0 });
  assert.equal((await getMessage(db, 'm1')).limit, null);
});

// ---- whitelist / blacklist ----

test('whitelist and blacklist add, remove and clear persist', async () => {
  await enable();
  await seed();
  const env = setup();
  await run(env, 'whitelist', { message_id: 'm1', mode: 'add', role: { id: 'a' } });
  await run(env, 'whitelist', { message_id: 'm1', mode: 'add', role: { id: 'b' } });
  await run(env, 'whitelist', { message_id: 'm1', mode: 'add', role: { id: 'a' } });
  await run(env, 'blacklist', { message_id: 'm1', mode: 'add', role: { id: 'x' } });
  let m = await getMessage(db, 'm1');
  assert.deepEqual(m.whitelist, ['a', 'b']);
  assert.deepEqual(m.blacklist, ['x']);
  await run(env, 'whitelist', { message_id: 'm1', mode: 'remove', role: { id: 'a' } });
  assert.deepEqual((await getMessage(db, 'm1')).whitelist, ['b']);
  await run(env, 'whitelist', { message_id: 'm1', mode: 'clear' });
  m = await getMessage(db, 'm1');
  assert.deepEqual(m.whitelist, []);
  assert.deepEqual(m.blacklist, ['x']);
});

test('adding to a list without a role is refused and logs nothing', async () => {
  await enable();
  await enableLogging();
  await seed();
  const env = setup();
  const i = await run(env, 'blacklist', { message_id: 'm1', mode: 'add' });
  assert.equal(last(i), t('en', 'reactionroles.list.needRole'));
  assert.equal(env.logged.length, 0);
});

// ---- selfdestruct ----

test('selfdestruct schedules a job keyed by the message id, and 0 or off cancels it', async () => {
  await enable();
  await seed();
  const env = setup();
  const before = Date.now();
  const i = await run(env, 'selfdestruct', { message_id: 'm1', duration: '1h' });
  assert.equal(last(i), t('en', 'reactionroles.selfdestructSet', { time: '1h' }));
  assert.deepEqual(await jobsOf(), ['m1']);
  const at = (await getMessage(db, 'm1')).selfdestructAt.getTime();
  assert.ok(at >= before + 3600_000 && at <= Date.now() + 3600_000);
  for (const off of ['0', 'OFF']) {
    await run(env, 'selfdestruct', { message_id: 'm1', duration: '1h' });
    const j = await run(env, 'selfdestruct', { message_id: 'm1', duration: off });
    assert.equal(last(j), t('en', 'common.saved'));
    assert.deepEqual(await jobsOf(), []);
    assert.equal((await getMessage(db, 'm1')).selfdestructAt, null);
  }
});

test('selfdestruct with an unreadable duration is refused', async () => {
  await enable();
  await seed();
  const i = await run(setup(), 'selfdestruct', { message_id: 'm1', duration: 'soon' });
  assert.equal(last(i), t('en', 'reactionroles.badDuration'));
  assert.deepEqual(await jobsOf(), []);
});

test('destructJob deletes the Discord message and the stored rows', async () => {
  await seed();
  await addEntry(db, 'm1', { roleId: 'r1', label: 'A' });
  const env = setup();
  await destructJob(env.ctx, { guildId: G, key: 'm1' });
  assert.equal(env.store.get('m1').deleted, true);
  assert.equal(await getMessage(db, 'm1'), null);
});

const discordError = (code) => Object.assign(new Error(`Discord error ${code}`), { code });
const seedWithEntry = async () => {
  await seed();
  await addEntry(db, 'm1', { roleId: 'r1', label: 'A' });
};

test('destructJob counts an already deleted Discord message as done', async () => {
  await seed();
  const env = setup();
  env.store.get('m1').delete = async () => { throw discordError(10008); };
  await destructJob(env.ctx, { guildId: G, key: 'm1' });
  assert.equal(await getMessage(db, 'm1'), null);

  await seed();
  const gone = setup();
  gone.ctx.client.channels.fetch = async () => { throw discordError(10003); };
  await destructJob(gone.ctx, { guildId: G, key: 'm1' });
  assert.equal(await getMessage(db, 'm1'), null);

  await seed();
  const missing = setup();
  missing.ctx.client.channels.fetch = async () => ({ messages: { fetch: async () => { throw discordError(10008); } } });
  await destructJob(missing.ctx, { guildId: G, key: 'm1' });
  assert.equal(await getMessage(db, 'm1'), null);
});

test('destructJob rethrows a channel fetch failure and keeps the stored message', async () => {
  await seedWithEntry();
  const env = setup();
  env.ctx.client.channels.fetch = async () => { throw discordError(50013); };
  await assert.rejects(destructJob(env.ctx, { guildId: G, key: 'm1' }), { code: 50013 });
  assert.equal((await getMessage(db, 'm1')).entries.length, 1);
});

test('destructJob rethrows a generic message fetch failure and keeps the stored message', async () => {
  await seedWithEntry();
  const env = setup();
  env.ctx.client.channels.fetch = async () => ({ messages: { fetch: async () => { throw new Error('socket hang up'); } } });
  await assert.rejects(destructJob(env.ctx, { guildId: G, key: 'm1' }), /socket hang up/);
  assert.ok(await getMessage(db, 'm1'));
});

test('destructJob rethrows a failed delete and keeps the stored message', async () => {
  await seedWithEntry();
  const env = setup();
  env.store.get('m1').delete = async () => { throw discordError(50013); };
  await assert.rejects(destructJob(env.ctx, { guildId: G, key: 'm1' }), { code: 50013 });
  assert.ok(await getMessage(db, 'm1'));
});

test('destructJob run again after success resolves quietly', async () => {
  await seed();
  const env = setup();
  await destructJob(env.ctx, { guildId: G, key: 'm1' });
  await destructJob(env.ctx, { guildId: G, key: 'm1' });
  assert.equal(await getMessage(db, 'm1'), null);
});

// ---- refresh ----

test('refresh on an adopted message says it has no embed name', async () => {
  await enable();
  await seed();
  const i = await run(setup(), 'refresh', { message_id: 'm1' });
  assert.equal(last(i), t('en', 'reactionroles.noEmbedName'));
});

test('refresh re-renders a named embed, and reports a missing one', async () => {
  await enable();
  await enableLogging();
  await createEmbed(db, G, 'rules');
  await saveEmbed(db, G, 'rules', { title: 'Rules', description: 'Be kind' });
  await seed({ embedName: 'rules' });
  const env = setup();
  const i = await run(env, 'refresh', { message_id: 'm1' });
  assert.equal(last(i), t('en', 'common.saved'));
  assert.equal(env.store.get('m1').edits.length, 1);
  assert.equal(env.logged.length, 1);

  await db.query('DELETE FROM reaction_role_messages');
  await seed({ embedName: 'nope' });
  const env2 = setup();
  const j = await run(env2, 'refresh', { message_id: 'm1' });
  assert.equal(last(j), t('en', 'reactionroles.embed.missing'));
  assert.equal(env2.logged.length, 0);
});

// ---- fix ----

test('fix repairs one message or every message of the server', async () => {
  await enable();
  await seed();
  await createMessage(db, { guildId: G, messageId: 'm2', channelId: 'c1', style: 'buttons', createdBy: 'u' });
  await addEntry(db, 'm1', { roleId: 'r1', label: 'A' });
  const env = setup({ messages: [fakeDiscordMessage('m1'), fakeDiscordMessage('m2')] });
  const one = await run(env, 'fix', { message_id: 'm1' });
  assert.equal(last(one), t('en', 'reactionroles.fixed', { count: 1 }));
  assert.equal(env.store.get('m1').edits.length, 1);
  assert.equal(env.store.get('m2').edits.length, 0);
  const all = await run(env, 'fix', {});
  assert.equal(last(all), t('en', 'reactionroles.fixed', { count: 2 }));
});

// ---- purge ----

function buttonPress(env, customId, userId = 'staff') {
  const updates = [];
  const replies = [];
  return {
    customId, guildId: G, guild: env.guild, member: env.member, user: { id: userId, username: userId }, updates, replies,
    update: async (p) => { updates.push(p); },
    reply: async (p) => { replies.push(p); },
  };
}

async function seedTwo() {
  await seed();
  await createMessage(db, { guildId: G, messageId: 'm2', channelId: 'c1', style: 'buttons', createdBy: 'u' });
  await addEntry(db, 'm1', { roleId: 'r1', label: 'A' });
  await addEntry(db, 'm2', { roleId: 'r2', label: 'B' });
}

test('purge only asks for confirmation and changes nothing', async () => {
  await enable();
  await seedTwo();
  await scheduleOne();
  const env = setup();
  const one = await run(env, 'purge', { message_id: 'm1' });
  const row = one.replies[0].components[0].toJSON().components;
  assert.deepEqual(row.map((b) => b.custom_id), ['reactionroles:purge:ok:staff:m1', 'reactionroles:purge:no:staff']);
  const all = await run(env, 'purge', {});
  assert.deepEqual(all.replies[0].components[0].toJSON().components[0].custom_id, 'reactionroles:purge:ok:staff:all');
  assert.equal(all.replies[0].content, t('en', 'reactionroles.purge.askAll', { count: 2 }));
  assert.equal((await getMessage(db, 'm1')).entries.length, 1);
  assert.deepEqual(await jobsOf(), ['m2']);
});

async function scheduleOne() {
  await db.query(
    "INSERT INTO scheduled_jobs (guild_id, type, key, payload, due_at) VALUES ($1, $2, 'm2', '{}', now() + interval '1 hour')", [G, SELFDESTRUCT_JOB]);
}

test('purge with nothing stored says there are no role messages', async () => {
  await enable();
  const i = await run(setup(), 'purge', {});
  assert.equal(last(i), t('en', 'reactionroles.show.none'));
});

test('confirming purge of one message clears its roles, keeps the row and strips the controls', async () => {
  await seedTwo();
  await enableLogging();
  const env = setup({ messages: [fakeDiscordMessage('m1'), fakeDiscordMessage('m2')] });
  const press = buttonPress(env, 'reactionroles:purge:ok:staff:m1');
  await handlePurge(press, env.ctx);
  assert.equal(press.updates[0].content, t('en', 'reactionroles.purge.doneOne', { count: 1 }));
  assert.deepEqual(press.updates[0].components, []);
  assert.equal((await getMessage(db, 'm1')).entries.length, 0);
  assert.equal((await getMessage(db, 'm2')).entries.length, 1);
  assert.deepEqual(env.store.get('m1').edits, [{ components: [] }]);
  assert.equal(env.store.get('m1').deleted, false);
  assert.equal(env.logged.length, 1);
});

test('confirming purge of all forgets every stored message and cancels the selfdestruct jobs', async () => {
  await seedTwo();
  await scheduleOne();
  await createMessage(db, { guildId: 'other', messageId: 'o1', channelId: 'c1', style: 'buttons', createdBy: 'u' });
  await db.query("INSERT INTO scheduled_jobs (guild_id, type, key, payload, due_at) VALUES ('other', $1, 'o1', '{}', now())", [SELFDESTRUCT_JOB]);
  const env = setup();
  const press = buttonPress(env, 'reactionroles:purge:ok:staff:all');
  await handlePurge(press, env.ctx);
  assert.equal(press.updates[0].content, t('en', 'reactionroles.purge.done', { count: 2 }));
  assert.equal(await getMessage(db, 'm1'), null);
  assert.equal(await getMessage(db, 'm2'), null);
  assert.ok(await getMessage(db, 'o1'));
  assert.deepEqual(await jobsOf(), ['o1']);
  for (const m of env.store.values()) assert.equal(m.deleted, false);
});

test('cancelling purge changes nothing', async () => {
  await seedTwo();
  const env = setup();
  const press = buttonPress(env, 'reactionroles:purge:no:staff');
  await handlePurge(press, env.ctx);
  assert.equal(press.updates[0].content, t('en', 'reactionroles.purge.cancelled'));
  assert.equal((await getMessage(db, 'm1')).entries.length, 1);
});

test('another user, or someone who can no longer manage, may not confirm purge', async () => {
  await seedTwo();
  const env = setup();
  const other = buttonPress(env, 'reactionroles:purge:ok:staff:all', 'intruder');
  await handlePurge(other, env.ctx);
  assert.equal(other.replies[0].content, t('en', 'reactionroles.notYours'));
  assert.equal(other.updates.length, 0);
  assert.ok(await getMessage(db, 'm1'));

  const demoted = setup({ allowed: false });
  const press = buttonPress(demoted, 'reactionroles:purge:ok:staff:all');
  await handlePurge(press, demoted.ctx);
  assert.equal(press.replies[0].content, t('en', 'reactionroles.notYours'));
  assert.ok(await getMessage(db, 'm1'));
});

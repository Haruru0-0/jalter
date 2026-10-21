import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { MessageFlags } from 'discord.js';
import { testDb } from '../helpers/db.js';
import { resetDb } from '../../src/db/index.js';
import { setFeature } from '../../src/db/settings.js';
import { t } from '../../src/i18n/index.js';
import { createMessage, getMessage, addEntry } from '../../src/features/reactionroles/store.js';
import { builderPayload, handleBuilder } from '../../src/features/reactionroles/builder.js';
import { createReactionRolesCommand } from '../../src/features/reactionroles/commands.js';
import { handle } from '../../src/features/reactionroles/components.js';

let db;
before(async () => { db = await testDb(); });
beforeEach(async () => { await resetDb(db); });
after(async () => { await db.end(); });

const G = '111111111111111111';
const MSG = '222222222222222222';
const USER = '333333333333333333';
const ROLE = '444444444444444444';
const ROLE2 = '555555555555555555';
const BOT = 'bot1';
const NOW = Math.floor(Date.now() / 1000);
const stamp = (secondsAgo = 0) => (NOW - secondsAgo).toString(36);

const role = (id, position = 1, extra = {}) => ({ id, name: `role-${id.slice(0, 3)}`, position, managed: false, permissions: { has: () => false }, ...extra });

function setup({ roles = [role(ROLE, 3), role(ROLE2, 3)] } = {}) {
  const guild = {
    id: G, ownerId: 'owner', name: 'Guild', memberCount: 5, createdTimestamp: 1700000000000, iconURL: () => null,
    members: { me: { id: BOT, permissions: { has: () => true }, roles: { highest: { position: 10 } } } },
    channels: { fetch: async () => null },
    roles: { cache: new Map(roles.map((r) => [r.id, r])) },
    emojis: { cache: new Map() },
  };
  const logged = [];
  const logChannel = { isTextBased: () => true, send: async (p) => { logged.push(p); return { id: 'l', channelId: 'logch' }; } };
  const ctx = { db, client: { user: { id: BOT }, channels: { fetch: async () => logChannel } } };
  const member = { id: USER, permissions: { has: () => true }, roles: { highest: { position: 8 }, cache: new Map() }, guild };
  return { guild, ctx, member, logged };
}

async function seed(style = 'buttons') {
  await setFeature(db, G, 'logging', { enabled: true, config: { channels: { default: 'logch' } } });
  await createMessage(db, { guildId: G, messageId: MSG, channelId: 'c1', style, createdBy: USER });
}

// A fake component/modal interaction that records which response method was used.
function fake(env, customId, extra = {}) {
  const calls = [];
  return {
    customId, guildId: G, guild: env.guild, member: env.member, user: { id: USER }, calls,
    values: extra.values,
    fields: { getTextInputValue: (k) => (extra.fields ?? {})[k] ?? '' },
    update: async (p) => { calls.push(['update', p]); },
    reply: async (p) => { calls.push(['reply', p]); },
    showModal: async (m) => { calls.push(['showModal', m]); },
  };
}
const panelId = (action, { user = USER, msg = MSG, at = stamp(), extra } = {}) =>
  ['reactionroles', 'b', action, user, msg, at, extra].filter((p) => p !== undefined).join(':');
const parts = (components) => components.flatMap((r) => r.toJSON().components);
const refusal = (key) => ['reply', { content: t('en', key), flags: MessageFlags.Ephemeral }];

// ---- builderPayload ----

test('builderPayload lists the entries and has the role picker, Remove, Add and Done', async () => {
  const env = setup();
  await seed();
  await addEntry(db, MSG, { roleId: ROLE, label: 'Gamers' });
  const message = await getMessage(db, MSG);
  const { content, components } = builderPayload('en', message, env.guild, { userId: USER, startedAt: stamp(), roleId: ROLE2 });
  assert.equal(content, `${t('en', 'reactionroles.builder.head', { id: MSG })}\nGamers <@&${ROLE}>`);
  const flat = parts(components);
  assert.deepEqual(flat.map((c) => c.custom_id.split(':')[2]), ['role', 'rm', 'add', 'done']);
  const add = flat.find((c) => c.custom_id.includes(':add:'));
  assert.equal(add.disabled, false);
  assert.ok(add.custom_id.endsWith(`:${ROLE2}`));
  const rm = flat.find((c) => c.custom_id.includes(':rm:'));
  assert.deepEqual(rm.options.map((o) => [o.label, o.value]), [['Gamers', ROLE]]);
});

test('builderPayload without entries or a picked role: empty text, no Remove, Add disabled', async () => {
  const env = setup();
  await seed();
  const message = await getMessage(db, MSG);
  const { content, components } = builderPayload('en', message, env.guild, { userId: USER, startedAt: stamp() });
  assert.ok(content.endsWith(t('en', 'reactionroles.builder.empty')));
  const flat = parts(components);
  assert.deepEqual(flat.map((c) => c.custom_id.split(':')[2]), ['role', 'add', 'done']);
  assert.equal(flat[1].disabled, true);
});

test('builderPayload stays inside Discord limits with 20 long entries', async () => {
  const env = setup();
  await seed();
  for (let n = 0; n < 20; n += 1) {
    const id = `6000000000000000${String(10 + n)}`;
    env.guild.roles.cache.set(id, role(id, 3));
    await addEntry(db, MSG, { roleId: id, label: 'x'.repeat(80) });
  }
  const message = await getMessage(db, MSG);
  for (const lang of ['en', 'fr', 'ar']) {
    const { content, components } = builderPayload(lang, message, env.guild, { userId: USER, startedAt: stamp(), roleId: ROLE });
    assert.ok(content.length <= 2000, `${lang} ${content.length}`);
    const shown = content.split('\n').length - 2;
    assert.ok(shown > 0 && shown < 20);
    assert.equal(content.split('\n').at(-1), t(lang, 'reactionroles.more', { count: 20 - shown }));
    const flat = parts(components);
    for (const c of flat) assert.ok(c.custom_id.length <= 100);
    const rm = flat.find((c) => c.custom_id.includes(':rm:'));
    assert.equal(rm.options.length, 20);
    assert.ok(rm.options.every((o) => o.label.length <= 100));
  }
});

test('the longest customId the panel produces (modal with roleId) fits in 100 characters', () => {
  const big = '9'.repeat(19);
  const at = Math.floor(Date.now() / 1000).toString(36);
  const env = setup();
  const { components } = builderPayload('en', { messageId: big, entries: [] }, env.guild, { userId: big, startedAt: at, roleId: big });
  const longest = Math.max(...parts(components).map((c) => c.custom_id.length));
  assert.ok(longest <= 100, String(longest));
  // The modal id swaps "add" for "modal" on the same parts.
  const modalId = parts(components).find((c) => c.custom_id.includes(':add:')).custom_id.replace(':add:', ':modal:');
  assert.ok(modalId.length <= 100, String(modalId.length));
});

// ---- handleBuilder ----

test('picking a role re-renders the panel with Add enabled for that role', async () => {
  const env = setup();
  await seed();
  const i = fake(env, panelId('role'), { values: [ROLE] });
  await handleBuilder(i, env.ctx);
  assert.equal(i.calls.length, 1);
  const [kind, payload] = i.calls[0];
  assert.equal(kind, 'update');
  const add = parts(payload.components).find((c) => c.custom_id.includes(':add:'));
  assert.equal(add.disabled, false);
  assert.ok(add.custom_id.endsWith(`:${ROLE}`));
});

test('Add opens a modal whose title and labels fit 45 characters in every language', async () => {
  const env = setup();
  await seed();
  for (const lang of ['en', 'fr', 'ar']) {
    await setFeature(db, G, 'language', { config: { lang } });
    const at = stamp();
    const i = fake(env, panelId('add', { at, extra: ROLE }));
    await handleBuilder(i, env.ctx);
    assert.equal(i.calls.length, 1);
    const [kind, m] = i.calls[0];
    assert.equal(kind, 'showModal');
    const json = m.toJSON();
    assert.equal(json.custom_id, panelId('modal', { at, extra: ROLE }));
    assert.equal(json.title, t(lang, 'reactionroles.builder.modalTitle'));
    assert.ok(json.title.length <= 45);
    const labels = json.components.map((r) => r.components[0].label);
    assert.deepEqual(labels, [t(lang, 'reactionroles.builder.emoji'), t(lang, 'reactionroles.builder.label')]);
    assert.ok(labels.every((l) => l.length <= 45));
  }
});

test('modal submit adds the entry, re-renders the panel and writes one log line', async () => {
  const env = setup();
  await seed();
  const i = fake(env, panelId('modal', { extra: ROLE }), { fields: { emoji: '', label: ' Gamers ' } });
  await handleBuilder(i, env.ctx);
  assert.equal(i.calls.length, 1);
  assert.equal(i.calls[0][0], 'update');
  assert.ok(i.calls[0][1].content.includes(`Gamers <@&${ROLE}>`));
  const stored = (await getMessage(db, MSG)).entries;
  assert.deepEqual(stored.map((e) => [e.roleId, e.emoji, e.label]), [[ROLE, null, 'Gamers']]);
  assert.equal(env.logged.length, 1);
});

test('a dangerous role is refused with the setup message, nothing stored or logged', async () => {
  const env = setup({ roles: [role(ROLE, 3, { permissions: { has: (p) => p === 'BanMembers' } })] });
  await seed();
  const i = fake(env, panelId('modal', { extra: ROLE }), { fields: { label: 'Gamers' } });
  await handleBuilder(i, env.ctx);
  assert.deepEqual(i.calls, [refusal('reactionroles.add.role.dangerous')]);
  assert.equal((await getMessage(db, MSG)).entries.length, 0);
  assert.equal(env.logged.length, 0);
});

test('a duplicate role and a bad emoji reuse the /reactionroles add refusals', async () => {
  const env = setup();
  await seed();
  await addEntry(db, MSG, { roleId: ROLE, label: 'A' });
  const dup = fake(env, panelId('modal', { extra: ROLE }), { fields: { label: 'B' } });
  await handleBuilder(dup, env.ctx);
  assert.deepEqual(dup.calls, [refusal('reactionroles.add.duplicate')]);
  const bad = fake(env, panelId('modal', { extra: ROLE2 }), { fields: { emoji: 'notanemoji', label: 'B' } });
  await handleBuilder(bad, env.ctx);
  assert.deepEqual(bad.calls, [refusal('reactionroles.add.emoji.invalid')]);
  assert.equal(env.logged.length, 0);
});

test('a role deleted since it was picked replies role_missing', async () => {
  const env = setup({ roles: [] });
  await seed();
  const i = fake(env, panelId('modal', { extra: ROLE }), { fields: { label: 'x' } });
  await handleBuilder(i, env.ctx);
  assert.deepEqual(i.calls, [refusal('reactionroles.refused.role_missing')]);
});

test('Remove deletes the entry, re-renders and writes one log line', async () => {
  const env = setup();
  await seed();
  await addEntry(db, MSG, { roleId: ROLE, label: 'A' });
  await addEntry(db, MSG, { roleId: ROLE2, label: 'B' });
  const i = fake(env, panelId('rm'), { values: [ROLE] });
  await handleBuilder(i, env.ctx);
  assert.equal(i.calls[0][0], 'update');
  assert.ok(!i.calls[0][1].content.includes(`<@&${ROLE}>`));
  assert.ok(i.calls[0][1].content.includes(`<@&${ROLE2}>`));
  assert.deepEqual((await getMessage(db, MSG)).entries.map((e) => e.roleId), [ROLE2]);
  assert.equal(env.logged.length, 1);
});

test('Remove of an entry that is already gone logs nothing but still re-renders', async () => {
  const env = setup();
  await seed();
  const i = fake(env, panelId('rm'), { values: [ROLE] });
  await handleBuilder(i, env.ctx);
  assert.equal(i.calls[0][0], 'update');
  assert.equal(env.logged.length, 0);
});

test('Done closes the panel', async () => {
  const env = setup();
  await seed();
  const i = fake(env, panelId('done'));
  await handleBuilder(i, env.ctx);
  assert.deepEqual(i.calls, [['update', { content: t('en', 'reactionroles.builder.finished'), components: [] }]]);
});

test('another member is refused ephemerally and nothing changes', async () => {
  const env = setup();
  await seed();
  await addEntry(db, MSG, { roleId: ROLE, label: 'A' });
  for (const [action, extra] of [['rm', { values: [ROLE] }], ['done', {}], ['role', { values: [ROLE2] }], ['add', {}]]) {
    const i = fake(env, panelId(action, { user: '999999999999999999' }), extra);
    await handleBuilder(i, env.ctx);
    assert.deepEqual(i.calls, [refusal('reactionroles.notYours')]);
  }
  assert.equal((await getMessage(db, MSG)).entries.length, 1);
});

test('a panel older than ten minutes (or with a bad timestamp) is expired', async () => {
  const env = setup();
  await seed();
  for (const at of [stamp(601), '!!']) {
    const i = fake(env, panelId('done', { at }));
    await handleBuilder(i, env.ctx);
    assert.deepEqual(i.calls, [refusal('reactionroles.expired')]);
  }
  const fresh = fake(env, panelId('done', { at: stamp(590) }));
  await handleBuilder(fresh, env.ctx);
  assert.equal(fresh.calls[0][0], 'update');
});

test('a deleted or foreign-guild message replies gone', async () => {
  const env = setup();
  const i = fake(env, panelId('done'));
  await handleBuilder(i, env.ctx);
  assert.deepEqual(i.calls, [refusal('reactionroles.gone')]);
  await createMessage(db, { guildId: 'other', messageId: MSG, channelId: 'c1', style: 'buttons', createdBy: USER });
  const j = fake(env, panelId('done'));
  await handleBuilder(j, env.ctx);
  assert.deepEqual(j.calls, [refusal('reactionroles.gone')]);
});

// ---- entry points ----

test('the builder subcommand opens the panel ephemerally, or replies gone', async () => {
  const env = setup();
  await seed();
  await setFeature(db, G, 'reactionroles', { enabled: true });
  const command = createReactionRolesCommand();
  assert.ok(command.data.toJSON().options.some((o) => o.name === 'builder'));
  const run = async (messageId) => {
    const calls = [];
    const interaction = {
      guildId: G, guild: env.guild, member: env.member, user: { id: USER }, inGuild: () => true,
      options: { getSubcommand: () => 'builder', getString: () => messageId },
      reply: async (p) => { calls.push(p); },
    };
    await command.execute(interaction, env.ctx);
    return calls;
  };
  const [opened] = await run(MSG);
  assert.equal(opened.flags, MessageFlags.Ephemeral);
  assert.ok(opened.content.includes(MSG));
  const done = parts(opened.components).find((c) => c.custom_id.includes(':done:'));
  assert.equal(done.custom_id.split(':')[3], USER);
  assert.equal(done.custom_id.split(':')[4], MSG);
  const [gone] = await run('nope');
  assert.deepEqual(gone, { content: t('en', 'reactionroles.gone'), flags: MessageFlags.Ephemeral });
});

test('components.js routes reactionroles:b:* to the builder', async () => {
  const env = setup();
  await seed();
  const i = fake(env, panelId('done'));
  await handle(i, env.ctx);
  assert.equal(i.calls[0][0], 'update');
});

// ---- the Discord message is synced ----

// Gives the guild a channel c1 holding one fake bot message that records edits and reaction changes.
function withDiscordMessage(env, reactionKeys = []) {
  const edits = [];
  const removed = [];
  const reacted = [];
  const discordMessage = {
    id: MSG, guild: env.guild, edits, removed, reacted,
    reactions: { cache: new Map(reactionKeys.map((k) => [k, { me: true, emoji: { id: null, name: k }, users: { remove: async (u) => { removed.push([k, u]); } } }])) },
    edit: async (p) => { edits.push(p); },
    react: async (e) => { reacted.push(e); },
  };
  env.guild.channels.fetch = async (cid) => (cid === 'c1' ? { messages: { fetch: async (mid) => (mid === MSG ? discordMessage : null) } } : null);
  return discordMessage;
}
const buttonLabels = (edit) => edit.components.flatMap((r) => r.toJSON().components.map((c) => c.label));

test('Remove syncs a buttons message: the removed role button leaves the Discord message', async () => {
  const env = setup();
  await seed();
  await addEntry(db, MSG, { roleId: ROLE, label: 'A' });
  await addEntry(db, MSG, { roleId: ROLE2, label: 'B' });
  const dm = withDiscordMessage(env);
  await handleBuilder(fake(env, panelId('rm'), { values: [ROLE] }), env.ctx);
  assert.equal(dm.edits.length, 1);
  assert.deepEqual(buttonLabels(dm.edits[0]), ['B']);
});

test('Remove syncs a reactions message: the removed entry own reaction is taken off', async () => {
  const env = setup();
  await seed('reactions');
  await addEntry(db, MSG, { roleId: ROLE, emoji: '😀' });
  await addEntry(db, MSG, { roleId: ROLE2, emoji: '😎' });
  const dm = withDiscordMessage(env, ['😀', '😎']);
  await handleBuilder(fake(env, panelId('rm'), { values: [ROLE] }), env.ctx);
  assert.deepEqual(dm.removed, [['😀', BOT]]);
});

test('Add syncs the Discord message: the new button appears', async () => {
  const env = setup();
  await seed();
  const dm = withDiscordMessage(env);
  await handleBuilder(fake(env, panelId('modal', { extra: ROLE }), { fields: { label: 'Gamers' } }), env.ctx);
  assert.equal(dm.edits.length, 1);
  assert.deepEqual(buttonLabels(dm.edits[0]), ['Gamers']);
});

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { testDb } from '../helpers/db.js';
import { setFeature } from '../../src/db/settings.js';
import { verifyMember, postPanel, handleVerifyButton } from '../../src/features/verification/verify.js';
import { createVerificationCommand } from '../../src/features/verification/commands.js';
import * as feature from '../../src/features/verification/index.js';

let db;
before(async () => { db = await testDb(); });
after(async () => { await db.end?.(); });

const G = 'g1';
const EPH = 64;

async function setup(config = {}, enabled = true) {
  await setFeature(db, G, 'verification', {
    enabled,
    config: { mode: 'button', roleId: 'rv', channelId: 'cv', messageId: 'm1', state: 'active', ...config },
  });
}

function makeGuild({ role = { id: 'rv', position: 1, managed: false }, botTop = 5 } = {}) {
  const members = new Map();
  return {
    id: G,
    roles: {
      cache: new Map(role ? [[role.id, role]] : []),
      fetch: async (id) => (role && role.id === id ? role : null),
    },
    members: {
      me: { roles: { highest: { position: botTop } } },
      fetch: async (id) => {
        const m = members.get(id);
        if (!m) throw new Error('Unknown Member');
        return m;
      },
      _set: (m) => members.set(m.id, m),
    },
  };
}

function makeMember(id = 'u1', roles = [], { failAdd = false } = {}) {
  const cache = new Map(roles.map((r) => [r, { id: r }]));
  const added = [];
  return {
    id,
    added,
    roles: {
      cache,
      add: async (rid) => {
        if (failAdd) throw new Error('boom');
        added.push(rid);
        cache.set(rid, { id: rid });
      },
    },
  };
}

function makeInteraction(guild, member) {
  const replies = [];
  return {
    replies,
    customId: 'verification:go',
    guildId: G,
    guild,
    member,
    user: { id: member.id },
    inGuild: () => true,
    isButton: () => true,
    reply: async (p) => { replies.push(p); },
  };
}

function logger() {
  const calls = [];
  return { calls, deps: { logVerification: async (...a) => { calls.push(a); } } };
}

test('button mode grants the role and answers privately', async () => {
  await setup();
  const guild = makeGuild();
  const member = makeMember();
  guild.members._set(member);
  const log = logger();
  const i = makeInteraction(guild, member);
  await handleVerifyButton(i, { db }, log.deps);
  assert.deepEqual(member.added, ['rv']);
  assert.equal(i.replies.length, 1);
  assert.equal(i.replies[0].flags & EPH, EPH);
  assert.equal(log.calls.length, 1);
  assert.equal(log.calls[0][3].kind, 'verified');
});

test('an already verified member is told so and nothing changes', async () => {
  await setup();
  const guild = makeGuild();
  const member = makeMember('u1', ['rv']);
  guild.members._set(member);
  const log = logger();
  const i = makeInteraction(guild, member);
  await handleVerifyButton(i, { db }, log.deps);
  assert.deepEqual(member.added, []);
  assert.equal(log.calls.length, 0);
  assert.equal(i.replies[0].flags & EPH, EPH);
  assert.ok(!i.replies[0].content.startsWith('verification.'));
});

test('a disabled feature answers off and does nothing', async () => {
  await setup({}, false);
  const guild = makeGuild();
  const member = makeMember();
  guild.members._set(member);
  const log = logger();
  const i = makeInteraction(guild, member);
  await handleVerifyButton(i, { db }, log.deps);
  assert.deepEqual(member.added, []);
  assert.equal(log.calls.length, 0);
  assert.equal(i.replies.length, 1);
  assert.equal(i.replies[0].flags & EPH, EPH);
});

test('state none answers off', async () => {
  await setup({ state: 'none' });
  const guild = makeGuild();
  const member = makeMember();
  guild.members._set(member);
  const i = makeInteraction(guild, member);
  await handleVerifyButton(i, { db }, logger().deps);
  assert.deepEqual(member.added, []);
  assert.equal(i.replies.length, 1);
});

test('a member who left (fetch error) is handled', async () => {
  await setup();
  const guild = makeGuild();
  const member = makeMember();
  const log = logger();
  const i = makeInteraction(guild, member);
  await assert.doesNotReject(handleVerifyButton(i, { db }, log.deps));
  assert.deepEqual(member.added, []);
  assert.equal(log.calls.length, 0);
  assert.equal(i.replies.length, 1);
  assert.equal(i.replies[0].flags & EPH, EPH);
  const r = await verifyMember({ db }, guild, null, { method: 'button' }, log.deps);
  assert.deepEqual(r, { ok: false, reason: 'discord_error' });
});

test('a deleted role gives no_role', async () => {
  await setup();
  const guild = makeGuild({ role: null });
  const member = makeMember();
  guild.members._set(member);
  const log = logger();
  const r = await verifyMember({ db }, guild, member, { method: 'button' }, log.deps);
  assert.deepEqual(r, { ok: false, reason: 'no_role' });
  assert.equal(log.calls.length, 0);
  const i = makeInteraction(guild, member);
  await handleVerifyButton(i, { db }, log.deps);
  assert.equal(i.replies.length, 1);
});

test('a role above the bot gives role_too_high', async () => {
  await setup();
  const guild = makeGuild({ role: { id: 'rv', position: 9, managed: false }, botTop: 5 });
  const member = makeMember();
  guild.members._set(member);
  const log = logger();
  const r = await verifyMember({ db }, guild, member, { method: 'button' }, log.deps);
  assert.deepEqual(r, { ok: false, reason: 'role_too_high' });
  assert.deepEqual(member.added, []);
  assert.equal(log.calls.length, 0);
});

test('a failing role add gives discord_error and no log', async () => {
  await setup();
  const guild = makeGuild();
  const member = makeMember('u1', [], { failAdd: true });
  const log = logger();
  const r = await verifyMember({ db }, guild, member, { method: 'button' }, log.deps);
  assert.deepEqual(r, { ok: false, reason: 'discord_error' });
  assert.equal(log.calls.length, 0);
});

test('a double click grants once and logs once', async () => {
  await setup();
  const guild = makeGuild();
  const member = makeMember();
  guild.members._set(member);
  const log = logger();
  const a = makeInteraction(guild, member);
  const b = makeInteraction(guild, member);
  await Promise.all([handleVerifyButton(a, { db }, log.deps), handleVerifyButton(b, { db }, log.deps)]);
  assert.deepEqual(member.added, ['rv']);
  assert.equal(log.calls.length, 1);
  assert.equal(a.replies.length + b.replies.length, 2);
  const again = makeInteraction(guild, member);
  await handleVerifyButton(again, { db }, log.deps);
  assert.equal(member.added.length, 1);
  assert.equal(log.calls.length, 1);
});

test('manual method logs manual_verify with the actor', async () => {
  await setup();
  const guild = makeGuild();
  const member = makeMember();
  const log = logger();
  const r = await verifyMember({ db }, guild, member, { method: 'manual', actorId: 'mod1' }, log.deps);
  assert.deepEqual(r, { ok: true });
  assert.equal(log.calls[0][3].kind, 'manual_verify');
  assert.equal(log.calls[0][3].actorId, 'mod1');
});

test('captcha mode answers not available for now', async () => {
  await setup({ mode: 'captcha' });
  const guild = makeGuild();
  const member = makeMember();
  guild.members._set(member);
  const i = makeInteraction(guild, member);
  await handleVerifyButton(i, { db }, logger().deps);
  assert.deepEqual(member.added, []);
  assert.equal(i.replies.length, 1);
  assert.equal(i.replies[0].flags & EPH, EPH);
});

test('postPanel posts one button message with the verify customId', async () => {
  const sent = [];
  const channel = { send: async (p) => { sent.push(p); return { id: 'msg9' }; } };
  const id = await postPanel({ db }, makeGuild(), channel, 'en');
  assert.equal(id, 'msg9');
  assert.equal(sent.length, 1);
  const btn = sent[0].components[0].components[0].toJSON();
  assert.equal(btn.custom_id, 'verification:go');
  assert.ok(btn.label && !btn.label.startsWith('verification.'));
  const bad = { send: async () => { throw new Error('x'); } };
  assert.equal(await postPanel({ db }, makeGuild(), bad, 'en'), null);
});

test('the command module registers the verification component prefix', () => {
  const c = createVerificationCommand();
  assert.equal(c.components.prefix, 'verification');
  assert.equal(typeof c.components.handle, 'function');
  assert.ok(feature.commands.some((x) => x.components?.prefix === 'verification'));
});

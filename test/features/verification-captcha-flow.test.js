import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { testDb } from '../helpers/db.js';
import { setFeature } from '../../src/db/settings.js';
import { handle } from '../../src/features/verification/verify.js';
import { createChallengeStore } from '../../src/features/verification/captcha.js';

let db;
before(async () => { db = await testDb(); });
after(async () => { await db.end?.(); });

const G = 'g1';
const EPH = 64;
const ASCII = /^[\x20-\x7e\n]+$/;

async function setup(config = {}, enabled = true, lang = 'en') {
  await setFeature(db, G, 'verification', {
    enabled,
    config: { mode: 'captcha', roleId: 'rv', channelId: 'cv', messageId: 'm1', state: 'active', ...config },
  });
  await setFeature(db, G, 'language', { enabled: true, config: { lang } });
}

function makeGuild({ role = { id: 'rv', position: 1, managed: false } } = {}) {
  const members = new Map();
  return {
    id: G,
    roles: { cache: new Map(role ? [[role.id, role]] : []), fetch: async () => role },
    members: {
      me: { roles: { highest: { position: 5 } } },
      fetch: async (arg) => {
        const m = members.get(typeof arg === 'string' ? arg : arg.user);
        if (!m) throw new Error('Unknown Member');
        return m;
      },
      _set: (m) => members.set(m.id, m),
    },
  };
}

function makeMember(id = 'u1', roles = []) {
  const cache = new Map(roles.map((r) => [r, { id: r }]));
  const added = [];
  return { id, added, roles: { cache, add: async (rid) => { added.push(rid); cache.set(rid, { id: rid }); } } };
}

function makeInteraction(guild, userId, customId, { code, kind = 'button' } = {}) {
  const replies = [];
  const modals = [];
  let deferred = 0;
  return {
    replies, modals,
    get deferred() { return deferred; },
    customId, guildId: G, guild,
    user: { id: userId },
    isButton: () => kind === 'button',
    isModalSubmit: () => kind === 'modal',
    fields: { getTextInputValue: () => code },
    reply: async (p) => { replies.push(p); },
    deferReply: async () => { deferred += 1; },
    editReply: async (p) => { replies.push(p); },
    showModal: async (m) => { modals.push(m); },
  };
}

// random() = 0 makes every code "AAAAA".
function deps(store = createChallengeStore({ random: () => 0 })) {
  const logs = [];
  return { store, logs, render: async () => Buffer.from('png'), logVerification: async (...a) => { logs.push(a); } };
}

const json = (c) => c.toJSON();
const last = (i) => i.replies[i.replies.length - 1];

test('go in captcha mode replies with an image and the enter button', async () => {
  await setup();
  const guild = makeGuild();
  guild.members._set(makeMember());
  const d = deps();
  const i = makeInteraction(guild, 'u1', 'verification:go');
  await handle(i, { db }, d);
  assert.equal(i.deferred, 1);
  assert.equal(i.replies.length, 1);
  const r = i.replies[0];
  assert.equal(r.files.length, 1);
  assert.equal(r.files[0].name, 'captcha.png');
  assert.equal(json(r.components[0].components[0]).custom_id, 'verification:enter:u1');
  assert.equal(d.store.check(G, 'u1', 'AAAAA'), 'ok');
});

test('go during a cooldown says how long to wait, with no image', async () => {
  await setup();
  const guild = makeGuild();
  guild.members._set(makeMember());
  const d = deps();
  d.store.issue(G, 'u1');
  for (let n = 0; n < 3; n++) d.store.check(G, 'u1', 'ZZZZZ');
  const i = makeInteraction(guild, 'u1', 'verification:go');
  await handle(i, { db }, d);
  assert.equal(i.replies.length, 1);
  assert.ok(!i.replies[0].files);
  assert.match(i.replies[0].content, /\d+ seconds/);
});

test('the enter button opens the modal for the right user', async () => {
  await setup();
  const i = makeInteraction(makeGuild(), 'u1', 'verification:enter:u1');
  await handle(i, { db }, deps());
  assert.equal(i.modals.length, 1);
  const m = json(i.modals[0]);
  assert.equal(m.custom_id, 'verification:code:u1');
  const input = m.components[0].components[0];
  assert.equal(input.min_length, 5);
  assert.equal(input.max_length, 5);
  assert.equal(input.required, true);
  assert.equal(i.replies.length, 0);
});

test('the enter button from another user is refused privately', async () => {
  await setup();
  const i = makeInteraction(makeGuild(), 'u2', 'verification:enter:u1');
  await handle(i, { db }, deps());
  assert.equal(i.modals.length, 0);
  assert.equal(i.replies.length, 1);
  assert.equal(i.replies[0].flags & EPH, EPH);
});

test('the modal from another user is refused', async () => {
  await setup();
  const guild = makeGuild();
  const member = makeMember('u2');
  guild.members._set(member);
  const d = deps();
  d.store.issue(G, 'u1');
  const i = makeInteraction(guild, 'u2', 'verification:code:u1', { code: 'AAAAA', kind: 'modal' });
  await handle(i, { db }, d);
  assert.deepEqual(member.added, []);
  assert.equal(i.replies.length, 1);
  assert.equal(i.replies[0].flags & EPH, EPH);
  assert.equal(d.store.check(G, 'u1', 'AAAAA'), 'ok');
});

test('a correct code verifies and answers privately', async () => {
  await setup();
  const guild = makeGuild();
  const member = makeMember();
  guild.members._set(member);
  const d = deps();
  d.store.issue(G, 'u1');
  const i = makeInteraction(guild, 'u1', 'verification:code:u1', { code: 'aaaaa', kind: 'modal' });
  await handle(i, { db }, d);
  assert.deepEqual(member.added, ['rv']);
  assert.equal(i.deferred, 1);
  assert.equal(i.replies.length, 1);
  assert.ok(!i.replies[0].content.startsWith('verification.'));
  assert.equal(d.logs.length, 1);
  assert.equal(d.logs[0][3].detail, 'captcha');
});

test('a wrong code reports tries left', async () => {
  await setup();
  const guild = makeGuild();
  const member = makeMember();
  guild.members._set(member);
  const d = deps();
  d.store.issue(G, 'u1');
  const i = makeInteraction(guild, 'u1', 'verification:code:u1', { code: 'BBBBB', kind: 'modal' });
  await handle(i, { db }, d);
  assert.deepEqual(member.added, []);
  assert.equal(d.logs.length, 0);
  assert.match(i.replies[0].content, /2/);
});

test('three wrong codes show the cooldown and offer Verify again', async () => {
  await setup();
  const guild = makeGuild();
  guild.members._set(makeMember());
  const d = deps();
  d.store.issue(G, 'u1');
  let i;
  for (let n = 0; n < 3; n++) {
    i = makeInteraction(guild, 'u1', 'verification:code:u1', { code: 'BBBBB', kind: 'modal' });
    await handle(i, { db }, d);
  }
  assert.match(last(i).content, /\d+ seconds/);
  assert.equal(json(last(i).components[0].components[0]).custom_id, 'verification:go');
  assert.equal(d.logs.length, 0);
});

test('an expired or missing code asks to press Verify again', async () => {
  await setup();
  const guild = makeGuild();
  guild.members._set(makeMember());
  const i = makeInteraction(guild, 'u1', 'verification:code:u1', { code: 'AAAAA', kind: 'modal' });
  await handle(i, { db }, deps());
  assert.equal(i.replies.length, 1);
  assert.match(i.replies[0].content, /Verify again/);
});

test('a disabled feature answers off at every step', async () => {
  await setup({}, false);
  const guild = makeGuild();
  const member = makeMember();
  guild.members._set(member);
  const d = deps();
  d.store.issue(G, 'u1');
  for (const [id, kind] of [['verification:go', 'button'], ['verification:enter:u1', 'button'], ['verification:code:u1', 'modal']]) {
    const i = makeInteraction(guild, 'u1', id, { code: 'AAAAA', kind });
    await handle(i, { db }, d);
    assert.equal(i.replies.length, 1);
    assert.equal(i.modals.length, 0);
    assert.equal(i.replies[0].flags & EPH, EPH);
  }
  assert.deepEqual(member.added, []);
});

test('a member who left or a deleted role does not crash the modal', async () => {
  await setup();
  const d = deps();
  d.store.issue(G, 'u1');
  const gone = makeInteraction(makeGuild(), 'u1', 'verification:code:u1', { code: 'AAAAA', kind: 'modal' });
  await assert.doesNotReject(handle(gone, { db }, d));
  assert.equal(gone.replies.length, 1);
  const guild = makeGuild({ role: null });
  guild.members._set(makeMember());
  d.store.issue(G, 'u1');
  const norole = makeInteraction(guild, 'u1', 'verification:code:u1', { code: 'AAAAA', kind: 'modal' });
  await handle(norole, { db }, d);
  assert.equal(norole.replies.length, 1);
});

for (const lang of ['fr', 'ar']) {
  test(`captcha texts are English even when the server language is ${lang}`, async () => {
    await setup({}, true, lang);
    const guild = makeGuild();
    guild.members._set(makeMember());
    const d = deps();
    const go = makeInteraction(guild, 'u1', 'verification:go');
    await handle(go, { db }, d);
    assert.match(go.replies[0].content, ASCII);
    assert.equal(json(go.replies[0].components[0].components[0]).label, 'Enter code');
    const en = makeInteraction(guild, 'u1', 'verification:enter:u1');
    await handle(en, { db }, d);
    const m = json(en.modals[0]);
    assert.equal(m.title, 'Verification code');
    assert.equal(m.components[0].components[0].label, 'Code from the image');
    const bad = makeInteraction(guild, 'u1', 'verification:code:u1', { code: 'BBBBB', kind: 'modal' });
    await handle(bad, { db }, d);
    assert.match(bad.replies[0].content, ASCII);
    const ok = makeInteraction(guild, 'u1', 'verification:code:u1', { code: 'AAAAA', kind: 'modal' });
    await handle(ok, { db }, d);
    assert.match(ok.replies[0].content, ASCII);
    await setup();
  });
}

test('button mode is unchanged', async () => {
  await setup({ mode: 'button' });
  const guild = makeGuild();
  const member = makeMember();
  guild.members._set(member);
  const d = deps();
  const i = makeInteraction(guild, 'u1', 'verification:go');
  await handle(i, { db }, d);
  assert.deepEqual(member.added, ['rv']);
  assert.ok(!i.replies[0].files);
});

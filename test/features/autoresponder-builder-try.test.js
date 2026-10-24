import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { testDb } from '../helpers/db.js';
import { resetDb } from '../../src/db/index.js';
import { setFeature } from '../../src/db/settings.js';
import { t } from '../../src/i18n/index.js';
import { listRules } from '../../src/features/autoresponder/store.js';
import { clearCache } from '../../src/features/autoresponder/cache.js';
import { createAutoresponderCommand } from '../../src/features/autoresponder/commands.js';
import { drafts } from '../../src/features/autoresponder/builder/drafts.js';
import { builderId, parseBuilderId, panelPayload } from '../../src/features/autoresponder/builder/panel.js';
import { newDraft, patch } from '../../src/features/autoresponder/builder/draft.js';

let db;
before(async () => { db = await testDb(); });
beforeEach(async () => { await resetDb(db); clearCache(); });
after(async () => { await db.end(); });

const G = 'g1';
const ROLE = '111111111111111111';
const command = createAutoresponderCommand();
const tt = (key, vars) => t('en', `autoresponder.test.${key}`, vars);
const bt = (key, vars) => t('en', `autoresponder.builder.${key}`, vars);
const boom = (name) => () => { throw new Error(`side effect: ${name}`); };

function setup() {
  const roles = new Map([[ROLE, { id: ROLE, name: 'Vip', position: 1, managed: false, permissions: { has: () => false } }]]);
  const guild = {
    id: G, name: 'Srv', ownerId: 'owner', memberCount: 5, createdTimestamp: 1_500_000_000_000, iconURL: () => 'i.png',
    roles: { cache: roles }, channels: { cache: new Map() }, members: { me: { id: 'bot', roles: { highest: { position: 10 } } } },
  };
  const logChannel = { isTextBased: () => true, send: async () => ({ id: 'log1', channelId: 'logch' }) };
  const ctx = { db, client: { user: { id: 'bot' }, channels: { fetch: async () => logChannel } } };
  const user = { id: 'staff', username: 'Sam', globalName: null, createdTimestamp: 1_600_000_000_000, displayAvatarURL: () => 'a.png', tag: 'Sam#0' };
  const member = {
    id: 'staff', displayName: 'Sam', user, guild, permissions: { has: () => true },
    roles: { highest: { position: 5 }, cache: new Map(), add: boom('roles.add'), remove: boom('roles.remove') },
    send: boom('member.send'), setNickname: boom('setNickname'),
  };
  const channel = { id: 'c1', name: 'general', send: boom('channel.send'), reply: boom('channel.reply'), isTextBased: () => true };
  return { guild, ctx, member, user, channel };
}

function fake(env, extra = {}) {
  const calls = [];
  const i = {
    guildId: G, guild: env.guild, member: env.member, user: env.user, channel: env.channel, channelId: 'c1', calls,
    deferred: false, replied: false,
    inGuild: () => true,
    isModalSubmit: () => Boolean(extra.fields),
    isFromMessage: () => true,
    values: extra.values,
    customId: extra.customId,
    options: { getSubcommand: () => extra.sub, getString: () => null, getInteger: () => null },
    fields: { getTextInputValue: (k) => (extra.fields ?? {})[k] ?? '' },
    update: async (p) => { i.replied = true; calls.push(['update', p]); },
    reply: async (p) => { i.replied = true; calls.push(['reply', p]); },
    showModal: async (m) => { calls.push(['showModal', m.toJSON()]); },
    deferUpdate: async () => { i.deferred = true; calls.push(['deferUpdate']); },
    editReply: async (p) => { calls.push(['editReply', p]); },
    followUp: async (p) => { calls.push(['followUp', p]); },
  };
  return i;
}

const on = async () => {
  await setFeature(db, G, 'logging', { enabled: true, config: { channels: { default: 'logch' } } });
  await setFeature(db, G, 'autoresponder', { enabled: true });
};
const last = (i) => i.calls.at(-1);
const flat = (components) => components.flatMap((r) => r.toJSON().components);
const kinds = (payload) => flat(payload.components).map((c) => c.custom_id.split(':')[2]);

async function open(env) {
  const i = fake(env, { sub: 'builder' });
  await command.execute(i, env.ctx);
  const [, payload] = last(i);
  return parseBuilderId(flat(payload.components)[0].custom_id).panelId;
}

async function press(env, panelId, action, { extra, ...rest } = {}) {
  const i = fake(env, { customId: builderId(action, 'staff', panelId, extra), ...rest });
  await command.components.handle(i, env.ctx);
  return i;
}

async function start(draft = {}) {
  const env = setup();
  await on();
  const panelId = await open(env);
  drafts.update(panelId, { draft: patch(newDraft(), { trigger: 'hello', matchMode: 'includes', text: 'hi {user_name}', ...draft }), page: 'review' });
  return { env, panelId };
}
const tryIt = (env, panelId, sample) => press(env, panelId, 'mtry', { fields: { sample } });
const body = (i) => last(i)[1].content;

test('the review page has a Try it button that opens the sample modal', async () => {
  const { env, panelId } = await start();
  const [kind, modal] = last(await press(env, panelId, 'btry'));
  assert.equal(kind, 'showModal');
  assert.equal(parseBuilderId(modal.custom_id).action, 'mtry');
  const input = modal.components[0].components[0];
  assert.equal(input.custom_id, 'sample');
  assert.equal(input.style, 2);
  assert.equal(input.max_length, 1000);
  assert.ok(modal.title.length <= 45 && input.label.length <= 45);
  for (const lang of ['en', 'fr', 'ar']) {
    const review = panelPayload(lang, { panelId, userId: 'u', page: 'review', draft: newDraft() });
    assert.ok(kinds(review).includes('btry'));
    assert.ok(review.components.length <= 5);
    for (const r of review.components) assert.ok(r.toJSON().components.length <= 5);
  }
});

test('a matching sample shows the match line, the gates, the rendered text and the actions', async () => {
  const { env, panelId } = await start({
    gates: [{ fn: 'requireperm', perms: ['Administrator'] }, { fn: 'cooldown', seconds: 30 }],
    actions: [{ fn: 'react', emoji: '👍' }],
  });
  const i = await tryIt(env, panelId, 'well hello there');
  assert.equal(last(i)[0], 'reply');
  assert.equal(last(i)[1].flags !== undefined, true);
  const text = body(i);
  assert.ok(text.includes(bt('try.match')));
  assert.ok(!text.includes(bt('try.nomatch')) && !text.includes(bt('try.wouldRun')));
  assert.ok(text.includes(tt('gate.pass', { gate: 'requireperm' })));
  assert.ok(text.includes(tt('gate.cooldown', { seconds: 30 })));
  assert.ok(text.includes('hi Sam'));
  assert.ok(text.includes(tt('action.react', { detail: '👍' })));
  assert.ok(drafts.get(panelId), 'the panel stays');
});

test('a non-matching sample says so and still shows what it would do', async () => {
  const { env, panelId } = await start();
  const text = body(await tryIt(env, panelId, 'goodbye'));
  assert.ok(text.includes(bt('try.nomatch')));
  assert.ok(text.includes(bt('try.wouldRun')));
  assert.ok(text.includes('hi Sam'));
});

test('a failing requirerole shows gate.fail and no text', async () => {
  const { env, panelId } = await start({ gates: [{ fn: 'requirerole', ids: [ROLE] }] });
  const text = body(await tryIt(env, panelId, 'hello'));
  assert.ok(text.includes(tt('gate.fail', { gate: 'requirerole' })));
  assert.ok(!text.includes('hi Sam'));
});

test('a draft that does not compile replies with the errors', async () => {
  const { env, panelId } = await start({ embed: { kind: 'named', name: 'missing' } });
  const i = await tryIt(env, panelId, 'hello');
  assert.equal(last(i)[0], 'reply');
  assert.ok(body(i).includes(t('en', 'autoresponder.error.EMBED_NOT_FOUND', { detail: '' }).trim()));
  assert.ok(!body(i).includes(bt('try.match')));
});

test('Try it has no side effects: no write reaches the database, and Discord writes would throw', async () => {
  const { env, panelId } = await start({ actions: [{ fn: 'addrole', id: ROLE }, { fn: 'setnick', text: 'Bob' }, { fn: 'react', emoji: '👍' }], deleteTrigger: true, dest: 'dm' });
  const queries = [];
  const orig = db.query;
  db.query = (...a) => { queries.push(String(a[0])); return orig.apply(db, a); };
  const before = (await listRules(db, G)).length;
  let i;
  try { i = await tryIt(env, panelId, 'hello'); } finally { db.query = orig; }
  assert.ok(body(i).includes(bt('try.match')), body(i));
  for (const q of queries) assert.match(q.trim(), /^SELECT/i, q);
  assert.equal((await listRules(db, G)).length, before);
  const { rows } = await db.query("SELECT count(*)::int AS n FROM autoresponder_cooldowns").catch(() => ({ rows: [{ n: 0 }] }));
  assert.equal(rows[0].n, 0);
  assert.equal(i.calls.length, 1);
});

test('the output is at most 2000 characters', async () => {
  const gates = Array.from({ length: 25 }, (_, k) => ({ fn: 'requireperm', perms: ['Administrator'] }));
  const { env, panelId } = await start({ text: 'x'.repeat(1900), gates });
  const text = body(await tryIt(env, panelId, 'hello'));
  assert.ok(text.length <= 2000, String(text.length));
});

test('a trigger that is empty never matches and a forged call or expired panel never throws', async () => {
  const { env, panelId } = await start({ trigger: '' });
  assert.ok(body(await tryIt(env, panelId, 'hello')).includes(bt('try.nomatch')));
  const forged = await press(env, panelId, 'mtry');
  assert.equal(last(forged)[1].content, bt('expired'));
  const gone = await press(env, 'nopanel0', 'btry');
  assert.equal(last(gone)[1].content, bt('expired'));
  const gone2 = await tryIt(env, 'nopanel0', 'hello');
  assert.equal(last(gone2)[1].content, bt('expired'));
});

test('every Try it i18n key exists in en, fr and ar, with short labels', () => {
  const short = ['btn.try', 'modal.try', 'input.sample'];
  const keys = [...short, 'try.match', 'try.nomatch', 'try.wouldRun'].map((k) => `autoresponder.builder.${k}`);
  for (const lang of ['en', 'fr', 'ar']) {
    for (const key of keys) assert.notEqual(t(lang, key), key, `${lang} ${key}`);
    for (const k of short) assert.ok(t(lang, `autoresponder.builder.${k}`).length <= 45, `${lang} ${k}`);
  }
});

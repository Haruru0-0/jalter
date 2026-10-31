import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { MessageFlags } from 'discord.js';
import { testDb } from '../helpers/db.js';
import { resetDb } from '../../src/db/index.js';
import { setFeature } from '../../src/db/settings.js';
import { t } from '../../src/i18n/index.js';
import { createRule, getRule, listRules, MAX_RULES } from '../../src/features/autoresponder/store.js';
import { getRules, clearCache } from '../../src/features/autoresponder/cache.js';
import { claimCooldown } from '../../src/features/autoresponder/cooldown.js';
import { pruneButtonMessages } from '../../src/features/autoresponder/buttons/store.js';
import { COMPILE_ERROR_CODES } from '../../src/features/autoresponder/script/compile.js';
import { RUN_ERROR_CODES } from '../../src/features/autoresponder/execute.js';
import { createAutoresponderCommand } from '../../src/features/autoresponder/commands.js';
import { commands, events, housekeeping } from '../../src/features/autoresponder/index.js';
import { pruneCooldowns } from '../../src/features/autoresponder/cooldown.js';

let db;
before(async () => { db = await testDb(); });
beforeEach(async () => { await resetDb(db); clearCache(); });
after(async () => { await db.end(); });

const G = 'g1';
const command = createAutoresponderCommand();
const compiled = { version: 1, template: [{ t: 'text', v: 'hi' }], gates: [], actions: [], flags: { silent: false, dm: false, delete: false, embed: null, sendTo: null, deleteReplyAfter: null } };
const base = { guildId: G, trigger: 'hello', matchMode: 'exact', script: 'hi', compiled, createdBy: 'u1' };

function setup({ staff = true } = {}) {
  const guild = { id: G, ownerId: 'owner', roles: { cache: new Map() }, channels: { cache: new Map() }, members: { me: { id: 'bot', roles: { highest: { position: 10 } } } } };
  const logged = [];
  const logChannel = { isTextBased: () => true, send: async (payload) => { logged.push(payload); return { id: 'log1', channelId: 'logch' }; } };
  const ctx = { db, client: { user: { id: 'bot' }, channels: { fetch: async () => logChannel } } };
  const member = { id: 'staff', permissions: { has: () => staff }, roles: { highest: { position: 5 }, cache: new Map() }, guild };
  return { guild, ctx, member, logged };
}

function reply() {
  const replies = [];
  return { replies, fn: async (p) => { replies.push(typeof p === 'string' ? { content: p } : p); } };
}

function slash(env, sub, opts = {}) {
  const r = reply();
  const interaction = {
    guildId: G, guild: env.guild, member: env.member, user: { id: 'staff' }, replies: r.replies, modals: [],
    inGuild: () => true,
    isModalSubmit: () => false,
    options: {
      getSubcommand: () => sub,
      getString: (n) => opts[n] ?? null,
      getInteger: (n) => opts[n] ?? null,
    },
    reply: r.fn,
    showModal: async (m) => { interaction.modals.push(m.toJSON()); },
  };
  return interaction;
}

function submit(env, customId, fields) {
  const r = reply();
  return {
    guildId: G, guild: env.guild, member: env.member, user: { id: 'staff' }, replies: r.replies, customId,
    inGuild: () => true,
    isModalSubmit: () => true,
    fields: { getTextInputValue: (n) => fields[n] },
    reply: r.fn,
  };
}

const run = (env, sub, opts) => { const i = slash(env, sub, opts); return command.execute(i, env.ctx).then(() => i); };
const send = (env, customId, fields) => { const i = submit(env, customId, fields); return command.components.handle(i, env.ctx).then(() => i); };
const on = async () => {
  await setFeature(db, G, 'logging', { enabled: true, config: { channels: { default: 'logch' } } });
  await setFeature(db, G, 'autoresponder', { enabled: true });
};
const text = (i) => i.replies.at(-1).content;
const inputs = (modal) => modal.components.map((row) => row.components[0]);

test('index exports commands, events and housekeeping', () => {
  assert.equal(commands[0].data.name, 'autoresponder');
  assert.ok(Array.isArray(events));
  assert.deepEqual(housekeeping, [pruneCooldowns, pruneButtonMessages]);
  assert.equal(command.components.prefix, 'autoresponder');
});

test('enable and disable update the cache at once', async () => {
  const env = setup();
  await createRule(db, base);
  assert.deepEqual(await getRules(db, G), []);
  const i = await run(env, 'enable');
  assert.equal(i.replies.at(-1).flags, MessageFlags.Ephemeral);
  assert.equal((await getRules(db, G)).length, 1);
  await run(env, 'disable');
  assert.deepEqual(await getRules(db, G), []);
});

test('with the feature off every subcommand but enable/disable is refused; members are refused everywhere', async () => {
  const env = setup();
  for (const sub of ['add', 'edit', 'editmatchmode', 'toggle', 'remove', 'list', 'show']) {
    const i = await run(env, sub, { id: 1, match: 'exact' });
    assert.equal(text(i), t('en', 'common.featureOff', { command: '/autoresponder enable' }), sub);
    assert.equal(i.modals.length, 0);
  }
  await on();
  const member = setup({ staff: false });
  for (const sub of ['enable', 'disable', 'add', 'list', 'remove']) {
    const i = await run(member, sub, { id: 1 });
    assert.equal(text(i), t('en', 'common.notAllowed'), sub);
  }
  assert.equal((await send(member, 'autoresponder:m:add:exact', { trigger: 'x', script: 'y' })).replies.at(-1).content, t('en', 'common.notAllowed'));
  assert.equal((await listRules(db, G)).length, 0);
});

test('add shows the modal with the documented id and two inputs', async () => {
  const env = setup();
  await on();
  const i = await run(env, 'add', { match: 'includes' });
  assert.equal(i.modals.length, 1);
  const m = i.modals[0];
  assert.equal(m.custom_id, 'autoresponder:m:add:includes');
  assert.ok(m.title.length <= 45);
  const [trigger, script] = inputs(m);
  assert.equal(trigger.custom_id, 'trigger');
  assert.equal(trigger.max_length, 100);
  assert.equal(trigger.style, 1);
  assert.equal(script.custom_id, 'script');
  assert.equal(script.max_length, 4000);
  assert.equal(script.style, 2);
  assert.equal((await run(env, 'add')).modals[0].custom_id, 'autoresponder:m:add:exact');
});

test('a valid submission stores the rule, drops the cache, logs once and replies with the id', async () => {
  const env = setup();
  await on();
  assert.deepEqual(await getRules(db, G), []);
  const i = await send(env, 'autoresponder:m:add:exact', { trigger: 'Hello', script: 'hi there {cooldown:10}' });
  const [rule] = await listRules(db, G);
  assert.equal(rule.trigger, 'Hello');
  assert.equal(rule.matchMode, 'exact');
  assert.ok(rule.compiled.version);
  assert.equal(rule.createdBy, 'staff');
  assert.equal((await getRules(db, G)).length, 1);
  assert.equal(env.logged.length, 1);
  assert.equal(text(i), t('en', 'autoresponder.created', { id: rule.id }));
  assert.equal(i.replies.at(-1).flags, MessageFlags.Ephemeral);
});

test('a script with two errors stores nothing, logs nothing and lists both with positions', async () => {
  const env = setup();
  await on();
  const i = await send(env, 'autoresponder:m:add:exact', { trigger: 'x', script: 'a {foo} b {bar}' });
  assert.equal((await listRules(db, G)).length, 0);
  assert.equal(env.logged.length, 0);
  const out = text(i);
  assert.match(out, new RegExp(t('en', 'autoresponder.error.UNKNOWN_FUNCTION', { detail: '"foo"' }).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.ok(out.includes('"bar"'));
  // Positions are shown counting from 1: the braces sit at offsets 2 and 10.
  assert.ok(out.includes('At character 3:'));
  assert.ok(out.includes('At character 11:'));
  assert.ok(!out.includes('At character 2:'));
  assert.ok(out.length <= 2000);
});

test('an error on the first character is shown as character 1, never 0', async () => {
  const env = setup();
  await on();
  const out = text(await send(env, 'autoresponder:m:add:exact', { trigger: 'x', script: '{foo}' }));
  assert.ok(out.includes('At character 1:'));
  assert.ok(!out.includes('At character 0'));
});

test('more than ten errors show ten lines, fitted to 2000 characters', async () => {
  const env = setup();
  await on();
  const script = Array.from({ length: 15 }, (_, k) => `{nofn${k}}`).join(' ');
  const out = text(await send(env, 'autoresponder:m:add:exact', { trigger: 'x', script }));
  assert.ok(out.length <= 2000);
  assert.equal(out.split('\n').filter((l) => l.includes('At character')).length, 10);
});

test('a bad regex trigger is refused', async () => {
  const env = setup();
  await on();
  const i = await send(env, 'autoresponder:m:add:regex', { trigger: '(', script: 'hi' });
  assert.equal(text(i), t('en', 'autoresponder.badTrigger.BAD_REGEX'));
  assert.equal((await listRules(db, G)).length, 0);
  const e = await send(env, 'autoresponder:m:add:exact', { trigger: '   ', script: 'hi' });
  assert.equal(text(e), t('en', 'autoresponder.badTrigger.EMPTY_TRIGGER'));
});

test('the 101st rule replies full', async () => {
  const env = setup();
  await on();
  for (let k = 0; k < MAX_RULES; k += 1) await createRule(db, { ...base, trigger: `t${k}` });
  const i = await send(env, 'autoresponder:m:add:exact', { trigger: 'one more', script: 'hi' });
  assert.equal(text(i), t('en', 'autoresponder.full'));
  assert.equal((await listRules(db, G)).length, MAX_RULES);
  assert.equal(env.logged.length, 0);
});

test('edit prefills trigger and script, and the submission saves, clears cooldowns and logs', async () => {
  const env = setup();
  await on();
  const rule = await createRule(db, { ...base, script: 'old script' });
  await claimCooldown(db, rule.id, 'u9', 60);
  const i = await run(env, 'edit', { id: rule.id });
  const m = i.modals[0];
  assert.equal(m.custom_id, `autoresponder:m:edit:${rule.id}`);
  const [trigger, script] = inputs(m);
  assert.equal(trigger.value, 'hello');
  assert.equal(script.value, 'old script');
  const done = await send(env, m.custom_id, { trigger: 'bye', script: 'new script' });
  const saved = await getRule(db, G, rule.id);
  assert.equal(saved.trigger, 'bye');
  assert.equal(saved.script, 'new script');
  assert.equal(text(done), t('en', 'autoresponder.updated', { id: rule.id }));
  assert.equal(env.logged.length, 1);
  const { rows } = await db.query('SELECT 1 FROM autoresponder_cooldowns WHERE rule_id = $1', [rule.id]);
  assert.equal(rows.length, 0);
});

test('edit of an unknown or foreign rule replies gone, also on submit', async () => {
  const env = setup();
  await on();
  const other = await createRule(db, { ...base, guildId: 'g2' });
  const i = await run(env, 'edit', { id: other.id });
  assert.equal(text(i), t('en', 'autoresponder.gone'));
  assert.equal(i.modals.length, 0);
  const s = await send(env, `autoresponder:m:edit:${other.id}`, { trigger: 'x', script: 'y' });
  assert.equal(text(s), t('en', 'autoresponder.gone'));
  assert.equal((await getRule(db, 'g2', other.id)).trigger, 'hello');
});

test('editmatchmode re-validates the stored trigger', async () => {
  const env = setup();
  await on();
  const rule = await createRule(db, { ...base, trigger: '(' });
  const bad = await run(env, 'editmatchmode', { id: rule.id, match: 'regex' });
  assert.equal(text(bad), t('en', 'autoresponder.badTrigger.BAD_REGEX'));
  assert.equal((await getRule(db, G, rule.id)).matchMode, 'exact');
  const good = await run(env, 'editmatchmode', { id: rule.id, match: 'includes' });
  assert.equal((await getRule(db, G, rule.id)).matchMode, 'includes');
  assert.equal(text(good), t('en', 'autoresponder.matchChanged', { id: rule.id, mode: 'includes' }));
  assert.equal(env.logged.length, 1);
});

test('toggle flips enabled and the cache drops the rule', async () => {
  const env = setup();
  await on();
  const rule = await createRule(db, base);
  assert.equal((await getRules(db, G)).length, 1);
  await run(env, 'toggle', { id: rule.id });
  assert.equal((await getRule(db, G, rule.id)).enabled, false);
  assert.equal((await getRules(db, G)).length, 0);
  await run(env, 'toggle', { id: rule.id });
  assert.equal((await getRules(db, G)).length, 1);
  assert.equal(env.logged.length, 2);
});

test('remove deletes the rule and its cooldown rows', async () => {
  const env = setup();
  await on();
  const rule = await createRule(db, base);
  await claimCooldown(db, rule.id, 'u9', 60);
  const i = await run(env, 'remove', { id: rule.id });
  assert.equal(text(i), t('en', 'autoresponder.removed', { id: rule.id }));
  assert.equal(await getRule(db, G, rule.id), null);
  const { rows } = await db.query('SELECT 1 FROM autoresponder_cooldowns WHERE rule_id = $1', [rule.id]);
  assert.equal(rows.length, 0);
  assert.equal(env.logged.length, 1);
  assert.equal(text(await run(env, 'remove', { id: rule.id })), t('en', 'autoresponder.gone'));
});

test('list and show read the store, including disabled rules, and stay under 2000 characters', async () => {
  const env = setup();
  await on();
  assert.equal(text(await run(env, 'list')), t('en', 'autoresponder.list.none'));
  for (let k = 0; k < 100; k += 1) await createRule(db, { ...base, trigger: `trigger number ${k} ${'x'.repeat(40)}` });
  const out = text(await run(env, 'list'));
  assert.ok(out.length <= 2000);
  assert.match(out, /and \d+ more/);
  const one = await createRule(db, { ...base, guildId: 'g3', trigger: 'solo', script: 's'.repeat(3500) }).catch(() => null);
  assert.equal(one.trigger, 'solo');
  const env3 = setup();
  env3.guild.id = 'g3';
  const i = slash(env3, 'show', { id: one.id });
  i.guildId = 'g3';
  await setFeature(db, 'g3', 'autoresponder', { enabled: true });
  await command.execute(i, env3.ctx);
  assert.ok(text(i).length <= 2000);
  assert.ok(text(i).includes('solo'));
  assert.equal(text(await run(env, 'show', { id: one.id })), t('en', 'autoresponder.gone'));
});

test('every compile error, run error, and key text exists in en, fr and ar, within modal limits', () => {
  const keys = [
    ...COMPILE_ERROR_CODES.map((c) => `autoresponder.error.${c}`),
    ...RUN_ERROR_CODES.map((c) => `autoresponder.run.${c}`),
    ...['EMPTY_TRIGGER', 'TRIGGER_TOO_LONG', 'BAD_MODE', 'BAD_REGEX'].map((c) => `autoresponder.badTrigger.${c}`),
    ...['add', 'edit', 'editmatchmode', 'toggle', 'remove'].map((c) => `autoresponder.action.${c}`),
    'autoresponder.errors.line',
  ];
  for (const lang of ['en', 'fr', 'ar']) {
    for (const key of keys) assert.notEqual(t(lang, key), key, `${lang} ${key}`);
    for (const key of ['modal.title', 'modal.trigger', 'modal.script']) {
      const v = t(lang, `autoresponder.${key}`);
      assert.ok(v !== `autoresponder.${key}` && v.length <= 45, `${lang} ${key}`);
    }
  }
});

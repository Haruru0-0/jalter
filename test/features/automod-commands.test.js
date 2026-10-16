import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { commands } from '../../src/features/automod/index.js';
import { parseSteps, createAutomodCommand } from '../../src/features/automod/commands.js';
import { readConfig, RULES } from '../../src/features/automod/config.js';
import { getFeature } from '../../src/db/settings.js';
import { collectModules } from '../../src/core/loader.js';
import { modules } from '../../src/modules.js';
import { buildHelp } from '../../src/features/help/index.js';
import { t } from '../../src/i18n/index.js';
import { testDb } from '../helpers/db.js';

const cmd = commands[0];
const json = cmd.data.toJSON();

test('parseSteps accepts 3:warn,5:timeout:10m', () => {
  assert.deepEqual(parseSteps('3:warn,5:timeout:10m, 8:timeout:1d'), {
    ok: true,
    steps: [
      { strikes: 3, action: 'warn', timeoutSeconds: null },
      { strikes: 5, action: 'timeout', timeoutSeconds: 600 },
      { strikes: 8, action: 'timeout', timeoutSeconds: 86400 },
    ],
  });
});

test('parseSteps rejects duplicates, unknown actions and out-of-range values', () => {
  const bad = ['3:warn,3:timeout:10m', '3:ban', '0:warn', '51:warn', '3:timeout:30s', '3:timeout:29d', '3:timeout:abc',
    '', ' ', '3:warn,', 'x:warn', '3', '3:warn:10m', '1:warn,2:warn,3:warn,4:warn,5:warn,6:warn,7:warn,8:warn,9:warn'];
  for (const text of bad) assert.equal(parseSteps(text).ok, false, JSON.stringify(text));
  assert.equal(parseSteps('50:warn').ok, true);
  assert.equal(parseSteps('3:timeout:1m').ok, true);
  assert.equal(parseSteps('3:timeout:28d').ok, true);
});

test('subcommands are the documented ones and descriptions fit', () => {
  assert.deepEqual(json.options.slice(0, 10).map((o) => o.name), [
    'enable', 'disable', 'status', 'rule', 'delete', 'steps', 'window', 'spam-check', 'spam-limit', 'nickname',
  ]);
  for (const s of json.options.slice(0, 10)) {
    assert.ok(s.description.length >= 1 && s.description.length <= 100, s.name);
    for (const o of s.options ?? []) assert.ok(o.description.length >= 1 && o.description.length <= 100, o.name);
  }
  assert.deepEqual(json.options.find((o) => o.name === 'rule').options[0].choices.map((c) => c.value), RULES);
});

test('the real module list registers /automod and /help still works', () => {
  const reg = collectModules(modules);
  assert.ok(reg.commands.has('automod'));
  assert.ok(buildHelp('en', new Map(), reg.commands, 'automod'));
});

let db;
before(async () => { db = await testDb(); });
beforeEach(async () => { await db.query('TRUNCATE guild_settings, scheduled_jobs'); });
after(async () => { await db.end(); });

function fake(sub, { strings = {}, ints = {} } = {}) {
  const calls = { reply: [] };
  return {
    calls,
    guildId: 'g1',
    inGuild: () => true,
    member: { permissions: { has: () => true }, guild: { id: 'g1' }, roles: { cache: { has: () => false } } },
    guild: { id: 'g1' },
    options: {
      getSubcommand: () => sub,
      getSubcommandGroup: () => null,
      getString: (n) => strings[n] ?? null,
      getInteger: (n) => ints[n] ?? null,
    },
    deferred: false,
    replied: false,
    reply: async (p) => { calls.reply.push(p); },
    editReply: async (p) => { calls.reply.push(p); },
  };
}
const run = (i) => cmd.execute(i, { db });
const text = (i) => i.calls.reply.at(-1).content;
const state = () => getFeature(db, 'g1', 'automod');
const saved = async () => readConfig((await state()).config);

test('non-managers are refused by the guard', async () => {
  const i = fake('rule', { strings: { rule: 'spam', state: 'on' } });
  i.member.permissions.has = () => false;
  await run(i);
  assert.equal(text(i), t('en', 'common.notAllowed'));
  assert.equal((await state()).config.rules, undefined);
});

test('enable and disable toggle the feature', async () => {
  await run(fake('enable'));
  assert.equal((await state()).enabled, true);
  await run(fake('disable'));
  assert.equal((await state()).enabled, false);
});

test('rule on enables a rule, delete and nickname toggle', async () => {
  const i = fake('rule', { strings: { rule: 'links', state: 'on' } });
  await run(i);
  assert.equal(i.calls.reply[0].allowedMentions.parse.length, 0);
  assert.equal((await saved()).rules.links.enabled, true);
  await run(fake('delete', { strings: { rule: 'links', state: 'off' } }));
  await run(fake('nickname', { strings: { state: 'on' } }));
  const c = await saved();
  assert.equal(c.rules.links.delete, false);
  assert.equal(c.rules.links.enabled, true);
  assert.equal(c.nickname.enabled, true);
  await run(fake('rule', { strings: { rule: 'links', state: 'off' } }));
  assert.equal((await saved()).rules.links.enabled, false);
});

test('steps saves sorted steps and rejects bad text', async () => {
  await run(fake('steps', { strings: { rule: 'words', steps: '8:timeout:1d,3:warn,5:timeout:10m' } }));
  assert.deepEqual((await saved()).rules.words.steps.map((s) => s.strikes), [3, 5, 8]);
  const i = fake('steps', { strings: { rule: 'words', steps: '3:ban' } });
  await run(i);
  assert.equal(text(i), t('en', 'automod.settings.bad_steps'));
  assert.deepEqual((await saved()).rules.words.steps.map((s) => s.strikes), [3, 5, 8]);
});

test('window rejects 5s, accepts 10s and 1d', async () => {
  for (const bad of ['5s', '2d', 'abc', '']) {
    const i = fake('window', { strings: { rule: 'spam', duration: bad } });
    await run(i);
    assert.equal(text(i), t('en', 'automod.settings.bad_window'));
  }
  assert.equal((await state()).config.rules, undefined);
  await run(fake('window', { strings: { rule: 'spam', duration: '10s' } }));
  assert.equal((await saved()).rules.spam.windowSeconds, 10);
  await run(fake('window', { strings: { rule: 'spam', duration: '1d' } }));
  assert.equal((await saved()).rules.spam.windowSeconds, 86400);
});

test('spam-check toggles a check and spam-limit sets its primary number within range', async () => {
  await run(fake('spam-check', { strings: { check: 'caps', state: 'off' } }));
  assert.equal((await saved()).rules.spam.caps.enabled, false);
  const limits = [['burst', 'messages', 7], ['identical', 'count', 6], ['caps', 'percent', 90], ['emoji', 'max', 20],
    ['mentions', 'max', 8], ['attachments', 'count', 9], ['linkRate', 'count', 3]];
  for (const [check, field, value] of limits) {
    await run(fake('spam-limit', { strings: { check }, ints: { value } }));
    assert.equal((await saved()).rules.spam[check][field], value, check);
  }
  const before = (await state()).config;
  const bad = [['burst', 1, 2, 50], ['burst', 51, 2, 50], ['caps', 5, 10, 100], ['emoji', 0, 1, 100],
    ['mentions', 101, 1, 100], ['linkRate', 1, 2, 50]];
  for (const [check, value, min, max] of bad) {
    const i = fake('spam-limit', { strings: { check }, ints: { value } });
    await run(i);
    assert.equal(text(i), t('en', 'automod.settings.bad_limit', { min, max }), `${check} ${value}`);
  }
  assert.deepEqual((await state()).config, before);
});

test('status shows each rule, the nickname setting and the feature state', async () => {
  await run(fake('enable'));
  await run(fake('rule', { strings: { rule: 'spam', state: 'on' } }));
  await run(fake('window', { strings: { rule: 'spam', duration: '5m' } }));
  const i = fake('status');
  await run(i);
  const out = text(i);
  assert.ok(out.includes(t('en', 'automod.settings.status_title')));
  assert.ok(out.includes(t('en', 'automod.settings.status_on')));
  for (const r of RULES) assert.ok(out.includes(t('en', `automod.rule.${r}`)), r);
  assert.ok(out.includes('5m'));
  assert.ok(out.includes(t('en', 'automod.settings.nickname')));
  assert.ok(out.includes(t('en', 'automod.settings.step_warn', { strikes: 3 })));
  assert.equal(i.calls.reply[0].allowedMentions.parse.length, 0);
});

test('extend, handlers and groupHandlers dispatch, and a missing handler gets a generic reply', async () => {
  const seen = [];
  const custom = createAutomodCommand({
    extend: (b) => b
      .addSubcommand((s) => s.setName('plain').setDescription('Plain'))
      .addSubcommand((s) => s.setName('orphan').setDescription('No handler'))
      .addSubcommandGroup((g) => g.setName('grp').setDescription('Group')
        .addSubcommand((s) => s.setName('inner').setDescription('Inner'))
        .addSubcommand((s) => s.setName('lost').setDescription('No handler'))),
    handlers: { plain: async (i, args) => { seen.push(['plain', Object.keys(args).sort()]); } },
    groupHandlers: { grp: { inner: async () => { seen.push(['inner']); } } },
  });
  const call = (sub, group = null) => {
    const i = fake(sub);
    i.options.getSubcommandGroup = () => group;
    return custom.execute(i, { db }).then(() => i);
  };
  await call('plain');
  await call('inner', 'grp');
  assert.deepEqual(seen, [['plain', ['config', 'ctx', 'enabled', 'lang', 'save']], ['inner']]);
  for (const [sub, group] of [['orphan', null], ['lost', 'grp']]) {
    const i = await call(sub, group);
    assert.equal(text(i), t('en', 'automod.error.generic'));
    assert.equal(i.calls.reply[0].allowedMentions.parse.length, 0);
  }
});

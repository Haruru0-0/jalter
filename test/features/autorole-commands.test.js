import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { commands, events } from '../../src/features/autorole/index.js';
import { events as assignEvents } from '../../src/features/autorole/assign.js';
import { getFeature, setFeature } from '../../src/db/settings.js';
import { queueRole } from '../../src/features/autorole/store.js';
import { t } from '../../src/i18n/index.js';
import { testDb } from '../helpers/db.js';

const json = commands[0].data.toJSON();
const SUB = 1;
const GROUP = 2;

// ---- structure (no Discord, no database) ----

test('the module exposes one autorole command and the assign events', () => {
  assert.equal(commands.length, 1);
  assert.equal(json.name, 'autorole');
  assert.equal(events, assignEvents);
});

test('top-level subcommands and groups are exactly the documented ones', () => {
  assert.deepEqual(json.options.map((o) => o.name), ['add', 'remove', 'show', 'reassign', 'blacklist', 'timed', 'disable']);
  const type = (name) => json.options.find((o) => o.name === name).type;
  assert.equal(type('blacklist'), GROUP);
  assert.equal(type('timed'), GROUP);
  for (const n of ['add', 'remove', 'show', 'reassign', 'disable']) assert.equal(type(n), SUB);
});

test('blacklist and timed groups hold add and remove', () => {
  for (const g of ['blacklist', 'timed']) {
    const group = json.options.find((o) => o.name === g);
    assert.deepEqual(group.options.map((o) => o.name), ['add', 'remove']);
  }
});

test('timed add takes delay then role, both required', () => {
  const add = json.options.find((o) => o.name === 'timed').options.find((o) => o.name === 'add');
  assert.deepEqual(add.options.map((o) => [o.name, o.required]), [['delay', true], ['role', true]]);
});

test('add has a required role and an optional target with humans and bots', () => {
  const add = json.options.find((o) => o.name === 'add');
  assert.deepEqual(add.options.map((o) => o.name), ['role', 'target']);
  assert.equal(add.options[0].required, true);
  assert.notEqual(add.options[1].required, true);
  assert.deepEqual(add.options[1].choices.map((c) => c.value), ['humans', 'bots']);
});

test('required options come before optional ones and all descriptions are 1-100 characters', () => {
  const walk = (node, path) => {
    assert.ok(node.description.length >= 1 && node.description.length <= 100, `${path} description`);
    let seenOptional = false;
    for (const o of node.options ?? []) {
      if ([SUB, GROUP].includes(o.type)) { walk(o, `${path} ${o.name}`); continue; }
      assert.ok(!(seenOptional && o.required), `${path} ${o.name} required after optional`);
      if (!o.required) seenOptional = true;
      assert.ok(o.description.length >= 1 && o.description.length <= 100, `${path} ${o.name} description`);
    }
  };
  walk(json, 'autorole');
});

// ---- handlers against the test database ----

let db;
before(async () => { db = await testDb(); });
beforeEach(async () => { await db.query('TRUNCATE guild_settings, pending_roles, remembered_roles'); });
after(async () => { await db.end(); });

const ROLES = {
  r1: { id: 'r1', managed: false, position: 1 },
  r2: { id: 'r2', managed: false, position: 2 },
  hi: { id: 'hi', managed: false, position: 50 },
  g1: { id: 'g1', managed: false, position: 0 },
  mg: { id: 'mg', managed: true, position: 1 },
};

function fake(path, { roles = {}, strings = {}, ids = ['r1', 'r2', 'hi'] } = {}) {
  const [group, sub] = path.includes(' ') ? path.split(' ') : [null, path];
  const calls = { reply: [] };
  return {
    calls,
    guildId: 'g1',
    inGuild: () => true,
    member: { permissions: { has: () => true }, guild: { id: 'g1' }, roles: { cache: { has: () => false } } },
    guild: {
      id: 'g1',
      roles: { cache: new Map(ids.map((id) => [id, ROLES[id]])) },
      members: { me: { roles: { highest: { position: 10 } } } },
    },
    options: {
      getSubcommandGroup: () => group,
      getSubcommand: () => sub,
      getRole: (name) => (roles[name] ? ROLES[roles[name]] : null),
      getString: (name) => strings[name] ?? null,
    },
    reply: async (p) => { calls.reply.push(p); },
  };
}

const run = (i) => commands[0].execute(i, { db });
const text = (i) => i.calls.reply.at(-1).content;
const state = () => getFeature(db, 'g1', 'autorole');

test('add stores the role, enables the feature and replies', async () => {
  const i = fake('add', { roles: { role: 'r1' } });
  await run(i);
  const { enabled, config } = await state();
  assert.equal(enabled, true);
  assert.deepEqual(config.roles, ['r1']);
  assert.equal(text(i), t('en', 'autorole.added', { role: '<@&r1>', target: t('en', 'autorole.targetHumans') }));
});

test('add with target bots stores a bot role; a role above the bot adds the warning', async () => {
  const i = fake('add', { roles: { role: 'hi' }, strings: { target: 'bots' } });
  await run(i);
  assert.deepEqual((await state()).config.botRoles, ['hi']);
  assert.ok(text(i).includes(t('en', 'autorole.tooHigh')));
});

test('add of the same role twice replies exists and keeps one copy', async () => {
  await run(fake('add', { roles: { role: 'r1' } }));
  const i = fake('add', { roles: { role: 'r1' } });
  await run(i);
  assert.equal(text(i), t('en', 'autorole.exists'));
  assert.deepEqual((await state()).config.roles, ['r1']);
});

test('add rejects @everyone and managed roles without saving', async () => {
  for (const id of ['g1', 'mg']) {
    const i = fake('add', { roles: { role: id }, ids: ['g1', 'mg'] });
    await run(i);
    assert.equal(text(i), t('en', 'autorole.badRole'));
  }
  assert.equal((await state()).enabled, false);
});

test('legacy keys are replaced on save and do not come back', async () => {
  await setFeature(db, 'g1', 'autorole', { enabled: true, config: { humanRoleId: 'r2', botRoleId: 'r1' } });
  await run(fake('add', { roles: { role: 'hi' } }));
  const { config } = await state();
  assert.deepEqual(config.roles, ['r2', 'hi']);
  assert.deepEqual(config.botRoles, ['r1']);
  await run(fake('remove', { roles: { role: 'r2' } }));
  assert.deepEqual((await state()).config.roles, ['hi']);
});

test('remove drops a listed role and says notListed for an unlisted one', async () => {
  await run(fake('add', { roles: { role: 'r1' } }));
  const gone = fake('remove', { roles: { role: 'r1' } });
  await run(gone);
  assert.equal(text(gone), t('en', 'autorole.removed', { role: '<@&r1>' }));
  assert.deepEqual((await state()).config.roles, []);
  const again = fake('remove', { roles: { role: 'r1' } });
  await run(again);
  assert.equal(text(again), t('en', 'autorole.notListed'));
});

test('timed add with a bad delay stores nothing', async () => {
  for (const delay of ['soon', '10s', '31d']) {
    const i = fake('timed add', { roles: { role: 'r1' }, strings: { delay } });
    await run(i);
    assert.match(text(i), /1m/);
    assert.match(text(i), /30d/);
  }
  assert.deepEqual((await state()).config, {});
});

test('timed add stores the delay; timed remove deletes it and cancels pending grants', async () => {
  const add = fake('timed add', { roles: { role: 'r1' }, strings: { delay: '1h30m' } });
  await run(add);
  assert.deepEqual((await state()).config.timed, [{ roleId: 'r1', seconds: 5400 }]);
  assert.ok(text(add).includes('1h30m'));
  await queueRole(db, 'g1', 'u1', 'r1', Date.now() + 60000);
  await run(fake('timed remove', { roles: { role: 'r1' } }));
  assert.deepEqual((await state()).config.timed, []);
  const { rows } = await db.query('SELECT * FROM pending_roles');
  assert.equal(rows.length, 0);
  const again = fake('timed remove', { roles: { role: 'r1' } });
  await run(again);
  assert.equal(text(again), t('en', 'autorole.notListed'));
});

test('blacklist add and remove', async () => {
  await run(fake('blacklist add', { roles: { role: 'r2' } }));
  assert.deepEqual((await state()).config.blacklist, ['r2']);
  const dup = fake('blacklist add', { roles: { role: 'r2' } });
  await run(dup);
  assert.equal(text(dup), t('en', 'autorole.exists'));
  await run(fake('blacklist remove', { roles: { role: 'r2' } }));
  assert.deepEqual((await state()).config.blacklist, []);
  const miss = fake('blacklist remove', { roles: { role: 'r2' } });
  await run(miss);
  assert.equal(text(miss), t('en', 'autorole.notListed'));
});

test('reassign saves the state', async () => {
  const on = fake('reassign', { strings: { state: 'on' } });
  await run(on);
  assert.equal((await state()).config.reassign, true);
  assert.equal(text(on), t('en', 'autorole.reassignOn'));
  await run(fake('reassign', { strings: { state: 'off' } }));
  assert.equal((await state()).config.reassign, false);
});

test('show with nothing set says so', async () => {
  const i = fake('show');
  await run(i);
  assert.equal(text(i), t('en', 'autorole.nothing'));
});

test('show lists roles without pinging and marks deleted and too-high roles', async () => {
  await setFeature(db, 'g1', 'autorole', {
    enabled: true,
    config: { roles: ['r1', 'hi', 'gone'], botRoles: ['r2'], timed: [{ roleId: 'r1', seconds: 5400 }],
      reassign: true, blacklist: ['r2'] },
  });
  const i = fake('show');
  await run(i);
  const reply = i.calls.reply.at(-1);
  assert.deepEqual(reply.allowedMentions, { parse: [] });
  assert.ok(reply.content.includes('<@&r1>'));
  assert.ok(reply.content.includes('1h30m'));
  assert.match(reply.content, new RegExp(`gone.*${t('en', 'autorole.deletedRole')}`));
  assert.match(reply.content, new RegExp(`<@&hi>.*${t('en', 'autorole.tooHighShort')}`));
  assert.ok(reply.content.length <= 2000);
});

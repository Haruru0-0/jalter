import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { commands, events, jobs } from '../../src/features/moderation/index.js';
import { events as actionEvents, jobs as actionJobs } from '../../src/features/moderation/actions.js';
import { collectModules } from '../../src/core/loader.js';
import { modules } from '../../src/modules.js';
import { getFeature, setFeature } from '../../src/db/settings.js';
import { buildHelp } from '../../src/features/help/index.js';
import { buildPanelEmbed } from '../../src/features/panel/index.js';
import { t } from '../../src/i18n/index.js';
import { formatDuration } from '../../src/core/duration.js';
import { FEATURES } from '../../src/core/registry.js';
import { testDb } from '../helpers/db.js';

const settings = commands[0];
const json = settings.data.toJSON();
const ALL = ['moderation', 'warn', 'warnings', 'timeout', 'untimeout', 'mute', 'unmute', 'kick', 'ban', 'unban', 'reason',
  'purge', 'slowmode', 'lock', 'unlock'];
const TOOLS = ['purge', 'slowmode', 'lock', 'unlock'];

// ---- structure ----

test('the module exposes the settings command first, every other moderation command, events and jobs', () => {
  assert.equal(commands[0].data.name, 'moderation');
  assert.equal(new Set(commands.map((c) => c.data.name)).size, commands.length);
  assert.deepEqual([...commands.map((c) => c.data.name)].sort(), [...ALL].sort());
  assert.equal(events, actionEvents);
  assert.equal(jobs, actionJobs);
});

test('settings subcommands are the documented ones', () => {
  assert.deepEqual(json.options.map((o) => o.name), [
    'enable', 'disable', 'status', 'reason-required', 'dm', 'timeout-default', 'ban-delete-days',
    'mute-role', 'permitted-role-add', 'permitted-role-remove',
  ]);
  const sub = (n) => json.options.find((o) => o.name === n);
  assert.deepEqual(sub('mute-role').options.map((o) => [o.name, !!o.required]), [['role', true], ['apply', false]]);
  assert.equal(sub('ban-delete-days').options[0].min_value, 0);
  assert.equal(sub('ban-delete-days').options[0].max_value, 7);
});

test('descriptions are 1-100 chars and required options come first', () => {
  assert.ok(json.description.length <= 100);
  for (const s of json.options) {
    assert.ok(s.description.length >= 1 && s.description.length <= 100, s.name);
    let optional = false;
    for (const o of s.options ?? []) {
      assert.ok(o.description.length >= 1 && o.description.length <= 100, `${s.name} ${o.name}`);
      assert.ok(!(optional && o.required), `${s.name} ${o.name}`);
      if (!o.required) optional = true;
    }
  }
});

test('collectModules over the real module list has no duplicate commands and registers events and jobs', () => {
  const reg = collectModules(modules);
  for (const n of ALL) assert.ok(reg.commands.has(n), n);
  for (const e of actionEvents) assert.ok(reg.events.includes(e));
  for (const type of Object.keys(actionJobs)) assert.equal(reg.jobs.get(type), actionJobs[type]);
});

test('help lists every moderation command and the panel no longer says coming soon', () => {
  const { commands: reg } = collectModules(modules);
  const help = buildHelp('en', new Map(), reg, 'moderation');
  assert.ok(help);
  for (const n of ALL) assert.ok(help.description.includes(`/${n}`), n);
  const { description } = buildPanelEmbed(new Map(), 'en');
  assert.match(description, /Moderation\*\*: Off \(\/moderation enable\)/);
});

test('every module has unique command names and component prefixes and purge registers its prefix', () => {
  const names = modules.flatMap((m) => (m.commands ?? []).map((c) => c.data.name));
  assert.equal(new Set(names).size, names.length);
  const prefixes = modules.flatMap((m) => (m.commands ?? []).filter((c) => c.components).map((c) => c.components.prefix));
  assert.equal(new Set(prefixes).size, prefixes.length);
  const reg = collectModules(modules);
  assert.equal(reg.components.get('purge')?.prefix, 'purge');
  assert.equal(typeof reg.components.get('purge').handle, 'function');
});

test('help lists the channel tool commands', () => {
  const { commands: reg } = collectModules(modules);
  const help = buildHelp('en', new Map(), reg, 'moderation');
  for (const n of TOOLS) assert.ok(help.description.includes(`/${n}`), n);
});

test('the registry moderation command list matches the module commands', () => {
  const entry = FEATURES.find((f) => f.key === 'moderation');
  assert.deepEqual([...entry.commands].sort(), commands.map((c) => c.data.name).sort());
});

// ---- handlers ----

let db;
before(async () => { db = await testDb(); });
beforeEach(async () => { await db.query('TRUNCATE guild_settings, scheduled_jobs'); });
after(async () => { await db.end(); });

const ROLES = {
  r1: { id: 'r1', managed: false, position: 1 },
  g1: { id: 'g1', managed: false, position: 0 },
  mg: { id: 'mg', managed: true, position: 1 },
  hi: { id: 'hi', managed: false, position: 50 },
};
for (let i = 0; i < 12; i += 1) ROLES[`p${i}`] = { id: `p${i}`, managed: false, position: 1 };

const channel = (id, { ok = true, fail = false } = {}) => ({
  id, manageable: ok, calls: [],
  permissionOverwrites: {
    edit: async function edit(role, perms) {
      if (fail) throw new Error('nope');
      this.calls.push([role.id ?? role, perms]);
    },
  },
});
// edit is called as a method of permissionOverwrites, so keep calls on the channel
const wire = (c) => { c.permissionOverwrites.calls = c.calls; return c; };

function fake(sub, { role, strings = {}, ints = {}, bools = {}, channels = [] } = {}) {
  const calls = { reply: [] };
  return {
    calls,
    guildId: 'g1',
    inGuild: () => true,
    member: { permissions: { has: () => true }, guild: { id: 'g1' }, roles: { cache: { has: () => false } } },
    guild: {
      id: 'g1',
      roles: { cache: new Map(Object.entries(ROLES)) },
      channels: { cache: new Map(channels.map((c) => [c.id, wire(c)])) },
      members: { me: { roles: { highest: { position: 10 } } } },
    },
    options: {
      getSubcommand: () => sub,
      getSubcommandGroup: () => null,
      getRole: () => (role ? ROLES[role] : null),
      getString: (n) => strings[n] ?? null,
      getInteger: (n) => ints[n] ?? null,
      getBoolean: (n) => bools[n] ?? null,
    },
    deferred: false,
    deferReply: async function deferReply() { this.deferred = true; },
    reply: async (p) => { calls.reply.push(p); },
    editReply: async (p) => { calls.reply.push(p); },
  };
}

const run = (i) => settings.execute(i, { db });
const text = (i) => i.calls.reply.at(-1).content;
const state = () => getFeature(db, 'g1', 'moderation');

test('enable and disable toggle the feature', async () => {
  await run(fake('enable'));
  assert.equal((await state()).enabled, true);
  await run(fake('disable'));
  assert.equal((await state()).enabled, false);
});

test('a non-manager is refused', async () => {
  const i = fake('dm', { strings: { state: 'off' } });
  i.member.permissions.has = () => false;
  await run(i);
  assert.equal(text(i), t('en', 'common.notAllowed'));
});

test('every setting writes the whole config and status shows it', async () => {
  await run(fake('reason-required', { strings: { state: 'off' } }));
  await run(fake('dm', { strings: { state: 'off' } }));
  await run(fake('timeout-default', { strings: { duration: '2h' } }));
  await run(fake('ban-delete-days', { ints: { days: 3 } }));
  await run(fake('permitted-role-add', { role: 'r1' }));
  const { config } = await state();
  assert.deepEqual(config, {
    reasonRequired: false, dm: false, timeoutDefaultSeconds: 7200, banDeleteDays: 3,
    muteRoleId: null, permittedRoles: ['r1'],
  });
  const i = fake('status');
  await run(i);
  const out = text(i);
  assert.ok(out.includes(formatDuration(7200)));
  assert.ok(out.includes('<@&r1>'));
  assert.ok(out.includes(t('en', 'moderation.settings.status_title')));
});

test('timeout-default rejects text that is invalid or out of range', async () => {
  for (const bad of ['abc', '10s', '40d', '']) {
    const i = fake('timeout-default', { strings: { duration: bad } });
    await run(i);
    assert.equal(text(i), t('en', 'moderation.settings.bad_timeout'));
  }
  assert.equal((await state()).config.timeoutDefaultSeconds, undefined);
});

test('mute-role refuses @everyone, managed roles and roles above the bot', async () => {
  for (const [role, key] of [['g1', 'moderation.settings.role_everyone'], ['mg', 'moderation.settings.role_managed'], ['hi', 'moderation.settings.role_too_high']]) {
    const i = fake('mute-role', { role });
    await run(i);
    assert.equal(text(i), t('en', key));
  }
  assert.equal((await state()).config.muteRoleId, undefined);
});

test('mute-role stores the role without touching channels unless apply is set', async () => {
  const ch = channel('c1');
  const i = fake('mute-role', { role: 'r1', channels: [ch] });
  await run(i);
  assert.equal((await state()).config.muteRoleId, 'r1');
  assert.equal(ch.calls.length, 0);
  assert.equal(text(i), t('en', 'moderation.settings.mute_role_set', { role: '<@&r1>' }));
});

test('mute-role with apply denies send, react and speak and reports successes and failures', async () => {
  const good = channel('c1');
  const bad = channel('c2', { fail: true });
  const skipped = channel('c3', { ok: false });
  const i = fake('mute-role', { role: 'r1', bools: { apply: true }, channels: [good, bad, skipped] });
  await run(i);
  assert.deepEqual(good.calls, [['r1', { SendMessages: false, AddReactions: false, Speak: false }]]);
  assert.equal(skipped.calls.length, 0);
  assert.equal(text(i), t('en', 'moderation.settings.mute_role_applied', { role: '<@&r1>', ok: 1, failed: 1 }));
});

test('permitted-role-add respects the limit, duplicates and remove', async () => {
  for (let n = 0; n < 10; n += 1) await run(fake('permitted-role-add', { role: `p${n}` }));
  let i = fake('permitted-role-add', { role: 'p10' });
  await run(i);
  assert.equal(text(i), t('en', 'moderation.settings.permitted_full', { limit: 10 }));
  i = fake('permitted-role-add', { role: 'p0' });
  await run(i);
  assert.equal(text(i), t('en', 'moderation.settings.permitted_exists'));
  i = fake('permitted-role-remove', { role: 'p0' });
  await run(i);
  assert.equal((await state()).config.permittedRoles.includes('p0'), false);
  i = fake('permitted-role-remove', { role: 'p0' });
  await run(i);
  assert.equal(text(i), t('en', 'moderation.settings.permitted_missing'));
});

test('writes keep the enabled flag', async () => {
  await setFeature(db, 'g1', 'moderation', { enabled: true });
  await run(fake('dm', { strings: { state: 'off' } }));
  assert.equal((await state()).enabled, true);
});

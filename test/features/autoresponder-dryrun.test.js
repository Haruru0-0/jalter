import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { testDb } from '../helpers/db.js';
import { t } from '../../src/i18n/index.js';
import { compileScript } from '../../src/features/autoresponder/script/compile.js';
import { describeRun } from '../../src/features/autoresponder/dryrun.js';

let db;
before(async () => { db = await testDb(); });
after(async () => { await db.end(); });

const ROLE = '111111111111111111';
const boom = (name) => () => { throw new Error(`side effect: ${name}`); };
const tt = (key, vars) => t('en', `autoresponder.test.${key}`, vars);

function world({ roles = [] } = {}) {
  const user = { id: 'staff', username: 'Sam', globalName: null, createdTimestamp: 1_600_000_000_000, displayAvatarURL: () => 'a.png', tag: 'Sam#0' };
  const guild = {
    id: 'g1', name: 'Srv', ownerId: 'owner', memberCount: 5, createdTimestamp: 1_500_000_000_000, iconURL: () => 'i.png',
    channels: { cache: new Map() }, roles: { cache: new Map([[ROLE, { id: ROLE, name: 'Vip' }]]) }, members: { me: { id: 'bot' } },
  };
  const member = {
    id: 'staff', displayName: 'Sam', user, guild, permissions: { has: () => true },
    roles: { cache: new Map(roles.map((r) => [r, {}])), add: boom('roles.add'), remove: boom('roles.remove') },
    send: boom('member.send'), setNickname: boom('setNickname'),
  };
  const channel = { id: 'c1', name: 'general', send: boom('channel.send'), reply: boom('channel.reply') };
  return { guild, member, channel, author: user };
}

async function run(script, opts) {
  const w = world(opts);
  const res = await compileScript(script, { db, guild: w.guild, writer: { id: 'owner' } });
  assert.ok(res.ok, JSON.stringify(res.errors));
  return describeRun('en', { compiled: res.compiled, text: 'hello', member: w.member, guild: w.guild, channel: w.channel, channelId: 'c1', author: w.author });
}

test('a cooldown prints its seconds and another failing gate prints gate.fail', async () => {
  const lines = await run('hi\n{cooldown:30}\n{requireuser:<@123456789012345678>}', {});
  assert.ok(lines.includes(tt('gate.cooldown', { seconds: 30 })));
  assert.ok(lines.includes(tt('gate.fail', { gate: 'requireuser' })));
});

test('every gate passing prints gate.pass lines, the text and the actions', async () => {
  const lines = await run('hi {user_name}\n{cooldown:30}\n{requireperm:Administrator}\n{react:👍}', {});
  const at = (s) => lines.indexOf(s);
  assert.ok(at(tt('gate.pass', { gate: 'requireperm' })) >= 0);
  assert.ok(at(tt('gate.cooldown', { seconds: 30 })) >= 0);
  assert.ok(at(tt('gates')) < at(tt('gate.pass', { gate: 'requireperm' })));
  assert.ok(at(tt('gate.pass', { gate: 'requireperm' })) < at(tt('text')));
  assert.equal(lines[at(tt('text')) + 1], 'hi Sam');
  assert.ok(at(tt('text')) < at(tt('actions')));
  assert.ok(lines.includes(tt('action.react', { detail: '👍' })));
});

test('a failing requirerole gives gate.fail and no text or actions', async () => {
  const lines = await run(`hi\n{requirerole:<@&${ROLE}>}\n{react:👍}`, {});
  assert.ok(lines.includes(tt('gate.fail', { gate: 'requirerole' })));
  assert.ok(!lines.includes(tt('text')));
  assert.ok(!lines.includes(tt('actions')));
  const ok = await run(`hi\n{requirerole:<@&${ROLE}>}`, { roles: [ROLE] });
  assert.ok(ok.includes(tt('gate.pass', { gate: 'requirerole' })));
});

test('no gates prints no gates header', async () => {
  const lines = await run('plain', {});
  assert.ok(!lines.includes(tt('gates')));
  assert.deepEqual(lines, [tt('text'), 'plain', tt('actions'), tt('action.reply', { detail: undefined })]);
});

test('describeRun never queries the database or writes to Discord', async () => {
  const calls = [];
  const orig = db.query;
  db.query = (...a) => { calls.push(a); return orig.apply(db, a); };
  try {
    await run('hi\n{addrole:<@&' + ROLE + '>}\n{dm}', {}).catch(() => {});
    calls.length = 0;
    const w = world();
    const compiled = { version: 1, template: [{ t: 'text', v: 'x' }], gates: [], actions: [{ fn: 'addrole', roleId: ROLE }, { fn: 'react', emoji: 'A' }], flags: { silent: false, dm: true, delete: true, embed: null, sendTo: null, deleteReplyAfter: 5 } };
    const lines = describeRun('en', { compiled, text: 'hello', member: w.member, guild: w.guild, channel: w.channel, channelId: 'c1', author: w.author });
    assert.ok(Array.isArray(lines));
    assert.equal(calls.length, 0);
  } finally { db.query = orig; }
});

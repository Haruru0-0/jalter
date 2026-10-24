import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { testDb } from '../helpers/db.js';
import { createEmbed } from '../../src/features/embeds/store.js';
import { compileScript, COMPILE_ERROR_CODES } from '../../src/features/autoresponder/script/compile.js';
import { PLACEHOLDER_NAMES, buildScriptVars } from '../../src/features/autoresponder/script/placeholders.js';
import { PARSE_ERROR_CODES } from '../../src/features/autoresponder/script/parse.js';

const G = '100000000000000000';
const id = (n) => `2${String(n).padStart(17, '0')}`;
const BOT_ID = id(900);

let db;
before(async () => {
  db = await testDb();
  await createEmbed(db, G, 'welcome');
});
after(async () => {
  await db.end();
});

const perm = (...names) => ({ has: (p) => names.includes(p) });
function role(n, name, position, extra = {}) {
  return { id: id(n), name, position, managed: false, permissions: perm(), ...extra };
}
const roles = [
  role(1, 'Mods', 5),
  role(2, 'Red', 2),
  role(3, 'Twin', 1),
  role(4, 'twin', 1),
  role(5, 'Staff', 3, { permissions: perm('Administrator') }),
  role(6, 'High', 20),
  role(7, 'Mid', 8),
  role(8, 'Blue', 1),
  role(9, 'Green', 1),
  role(10, 'Pink', 1),
];
const channels = [{ id: id(50), name: 'chat' }, { id: id(51), name: 'logs' }];
const asMap = (list) => new Map(list.map((x) => [x.id, x]));

function makeGuild() {
  return {
    id: G,
    ownerId: id(700),
    roles: { cache: asMap(roles) },
    channels: { cache: asMap(channels) },
    emojis: { cache: new Map([[id(80), { id: id(80), available: true }]]) },
    members: { me: { id: BOT_ID, roles: { highest: { position: 10 } } } },
  };
}
const writerOf = (position, userId = id(701)) => ({ id: userId, roles: { highest: { position } } });
const env = (over = {}) => ({ db, guild: makeGuild(), writer: writerOf(15), ...over });
const codes = (r) => r.errors.map((e) => e.code);

test('plain text compiles to a single text part', async () => {
  const r = await compileScript('hello there', env());
  assert.equal(r.ok, true);
  assert.deepEqual(r.compiled.template, [{ t: 'text', v: 'hello there' }]);
  assert.equal(r.compiled.version, 2);
  assert.deepEqual(r.compiled.flags, {
    silent: false, dm: false, delete: false, embed: null, sendTo: null, deleteReplyAfter: null,
  });
});

test('a placeholder becomes a ph part', async () => {
  const r = await compileScript('hi {user}!', env());
  assert.deepEqual(r.compiled.template, [
    { t: 'text', v: 'hi ' }, { t: 'ph', name: 'user' }, { t: 'text', v: '!' },
  ]);
});

test('unknown name is UNKNOWN_FUNCTION with position', async () => {
  const r = await compileScript('ab {nope}', env());
  assert.equal(r.ok, false);
  assert.deepEqual(r.errors, [{ code: 'UNKNOWN_FUNCTION', pos: 3, detail: 'nope' }]);
});

test('parser errors are passed through', async () => {
  const r = await compileScript('oops {user', env());
  assert.equal(r.ok, false);
  assert.equal(r.errors[0].code, 'UNBALANCED_BRACE');
});

test('missing and surplus arguments', async () => {
  assert.deepEqual(codes(await compileScript('{cooldown}', env())), ['MISSING_ARGUMENT']);
  assert.deepEqual(codes(await compileScript('{cooldown:}', env())), ['MISSING_ARGUMENT']);
  assert.deepEqual(codes(await compileScript('{cooldown:3|4}', env())), ['TOO_MANY_ARGUMENTS']);
  assert.deepEqual(codes(await compileScript('{dm:x}', env())), ['TOO_MANY_ARGUMENTS']);
});

test('cooldown gate and its range', async () => {
  const r = await compileScript('{cooldown:30}x', env());
  assert.deepEqual(r.compiled.gates, [{ fn: 'cooldown', seconds: 30 }]);
  assert.equal((await compileScript('{cooldown:604800}', env())).ok, true);
  assert.deepEqual(codes(await compileScript('{cooldown:0}', env())), ['COOLDOWN_RANGE']);
  assert.deepEqual(codes(await compileScript('{cooldown:604801}', env())), ['COOLDOWN_RANGE']);
  assert.deepEqual(codes(await compileScript('{cooldown:abc}', env())), ['BAD_ARGUMENT']);
});

test('duplicate singleton functions', async () => {
  for (const s of ['{cooldown:5}{cooldown:6}', '{embed}{embed}', '{sendto:chat}{sendto:logs}', '{dm}{dm}',
    '{delete}{delete}', '{delete_reply:5}{delete_reply:6}', '{silent}{silent}']) {
    assert.deepEqual(codes(await compileScript(s, env())), ['DUPLICATE_FUNCTION'], s);
  }
});

test('requirerole resolves by name, mention and id', async () => {
  const r = await compileScript(`{requirerole:mods}{requirerole:<@&${id(2)}>}{denyrole:${id(8)}}`, env());
  assert.deepEqual(r.compiled.gates, [
    { fn: 'requirerole', roleIds: [id(1)] },
    { fn: 'requirerole', roleIds: [id(2)] },
    { fn: 'denyrole', roleIds: [id(8)] },
  ]);
});

test('role lookup errors', async () => {
  assert.deepEqual(codes(await compileScript('{requirerole:Twin}', env())), ['ROLE_AMBIGUOUS']);
  assert.deepEqual(codes(await compileScript('{requirerole:Ghost}', env())), ['ROLE_NOT_FOUND']);
  assert.deepEqual(codes(await compileScript(`{requirerole:${id(399)}}`, env())), ['ROLE_NOT_FOUND']);
});

test('addrole safety checks', async () => {
  assert.deepEqual(codes(await compileScript('{addrole:Staff}', env())), ['ROLE_DANGEROUS']);
  assert.deepEqual(codes(await compileScript('{addrole:High}', env())), ['ROLE_ABOVE_BOT']);
  assert.deepEqual(codes(await compileScript('{addrole:Mid}', env({ writer: writerOf(8) }))), ['ROLE_ABOVE_YOU']);
  assert.equal((await compileScript('{addrole:Mid}', env({ writer: writerOf(9) }))).ok, true);
});

test('server owner may give a role below the bot', async () => {
  const g = makeGuild();
  const r = await compileScript('{addrole:Mid}', { db, guild: g, writer: writerOf(0, g.ownerId) });
  assert.equal(r.ok, true);
  assert.deepEqual(r.compiled.actions, [{ fn: 'addrole', roleId: id(7), raw: 'Mid', target: null }]);
});

test('removerole compiles; a typed target is refused', async () => {
  const r = await compileScript('{removerole:Red}', env());
  assert.deepEqual(r.compiled.actions, [{ fn: 'removerole', roleId: id(2), raw: 'Red', target: null }]);
  assert.deepEqual(codes(await compileScript('{addrole:Red|@sam}', env())), ['TARGET_NOT_CHECKED_USER']);
});

test('a fourth role or nick action is refused', async () => {
  const ok = await compileScript('{addrole:Red}{removerole:Blue}{setnick:Sam}', env());
  assert.equal(ok.ok, true);
  const r = await compileScript('{addrole:Red}{addrole:Blue}{addrole:Green}{addrole:Pink}', env());
  assert.deepEqual(codes(r), ['TOO_MANY_ROLE_ACTIONS']);
  assert.equal(r.errors[0].pos, '{addrole:Red}{addrole:Blue}{addrole:Green}'.length);
  const n = await compileScript('{addrole:Red}{addrole:Blue}{addrole:Green}{setnick:x}', env());
  assert.deepEqual(codes(n), ['TOO_MANY_ROLE_ACTIONS']);
});

test('embed forms', async () => {
  assert.deepEqual((await compileScript('{embed:#ec948a}', env())).compiled.flags.embed,
    { kind: 'plain', color: 0xec948a });
  assert.deepEqual((await compileScript('{embed}', env())).compiled.flags.embed, { kind: 'plain', color: null });
  assert.deepEqual((await compileScript('{embed:Welcome}', env())).compiled.flags.embed,
    { kind: 'named', name: 'welcome' });
  assert.deepEqual(codes(await compileScript('{embed:missing}', env())), ['EMBED_NOT_FOUND']);
  assert.deepEqual(codes(await compileScript('{embed:#zzz}', env())), ['BAD_ARGUMENT']);
});

test('reactions: valid, too many, foreign emoji', async () => {
  const r = await compileScript(`{react:🔥}{reactreply:<:ok:${id(80)}>}`, env());
  assert.deepEqual(r.compiled.actions, [
    { fn: 'react', emoji: '🔥' }, { fn: 'reactreply', emoji: `<:ok:${id(80)}>` },
  ]);
  assert.deepEqual(codes(await compileScript('{react:🔥}'.repeat(6), env())), ['TOO_MANY_REACTIONS']);
  assert.equal((await compileScript('{react:🔥}'.repeat(5), env())).ok, true);
  assert.deepEqual(codes(await compileScript(`{react:<:far:${id(81)}>}`, env())), ['INVALID_EMOJI']);
  assert.deepEqual(codes(await compileScript('{react:hello}', env())), ['INVALID_EMOJI']);
});

test('setnick length', async () => {
  assert.equal((await compileScript(`{setnick:${'a'.repeat(32)}}`, env())).ok, true);
  assert.deepEqual(codes(await compileScript(`{setnick:${'a'.repeat(33)}}`, env())), ['NICK_TOO_LONG']);
});

test('permissions are case-insensitive and stored canonically', async () => {
  const r = await compileScript('{requireperm:managemessages}{denyperm:BanMembers}', env());
  assert.deepEqual(r.compiled.gates, [
    { fn: 'requireperm', perms: ['ManageMessages'] }, { fn: 'denyperm', perms: ['BanMembers'] },
  ]);
  assert.deepEqual(codes(await compileScript('{requireperm:Nope}', env())), ['INVALID_PERMISSION']);
});

test('channels by mention, id and name', async () => {
  for (const arg of [`<#${id(50)}>`, id(50), '#chat', 'chat']) {
    const r = await compileScript(`{sendto:${arg}}`, env());
    assert.equal(r.compiled.flags.sendTo, id(50), arg);
  }
  assert.deepEqual(codes(await compileScript('{sendto:nowhere}', env())), ['CHANNEL_NOT_FOUND']);
  const g = await compileScript(`{requirechannel:chat}{denychannel:<#${id(51)}>}`, env());
  assert.deepEqual(g.compiled.gates, [
    { fn: 'requirechannel', channelIds: [id(50)] }, { fn: 'denychannel', channelIds: [id(51)] },
  ]);
});

test('requireuser', async () => {
  const r = await compileScript(`{requireuser:<@${id(600)}>}{requireuser:${id(601)}}`, env());
  assert.deepEqual(r.compiled.gates, [
    { fn: 'requireuser', userIds: [id(600)] }, { fn: 'requireuser', userIds: [id(601)] },
  ]);
  assert.deepEqual(codes(await compileScript('{requireuser:abc}', env())), ['INVALID_USER']);
});

test('flags: dm, delete, silent, delete_reply', async () => {
  const r = await compileScript('{dm}{delete}{silent}{delete_reply:10}', env());
  assert.deepEqual(r.compiled.flags, {
    silent: true, dm: true, delete: true, embed: null, sendTo: null, deleteReplyAfter: 10,
  });
  assert.deepEqual(codes(await compileScript('{delete_reply:0}', env())), ['DELETE_REPLY_RANGE']);
  assert.deepEqual(codes(await compileScript('{delete_reply:301}', env())), ['DELETE_REPLY_RANGE']);
  assert.equal((await compileScript('{delete_reply:300}', env())).compiled.flags.deleteReplyAfter, 300);
  assert.deepEqual(codes(await compileScript('{delete_reply:x}', env())), ['BAD_ARGUMENT']);
});

test('script length limit', async () => {
  assert.equal((await compileScript('a'.repeat(4000), env())).ok, true);
  const r = await compileScript('a'.repeat(4001), env());
  assert.deepEqual(codes(r), ['SCRIPT_TOO_LONG']);
});

test('several independent errors are all reported', async () => {
  const r = await compileScript('{nope}{cooldown:abc}{requirerole:Ghost}{sendto:zzz}', env());
  assert.deepEqual(codes(r), ['UNKNOWN_FUNCTION', 'BAD_ARGUMENT', 'ROLE_NOT_FOUND', 'CHANNEL_NOT_FOUND']);
});

test('compiled output is JSON-safe and every ph is a known name', async () => {
  const src = `{user} {server_name}{newline}{cooldown:9}{requirerole:Mods}{addrole:Red}{react:🔥}{setnick:Sam}`
    + `{embed:#ec948a}{sendto:chat}{dm}{delete}{silent}{delete_reply:4}{requireperm:ManageMessages}`
    + `{requirechannel:chat}{requireuser:${id(600)}}`;
  const r = await compileScript(src, env());
  assert.equal(r.ok, true);
  assert.deepEqual(JSON.parse(JSON.stringify(r.compiled)), r.compiled);
  for (const p of r.compiled.template) if (p.t === 'ph') assert.ok(PLACEHOLDER_NAMES.has(p.name));
});

test('COMPILE_ERROR_CODES lists every code including the parser ones', () => {
  for (const c of PARSE_ERROR_CODES) assert.ok(COMPILE_ERROR_CODES.includes(c));
  for (const c of ['UNKNOWN_FUNCTION', 'TOO_MANY_EMBEDS', 'SCRIPT_TOO_LONG', 'ROLE_ABOVE_YOU', 'INVALID_EMOJI']) {
    assert.ok(COMPILE_ERROR_CODES.includes(c));
  }
  assert.equal(new Set(COMPILE_ERROR_CODES).size, COMPILE_ERROR_CODES.length);
});

test('PLACEHOLDER_NAMES holds the shared and extra names', () => {
  for (const n of ['user', 'user_name', 'server_membercount', 'date', 'newline', 'count', 'user_id', 'user_nick',
    'user_joindate', 'user_createdate', 'user_displaycolor', 'user_boostsince', 'server_id', 'server_boostlevel',
    'channel', 'channel_name', 'message_id', 'message_content', 'message_link']) {
    assert.ok(PLACEHOLDER_NAMES.has(n), n);
  }
});

test('buildScriptVars covers every placeholder name', () => {
  const user = {
    id: id(600), username: 'sam', globalName: 'Sam', tag: 'sam', createdTimestamp: 1_700_000_000_000,
    displayAvatarURL: () => 'http://a',
  };
  const guild = {
    id: G, name: 'Srv', ownerId: id(700), createdTimestamp: 1_600_000_000_000, memberCount: 3,
    premiumSubscriptionCount: 1, premiumTier: 2, iconURL: () => null,
  };
  const member = {
    displayName: 'Sam', nickname: 'Samy', joinedTimestamp: 1_710_000_000_000, premiumSinceTimestamp: null,
    displayHexColor: '#ff0000',
  };
  const message = { id: id(5), content: 'yo', url: 'http://m', author: user, channel: { id: id(50), name: 'chat' } };
  const vars = buildScriptVars({ message, member, guild });
  for (const n of PLACEHOLDER_NAMES) assert.ok(Object.hasOwn(vars, n), n);
  assert.equal(vars.user_joindate, '<t:1710000000:D>');
  assert.equal(vars.user_boostsince, '');
  assert.equal(vars.user_createdate, '<t:1700000000:D>');
  const boosted = buildScriptVars({
    message, member: { ...member, premiumSinceTimestamp: 1_720_000_000_000 }, guild,
  });
  assert.equal(boosted.user_boostsince, '<t:1720000000:D>');
  assert.equal(vars.channel, `<#${id(50)}>`);
  assert.equal(vars.user_nick, 'Samy');
  assert.equal(vars.server_boostlevel, 2);
});

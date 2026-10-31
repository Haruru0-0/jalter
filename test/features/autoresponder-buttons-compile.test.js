import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { testDb } from '../helpers/db.js';
import { resetDb } from '../../src/db/index.js';
import { t } from '../../src/i18n/index.js';
import { createButton } from '../../src/features/autoresponder/buttons/store.js';
import { createEmbed } from '../../src/features/embeds/store.js';
import { compileScript, COMPILE_ERROR_CODES } from '../../src/features/autoresponder/script/compile.js';

const G = '100000000000000000';
const id = (n) => `2${String(n).padStart(17, '0')}`;

let db;
before(async () => { db = await testDb(); });
beforeEach(async () => {
  await resetDb(db);
  for (const name of ['rules', 'x', 'a', 'b']) {
    await createButton(db, { guildId: G, name, label: name, style: 'grey', script: 'hi', compiled: {}, createdBy: id(1) });
  }
});
after(async () => { await db.end(); });

const guild = () => ({
  id: G,
  ownerId: id(700),
  roles: { cache: new Map() },
  channels: { cache: new Map([[id(50), { id: id(50), name: 'chat' }]]) },
  emojis: { cache: new Map() },
  members: { me: { id: id(900), roles: { highest: { position: 10 } } } },
});
const comp = (src, over = {}) => compileScript(src, { db, guild: guild(), writer: { id: id(701), roles: { highest: { position: 15 } } }, ...over });
const codes = (r) => r.errors.map((e) => e.code);

test('a stored button compiles into buttons', async () => {
  const r = await comp('Hello {addbutton:rules}');
  assert.equal(r.ok, true);
  assert.deepEqual(r.compiled.buttons, [{ kind: 'stored', name: 'rules' }]);
});

test('scripts without buttons have no buttons key', async () => {
  const r = await comp('Hello {user}');
  assert.equal(r.ok, true);
  assert.equal(Object.hasOwn(r.compiled, 'buttons'), false);
  assert.equal(r.compiled.version, 2);
});

test('unknown stored name is BUTTON_NOT_FOUND, invalid name text is BUTTON_NAME_INVALID', async () => {
  assert.deepEqual(codes(await comp('Hi {addbutton:nope}')), ['BUTTON_NOT_FOUND']);
  assert.deepEqual(codes(await comp('Hi {addbutton:Bad Name}')), ['BUTTON_NAME_INVALID']);
  assert.deepEqual(codes(await comp('Hi {addbutton:}')), ['MISSING_ARGUMENT']);
});

test('order is preserved with link buttons mixed in; repeated use is allowed', async () => {
  const r = await comp('Hi {addbutton:a}{addlinkbutton:Docs|https://example.com/x}{addbutton:b}{addbutton:a}');
  assert.equal(r.ok, true);
  assert.deepEqual(r.compiled.buttons, [
    { kind: 'stored', name: 'a' },
    { kind: 'link', label: 'Docs', url: 'https://example.com/x', emoji: null },
    { kind: 'stored', name: 'b' },
    { kind: 'stored', name: 'a' },
  ]);
});

test('25 buttons are accepted, 26 are TOO_MANY_BUTTONS (both kinds counted together)', async () => {
  const ok = await comp(`Hi ${'{addbutton:a}'.repeat(20)}${'{addlinkbutton:L|https://e.com}'.repeat(5)}`);
  assert.equal(ok.ok, true);
  assert.equal(ok.compiled.buttons.length, 25);
  const bad = await comp(`Hi ${'{addbutton:a}'.repeat(20)}${'{addlinkbutton:L|https://e.com}'.repeat(6)}`);
  assert.equal(bad.ok, false);
  assert.deepEqual(codes(bad), ['TOO_MANY_BUTTONS']);
});

test('link buttons: label, url and emoji', async () => {
  const r = await comp('Hi {addlinkbutton:Docs|https://example.com}{addlinkbutton:Go|http://a.b/c?d=1|\u{1F44D}}');
  assert.equal(r.ok, true);
  assert.deepEqual(r.compiled.buttons[0], { kind: 'link', label: 'Docs', url: 'https://example.com/', emoji: null });
  assert.equal(r.compiled.buttons[1].kind, 'link');
  assert.equal(r.compiled.buttons[1].label, 'Go');
  assert.equal(r.compiled.buttons[1].url, 'http://a.b/c?d=1');
  assert.ok(r.compiled.buttons[1].emoji);
});

test('link url must be http(s), a real URL, at most 512 characters', async () => {
  for (const url of ['ftp://x.com', 'javascript:alert(1)', 'data:text/plain,hi', 'https://', 'not a url', `https://e.com/${'a'.repeat(500)}`]) {
    const r = await comp(`Hi {addlinkbutton:L|${url}}`);
    assert.equal(r.ok, false, url);
    assert.deepEqual(codes(r), ['LINK_URL_INVALID'], url);
  }
  const r = await comp(`Hi {addlinkbutton:L|https://e.com/${'a'.repeat(512 - 14)}}`);
  assert.equal(r.ok, true);
});

test('link label must be 1 to 80 characters', async () => {
  assert.equal((await comp(`Hi {addlinkbutton:${'a'.repeat(80)}|https://e.com}`)).ok, true);
  const long = await comp(`Hi {addlinkbutton:${'a'.repeat(81)}|https://e.com}`);
  assert.equal(long.ok, false);
  const empty = await comp('Hi {addlinkbutton:|https://e.com}');
  assert.equal(empty.ok, false);
  assert.equal((await comp('Hi {addlinkbutton:Only}')).ok, false);
  assert.equal((await comp('Hi {addlinkbutton:a|https://e.com|\u{1F44D}|x}')).ok, false);
});

test('a bad emoji is INVALID_EMOJI', async () => {
  assert.deepEqual(codes(await comp('Hi {addlinkbutton:L|https://e.com|notanemoji}')), ['INVALID_EMOJI']);
});

test('an escaped bracket in label and url comes back as a plain bracket', async () => {
  const r = await comp('Hi {addlinkbutton:A \\[range] b|https://e.com/\\[range]}');
  assert.equal(r.ok, true);
  assert.equal(r.compiled.buttons[0].label, 'A [range] b');
  assert.equal(r.compiled.buttons[0].url, 'https://e.com/[range]');
});

test('{dm} with any button is BUTTONS_NEED_CHANNEL, in either order', async () => {
  assert.ok(codes(await comp('Hi {dm}{addbutton:a}')).includes('BUTTONS_NEED_CHANNEL'));
  assert.ok(codes(await comp('Hi {addbutton:a}{dm}')).includes('BUTTONS_NEED_CHANNEL'));
  assert.ok(codes(await comp('Hi {addlinkbutton:L|https://e.com}{dm}')).includes('BUTTONS_NEED_CHANNEL'));
});

test('buttons need text or a named embed', async () => {
  assert.deepEqual(codes(await comp('{addbutton:x}')), ['BUTTONS_NEED_TEXT']);
  assert.deepEqual(codes(await comp('  {addbutton:x}  ')), ['BUTTONS_NEED_TEXT']);
  assert.deepEqual(codes(await comp('{addlinkbutton:L|https://e.com}')), ['BUTTONS_NEED_TEXT']);
  assert.equal((await comp('Hello {addbutton:x}')).ok, true);
  assert.equal((await comp('{addbutton:x}Hello')).ok, true);
  assert.deepEqual(codes(await comp('{embed}{addbutton:x}')), ['BUTTONS_NEED_TEXT']);
  assert.deepEqual(codes(await comp('{addbutton:x}{embed}')), ['BUTTONS_NEED_TEXT']);
  assert.equal((await comp('{user}{addbutton:x}')).ok, true);
  assert.equal((await comp('{range:1-6}[range]{addbutton:x}')).ok, true);
  assert.equal((await comp('{requirearg:1}[$1]{addbutton:x}')).ok, true);
});

test('{sendto} with a button compiles', async () => {
  const r = await comp('Hi {sendto:#chat}{addbutton:x}');
  assert.equal(r.ok, true);
  assert.equal(r.compiled.flags.sendTo, id(50));
});

test('compiled output round trips through JSON', async () => {
  const r = await comp('Hi {addbutton:a}{addlinkbutton:L|https://e.com|\u{1F44D}}');
  assert.deepEqual(JSON.parse(JSON.stringify(r.compiled)), r.compiled);
});

test('buttonScript: rand tokens are live without their function', async () => {
  const r = await comp('roll [range] [choice2] [lockedchoice]', { buttonScript: true });
  assert.equal(r.ok, true);
  assert.deepEqual(r.compiled.template.filter((p) => p.t === 'rand'), [
    { t: 'rand', kind: 'range', n: 1 }, { t: 'rand', kind: 'choice', n: 2 }, { t: 'rand', kind: 'lockedchoice', n: 1 },
  ]);
  const plain = await comp('roll [range]');
  assert.deepEqual(plain.compiled.template, [{ t: 'text', v: 'roll [range]' }]);
});

test('buttonScript: match mode is ignored and requirearg works', async () => {
  const r = await comp('Hi [$1]{requirearg:1|user}', { buttonScript: true, matchMode: 'exact' });
  assert.equal(r.ok, true);
  assert.deepEqual(r.warnings, []);
  const rule = await comp('Hi {requirearg:1|user}', { matchMode: 'exact' });
  assert.deepEqual(codes(rule), ['NO_ARGUMENTS_IN_MODE']);
});

test('buttonScript: addbutton is allowed', async () => {
  const r = await comp('Again {addbutton:x}', { buttonScript: true });
  assert.equal(r.ok, true);
  assert.deepEqual(r.compiled.buttons, [{ kind: 'stored', name: 'x' }]);
});

test('new codes are listed and translated in every language', () => {
  for (const c of ['BUTTON_NOT_FOUND', 'LINK_URL_INVALID', 'TOO_MANY_BUTTONS', 'BUTTONS_NEED_CHANNEL', 'BUTTONS_NEED_TEXT', 'BUTTON_NAME_INVALID']) {
    assert.ok(COMPILE_ERROR_CODES.includes(c), c);
    for (const lang of ['en', 'fr', 'ar']) assert.notEqual(t(lang, `autoresponder.error.${c}`, { detail: '' }), `autoresponder.error.${c}`, `${lang} ${c}`);
  }
});

test('a whitespace-only link button label is rejected as BAD_ARGUMENT', async () => {
  const r = await comp('Hi {addlinkbutton:   |https://example.com}');
  assert.equal(r.ok, false);
  assert.ok(codes(r).includes('BAD_ARGUMENT'));
});

// ---------- stage 3 follow-up: a plain embed is not text; attached role buttons are checked against the saver ----------

test('a plain {embed} does not count as text for buttons; a named embed does', async () => {
  assert.deepEqual(codes(await comp('{addlinkbutton:x|https://e.com}{embed}')), ['BUTTONS_NEED_TEXT']);
  assert.deepEqual(codes(await comp('{embed:#ff0000}{addbutton:x}')), ['BUTTONS_NEED_TEXT']);
  assert.equal((await comp('Hello {embed}{addbutton:x}')).ok, true);
  await createEmbed(db, G, 'card');
  assert.equal((await comp('{embed:card}{addbutton:x}')).ok, true);
});

const MOD = id(60);
const roleGuild = (roles) => ({ ...guild(), roles: { cache: new Map(roles.map((r) => [r.id, r])) } });
const role = (over = {}) => ({ id: MOD, name: 'Mod', position: 5, managed: false, permissions: { has: () => false }, ...over });
const roleButton = async (name, actions) => createButton(db, { guildId: G, name, label: name, style: 'grey', script: 'x', compiled: { version: 2, template: [{ t: 'text', v: 'x' }], gates: [], actions, flags: {} }, createdBy: id(1) });
const writerAt = (position, wid = id(701)) => ({ id: wid, roles: { highest: { position } } });

test('attaching a button whose role the saver cannot give is ROLE_ABOVE_YOU with the button name', async () => {
  await roleButton('modrole', [{ fn: 'addrole', roleId: MOD, raw: 'Mod', target: null }]);
  await roleButton('unmod', [{ fn: 'removerole', roleId: MOD, raw: 'Mod', target: null }]);
  const g = roleGuild([role()]);
  for (const src of ['Hi {addbutton:modrole}', 'Hi {addbutton:unmod}']) {
    const r = await comp(src, { guild: g, writer: writerAt(3) });
    assert.equal(r.ok, false, src);
    assert.deepEqual(r.errors.map((e) => [e.code, e.detail]), [['ROLE_ABOVE_YOU', src.slice(14, -1)]], src);
  }
  const inButton = await comp('Again {addbutton:modrole}', { guild: g, writer: writerAt(3), buttonScript: true });
  assert.deepEqual(codes(inButton), ['ROLE_ABOVE_YOU']);
});

test('a saver who can give the role, the guild owner, and a button with no role actions all compile', async () => {
  await roleButton('modrole', [{ fn: 'addrole', roleId: MOD, raw: 'Mod', target: null }]);
  const g = roleGuild([role()]);
  assert.equal((await comp('Hi {addbutton:modrole}', { guild: g, writer: writerAt(6) })).ok, true);
  assert.equal((await comp('Hi {addbutton:modrole}', { guild: g, writer: writerAt(1, id(700)) })).ok, true);
  assert.equal((await comp('Hi {addbutton:modrole}', { guild: g, writer: writerAt(6), buttonScript: true })).ok, true);
  assert.equal((await comp('Hi {addbutton:x}', { guild: g, writer: writerAt(0) })).ok, true);
});

test('an attached button whose role is gone is skipped; a dangerous or above-bot role is refused', async () => {
  await roleButton('modrole', [{ fn: 'addrole', roleId: MOD, raw: 'Mod', target: null }]);
  assert.equal((await comp('Hi {addbutton:modrole}', { guild: roleGuild([]), writer: writerAt(0) })).ok, true);
  const danger = roleGuild([role({ permissions: { has: (p) => p === 'ManageGuild' } })]);
  assert.deepEqual(codes(await comp('Hi {addbutton:modrole}', { guild: danger, writer: writerAt(15) })), ['ROLE_DANGEROUS']);
  const high = roleGuild([role({ position: 12 })]);
  assert.deepEqual(codes(await comp('Hi {addbutton:modrole}', { guild: high, writer: writerAt(15) })), ['ROLE_ABOVE_BOT']);
});

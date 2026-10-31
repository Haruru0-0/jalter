import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ButtonStyle } from 'discord.js';
import {
  STYLES, LIMITATIONS, checkButtonInput, buttonId, parseButtonId, buildRows, pressDecision, createPressThrottle,
} from '../../src/features/autoresponder/buttons/model.js';

const ok = { name: 'rules', label: 'Rules', emoji: null, style: 'blue', limitations: 'none' };

test('styles and limitations constants', () => {
  assert.deepEqual(STYLES, {
    blue: ButtonStyle.Primary, green: ButtonStyle.Success, grey: ButtonStyle.Secondary, red: ButtonStyle.Danger,
  });
  assert.deepEqual(LIMITATIONS, ['none', 'limited', 'strict']);
});

test('checkButtonInput: valid and each code', () => {
  assert.deepEqual(checkButtonInput(ok), { ok: true });
  for (const name of ['', 'Rules', 'a b', 'x'.repeat(17), undefined]) {
    assert.deepEqual(checkButtonInput({ ...ok, name }), { ok: false, code: 'BUTTON_NAME_INVALID' }, String(name));
  }
  for (const label of ['', '   ', 'x'.repeat(81), undefined]) {
    assert.deepEqual(checkButtonInput({ ...ok, label }), { ok: false, code: 'BUTTON_LABEL_INVALID' }, String(label));
  }
  assert.deepEqual(checkButtonInput({ ...ok, style: 'pink' }), { ok: false, code: 'BUTTON_STYLE_INVALID' });
  assert.deepEqual(checkButtonInput({ ...ok, limitations: 'weird' }), { ok: false, code: 'BUTTON_LIMITATION_INVALID' });
  assert.deepEqual(checkButtonInput({ ...ok, label: 'x'.repeat(80) }), { ok: true });
  assert.deepEqual(checkButtonInput({ ...ok, name: 'x'.repeat(16) }), { ok: true });
});

test('buttonId round trip and garbage', () => {
  const id = buttonId('123456789012345678', 7);
  assert.equal(id, 'autoresponder:p:123456789012345678:7');
  assert.deepEqual(parseButtonId(id), { messageId: '123456789012345678', index: 7 });
  for (const bad of [null, undefined, '', 'autoresponder:p:1', 'autoresponder:p:abc:1', 'autoresponder:p:1:x',
    'autoresponder:p:1:-1', 'reactionroles:btn:1:2', 'autoresponder:p:1:2:3', 42]) {
    assert.equal(parseButtonId(bad), null, String(bad));
  }
});

const stored = (i, extra = {}) => ({ kind: 'stored', name: `b${i}`, label: `Label ${i}`, emoji: null, style: 'green', ...extra });
const json = (rows) => rows.map((r) => r.toJSON());
const parseEmoji = (e) => e;
const fresh = { locked: false, pressed: [] };

test('buildRows: 5 per row, 25 buttons give 5 rows', () => {
  const rows = buildRows('1', Array.from({ length: 25 }, (_, i) => stored(i)), fresh, parseEmoji);
  assert.equal(rows.length, 5);
  for (const r of json(rows)) assert.equal(r.components.length, 5);
  assert.equal(buildRows('1', Array.from({ length: 7 }, (_, i) => stored(i)), fresh, parseEmoji).length, 2);
  assert.equal(buildRows('1', [], fresh, parseEmoji).length, 0);
});

test('buildRows: never more than 25 buttons', () => {
  const rows = buildRows('1', Array.from({ length: 40 }, (_, i) => stored(i)), fresh, parseEmoji);
  assert.equal(rows.length, 5);
});

test('buildRows: disabled when locked or pressed, link never', () => {
  const entries = [stored(0), stored(1), { kind: 'link', label: 'Docs', url: 'https://example.com', emoji: null }];
  const flat = (state) => json(buildRows('1', entries, state, parseEmoji)).flatMap((r) => r.components);
  let c = flat({ locked: false, pressed: [1] });
  assert.deepEqual(c.map((x) => !!x.disabled), [false, true, false]);
  c = flat({ locked: true, pressed: [] });
  assert.deepEqual(c.map((x) => !!x.disabled), [true, true, false]);
  assert.equal(c[2].url, 'https://example.com');
  assert.equal(c[2].custom_id, undefined);
});

test('buildRows: style map, label cut, emoji, ids within 100 chars', () => {
  const entries = [
    stored(0, { style: 'red', label: 'x'.repeat(200), emoji: '🔥' }),
    stored(1, { style: 'blue' }), stored(2, { style: 'grey' }),
    { kind: 'link', label: 'y'.repeat(200), url: 'https://example.com', emoji: '👍' },
  ];
  const c = json(buildRows('123456789012345678', entries, fresh, parseEmoji)).flatMap((r) => r.components);
  assert.equal(c[0].style, ButtonStyle.Danger);
  assert.equal(c[1].style, ButtonStyle.Primary);
  assert.equal(c[2].style, ButtonStyle.Secondary);
  assert.equal(c[0].label.length, 80);
  assert.equal(c[3].label.length, 80);
  assert.equal(c[3].style, ButtonStyle.Link);
  assert.ok(c[0].emoji);
  for (const x of c) if (x.custom_id) assert.ok(x.custom_id.length <= 100);
});

test('buildRows: custom ids carry the message id and the index', () => {
  const c = json(buildRows('999', [stored(0), stored(1)], fresh, parseEmoji)).flatMap((r) => r.components);
  assert.deepEqual(c.map((x) => x.custom_id), ['autoresponder:p:999:0', 'autoresponder:p:999:1']);
});

test('buildRows: the injected emoji parser is used', () => {
  const c = json(buildRows('1', [stored(0, { emoji: 'raw' })], fresh, () => '😀')).flatMap((r) => r.components);
  assert.equal(c[0].emoji.name, '😀');
});

test('pressDecision: invoker_only', () => {
  const record = { messageId: 'm', invokerId: 'u1', expiresAt: 20_000 };
  const t = createPressThrottle(3000);
  assert.deepEqual(pressDecision({ record, button: { invokerOnly: true }, presserId: 'u2', now: 1000, throttle: t }),
    { ok: false, reason: 'invoker' });
  assert.deepEqual(pressDecision({ record, button: { invokerOnly: true }, presserId: 'u1', now: 1000, throttle: t }), { ok: true });
  assert.deepEqual(pressDecision({ record, button: { invokerOnly: false }, presserId: 'u3', now: 1000, throttle: t }), { ok: true });
});

test('pressDecision: expired record', () => {
  const t = createPressThrottle(3000);
  assert.deepEqual(pressDecision({ record: { messageId: 'm', invokerId: 'u1', expiresAt: 500 }, button: {}, presserId: 'u1', now: 1000, throttle: t }),
    { ok: false, reason: 'expired' });
});

test('pressDecision: throttle per presser per message', () => {
  const t = createPressThrottle(3000);
  const rec = (messageId) => ({ messageId, invokerId: 'u1', expiresAt: 1e12 });
  const press = (messageId, presserId, now) => pressDecision({ record: rec(messageId), button: {}, presserId, now, throttle: t });
  assert.deepEqual(press('m1', 'u1', 1000), { ok: true });
  assert.deepEqual(press('m1', 'u1', 3999), { ok: false, reason: 'slow' });
  assert.deepEqual(press('m1', 'u2', 3999), { ok: true });
  assert.deepEqual(press('m2', 'u1', 3999), { ok: true });
  assert.deepEqual(press('m1', 'u1', 4000), { ok: true });
});

test('pressDecision: a refused non-invoker is throttled, and never affects the invoker throttle', () => {
  const t = createPressThrottle(3000);
  const record = { messageId: 'm', invokerId: 'u1', expiresAt: 1e12 };
  const btn = { invokerOnly: true };
  assert.deepEqual(pressDecision({ record, button: btn, presserId: 'u2', now: 1000, throttle: t }), { ok: false, reason: 'invoker' });
  assert.deepEqual(pressDecision({ record, button: btn, presserId: 'u2', now: 1001, throttle: t }), { ok: false, reason: 'slow' });
  assert.deepEqual(pressDecision({ record, button: btn, presserId: 'u1', now: 1002, throttle: t }), { ok: true });
});

test('createPressThrottle is bounded', () => {
  const t = createPressThrottle(3000);
  for (let i = 0; i < 20_000; i++) t.check(`m${i}`, 'u', 1000);
  assert.ok(t.size() <= 10_000);
});

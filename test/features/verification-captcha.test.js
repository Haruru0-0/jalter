import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeCode, createChallengeStore } from '../../src/features/verification/captcha.js';
import { renderCaptcha } from '../../src/features/verification/captcha-image.js';

const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

function clock() {
  const c = { t: 1_000_000, now: () => c.t };
  return c;
}
function seq(...vals) {
  let i = 0;
  return () => vals[i++ % vals.length];
}

test('makeCode uses only the allowed characters and length 5', () => {
  for (let i = 0; i < 200; i++) {
    const code = makeCode();
    assert.equal(code.length, 5);
    for (const ch of code) assert.ok(ALPHABET.includes(ch), ch);
  }
  assert.equal(makeCode(() => 0), 'AAAAA');
  assert.equal(makeCode(() => 0.999999), '99999');
});

test('renderCaptcha returns a PNG buffer (signature bytes)', async () => {
  const buf = await renderCaptcha('AB3K9');
  assert.ok(Buffer.isBuffer(buf));
  assert.deepEqual([...buf.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const w = buf.readUInt32BE(16), h = buf.readUInt32BE(20);
  assert.equal(w, 320);
  assert.equal(h, 110);
});

test('codes come from crypto, not Math.random, unless a random is injected', () => {
  const original = Math.random;
  Math.random = () => { throw new Error('Math.random used for a code'); };
  try {
    const code = makeCode();
    assert.match(code, /^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{5}$/);
    const issued = createChallengeStore().issue('g', 'u');
    assert.match(issued.code, /^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{5}$/);
  } finally {
    Math.random = original;
  }
});

test('renderCaptcha is deterministic for a seeded random', async () => {
  const a = await renderCaptcha('AB3K9', seq(0.1, 0.5, 0.9, 0.3));
  const b = await renderCaptcha('AB3K9', seq(0.1, 0.5, 0.9, 0.3));
  assert.ok(a.equals(b));
});

test('check accepts the code case-insensitively and clears it', () => {
  const s = createChallengeStore();
  const { code } = s.issue('g', 'u');
  assert.equal(s.check('g', 'u', `  ${code.toLowerCase()} `), 'ok');
  assert.equal(s.check('g', 'u', code), 'none');
});

test('a correct code cannot be reused', () => {
  const s = createChallengeStore();
  const { code } = s.issue('g', 'u');
  assert.equal(s.check('g', 'u', code), 'ok');
  assert.equal(s.check('g', 'u', code), 'none');
});

test('an expired code returns expired', () => {
  const c = clock();
  const s = createChallengeStore({ now: c.now });
  const { code } = s.issue('g', 'u');
  c.t += 299_999;
  assert.equal(s.check('g', 'u', 'ZZZZZ' === code ? 'YYYYY' : 'ZZZZZ'), 'wrong');
  c.t += 2;
  assert.equal(s.check('g', 'u', code), 'expired');
});

test('three wrong entries start the cooldown and check returns cooldown', () => {
  const c = clock();
  const s = createChallengeStore({ now: c.now });
  const { code } = s.issue('g', 'u');
  assert.equal(s.triesLeft('g', 'u'), 3);
  assert.equal(s.check('g', 'u', 'nope1'), 'wrong');
  assert.equal(s.triesLeft('g', 'u'), 2);
  assert.equal(s.check('g', 'u', 'nope2'), 'wrong');
  assert.equal(s.triesLeft('g', 'u'), 1);
  assert.equal(s.check('g', 'u', 'nope3'), 'cooldown');
  assert.equal(s.triesLeft('g', 'u'), 0);
  assert.equal(s.cooldownLeft('g', 'u'), 30_000);
  c.t += 10_000;
  assert.equal(s.cooldownLeft('g', 'u'), 20_000);
  assert.equal(s.check('g', 'u', code), 'cooldown');
});

test('issue during the cooldown hands out no code and changes nothing', () => {
  const c = clock();
  const s = createChallengeStore({ now: c.now });
  s.issue('g', 'u');
  for (const x of ['a1', 'b2', 'c3']) s.check('g', 'u', x);
  c.t += 5_000;
  const r = s.issue('g', 'u');
  assert.equal(r.code, null);
  assert.equal(r.cooldownLeft, 25_000);
  assert.equal(s.cooldownLeft('g', 'u'), 25_000);
  assert.equal(s.triesLeft('g', 'u'), 0);
});

test('after the cooldown a new issue works with fresh tries', () => {
  const c = clock();
  const s = createChallengeStore({ now: c.now });
  const first = s.issue('g', 'u').code;
  for (const x of ['a1', 'b2', 'c3']) s.check('g', 'u', x);
  c.t += 30_000;
  assert.equal(s.cooldownLeft('g', 'u'), 0);
  assert.equal(s.check('g', 'u', first), 'none');
  const { code } = s.issue('g', 'u');
  assert.equal(code.length, 5);
  assert.equal(s.triesLeft('g', 'u'), 3);
  assert.equal(s.check('g', 'u', code), 'ok');
});

test('issue replaces the previous code and does not reset wrong entries', () => {
  const s = createChallengeStore({ random: seq(0, 0.5) });
  const a = s.issue('g', 'u').code;
  assert.equal(s.check('g', 'u', 'wrong'), 'wrong');
  const b = s.issue('g', 'u').code;
  assert.notEqual(a, b);
  assert.equal(s.triesLeft('g', 'u'), 2);
  assert.equal(s.check('g', 'u', a), 'wrong');
  assert.equal(s.check('g', 'u', b), 'ok');
});

test('one user\'s code does not validate for another', () => {
  const s = createChallengeStore({ random: seq(0, 0.5, 0.2) });
  const a = s.issue('g', 'u1').code;
  const b = s.issue('g', 'u2').code;
  assert.equal(s.check('g', 'u2', a), 'wrong');
  assert.equal(s.check('g2', 'u1', a), 'none');
  assert.equal(s.check('g', 'u1', a), 'ok');
  assert.equal(s.check('g', 'u2', b), 'ok');
});

test('clear removes the entry and stale entries are pruned', () => {
  const c = clock();
  const s = createChallengeStore({ now: c.now });
  s.issue('g', 'u');
  s.clear('g', 'u');
  assert.equal(s.check('g', 'u', 'AAAAA'), 'none');
  for (let i = 0; i < 50; i++) s.issue('g', `x${i}`);
  c.t += 10 * 300_000;
  s.issue('g', 'fresh');
  assert.equal(s.size(), 1);
});

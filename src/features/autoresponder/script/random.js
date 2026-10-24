// Random drawing for autoresponder scripts. Pure; the rng is injectable for tests.

const pickIndex = (n, rng) => Math.min(n - 1, Math.floor(rng() * n));

/** Index chosen by relative weights. Zero-weight entries are never picked (-1 if all are zero). */
export function weightedPick(weights, rng = Math.random) {
  const w = (weights ?? []).map((x) => (Number.isFinite(x) && x > 0 ? x : 0));
  const total = w.reduce((a, b) => a + b, 0);
  if (!(total > 0)) return -1;
  const r = rng() * total;
  let acc = 0;
  let last = -1;
  for (let i = 0; i < w.length; i++) {
    if (w[i] === 0) continue;
    last = i;
    acc += w[i];
    if (r < acc) return i;
  }
  return last; // float edge: r landed on the total
}

/** Draw every random value of a compiled spec once. */
export function drawRandom(spec, rng = Math.random) {
  const draws = { range: [], choice: [], lockedchoice: [], picked: [] };
  for (const r of spec?.ranges ?? []) {
    draws.range.push(r.min + pickIndex(r.max - r.min + 1, rng));
  }
  for (const c of spec?.choosers ?? []) {
    if (c.kind === 'weighted') {
      const i = weightedPick(c.weights, rng);
      draws.picked.push(i);
      draws.choice.push(i + 1);
    } else {
      const opts = c.options ?? [];
      const i = opts.length ? pickIndex(opts.length, rng) : -1;
      draws.picked.push(i);
      draws.choice.push(i >= 0 ? opts[i] : '');
    }
  }
  (spec?.locked ?? []).forEach((list, k) => {
    const i = draws.picked[k];
    draws.lockedchoice.push(i >= 0 && list?.[i] !== undefined ? list[i] : '');
  });
  return draws;
}

/** Text for a `rand` token, or '' when that draw does not exist. */
export function renderRand(token, draws) {
  const list = draws?.[token?.kind];
  const v = Array.isArray(list) ? list[(token.n ?? 1) - 1] : undefined;
  return v === undefined || v === null ? '' : String(v);
}

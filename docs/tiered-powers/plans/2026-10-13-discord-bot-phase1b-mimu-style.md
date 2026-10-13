# Jalter, Phase 1b: Mimu-style Embeds and Greet/Leave/Boost Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use tiered-powers:subagent-driven-development (recommended) or tiered-powers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the `/welcome <event>` command and the builder-and-templates embed flow with Mimu's design: separate greet, leave and boost messages (`/set`, `/test`), named embeds (`/embed create|edit|list|delete|show`), `{embed:name}` inside message text, and Mimu's placeholder names. `/embed` and `/post` become always available to managers.

**Architecture:** Same as Phase 1 (feature modules exporting `{ commands, events }`, settings in `guild_settings`, everything async). New: `src/core/placeholders.js` (renders placeholders, builds the variables for a member and guild, extracts `{embed:name}`), named embeds stored in an `embeds` table (renamed from `embed_templates`), autosaved per part, and three independent features `greet`, `leave`, `boost` replacing the single `welcome` feature.

**Tech Stack:** unchanged (Node.js, discord.js 14.27.0, PostgreSQL in Docker, `node:test`).

**Spec:** `docs/tiered-powers/specs/2026-10-13-discord-bot-design.md`, section "Fifth round of owner decisions: copy Mimu". The earlier plan `2026-10-13-discord-bot-phase1-core.md` is superseded for: the `welcome` feature (Task 11), the embed builder, quick command and templates (Task 9), `/post embed`, and `core/templates.js` (Task 10).

**Branching:** work on branch `phase-1` (this amends Phase 1, which is not merged yet). Commit after every task.

**Code in this plan is untested.** It was written without running it. If a real result differs from an expected result, fix the code unless the expectation contradicts the spec.

## Global Constraints

- Everything stays inside Discord. Setup access is the Manage Server permission or the bot manager role (`guard`); replies to setup commands are ephemeral.
- Greet, leave and boost are off by default (the feature is off until a channel is set). `/panel` and `/language` stay always available; **`/embed` and `/post` become always available to managers** (`alwaysOn`), with no `enable` or `disable`.
- Embed name: 1 to 16 characters of `a-z`, `0-9`, `_` or `-` (input is trimmed and lower-cased first). No limit on the number of embeds per server.
- Embed parts: author (text and icon), title, description, thumbnail, image, color (`#RRGGBB`), footer, timestamp (boolean), fields (name, value, inline; kept from Phase 1). Discord limits: title 256, description 4096, footer 2048, author text 256, 25 fields, field name 256, field value 1024, total 6000 characters across title, description, footer, author text and fields.
- Image parts (`thumbnail`, `image`, `author.icon`) are stored as raw strings. A string may be an `http(s)` link, the name of a stored image (media storage channel), or text containing placeholders such as `{user_avatar}`; placeholders are rendered first, then the result is parsed with `parseImageInput` and resolved with `resolveImage`. An empty result after rendering means "no image". Old stored `ImageRef` objects (`{type:'url',url}`, `{type:'stored',name}`) are still accepted.
- Placeholders (exact names): `{user}`, `{user_name}`, `{user_tag}`, `{user_avatar}`, `{server_name}`, `{server_icon}`, `{server_owner}`, `{server_createdate}`, `{server_membercount}`, `{server_membercount_ordinal}`, `{server_boostcount}`, `{date}`, `{newline}`; plus the old aliases `{username}`, `{server}`, `{count}`, `{boosts}`. Unknown placeholders and placeholders without a value are left as written. A rendered value is never expanded again.
- `{embed:name}` in a message attaches the named embed (the first one only; every tag is removed from the text). A missing embed is skipped with a warning and the text is still sent. A message is never sent empty.
- Messages built from user text set `allowedMentions`: greet and boost allow only the new member's id; leave allows none; everything else uses `safeMentions()`. `@everyone` and `@here` can never ping.
- A missing or unwritable channel warns and skips; handlers never throw.
- Languages `en`, `ar`, `fr` per server; a test enforces that `ar.json` and `fr.json` contain every key in `en.json`. Every new key needs real translations in all three files. Remove keys that become unused.
- Tests run with `node --test --test-concurrency=1`; Postgres via `docker compose up -d`. Test output stays pristine (stub `console.warn` where a test expects a warning).
- Do not start the bot and do not create a Discord token. Verify command builders serialise with:
  `node -e "import('./src/modules.js').then(m=>console.log(m.modules.flatMap(x=>x.commands).map(c=>c.data.toJSON().name)))"`
  (descriptions 1-100 characters, required options before optional ones).

## Review Focus

1. A `{embed:name}` that points to a deleted or invalid embed must not stop the greet message (text still sent, warning logged). Pinned in Task 8.
2. A placeholder value containing `@everyone` or a role mention must not ping (embed text never pings; message `content` uses `allowedMentions`). Pinned in Task 8.
3. Removing the last part of an embed (blank value) must not be blocked by the "empty embed" rule at edit time, but an empty embed must be refused at show and send time. Pinned in Tasks 2 and 5.
4. Embed names are case-insensitive and cannot contain spaces; `Rules` and `rules` are the same embed. Pinned in Task 3.
5. `/set greet message` with no text opens a multi-line form, and a message of `none` or `disable` turns only that one message off. Pinned in Task 9.

## File Structure (after this plan)

```
src/core/placeholders.js          new (replaces core/templates.js)
src/db/migrations/002_named_embeds.sql   new
src/features/embeds/
  model.js     extended (author, timestamp, thumbnail, renderEmbedSpec, imageSource)
  store.js     new (replaces templates.js)
  render.js    new (buildEmbedPayload, sendEmbedSpec; replaces send.js)
  edit.js      new (applyEdit, applyEdits)
  panel.js     new (buttons, modals, panel payload)
  spec.js      reduced (errorText, appendField, parseInline)
  index.js     rewritten (/embed create, edit, list, delete, show)
src/features/post/index.js        no enable/disable, no embed subcommand
src/features/greet/
  kinds.js  config.js  message.js  send.js  card.js (moved)  index.js (/set and /test)
src/features/panel, core/registry.js  updated
removed: src/features/welcome/*, src/core/templates.js, embeds/templates.js, embeds/drafts.js, embeds/send.js
```

---

### Task 1: Placeholders module

**Files:**
- Create: `src/core/placeholders.js`
- Test: `test/core/placeholders.test.js`

**Tier:** haiku, every step's code is verbatim.

**Interfaces:**
- Produces:
  - `ordinal(n: number, lang: 'en'|'ar'|'fr'): string` (en: 1st 2nd 3rd 4th, 11th 12th 13th, 21st; fr: 1er, 2e; ar: the plain number)
  - `renderPlaceholders(text: string, vars: Record<string, string|number>): string`
  - `buildVars({ user, member?, guild, lang?, now? }): Record<string, string|number>`; `user` needs `id`, `username`, `globalName?`, `tag?`, `displayAvatarURL(options)`; `guild` needs `name`, `iconURL(options)`, `ownerId`, `createdTimestamp`, `memberCount`, `premiumSubscriptionCount?`
  - `extractEmbedRefs(text: string): { text: string, names: string[] }`

- [ ] **Step 1: Write the failing test** `test/core/placeholders.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ordinal, renderPlaceholders, buildVars, extractEmbedRefs } from '../../src/core/placeholders.js';

test('ordinal follows English rules, French and Arabic styles', () => {
  assert.deepEqual([1, 2, 3, 4, 11, 12, 13, 21, 22, 101, 111].map((n) => ordinal(n, 'en')),
    ['1st', '2nd', '3rd', '4th', '11th', '12th', '13th', '21st', '22nd', '101st', '111th']);
  assert.equal(ordinal(1, 'fr'), '1er');
  assert.equal(ordinal(42, 'fr'), '42e');
  assert.equal(ordinal(42, 'ar'), '42');
});

test('renderPlaceholders replaces known names and keeps unknown ones', () => {
  assert.equal(renderPlaceholders('Hi {user_name} {nope} {count}', { user_name: 'Sam', count: 0 }), 'Hi Sam {nope} 0');
  assert.equal(renderPlaceholders('{user}', {}), '{user}');
  assert.equal(renderPlaceholders(undefined, {}), undefined);
});

test('a rendered value is not expanded again', () => {
  assert.equal(renderPlaceholders('{user_name}', { user_name: '{server_name}', server_name: 'Home' }), '{server_name}');
});

const user = {
  id: '7', username: 'sam', globalName: 'Sam!', tag: 'sam',
  displayAvatarURL: () => 'https://cdn.test/a.png',
};
const guild = {
  name: 'Home', iconURL: () => 'https://cdn.test/g.png', ownerId: '9',
  createdTimestamp: 1_700_000_000_000, memberCount: 42, premiumSubscriptionCount: 3,
};

test('buildVars provides every documented placeholder', () => {
  const v = buildVars({ user, guild, lang: 'en', now: 1_800_000_000_000 });
  assert.equal(v.user, '<@7>');
  assert.equal(v.user_name, 'Sam!');
  assert.equal(v.user_tag, 'sam');
  assert.equal(v.user_avatar, 'https://cdn.test/a.png');
  assert.equal(v.server_name, 'Home');
  assert.equal(v.server_icon, 'https://cdn.test/g.png');
  assert.equal(v.server_owner, '<@9>');
  assert.equal(v.server_createdate, '<t:1700000000:D>');
  assert.equal(v.server_membercount, 42);
  assert.equal(v.server_membercount_ordinal, '42nd');
  assert.equal(v.server_boostcount, 3);
  assert.equal(v.date, '<t:1800000000:D>');
  assert.equal(v.newline, '\n');
});

test('buildVars keeps the old aliases and prefers the member display name', () => {
  const v = buildVars({ user, member: { displayName: 'Nick' }, guild });
  assert.equal(v.user_name, 'Nick');
  assert.equal(v.username, 'sam');
  assert.equal(v.server, 'Home');
  assert.equal(v.count, 42);
  assert.equal(v.boosts, 3);
});

test('buildVars tolerates a guild without an icon or boosts', () => {
  const v = buildVars({ user, guild: { ...guild, iconURL: () => null, premiumSubscriptionCount: null } });
  assert.equal(v.server_icon, '');
  assert.equal(v.server_boostcount, 0);
});

test('extractEmbedRefs removes every tag and lowercases names', () => {
  assert.deepEqual(extractEmbedRefs('welcome, {user}! {embed:Greet_Embed}'),
    { text: 'welcome, {user}!', names: ['greet_embed'] });
  assert.deepEqual(extractEmbedRefs('{embed:a}{embed:b} hi'), { text: 'hi', names: ['a', 'b'] });
  assert.deepEqual(extractEmbedRefs('no tags'), { text: 'no tags', names: [] });
  assert.deepEqual(extractEmbedRefs('{embed:has space}'), { text: '{embed:has space}', names: [] });
});
```

- [ ] **Step 2: Run** `npm test`. Expected: FAIL (module missing).

- [ ] **Step 3: Implement** `src/core/placeholders.js`:

```js
export function ordinal(n, lang = 'en') {
  if (lang === 'fr') return n === 1 ? '1er' : `${n}e`;
  if (lang === 'ar') return String(n);
  const lastTwo = n % 100;
  if (lastTwo >= 11 && lastTwo <= 13) return `${n}th`;
  return `${n}${{ 1: 'st', 2: 'nd', 3: 'rd' }[n % 10] ?? 'th'}`;
}

export function renderPlaceholders(text, vars) {
  if (!text) return text;
  return text.replace(/\{([a-z_]+)\}/g, (match, key) =>
    vars[key] === undefined ? match : String(vars[key]));
}

const unix = (ms) => Math.floor(ms / 1000);

export function buildVars({ user, member = null, guild, lang = 'en', now = Date.now() }) {
  const memberCount = guild.memberCount;
  const boosts = guild.premiumSubscriptionCount ?? 0;
  return {
    user: `<@${user.id}>`,
    user_name: member?.displayName ?? user.globalName ?? user.username,
    user_tag: user.tag ?? user.username,
    user_avatar: user.displayAvatarURL({ extension: 'png', size: 256 }) ?? '',
    server_name: guild.name,
    server_icon: guild.iconURL({ extension: 'png', size: 256 }) ?? '',
    server_owner: `<@${guild.ownerId}>`,
    server_createdate: `<t:${unix(guild.createdTimestamp)}:D>`,
    server_membercount: memberCount,
    server_membercount_ordinal: ordinal(memberCount, lang),
    server_boostcount: boosts,
    date: `<t:${unix(now)}:D>`,
    newline: '\n',
    // old names from Phase 1
    username: user.username,
    server: guild.name,
    count: memberCount,
    boosts,
  };
}

export function extractEmbedRefs(text) {
  const names = [];
  const stripped = text.replace(/\{embed:([A-Za-z0-9_-]{1,16})\}/g, (_match, name) => {
    names.push(name.toLowerCase());
    return '';
  });
  return { text: stripped.trim(), names };
}
```

- [ ] **Step 4: Run** `npm test`. Expected: PASS for the new file (the old `templates.js` still exists until Task 10).
- [ ] **Step 5: Commit** `feat: mimu-style placeholders and embed references`.

---

### Task 2: Embed model extension (author, timestamp, image strings, rendering)

**Files:**
- Modify: `src/features/embeds/model.js`
- Test: `test/features/embed-model.test.js` (add cases; keep the existing ones passing)

**Tier:** sonnet.

**Interfaces:**
- Consumes: `renderPlaceholders` from Task 1.
- Produces (all in `model.js`, pure, no discord.js):
  - `imageSource(value): string | undefined`; a string is returned as is, `{type:'url',url}` gives the url, `{type:'stored',name}` gives the name, anything falsy gives `undefined`.
  - `validateEmbed(spec, { allowEmpty = false } = {}): { ok: true } | { ok: false, errors: string[] }`. New rules: `author.text` over 256 gives `embeds.err.authorTooLong` and counts toward the 6000 total; `author.icon` without `author.text` gives `embeds.err.authorNeedsText`; the "empty" rule counts `title, description, image, thumbnail, author.text, footer` and fields, and is skipped when `allowEmpty` is true.
  - `toDiscordEmbed(spec, images = {}, { now } = {}): object`; `images` is `{ image?, thumbnail?, authorIcon? }` (resolved URLs). Adds `author: { name, icon_url? }` and `timestamp` (ISO string from `now ?? Date.now()`) when `spec.timestamp` is true.
  - `renderEmbedSpec(spec, vars): EmbedSpec` renders placeholders in title, description, footer, author text, field names and values, and in `image`, `thumbnail` and `author.icon` (those three are converted with `imageSource` first). Does not mutate `spec`.

- [ ] **Step 1: Add failing tests** to `test/features/embed-model.test.js` (append):

```js
import { imageSource, renderEmbedSpec } from '../../src/features/embeds/model.js';

test('imageSource accepts strings and old image refs', () => {
  assert.equal(imageSource('https://x.test/a.png'), 'https://x.test/a.png');
  assert.equal(imageSource({ type: 'url', url: 'https://x.test/a.png' }), 'https://x.test/a.png');
  assert.equal(imageSource({ type: 'stored', name: 'logo' }), 'logo');
  assert.equal(imageSource(undefined), undefined);
});

test('author text counts toward limits and the icon needs text', () => {
  assert.ok(validateEmbed({ author: { text: 'x'.repeat(257) } }).errors.includes('embeds.err.authorTooLong'));
  assert.ok(validateEmbed({ title: 't', author: { icon: 'https://x.test/a.png' } }).errors.includes('embeds.err.authorNeedsText'));
  const big = { title: 'x'.repeat(256), description: 'x'.repeat(4000), author: { text: 'x'.repeat(256) }, footer: 'x'.repeat(1489) };
  assert.ok(validateEmbed(big).errors.includes('embeds.err.tooLarge'));
});

test('an embed with only an author, only a thumbnail or only a footer is not empty', () => {
  assert.deepEqual(validateEmbed({ author: { text: 'a' } }), { ok: true });
  assert.deepEqual(validateEmbed({ thumbnail: 'https://x.test/t.png' }), { ok: true });
  assert.deepEqual(validateEmbed({ footer: 'f' }), { ok: true });
});

test('allowEmpty lets an empty embed through but still checks limits', () => {
  assert.deepEqual(validateEmbed({}, { allowEmpty: true }), { ok: true });
  assert.ok(validateEmbed({ title: 'x'.repeat(257) }, { allowEmpty: true }).errors.includes('embeds.err.titleTooLong'));
});

test('toDiscordEmbed adds author and timestamp', () => {
  const e = toDiscordEmbed(
    { title: 'T', author: { text: 'Sam' }, timestamp: true },
    { authorIcon: 'https://x.test/i.png' },
    { now: Date.UTC(2026, 0, 2, 3, 4, 5) },
  );
  assert.deepEqual(e.author, { name: 'Sam', icon_url: 'https://x.test/i.png' });
  assert.equal(e.timestamp, '2026-01-02T03:04:05.000Z');
  assert.equal(toDiscordEmbed({ title: 'T' }).timestamp, undefined);
  assert.deepEqual(toDiscordEmbed({ author: { text: 'Sam' } }).author, { name: 'Sam' });
});

test('renderEmbedSpec renders text and image parts without changing the input', () => {
  const spec = {
    title: 'Hi {user_name}', description: '{server_name}', footer: '#{server_membercount_ordinal}',
    author: { text: '{user_name}', icon: '{user_avatar}' },
    thumbnail: '{server_icon}', image: { type: 'stored', name: 'logo' },
    fields: [{ name: '{user_name}', value: '{date}', inline: true }],
  };
  const vars = { user_name: 'Sam', server_name: 'Home', server_membercount_ordinal: '42nd', user_avatar: 'https://a.test/a.png', server_icon: 'https://a.test/g.png', date: 'D' };
  const out = renderEmbedSpec(spec, vars);
  assert.equal(out.title, 'Hi Sam');
  assert.equal(out.description, 'Home');
  assert.equal(out.footer, '#42nd');
  assert.deepEqual(out.author, { text: 'Sam', icon: 'https://a.test/a.png' });
  assert.equal(out.thumbnail, 'https://a.test/g.png');
  assert.equal(out.image, 'logo');
  assert.deepEqual(out.fields, [{ name: 'Sam', value: 'D', inline: true }]);
  assert.equal(spec.title, 'Hi {user_name}');
});
```

(`validateEmbed` and `toDiscordEmbed` are already imported at the top of that file; add the two new imports.)

- [ ] **Step 2: Run** `npm test`. Expected: FAIL.
- [ ] **Step 3: Implement.** In `model.js`:
  - add `imageSource`;
  - add the `allowEmpty` option and the author rules to `validateEmbed`; add `len(spec.author?.text)` to `total`;
  - extend `toDiscordEmbed` (author, timestamp; the existing `image`/`thumbnail` handling stays);
  - add `renderEmbedSpec` using `renderPlaceholders` from `../../core/placeholders.js`. An absent image part stays absent; a part that renders to an empty string is removed from the result.
- [ ] **Step 4: Locale keys.** Add to `en.json`, then translate into `ar.json` and `fr.json`:

```json
"embeds.err.authorTooLong": "The author text is longer than 256 characters.",
"embeds.err.authorNeedsText": "The author icon needs author text too."
```

- [ ] **Step 5: Run** `npm test`. Expected: PASS. **Step 6: Commit** `feat: embed author, timestamp and placeholder rendering`.

---

### Task 3: Named embed store and migration

**Files:**
- Create: `src/db/migrations/002_named_embeds.sql`, `src/features/embeds/store.js`
- Modify: `src/db/index.js` (the `resetDb` table list), `test/db/settings.test.js` (the migration count test)
- Delete: `src/features/embeds/templates.js`, `test/features/embed-templates.test.js`
- Test: `test/features/embed-store.test.js`

**Tier:** sonnet, migration.

**Interfaces:**
- Produces:
  - `normalizeEmbedName(input): string | null` (trim, lower-case, must match `^[a-z0-9_-]{1,16}$`)
  - `createEmbed(db, guildId, name): Promise<boolean>` (creates an empty `{}` embed; `false` if the name exists)
  - `getEmbed(db, guildId, name): Promise<EmbedSpec | null>`
  - `saveEmbed(db, guildId, name, spec): Promise<boolean>` (`false` if the embed does not exist; never creates)
  - `listEmbeds(db, guildId): Promise<string[]>` (sorted)
  - `deleteEmbed(db, guildId, name): Promise<boolean>`

- [ ] **Step 1: Migration** `src/db/migrations/002_named_embeds.sql`:

```sql
ALTER TABLE embed_templates RENAME TO embeds;
```

(No data migration: nothing is deployed yet. Existing rows keep their names; names that break the new rules are simply unreachable until deleted.)

- [ ] **Step 2:** In `src/db/index.js` change the `TRUNCATE` list from `embed_templates` to `embeds`.
- [ ] **Step 3:** In `test/db/settings.test.js`, change the "openDb twice does not re-apply migrations" test so it compares the `schema_version` row count with the number of `.sql` files in `src/db/migrations` (read with `readdir`) instead of the literal `1`.
- [ ] **Step 4: Write the failing test** `test/features/embed-store.test.js`:

```js
import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeEmbedName, createEmbed, getEmbed, saveEmbed, listEmbeds, deleteEmbed,
} from '../../src/features/embeds/store.js';
import { testDb } from '../helpers/db.js';

let db;
before(async () => { db = await testDb(); });
beforeEach(async () => { await db.query('TRUNCATE embeds'); });
after(async () => { await db.end(); });

test('normalizeEmbedName trims, lower-cases and rejects bad names', () => {
  assert.equal(normalizeEmbedName('  Rules_1 '), 'rules_1');
  assert.equal(normalizeEmbedName('a'.repeat(16)), 'a'.repeat(16));
  for (const bad of ['', '   ', 'has space', 'a'.repeat(17), 'weird!', undefined]) {
    assert.equal(normalizeEmbedName(bad), null, String(bad));
  }
});

test('createEmbed makes an empty embed once', async () => {
  assert.equal(await createEmbed(db, 'g1', 'rules'), true);
  assert.equal(await createEmbed(db, 'g1', 'rules'), false);
  assert.deepEqual(await getEmbed(db, 'g1', 'rules'), {});
});

test('saveEmbed updates an existing embed and never creates one', async () => {
  assert.equal(await saveEmbed(db, 'g1', 'nope', { title: 'x' }), false);
  await createEmbed(db, 'g1', 'rules');
  assert.equal(await saveEmbed(db, 'g1', 'rules', { title: 'Rules', color: '#5865F2' }), true);
  assert.deepEqual(await getEmbed(db, 'g1', 'rules'), { title: 'Rules', color: '#5865F2' });
});

test('embeds are per guild, listed sorted, and deletable', async () => {
  await createEmbed(db, 'g1', 'b');
  await createEmbed(db, 'g1', 'a');
  await createEmbed(db, 'g2', 'c');
  assert.deepEqual(await listEmbeds(db, 'g1'), ['a', 'b']);
  assert.equal(await getEmbed(db, 'g2', 'a'), null);
  assert.equal(await deleteEmbed(db, 'g1', 'a'), true);
  assert.equal(await deleteEmbed(db, 'g1', 'a'), false);
});
```

- [ ] **Step 5: Run** `npm test`. Expected: FAIL.
- [ ] **Step 6: Implement** `src/features/embeds/store.js` with parameterised SQL against table `embeds` (`INSERT ... ON CONFLICT DO NOTHING` and check `rowCount`; `UPDATE ... WHERE guild_id AND name` and check `rowCount`; `json` is JSONB so pass `JSON.stringify(spec)` with `$3::jsonb`). Delete `templates.js` and its test; fix imports later in Tasks 5 and 6 (the build stays red until then, so do Steps 6 and the deletes together with Task 5 if the executor prefers a green tree after every task: in that case keep `templates.js` until Task 5 deletes it).
- [ ] **Step 7: Run** `npm test`. Expected: PASS. **Step 8: Commit** `feat: named embed store`.

---

### Task 4: Render and send helpers for embeds

**Files:**
- Create: `src/features/embeds/render.js`
- Modify: `src/features/embeds/send.js` is replaced by `render.js` at Task 5 (this task only adds `render.js`)
- Test: `test/features/embed-render.test.js`

**Tier:** sonnet.

**Interfaces:**
- Consumes: `renderEmbedSpec`, `validateEmbed`, `toDiscordEmbed`, `imageSource` (Task 2), `parseImageInput`, `resolveImage` (media), `buildVars`, `fetchSendable`, `trySend`, `safeMentions`, `memberCanPost`.
- Produces:
  - `buildEmbedPayload(ctx, guildId, spec, vars, { now } = {}): Promise<{ embeds: object[] }>`. Renders placeholders, validates the rendered spec, resolves `image`, `thumbnail` and `author.icon` (skipping empty values). Throws `Error('image-not-found')` (from `resolveImage`) or an `Error('embed-invalid')` with `.errors: string[]`.
  - `fetchGuildSendable(client, guildId, channelId)` (moved unchanged from `send.js`)
  - `sendEmbedSpec(interaction, ctx, lang, spec, channelId): Promise<Message | null>`. Same flow as today's function (validate raw spec with `validateEmbed` before deferring, defer ephemeral, build vars from `interaction.member` and `interaction.guild`, call `buildEmbedPayload`, check `memberCanPost`, `trySend` with `safeMentions()`, answer with `embeds.sent` or `embeds.cannotSend`). The `ns` parameter is removed.

- [ ] **Step 1: Write the failing test** `test/features/embed-render.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildEmbedPayload } from '../../src/features/embeds/render.js';

const noDb = { query: async () => ({ rows: [] }) };
const ctx = { db: noDb, client: {} };
const vars = { user_name: 'Sam', user_avatar: 'https://a.test/a.png', server_icon: '', server_name: 'Home' };

test('placeholders in text and image parts are rendered and images resolved', async () => {
  const { embeds } = await buildEmbedPayload(ctx, 'g1', {
    title: 'Hi {user_name}', author: { text: '{user_name}', icon: '{user_avatar}' },
    thumbnail: '{server_icon}', image: 'https://a.test/i.png', timestamp: true,
  }, vars, { now: 0 });
  assert.equal(embeds[0].title, 'Hi Sam');
  assert.deepEqual(embeds[0].author, { name: 'Sam', icon_url: 'https://a.test/a.png' });
  assert.equal(embeds[0].thumbnail, undefined);               // empty after rendering = no image
  assert.deepEqual(embeds[0].image, { url: 'https://a.test/i.png' });
  assert.equal(embeds[0].timestamp, '1970-01-01T00:00:00.000Z');
});

test('an unknown stored image name throws image-not-found and nothing is built', async () => {
  await assert.rejects(buildEmbedPayload(ctx, 'g1', { title: 't', image: 'missing' }, vars), /image-not-found/);
});

test('a rendered embed that breaks a limit throws embed-invalid with the errors', async () => {
  await assert.rejects(
    buildEmbedPayload(ctx, 'g1', { title: '{user_name}' }, { user_name: 'x'.repeat(300) }),
    (err) => err.message === 'embed-invalid' && err.errors.includes('embeds.err.titleTooLong'),
  );
});

test('an empty embed is refused', async () => {
  await assert.rejects(buildEmbedPayload(ctx, 'g1', {}, vars),
    (err) => err.message === 'embed-invalid' && err.errors.includes('embeds.err.empty'));
});
```

- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement** `render.js`. Resolution helper (internal): `async function resolve(ctx, guildId, value) { return value ? resolveImage(ctx.db, ctx.client, guildId, parseImageInput(value)) : undefined; }`. Order: render, then `validateEmbed(rendered)`; if not ok, throw `Object.assign(new Error('embed-invalid'), { errors })`; then resolve the three images; then `toDiscordEmbed`.
- [ ] **Step 4: Run** `npm test`. Expected: PASS. **Step 5: Commit** `feat: render named embeds with placeholders and images`.

---

### Task 5: Embed edit logic and the `/embed` slash commands

**Files:**
- Create: `src/features/embeds/edit.js`
- Modify: `src/features/embeds/index.js` (rewrite), `src/features/embeds/spec.js` (remove `specFromFields`, `quickSpec`), `src/modules.js` unchanged
- Delete: `src/features/embeds/templates.js`, `drafts.js`, `send.js`, `test/features/embed-templates.test.js` (if still present), `test/features/embed-drafts.test.js`, `test/features/embed-modals.test.js` (rewritten in Task 6)
- Test: `test/features/embed-edit.test.js`; adjust `test/features/embed-spec.test.js`

**Tier:** sonnet.

**Interfaces:**
- Consumes: store (Task 3), `validateEmbed` (Task 2), `sendEmbedSpec` (Task 4), `guard`, `capList`, `memberCanPost`.
- Produces:
  - `applyEdit(spec, part, value): { ok: true, spec } | { ok: false, errors: string[] }` where `part` is one of `title | description | footer | color | thumbnail | image | timestamp | author | field | clear-fields` and `value` depends on the part:
    - text parts and `color`, `thumbnail`, `image`: a string; blank, whitespace or `undefined` removes the part.
    - `timestamp`: a boolean (`false` removes it).
    - `author`: `{ text?: string, icon?: string }`; blank text removes the whole author (even if an icon is given, then the result is `ok` and the author is gone only when icon is also blank; an icon without text returns `embeds.err.authorNeedsText`).
    - `field`: `{ name, value, inline }` (delegates to `appendField` from `spec.js`).
    - `clear-fields`: ignored value; removes `fields`.
    The result is validated with `validateEmbed(next, { allowEmpty: true })`. The input spec is not mutated.
  - `applyEdits(spec, edits: Array<[part, value]>): same result` applies in order and stops at the first error.
  - `/embed` commands (below). `embeds` is no longer toggleable.

Command tree for `/embed` (Mimu's names; option `embed` is the embed name, required):
- `create name:<text>` (name 1-16; error replies: bad name, name exists)
- `edit all embed:` (opens the button panel; Task 6)
- `edit author embed: [text:] [icon:]`, `edit title embed: [title:]`, `edit description embed: [description:]`, `edit thumbnail embed: [image:]`, `edit image embed: [image:]`, `edit color embed: [color:]`, `edit footer embed: [text:]`, `edit timestamp embed: timestamp:<bool>`, `edit field embed: name: value: [inline:<bool>]`, `edit clear-fields embed:` (all inside a subcommand group `edit`)
- `list`, `delete embed:`, `show embed: [channel:]`

Behaviour:
- Every subcommand starts with `guard(interaction, ctx, 'embeds', { requireEnabled: false })`.
- Names go through `normalizeEmbedName`; an invalid name replies `embeds.badName`; an unknown embed replies `embeds.notFound`.
- `edit <part>`: load, `applyEdit`, on errors reply `errorText(lang, errors)`, else `saveEmbed` and reply `common.saved`. For `thumbnail`, `image` and `author.icon` a value that is neither a link nor contains `{` is treated as a stored image name and must exist in `media_items` (reply `media.unknown` otherwise), as `/welcome image` did.
- `show`: refuse an empty embed (`validateEmbed(spec)` with errors), then `sendEmbedSpec(...)`. Channel defaults to the current channel; channel types text and announcement.
- `list`: `capList` of names in backticks, or `embeds.none`.

- [ ] **Step 1: Write the failing test** `test/features/embed-edit.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyEdit, applyEdits } from '../../src/features/embeds/edit.js';

test('setting and clearing a text part', () => {
  const a = applyEdit({}, 'title', ' Rules ');
  assert.deepEqual(a, { ok: true, spec: { title: 'Rules' } });
  assert.deepEqual(applyEdit(a.spec, 'title', ''), { ok: true, spec: {} });     // blank removes, last part allowed
  assert.deepEqual(applyEdit(a.spec, 'title', undefined), { ok: true, spec: {} });
});

test('limits and color are checked', () => {
  assert.deepEqual(applyEdit({}, 'title', 'x'.repeat(257)).errors, ['embeds.err.titleTooLong']);
  assert.deepEqual(applyEdit({}, 'color', 'red').errors, ['embeds.err.badColor']);
  assert.deepEqual(applyEdit({}, 'color', '#5865F2'), { ok: true, spec: { color: '#5865F2' } });
});

test('images and thumbnails are stored as raw strings', () => {
  assert.deepEqual(applyEdit({}, 'image', 'https://x.test/a.png').spec, { image: 'https://x.test/a.png' });
  assert.deepEqual(applyEdit({ thumbnail: 'x' }, 'thumbnail', '{server_icon}').spec, { thumbnail: '{server_icon}' });
});

test('timestamp is a boolean part', () => {
  assert.deepEqual(applyEdit({}, 'timestamp', true).spec, { timestamp: true });
  assert.deepEqual(applyEdit({ timestamp: true }, 'timestamp', false).spec, {});
});

test('author needs text; blank text and icon removes it', () => {
  assert.deepEqual(applyEdit({}, 'author', { text: '{user_name}', icon: '{user_avatar}' }).spec,
    { author: { text: '{user_name}', icon: '{user_avatar}' } });
  assert.deepEqual(applyEdit({}, 'author', { icon: 'https://x.test/i.png' }).errors, ['embeds.err.authorNeedsText']);
  assert.deepEqual(applyEdit({ author: { text: 'a' } }, 'author', {}).spec, {});
});

test('fields can be appended, limited to 25, and cleared', () => {
  let spec = {};
  for (let i = 0; i < 25; i += 1) spec = applyEdit(spec, 'field', { name: `n${i}`, value: 'v', inline: false }).spec;
  assert.equal(spec.fields.length, 25);
  assert.deepEqual(applyEdit(spec, 'field', { name: 'x', value: 'v' }).errors, ['embeds.err.tooManyFields']);
  assert.deepEqual(applyEdit(spec, 'clear-fields').spec.fields, undefined);
  assert.deepEqual(applyEdit({}, 'field', { name: '', value: 'v' }).errors, ['embeds.err.fieldEmpty']);
});

test('the input spec is not mutated and applyEdits stops at the first error', () => {
  const spec = { title: 'a' };
  applyEdit(spec, 'title', 'b');
  assert.equal(spec.title, 'a');
  const r = applyEdits({}, [['title', 'ok'], ['color', 'bad'], ['footer', 'never']]);
  assert.equal(r.ok, false);
  assert.deepEqual(applyEdits({}, [['title', 'ok'], ['footer', 'f']]).spec, { title: 'ok', footer: 'f' });
});
```

- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement** `edit.js` (pure, imports only `validateEmbed` and `appendField`/`parseInline`). Note: `appendField` currently validates with `validateEmbed(next)` (which would reject nothing here since a field makes the embed non-empty); keep it.
- [ ] **Step 4: Rewrite `src/features/embeds/index.js`** with the command tree above. Keep the file focused: build `data` with `SlashCommandBuilder`, a small `loadEmbed(interaction, ctx, lang)` helper (normalise the `embed` option, fetch, reply on failure, return `{ name, spec }` or `null`), and one `execute` that dispatches on group and subcommand. `edit all` and `create` call `showPanel(...)` which Task 6 provides; until Task 6, export a stub `showPanel` in `panel.js` that replies `embeds.panelSoon` so the tree is runnable. Descriptions 1-100 characters.
- [ ] **Step 5: Cleanup.** Delete `templates.js`, `drafts.js`, `send.js` from `src/features/embeds/` and their tests; remove `specFromFields` and `quickSpec` from `spec.js` and the matching cases from `test/features/embed-spec.test.js` (keep `errorText`, `appendField`, `parseInline` cases); update `src/features/post/index.js` imports in Task 7 (post currently imports `getTemplate`, `fetchGuildSendable`, `sendEmbedSpec`; to keep the tree green in this task, change those imports to `./render.js` and leave `/post embed` calling a temporary `getEmbed`; Task 7 removes that subcommand).
- [ ] **Step 6: Locale keys** (en, then ar and fr):

```json
"embeds.badName": "Embed names are 1 to 16 characters: letters, numbers, _ or -, no spaces.",
"embeds.exists": "An embed named `{name}` already exists.",
"embeds.created": "Created the embed `{name}`.",
"embeds.notFound": "There is no embed named `{name}`.",
"embeds.none": "No embeds yet. Create one with /embed create.",
"embeds.deleted": "Deleted the embed `{name}`.",
"embeds.panelSoon": "The editing buttons are coming in the next step."
```

Remove the now-unused keys from Phase 1 (`embeds.modalTitle`, `embeds.previewHint`, `embeds.send`, `embeds.saveTemplate`, `embeds.draftExpired`, `embeds.noTemplate`, `embeds.noTemplates`, `embeds.templateSaved`, `embeds.templateDeleted`, `embeds.templateName`) only after confirming with a repository search that no code still uses them (Task 10 does the final sweep).
- [ ] **Step 7: Run** `npm test` and the serialise check. Expected: PASS; the list shows `embed` once. **Step 8: Commit** `feat: mimu-style /embed commands`.

---

### Task 6: Embed editing panel (buttons and forms)

**Files:**
- Create: `src/features/embeds/panel.js` (replaces the stub)
- Modify: `src/features/embeds/index.js` (register the component handler)
- Test: `test/features/embed-panel.test.js`

**Tier:** opus, interactive multi-step flow touching Tasks 2, 4, 5.

**Interfaces:**
- Consumes: store, `applyEdits`, `buildEmbedPayload`, `buildVars`, `guard`, `ephemeral`, `errorText`.
- Produces:
  - `panelModal(lang, part, name, spec): ModalBuilder` for parts `text` (title, description, footer), `look` (color, timestamp: "yes"/"no"), `author` (text, icon), `images` (thumbnail, image), `field` (name, value, inline). Modal custom id `embeds:m:<part>:<name>`; every title and label at most 45 characters in all languages; inputs pre-filled from `spec` (image parts shown as the raw string).
  - `editsFromModal(part, get): Array<[part, value]>` (pure; `get(id)` returns the raw input) mapping each modal to `applyEdits` input. `look` maps `timestamp` with `parseInline` (yes/oui/نعم).
  - `panelPayload(ctx, interaction, lang, name, spec): Promise<object>` returns the message body: a `content` line with the embed name and a hint, the rendered preview embed (placeholders rendered for the invoker; if the spec is empty show `embeds.panelEmpty` as content instead of an embed; if building fails show `embeds.previewFailed` or `embeds.imageMissing`), and two button rows: row 1 `Text`, `Look`, `Author`, `Images`, `Add field`; row 2 `Clear fields`, `Show here`. Button ids `embeds:b:<action>:<name>` with actions `text, look, author, images, field, clear, show`.
  - `showPanel(interaction, ctx, lang, name, spec)`: replies ephemeral with `panelPayload`.
  - `handlePanel(interaction, ctx)`: the component handler for the `embeds` prefix. For every component it first calls `guard(interaction, ctx, 'embeds', { requireEnabled: false })`, loads the embed by name (reply `embeds.notFound` if gone), then:
    - button `text|look|author|images|field`: `showModal(panelModal(...))`;
    - button `clear`: remove fields, save, `interaction.update(panelPayload)`;
    - button `show`: `sendEmbedSpec` to the current channel (the invoker's channel);
    - modal submit: `editsFromModal` then `applyEdits`; on errors reply `errorText` (ephemeral) and save nothing; on success `saveEmbed` and `interaction.isFromMessage() ? interaction.update(payload) : interaction.reply(ephemeral(payload))`.
  - Component prefix stays `embeds`.

- [ ] **Step 1: Write the failing test** `test/features/embed-panel.test.js` (pure parts only):

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { panelModal, editsFromModal } from '../../src/features/embeds/panel.js';
import { LANGS } from '../../src/i18n/index.js';

const PARTS = ['text', 'look', 'author', 'images', 'field'];

test('every modal is valid in every language and uses the documented custom id', () => {
  for (const lang of LANGS) {
    for (const part of PARTS) {
      const json = panelModal(lang, part, 'rules', {}).toJSON();   // toJSON validates label and title lengths
      assert.equal(json.custom_id, `embeds:m:${part}:rules`);
      assert.ok(json.components.length >= 2 && json.components.length <= 5);
    }
  }
});

test('modals are prefilled from the saved embed', () => {
  const spec = { title: 'T', description: 'D', footer: 'F', color: '#000000', timestamp: true,
    author: { text: 'A', icon: '{user_avatar}' }, thumbnail: '{server_icon}', image: { type: 'stored', name: 'logo' } };
  const values = (part) => panelModal('en', part, 'x', spec).toJSON().components.map((r) => r.components[0].value);
  assert.deepEqual(values('text'), ['T', 'D', 'F']);
  assert.deepEqual(values('look'), ['#000000', 'yes']);
  assert.deepEqual(values('author'), ['A', '{user_avatar}']);
  assert.deepEqual(values('images'), ['{server_icon}', 'logo']);
});

test('editsFromModal maps each form to edits', () => {
  const get = (map) => (id) => map[id];
  assert.deepEqual(editsFromModal('text', get({ title: 'T', description: '', footer: 'F' })),
    [['title', 'T'], ['description', ''], ['footer', 'F']]);
  assert.deepEqual(editsFromModal('look', get({ color: '#fff000', timestamp: 'Oui' })),
    [['color', '#fff000'], ['timestamp', true]]);
  assert.deepEqual(editsFromModal('look', get({ color: '', timestamp: '' })), [['color', ''], ['timestamp', false]]);
  assert.deepEqual(editsFromModal('author', get({ text: 'A', icon: '' })), [['author', { text: 'A', icon: '' }]]);
  assert.deepEqual(editsFromModal('images', get({ thumbnail: 't', image: 'i' })), [['thumbnail', 't'], ['image', 'i']]);
  assert.deepEqual(editsFromModal('field', get({ name: 'n', value: 'v', inline: 'yes' })),
    [['field', { name: 'n', value: 'v', inline: true }]]);
});
```

- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement** `panel.js`; reuse the `textInput` helper pattern from the old `index.js` (set value only when non-empty, set `setMaxLength`, `required` only for `field` name and value). In `index.js` export `components: { prefix: 'embeds', handle: handlePanel }` on the `/embed` command and make `create` and `edit all` call `showPanel`.
- [ ] **Step 4: Locale keys** (en, then ar and fr): `embeds.panelHint`, `embeds.panelEmpty`, `embeds.partText`, `embeds.partLook`, `embeds.partAuthor`, `embeds.partImages`, `embeds.addField`, `embeds.clearFields`, `embeds.showHere`, `embeds.modalText`, `embeds.modalLook`, `embeds.modalAuthor`, `embeds.modalImages`, `embeds.modalField`, `embeds.fieldName`, `embeds.fieldValue`, `embeds.fieldInline`, `embeds.title`, `embeds.description`, `embeds.footer`, `embeds.color`, `embeds.timestampYesNo`, `embeds.authorText`, `embeds.authorIcon`, `embeds.thumbnail`, `embeds.image`. Remove `embeds.panelSoon`.
- [ ] **Step 5: Run** `npm test` and the serialise check. Expected: PASS. **Step 6: Commit** `feat: embed editing panel with buttons and forms`.

---

### Task 7: Registry, `/panel` and `/post`

**Files:**
- Modify: `src/core/registry.js`, `src/features/post/index.js`, `src/features/panel/index.js` (only if needed), locale files
- Test: `test/core/registry.test.js`, `test/features/panel.test.js`, `test/features/post-rules.test.js` (unchanged)

**Tier:** sonnet.

**Interfaces:**
- `FEATURES`: `embeds` and `post` get `alwaysOn: true` (shown as Core). `welcome` is replaced by `greet`, `leave`, `boost`, each with `command: 'set'` and `enableCommand: 'set greet channel'` / `'set leave channel'` / `'set boost channel'`. `info` unchanged.
- `/post`: subcommands `text` and `buttons` only; no `enable`/`disable`; `guard(interaction, ctx, 'post', { requireEnabled: false })`. `/post embed` is removed (use `/embed show`).

- [ ] **Step 1: Update tests first.**
  - `test/core/registry.test.js`: the Phase 1 key list becomes `panel, language, media, embeds, post, greet, leave, boost, autorole, logging, info`.
  - `test/features/panel.test.js`: replace the three `welcome` expectations with `Greet messages\*\*: Off \(\/set greet channel\)`, `Leave messages\*\*: Off \(\/set leave channel\)`, `Boost messages\*\*: Off \(\/set boost channel\)`; the "enabled" test uses key `greet`; add `Embeds\*\*: Core$` and `Post message\*\*: Core$` expectations (multi-line flag `m`); the French test expects `Désactivé \(\/set greet channel\)`.
  - `test/core/guard.test.js`: the case that used key `'welcome'` for the hint now uses `'greet'` and expects `/\/set greet channel/`.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement** the registry change, then edit `post/index.js` (remove `toggleSubcommands`, `handleToggle`, the `embed` subcommand and the `getTemplate`/`sendEmbedSpec` imports; keep `text` and `buttons` and their guard with `requireEnabled: false`).
- [ ] **Step 4: Locale keys:** add `feature.greet` = "Greet messages", `feature.leave` = "Leave messages", `feature.boost` = "Boost messages" (translate); remove `feature.welcome`, and the `post.*` keys no longer used.
- [ ] **Step 5: Run** `npm test` and the serialise check (the list must no longer show `post enable` or `embed enable`; the dispatch of `welcome` still exists until Task 10, so the registry may list `greet` before its module exists; that is fine). **Step 6: Commit** `feat: embeds and post always available; greet, leave and boost features`.

---

### Task 8: Greet, leave and boost: config, message building, sending

**Files:**
- Create: `src/features/greet/kinds.js`, `config.js`, `message.js`, `send.js`
- Move: `src/features/welcome/card.js` to `src/features/greet/card.js` (use `git mv`); `test/features/welcome-card.test.js` to `test/features/greet-card.test.js` (fix its import path)
- Test: `test/features/greet-message.test.js`, `test/features/greet-send.test.js`

**Tier:** sonnet.

**Interfaces:**
- `kinds.js`: `KINDS = ['greet','leave','boost']`; `DM_KINDS = ['greet','boost']`; `DEFAULT_MESSAGE = { greet: 'Welcome {user} to {server_name}! You are our {server_membercount_ordinal} member.', leave: '{user_name} left {server_name}.', boost: 'Thank you {user} for boosting {server_name}!' }`.
- Config shape per feature key (`greet`, `leave`, `boost`; the `enabled` flag is the feature's `enabled` column): `{ channelId?: string, message?: string, card?: boolean, background?: string, dm?: boolean }`.
- `message.js`:
  - `buildContent(rawMessage: string, vars): { content: string, embedNames: string[] }` uses `extractEmbedRefs` then `renderPlaceholders`; `content` is `''` when only an embed tag was written.
  - `ensureNotEmpty(payload, fallbackText)`: if the payload has no `content`, `embeds` or `files`, set `content` to the fallback so a message is never empty.
- `send.js`:
  - `handleMember(ctx, member, kind): Promise<'sent' | 'off' | 'no-channel' | 'send-failed'>` never throws.
    1. `getFeature(db, guild.id, kind)`: not enabled gives `'off'`; no `channelId` gives `'no-channel'`.
    2. A member without `user` warns and returns `'send-failed'`.
    3. `lang = getLang`, `vars = buildVars({ user: member.user, member, guild: member.guild, lang })`.
    4. Full payload: text from `buildContent(config.message ?? DEFAULT_MESSAGE[kind], vars)`; the first embed name is loaded with `getEmbed` and built with `buildEmbedPayload` (a missing embed: warn and skip; `image-not-found` or `embed-invalid`: treated as a failure of the full payload); if `config.card` render the card with `renderCard({ username: vars.user_name, avatarUrl: vars.user_avatar || undefined, serverName: vars.server_name, background })` where `background` comes from `config.background` through `parseImageInput` and `resolveImage`; attach it as `files: [{ attachment, name: 'card.png' }]`.
    5. If building the full payload throws, warn and send text only (`content` from step 4 without embed or card).
    6. `ensureNotEmpty(payload, renderPlaceholders(DEFAULT_MESSAGE[kind], vars))`.
    7. Send with `allowedMentions`: `kind === 'leave' ? safeMentions() : { parse: [], users: [member.id] }`. Result `'sent'` or `'send-failed'`.
    8. For `kind` in `DM_KINDS` with `config.dm`: `member.send(payload)` (same payload, without the card file when it fails), swallow errors with a warning.
  - `events`: `GuildMemberAdd` to `greet`, `GuildMemberRemove` to `leave`, `GuildMemberUpdate` to `boost` only when `!oldMember.partial && !oldMember.premiumSince && newMember.premiumSince`.

- [ ] **Step 1: Write failing tests.** `test/features/greet-message.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildContent, ensureNotEmpty } from '../../src/features/greet/message.js';

const vars = { user: '<@1>', user_name: 'Sam', server_name: 'Home' };

test('buildContent renders placeholders and extracts the embed tag', () => {
  assert.deepEqual(buildContent('hi {user}{newline}{embed:Greet_Embed}', { ...vars, newline: '\n' }),
    { content: 'hi <@1>', embedNames: ['greet_embed'] });
  assert.deepEqual(buildContent('{embed:a}', vars), { content: '', embedNames: ['a'] });
});

test('a mention inside a value is just text (allowedMentions decides pings)', () => {
  assert.equal(buildContent('{user_name}', { user_name: '@everyone' }).content, '@everyone');
});

test('ensureNotEmpty never lets a message be empty', () => {
  assert.deepEqual(ensureNotEmpty({}, 'fallback'), { content: 'fallback' });
  assert.deepEqual(ensureNotEmpty({ content: '' }, 'fallback'), { content: 'fallback' });
  assert.deepEqual(ensureNotEmpty({ embeds: [{}] }, 'fallback'), { embeds: [{}] });
  assert.deepEqual(ensureNotEmpty({ files: [{}] }, 'fallback'), { files: [{}] });
});
```

`test/features/greet-send.test.js` (real test database, Discord fakes; rewrite of the old `welcome-events.test.js`; stub `console.warn` in tests that expect warnings and restore it in `finally`). Cases, each as its own `test`:
  1. feature off gives `'off'` and sends nothing;
  2. enabled without a channel gives `'no-channel'`;
  3. default greet message is sent with the member's name and `allowedMentions` equal to `{ parse: [], users: ['1'] }`;
  4. leave uses `allowedMentions` `{ parse: [] }`;
  5. `{embed:rules}` attaches the stored embed (insert with `createEmbed` + `saveEmbed`), content holds the rest of the text;
  6. a missing embed name still sends the text and warns;
  7. an embed whose image is a missing stored name falls back to text only;
  8. `card: true` attaches a file named `card.png` (the real `renderCard` is used; pass a Latin name);
  9. `dm: true` on greet sends the same payload by DM; closed DMs do not throw; leave never DMs;
  10. a deleted channel (fetch rejects) gives `'no-channel'`/`'send-failed'` and does not throw;
  11. a partial member without `user` returns `'send-failed'`;
  12. the boost event handler fires only when `premiumSince` changes from null to a date and skips partial old members.

- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement** the four files and the moved card. In `card.js` nothing changes except the file path.
- [ ] **Step 4: Run** `npm test`. Expected: PASS. The old `src/features/welcome/` directory still exists and still works until Task 10.
- [ ] **Step 5: Commit** `feat: greet, leave and boost message sending`.

---

### Task 9: `/set` and `/test` commands

**Files:**
- Create: `src/features/greet/index.js`
- Modify: `src/modules.js` (add `greet`), locale files
- Test: `test/features/greet-config.test.js`, `test/features/greet-commands.test.js`

**Tier:** sonnet.

**Interfaces:**
- `config.js` (written here, used by the commands; all take `(db, guildId, kind, ...)` and are async):
  - `setChannel(db, guildId, kind, channelId): Promise<void>`: saves the channel, keeps an existing message or stores `DEFAULT_MESSAGE[kind]`, sets the feature `enabled: true`.
  - `applyMessage(db, guildId, kind, text): Promise<'disabled' | 'saved' | 'saved-needs-channel'>`: `none` or `disable` (trimmed, case-insensitive) sets `enabled: false` and keeps channel and message; any other text is stored; `enabled` becomes true only if a channel exists (otherwise `'saved-needs-channel'`).
  - `setCard(db, guildId, kind, on)`, `setBackground(db, guildId, kind, value | null)`, `setDm(db, guildId, kind, on)`.
  - `getKindConfig(db, guildId, kind)`: `{ enabled, config }`.
- Commands:
  - `/set` with subcommand groups `greet`, `leave`, `boost`. Each group has subcommands `channel` (channel option, text or announcement channel, required), `message` (optional string option `message`, max 2000), `card` (required string option `state` with choices `on` / `off`), `background` (optional string `source`, optional boolean `clear`), and, for `greet` and `boost` only, `dm` (`state` on/off).
  - `/test` with subcommands `greet`, `leave`, `boost`.
- Behaviour:
  - Every `/set` subcommand uses `guard(interaction, ctx, kind, { requireEnabled: false })`.
  - `message` without text shows a multi-line form (custom id `set:msg:<kind>`, prefilled with the current message, max 2000, required) through the component prefix `set`; a form submit calls `applyMessage` and replies like the slash path. A reply names the result: `greet.messageSaved`, `greet.messageDisabled`, or `greet.messageNeedsChannel`. If the saved text contains `{embed:name}` and that embed does not exist, add `greet.embedMissing` with the name to the reply (the message is still saved).
  - `background` with a stored image name checks `media_items` (reply `media.unknown` if missing); links and `clear` work like the old `/welcome image`; `source` is stored as the raw string.
  - `/test <kind>`: `guard(interaction, ctx, kind, { requireEnabled: false })`, defer ephemeral, `handleMember(ctx, interaction.member, kind)`, then reply `greet.testSent`, `greet.testOff` (mentions `/set <kind> channel`), `greet.testNoChannel` or `greet.testFailed`.
  - Component prefix `set`.

- [ ] **Step 1: Write the failing tests.** `test/features/greet-config.test.js` (real database):

```js
import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { setChannel, applyMessage, setCard, setBackground, setDm, getKindConfig } from '../../src/features/greet/config.js';
import { DEFAULT_MESSAGE } from '../../src/features/greet/kinds.js';
import { testDb } from '../helpers/db.js';

let db;
before(async () => { db = await testDb(); });
beforeEach(async () => { await db.query('TRUNCATE guild_settings'); });
after(async () => { await db.end(); });

test('setChannel turns the kind on with the default message', async () => {
  await setChannel(db, 'g1', 'greet', 'c1');
  const { enabled, config } = await getKindConfig(db, 'g1', 'greet');
  assert.equal(enabled, true);
  assert.equal(config.channelId, 'c1');
  assert.equal(config.message, DEFAULT_MESSAGE.greet);
});

test('setChannel keeps an existing message and each kind is independent', async () => {
  await applyMessage(db, 'g1', 'leave', 'bye {user_name}');
  await setChannel(db, 'g1', 'leave', 'c2');
  assert.equal((await getKindConfig(db, 'g1', 'leave')).config.message, 'bye {user_name}');
  assert.equal((await getKindConfig(db, 'g1', 'greet')).enabled, false);
});

test('applyMessage: none and disable turn only that kind off', async () => {
  await setChannel(db, 'g1', 'greet', 'c1');
  await setChannel(db, 'g1', 'boost', 'c3');
  assert.equal(await applyMessage(db, 'g1', 'greet', ' None '), 'disabled');
  assert.equal(await applyMessage(db, 'g1', 'boost', 'DISABLE'), 'disabled');
  assert.equal((await getKindConfig(db, 'g1', 'greet')).enabled, false);
  assert.equal((await getKindConfig(db, 'g1', 'greet')).config.channelId, 'c1');
});

test('applyMessage saves text; without a channel the kind stays off', async () => {
  assert.equal(await applyMessage(db, 'g1', 'greet', 'hello {user}'), 'saved-needs-channel');
  assert.equal((await getKindConfig(db, 'g1', 'greet')).enabled, false);
  await setChannel(db, 'g1', 'greet', 'c1');
  assert.equal(await applyMessage(db, 'g1', 'greet', 'hello again'), 'saved');
  const { enabled, config } = await getKindConfig(db, 'g1', 'greet');
  assert.equal(enabled, true);
  assert.equal(config.message, 'hello again');
});

test('card, background and dm settings are saved and cleared', async () => {
  await setChannel(db, 'g1', 'greet', 'c1');
  await setCard(db, 'g1', 'greet', true);
  await setBackground(db, 'g1', 'greet', 'logo');
  await setDm(db, 'g1', 'greet', true);
  let { config } = await getKindConfig(db, 'g1', 'greet');
  assert.deepEqual([config.card, config.background, config.dm], [true, 'logo', true]);
  await setBackground(db, 'g1', 'greet', null);
  ({ config } = await getKindConfig(db, 'g1', 'greet'));
  assert.equal(config.background, null);
  assert.equal(config.channelId, 'c1');
});
```

`test/features/greet-commands.test.js` (no database): check the command data. For `/set` and `/test`: `toJSON()` succeeds; `set` has groups `greet`, `leave`, `boost`; `greet` and `boost` groups include `dm`, `leave` does not; every group has `channel`, `message`, `card`, `background`; `test` has the three subcommands; the `message` option is not required; the form modal for `set:msg:greet` is valid in every language (labels and title at most 45 characters).

- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement** `config.js` and `index.js`. `setFeature` merges `config` at the top level only, which is correct here because the config is flat.
- [ ] **Step 4: Register** `greet` in `src/modules.js` (leave `welcome` registered for now; Task 10 removes it). Command names `set` and `test` must not collide with existing ones.
- [ ] **Step 5: Locale keys** (en, then ar and fr): `greet.channelSet` ("{kind} messages will be posted in {channel}."), `greet.messageSaved`, `greet.messageDisabled`, `greet.messageNeedsChannel`, `greet.embedMissing`, `greet.cardOn`, `greet.cardOff`, `greet.dmOn`, `greet.dmOff`, `greet.backgroundSaved`, `greet.backgroundCleared`, `greet.backgroundNeeded`, `greet.modalTitle`, `greet.messageLabel`, `greet.testSent`, `greet.testOff`, `greet.testNoChannel`, `greet.testFailed`, `greet.kind.greet` ("Greet"), `greet.kind.leave` ("Leave"), `greet.kind.boost` ("Boost").
- [ ] **Step 6: Run** `npm test` and the serialise check. Expected: PASS; the list contains `set` and `test`. **Step 7: Commit** `feat: /set and /test for greet, leave and boost messages`.

---

### Task 10: Remove the old pieces, wire modules, sweep locales, update README

**Files:**
- Delete: `src/features/welcome/` (all), `src/core/templates.js`, `test/core/templates.test.js`, `test/features/welcome-payload.test.js`, `test/features/welcome-events.test.js`
- Modify: `src/modules.js`, locale files, `README.md`
- Test: whole suite

**Tier:** sonnet.

- [ ] **Step 1:** In `src/modules.js` remove the `welcome` import and entry (keep `greet`).
- [ ] **Step 2:** Delete the files listed above. Search `src/` and `test/` for leftover imports of `core/templates`, `features/welcome`, `embeds/templates`, `embeds/drafts`, `embeds/send` and fix any.
- [ ] **Step 3: Locale sweep.** Write a throwaway script outside the repo that lists every key of `en.json` not referenced as a string literal in `src/`, and not covered by these dynamic patterns: `feature.${key}`, `${ns}.sent`, `${ns}.cannotSend`, `greet.kind.${kind}`, `embeds.err.*` (all produced by `validateEmbed`). Remove each unused key from `en.json`, `ar.json` and `fr.json`, except keys reserved for later phases. Report the removed keys in the commit message body.
- [ ] **Step 4: README.** Update the features list, command list and the "Manual check on a test server" checklist to the new commands: `/embed create name:rules`, the buttons, `/embed edit title ...`, `/embed show`, `/set greet channel`, `/set greet message` (with and without text), `{embed:name}`, `/test greet`, `/set greet card on`, `/set greet background`, `/set greet dm on`, `/set leave ...`, `/set boost ...`, and the always-available `/embed` and `/post`. Remove references to `/welcome`, `/embed enable`, `/post enable`, templates and the quick command.
- [ ] **Step 5: Run** `npm test`. Expected: PASS, no new console noise. Run the serialise check; expected list: `panel, language, media, embed, post, set, test, autorole, logging, info, userinfo, avatar, banner, serverinfo` (14 names; `welcome` gone).
- [ ] **Step 6: Commit** `refactor: remove welcome command and embed templates`.

---

### Task 11: Final offline verification

**Files:** none changed unless a defect is found.

**Tier:** sonnet.

- [ ] **Step 1:** `npm test`: all pass, output pristine except the known intentional warnings (list them in the report).
- [ ] **Step 2:** `node --check` on every file under `src/`; the serialise check prints the 14 names with no duplicates and no throw.
- [ ] **Step 3:** Search for leftovers: `welcome` (outside the README history and the `welcome.png`-free card code), `template`, `drafts`, `renderTemplate`. Report each hit and whether it is intended.
- [ ] **Step 4:** Confirm every literal key used in `t(` calls under `src/` exists in `en.json` (grep-based, as in the earlier plan's Task 15), and that `ar.json` and `fr.json` match `en.json` exactly.
- [ ] **Step 5:** Confirm `.env` is untracked, `package.json` has no `^` or `~`, and `git status` is clean.
- [ ] **Step 6:** The live checks on a real server are the owner's (they need a bot token). Make sure the README checklist covers: create an embed with the buttons, edit single parts, `/embed show`, greet, leave and boost messages with `{embed:name}` and placeholders, `/test` for each, the card, the DM, `none` turning one message off, and that `/embed` and `/post` work without any enable step.

---

## Self-review notes

- **Spec coverage (fifth round):** separate greet, leave and boost features and commands (7, 8, 9); `{embed:name}` (1, 8); named embeds with Mimu's commands and parts (2, 3, 5, 6); placeholders with Mimu's names plus old aliases (1); always-available embeds and post (7); extras: card, DM, fields (8, 9, 6).
- **Order and green tree:** Tasks 1 to 4 only add files. Task 5 removes the old embed builder files and keeps `post` compiling through temporary imports; Task 7 removes `/post embed`. The old `welcome` module keeps working until Task 10 removes it, so the suite stays green after every task.
- **Not changed:** logging, auto role, info, media, language, panel manager-role rules, boot hardening.
- **Known open point (my call):** `/set greet channel` re-enables a kind that was turned off with `none`, and keeps its stored message.

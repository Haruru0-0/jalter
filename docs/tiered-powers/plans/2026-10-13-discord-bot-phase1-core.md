# Jalter (Discord Bot), Phase 1 (Core) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use tiered-powers:subagent-driven-development (recommended) or tiered-powers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A working Discord bot with per-server feature toggles (everything off by default), a `/panel` overview, three languages, and the Phase 1 features: media storage, embed builder, post message, welcome/leave/boost messages, auto role, logging, and info commands.

**Architecture:** One Node.js process. Slash commands and component interactions are routed from a registry built from feature modules. Each feature lives in `src/features/<name>/index.js` and exports `{ commands, events }`. Every handler first checks the feature is enabled for that guild. All settings live in PostgreSQL (Docker) as one row per guild per feature (`enabled` plus a JSONB `config`). All database calls are asynchronous.

**Tech Stack:** Node.js 22 LTS (pinned), ES modules, discord.js v14 (exact version), `pg`, Docker Compose for Postgres, @napi-rs/canvas with bundled Noto fonts, `node:test`.

**Spec:** `docs/tiered-powers/specs/2026-10-13-discord-bot-design.md` (Phase 1 only. Phases 2-5 get their own plans.)

**Branching:** Phase 1 is built on branch `phase-1`. Phase 2 starts with `git switch -c phase-2` from `phase-1`, so `phase-2` holds Phases 1 and 2, and so on. Commit only on the current phase's branch.

**Code in this plan is untested.** It was written without running it. Each step that runs a test or command says what the result should be. If the real result differs, fix the code, not the expectation, unless the expectation contradicts the spec.

## Global Constraints

- JavaScript (Node.js) with discord.js and PostgreSQL (owner's choice, run in Docker for now). Storage stays behind `src/db/`; pure logic modules never import discord.js. Every database function returns a Promise and every caller awaits it.
- Pin Node (`.nvmrc` and `engines`) and exact versions of discord.js, `pg`, @napi-rs/canvas, dotenv (`npm install --save-exact`).
- Everything is configured inside Discord. No website.
- **Every feature is off by default**, commands included. An admin turns each on from its own setup command or `enable` subcommand. Exception (my call): `/panel` and `/language` are core and always available, because nothing else can be configured without them.
- Setup access: the Manage Server permission, or the "bot manager" role set with `/panel manager-role`. Never require full Administrator. Setup and panel replies are ephemeral.
- Languages: `en`, `ar`, `fr`, per server. Missing keys fall back to English. A test enforces that `ar.json` and `fr.json` contain every key in `en.json`.
- Secrets (`DISCORD_TOKEN`, `CLIENT_ID`) come from `.env`; never commit it.
- Intents: Guilds, GuildMembers, GuildMessages, MessageContent. Partials: Message, Channel (so edits and deletes of uncached messages still log).
- Messages built from user text must set `allowedMentions` so they cannot ping `@everyone`/`@here`.
- Voice logging is not requested. Do not build it.
- Images come from an external URL or from the media storage channel (admin's choice per use). Never store a raw Discord attachment URL; store channel and message IDs and fetch a fresh URL on use.
- Tests run with `node --test --test-concurrency=1` (they share one test database).

## Review Focus

1. A configured channel is deleted, or the bot cannot send there: the feature warns and skips instead of crashing (Task 4 `trySend`/`fetchSendable`, Task 11, Task 13).
2. An embed exceeds Discord's limits: the admin sees a clear error and nothing is sent (Task 8).
3. A stored image's message was deleted: a clear error, no embed with a broken image (Task 7).
4. The log channel feeds itself: log-channel events and bot messages are ignored (Task 13).
5. A translation key is missing in `ar`/`fr`: English text is shown, never `undefined` or the raw key (Task 3).

## File Structure

```
jalter/
  package.json, .nvmrc, .env.example, .gitignore, README.md
  docker-compose.yml, docker/init-databases.sql
  assets/fonts/NotoSans-Regular.ttf, NotoSansArabic-Regular.ttf
  src/
    index.js  deploy-commands.js  config.js  modules.js
    db/index.js  db/settings.js  db/migrations/001_init.sql
    i18n/index.js  en.json  ar.json  fr.json
    core/registry.js  permissions.js  mentions.js  replies.js
         guard.js  toggle.js  send.js  loader.js  templates.js
    features/
      panel/  language/  media/  embeds/  post/
      welcome/  autorole/  logging/  info/
  test/  (mirrors src/, plus helpers/db.js)
```

Every feature module exports `commands` (array) and `events` (array):
- command: `{ data: SlashCommandBuilder, execute(interaction, ctx), components?: { prefix: string, handle(interaction, ctx) } }`
- event: `{ name: string, once?: boolean, execute(ctx, ...args) }`
- `ctx` is `{ db: Pool, client: Client }`

---

### Task 1: Scaffold, config, Postgres in Docker

**Files:**
- Create: `package.json`, `.nvmrc`, `.env.example`, `.gitignore`, `docker-compose.yml`, `docker/init-databases.sql`, `src/config.js`, `test/helpers/db.js`
- Test: `test/config.test.js`

**Tier:** sonnet, small but sets conventions every later task relies on.

**Interfaces:**
- Produces: `loadConfig(env = process.env): { token: string, clientId: string, devGuildId: string | null, databaseUrl: string }`

- [ ] **Step 1: Create the repo and branch.** In the project folder `C:\Users\ahmad\Documents\GitHub\jalter` (already created; the docs are in it):

```bash
git init
git switch -c phase-1
node --version   # note the LTS version for .nvmrc, must be 22.x
npm init -y
npm install --save-exact discord.js pg @napi-rs/canvas dotenv
```

Then edit `package.json` so it contains:

```json
{
  "name": "jalter",
  "private": true,
  "type": "module",
  "engines": { "node": ">=22" },
  "scripts": {
    "start": "node src/index.js",
    "deploy": "node src/deploy-commands.js",
    "db:up": "docker compose up -d",
    "test": "node --test --test-concurrency=1"
  }
}
```

(Keep the `dependencies` block that npm wrote. Write the major version you are running, for example `22`, into `.nvmrc`.)

- [ ] **Step 2: Add Postgres.** `docker-compose.yml`:

```yaml
services:
  postgres:
    image: postgres:16
    environment:
      POSTGRES_USER: bot
      POSTGRES_PASSWORD: bot
      POSTGRES_DB: bot
    ports:
      - "5432:5432"
    volumes:
      - pgdata:/var/lib/postgresql/data
      - ./docker/init-databases.sql:/docker-entrypoint-initdb.d/init.sql:ro
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U bot -d bot"]
      interval: 5s
      retries: 10
volumes:
  pgdata:
```

`docker/init-databases.sql`:

```sql
CREATE DATABASE bot_test;
```

`.env.example`:

```
DISCORD_TOKEN=
CLIENT_ID=
DEV_GUILD_ID=
DATABASE_URL=postgres://bot:bot@localhost:5432/bot
```

`.gitignore`:

```
node_modules
.env
```

- [ ] **Step 3: Verify Postgres.** Run `docker compose up -d`, wait ~10 seconds, then:

```bash
docker compose exec postgres psql -U bot -d bot_test -c "select 1"
```

Expected: a table showing `1`. If the `bot_test` database is missing, run `docker compose down -v` and `docker compose up -d` again (init scripts only run on a fresh volume).

- [ ] **Step 4: Write the failing test** `test/config.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../src/config.js';

test('loadConfig returns values and defaults', () => {
  const cfg = loadConfig({ DISCORD_TOKEN: 't', CLIENT_ID: 'c' });
  assert.equal(cfg.token, 't');
  assert.equal(cfg.clientId, 'c');
  assert.equal(cfg.devGuildId, null);
  assert.match(cfg.databaseUrl, /\/bot$/);
});

test('loadConfig names the missing variable', () => {
  assert.throws(() => loadConfig({ CLIENT_ID: 'c' }), /DISCORD_TOKEN/);
  assert.throws(() => loadConfig({ DISCORD_TOKEN: 't' }), /CLIENT_ID/);
});
```

- [ ] **Step 5: Run** `npm test`. Expected: FAIL (cannot find `src/config.js`).

- [ ] **Step 6: Implement** `src/config.js`:

```js
export function loadConfig(env = process.env) {
  for (const key of ['DISCORD_TOKEN', 'CLIENT_ID']) {
    if (!env[key]) throw new Error(`Missing environment variable ${key}`);
  }
  return {
    token: env.DISCORD_TOKEN,
    clientId: env.CLIENT_ID,
    devGuildId: env.DEV_GUILD_ID || null,
    databaseUrl: env.DATABASE_URL || 'postgres://bot:bot@localhost:5432/bot',
  };
}
```

- [ ] **Step 7: Run** `npm test`. Expected: PASS (2 tests).

- [ ] **Step 8: Commit.**

```bash
git add -A
git commit -m "chore: scaffold project, config loader, postgres compose file"
```

---

### Task 2: Database and settings store

**Files:**
- Create: `src/db/index.js`, `src/db/settings.js`, `src/db/migrations/001_init.sql`
- Test: `test/db/settings.test.js`; the helper `test/helpers/db.js` is created in this task.

**Tier:** sonnet, migrations and concurrency.

**Interfaces:**
- Produces:
  - `openDb(databaseUrl: string): Promise<pg.Pool>` runs unapplied migrations in filename order, each in a transaction, tracked in `schema_version`.
  - `resetDb(pool): Promise<void>` truncates all tables (tests only).
  - `getFeature(db, guildId, key): Promise<{ enabled: boolean, config: object }>`
  - `setFeature(db, guildId, key, patch: { enabled?: boolean, config?: object }): Promise<void>` upsert; `config` is merged with JSONB `||` in one statement.
  - `listFeatures(db, guildId): Promise<Map<string, { enabled: boolean, config: object }>>`
  - `testDb(): Promise<Pool>` in `test/helpers/db.js` opens `bot_test` and resets it.

- [ ] **Step 1: Write the migration** `src/db/migrations/001_init.sql`:

```sql
CREATE TABLE guild_settings (
  guild_id TEXT NOT NULL,
  feature  TEXT NOT NULL,
  enabled  BOOLEAN NOT NULL DEFAULT false,
  config   JSONB NOT NULL DEFAULT '{}',
  PRIMARY KEY (guild_id, feature)
);

CREATE TABLE embed_templates (
  id       SERIAL PRIMARY KEY,
  guild_id TEXT NOT NULL,
  name     TEXT NOT NULL,
  json     JSONB NOT NULL,
  UNIQUE (guild_id, name)
);

CREATE TABLE media_items (
  id               SERIAL PRIMARY KEY,
  guild_id         TEXT NOT NULL,
  name             TEXT NOT NULL,
  channel_id       TEXT NOT NULL,
  message_id       TEXT NOT NULL,
  attachment_index INTEGER NOT NULL DEFAULT 0,
  UNIQUE (guild_id, name)
);
```

- [ ] **Step 2: Test helper** `test/helpers/db.js`:

```js
import { openDb, resetDb } from '../../src/db/index.js';

export const TEST_DB_URL =
  process.env.TEST_DATABASE_URL ?? 'postgres://bot:bot@localhost:5432/bot_test';

export async function testDb() {
  const db = await openDb(TEST_DB_URL);
  await resetDb(db);
  return db;
}
```

- [ ] **Step 3: Write the failing test** `test/db/settings.test.js`:

```js
import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../../src/db/index.js';
import { getFeature, setFeature, listFeatures } from '../../src/db/settings.js';
import { testDb, TEST_DB_URL } from '../helpers/db.js';

let db;
before(async () => { db = await testDb(); });
beforeEach(async () => { await db.query('TRUNCATE guild_settings'); });
after(async () => { await db.end(); });

test('getFeature on an empty db is disabled with empty config', async () => {
  assert.deepEqual(await getFeature(db, 'g1', 'welcome'), { enabled: false, config: {} });
});

test('setFeature enables a feature', async () => {
  await setFeature(db, 'g1', 'welcome', { enabled: true });
  assert.equal((await getFeature(db, 'g1', 'welcome')).enabled, true);
});

test('setFeature merges config across calls', async () => {
  await setFeature(db, 'g1', 'x', { config: { a: 1 } });
  await setFeature(db, 'g1', 'x', { config: { b: 2 } });
  assert.deepEqual((await getFeature(db, 'g1', 'x')).config, { a: 1, b: 2 });
});

test('setFeature without enabled keeps the existing enabled value', async () => {
  await setFeature(db, 'g1', 'x', { enabled: true });
  await setFeature(db, 'g1', 'x', { config: { a: 1 } });
  assert.equal((await getFeature(db, 'g1', 'x')).enabled, true);
});

test('guilds do not leak into each other', async () => {
  await setFeature(db, 'g1', 'x', { enabled: true });
  assert.equal((await getFeature(db, 'g2', 'x')).enabled, false);
});

test('parallel setFeature calls keep both keys', async () => {
  await Promise.all([
    setFeature(db, 'g1', 'x', { config: { a: 1 } }),
    setFeature(db, 'g1', 'x', { config: { b: 2 } }),
  ]);
  assert.deepEqual((await getFeature(db, 'g1', 'x')).config, { a: 1, b: 2 });
});

test('listFeatures returns a map of all features for a guild', async () => {
  await setFeature(db, 'g1', 'a', { enabled: true });
  await setFeature(db, 'g1', 'b', { config: { k: 1 } });
  const map = await listFeatures(db, 'g1');
  assert.equal(map.get('a').enabled, true);
  assert.deepEqual(map.get('b').config, { k: 1 });
});

test('openDb twice does not re-apply migrations', async () => {
  const again = await openDb(TEST_DB_URL);
  const { rows } = await again.query('SELECT count(*)::int AS n FROM schema_version');
  assert.equal(rows[0].n, 1);
  await again.end();
});
```

- [ ] **Step 4: Run** `npm test`. Expected: FAIL (modules missing).

- [ ] **Step 5: Implement** `src/db/index.js`:

```js
import pg from 'pg';
import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const MIGRATIONS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'migrations');

export async function openDb(databaseUrl) {
  const pool = new pg.Pool({ connectionString: databaseUrl });
  await pool.query('CREATE TABLE IF NOT EXISTS schema_version (name TEXT PRIMARY KEY)');
  const done = new Set(
    (await pool.query('SELECT name FROM schema_version')).rows.map((r) => r.name),
  );
  const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith('.sql')).sort();
  for (const file of files) {
    if (done.has(file)) continue;
    const sql = await readFile(path.join(MIGRATIONS_DIR, file), 'utf8');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(sql);
      await client.query('INSERT INTO schema_version (name) VALUES ($1)', [file]);
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }
  return pool;
}

export async function resetDb(pool) {
  await pool.query(
    'TRUNCATE guild_settings, embed_templates, media_items RESTART IDENTITY',
  );
}
```

`src/db/settings.js`:

```js
export async function getFeature(db, guildId, key) {
  const { rows } = await db.query(
    'SELECT enabled, config FROM guild_settings WHERE guild_id = $1 AND feature = $2',
    [guildId, key],
  );
  return rows[0]
    ? { enabled: rows[0].enabled, config: rows[0].config }
    : { enabled: false, config: {} };
}

export async function setFeature(db, guildId, key, patch) {
  await db.query(
    `INSERT INTO guild_settings (guild_id, feature, enabled, config)
     VALUES ($1, $2, COALESCE($3::boolean, false), $4::jsonb)
     ON CONFLICT (guild_id, feature) DO UPDATE SET
       enabled = COALESCE($3::boolean, guild_settings.enabled),
       config  = guild_settings.config || $4::jsonb`,
    [guildId, key, patch.enabled ?? null, JSON.stringify(patch.config ?? {})],
  );
}

export async function listFeatures(db, guildId) {
  const { rows } = await db.query(
    'SELECT feature, enabled, config FROM guild_settings WHERE guild_id = $1',
    [guildId],
  );
  return new Map(rows.map((r) => [r.feature, { enabled: r.enabled, config: r.config }]));
}
```

- [ ] **Step 6: Run** `npm test`. Expected: PASS (all tests, including Task 1's).

- [ ] **Step 7: Commit** `feat: postgres store with per-guild feature settings`.

---

### Task 3: Internationalization

**Files:**
- Create: `src/i18n/index.js`, `src/i18n/en.json`, `ar.json`, `fr.json`
- Test: `test/i18n.test.js`

**Tier:** sonnet.

**Interfaces:**
- Consumes: `getFeature`.
- Produces:
  - `createT(strings: Record<lang, Record<key, string>>): (lang, key, vars?) => string`
  - `t(lang, key, vars?)` using the real files. Lookup order: requested language, English, the key itself. `{name}` placeholders are replaced; unknown placeholders are left as written.
  - `getLang(db, guildId): Promise<'en'|'ar'|'fr'>`, default `'en'`.
  - `isRtl(lang): boolean`.
  - **Convention for all later tasks:** locale files are flat key to string maps. Each task lists the `en` keys it adds; you add the same keys translated to `ar.json` and `fr.json`. The coverage test below fails until you do.

- [ ] **Step 1: Seed the locale files.** `src/i18n/en.json`:

```json
{
  "common.on": "On",
  "common.off": "Off",
  "common.enabledMsg": "{feature} is now on.",
  "common.disabledMsg": "{feature} is now off.",
  "common.featureOff": "This feature is off. A manager can turn it on with {command}.",
  "common.notAllowed": "You need the Manage Server permission or the bot manager role.",
  "common.guildOnly": "This command only works in a server.",
  "common.saved": "Saved.",
  "common.error": "Something went wrong. Please try again."
}
```

`src/i18n/ar.json`:

```json
{
  "common.on": "مفعّل",
  "common.off": "معطّل",
  "common.enabledMsg": "تم تفعيل {feature}.",
  "common.disabledMsg": "تم تعطيل {feature}.",
  "common.featureOff": "هذه الميزة معطّلة. يمكن للمدير تفعيلها بالأمر {command}.",
  "common.notAllowed": "تحتاج إلى صلاحية إدارة الخادم أو رتبة مدير البوت.",
  "common.guildOnly": "هذا الأمر يعمل داخل الخادم فقط.",
  "common.saved": "تم الحفظ.",
  "common.error": "حدث خطأ ما. حاول مرة أخرى."
}
```

`src/i18n/fr.json`:

```json
{
  "common.on": "Activé",
  "common.off": "Désactivé",
  "common.enabledMsg": "{feature} est maintenant activé.",
  "common.disabledMsg": "{feature} est maintenant désactivé.",
  "common.featureOff": "Cette fonctionnalité est désactivée. Un gestionnaire peut l'activer avec {command}.",
  "common.notAllowed": "Il vous faut la permission Gérer le serveur ou le rôle de gestionnaire du bot.",
  "common.guildOnly": "Cette commande ne fonctionne que dans un serveur.",
  "common.saved": "Enregistré.",
  "common.error": "Une erreur s'est produite. Veuillez réessayer."
}
```

- [ ] **Step 2: Write the failing test** `test/i18n.test.js`:

```js
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { t, createT, getLang, isRtl } from '../src/i18n/index.js';
import { setFeature } from '../src/db/settings.js';
import { testDb } from './helpers/db.js';

let db;
before(async () => { db = await testDb(); });
after(async () => { await db.end(); });

test('t returns each language', () => {
  assert.equal(t('en', 'common.on'), 'On');
  assert.equal(t('fr', 'common.on'), 'Activé');
  assert.equal(t('ar', 'common.on'), 'مفعّل');
});

test('missing translation falls back to English, then to the key', () => {
  const tt = createT({ en: { only: 'English only' }, ar: {}, fr: {} });
  assert.equal(tt('ar', 'only'), 'English only');
  assert.equal(tt('ar', 'nope'), 'nope');
});

test('placeholders are substituted, unknown ones kept', () => {
  const tt = createT({ en: { k: 'Hi {name} {other}' }, ar: {}, fr: {} });
  assert.equal(tt('en', 'k', { name: 'Sam' }), 'Hi Sam {other}');
});

test('getLang defaults to en and reads the saved language', async () => {
  assert.equal(await getLang(db, 'g1'), 'en');
  await setFeature(db, 'g1', 'language', { config: { lang: 'fr' } });
  assert.equal(await getLang(db, 'g1'), 'fr');
  await setFeature(db, 'g2', 'language', { config: { lang: 'xx' } });
  assert.equal(await getLang(db, 'g2'), 'en');
});

test('isRtl is true only for Arabic', () => {
  assert.equal(isRtl('ar'), true);
  assert.equal(isRtl('en'), false);
});

test('ar.json and fr.json contain every key in en.json', () => {
  const load = (l) => JSON.parse(readFileSync(new URL(`../src/i18n/${l}.json`, import.meta.url), 'utf8'));
  const en = Object.keys(load('en'));
  for (const lang of ['ar', 'fr']) {
    const keys = new Set(Object.keys(load(lang)));
    const missing = en.filter((k) => !keys.has(k));
    assert.deepEqual(missing, [], `${lang}.json is missing keys`);
  }
});
```

- [ ] **Step 3: Run** `npm test`. Expected: FAIL.

- [ ] **Step 4: Implement** `src/i18n/index.js`:

```js
import { readFileSync } from 'node:fs';
import { getFeature } from '../db/settings.js';

const load = (lang) =>
  JSON.parse(readFileSync(new URL(`./${lang}.json`, import.meta.url), 'utf8'));

export const LANGS = ['en', 'ar', 'fr'];
const STRINGS = Object.fromEntries(LANGS.map((l) => [l, load(l)]));

export function createT(strings) {
  return (lang, key, vars = {}) => {
    const text = strings[lang]?.[key] ?? strings.en?.[key] ?? key;
    return text.replace(/\{(\w+)\}/g, (match, name) =>
      name in vars ? String(vars[name]) : match,
    );
  };
}

export const t = createT(STRINGS);

export async function getLang(db, guildId) {
  const { config } = await getFeature(db, guildId, 'language');
  return LANGS.includes(config.lang) ? config.lang : 'en';
}

export const isRtl = (lang) => lang === 'ar';
```

- [ ] **Step 5: Run** `npm test`. Expected: PASS.
- [ ] **Step 6: Commit** `feat: i18n with english fallback and key coverage test`.

---

### Task 4: Registry, permissions, mentions, replies, guard, toggle, send helpers

**Files:**
- Create: `src/core/registry.js`, `permissions.js`, `mentions.js`, `replies.js`, `guard.js`, `toggle.js`, `send.js`
- Test: `test/core/registry.test.js`, `test/core/permissions.test.js`, `test/core/mentions.test.js`, `test/core/guard.test.js`, `test/core/send.test.js`
- Modify: `src/i18n/*.json` (feature names)

**Tier:** sonnet.

**Interfaces:**
- Consumes: `getFeature`, `setFeature`, `getLang`, `t`.
- Produces:
  - `FEATURES: Array<{ key, nameKey, phase, command, alwaysOn? }>`; `isEnabled(db, guildId, key): Promise<boolean>`
  - `canManage(db, member): Promise<boolean>`
  - `safeMentions(roleIds: string[] = []): { parse: [], roles?: string[] }`; `extractRoleIds(text): string[]`
  - `ephemeral(content: string | object): object` adds `flags: MessageFlags.Ephemeral`
  - `guard(interaction, ctx, key, opts?): Promise<'en'|'ar'|'fr'|null>` replies and returns `null` when the user is not allowed or the feature is off; otherwise returns the guild language. Options `{ requireManager = true, requireEnabled = true }`.
  - `handleToggle(interaction, ctx, key): Promise<void>` and `toggleSubcommands(builder): builder` (adds `enable` and `disable` subcommands)
  - `trySend(channel, payload): Promise<Message | null>`; `fetchSendable(client, channelId): Promise<Channel | null>`

- [ ] **Step 1: Write the failing tests.**

`test/core/registry.test.js`:

```js
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { FEATURES, isEnabled } from '../../src/core/registry.js';
import { setFeature } from '../../src/db/settings.js';
import { testDb } from '../helpers/db.js';

let db;
before(async () => { db = await testDb(); });
after(async () => { await db.end(); });

test('FEATURES has unique keys and covers all phase 1 features', () => {
  const keys = FEATURES.map((f) => f.key);
  assert.equal(new Set(keys).size, keys.length);
  for (const k of ['panel', 'language', 'media', 'embeds', 'post', 'welcome', 'autorole', 'logging', 'info']) {
    assert.ok(keys.includes(k), k);
  }
});

test('isEnabled is false by default and true after enabling', async () => {
  assert.equal(await isEnabled(db, 'g1', 'welcome'), false);
  await setFeature(db, 'g1', 'welcome', { enabled: true });
  assert.equal(await isEnabled(db, 'g1', 'welcome'), true);
});
```

`test/core/permissions.test.js`:

```js
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { canManage } from '../../src/core/permissions.js';
import { setFeature } from '../../src/db/settings.js';
import { testDb } from '../helpers/db.js';

let db;
before(async () => { db = await testDb(); });
after(async () => { await db.end(); });

const member = ({ manage = false, roles = [] } = {}) => ({
  guild: { id: 'g1' },
  permissions: { has: (p) => manage && p === 'ManageGuild' },
  roles: { cache: { has: (id) => roles.includes(id) } },
});

test('Manage Server can manage', async () => {
  assert.equal(await canManage(db, member({ manage: true })), true);
});

test('a plain member cannot', async () => {
  assert.equal(await canManage(db, member()), false);
});

test('the configured manager role can; other roles cannot', async () => {
  await setFeature(db, 'g1', 'panel', { config: { managerRoleId: 'R1' } });
  assert.equal(await canManage(db, member({ roles: ['R1'] })), true);
  assert.equal(await canManage(db, member({ roles: ['R2'] })), false);
});
```

`test/core/mentions.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { safeMentions, extractRoleIds } from '../../src/core/mentions.js';

test('safeMentions parses nothing by default', () => {
  assert.deepEqual(safeMentions(), { parse: [] });
});

test('safeMentions allows only the listed roles', () => {
  assert.deepEqual(safeMentions(['1', '2']), { parse: [], roles: ['1', '2'] });
});

test('extractRoleIds finds role mentions and ignores everyone/here', () => {
  assert.deepEqual(extractRoleIds('hi <@&123> and <@&456> @everyone @here'), ['123', '456']);
});
```

`test/core/guard.test.js`:

```js
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { guard } from '../../src/core/guard.js';
import { setFeature } from '../../src/db/settings.js';
import { testDb } from '../helpers/db.js';

let db;
before(async () => { db = await testDb(); });
after(async () => { await db.end(); });

function fakeInteraction({ manage }) {
  const replies = [];
  return {
    replies,
    guildId: 'g1',
    inGuild: () => true,
    member: {
      guild: { id: 'g1' },
      permissions: { has: () => manage },
      roles: { cache: { has: () => false } },
    },
    reply: async (o) => { replies.push(o); },
  };
}

test('guard refuses a non-manager with an ephemeral message', async () => {
  const i = fakeInteraction({ manage: false });
  assert.equal(await guard(i, { db }, 'welcome'), null);
  assert.match(i.replies[0].content, /Manage Server/);
  assert.ok(i.replies[0].flags);
});

test('guard refuses when the feature is off and names the enable command', async () => {
  const i = fakeInteraction({ manage: true });
  assert.equal(await guard(i, { db }, 'welcome'), null);
  assert.match(i.replies[0].content, /\/welcome enable/);
});

test('guard returns the language when allowed and enabled', async () => {
  await setFeature(db, 'g1', 'welcome', { enabled: true });
  const i = fakeInteraction({ manage: true });
  assert.equal(await guard(i, { db }, 'welcome'), 'en');
  assert.equal(i.replies.length, 0);
});

test('requireEnabled:false lets a manager through while the feature is off', async () => {
  const i = fakeInteraction({ manage: true });
  assert.equal(await guard(i, { db }, 'media', { requireEnabled: false }), 'en');
});
```

`test/core/send.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { trySend, fetchSendable } from '../../src/core/send.js';

test('trySend returns the message on success', async () => {
  const msg = { id: 'm' };
  assert.equal(await trySend({ send: async () => msg }, { content: 'x' }), msg);
});

test('trySend returns null instead of throwing when sending fails', async () => {
  const ch = { send: async () => { throw Object.assign(new Error('Missing Permissions'), { code: 50013 }); } };
  assert.equal(await trySend(ch, { content: 'x' }), null);
});

test('fetchSendable returns null for a missing id, a deleted channel, or a non-text channel', async () => {
  const client = (fn) => ({ channels: { fetch: fn } });
  assert.equal(await fetchSendable(client(async () => null), undefined), null);
  assert.equal(await fetchSendable(client(async () => { throw new Error('Unknown Channel'); }), '1'), null);
  assert.equal(await fetchSendable(client(async () => ({ isTextBased: () => false })), '1'), null);
});

test('fetchSendable returns a text channel', async () => {
  const ch = { isTextBased: () => true };
  assert.equal(await fetchSendable({ channels: { fetch: async () => ch } }, '1'), ch);
});
```

- [ ] **Step 2: Run** `npm test`. Expected: FAIL.

- [ ] **Step 3: Implement.**

`src/core/registry.js`:

```js
import { getFeature } from '../db/settings.js';

const f = (key, phase, command, extra = {}) => ({
  key, nameKey: `feature.${key}`, phase, command, ...extra,
});

export const FEATURES = [
  f('panel', 1, 'panel', { alwaysOn: true }),
  f('language', 1, 'language', { alwaysOn: true }),
  f('media', 1, 'media'),
  f('embeds', 1, 'embed'),
  f('post', 1, 'post'),
  f('welcome', 1, 'welcome'),
  f('autorole', 1, 'autorole'),
  f('logging', 1, 'logging'),
  f('info', 1, 'info'),
  f('moderation', 2, null), f('automod', 2, null), f('antiraid', 2, null),
  f('verification', 2, null), f('stickyroles', 2, null),
  f('autoresponder', 3, null), f('reactionroles', 3, null), f('quote', 3, null),
  f('leveling', 4, null), f('tickets', 4, null), f('reminders', 4, null),
  f('birthdays', 4, null), f('confessions', 4, null), f('starboard', 4, null),
  f('afk', 4, null), f('statschannels', 4, null),
  f('backup', 5, null), f('translate', 5, null),
];

export async function isEnabled(db, guildId, key) {
  return (await getFeature(db, guildId, key)).enabled;
}
```

`src/core/permissions.js`:

```js
import { getFeature } from '../db/settings.js';

export async function canManage(db, member) {
  if (member.permissions.has('ManageGuild')) return true;
  const { config } = await getFeature(db, member.guild.id, 'panel');
  return Boolean(config.managerRoleId) && member.roles.cache.has(config.managerRoleId);
}
```

`src/core/mentions.js`:

```js
export function safeMentions(roleIds = []) {
  return roleIds.length ? { parse: [], roles: roleIds } : { parse: [] };
}

export function extractRoleIds(text) {
  return [...text.matchAll(/<@&(\d+)>/g)].map((m) => m[1]);
}
```

`src/core/replies.js`:

```js
import { MessageFlags } from 'discord.js';

export function ephemeral(content) {
  const body = typeof content === 'string' ? { content } : content;
  return { ...body, flags: MessageFlags.Ephemeral };
}
```

`src/core/guard.js`:

```js
import { getLang, t } from '../i18n/index.js';
import { canManage } from './permissions.js';
import { isEnabled, FEATURES } from './registry.js';
import { ephemeral } from './replies.js';

export async function guard(interaction, ctx, key, { requireManager = true, requireEnabled = true } = {}) {
  const lang = interaction.guildId ? await getLang(ctx.db, interaction.guildId) : 'en';
  if (!interaction.inGuild()) {
    await interaction.reply(ephemeral(t(lang, 'common.guildOnly')));
    return null;
  }
  if (requireManager && !(await canManage(ctx.db, interaction.member))) {
    await interaction.reply(ephemeral(t(lang, 'common.notAllowed')));
    return null;
  }
  if (requireEnabled && !(await isEnabled(ctx.db, interaction.guildId, key))) {
    const command = FEATURES.find((f) => f.key === key)?.command ?? key;
    await interaction.reply(ephemeral(t(lang, 'common.featureOff', { command: `/${command} enable` })));
    return null;
  }
  return lang;
}
```

`src/core/toggle.js`:

```js
import { setFeature } from '../db/settings.js';
import { t } from '../i18n/index.js';
import { guard } from './guard.js';
import { ephemeral } from './replies.js';

export function toggleSubcommands(builder) {
  return builder
    .addSubcommand((s) => s.setName('enable').setDescription('Turn this feature on'))
    .addSubcommand((s) => s.setName('disable').setDescription('Turn this feature off'));
}

export async function handleToggle(interaction, ctx, key) {
  const lang = await guard(interaction, ctx, key, { requireEnabled: false });
  if (!lang) return;
  const on = interaction.options.getSubcommand() === 'enable';
  await setFeature(ctx.db, interaction.guildId, key, { enabled: on });
  const msgKey = on ? 'common.enabledMsg' : 'common.disabledMsg';
  await interaction.reply(ephemeral(t(lang, msgKey, { feature: t(lang, `feature.${key}`) })));
}
```

`src/core/send.js`:

```js
export async function trySend(channel, payload) {
  try {
    return await channel.send(payload);
  } catch (err) {
    console.warn(`Could not send message: ${err.code ?? ''} ${err.message}`);
    return null;
  }
}

export async function fetchSendable(client, channelId) {
  if (!channelId) return null;
  try {
    const channel = await client.channels.fetch(channelId);
    return channel?.isTextBased() ? channel : null;
  } catch {
    return null;
  }
}
```

- [ ] **Step 4: Add feature names to the locale files.** Add to `en.json`:

```json
"feature.panel": "Panel", "feature.language": "Language", "feature.media": "Media storage",
"feature.embeds": "Embeds", "feature.post": "Post message", "feature.welcome": "Welcome and leave",
"feature.autorole": "Auto role", "feature.logging": "Logging", "feature.info": "Info commands",
"feature.moderation": "Moderation", "feature.automod": "Auto-mod", "feature.antiraid": "Anti-raid",
"feature.verification": "Verification", "feature.stickyroles": "Sticky roles",
"feature.autoresponder": "Autoresponder", "feature.reactionroles": "Reaction roles", "feature.quote": "Quote",
"feature.leveling": "Leveling", "feature.tickets": "Tickets", "feature.reminders": "Reminders",
"feature.birthdays": "Birthdays", "feature.confessions": "Confessions", "feature.starboard": "Starboard",
"feature.afk": "AFK", "feature.statschannels": "Stats channels", "feature.backup": "Backup and restore",
"feature.translate": "Translate"
```

Add the same keys, translated, to `ar.json` and `fr.json`.

- [ ] **Step 5: Run** `npm test`. Expected: PASS.
- [ ] **Step 6: Commit** `feat: registry, permission gate, guard, toggle and send helpers`.

---

### Task 5: Module loader, interaction router, boot scripts

**Files:**
- Create: `src/core/loader.js`, `src/modules.js`, `src/index.js`, `src/deploy-commands.js`
- Test: `test/core/loader.test.js`

**Tier:** sonnet, wiring across modules.

**Interfaces:**
- Consumes: `getLang`, `t`, `ephemeral`.
- Produces:
  - `collectModules(modules): { commands: Map, components: Map, events: object[] }`. Throws on duplicate command names or component prefixes.
  - `routeInteraction(interaction, ctx, registry): Promise<void>`. Component ids look like `prefix:rest`. Errors are logged and answered with an ephemeral `common.error`; the function never rejects.
  - `src/modules.js` default-exports nothing; it exports `modules`, an array of the feature module namespaces. In this task the array is empty and each later task adds its module.

- [ ] **Step 1: Write the failing test** `test/core/loader.test.js`:

```js
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { collectModules, routeInteraction } from '../../src/core/loader.js';
import { testDb } from '../helpers/db.js';

let db;
before(async () => { db = await testDb(); });
after(async () => { await db.end(); });

const cmd = (name, extra = {}) => ({ data: { name }, execute: async () => {}, ...extra });

test('collectModules rejects duplicate command names', () => {
  assert.throws(
    () => collectModules([{ commands: [cmd('a')] }, { commands: [cmd('a')] }]),
    /Duplicate command/,
  );
});

test('collectModules rejects duplicate component prefixes', () => {
  const c = (n) => cmd(n, { components: { prefix: 'p', handle: async () => {} } });
  assert.throws(() => collectModules([{ commands: [c('a'), c('b')] }]), /Duplicate component/);
});

test('collectModules gathers events', () => {
  const r = collectModules([{ events: [{ name: 'x' }] }, { events: [{ name: 'y' }] }]);
  assert.equal(r.events.length, 2);
});

test('a button reaches the handler registered for its prefix with the full id', async () => {
  let seen;
  const registry = collectModules([{
    commands: [cmd('embed', { components: { prefix: 'embeds', handle: async (i) => { seen = i.customId; } } })],
  }]);
  const interaction = { isChatInputCommand: () => false, isContextMenuCommand: () => false, customId: 'embeds:send:12' };
  await routeInteraction(interaction, { db }, registry);
  assert.equal(seen, 'embeds:send:12');
});

test('a throwing handler produces an ephemeral error reply and does not reject', async () => {
  const replies = [];
  const registry = collectModules([{
    commands: [cmd('boom', { execute: async () => { throw new Error('x'); } })],
  }]);
  const interaction = {
    isChatInputCommand: () => true, commandName: 'boom', guildId: 'g1',
    replied: false, deferred: false,
    reply: async (o) => { replies.push(o); },
  };
  await routeInteraction(interaction, { db }, registry);
  assert.match(replies[0].content, /went wrong/);
});

test('an unknown component id is ignored', async () => {
  const registry = collectModules([]);
  const interaction = { isChatInputCommand: () => false, isContextMenuCommand: () => false, customId: 'zzz:1' };
  await routeInteraction(interaction, { db }, registry);
});
```

- [ ] **Step 2: Run.** Expected: FAIL.

- [ ] **Step 3: Implement** `src/core/loader.js`:

```js
import { getLang, t } from '../i18n/index.js';
import { ephemeral } from './replies.js';

export function collectModules(modules) {
  const commands = new Map();
  const components = new Map();
  const events = [];
  for (const mod of modules) {
    for (const command of mod.commands ?? []) {
      const name = command.data.name;
      if (commands.has(name)) throw new Error(`Duplicate command: ${name}`);
      commands.set(name, command);
      if (command.components) {
        const { prefix } = command.components;
        if (components.has(prefix)) throw new Error(`Duplicate component prefix: ${prefix}`);
        components.set(prefix, command.components);
      }
    }
    events.push(...(mod.events ?? []));
  }
  return { commands, components, events };
}

export async function routeInteraction(interaction, ctx, registry) {
  try {
    if (interaction.isChatInputCommand() || interaction.isContextMenuCommand()) {
      await registry.commands.get(interaction.commandName)?.execute(interaction, ctx);
      return;
    }
    if (interaction.customId) {
      const prefix = interaction.customId.split(':')[0];
      await registry.components.get(prefix)?.handle(interaction, ctx);
    }
  } catch (err) {
    console.error('Interaction failed:', err);
    try {
      const lang = interaction.guildId ? await getLang(ctx.db, interaction.guildId) : 'en';
      const payload = ephemeral(t(lang, 'common.error'));
      if (interaction.replied || interaction.deferred) await interaction.followUp(payload);
      else await interaction.reply(payload);
    } catch {
      // nothing more we can do
    }
  }
}
```

`src/modules.js`:

```js
// Each later task adds its feature module here.
export const modules = [];
```

`src/index.js`:

```js
import 'dotenv/config';
import { Client, GatewayIntentBits, Partials, Events } from 'discord.js';
import { loadConfig } from './config.js';
import { openDb } from './db/index.js';
import { modules } from './modules.js';
import { collectModules, routeInteraction } from './core/loader.js';

const config = loadConfig();
const db = await openDb(config.databaseUrl);
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
  partials: [Partials.Message, Partials.Channel],
});
const ctx = { db, client };
const registry = collectModules(modules);

for (const event of registry.events) {
  const run = async (...args) => {
    try {
      await event.execute(ctx, ...args);
    } catch (err) {
      console.error(`Event ${event.name} failed:`, err);
    }
  };
  if (event.once) client.once(event.name, run);
  else client.on(event.name, run);
}

client.on(Events.InteractionCreate, (interaction) => routeInteraction(interaction, ctx, registry));
client.once(Events.ClientReady, (c) => console.log(`Logged in as ${c.user.tag}`));

await client.login(config.token);
```

`src/deploy-commands.js`:

```js
import 'dotenv/config';
import { REST, Routes } from 'discord.js';
import { loadConfig } from './config.js';
import { modules } from './modules.js';
import { collectModules } from './core/loader.js';

const config = loadConfig();
const { commands } = collectModules(modules);
const body = [...commands.values()].map((c) => c.data.toJSON());
const rest = new REST().setToken(config.token);
const route = config.devGuildId
  ? Routes.applicationGuildCommands(config.clientId, config.devGuildId)
  : Routes.applicationCommands(config.clientId);
await rest.put(route, { body });
console.log(`Registered ${body.length} commands ${config.devGuildId ? 'to the dev guild' : 'globally'}.`);
```

- [ ] **Step 4: Run** `npm test`. Expected: PASS.
- [ ] **Step 5: Commit** `feat: module loader and interaction router`.

---

### Task 6: Panel overview and language

**Files:**
- Create: `src/features/panel/index.js`, `src/features/language/index.js`
- Modify: `src/modules.js`, `src/i18n/*.json`
- Test: `test/features/panel.test.js`

**Tier:** sonnet.

**Interfaces:**
- Consumes: `FEATURES`, `listFeatures`, `guard`, `ephemeral`, `t`, `setFeature`.
- Produces:
  - `buildPanelEmbed(features: Map<string, {enabled: boolean}>, lang): { title: string, description: string }` (pure).
  - Commands `/panel overview`, `/panel manager-role <role>`, `/panel manager-role-clear`, `/language set <en|ar|fr>`. All require a manager and are always available.

- [ ] **Step 1: Write the failing test** `test/features/panel.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildPanelEmbed } from '../../src/features/panel/index.js';

test('every phase 1 feature is Off on a fresh guild; core features say Core', () => {
  const { description } = buildPanelEmbed(new Map(), 'en');
  assert.match(description, /Welcome and leave\*\*: Off/);
  assert.match(description, /Panel\*\*: Core/);
});

test('an enabled feature says On', () => {
  const { description } = buildPanelEmbed(new Map([['welcome', { enabled: true }]]), 'en');
  assert.match(description, /Welcome and leave\*\*: On/);
});

test('later-phase features say Coming soon', () => {
  const { description } = buildPanelEmbed(new Map(), 'en');
  assert.match(description, /Moderation\*\*: Coming soon/);
});

test('the text follows the language', () => {
  const { description } = buildPanelEmbed(new Map(), 'fr');
  assert.match(description, /Désactivé/);
});
```

- [ ] **Step 2: Run.** Expected: FAIL.

- [ ] **Step 3: Implement** `src/features/panel/index.js`:

```js
import { SlashCommandBuilder } from 'discord.js';
import { FEATURES } from '../../core/registry.js';
import { guard } from '../../core/guard.js';
import { ephemeral } from '../../core/replies.js';
import { listFeatures, setFeature } from '../../db/settings.js';
import { t } from '../../i18n/index.js';

export function buildPanelEmbed(features, lang) {
  const lines = FEATURES.map((f) => {
    let status;
    if (f.alwaysOn) status = t(lang, 'panel.core');
    else if (f.command === null) status = t(lang, 'panel.comingSoon');
    else status = features.get(f.key)?.enabled ? t(lang, 'common.on') : t(lang, 'common.off');
    return `**${t(lang, f.nameKey)}**: ${status}`;
  });
  return { title: t(lang, 'panel.title'), description: lines.join('\n') };
}

const data = new SlashCommandBuilder()
  .setName('panel')
  .setDescription('See which bot features are on')
  .addSubcommand((s) => s.setName('overview').setDescription('Show which features are on and off'))
  .addSubcommand((s) =>
    s.setName('manager-role').setDescription('Let a role manage the bot')
      .addRoleOption((o) => o.setName('role').setDescription('The manager role').setRequired(true)))
  .addSubcommand((s) => s.setName('manager-role-clear').setDescription('Remove the bot manager role'));

async function execute(interaction, ctx) {
  const lang = await guard(interaction, ctx, 'panel', { requireEnabled: false });
  if (!lang) return;
  const sub = interaction.options.getSubcommand();
  if (sub === 'overview') {
    const features = await listFeatures(ctx.db, interaction.guildId);
    await interaction.reply(ephemeral({ embeds: [buildPanelEmbed(features, lang)] }));
  } else if (sub === 'manager-role') {
    const role = interaction.options.getRole('role', true);
    await setFeature(ctx.db, interaction.guildId, 'panel', { config: { managerRoleId: role.id } });
    await interaction.reply(ephemeral(t(lang, 'panel.managerSet', { role: role.name })));
  } else {
    await setFeature(ctx.db, interaction.guildId, 'panel', { config: { managerRoleId: null } });
    await interaction.reply(ephemeral(t(lang, 'panel.managerCleared')));
  }
}

export const commands = [{ data, execute }];
export const events = [];
```

(`canManage` treats a `null` role id as unset because of the `Boolean(...)` check.)

`src/features/language/index.js`:

```js
import { SlashCommandBuilder } from 'discord.js';
import { guard } from '../../core/guard.js';
import { ephemeral } from '../../core/replies.js';
import { setFeature } from '../../db/settings.js';
import { t, LANGS } from '../../i18n/index.js';

const data = new SlashCommandBuilder()
  .setName('language')
  .setDescription('Set the bot language for this server')
  .addSubcommand((s) =>
    s.setName('set').setDescription('Choose the language')
      .addStringOption((o) =>
        o.setName('language').setDescription('Language').setRequired(true)
          .addChoices(
            { name: 'English', value: 'en' },
            { name: 'العربية', value: 'ar' },
            { name: 'Français', value: 'fr' },
          )));

async function execute(interaction, ctx) {
  const lang = await guard(interaction, ctx, 'language', { requireEnabled: false });
  if (!lang) return;
  const chosen = interaction.options.getString('language', true);
  if (!LANGS.includes(chosen)) return;
  await setFeature(ctx.db, interaction.guildId, 'language', { config: { lang: chosen } });
  await interaction.reply(ephemeral(t(chosen, 'language.set')));
}

export const commands = [{ data, execute }];
export const events = [];
```

- [ ] **Step 4: Register modules.** In `src/modules.js`:

```js
import * as panel from './features/panel/index.js';
import * as language from './features/language/index.js';

export const modules = [panel, language];
```

- [ ] **Step 5: Locale keys.** Add to `en.json`:

```json
"panel.title": "Bot features",
"panel.core": "Core",
"panel.comingSoon": "Coming soon",
"panel.managerSet": "Members with the role {role} can now manage the bot.",
"panel.managerCleared": "The bot manager role was removed.",
"language.set": "The bot language is now English."
```

Translate into `ar.json` and `fr.json`, with `language.set` saying the new language name in that language.

- [ ] **Step 6: Run** `npm test`. Expected: PASS.
- [ ] **Step 7: Commit** `feat: panel overview and language setting`.

---

### Task 7: Image sources and media storage channel

**Files:**
- Create: `src/features/media/images.js`, `src/features/media/index.js`
- Modify: `src/modules.js`, locale files
- Test: `test/features/images.test.js`

**Tier:** sonnet.

**Interfaces:**
- Consumes: `guard`, `handleToggle`, `toggleSubcommands`, `fetchSendable`, `setFeature`, `getFeature`.
- Produces:
  - `type ImageRef = { type: 'url', url: string } | { type: 'stored', name: string }`
  - `parseImageInput(input: string): ImageRef`, throws `Error('invalid-image')` on empty input
  - `resolveImage(db, client, guildId, ref): Promise<string>`, throws `Error('image-not-found')` for unknown names and deleted messages
  - Commands `/media setup <channel>`, `/media add <name> <image>`, `/media list`, `/media remove <name>`, `/media enable|disable`

- [ ] **Step 1: Write the failing test** `test/features/images.test.js`:

```js
import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { parseImageInput, resolveImage } from '../../src/features/media/images.js';
import { testDb } from '../helpers/db.js';

let db;
before(async () => { db = await testDb(); });
beforeEach(async () => { await db.query('TRUNCATE media_items'); });
after(async () => { await db.end(); });

const fakeClient = (fetchMessage) => ({
  channels: { fetch: async () => ({ messages: { fetch: fetchMessage } }) },
});

test('parseImageInput: URL, stored name, and empty input', () => {
  assert.deepEqual(parseImageInput('https://x.io/a.png'), { type: 'url', url: 'https://x.io/a.png' });
  assert.deepEqual(parseImageInput(' logo '), { type: 'stored', name: 'logo' });
  assert.throws(() => parseImageInput('  '), /invalid-image/);
});

test('resolveImage returns a URL ref unchanged', async () => {
  assert.equal(await resolveImage(db, {}, 'g1', { type: 'url', url: 'https://x.io/a.png' }), 'https://x.io/a.png');
});

test('resolveImage fetches a fresh URL for a stored image', async () => {
  await db.query(
    "INSERT INTO media_items (guild_id, name, channel_id, message_id) VALUES ('g1','logo','c1','m1')",
  );
  const client = fakeClient(async () => ({ attachments: new Map([['a', { url: 'https://cdn/fresh.png' }]]) }));
  assert.equal(await resolveImage(db, client, 'g1', { type: 'stored', name: 'logo' }), 'https://cdn/fresh.png');
});

test('resolveImage throws image-not-found for an unknown name', async () => {
  await assert.rejects(resolveImage(db, {}, 'g1', { type: 'stored', name: 'nope' }), /image-not-found/);
});

test('resolveImage throws image-not-found when the message was deleted', async () => {
  await db.query(
    "INSERT INTO media_items (guild_id, name, channel_id, message_id) VALUES ('g1','logo','c1','m1')",
  );
  const client = fakeClient(async () => { throw new Error('Unknown Message'); });
  await assert.rejects(resolveImage(db, client, 'g1', { type: 'stored', name: 'logo' }), /image-not-found/);
});
```

- [ ] **Step 2: Run.** Expected: FAIL.

- [ ] **Step 3: Implement** `src/features/media/images.js`:

```js
export function parseImageInput(input) {
  const value = (input ?? '').trim();
  if (!value) throw new Error('invalid-image');
  return /^https?:\/\//i.test(value)
    ? { type: 'url', url: value }
    : { type: 'stored', name: value };
}

export async function resolveImage(db, client, guildId, ref) {
  if (ref.type === 'url') return ref.url;
  const { rows } = await db.query(
    'SELECT channel_id, message_id, attachment_index FROM media_items WHERE guild_id = $1 AND name = $2',
    [guildId, ref.name],
  );
  if (!rows[0]) throw new Error('image-not-found');
  try {
    const channel = await client.channels.fetch(rows[0].channel_id);
    const message = await channel.messages.fetch(rows[0].message_id);
    const attachment = [...message.attachments.values()][rows[0].attachment_index];
    if (!attachment) throw new Error('missing attachment');
    return attachment.url;
  } catch {
    throw new Error('image-not-found');
  }
}
```

`src/features/media/index.js`:

```js
import { SlashCommandBuilder, ChannelType } from 'discord.js';
import { guard } from '../../core/guard.js';
import { handleToggle, toggleSubcommands } from '../../core/toggle.js';
import { ephemeral } from '../../core/replies.js';
import { fetchSendable } from '../../core/send.js';
import { getFeature, setFeature } from '../../db/settings.js';
import { t } from '../../i18n/index.js';

const data = toggleSubcommands(
  new SlashCommandBuilder()
    .setName('media')
    .setDescription('Images stored for use in embeds and welcome cards')
    .addSubcommand((s) =>
      s.setName('setup').setDescription('Choose the storage channel')
        .addChannelOption((o) =>
          o.setName('channel').setDescription('Where images are kept')
            .addChannelTypes(ChannelType.GuildText).setRequired(true)))
    .addSubcommand((s) =>
      s.setName('add').setDescription('Store an image under a name')
        .addStringOption((o) => o.setName('name').setDescription('Name to use later').setRequired(true))
        .addAttachmentOption((o) => o.setName('image').setDescription('The image').setRequired(true)))
    .addSubcommand((s) => s.setName('list').setDescription('List stored images'))
    .addSubcommand((s) =>
      s.setName('remove').setDescription('Forget a stored image')
        .addStringOption((o) => o.setName('name').setDescription('Image name').setRequired(true))),
);

async function execute(interaction, ctx) {
  const sub = interaction.options.getSubcommand();
  if (sub === 'enable' || sub === 'disable') return handleToggle(interaction, ctx, 'media');

  if (sub === 'setup') {
    const lang = await guard(interaction, ctx, 'media', { requireEnabled: false });
    if (!lang) return;
    const channel = interaction.options.getChannel('channel', true);
    await setFeature(ctx.db, interaction.guildId, 'media', { enabled: true, config: { channelId: channel.id } });
    return interaction.reply(ephemeral(t(lang, 'media.setupDone', { channel: `<#${channel.id}>` })));
  }

  const lang = await guard(interaction, ctx, 'media');
  if (!lang) return;
  const guildId = interaction.guildId;

  if (sub === 'add') {
    const name = interaction.options.getString('name', true).trim();
    const attachment = interaction.options.getAttachment('image', true);
    if (!attachment.contentType?.startsWith('image/')) {
      return interaction.reply(ephemeral(t(lang, 'media.notImage')));
    }
    const { config } = await getFeature(ctx.db, guildId, 'media');
    const channel = await fetchSendable(ctx.client, config.channelId);
    if (!channel) return interaction.reply(ephemeral(t(lang, 'media.noChannel')));
    await interaction.deferReply({ flags: ephemeral('').flags });
    const sent = await channel.send({ files: [{ attachment: attachment.url, name: attachment.name }] });
    await ctx.db.query(
      `INSERT INTO media_items (guild_id, name, channel_id, message_id, attachment_index)
       VALUES ($1, $2, $3, $4, 0)
       ON CONFLICT (guild_id, name) DO UPDATE SET channel_id = $3, message_id = $4, attachment_index = 0`,
      [guildId, name, channel.id, sent.id],
    );
    return interaction.editReply(t(lang, 'media.added', { name }));
  }

  if (sub === 'list') {
    const { rows } = await ctx.db.query('SELECT name FROM media_items WHERE guild_id = $1 ORDER BY name', [guildId]);
    const text = rows.length ? rows.map((r) => `\`${r.name}\``).join(', ') : t(lang, 'media.empty');
    return interaction.reply(ephemeral(text));
  }

  if (sub === 'remove') {
    const name = interaction.options.getString('name', true).trim();
    const { rowCount } = await ctx.db.query('DELETE FROM media_items WHERE guild_id = $1 AND name = $2', [guildId, name]);
    return interaction.reply(ephemeral(t(lang, rowCount ? 'media.removed' : 'media.unknown', { name })));
  }
}

export const commands = [{ data, execute }];
export const events = [];
```

- [ ] **Step 4: Register** `media` in `src/modules.js`. **Step 5: Locale keys** (add to `en.json`, translate to `ar`/`fr`):

```json
"media.setupDone": "Images will be kept in {channel}.",
"media.notImage": "That file is not an image.",
"media.noChannel": "The storage channel is missing or I cannot post there. Run /media setup again.",
"media.added": "Stored the image as `{name}`.",
"media.empty": "No stored images yet.",
"media.removed": "Forgot `{name}`.",
"media.unknown": "There is no image named `{name}`."
```

- [ ] **Step 6: Run** `npm test`. Expected: PASS. **Step 7: Commit** `feat: media storage channel and image resolver`.

---

### Task 8: Embed model and validation

**Files:**
- Create: `src/features/embeds/model.js`
- Test: `test/features/embed-model.test.js`

**Tier:** sonnet.

**Interfaces:**
- Consumes: `ImageRef` type only.
- Produces:
  - `type EmbedSpec = { title?, description?, color?: '#RRGGBB', footer?, image?: ImageRef, thumbnail?: ImageRef, fields?: Array<{name, value, inline?}> }`
  - `validateEmbed(spec): { ok: true } | { ok: false, errors: string[] }` (errors are i18n keys)
  - `toDiscordEmbed(spec, images?: { image?: string, thumbnail?: string }): object`
  - `renderEmbedText(spec, vars): EmbedSpec` applies `renderTemplate` to title, description, footer and field text (used by welcome in Task 11; defined there, not here).

- [ ] **Step 1: Write the failing test** `test/features/embed-model.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateEmbed, toDiscordEmbed } from '../../src/features/embeds/model.js';

const longer = (n) => 'x'.repeat(n);

test('an empty spec is rejected', () => {
  assert.deepEqual(validateEmbed({}), { ok: false, errors: ['embeds.err.empty'] });
});

test('a title over 256 characters is rejected', () => {
  const r = validateEmbed({ title: longer(257) });
  assert.ok(r.errors.includes('embeds.err.titleTooLong'));
});

test('a description over 4096 characters is rejected', () => {
  assert.ok(validateEmbed({ description: longer(4097) }).errors.includes('embeds.err.descriptionTooLong'));
});

test('more than 25 fields is rejected', () => {
  const fields = Array.from({ length: 26 }, () => ({ name: 'a', value: 'b' }));
  assert.ok(validateEmbed({ fields }).errors.includes('embeds.err.tooManyFields'));
});

test('a field value over 1024 characters is rejected', () => {
  assert.ok(validateEmbed({ fields: [{ name: 'a', value: longer(1025) }] }).errors.includes('embeds.err.fieldTooLong'));
});

test('total size over 6000 characters is rejected', () => {
  const spec = { title: longer(256), description: longer(4000), footer: longer(1745) };
  assert.ok(validateEmbed(spec).errors.includes('embeds.err.tooLarge'));
});

test('a bad color is rejected', () => {
  assert.ok(validateEmbed({ title: 'a', color: 'red' }).errors.includes('embeds.err.badColor'));
});

test('a valid spec passes', () => {
  assert.deepEqual(validateEmbed({ title: 'Hi', description: 'there', color: '#5865F2' }), { ok: true });
});

test('toDiscordEmbed converts color and puts resolved images in place', () => {
  const e = toDiscordEmbed(
    { title: 'Hi', color: '#5865F2', footer: 'f', fields: [{ name: 'a', value: 'b' }] },
    { image: 'https://x.io/i.png', thumbnail: 'https://x.io/t.png' },
  );
  assert.equal(e.title, 'Hi');
  assert.equal(e.color, 0x5865f2);
  assert.deepEqual(e.footer, { text: 'f' });
  assert.deepEqual(e.image, { url: 'https://x.io/i.png' });
  assert.deepEqual(e.thumbnail, { url: 'https://x.io/t.png' });
  assert.deepEqual(e.fields, [{ name: 'a', value: 'b', inline: false }]);
});
```

- [ ] **Step 2: Run.** Expected: FAIL.

- [ ] **Step 3: Implement** `src/features/embeds/model.js`:

```js
export function validateEmbed(spec) {
  const errors = [];
  const fields = spec.fields ?? [];
  const len = (s) => (s ? s.length : 0);

  if (!spec.title && !spec.description && !spec.image && fields.length === 0) {
    errors.push('embeds.err.empty');
  }
  if (len(spec.title) > 256) errors.push('embeds.err.titleTooLong');
  if (len(spec.description) > 4096) errors.push('embeds.err.descriptionTooLong');
  if (len(spec.footer) > 2048) errors.push('embeds.err.footerTooLong');
  if (fields.length > 25) errors.push('embeds.err.tooManyFields');
  if (fields.some((f) => len(f.name) > 256 || len(f.value) > 1024)) {
    errors.push('embeds.err.fieldTooLong');
  }
  const total =
    len(spec.title) + len(spec.description) + len(spec.footer) +
    fields.reduce((sum, f) => sum + len(f.name) + len(f.value), 0);
  if (total > 6000) errors.push('embeds.err.tooLarge');
  if (spec.color && !/^#[0-9a-fA-F]{6}$/.test(spec.color)) errors.push('embeds.err.badColor');

  return errors.length ? { ok: false, errors } : { ok: true };
}

export function toDiscordEmbed(spec, images = {}) {
  const embed = {};
  if (spec.title) embed.title = spec.title;
  if (spec.description) embed.description = spec.description;
  if (spec.color) embed.color = parseInt(spec.color.slice(1), 16);
  if (spec.footer) embed.footer = { text: spec.footer };
  if (images.image) embed.image = { url: images.image };
  if (images.thumbnail) embed.thumbnail = { url: images.thumbnail };
  if (spec.fields?.length) {
    embed.fields = spec.fields.map((f) => ({ name: f.name, value: f.value, inline: Boolean(f.inline) }));
  }
  return embed;
}
```

- [ ] **Step 4: Run** `npm test`. Expected: PASS. Add locale keys to `en.json` (translate to `ar`/`fr`):

```json
"embeds.err.empty": "The embed needs at least a title, description, image or field.",
"embeds.err.titleTooLong": "The title is longer than 256 characters.",
"embeds.err.descriptionTooLong": "The description is longer than 4096 characters.",
"embeds.err.footerTooLong": "The footer is longer than 2048 characters.",
"embeds.err.tooManyFields": "An embed can have at most 25 fields.",
"embeds.err.fieldTooLong": "A field name is over 256 characters or a value is over 1024.",
"embeds.err.tooLarge": "The embed is over 6000 characters in total.",
"embeds.err.badColor": "The color must look like #5865F2."
```

- [ ] **Step 5: Run** `npm test` again (coverage test), then commit `feat: embed model and validation`.

---

### Task 9: Embed builder, templates, post message

**Files:**
- Create: `src/features/embeds/drafts.js`, `templates.js`, `send.js`, `index.js`, `src/features/post/index.js`
- Modify: `src/modules.js`, locale files
- Test: `test/features/embed-templates.test.js`, `test/features/embed-drafts.test.js`

**Tier:** opus, interactive multi-step flow combining Tasks 4, 7 and 8.

**Interfaces:**
- Consumes: `validateEmbed`, `toDiscordEmbed`, `parseImageInput`, `resolveImage`, `guard`, `handleToggle`, `toggleSubcommands`, `safeMentions`, `extractRoleIds`, `trySend`, `fetchSendable`, `ephemeral`.
- Produces:
  - Template store: `saveTemplate(db, guildId, name, spec): Promise<void>`, `getTemplate(db, guildId, name): Promise<EmbedSpec|null>`, `listTemplates(db, guildId): Promise<string[]>`, `deleteTemplate(db, guildId, name): Promise<boolean>`
  - Draft store: `putDraft(userId, spec, now?)`, `getDraft(userId, now?): EmbedSpec|null` (expires after 15 minutes), `clearDraft(userId)`
  - `buildEmbedPayload(ctx, guildId, spec): Promise<{ embeds: object[] }>` resolves images and converts; throws `Error('image-not-found')` upward
  - Commands: `/embed builder [channel]`, `/embed quick`, `/embed template use|list|delete`, `/embed enable|disable`; `/post text`, `/post embed`, `/post buttons`, `/post enable|disable`
  - Component prefix `embeds`: ids `embeds:modal:<channelId>`, `embeds:send:<channelId>`, `embeds:edit:<channelId>`, `embeds:tpl`, `embeds:tplmodal`

- [ ] **Step 1: Write the failing tests.** `test/features/embed-templates.test.js`:

```js
import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { saveTemplate, getTemplate, listTemplates, deleteTemplate } from '../../src/features/embeds/templates.js';
import { testDb } from '../helpers/db.js';

let db;
before(async () => { db = await testDb(); });
beforeEach(async () => { await db.query('TRUNCATE embed_templates'); });
after(async () => { await db.end(); });

test('save then get returns the same spec', async () => {
  const spec = { title: 'Rules', color: '#5865F2' };
  await saveTemplate(db, 'g1', 'rules', spec);
  assert.deepEqual(await getTemplate(db, 'g1', 'rules'), spec);
});

test('saving the same name twice keeps one row with the latest spec', async () => {
  await saveTemplate(db, 'g1', 'a', { title: 'one' });
  await saveTemplate(db, 'g1', 'a', { title: 'two' });
  assert.deepEqual(await listTemplates(db, 'g1'), ['a']);
  assert.equal((await getTemplate(db, 'g1', 'a')).title, 'two');
});

test('templates are per guild and delete reports whether it removed one', async () => {
  await saveTemplate(db, 'g1', 'a', { title: 'x' });
  assert.deepEqual(await listTemplates(db, 'g2'), []);
  assert.equal(await deleteTemplate(db, 'g1', 'a'), true);
  assert.equal(await deleteTemplate(db, 'g1', 'a'), false);
  assert.equal(await getTemplate(db, 'g1', 'a'), null);
});
```

`test/features/embed-drafts.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { putDraft, getDraft, clearDraft } from '../../src/features/embeds/drafts.js';

test('a draft is returned before it expires and dropped after 15 minutes', () => {
  putDraft('u1', { title: 'a' }, 1000);
  assert.deepEqual(getDraft('u1', 1000 + 14 * 60 * 1000), { title: 'a' });
  assert.equal(getDraft('u1', 1000 + 16 * 60 * 1000), null);
});

test('clearDraft removes a draft', () => {
  putDraft('u2', { title: 'a' }, 1000);
  clearDraft('u2');
  assert.equal(getDraft('u2', 1001), null);
});
```

- [ ] **Step 2: Run.** Expected: FAIL.

- [ ] **Step 3: Implement the stores.**

`src/features/embeds/templates.js`:

```js
export async function saveTemplate(db, guildId, name, spec) {
  await db.query(
    `INSERT INTO embed_templates (guild_id, name, json) VALUES ($1, $2, $3::jsonb)
     ON CONFLICT (guild_id, name) DO UPDATE SET json = $3::jsonb`,
    [guildId, name, JSON.stringify(spec)],
  );
}

export async function getTemplate(db, guildId, name) {
  const { rows } = await db.query(
    'SELECT json FROM embed_templates WHERE guild_id = $1 AND name = $2', [guildId, name]);
  return rows[0]?.json ?? null;
}

export async function listTemplates(db, guildId) {
  const { rows } = await db.query(
    'SELECT name FROM embed_templates WHERE guild_id = $1 ORDER BY name', [guildId]);
  return rows.map((r) => r.name);
}

export async function deleteTemplate(db, guildId, name) {
  const { rowCount } = await db.query(
    'DELETE FROM embed_templates WHERE guild_id = $1 AND name = $2', [guildId, name]);
  return rowCount > 0;
}
```

`src/features/embeds/drafts.js`:

```js
const TTL_MS = 15 * 60 * 1000;
const drafts = new Map();

export function putDraft(userId, spec, now = Date.now()) {
  drafts.set(userId, { spec, expires: now + TTL_MS });
}

export function getDraft(userId, now = Date.now()) {
  const draft = drafts.get(userId);
  if (!draft) return null;
  if (draft.expires < now) {
    drafts.delete(userId);
    return null;
  }
  return draft.spec;
}

export function clearDraft(userId) {
  drafts.delete(userId);
}
```

- [ ] **Step 4: Run** `npm test`. Expected: PASS.

- [ ] **Step 5: Implement `send.js`** (shared by `/embed` and `/post`) in `src/features/embeds/send.js`:

```js
import { toDiscordEmbed } from './model.js';
import { resolveImage } from '../media/images.js';

export async function buildEmbedPayload(ctx, guildId, spec) {
  const images = {};
  if (spec.image) images.image = await resolveImage(ctx.db, ctx.client, guildId, spec.image);
  if (spec.thumbnail) images.thumbnail = await resolveImage(ctx.db, ctx.client, guildId, spec.thumbnail);
  return { embeds: [toDiscordEmbed(spec, images)] };
}
```

- [ ] **Step 6: Implement the builder commands** in `src/features/embeds/index.js`. Structure (write the whole file; each function is short):

```js
import {
  SlashCommandBuilder, ChannelType, ActionRowBuilder, ModalBuilder, TextInputBuilder,
  TextInputStyle, ButtonBuilder, ButtonStyle,
} from 'discord.js';
import { guard } from '../../core/guard.js';
import { handleToggle, toggleSubcommands } from '../../core/toggle.js';
import { ephemeral } from '../../core/replies.js';
import { fetchSendable, trySend } from '../../core/send.js';
import { safeMentions } from '../../core/mentions.js';
import { t } from '../../i18n/index.js';
import { validateEmbed } from './model.js';
import { buildEmbedPayload } from './send.js';
import { putDraft, getDraft, clearDraft } from './drafts.js';
import { saveTemplate, getTemplate, listTemplates, deleteTemplate } from './templates.js';
import { parseImageInput } from '../media/images.js';

const errorText = (lang, errors) => errors.map((e) => `• ${t(lang, e)}`).join('\n');

function textInput(id, label, style, value, { required = false, max } = {}) {
  const input = new TextInputBuilder().setCustomId(id).setLabel(label).setStyle(style).setRequired(required);
  if (value) input.setValue(value);
  if (max) input.setMaxLength(max);
  return new ActionRowBuilder().addComponents(input);
}

export function builderModal(lang, channelId, spec = {}) {
  const img = spec.image?.type === 'url' ? spec.image.url : spec.image?.name;
  return new ModalBuilder()
    .setCustomId(`embeds:modal:${channelId}`)
    .setTitle(t(lang, 'embeds.modalTitle'))
    .addComponents(
      textInput('title', t(lang, 'embeds.title'), TextInputStyle.Short, spec.title, { max: 256 }),
      textInput('description', t(lang, 'embeds.description'), TextInputStyle.Paragraph, spec.description, { max: 4000 }),
      textInput('color', t(lang, 'embeds.color'), TextInputStyle.Short, spec.color, { max: 7 }),
      textInput('footer', t(lang, 'embeds.footer'), TextInputStyle.Short, spec.footer, { max: 2048 }),
      textInput('image', t(lang, 'embeds.image'), TextInputStyle.Short, img),
    );
}

export function specFromModal(interaction) {
  const get = (id) => interaction.fields.getTextInputValue(id).trim();
  const spec = {};
  if (get('title')) spec.title = get('title');
  if (get('description')) spec.description = get('description');
  if (get('color')) spec.color = get('color');
  if (get('footer')) spec.footer = get('footer');
  if (get('image')) spec.image = parseImageInput(get('image'));
  return spec;
}

async function showPreview(interaction, ctx, lang, spec, channelId) {
  let payload;
  try {
    payload = await buildEmbedPayload(ctx, interaction.guildId, spec);
  } catch {
    return interaction.reply(ephemeral(t(lang, 'embeds.imageMissing')));
  }
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`embeds:edit:${channelId}`).setLabel(t(lang, 'embeds.edit')).setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`embeds:send:${channelId}`).setLabel(t(lang, 'embeds.send')).setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId('embeds:tpl').setLabel(t(lang, 'embeds.saveTemplate')).setStyle(ButtonStyle.Primary),
  );
  return interaction.reply(ephemeral({ content: t(lang, 'embeds.previewHint'), ...payload, components: [row] }));
}
```

Then, in the same file:

- `data`: `toggleSubcommands(new SlashCommandBuilder().setName('embed')...)` with subcommands `builder` (optional channel option), `quick` (string options `title`, `description` required; `color`, `image` optional; optional `channel`), and subcommand group `template` with `use <name> [channel]`, `list`, `delete <name>`.
- `execute(interaction, ctx)`:
  - `enable`/`disable` call `handleToggle(interaction, ctx, 'embeds')`.
  - Everything else first does `const lang = await guard(interaction, ctx, 'embeds'); if (!lang) return;`.
  - `builder`: `interaction.showModal(builderModal(lang, channelId))` where `channelId` is the option or `interaction.channelId`.
  - `quick`: build a spec from the options, `validateEmbed` (reply `errorText` when it fails), `buildEmbedPayload` (reply `embeds.imageMissing` on `image-not-found`), `fetchSendable`, `trySend(channel, { ...payload, allowedMentions: safeMentions() })`, reply `embeds.sent` or `embeds.cannotSend`.
  - `template use`: `getTemplate`; unknown name replies `embeds.noTemplate`; otherwise the same send path as `quick`.
  - `template list`: replies with names joined by commas, or `embeds.noTemplates`.
  - `template delete`: `deleteTemplate`, reply by result.
- `components = { prefix: 'embeds', handle }` where `handle(interaction, ctx)` first calls `guard(...)` (use `interaction.guildId`-based check; the guard works for any interaction with `member`, `inGuild`, `reply`), then switches on `interaction.customId.split(':')[1]`:
  - `modal` (modal submit): `specFromModal` inside try/catch (a `invalid-image` throw cannot occur because empty is skipped), `validateEmbed`; on failure reply `errorText`; on success `putDraft(interaction.user.id, spec)` and `showPreview(...)`.
  - `edit` (button): `getDraft`; if null reply `embeds.draftExpired`; else `interaction.showModal(builderModal(lang, channelId, spec))`.
  - `send` (button): `getDraft`; if null reply `embeds.draftExpired`; else build payload, `fetchSendable`, `trySend`, then `clearDraft` only if sending succeeded; reply `embeds.sent` or `embeds.cannotSend`.
  - `tpl` (button): show a one-field modal with id `embeds:tplmodal` asking for a template name.
  - `tplmodal` (modal submit): `saveTemplate(ctx.db, guildId, name, getDraft(...))`, reply `embeds.templateSaved`; if the draft expired reply `embeds.draftExpired`.

- [ ] **Step 7: Implement `/post`** in `src/features/post/index.js`: command `post` with subcommands `text <channel> <text> [allow-role-ping:boolean]`, `embed <channel> <template>`, `buttons <channel> <text> <label> <url>`, plus `enable|disable` (feature key `post`). Every action calls `guard(interaction, ctx, 'post')` first. Sending rules:
  - `text`: `allowedMentions` is `safeMentions(allowRolePing ? extractRoleIds(text) : [])`.
  - `embed`: load the template, `buildEmbedPayload`, send with `safeMentions()`.
  - `buttons`: a single link button (`ButtonStyle.Link`) with the given label and URL; reject URLs not starting with `http://` or `https://` using `post.badUrl`.
  - All use `fetchSendable` + `trySend` and reply `post.sent` or `post.cannotSend`.

- [ ] **Step 8: Register** `embeds` and `post` in `src/modules.js`.

- [ ] **Step 9: Locale keys** (add to `en.json`; translate to `ar`/`fr`):

```json
"embeds.modalTitle": "Build an embed", "embeds.title": "Title", "embeds.description": "Description",
"embeds.color": "Color (like #5865F2)", "embeds.footer": "Footer", "embeds.image": "Image link or stored image name",
"embeds.previewHint": "Preview. Nothing is posted until you press Send.",
"embeds.edit": "Edit", "embeds.send": "Send", "embeds.saveTemplate": "Save as template",
"embeds.sent": "Sent.", "embeds.cannotSend": "I could not post in that channel. Check my permissions.",
"embeds.imageMissing": "That image could not be found. Check the name or link.",
"embeds.draftExpired": "That draft expired. Start again with /embed builder.",
"embeds.noTemplate": "There is no template with that name.", "embeds.noTemplates": "No templates yet.",
"embeds.templateSaved": "Template saved.", "embeds.templateDeleted": "Template deleted.",
"post.sent": "Posted.", "post.cannotSend": "I could not post in that channel. Check my permissions.",
"post.badUrl": "The link must start with http:// or https://."
```

- [ ] **Step 10: Run** `npm test`. Expected: PASS. (The interactive flow is verified by hand in Task 15.)
- [ ] **Step 11: Commit** `feat: embed builder, templates and post message`.

---

### Task 10: Message templates (placeholders)

**Files:**
- Create: `src/core/templates.js`
- Test: `test/core/templates.test.js`

**Tier:** haiku, every step's code is verbatim.

**Interfaces:**
- Produces: `renderTemplate(text: string, vars: { user?, username?, server?, count?, boosts? }): string`

- [ ] **Step 1: Write the failing test** `test/core/templates.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderTemplate } from '../../src/core/templates.js';

test('known placeholders are replaced', () => {
  assert.equal(
    renderTemplate('Hi {user}, welcome to {server}', { user: '<@1>', server: 'Home' }),
    'Hi <@1>, welcome to Home',
  );
});

test('unknown placeholders and placeholders without a value are left alone', () => {
  assert.equal(renderTemplate('{foo} {count}', { count: 7 }), '{foo} 7');
  assert.equal(renderTemplate('{user}', {}), '{user}');
});

test('a value that contains a placeholder is not expanded again', () => {
  assert.equal(renderTemplate('{username}', { username: '{server}', server: 'Home' }), '{server}');
});

test('text without braces is unchanged', () => {
  assert.equal(renderTemplate('plain', { user: 'x' }), 'plain');
});
```

- [ ] **Step 2: Run** `npm test`. Expected: FAIL.
- [ ] **Step 3: Implement** `src/core/templates.js`:

```js
export function renderTemplate(text, vars) {
  return text.replace(/\{(user|username|server|count|boosts)\}/g, (match, key) =>
    vars[key] === undefined ? match : String(vars[key]),
  );
}
```

- [ ] **Step 4: Run** `npm test`. Expected: PASS. **Step 5: Commit** `feat: placeholder templates`.

---

### Task 11: Welcome, leave and boost messages

**Files:**
- Create: `src/features/welcome/index.js`, `src/features/welcome/payload.js`, `src/features/welcome/card.js`, `assets/fonts/NotoSans-Regular.ttf`, `assets/fonts/NotoSansArabic-Regular.ttf`
- Modify: `src/modules.js`, locale files
- Test: `test/features/welcome-payload.test.js`, `test/features/welcome-card.test.js`, `test/features/welcome-events.test.js`

**Tier:** sonnet.

**Interfaces:**
- Consumes: `renderTemplate`, `toDiscordEmbed`, `validateEmbed`, `resolveImage`, `safeMentions`, `getFeature`, `setFeature`, `fetchSendable`, `trySend`, `guard`, `handleToggle`.
- Produces:
  - Config under feature `welcome`: `{ join?: EventCfg, leave?: EventCfg, boost?: EventCfg }` where `EventCfg = { enabled: boolean, channelId: string, style: 'text'|'embed'|'card', text: string, embed?: EmbedSpec, background?: ImageRef, dm?: { enabled: boolean, text: string } }`
  - `DEFAULT_TEXT: { join, leave, boost }` strings
  - `buildWelcomePayload(eventCfg, vars, { images = {}, card = null }): { content?: string, embeds?: object[], files?: object[] }` (pure)
  - `renderCard({ username, avatarUrl?, serverName, background?: Buffer }): Promise<Buffer>` 1024 by 400 PNG
  - `handleMember(ctx, member, event: 'join'|'leave'|'boost'): Promise<void>`
  - Commands `/welcome setup <event> <channel>`, `style <event> <style>`, `message <event>` (modal), `dm <event> <on|off>`, `test <event>`, `disable <event>`, `enable|disable` is replaced by per-event `disable`; the feature itself turns on with `setup`.

- [ ] **Step 1: Fetch fonts.** Download Noto Sans Regular and Noto Sans Arabic Regular (both SIL Open Font License, from Google Fonts) and save them as `assets/fonts/NotoSans-Regular.ttf` and `assets/fonts/NotoSansArabic-Regular.ttf`. Add a one-line `assets/fonts/README.md` naming the license. Verify both files exist and are larger than 50 KB.

- [ ] **Step 2: Write the failing tests.** `test/features/welcome-payload.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildWelcomePayload } from '../../src/features/welcome/payload.js';

const vars = { user: '<@1>', username: 'Sam', server: 'Home', count: 42 };

test('text style renders placeholders', () => {
  const p = buildWelcomePayload({ style: 'text', text: 'Hi {user}, #{count} in {server}' }, vars, {});
  assert.deepEqual(p, { content: 'Hi <@1>, #42 in Home' });
});

test('embed style renders placeholders inside the embed', () => {
  const p = buildWelcomePayload(
    { style: 'embed', text: '', embed: { title: 'Welcome {username}', color: '#5865F2' } }, vars, {});
  assert.equal(p.embeds[0].title, 'Welcome Sam');
  assert.equal(p.embeds[0].color, 0x5865f2);
});

test('card style attaches the card file and keeps the text', () => {
  const p = buildWelcomePayload({ style: 'card', text: 'Hi {username}' }, vars, { card: Buffer.from('png') });
  assert.equal(p.content, 'Hi Sam');
  assert.equal(p.files[0].name, 'welcome.png');
});
```

`test/features/welcome-card.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderCard } from '../../src/features/welcome/card.js';

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47]);

test('renderCard returns a PNG for a Latin name', async () => {
  const buf = await renderCard({ username: 'Sam', serverName: 'Home' });
  assert.deepEqual(buf.subarray(0, 4), PNG);
});

test('renderCard returns a PNG for an Arabic name', async () => {
  const buf = await renderCard({ username: 'أحمد', serverName: 'الخادم' });
  assert.deepEqual(buf.subarray(0, 4), PNG);
});
```

`test/features/welcome-events.test.js` (uses the real test database and fakes for Discord):

```js
import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { handleMember } from '../../src/features/welcome/index.js';
import { setFeature } from '../../src/db/settings.js';
import { testDb } from '../helpers/db.js';

let db;
before(async () => { db = await testDb(); });
beforeEach(async () => { await db.query('TRUNCATE guild_settings'); });
after(async () => { await db.end(); });

function fakeMember() {
  const sent = [];
  const dms = [];
  const channel = { isTextBased: () => true, send: async (p) => { sent.push(p); return {}; } };
  return {
    sent, dms, channel,
    member: {
      id: '1', user: { username: 'Sam', bot: false, displayAvatarURL: () => '' },
      guild: { id: 'g1', name: 'Home', memberCount: 5, premiumSubscriptionCount: 2 },
      send: async (p) => { dms.push(p); },
    },
    ctx: () => ({ db, client: { channels: { fetch: async () => channel } } }),
  };
}

const cfg = (extra = {}) => ({ join: { enabled: true, channelId: 'c1', style: 'text', text: 'Hi {username}', ...extra } });

test('does nothing when the feature is off', async () => {
  const f = fakeMember();
  await setFeature(db, 'g1', 'welcome', { enabled: false, config: cfg() });
  await handleMember(f.ctx(), f.member, 'join');
  assert.equal(f.sent.length, 0);
});

test('sends the welcome text when on', async () => {
  const f = fakeMember();
  await setFeature(db, 'g1', 'welcome', { enabled: true, config: cfg() });
  await handleMember(f.ctx(), f.member, 'join');
  assert.equal(f.sent[0].content, 'Hi Sam');
});

test('sends a DM when the dm option is on', async () => {
  const f = fakeMember();
  await setFeature(db, 'g1', 'welcome', { enabled: true, config: cfg({ dm: { enabled: true, text: 'Hello {username}' } }) });
  await handleMember(f.ctx(), f.member, 'join');
  assert.equal(f.dms[0].content, 'Hello Sam');
});

test('a deleted channel does not throw', async () => {
  const f = fakeMember();
  await setFeature(db, 'g1', 'welcome', { enabled: true, config: cfg() });
  const ctx = { db, client: { channels: { fetch: async () => { throw new Error('Unknown Channel'); } } } };
  await handleMember(ctx, f.member, 'join');
});

test('a failing send does not throw', async () => {
  const f = fakeMember();
  f.channel.send = async () => { throw new Error('Missing Permissions'); };
  await setFeature(db, 'g1', 'welcome', { enabled: true, config: cfg() });
  await handleMember(f.ctx(), f.member, 'join');
});

test('closed DMs do not throw', async () => {
  const f = fakeMember();
  f.member.send = async () => { throw new Error('Cannot send messages to this user'); };
  await setFeature(db, 'g1', 'welcome', { enabled: true, config: cfg({ dm: { enabled: true, text: 'x' } }) });
  await handleMember(f.ctx(), f.member, 'join');
});
```

- [ ] **Step 3: Run.** Expected: FAIL.

- [ ] **Step 4: Implement `payload.js`:**

```js
import { renderTemplate } from '../../core/templates.js';
import { toDiscordEmbed } from '../embeds/model.js';

export const DEFAULT_TEXT = {
  join: 'Welcome {user} to {server}! You are member #{count}.',
  leave: '{username} left {server}.',
  boost: 'Thank you {user} for boosting {server}!',
};

function renderEmbedText(spec, vars) {
  const r = (s) => (s ? renderTemplate(s, vars) : s);
  return {
    ...spec,
    title: r(spec.title),
    description: r(spec.description),
    footer: r(spec.footer),
    fields: spec.fields?.map((f) => ({ ...f, name: r(f.name), value: r(f.value) })),
  };
}

export function buildWelcomePayload(cfg, vars, { images = {}, card = null }) {
  if (cfg.style === 'embed' && cfg.embed) {
    return { embeds: [toDiscordEmbed(renderEmbedText(cfg.embed, vars), images)] };
  }
  if (cfg.style === 'card' && card) {
    const payload = { files: [{ attachment: card, name: 'welcome.png' }] };
    if (cfg.text) payload.content = renderTemplate(cfg.text, vars);
    return payload;
  }
  return { content: renderTemplate(cfg.text, vars) };
}
```

- [ ] **Step 5: Implement `card.js`:**

```js
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createCanvas, loadImage, GlobalFonts } from '@napi-rs/canvas';

const FONTS = [
  ['NotoSans-Regular.ttf', 'Noto Sans'],
  ['NotoSansArabic-Regular.ttf', 'Noto Sans Arabic'],
];
let fontsReady = false;

function ensureFonts() {
  if (fontsReady) return;
  for (const [file, family] of FONTS) {
    const path = fileURLToPath(new URL(`../../../assets/fonts/${file}`, import.meta.url));
    if (!existsSync(path)) throw new Error(`Missing font file: ${path}`);
    GlobalFonts.registerFromPath(path, family);
  }
  fontsReady = true;
}

export async function renderCard({ username, avatarUrl, serverName, background }) {
  ensureFonts();
  const canvas = createCanvas(1024, 400);
  const ctx = canvas.getContext('2d');

  if (background) {
    ctx.drawImage(await loadImage(background), 0, 0, 1024, 400);
  } else {
    ctx.fillStyle = '#23272a';
    ctx.fillRect(0, 0, 1024, 400);
  }
  ctx.fillStyle = 'rgba(0,0,0,0.45)';
  ctx.fillRect(0, 0, 1024, 400);

  ctx.save();
  ctx.beginPath();
  ctx.arc(512, 130, 80, 0, Math.PI * 2);
  ctx.closePath();
  ctx.clip();
  if (avatarUrl) ctx.drawImage(await loadImage(avatarUrl), 432, 50, 160, 160);
  else { ctx.fillStyle = '#5865f2'; ctx.fillRect(432, 50, 160, 160); }
  ctx.restore();

  ctx.fillStyle = '#ffffff';
  ctx.textAlign = 'center';
  ctx.font = '56px "Noto Sans", "Noto Sans Arabic"';
  ctx.fillText(username, 512, 290);
  ctx.font = '32px "Noto Sans", "Noto Sans Arabic"';
  ctx.fillText(serverName, 512, 345);

  return canvas.toBuffer('image/png');
}
```

- [ ] **Step 6: Implement `index.js`.** Write the file with these parts:

```js
import { SlashCommandBuilder, ChannelType, Events, ActionRowBuilder, ModalBuilder, TextInputBuilder, TextInputStyle } from 'discord.js';
import { getFeature, setFeature } from '../../db/settings.js';
import { guard } from '../../core/guard.js';
import { ephemeral } from '../../core/replies.js';
import { fetchSendable, trySend } from '../../core/send.js';
import { safeMentions } from '../../core/mentions.js';
import { renderTemplate } from '../../core/templates.js';
import { resolveImage } from '../media/images.js';
import { buildWelcomePayload, DEFAULT_TEXT } from './payload.js';
import { renderCard } from './card.js';
import { t } from '../../i18n/index.js';

const EVENTS = ['join', 'leave', 'boost'];

export async function handleMember(ctx, member, event) {
  const { enabled, config } = await getFeature(ctx.db, member.guild.id, 'welcome');
  const cfg = config[event];
  if (!enabled || !cfg?.enabled) return;

  const vars = {
    user: `<@${member.id}>`,
    username: member.user.username,
    server: member.guild.name,
    count: member.guild.memberCount,
    boosts: member.guild.premiumSubscriptionCount ?? 0,
  };

  const channel = await fetchSendable(ctx.client, cfg.channelId);
  if (!channel) {
    console.warn(`Welcome channel for ${event} missing in guild ${member.guild.id}`);
  } else {
    try {
      const images = {};
      if (cfg.embed?.image) images.image = await resolveImage(ctx.db, ctx.client, member.guild.id, cfg.embed.image);
      let card = null;
      if (cfg.style === 'card') {
        const background = cfg.background ? await resolveImage(ctx.db, ctx.client, member.guild.id, cfg.background) : undefined;
        card = await renderCard({
          username: vars.username,
          avatarUrl: member.user.displayAvatarURL({ extension: 'png', size: 256 }) || undefined,
          serverName: vars.server,
          background,
        });
      }
      const payload = buildWelcomePayload(cfg, vars, { images, card });
      await trySend(channel, { ...payload, allowedMentions: event === 'leave' ? safeMentions() : { parse: [], users: [member.id] } });
    } catch (err) {
      console.warn(`Welcome ${event} failed:`, err.message);
    }
  }

  if (cfg.dm?.enabled && event !== 'leave') {
    try { await member.send({ content: renderTemplate(cfg.dm.text, vars) }); } catch { /* DMs closed */ }
  }
}
```

Then, in the same file:

- `data`: `/welcome` with subcommands, each with a required `event` string option restricted by `addChoices` to `join|leave|boost`: `setup <event> <channel>` (text channels), `style <event> <text|embed|card>`, `message <event>`, `dm <event> <on|off>`, `test <event>`, `disable <event>`.
- `updateEvent(ctx, guildId, event, patch)`: read `getFeature(...).config[event] ?? {}`, then `setFeature(..., { config: { [event]: { ...current, ...patch } } })`.
- `execute`:
  - `setup`: guard with `requireEnabled: false`; `setFeature(..., { enabled: true })`; `updateEvent(..., { enabled: true, channelId, style: current.style ?? 'text', text: current.text ?? DEFAULT_TEXT[event] })`; reply `welcome.setupDone`.
  - everything else: `guard(interaction, ctx, 'welcome')`.
  - `style`: `updateEvent(..., { style })`; a style of `embed` with no `embed` saved sets `embed: { title: 'Welcome {username}', description: DEFAULT_TEXT[event] }`.
  - `message`: `showModal` with id `welcome:msg:<event>` and one paragraph input `text` pre-filled with the current text.
  - `dm`: `updateEvent(..., { dm: { enabled: on, text: current.dm?.text ?? DEFAULT_TEXT[event] } })`.
  - `test`: call `handleMember(ctx, interaction.member, event)`, reply `welcome.testSent`.
  - `disable`: `updateEvent(..., { enabled: false })`.
- `components = { prefix: 'welcome', handle }`: for a modal submit with id `welcome:msg:<event>`, call `guard`, then `updateEvent(..., { text })` and reply `common.saved`.
- `events`: `GuildMemberAdd` calls `handleMember(ctx, member, 'join')`; `GuildMemberRemove` calls it with `'leave'`; `GuildMemberUpdate` returns if `oldMember.partial`, otherwise calls it with `'boost'` only when `!oldMember.premiumSince && newMember.premiumSince`.

- [ ] **Step 7: Register** `welcome` in `src/modules.js`. **Step 8: Locale keys** (add to `en.json`; translate to `ar`/`fr`):

```json
"welcome.setupDone": "Done. I will post {event} messages in {channel}.",
"welcome.testSent": "Sent a test message.",
"welcome.noChannel": "Set a channel first with /welcome setup."
```

- [ ] **Step 9: Run** `npm test`. Expected: PASS.
- [ ] **Step 10: Manual Arabic check.** Run a one-off script that calls `renderCard({ username: 'أحمد', serverName: 'الخادم' })` and writes the result to `card.png`. Open it and confirm the Arabic is joined and reads right to left. If it does not, switch to drawing the text with `ctx.direction = 'rtl'` and re-check before moving on.
- [ ] **Step 11: Commit** `feat: welcome, leave and boost messages with image cards`.

---

### Task 12: Auto role

**Files:**
- Create: `src/features/autorole/index.js`
- Modify: `src/modules.js`, locale files
- Test: `test/features/autorole.test.js`

**Tier:** sonnet.

**Interfaces:**
- Produces:
  - Config under `autorole`: `{ humanRoleId?: string, botRoleId?: string }`
  - `assignAutoRole(ctx, member): Promise<void>`
  - Commands `/autorole setup [human-role] [bot-role]`, `/autorole disable`

- [ ] **Step 1: Write the failing test** `test/features/autorole.test.js`:

```js
import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { assignAutoRole } from '../../src/features/autorole/index.js';
import { setFeature } from '../../src/db/settings.js';
import { testDb } from '../helpers/db.js';

let db;
before(async () => { db = await testDb(); });
beforeEach(async () => { await db.query('TRUNCATE guild_settings'); });
after(async () => { await db.end(); });

const member = (bot, fail = false) => {
  const added = [];
  return {
    added,
    guild: { id: 'g1' },
    user: { bot },
    roles: { add: async (id) => { if (fail) throw new Error('Missing Permissions'); added.push(id); } },
  };
};

const config = { humanRoleId: 'H', botRoleId: 'B' };

test('a human gets the human role', async () => {
  await setFeature(db, 'g1', 'autorole', { enabled: true, config });
  const m = member(false);
  await assignAutoRole({ db }, m);
  assert.deepEqual(m.added, ['H']);
});

test('a bot gets the bot role only', async () => {
  await setFeature(db, 'g1', 'autorole', { enabled: true, config });
  const m = member(true);
  await assignAutoRole({ db }, m);
  assert.deepEqual(m.added, ['B']);
});

test('nothing is added when the feature is off or the role is unset', async () => {
  const m = member(false);
  await assignAutoRole({ db }, m);
  await setFeature(db, 'g1', 'autorole', { enabled: true, config: { botRoleId: 'B' } });
  await assignAutoRole({ db }, m);
  assert.deepEqual(m.added, []);
});

test('a failed role add does not throw', async () => {
  await setFeature(db, 'g1', 'autorole', { enabled: true, config });
  await assignAutoRole({ db }, member(false, true));
});
```

- [ ] **Step 2: Run.** Expected: FAIL.

- [ ] **Step 3: Implement** `src/features/autorole/index.js`:

```js
import { SlashCommandBuilder, Events } from 'discord.js';
import { getFeature, setFeature } from '../../db/settings.js';
import { guard } from '../../core/guard.js';
import { handleToggle } from '../../core/toggle.js';
import { ephemeral } from '../../core/replies.js';
import { t } from '../../i18n/index.js';

export async function assignAutoRole(ctx, member) {
  const { enabled, config } = await getFeature(ctx.db, member.guild.id, 'autorole');
  if (!enabled) return;
  const roleId = member.user.bot ? config.botRoleId : config.humanRoleId;
  if (!roleId) return;
  try {
    await member.roles.add(roleId);
  } catch (err) {
    console.warn(`Auto role failed in ${member.guild.id}: ${err.message}`);
  }
}

const data = new SlashCommandBuilder()
  .setName('autorole')
  .setDescription('Give new members a role automatically')
  .addSubcommand((s) =>
    s.setName('setup').setDescription('Choose the roles')
      .addRoleOption((o) => o.setName('human-role').setDescription('Role for new members'))
      .addRoleOption((o) => o.setName('bot-role').setDescription('Role for new bots')))
  .addSubcommand((s) => s.setName('disable').setDescription('Turn auto role off'));

async function execute(interaction, ctx) {
  if (interaction.options.getSubcommand() === 'disable') return handleToggle(interaction, ctx, 'autorole');
  const lang = await guard(interaction, ctx, 'autorole', { requireEnabled: false });
  if (!lang) return;
  const human = interaction.options.getRole('human-role');
  const bot = interaction.options.getRole('bot-role');
  const botTop = interaction.guild.members.me.roles.highest.position;
  const tooHigh = [human, bot].filter(Boolean).filter((r) => r.position >= botTop);
  await setFeature(ctx.db, interaction.guildId, 'autorole', {
    enabled: true,
    config: { humanRoleId: human?.id ?? null, botRoleId: bot?.id ?? null },
  });
  const warn = tooHigh.length ? `\n${t(lang, 'autorole.tooHigh')}` : '';
  await interaction.reply(ephemeral(t(lang, 'autorole.setupDone') + warn));
}

export const commands = [{ data, execute }];
export const events = [
  { name: Events.GuildMemberAdd, execute: assignAutoRole },
];
```

Note: `assignAutoRole(ctx, member)` matches the event signature `execute(ctx, member)`. `handleToggle` for `disable` works because the subcommand name is `disable`; `enable` is not offered here because `setup` turns the feature on.

- [ ] **Step 4: Register** `autorole` in `src/modules.js`. **Step 5: Locale keys:**

```json
"autorole.setupDone": "Auto role is on.",
"autorole.tooHigh": "Warning: one of those roles is above my highest role, so I cannot give it."
```

Translate to `ar`/`fr`.

- [ ] **Step 6: Run** `npm test`. Expected: PASS. **Step 7: Commit** `feat: auto role for humans and bots`.

---

### Task 13: Logging

**Files:**
- Create: `src/features/logging/format.js`, `src/features/logging/index.js`
- Modify: `src/modules.js`, locale files
- Test: `test/features/logging-format.test.js`, `test/features/logging.test.js`

**Tier:** sonnet.

**Interfaces:**
- Consumes: `getFeature`, `setFeature`, `fetchSendable`, `trySend`, `getLang`, `t`, `guard`, `handleToggle`.
- Produces:
  - Config under `logging`: `{ channels: { messages?, members?, server?, mod? } }` (all optional; `mod` is a placeholder for Phase 2)
  - `truncate(text: string | null, max = 1024): string`
  - `formatMessageEdit(before, after, lang): { title, description, fields }` (pure)
  - `sendLog(ctx, guildId, category, embed, sourceChannelId?): Promise<void>`
  - Commands `/logging set <category> <channel>`, `/logging clear <category>`, `/logging enable|disable`

- [ ] **Step 1: Write the failing tests.** `test/features/logging-format.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { truncate, formatMessageEdit } from '../../src/features/logging/format.js';

test('truncate shortens long text and handles null', () => {
  assert.equal(truncate('a'.repeat(2000)).length, 1024);
  assert.equal(truncate(null), '—');
});

test('formatMessageEdit includes old and new content', () => {
  const e = formatMessageEdit(
    { content: 'old text', author: { username: 'Sam' }, channelId: 'c1' },
    { content: 'new text', author: { username: 'Sam' }, channelId: 'c1', url: 'https://discord.com/x' },
    'en',
  );
  assert.equal(e.fields[0].value, 'old text');
  assert.equal(e.fields[1].value, 'new text');
});

test('formatMessageEdit marks unavailable old content (uncached message)', () => {
  const e = formatMessageEdit({ content: null, partial: true }, { content: 'new', author: { username: 'S' }, channelId: 'c' }, 'en');
  assert.match(e.fields[0].value, /not available/i);
});
```

`test/features/logging.test.js`:

```js
import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { sendLog } from '../../src/features/logging/index.js';
import { setFeature } from '../../src/db/settings.js';
import { testDb } from '../helpers/db.js';

let db;
before(async () => { db = await testDb(); });
beforeEach(async () => { await db.query('TRUNCATE guild_settings'); });
after(async () => { await db.end(); });

function ctxWith(send) {
  const channel = { isTextBased: () => true, send };
  return { db, client: { channels: { fetch: async () => channel } } };
}
const embed = { title: 't' };
const logCfg = { channels: { messages: 'LOG', members: 'LOG2' } };

test('sends to the category channel', async () => {
  const sent = [];
  await setFeature(db, 'g1', 'logging', { enabled: true, config: logCfg });
  await sendLog(ctxWith(async (p) => { sent.push(p); }), 'g1', 'messages', embed, 'other');
  assert.equal(sent.length, 1);
});

test('ignores events that happen inside a log channel (no feedback loop)', async () => {
  const sent = [];
  await setFeature(db, 'g1', 'logging', { enabled: true, config: logCfg });
  await sendLog(ctxWith(async (p) => { sent.push(p); }), 'g1', 'messages', embed, 'LOG');
  assert.equal(sent.length, 0);
});

test('does nothing when logging is off or the category is unset', async () => {
  const sent = [];
  await sendLog(ctxWith(async (p) => { sent.push(p); }), 'g1', 'messages', embed, 'x');
  await setFeature(db, 'g1', 'logging', { enabled: true, config: logCfg });
  await sendLog(ctxWith(async (p) => { sent.push(p); }), 'g1', 'server', embed, 'x');
  assert.equal(sent.length, 0);
});

test('a failing send does not throw', async () => {
  await setFeature(db, 'g1', 'logging', { enabled: true, config: logCfg });
  await sendLog(ctxWith(async () => { throw new Error('Missing Permissions'); }), 'g1', 'messages', embed, 'x');
});

test('a deleted log channel does not throw', async () => {
  await setFeature(db, 'g1', 'logging', { enabled: true, config: logCfg });
  const ctx = { db, client: { channels: { fetch: async () => { throw new Error('Unknown Channel'); } } } };
  await sendLog(ctx, 'g1', 'messages', embed, 'x');
});
```

- [ ] **Step 2: Run.** Expected: FAIL.

- [ ] **Step 3: Implement `format.js`:**

```js
import { t } from '../../i18n/index.js';

export function truncate(text, max = 1024) {
  if (text === null || text === undefined || text === '') return '—';
  return text.length > max ? text.slice(0, max) : text;
}

export function formatMessageEdit(before, after, lang) {
  const oldText = before.content === null || before.content === undefined
    ? t(lang, 'logging.contentUnavailable')
    : truncate(before.content);
  return {
    title: t(lang, 'logging.messageEdited'),
    description: `${after.author?.username ?? '?'} in <#${after.channelId}> [${t(lang, 'logging.jump')}](${after.url ?? ''})`,
    fields: [
      { name: t(lang, 'logging.before'), value: oldText },
      { name: t(lang, 'logging.after'), value: truncate(after.content) },
    ],
  };
}
```

- [ ] **Step 4: Implement `index.js`.** Core function and events:

```js
import { SlashCommandBuilder, ChannelType, Events } from 'discord.js';
import { getFeature, setFeature } from '../../db/settings.js';
import { guard } from '../../core/guard.js';
import { handleToggle, toggleSubcommands } from '../../core/toggle.js';
import { ephemeral } from '../../core/replies.js';
import { fetchSendable, trySend } from '../../core/send.js';
import { getLang, t } from '../../i18n/index.js';
import { formatMessageEdit, truncate } from './format.js';

export async function sendLog(ctx, guildId, category, embed, sourceChannelId) {
  const { enabled, config } = await getFeature(ctx.db, guildId, 'logging');
  if (!enabled) return;
  const channels = config.channels ?? {};
  const channelId = channels[category];
  if (!channelId) return;
  if (sourceChannelId && Object.values(channels).includes(sourceChannelId)) return;
  const channel = await fetchSendable(ctx.client, channelId);
  if (!channel) {
    console.warn(`Log channel for ${category} missing in guild ${guildId}`);
    return;
  }
  await trySend(channel, { embeds: [{ ...embed, timestamp: new Date().toISOString() }], allowedMentions: { parse: [] } });
}
```

Then, in the same file:

- `data`: `toggleSubcommands(new SlashCommandBuilder().setName('logging')...)` plus `set <category> <channel>` (category choices `messages|members|server|mod`) and `clear <category>`. `set` and `clear` call `guard(interaction, ctx, 'logging', { requireEnabled: false })`, update `config.channels` by reading the current channels and writing back the whole `channels` object, and `set` also enables the feature.
- Events (each uses `getLang(ctx.db, guildId)` for text, builds a small embed, and calls `sendLog`):
  - `MessageUpdate (oldM, newM)`: return if `!newM.guildId`, `newM.author?.bot`, or `oldM.content === newM.content` (when both known). Embed from `formatMessageEdit`. Category `messages`, source channel `newM.channelId`.
  - `MessageDelete (message)`: return if `!message.guildId` or `message.author?.bot`. Embed with author (or unknown), channel, and `truncate(message.content)` (or `logging.contentUnavailable` for partials).
  - `GuildMemberAdd`, `GuildMemberRemove`: category `members`.
  - `GuildMemberUpdate (oldM, newM)`: return if `oldM.partial`. Log a nickname change when `oldM.nickname !== newM.nickname`; log added and removed roles by comparing `oldM.roles.cache` and `newM.roles.cache` keys.
  - `ChannelCreate`, `ChannelDelete`, `ChannelUpdate` (name change only), `RoleCreate`, `RoleDelete`, `RoleUpdate` (name or permissions change), `GuildEmojiCreate`, `GuildEmojiDelete`, `GuildEmojiUpdate` (name change): category `server`. For `ChannelCreate`/`Update`/`Delete`, skip channels without `guildId` (DMs).
- Export `commands = [{ data, execute }]` and `events`.

- [ ] **Step 5: Register** `logging` in `src/modules.js`. **Step 6: Locale keys** (add to `en.json`; translate to `ar`/`fr`):

```json
"logging.messageEdited": "Message edited", "logging.messageDeleted": "Message deleted",
"logging.before": "Before", "logging.after": "After", "logging.jump": "Jump to message",
"logging.contentUnavailable": "Content not available (message was not cached).",
"logging.memberJoined": "Member joined", "logging.memberLeft": "Member left",
"logging.nicknameChanged": "Nickname changed", "logging.rolesChanged": "Roles changed",
"logging.channelCreated": "Channel created", "logging.channelDeleted": "Channel deleted",
"logging.channelRenamed": "Channel renamed", "logging.roleCreated": "Role created",
"logging.roleDeleted": "Role deleted", "logging.roleUpdated": "Role updated",
"logging.emojiCreated": "Emoji created", "logging.emojiDeleted": "Emoji deleted",
"logging.emojiRenamed": "Emoji renamed",
"logging.set": "{category} logs will go to {channel}.", "logging.cleared": "{category} logging cleared."
```

- [ ] **Step 7: Run** `npm test`. Expected: PASS. **Step 8: Commit** `feat: logging for messages, members and server changes`.

---

### Task 14: Info commands

**Files:**
- Create: `src/features/info/build.js`, `src/features/info/index.js`
- Modify: `src/modules.js`, locale files
- Test: `test/features/info.test.js`

**Tier:** sonnet.

**Interfaces:**
- Produces:
  - `buildUserInfo(member, lang): { title, fields }` and `buildServerInfo(guild, lang): { title, fields }` (pure)
  - Commands `/userinfo [user]`, `/avatar [user]`, `/banner [user]`, `/serverinfo`, and `/info enable|disable` (manager only). The first four refuse with `common.featureOff` while the feature is off.

- [ ] **Step 1: Write the failing test** `test/features/info.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildUserInfo, buildServerInfo } from '../../src/features/info/build.js';

const fieldValue = (info, name) => info.fields.find((f) => f.name === name)?.value;

test('buildServerInfo shows members, boosts, channels and roles', () => {
  const guild = {
    name: 'Home', memberCount: 12, premiumSubscriptionCount: 3, premiumTier: 1,
    channels: { cache: { size: 8 } }, roles: { cache: { size: 5 } },
    createdTimestamp: 1_700_000_000_000,
  };
  const info = buildServerInfo(guild, 'en');
  assert.equal(fieldValue(info, 'Members'), '12');
  assert.match(fieldValue(info, 'Boosts'), /3/);
  assert.equal(fieldValue(info, 'Channels'), '8');
  assert.equal(fieldValue(info, 'Roles'), '5');
});

test('buildUserInfo lists roles without @everyone and shows not-yet-available lines', () => {
  const member = {
    user: { username: 'Sam', createdTimestamp: 1_600_000_000_000 },
    joinedTimestamp: 1_700_000_000_000,
    roles: { cache: new Map([['1', { id: '1', name: '@everyone' }], ['2', { id: '2', name: 'Mod' }]]) },
  };
  const info = buildUserInfo(member, 'en');
  assert.equal(fieldValue(info, 'Roles'), '<@&2>');
  assert.match(fieldValue(info, 'Level'), /not available/i);
  assert.match(fieldValue(info, 'Warnings'), /not available/i);
  assert.match(fieldValue(info, 'Birthday'), /not available/i);
});
```

Note: `@everyone` is the role whose `id` equals the guild id. The fake above gives it the name `@everyone`; filter on `name !== '@everyone'`.

- [ ] **Step 2: Run.** Expected: FAIL.

- [ ] **Step 3: Implement `build.js`:**

```js
import { t } from '../../i18n/index.js';

const stamp = (ms) => `<t:${Math.floor(ms / 1000)}:D> (<t:${Math.floor(ms / 1000)}:R>)`;

export function buildServerInfo(guild, lang) {
  return {
    title: guild.name,
    fields: [
      { name: t(lang, 'info.members'), value: String(guild.memberCount) },
      { name: t(lang, 'info.boosts'), value: t(lang, 'info.boostValue', { count: guild.premiumSubscriptionCount ?? 0, tier: guild.premiumTier }) },
      { name: t(lang, 'info.channels'), value: String(guild.channels.cache.size) },
      { name: t(lang, 'info.roles'), value: String(guild.roles.cache.size) },
      { name: t(lang, 'info.created'), value: stamp(guild.createdTimestamp) },
    ],
  };
}

export function buildUserInfo(member, lang) {
  const roles = [...member.roles.cache.values()]
    .filter((r) => r.name !== '@everyone')
    .map((r) => `<@&${r.id}>`)
    .join(' ') || '—';
  const later = t(lang, 'info.notAvailable');
  return {
    title: member.user.username,
    fields: [
      { name: t(lang, 'info.joined'), value: member.joinedTimestamp ? stamp(member.joinedTimestamp) : '—' },
      { name: t(lang, 'info.accountAge'), value: stamp(member.user.createdTimestamp) },
      { name: t(lang, 'info.roles'), value: roles },
      { name: t(lang, 'info.level'), value: later },
      { name: t(lang, 'info.warnings'), value: later },
      { name: t(lang, 'info.birthday'), value: later },
    ],
  };
}
```

Note: the test compares field names to English strings (`Members`, `Boosts`, `Roles`, `Level`, ...), so the `en.json` values below must be exactly those words.

- [ ] **Step 4: Implement `index.js`.** Commands:

```js
import { SlashCommandBuilder } from 'discord.js';
import { guard } from '../../core/guard.js';
import { handleToggle, toggleSubcommands } from '../../core/toggle.js';
import { ephemeral } from '../../core/replies.js';
import { t } from '../../i18n/index.js';
import { buildUserInfo, buildServerInfo } from './build.js';

const userOption = (o) => o.setName('user').setDescription('Member (defaults to you)');

const infoToggle = toggleSubcommands(new SlashCommandBuilder().setName('info').setDescription('Turn the info commands on or off'));
const userinfo = new SlashCommandBuilder().setName('userinfo').setDescription('About a member').addUserOption(userOption);
const avatar = new SlashCommandBuilder().setName('avatar').setDescription('Show an avatar').addUserOption(userOption);
const banner = new SlashCommandBuilder().setName('banner').setDescription('Show a banner').addUserOption(userOption);
const serverinfo = new SlashCommandBuilder().setName('serverinfo').setDescription('About this server');

const open = (interaction, ctx) => guard(interaction, ctx, 'info', { requireManager: false });

export const commands = [
  { data: infoToggle, execute: (i, ctx) => handleToggle(i, ctx, 'info') },
  {
    data: userinfo,
    async execute(i, ctx) {
      const lang = await open(i, ctx);
      if (!lang) return;
      const user = i.options.getUser('user') ?? i.user;
      const member = await i.guild.members.fetch(user.id).catch(() => null);
      if (!member) return i.reply(ephemeral(t(lang, 'info.notMember')));
      await i.reply({ embeds: [buildUserInfo(member, lang)] });
    },
  },
  {
    data: avatar,
    async execute(i, ctx) {
      const lang = await open(i, ctx);
      if (!lang) return;
      const user = i.options.getUser('user') ?? i.user;
      await i.reply({ embeds: [{ title: user.username, image: { url: user.displayAvatarURL({ size: 1024 }) } }] });
    },
  },
  {
    data: banner,
    async execute(i, ctx) {
      const lang = await open(i, ctx);
      if (!lang) return;
      const user = await (i.options.getUser('user') ?? i.user).fetch(true);
      const url = user.bannerURL({ size: 1024 });
      if (!url) return i.reply(ephemeral(t(lang, 'info.noBanner')));
      await i.reply({ embeds: [{ title: user.username, image: { url } }] });
    },
  },
  {
    data: serverinfo,
    async execute(i, ctx) {
      const lang = await open(i, ctx);
      if (!lang) return;
      await i.reply({ embeds: [buildServerInfo(i.guild, lang)] });
    },
  },
];
export const events = [];
```

(`/userinfo` and the others reply publicly because they only show public information. `guard` with `requireManager: false` still checks the feature is on and the command is used in a server.)

- [ ] **Step 5: Register** `info` in `src/modules.js`. **Step 6: Locale keys** (the English values must match the test):

```json
"info.members": "Members", "info.boosts": "Boosts", "info.boostValue": "{count} (level {tier})",
"info.channels": "Channels", "info.roles": "Roles", "info.created": "Created",
"info.joined": "Joined", "info.accountAge": "Account created", "info.level": "Level",
"info.warnings": "Warnings", "info.birthday": "Birthday",
"info.notAvailable": "Not available yet.", "info.notMember": "That user is not in this server.",
"info.noBanner": "That user has no banner."
```

Translate to `ar`/`fr`.

- [ ] **Step 7: Run** `npm test`. Expected: PASS. **Step 8: Commit** `feat: user, avatar, banner and server info commands`.

---

### Task 15: End-to-end check on a test server

**Files:**
- Create: `README.md` (setup and run steps only)

**Tier:** sonnet.

- [ ] **Step 1:** Run `npm test`. Expected: every test passes.
- [ ] **Step 2: Discord setup.** In the Discord developer portal create an application and a bot, enable the Server Members and Message Content intents, copy the token and application ID into `.env` (from `.env.example`), set `DEV_GUILD_ID` to your test server's ID, and invite the bot with the `bot` and `applications.commands` scopes and the permissions: View Channels, Send Messages, Embed Links, Attach Files, Manage Roles.
- [ ] **Step 3: Start.** Run `docker compose up -d`, then `npm run deploy`, then `npm start`. Expected: `Registered N commands to the dev guild.` then `Logged in as <bot>`.
- [ ] **Step 4: Walk this checklist** and confirm each item:
  1. `/panel overview` shows Panel and Language as Core, other Phase 1 features Off, later phases Coming soon.
  2. As a normal member (no Manage Server), every setup command is refused with the permission message.
  3. `/language set` to French changes `/panel overview` to French; Arabic shows Arabic.
  4. `/media setup`, `/media add logo`, `/media list`; then `/embed enable`, `/embed quick` with image `logo` shows the image.
  5. `/embed builder`: fill the form, see the preview, press Send; press Save as template; `/embed template use`.
  6. A text over the limits (for example a 300-character title) shows the error and posts nothing.
  7. `/post enable`, `/post text` with `@everyone` in the text does not ping.
  8. `/welcome setup join`, then `/welcome test join` in text, embed and card styles; the card looks right with an Arabic username; the DM option works.
  9. `/autorole setup` gives the right role to a new human account and to a bot.
  10. `/logging set messages`: edit and delete a message and see the log; edits inside the log channel itself are not logged.
  11. `/info enable`, then `/userinfo`, `/avatar`, `/banner`, `/serverinfo` work; with `/info disable` they refuse.
  12. Delete the welcome channel, trigger `/welcome test join`: the bot does not crash.
  13. Stop and restart the bot, then run `docker compose restart`: all settings are still there.
- [ ] **Step 5: README.** Write `README.md` with: prerequisites (Node 22, Docker Desktop), `.env` setup, the four commands from Step 3, and how to run tests.
- [ ] **Step 6: Commit** on `phase-1`: `docs: add readme and phase 1 verification`. Phase 1 is done when this branch passes the checklist. Phase 2 then starts with `git switch -c phase-2` from `phase-1`.

---

## Self-review notes

- **Spec coverage (Phase 1):** panel and always-on core (6), language (3, 6), media storage and URL-or-stored images (7), embeds, templates, quick command and post (8, 9), welcome/leave/boost with text, embed, card and DM (10, 11), auto role for humans and bots (12), logging without voice (13), info commands including banner (14), off-by-default and ephemeral replies and permission gate (2, 4, 6 onward).
- **Placeholders in later tasks:** `/userinfo` shows "not available yet" for level, warnings and birthday, and logging has a `mod` category with no events; Phases 2 and 4 fill those in.
- **Known gaps to watch:** the interactive embed flow (Task 9) and the Arabic card (Task 11) are verified by hand, not by unit tests. Task 9 steps 6 and 7 describe several handlers in prose with the shared helpers given in code; the builder should keep each handler short and reuse `errorText`, `showPreview` and `buildEmbedPayload`.
- **Unrequested additions:** none beyond the `alwaysOn` exception for `/panel` and `/language`, noted in Global Constraints.


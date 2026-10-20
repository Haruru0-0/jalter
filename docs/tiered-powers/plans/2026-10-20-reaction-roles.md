# Reaction Roles Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use tiered-powers:subagent-driven-development (recommended) or tiered-powers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let staff attach roles to a named-embed message that members pick with reactions, buttons or a dropdown, with Carl-bot-style types, limit, whitelist/blacklist and selfdestruct.

**Architecture:** A new feature module `src/features/reactionroles/`. Two pure layers (`config.js` parsing, `rules.js` pick decisions) feed `apply.js`, the only place that changes roles (per-member-per-message serialized). `render.js` builds the Discord components and reactions; `events.js` and `components.js` translate Discord events into picks; `commands.js`, `commands-settings.js` and `builder.js` are the staff surface. State lives in three new tables (migration 009); the on/off flag lives in `guild_settings`.

**Tech Stack:** discord.js 14.27, Node 22 ESM, Postgres, `node --test`.

**Spec:** `docs/tiered-powers/specs/2026-10-20-reaction-roles-design.md`

## How to read the code in this plan

Each task ends with **Reference code**: the files it adds, written out so the implementer is not guessing. The pure parts (`config.js`, `rules.js`) were checked against the cases in the tests below, and `store.js` and `apply.js` passed their tests against the real test database when drafted. Treat the code as the starting point: the tests in each task decide what is correct. Lines tagged `// Task N` belong to that task and are left out until it runs, so every task leaves the suite green. The i18n keys the code uses are listed in Task 5.

## Global Constraints

- Node 22+, ESM, discord.js 14.27.0; no new dependencies.
- Every user-facing string goes in all three of `src/i18n/en.json`, `fr.json`, `ar.json` (`test/i18n.test.js` checks they match). Keys are namespaced `reactionroles.*`.
- Off by default; setup commands call `guard(interaction, ctx, 'reactionroles', { requireManager: true })` and reply ephemerally (`ephemeral()` from `src/core/replies.js`), except `enable`/`disable` which use `requireEnabled: false`.
- A message holds at most 20 entries (`MAX_ENTRIES = 20`). Styles: `reactions`, `buttons`, `menu`. Types: `normal`, `unique`, `verify`, `drop`, `reversed`, `binding`, `lock`.
- Role safety at setup: refuse `isDangerousRole`, not `botCanGive`, not `callerCanGive` (all from `src/core/role-safety.js`). Re-check `botCanGive` at pick time.
- Needs intent `GuildMessageReactions` and `Partials.Reaction` in `src/index.js`.
- Scheduler job type `reactionroles.destruct`, key = message id.
- Single bot process: the per-member lock is in memory.
- Tests hit the DB (`npm test`, concurrency 1); pure logic must be testable without Discord.
- Commit style: `feat(reactionroles): ...`, using the user's own git name and email, with no Co-Authored-By Claude trailer (project memory rule).

## Review Focus

- Two fast picks (double click, double react) by one member must not slip past `unique`, `limit` or `binding` (Task 3).
- A role deleted from the server while an entry still points at it: the pick is refused with a message, nothing throws (Task 3, Task 7).
- A dropdown submitted with nothing selected on a `verify`, `binding` or `lock` message removes no role (Task 2).
- A reaction from a bot, on a message not in the table, or while the feature is off is ignored without error and without removing the reaction (Task 7).
- The picking member left the server or is a partial object mid-pick: no crash, no role change (Task 7).

---

## File Structure

- Create `src/db/migrations/009_reaction_roles.sql`
- Create `src/features/reactionroles/config.js` — constants, `parseEmoji`, `emojiKey`, `checkEntryInput`
- Create `src/features/reactionroles/store.js` — all SQL
- Create `src/features/reactionroles/rules.js` — pure pick decisions
- Create `src/features/reactionroles/apply.js` — `applyPick`, role safety at pick time, serialization
- Create `src/features/reactionroles/render.js` — components, reactions, `syncMessage`, `postRoleMessage`, `refreshEmbed`
- Create `src/features/reactionroles/setup.js` — `checkRoleForSetup`, `addOne`, `fetchDiscordMessage` (shared by commands and builder)
- Create `src/features/reactionroles/commands.js` — `/reactionroles` definition, base subcommands
- Create `src/features/reactionroles/commands-settings.js` — type/limit/lists/selfdestruct/refresh/purge/fix handlers + destruct job
- Create `src/features/reactionroles/builder.js` — interactive builder panel
- Create `src/features/reactionroles/components.js` — component router (`reactionroles` prefix): picks, purge confirm, builder
- Create `src/features/reactionroles/events.js` — reaction and cleanup events
- Create `src/features/reactionroles/log.js` — `logReactionRoles` (modAction line)
- Create `src/features/reactionroles/index.js`
- Modify `src/modules.js`, `src/index.js`, `src/core/registry.js`, `src/i18n/{en,fr,ar}.json`, `README.md`, `docs/testing-checklist.md`, `docs/memory/*`
- Tests in `test/features/reactionroles-*.test.js`

---

### Task 1: Migration and store

**Files:**
- Create: `src/db/migrations/009_reaction_roles.sql`, `src/features/reactionroles/store.js`
- Test: `test/features/reactionroles-store.test.js`

**Tier:** sonnet — migration plus SQL semantics (cascade, uniqueness)

**Interfaces:**
- Produces (all take `db` first; ids are strings):
  - `createMessage(db, { guildId, messageId, channelId, embedName, style, type = 'normal', createdBy }): Promise<void>`
  - `getMessage(db, messageId): Promise<RRMessage | null>` where `RRMessage = { guildId, messageId, channelId, embedName, style, type, limit, whitelist: string[], blacklist: string[], selfdestructAt: Date | null, entries: Entry[] }` and `Entry = { id, roleId, emoji, label, position }`
  - `listMessages(db, guildId): Promise<RRMessage[]>` (entries included, newest first)
  - `updateMessage(db, messageId, patch)` — patch keys any of `type, limit, whitelist, blacklist, selfdestructAt`; returns boolean
  - `addEntry(db, messageId, { roleId, emoji, label }): Promise<Entry | 'duplicate' | 'full'>` (`MAX_ENTRIES` from config.js is 20; duplicate = same role or same emoji)
  - `removeEntry(db, messageId, roleId): Promise<boolean>`
  - `deleteMessage(db, messageId): Promise<boolean>`, `deleteMessagesInChannel(db, guildId, channelId): Promise<string[]>` (returns deleted message ids), `deleteGuildMessages(db, guildId): Promise<string[]>`, `deleteEntriesForRole(db, guildId, roleId): Promise<string[]>` (affected message ids)
  - `getBinding(db, messageId, userId): Promise<string | null>`, `setBinding(db, { guildId, messageId, userId, roleId })`, `clearMemberBindings(db, guildId, userId)`
- Consumes: `MAX_ENTRIES` from `config.js` (create `config.js` with just the constants here; Task 2 extends it).

- [ ] **Step 1: Write failing tests** in `reactionroles-store.test.js` (pattern: `test/features/automod-history.test.js`, `testDb`/`resetDb`):
  - `createMessage then getMessage returns defaults` — type `normal`, `limit` null, empty lists and entries, `selfdestructAt` null.
  - `addEntry numbers positions and rejects duplicates` — second call with same role → `'duplicate'`; same emoji different role → `'duplicate'`; positions 0,1,2.
  - `addEntry refuses the 21st entry with 'full'`.
  - `updateMessage changes type, limit, lists and selfdestructAt; unknown message returns false`.
  - `removeEntry deletes one entry; deleteMessage cascades entries and bindings`.
  - `deleteEntriesForRole returns each affected message id once`.
  - `deleteMessagesInChannel and deleteGuildMessages return the deleted ids`.
  - `bindings: setBinding is one per member and message; clearMemberBindings only clears that guild's`.
- [ ] **Step 2:** `node --test test/features/reactionroles-store.test.js` → FAIL (module missing).
- [ ] **Step 3: Write migration 009.** Tables `reaction_role_messages(message_id TEXT PRIMARY KEY, guild_id, channel_id, embed_name TEXT NULL, style, type, "limit" INT NULL, whitelist JSONB DEFAULT '[]', blacklist JSONB DEFAULT '[]', selfdestruct_at TIMESTAMPTZ NULL, created_by, created_at)`, `reaction_role_entries(id SERIAL PRIMARY KEY, message_id REFERENCES reaction_role_messages ON DELETE CASCADE, role_id, emoji NULL, label NULL, position INT, UNIQUE(message_id, role_id))` plus a partial unique index on `(message_id, emoji) WHERE emoji IS NOT NULL`, `reaction_role_bindings(guild_id, message_id REFERENCES ... ON DELETE CASCADE, user_id, role_id, PRIMARY KEY(message_id, user_id))`. Index `reaction_role_messages(guild_id)`. Add the three new tables to the explicit TRUNCATE list in `resetDb` (`src/db/index.js:39`).
- [ ] **Step 4: Implement `store.js`** with the signatures above. `addEntry` counts and inserts in one transaction (`SELECT ... FOR UPDATE` on the message row) so two concurrent adds cannot pass 20.
- [ ] **Step 5:** run the test file → PASS; run `node --test test/db` to confirm migrations still apply.
- [ ] **Step 6: Commit** `feat(reactionroles): tables and store`.

#### Reference code

**`src/db/migrations/009_reaction_roles.sql`**

```sql
CREATE TABLE reaction_role_messages (
  message_id TEXT PRIMARY KEY,
  guild_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  embed_name TEXT,
  style TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'normal',
  "limit" INTEGER,
  whitelist JSONB NOT NULL DEFAULT '[]',
  blacklist JSONB NOT NULL DEFAULT '[]',
  selfdestruct_at TIMESTAMPTZ,
  created_by TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX reaction_role_messages_guild ON reaction_role_messages (guild_id);

CREATE TABLE reaction_role_entries (
  id SERIAL PRIMARY KEY,
  message_id TEXT NOT NULL REFERENCES reaction_role_messages (message_id) ON DELETE CASCADE,
  role_id TEXT NOT NULL,
  emoji TEXT,
  label TEXT,
  position INTEGER NOT NULL,
  UNIQUE (message_id, role_id)
);
CREATE UNIQUE INDEX reaction_role_entries_emoji ON reaction_role_entries (message_id, emoji) WHERE emoji IS NOT NULL;

CREATE TABLE reaction_role_bindings (
  guild_id TEXT NOT NULL,
  message_id TEXT NOT NULL REFERENCES reaction_role_messages (message_id) ON DELETE CASCADE,
  user_id TEXT NOT NULL,
  role_id TEXT NOT NULL,
  PRIMARY KEY (message_id, user_id)
);
```

Also add the three tables to the `TRUNCATE` list in `resetDb` (`src/db/index.js:39`): `..., verification_overwrites, reaction_role_messages, reaction_role_entries, reaction_role_bindings RESTART IDENTITY`.

**`src/features/reactionroles/config.js (constants only in this task; Task 2 completes it)`**

```js
export const STYLES = ['reactions', 'buttons', 'menu'];
export const TYPES = ['normal', 'unique', 'verify', 'drop', 'reversed', 'binding', 'lock'];
export const MAX_ENTRIES = 20;
export const SELFDESTRUCT_JOB = 'reactionroles.destruct';
```

**`src/features/reactionroles/store.js`**

```js
import { MAX_ENTRIES } from './config.js';

const entryOf = (r) => ({ id: r.id, roleId: r.role_id, emoji: r.emoji, label: r.label, position: r.position });
const messageOf = (r, entries) => ({
  guildId: r.guild_id,
  messageId: r.message_id,
  channelId: r.channel_id,
  embedName: r.embed_name,
  style: r.style,
  type: r.type,
  limit: r.limit,
  whitelist: r.whitelist,
  blacklist: r.blacklist,
  selfdestructAt: r.selfdestruct_at,
  entries,
});

export async function createMessage(db, { guildId, messageId, channelId, embedName = null, style, type = 'normal', createdBy }) {
  await db.query(
    `INSERT INTO reaction_role_messages (message_id, guild_id, channel_id, embed_name, style, type, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [messageId, guildId, channelId, embedName, style, type, createdBy],
  );
}

async function withEntries(db, rows) {
  if (!rows.length) return [];
  const { rows: entryRows } = await db.query(
    'SELECT * FROM reaction_role_entries WHERE message_id = ANY($1) ORDER BY position', [rows.map((r) => r.message_id)]);
  return rows.map((r) => messageOf(r, entryRows.filter((e) => e.message_id === r.message_id).map(entryOf)));
}

export async function getMessage(db, messageId) {
  const { rows } = await db.query('SELECT * FROM reaction_role_messages WHERE message_id = $1', [messageId]);
  return (await withEntries(db, rows))[0] ?? null;
}

export async function listMessages(db, guildId) {
  const { rows } = await db.query(
    'SELECT * FROM reaction_role_messages WHERE guild_id = $1 ORDER BY created_at DESC', [guildId]);
  return withEntries(db, rows);
}

const COLUMNS = { type: 'type', limit: '"limit"', whitelist: 'whitelist', blacklist: 'blacklist', selfdestructAt: 'selfdestruct_at' };

export async function updateMessage(db, messageId, patch) {
  const keys = Object.keys(patch).filter((k) => k in COLUMNS);
  if (!keys.length) return false;
  const sets = keys.map((k, i) => `${COLUMNS[k]} = $${i + 2}`);
  const values = keys.map((k) => (Array.isArray(patch[k]) ? JSON.stringify(patch[k]) : patch[k]));
  const { rowCount } = await db.query(
    `UPDATE reaction_role_messages SET ${sets.join(', ')} WHERE message_id = $1`, [messageId, ...values]);
  return rowCount > 0;
}

export async function addEntry(db, messageId, { roleId, emoji = null, label = null }) {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const locked = await client.query('SELECT 1 FROM reaction_role_messages WHERE message_id = $1 FOR UPDATE', [messageId]);
    if (!locked.rowCount) {
      await client.query('ROLLBACK');
      return 'missing';
    }
    const { rows } = await client.query(
      'SELECT role_id, emoji, position FROM reaction_role_entries WHERE message_id = $1', [messageId]);
    if (rows.length >= MAX_ENTRIES) {
      await client.query('ROLLBACK');
      return 'full';
    }
    if (rows.some((r) => r.role_id === roleId || (emoji && r.emoji === emoji))) {
      await client.query('ROLLBACK');
      return 'duplicate';
    }
    const position = rows.reduce((max, r) => Math.max(max, r.position + 1), 0);
    const inserted = await client.query(
      `INSERT INTO reaction_role_entries (message_id, role_id, emoji, label, position)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [messageId, roleId, emoji, label, position]);
    await client.query('COMMIT');
    return entryOf(inserted.rows[0]);
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

export async function removeEntry(db, messageId, roleId) {
  const { rowCount } = await db.query(
    'DELETE FROM reaction_role_entries WHERE message_id = $1 AND role_id = $2', [messageId, roleId]);
  return rowCount > 0;
}

export async function deleteMessage(db, messageId) {
  const { rowCount } = await db.query('DELETE FROM reaction_role_messages WHERE message_id = $1', [messageId]);
  return rowCount > 0;
}

async function deleteReturning(db, sql, params) {
  const { rows } = await db.query(sql, params);
  return [...new Set(rows.map((r) => r.message_id))];
}

export const deleteMessagesInChannel = (db, guildId, channelId) => deleteReturning(db,
  'DELETE FROM reaction_role_messages WHERE guild_id = $1 AND channel_id = $2 RETURNING message_id', [guildId, channelId]);

export const deleteGuildMessages = (db, guildId) => deleteReturning(db,
  'DELETE FROM reaction_role_messages WHERE guild_id = $1 RETURNING message_id', [guildId]);

export const deleteEntriesForRole = (db, guildId, roleId) => deleteReturning(db,
  `DELETE FROM reaction_role_entries e USING reaction_role_messages m
   WHERE e.message_id = m.message_id AND m.guild_id = $1 AND e.role_id = $2
   RETURNING e.message_id`, [guildId, roleId]);

export async function getBinding(db, messageId, userId) {
  const { rows } = await db.query(
    'SELECT role_id FROM reaction_role_bindings WHERE message_id = $1 AND user_id = $2', [messageId, userId]);
  return rows[0]?.role_id ?? null;
}

export async function setBinding(db, { guildId, messageId, userId, roleId }) {
  await db.query(
    `INSERT INTO reaction_role_bindings (guild_id, message_id, user_id, role_id) VALUES ($1, $2, $3, $4)
     ON CONFLICT (message_id, user_id) DO NOTHING`, [guildId, messageId, userId, roleId]);
}

export async function clearMemberBindings(db, guildId, userId) {
  await db.query('DELETE FROM reaction_role_bindings WHERE guild_id = $1 AND user_id = $2', [guildId, userId]);
}
```

**`test/features/reactionroles-store.test.js`**

```js
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { testDb } from '../helpers/db.js';
import { resetDb } from '../../src/db/index.js';
import {
  createMessage, getMessage, addEntry, updateMessage, removeEntry, deleteMessage,
  deleteEntriesForRole, setBinding, getBinding, clearMemberBindings,
} from '../../src/features/reactionroles/store.js';

let db;
before(async () => {
  db = await testDb();
});
after(async () => {
  await db.end();
});
beforeEach(async () => {
  await resetDb(db);
});

const base = { guildId: 'g1', messageId: 'm1', channelId: 'c1', style: 'reactions', createdBy: 'u1' };

test('createMessage then getMessage returns the defaults', async () => {
  await createMessage(db, base);
  const m = await getMessage(db, 'm1');
  assert.equal(m.type, 'normal');
  assert.equal(m.limit, null);
  assert.deepEqual(m.whitelist, []);
  assert.deepEqual(m.entries, []);
  assert.equal(m.selfdestructAt, null);
});

test('addEntry numbers positions and rejects duplicate roles and emoji', async () => {
  await createMessage(db, base);
  const a = await addEntry(db, 'm1', { roleId: 'r1', emoji: '😀' });
  const b = await addEntry(db, 'm1', { roleId: 'r2', emoji: '👍' });
  assert.deepEqual([a.position, b.position], [0, 1]);
  assert.equal(await addEntry(db, 'm1', { roleId: 'r1', emoji: '🎉' }), 'duplicate');
  assert.equal(await addEntry(db, 'm1', { roleId: 'r3', emoji: '😀' }), 'duplicate');
  assert.equal(await addEntry(db, 'nope', { roleId: 'r9', emoji: '🎉' }), 'missing');
});

test('addEntry refuses the 21st entry', async () => {
  await createMessage(db, { ...base, style: 'buttons' });
  for (let i = 0; i < 20; i += 1) assert.equal(typeof (await addEntry(db, 'm1', { roleId: `r${i}`, label: `L${i}` })), 'object');
  assert.equal(await addEntry(db, 'm1', { roleId: 'r20', label: 'L20' }), 'full');
});

test('two concurrent adds cannot pass the cap', async () => {
  await createMessage(db, { ...base, style: 'buttons' });
  for (let i = 0; i < 19; i += 1) await addEntry(db, 'm1', { roleId: `r${i}`, label: `L${i}` });
  const results = await Promise.all([
    addEntry(db, 'm1', { roleId: 'x1', label: 'X1' }),
    addEntry(db, 'm1', { roleId: 'x2', label: 'X2' }),
  ]);
  assert.equal(results.filter((r) => r === 'full').length, 1);
});

test('updateMessage changes fields; an unknown message returns false', async () => {
  await createMessage(db, base);
  assert.equal(await updateMessage(db, 'm1', { type: 'unique', limit: 2, whitelist: ['w'], blacklist: ['b'], selfdestructAt: new Date(0) }), true);
  const m = await getMessage(db, 'm1');
  assert.deepEqual([m.type, m.limit, m.whitelist, m.blacklist], ['unique', 2, ['w'], ['b']]);
  assert.equal(await updateMessage(db, 'nope', { type: 'verify' }), false);
});

test('deleteMessage cascades entries and bindings; removeEntry removes one', async () => {
  await createMessage(db, base);
  await addEntry(db, 'm1', { roleId: 'r1', emoji: '😀' });
  await addEntry(db, 'm1', { roleId: 'r2', emoji: '👍' });
  await setBinding(db, { guildId: 'g1', messageId: 'm1', userId: 'u2', roleId: 'r1' });
  assert.equal(await removeEntry(db, 'm1', 'r1'), true);
  assert.equal((await getMessage(db, 'm1')).entries.length, 1);
  assert.equal(await deleteMessage(db, 'm1'), true);
  assert.equal(await getBinding(db, 'm1', 'u2'), null);
});

test('deleteEntriesForRole returns each affected message once', async () => {
  await createMessage(db, base);
  await createMessage(db, { ...base, messageId: 'm2' });
  await addEntry(db, 'm1', { roleId: 'r1', emoji: '😀' });
  await addEntry(db, 'm2', { roleId: 'r1', emoji: '😀' });
  assert.deepEqual((await deleteEntriesForRole(db, 'g1', 'r1')).sort(), ['m1', 'm2']);
});

test('bindings are one per member and message, and clearMemberBindings is per guild', async () => {
  await createMessage(db, base);
  await setBinding(db, { guildId: 'g1', messageId: 'm1', userId: 'u2', roleId: 'r1' });
  await setBinding(db, { guildId: 'g1', messageId: 'm1', userId: 'u2', roleId: 'r2' });
  assert.equal(await getBinding(db, 'm1', 'u2'), 'r1');
  await clearMemberBindings(db, 'g2', 'u2');
  assert.equal(await getBinding(db, 'm1', 'u2'), 'r1');
  await clearMemberBindings(db, 'g1', 'u2');
  assert.equal(await getBinding(db, 'm1', 'u2'), null);
});
```


---

### Task 2: Config helpers and pick rules (pure)

**Files:**
- Create/extend: `src/features/reactionroles/config.js`; create `src/features/reactionroles/rules.js`
- Test: `test/features/reactionroles-config.test.js`, `test/features/reactionroles-rules.test.js`

**Tier:** sonnet — rule table with many interacting cases, no I/O

**Interfaces:**
- Produces in `config.js`: `STYLES`, `TYPES`, `MAX_ENTRIES`, `SELFDESTRUCT_JOB = 'reactionroles.destruct'`, `parseEmoji(input: string, guild): { emoji: string, key: string } | { error: 'invalid' | 'foreign' }` (Unicode emoji → `emoji === key === the char`; `<:name:id>` / `<a:name:id>` → `key` is the id and must exist in `guild.emojis.cache` and be available, else `foreign`), `emojiKey(stored: string): string` (id of a custom emoji string, else the string), `checkEntryInput(style, { emoji, label }): 'ok' | 'emoji_required' | 'label_required'` (reactions need an emoji; buttons and menu need a label or an emoji), `typeAllowedForStyle(type, style): boolean` (false only for `reversed` with `buttons`/`menu`).
- Produces in `rules.js`: `decidePick({ message, entry, action, memberRoleIds, binding }): Decision` and `decideMenu({ message, selectedRoleIds, memberRoleIds, binding }): Decision`, where `action` is `'add' | 'remove' | 'toggle'`, `memberRoleIds` is a `Set<string>` of every role the member holds, `binding` is the role id of a stored binding or null, and `Decision = { ok: true, add: string[], remove: string[], clearReaction: boolean } | { ok: false, reason: 'locked' | 'blacklisted' | 'not_whitelisted' | 'bound' | 'limit' | 'nothing', clearReaction: boolean }`.

- [ ] **Step 1: Write failing tests.** Config: unicode emoji parsed; custom emoji of this guild parsed with `key` = id; custom emoji not in the guild → `foreign`; garbage → `invalid`; `typeAllowedForStyle('reversed','buttons') === false`. Rules (a table-driven test, one assertion per row):
  - normal/reactions: `add` of unheld role → add it; `remove` of held role → remove it; `remove` of unheld → `nothing`.
  - normal/toggle: held → remove, unheld → add.
  - unique: add B while holding A (A, B both entries) → `add:[B], remove:[A]`; remove action on unique removes the role.
  - verify: add → add; remove/toggle of held → `nothing`; `clearReaction` true.
  - drop: add action removes held role, unheld → `nothing`; `clearReaction` true.
  - reversed: `add` action removes, `remove` action adds.
  - binding: first pick adds and `clearReaction` true; with `binding` set → `bound`.
  - lock: always `locked`, `clearReaction` true.
  - check order: lock, blacklist, whitelist, binding/unique, limit; blacklisted member → `blacklisted` with `clearReaction` true; whitelist set and member lacks every whitelisted role → `not_whitelisted`.
  - limit 2 with two held entry roles → `limit`; limit does not block removals; unique ignores limit.
  - `decideMenu`: selection `{A,B}` on unique → `limit`-style refusal is not used: unique/binding menus accept one value only, a selection of two → `limit`; empty selection on verify/binding/lock → `ok` with no add/remove (for lock → `locked`); on normal → removes all held entry roles; a selection violating `limit` is refused whole.
- [ ] **Step 2:** run both files → FAIL.
- [ ] **Step 3: Implement** `config.js` (extend the Task 1 constants) and `rules.js`. Role counting uses entries of this message that are in `memberRoleIds`.
- [ ] **Step 4:** run both files → PASS.
- [ ] **Step 5: Commit** `feat(reactionroles): emoji parsing and pick rules`.

#### Reference code

**`src/features/reactionroles/config.js (complete file)`**

```js
export const STYLES = ['reactions', 'buttons', 'menu'];
export const TYPES = ['normal', 'unique', 'verify', 'drop', 'reversed', 'binding', 'lock'];
export const MAX_ENTRIES = 20;
export const SELFDESTRUCT_JOB = 'reactionroles.destruct';

const CUSTOM = /^<(a?):(\w{2,32}):(\d{17,20})>$/;
const UNICODE = /^(?:\p{Extended_Pictographic}[️‍\p{Extended_Pictographic}\p{Emoji_Modifier}]*|\p{Regional_Indicator}{2}|[0-9#*]️?⃣)$/u;

/** Parses what staff typed into an emoji: `{ emoji, key }` or `{ error: 'invalid' | 'foreign' }`. */
export function parseEmoji(input, guild) {
  const text = String(input ?? '').trim();
  const custom = CUSTOM.exec(text);
  if (custom) {
    const found = guild?.emojis?.cache?.get(custom[3]);
    if (!found || found.available === false) return { error: 'foreign' };
    return { emoji: text, key: custom[3] };
  }
  if (UNICODE.test(text)) return { emoji: text, key: text };
  return { error: 'invalid' };
}

/** The id of a stored custom emoji, or the Unicode character itself. Matches `reaction.emoji.id ?? reaction.emoji.name`. */
export function emojiKey(stored) {
  const custom = CUSTOM.exec(stored ?? '');
  return custom ? custom[3] : stored;
}

/** A stored emoji in the shape a button or menu option accepts. */
export function componentEmoji(stored) {
  const custom = CUSTOM.exec(stored ?? '');
  return custom ? { id: custom[3], name: custom[2], animated: custom[1] === 'a' } : stored;
}

export function checkEntryInput(style, { emoji, label }) {
  if (style === 'reactions') return emoji ? 'ok' : 'emoji_required';
  return label || emoji ? 'ok' : 'label_required';
}

/** `reversed` needs a "reaction removed" action, which buttons and menus do not have. */
export function typeAllowedForStyle(type, style) {
  return !(type === 'reversed' && style !== 'reactions');
}
```

**`src/features/reactionroles/rules.js`**

```js
// Pure pick decisions: no Discord, no database. `message` is an RRMessage from store.js.
const entryRoles = (message) => message.entries.map((e) => e.roleId);

// Lock, blacklist, whitelist: the checks that apply to every type, in that order.
function gate(message, memberRoleIds) {
  if (message.type === 'lock') return 'locked';
  if (message.blacklist.some((r) => memberRoleIds.has(r))) return 'blacklisted';
  if (message.whitelist.length && !message.whitelist.some((r) => memberRoleIds.has(r))) return 'not_whitelisted';
  return null;
}

/**
 * One reaction or button pick. `action`: 'add' (reaction added), 'remove' (reaction removed),
 * 'toggle' (button). `clearReaction` tells the caller to remove the member's reaction.
 */
export function decidePick({ message, entry, action, memberRoleIds, binding = null }) {
  const { type } = message;
  // A reaction that was already removed needs no clearing.
  const stop = (reason) => ({ ok: false, reason, clearReaction: action === 'add' });

  const blocked = gate(message, memberRoleIds);
  if (blocked) return stop(blocked);

  const held = memberRoleIds.has(entry.roleId);
  let want;
  if (type === 'verify' || type === 'binding') want = action === 'remove' ? null : 'add';
  else if (type === 'drop') want = action === 'remove' ? null : 'remove';
  else if (action === 'toggle') want = held ? 'remove' : 'add';
  else if (type === 'reversed') want = action === 'add' ? 'remove' : 'add';
  else want = action;

  if (want === 'remove') {
    if (!held) return stop('nothing');
    return { ok: true, add: [], remove: [entry.roleId], clearReaction: type === 'drop' };
  }
  if (want === 'add') {
    if (held) return stop('nothing');
    if (type === 'binding' && binding) return stop('bound');
    const others = entryRoles(message).filter((r) => r !== entry.roleId && memberRoleIds.has(r));
    const single = type === 'unique' || type === 'binding';
    if (!single && message.limit != null && others.length >= message.limit) return stop('limit');
    return {
      ok: true,
      add: [entry.roleId],
      remove: type === 'unique' ? others : [],
      clearReaction: type === 'verify' || type === 'binding',
    };
  }
  return stop('nothing');
}

/** A dropdown submission: `selectedRoleIds` is the whole selection. Refused whole or applied whole. */
export function decideMenu({ message, selectedRoleIds, memberRoleIds, binding = null }) {
  const stop = (reason) => ({ ok: false, reason, clearReaction: false });
  const blocked = gate(message, memberRoleIds);
  if (blocked) return stop(blocked);

  const { type } = message;
  const roles = entryRoles(message);
  const selected = new Set(selectedRoleIds.filter((r) => roles.includes(r)));
  const held = roles.filter((r) => memberRoleIds.has(r));
  const single = type === 'unique' || type === 'binding';
  if (single && selected.size > 1) return stop('limit');

  let add = [];
  let remove = [];
  if (type === 'drop') {
    remove = held.filter((r) => selected.has(r));
  } else {
    add = [...selected].filter((r) => !memberRoleIds.has(r));
    if (type === 'normal' || type === 'unique') remove = held.filter((r) => !selected.has(r));
  }
  if (type === 'binding' && binding && add.length) return stop('bound');
  if (!add.length && !remove.length) return stop('nothing');
  if (type !== 'unique' && type !== 'binding' && message.limit != null) {
    if (held.length - remove.length + add.length > message.limit) return stop('limit');
  }
  return { ok: true, add, remove, clearReaction: false };
}
```

The table-driven rules test mirrors the cases in Step 1 and follows the code above: for example `decidePick({ message, entry: { roleId: 'B' }, action: 'add', memberRoleIds: new Set(['A']) })` on a `unique` message returns `add: ['B'], remove: ['A']`, a `lock` message always returns `reason: 'locked'`, and `decideMenu` with an empty selection on a `verify` message returns `reason: 'nothing'`.


---

### Task 3: Applying a pick

**Files:**
- Create: `src/features/reactionroles/apply.js`
- Test: `test/features/reactionroles-apply.test.js`

**Tier:** sonnet — concurrency and Discord edge, uses fakes

**Interfaces:**
- Consumes: `getMessage`, `getBinding`, `setBinding` (store); `decidePick`, `decideMenu` (rules); `botCanGive` (role-safety).
- Produces: `applyPick(ctx, member, message, pick, deps = {}): Promise<Result>` where `pick = { kind: 'entry', entry, action } | { kind: 'menu', roleIds: string[] }` and `Result = { ok: true, added: string[], removed: string[], clearReaction: boolean } | { ok: false, reason: 'locked'|'blacklisted'|'not_whitelisted'|'bound'|'limit'|'nothing'|'role_missing'|'cannot_give'|'discord_failed', clearReaction: boolean }`. `deps` lets tests inject `now`-free fakes (`botCanGive`).

- [ ] **Step 1: Write failing tests** with a fake member (`roles.cache` Map, `roles.add/remove` recording calls, `guild` with roles cache) and the real test DB for bindings:
  - `adds a role and returns it`.
  - `removes the old role of a unique message` (both calls recorded).
  - `refuses a role deleted from the guild with 'role_missing' and changes nothing`.
  - `refuses with 'cannot_give' when botCanGive is false at pick time`.
  - `a Discord error from roles.add yields 'discord_failed', never throws`.
  - `binding pick stores a binding; a second pick returns 'bound'`.
  - `two simultaneous applyPick calls for the same member and message run one after the other` — on a `unique` message with entries A and B, fire both at once with a fake whose `roles.add` yields to the event loop; the member ends with exactly one entry role. Two calls for different members are not serialized against each other.
- [ ] **Step 2:** run → FAIL.
- [ ] **Step 3: Implement `applyPick`.** Serialize with a module-level `Map<string, Promise>` keyed `${messageId}:${userId}` (chain, delete the key when idle). Inside the critical section: reload the binding, compute `memberRoleIds` from `member.roles.cache`, run the decision, verify every role to add exists in `member.guild.roles.cache` and passes `botCanGive`, apply with `member.roles.add/remove(ids, 'Reaction roles')` inside try/catch, and on success of a `binding` add call `setBinding`.
- [ ] **Step 4:** run → PASS.
- [ ] **Step 5: Commit** `feat(reactionroles): apply a pick under a per-member lock`.

#### Reference code

**`src/features/reactionroles/apply.js`**

```js
import { getBinding, setBinding } from './store.js';
import { decidePick, decideMenu } from './rules.js';
import { botCanGive as defaultBotCanGive } from '../../core/role-safety.js';

const REASON = 'Reaction roles';
const chains = new Map();

// Runs `fn` after every earlier call with the same key finished, so one member's picks never overlap.
function serialize(key, fn) {
  const next = (chains.get(key) ?? Promise.resolve()).catch(() => {}).then(fn);
  chains.set(key, next);
  const clean = () => {
    if (chains.get(key) === next) chains.delete(key);
  };
  next.then(clean, clean);
  return next;
}

/** Applies one pick (`{kind:'entry', entry, action}` or `{kind:'menu', roleIds}`) to a member. Never throws. */
export function applyPick(ctx, member, message, pick, deps = {}) {
  return serialize(`${message.messageId}:${member.id}`, () => run(ctx, member, message, pick, deps));
}

async function run(ctx, member, message, pick, deps) {
  const botCanGive = deps.botCanGive ?? defaultBotCanGive;
  const binding = await getBinding(ctx.db, message.messageId, member.id);
  const memberRoleIds = new Set(member.roles.cache.keys());
  const decision = pick.kind === 'menu'
    ? decideMenu({ message, selectedRoleIds: pick.roleIds, memberRoleIds, binding })
    : decidePick({ message, entry: pick.entry, action: pick.action, memberRoleIds, binding });
  if (!decision.ok) return decision;

  const refuse = (reason) => ({ ok: false, reason, clearReaction: decision.clearReaction });
  const guild = member.guild;
  for (const id of decision.add) {
    const role = guild.roles.cache.get(id);
    if (!role) return refuse('role_missing');
    if (!botCanGive(guild, role)) return refuse('cannot_give');
  }
  try {
    if (decision.remove.length) await member.roles.remove(decision.remove, REASON);
    if (decision.add.length) await member.roles.add(decision.add, REASON);
  } catch (err) {
    console.warn(`Reaction role change failed: ${err.message}`);
    return refuse('discord_failed');
  }
  if (message.type === 'binding' && decision.add.length) {
    await setBinding(ctx.db, { guildId: guild.id, messageId: message.messageId, userId: member.id, roleId: decision.add[0] });
  }
  return { ok: true, added: decision.add, removed: decision.remove, clearReaction: decision.clearReaction };
}
```

**`test/features/reactionroles-apply.test.js`**

```js
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { testDb } from '../helpers/db.js';
import { resetDb } from '../../src/db/index.js';
import { applyPick } from '../../src/features/reactionroles/apply.js';
import { createMessage, addEntry, getMessage } from '../../src/features/reactionroles/store.js';

let db;
before(async () => {
  db = await testDb();
});
after(async () => {
  await db.end();
});
beforeEach(async () => {
  await resetDb(db);
});

// A guild with roles A, B, C and a member whose role changes land after a tick, like the real API.
function fakeMember(held = []) {
  const roles = new Map([['A', {}], ['B', {}], ['C', {}]]);
  const cache = new Map(held.map((id) => [id, {}]));
  const calls = [];
  return {
    id: 'u1',
    calls,
    guild: { id: 'g1', roles: { cache: roles } },
    roles: {
      cache,
      async add(ids) {
        await new Promise((r) => setImmediate(r));
        calls.push(['add', ids]);
        for (const id of ids) cache.set(id, {});
      },
      async remove(ids) {
        await new Promise((r) => setImmediate(r));
        calls.push(['remove', ids]);
        for (const id of ids) cache.delete(id);
      },
    },
  };
}

async function seed(type, extra = {}) {
  await createMessage(db, { guildId: 'g1', messageId: 'm1', channelId: 'c1', style: 'buttons', type, createdBy: 'x' });
  for (const id of ['A', 'B', 'C']) await addEntry(db, 'm1', { roleId: id, label: id });
  return { ...(await getMessage(db, 'm1')), ...extra };
}

const ctx = () => ({ db });
const allow = { botCanGive: () => true };
const toggle = (message, roleId) => ({ kind: 'entry', entry: message.entries.find((e) => e.roleId === roleId), action: 'toggle' });

test('adds a role and returns it', async () => {
  const message = await seed('normal');
  const member = fakeMember();
  const result = await applyPick(ctx(), member, message, toggle(message, 'A'), allow);
  assert.deepEqual([result.ok, result.added], [true, ['A']]);
  assert.ok(member.roles.cache.has('A'));
});

test('refuses a role deleted from the guild with role_missing', async () => {
  const message = await seed('normal');
  const member = fakeMember();
  member.guild.roles.cache.delete('A');
  const result = await applyPick(ctx(), member, message, toggle(message, 'A'), allow);
  assert.deepEqual([result.ok, result.reason], [false, 'role_missing']);
  assert.equal(member.calls.length, 0);
});

test('refuses with cannot_give when the bot can no longer give the role', async () => {
  const message = await seed('normal');
  const result = await applyPick(ctx(), fakeMember(), message, toggle(message, 'A'), { botCanGive: () => false });
  assert.equal(result.reason, 'cannot_give');
});

test('a Discord error becomes discord_failed and never throws', async () => {
  const message = await seed('normal');
  const member = fakeMember();
  member.roles.add = async () => {
    throw new Error('Missing Permissions');
  };
  const result = await applyPick(ctx(), member, message, toggle(message, 'A'), allow);
  assert.equal(result.reason, 'discord_failed');
});

test('a binding pick is stored and a second pick returns bound', async () => {
  const message = await seed('binding');
  const member = fakeMember();
  const verify = (roleId) => ({ kind: 'entry', entry: message.entries.find((e) => e.roleId === roleId), action: 'add' });
  assert.equal((await applyPick(ctx(), member, message, verify('A'), allow)).ok, true);
  member.roles.cache.delete('A');
  assert.equal((await applyPick(ctx(), member, message, verify('B'), allow)).reason, 'bound');
});

test('two simultaneous picks on a unique message leave exactly one role', async () => {
  const message = await seed('unique');
  const member = fakeMember();
  const add = (roleId) => ({ kind: 'entry', entry: message.entries.find((e) => e.roleId === roleId), action: 'add' });
  await Promise.all([
    applyPick(ctx(), member, message, add('A'), allow),
    applyPick(ctx(), member, message, add('B'), allow),
  ]);
  const held = ['A', 'B', 'C'].filter((id) => member.roles.cache.has(id));
  assert.equal(held.length, 1);
});
```


---

### Task 4: Rendering

**Files:**
- Create: `src/features/reactionroles/render.js`
- Test: `test/features/reactionroles-render.test.js`

**Tier:** sonnet — Discord component limits, fakes for messages

**Interfaces:**
- Consumes: `getEmbed` (`src/features/embeds/store.js`), `buildEmbedPayload` (`src/features/embeds/render.js`), `buildVars` (`src/core/placeholders.js`), `RRMessage`/`Entry` (Task 1), `emojiKey`.
- Produces:
  - `buildComponents(message, guild): ActionRowBuilder[]` — `buttons`: rows of up to 5 buttons, customId `reactionroles:btn:<messageId>:<entryId>`, label/emoji from the entry, style Secondary; `menu`: one `StringSelectMenuBuilder`, customId `reactionroles:menu:<messageId>`, `minValues 0`, `maxValues` = 1 for `unique`/`binding` else the entry count, option value = role id, label = entry label or the role name; `reactions`: `[]`. A message with no entries returns `[]`.
  - `missingReactions(message, discordMessage): string[]` (emoji strings the bot's own reactions lack)
  - `syncMessage(ctx, message, discordMessage): Promise<{ ok: boolean, reason?: 'cannot_edit' | 'cannot_react' }>` — `edit({ components })` for buttons/menu; for reactions, add missing own reactions in entry order and remove the bot's reactions for emoji no longer in an entry.
  - `postRoleMessage(ctx, interaction, lang, channel, embedName): Promise<{ message } | { error: 'missing' | 'image' | 'invalid' | 'cannot_send' }>` — loads the named embed, builds its payload with `buildEmbedPayload`, sends it with `allowedMentions: safeMentions()` via `trySend`.
  - `refreshEmbed(ctx, interaction, lang, message, discordMessage): Promise<{ ok: true } | { error }>` — re-renders the named embed payload and edits the message, keeping components.
- [ ] **Step 1: Write failing tests:** buttons split 12 entries into rows of 5,5,2; 20 entries fit; a menu with `unique` has `maxValues 1`, with `normal` and 4 entries has 4; `reactions` style returns `[]`; `missingReactions` lists only the emoji the bot has not reacted with; `syncMessage` on reactions removes a stale own reaction and adds a missing one (fake message with a `reactions.cache`).
- [ ] **Step 2:** run → FAIL.
- [ ] **Step 3: Implement** with discord.js builders (`ButtonBuilder`, `StringSelectMenuBuilder`, `ActionRowBuilder`). Option/label text truncated to Discord's limits (80 for button label, 100 for option label).
- [ ] **Step 4:** run → PASS.
- [ ] **Step 5: Commit** `feat(reactionroles): render components and sync reactions`.

#### Reference code

**`src/features/reactionroles/render.js`**

```js
import { ActionRowBuilder, ButtonBuilder, ButtonStyle, StringSelectMenuBuilder } from 'discord.js';
import { getEmbed } from '../embeds/store.js';
import { buildEmbedPayload } from '../embeds/render.js';
import { buildVars } from '../../core/placeholders.js';
import { safeMentions } from '../../core/mentions.js';
import { trySend } from '../../core/send.js';
import { componentEmoji, emojiKey } from './config.js';

export const PREFIX = 'reactionroles';

const roleName = (guild, roleId) => guild?.roles?.cache?.get(roleId)?.name ?? roleId;

function button(message, entry) {
  const b = new ButtonBuilder()
    .setCustomId(`${PREFIX}:btn:${message.messageId}:${entry.id}`)
    .setStyle(ButtonStyle.Secondary);
  if (entry.label) b.setLabel(entry.label.slice(0, 80));
  if (entry.emoji) b.setEmoji(componentEmoji(entry.emoji));
  return b;
}

/** The action rows for a message: up to 5 buttons per row, or one dropdown; none for reactions. */
export function buildComponents(message, guild) {
  const { entries, style } = message;
  if (!entries.length || style === 'reactions') return [];
  if (style === 'buttons') {
    const rows = [];
    for (let i = 0; i < entries.length; i += 5) {
      rows.push(new ActionRowBuilder().addComponents(entries.slice(i, i + 5).map((e) => button(message, e))));
    }
    return rows;
  }
  const single = message.type === 'unique' || message.type === 'binding';
  const menu = new StringSelectMenuBuilder()
    .setCustomId(`${PREFIX}:menu:${message.messageId}`)
    .setMinValues(0)
    .setMaxValues(single ? 1 : entries.length)
    .addOptions(entries.map((e) => {
      const option = { label: (e.label || roleName(guild, e.roleId)).slice(0, 100), value: e.roleId };
      if (e.emoji) option.emoji = componentEmoji(e.emoji);
      return option;
    }));
  return [new ActionRowBuilder().addComponents(menu)];
}

const botReactionKeys = (discordMessage) =>
  new Set([...discordMessage.reactions.cache.values()].filter((r) => r.me).map((r) => r.emoji.id ?? r.emoji.name));

/** Emoji of entries that the bot has not reacted with yet. */
export function missingReactions(message, discordMessage) {
  const have = botReactionKeys(discordMessage);
  return message.entries.filter((e) => e.emoji && !have.has(emojiKey(e.emoji))).map((e) => e.emoji);
}

/** Brings the Discord message in line with the stored entries. */
export async function syncMessage(ctx, message, discordMessage) {
  try {
    if (message.style !== 'reactions') {
      await discordMessage.edit({ components: buildComponents(message, discordMessage.guild) });
      return { ok: true };
    }
  } catch {
    return { ok: false, reason: 'cannot_edit' };
  }
  try {
    const wanted = new Set(message.entries.filter((e) => e.emoji).map((e) => emojiKey(e.emoji)));
    for (const reaction of discordMessage.reactions.cache.values()) {
      if (reaction.me && !wanted.has(reaction.emoji.id ?? reaction.emoji.name)) await reaction.users.remove(ctx.client.user.id);
    }
    for (const emoji of missingReactions(message, discordMessage)) await discordMessage.react(emoji);
    return { ok: true };
  } catch {
    return { ok: false, reason: 'cannot_react' };
  }
}

async function embedPayload(ctx, guild, user, member, lang, embedName) {
  const spec = await getEmbed(ctx.db, guild.id, embedName);
  if (!spec) return { error: 'missing' };
  try {
    return { payload: await buildEmbedPayload(ctx, guild.id, spec, buildVars({ user, member, guild, lang })) };
  } catch (err) {
    return { error: err.message === 'image-not-found' ? 'image' : 'invalid' };
  }
}

/** Posts the named embed to `channel`. Returns `{ message }` or `{ error: 'missing' | 'image' | 'invalid' | 'cannot_send' }`. */
export async function postRoleMessage(ctx, interaction, lang, channel, embedName) {
  const built = await embedPayload(ctx, interaction.guild, interaction.user, interaction.member, lang, embedName);
  if (built.error) return built;
  const sent = await trySend(channel, { ...built.payload, allowedMentions: safeMentions() });
  return sent ? { message: sent } : { error: 'cannot_send' };
}

/** Re-renders the named embed onto the posted message, keeping its components. */
export async function refreshEmbed(ctx, interaction, lang, message, discordMessage) {
  const built = await embedPayload(ctx, interaction.guild, interaction.user, interaction.member, lang, message.embedName);
  if (built.error) return built;
  await discordMessage.edit({ ...built.payload, allowedMentions: safeMentions() });
  return { ok: true };
}
```


---

### Task 5: Base staff commands

**Files:**
- Create: `src/features/reactionroles/commands.js`, `log.js`, `index.js`
- Modify: `src/i18n/{en,fr,ar}.json`
- Test: `test/features/reactionroles-commands.test.js`

**Tier:** sonnet — multi-file integration with i18n

**Interfaces:**
- Consumes: Tasks 1–4, `guard`, `handleToggle` (`src/core/toggle.js`), `ephemeral`, `sendLog` via `modAction` as in `src/features/moderation/tools-common.js` (`logTool`).
- Produces:
  - `commands.js`: `createReactionRolesCommand(): { data, execute, autocomplete, components }`, where `data` is `/reactionroles` with subcommands `enable`, `disable`, `status`, `create` (`embed` with autocomplete, `style`, optional `channel`, optional `type`), `adopt` (`message_id`, `style`, optional `channel`), `add` (`message_id`, `role`, optional `emoji`, optional `label`), `remove` (`message_id`, `role`), `show` (optional `message_id`). `components: { prefix: 'reactionroles', handle }` is supplied from `components.js` (Task 7); until then `handle` can be a stub exported from `components.js`.
  - `log.js`: `logReactionRoles(ctx, guild, lang, { action, actorId, messageId, detail }, deps = {})` — one `modAction` line, never throws.
  - `index.js`: `export const commands = [createReactionRolesCommand()]`; `events` and `jobs` are added in Tasks 6 and 7.
  - Pure helper `checkRoleForSetup(guild, caller, role): 'ok' | 'dangerous' | 'bot_cannot' | 'caller_cannot'` exported from `commands.js`.
- [ ] **Step 1: Write failing tests** (fake interactions as other command tests do): `checkRoleForSetup` returns each of the four results; `add` on a reactions message without an emoji replies `reactionroles.emojiRequired`; `add` of a dangerous role is refused and nothing stored; `add` the 21st entry replies `reactionroles.full`; `create` with an unknown embed name replies `reactionroles.embedMissing`; `adopt` refuses a message authored by someone else, a message without an embed, and a message that already has components; `create` with `type: reversed` and `style: buttons` is refused; commands reply `common.featureOff` when disabled (except `enable`); `status` lists a message whose Discord message no longer exists.
- [ ] **Step 2:** run → FAIL.
- [ ] **Step 3: Implement** the subcommands. `create` posts through `postRoleMessage`, stores the message with `embedName`; `adopt` fetches the message by id from the channel, requires `author.id === client.user.id`, `embeds.length > 0` and no components, stores it with `embedName: null` and runs `syncMessage`; `add` parses the emoji with `parseEmoji`, validates with `checkEntryInput` and `checkRoleForSetup`, stores the entry and calls `syncMessage`; `remove` removes the entry and syncs. `show` lists messages (or one message's entries, type, limit, lists, timer). Every setup action calls `logReactionRoles`. Add all `reactionroles.*` keys to en, fr and ar.
- [ ] **Step 4:** run the new tests and `node --test test/i18n.test.js` → PASS.
- [ ] **Step 5: Commit** `feat(reactionroles): create, adopt, add, remove, show, status`.

#### Reference code

The complete `commands.js` is shown with its final contents. In this task leave out the lines tagged `// Task 6`, `// Task 7` and `// Task 8` (return `data` without `settingsSubcommands`, keep `HANDLERS` to the base handlers, and omit `components`); those tasks add them.

**`src/features/reactionroles/setup.js`**

```js
// Shared by the slash commands and the builder panel, so both apply the same rules.
import { isDangerousRole, botCanGive, callerCanGive } from '../../core/role-safety.js';
import { parseEmoji, checkEntryInput } from './config.js';
import { addEntry, getMessage } from './store.js';
import { syncMessage } from './render.js';

/** Why a role may not be offered, or 'ok'. */
export function checkRoleForSetup(guild, caller, role) {
  if (isDangerousRole(role)) return 'dangerous';
  if (!botCanGive(guild, role)) return 'bot_cannot';
  if (!callerCanGive(guild, caller, role)) return 'caller_cannot';
  return 'ok';
}

export async function fetchDiscordMessage(guild, message) {
  const channel = await guild.channels.fetch(message.channelId).catch(() => null);
  return channel ? channel.messages.fetch(message.messageId).catch(() => null) : null;
}

/**
 * Validates and stores one entry, then syncs the Discord message.
 * Returns 'ok' or a reason: role.<verdict>, emoji.<error>, emoji_required, label_required, full, duplicate, missing, sync.<reason>.
 */
export async function addOne(ctx, { guild, caller }, message, { role, emojiText, label }) {
  const verdict = checkRoleForSetup(guild, caller, role);
  if (verdict !== 'ok') return `role.${verdict}`;
  let emoji = null;
  if (emojiText) {
    const parsed = parseEmoji(emojiText, guild);
    if (parsed.error) return `emoji.${parsed.error}`;
    emoji = parsed.emoji;
  }
  const input = checkEntryInput(message.style, { emoji, label });
  if (input !== 'ok') return input;
  const result = await addEntry(ctx.db, message.messageId, { roleId: role.id, emoji, label: label ?? null });
  if (typeof result === 'string') return result;
  const fresh = await getMessage(ctx.db, message.messageId);
  const discordMessage = await fetchDiscordMessage(guild, fresh);
  if (discordMessage) {
    const synced = await syncMessage(ctx, fresh, discordMessage);
    if (!synced.ok) return `sync.${synced.reason}`;
  }
  return 'ok';
}
```

**`src/features/reactionroles/log.js`**

```js
import { sendLog as defaultSendLog } from '../logging/send-log.js';
import { t } from '../../i18n/index.js';

/** One `mod` log line for a staff action on a role message. Never throws. */
export async function logReactionRoles(ctx, guild, lang, { action, actorId, messageId, detail }, deps = {}) {
  try {
    const send = deps.sendLog ?? defaultSendLog;
    const fields = [
      { name: t(lang, 'reactionroles.log.moderator'), value: `<@${actorId}>`, inline: true },
      { name: t(lang, 'reactionroles.log.message'), value: String(messageId), inline: true },
    ];
    if (detail) fields.push({ name: '​', value: String(detail) });
    await send(ctx, guild.id, 'modAction', { title: t(lang, 'reactionroles.log.title', { action }), fields });
  } catch (err) {
    console.warn(`Could not write reaction roles log: ${err.message}`);
  }
}
```

**`src/features/reactionroles/commands.js`**

```js
import { SlashCommandBuilder, ChannelType, MessageFlags } from 'discord.js';
import { guard } from '../../core/guard.js';
import { handleToggle } from '../../core/toggle.js';
import { ephemeral } from '../../core/replies.js';
import { t } from '../../i18n/index.js';
import { canManage } from '../../core/permissions.js';
import { botCanGive } from '../../core/role-safety.js';
import { listEmbeds } from '../embeds/store.js';
import { STYLES, TYPES, typeAllowedForStyle } from './config.js';
import { createMessage, getMessage, listMessages, removeEntry } from './store.js';
import { postRoleMessage, syncMessage } from './render.js';
import { logReactionRoles } from './log.js';
import { addOne, fetchDiscordMessage } from './setup.js';
import { settingsSubcommands, settingsHandlers } from './commands-settings.js'; // Task 6
import { builderHandler } from './builder.js'; // Task 8
import { handle } from './components.js'; // Task 7

const CHANNEL_TYPES = [ChannelType.GuildText, ChannelType.GuildAnnouncement];
const choices = (list) => list.map((v) => ({ name: v, value: v }));
const messageIdOption = (o) => o.setName('message_id').setDescription('Id of the role message').setRequired(true);

export function buildData() {
  const data = new SlashCommandBuilder()
    .setName('reactionroles')
    .setDescription('Let members pick roles from an embed message')
    .addSubcommand((s) => s.setName('enable').setDescription('Turn reaction roles on'))
    .addSubcommand((s) => s.setName('disable').setDescription('Turn reaction roles off'))
    .addSubcommand((s) => s.setName('status').setDescription('Show the role messages and any problems'))
    .addSubcommand((s) =>
      s.setName('create').setDescription('Post a named embed as a role message')
        .addStringOption((o) => o.setName('embed').setDescription('Name of the embed').setAutocomplete(true).setRequired(true))
        .addStringOption((o) => o.setName('style').setDescription('How members pick').addChoices(...choices(STYLES)).setRequired(true))
        .addChannelOption((o) => o.setName('channel').setDescription('Where to post (default: here)').addChannelTypes(...CHANNEL_TYPES))
        .addStringOption((o) => o.setName('type').setDescription('Behavior (default: normal)').addChoices(...choices(TYPES))))
    .addSubcommand((s) =>
      s.setName('adopt').setDescription('Use an embed message the bot already posted')
        .addStringOption(messageIdOption)
        .addStringOption((o) => o.setName('style').setDescription('How members pick').addChoices(...choices(STYLES)).setRequired(true))
        .addChannelOption((o) => o.setName('channel').setDescription('Channel of the message (default: here)').addChannelTypes(...CHANNEL_TYPES)))
    .addSubcommand((s) =>
      s.setName('add').setDescription('Add a role to a role message')
        .addStringOption(messageIdOption)
        .addRoleOption((o) => o.setName('role').setDescription('Role to offer').setRequired(true))
        .addStringOption((o) => o.setName('emoji').setDescription('Emoji (required for reactions)'))
        .addStringOption((o) => o.setName('label').setDescription('Label for buttons and the dropdown').setMaxLength(80)))
    .addSubcommand((s) =>
      s.setName('remove').setDescription('Remove a role from a role message')
        .addStringOption(messageIdOption)
        .addRoleOption((o) => o.setName('role').setDescription('Role to remove').setRequired(true)))
    .addSubcommand((s) =>
      s.setName('show').setDescription('List the role messages, or one message in detail')
        .addStringOption((o) => o.setName('message_id').setDescription('Id of the role message')))
    .addSubcommand((s) => // Task 8
      s.setName('builder').setDescription('Add several roles with an interactive panel').addStringOption(messageIdOption));
  return settingsSubcommands(data); // Task 6
}

// Replies with the guard failure or "no such role message"; returns the stored message or null.
async function loadMessage(interaction, ctx, lang) {
  const message = await getMessage(ctx.db, interaction.options.getString('message_id'));
  if (!message || message.guildId !== interaction.guildId) {
    await interaction.reply(ephemeral(t(lang, 'reactionroles.gone')));
    return null;
  }
  return message;
}

async function create(interaction, ctx, lang) {
  const style = interaction.options.getString('style');
  const type = interaction.options.getString('type') ?? 'normal';
  if (!typeAllowedForStyle(type, style)) return interaction.reply(ephemeral(t(lang, 'reactionroles.reversedNeedsReactions')));
  const channel = interaction.options.getChannel('channel') ?? interaction.channel;
  const name = interaction.options.getString('embed');
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const posted = await postRoleMessage(ctx, interaction, lang, channel, name);
  if (posted.error) return interaction.editReply(t(lang, `reactionroles.embed.${posted.error}`));
  await createMessage(ctx.db, {
    guildId: interaction.guildId, messageId: posted.message.id, channelId: channel.id,
    embedName: name, style, type, createdBy: interaction.user.id,
  });
  await logReactionRoles(ctx, interaction.guild, lang, { action: 'create', actorId: interaction.user.id, messageId: posted.message.id });
  return interaction.editReply(t(lang, 'reactionroles.created', { id: posted.message.id }));
}

async function adopt(interaction, ctx, lang) {
  const style = interaction.options.getString('style');
  const channel = interaction.options.getChannel('channel') ?? interaction.channel;
  const id = interaction.options.getString('message_id');
  const found = await channel.messages.fetch(id).catch(() => null);
  if (!found) return interaction.reply(ephemeral(t(lang, 'reactionroles.gone')));
  if (found.author.id !== ctx.client.user.id) return interaction.reply(ephemeral(t(lang, 'reactionroles.adopt.notOurs')));
  if (!found.embeds.length) return interaction.reply(ephemeral(t(lang, 'reactionroles.adopt.noEmbed')));
  if (found.components.length) return interaction.reply(ephemeral(t(lang, 'reactionroles.adopt.hasComponents')));
  if (await getMessage(ctx.db, id)) return interaction.reply(ephemeral(t(lang, 'reactionroles.adopt.already')));
  await createMessage(ctx.db, {
    guildId: interaction.guildId, messageId: id, channelId: channel.id, embedName: null, style, createdBy: interaction.user.id,
  });
  await logReactionRoles(ctx, interaction.guild, lang, { action: 'adopt', actorId: interaction.user.id, messageId: id });
  return interaction.reply(ephemeral(t(lang, 'reactionroles.adopted', { id })));
}

async function add(interaction, ctx, lang) {
  const message = await loadMessage(interaction, ctx, lang);
  if (!message) return;
  const outcome = await addOne(ctx, { guild: interaction.guild, caller: interaction.member }, message, {
    role: interaction.options.getRole('role'),
    emojiText: interaction.options.getString('emoji'),
    label: interaction.options.getString('label'),
  });
  if (outcome === 'ok') {
    await logReactionRoles(ctx, interaction.guild, lang, {
      action: 'add', actorId: interaction.user.id, messageId: message.messageId, detail: `<@&${interaction.options.getRole('role').id}>`,
    });
  }
  return interaction.reply(ephemeral(t(lang, outcome === 'ok' ? 'reactionroles.added' : `reactionroles.add.${outcome}`)));
}

async function remove(interaction, ctx, lang) {
  const message = await loadMessage(interaction, ctx, lang);
  if (!message) return;
  const role = interaction.options.getRole('role');
  if (!(await removeEntry(ctx.db, message.messageId, role.id))) {
    return interaction.reply(ephemeral(t(lang, 'reactionroles.noSuchEntry')));
  }
  const fresh = await getMessage(ctx.db, message.messageId);
  const discordMessage = await fetchDiscordMessage(interaction.guild, fresh);
  if (discordMessage) await syncMessage(ctx, fresh, discordMessage);
  await logReactionRoles(ctx, interaction.guild, lang, {
    action: 'remove', actorId: interaction.user.id, messageId: message.messageId, detail: `<@&${role.id}>`,
  });
  return interaction.reply(ephemeral(t(lang, 'reactionroles.removed')));
}

const describe = (lang, m) =>
  t(lang, 'reactionroles.show.line', { id: m.messageId, channel: `<#${m.channelId}>`, style: m.style, type: m.type, count: m.entries.length });

async function show(interaction, ctx, lang) {
  const id = interaction.options.getString('message_id');
  if (!id) {
    const all = await listMessages(ctx.db, interaction.guildId);
    return interaction.reply(ephemeral(all.length ? all.map((m) => describe(lang, m)).join('\n') : t(lang, 'reactionroles.show.none')));
  }
  const message = await loadMessage(interaction, ctx, lang);
  if (!message) return;
  const entries = message.entries.map((e) => `${e.emoji ?? ''} ${e.label ?? ''} <@&${e.roleId}>`.trim());
  const lines = [describe(lang, message), ...entries];
  if (message.limit != null) lines.push(t(lang, 'reactionroles.show.limit', { limit: message.limit }));
  if (message.whitelist.length) lines.push(t(lang, 'reactionroles.show.whitelist', { roles: message.whitelist.map((r) => `<@&${r}>`).join(' ') }));
  if (message.blacklist.length) lines.push(t(lang, 'reactionroles.show.blacklist', { roles: message.blacklist.map((r) => `<@&${r}>`).join(' ') }));
  return interaction.reply(ephemeral(lines.join('\n')));
}

async function status(interaction, ctx, lang) {
  const all = await listMessages(ctx.db, interaction.guildId);
  const problems = [];
  for (const m of all) {
    const discordMessage = await fetchDiscordMessage(interaction.guild, m);
    if (!discordMessage) {
      problems.push(t(lang, 'reactionroles.status.deleted', { id: m.messageId }));
      continue;
    }
    if (!m.entries.length) problems.push(t(lang, 'reactionroles.status.empty', { id: m.messageId }));
    for (const e of m.entries) {
      const role = interaction.guild.roles.cache.get(e.roleId);
      if (!role || !botCanGive(interaction.guild, role)) problems.push(t(lang, 'reactionroles.status.role', { id: m.messageId, role: `<@&${e.roleId}>` }));
    }
    if (m.style === 'reactions' && m.entries.some((e) => e.emoji) && discordMessage.reactions.cache.size === 0) {
      problems.push(t(lang, 'reactionroles.status.reactions', { id: m.messageId }));
    }
  }
  const head = t(lang, 'reactionroles.status.head', { count: all.length });
  return interaction.reply(ephemeral([head, ...problems].join('\n')));
}

const HANDLERS = {
  create, adopt, add, remove, show, status,
  builder: builderHandler, // Task 8
  ...settingsHandlers, // Task 6
};

export function createReactionRolesCommand() {
  return {
    data: buildData(),
    async execute(interaction, ctx) {
      const sub = interaction.options.getSubcommand();
      if (sub === 'enable' || sub === 'disable') return handleToggle(interaction, ctx, 'reactionroles');
      const lang = await guard(interaction, ctx, 'reactionroles');
      if (!lang) return;
      return HANDLERS[sub]?.(interaction, ctx, lang);
    },
    async autocomplete(interaction, ctx) {
      if (!interaction.guildId || !(await canManage(ctx.db, interaction.member))) return interaction.respond([]);
      const typed = interaction.options.getFocused().toLowerCase();
      const names = (await listEmbeds(ctx.db, interaction.guildId)).filter((n) => n.includes(typed)).slice(0, 25);
      return interaction.respond(names.map((n) => ({ name: n, value: n })));
    },
    components: { prefix: 'reactionroles', handle }, // Task 7
  };
}
```

**`src/features/reactionroles/index.js`**

```js
import { createReactionRolesCommand } from './commands.js';
import { jobs as settingsJobs } from './commands-settings.js'; // Task 6

export const commands = [createReactionRolesCommand()];
export const jobs = { ...settingsJobs }; // Task 6
export { events } from './events.js'; // Task 7
```

**i18n keys to add to en, fr and ar:** `reactionroles.created`, `.adopted`, `.added`, `.removed`, `.gone`, `.off`, `.noSuchEntry`, `.noEmbedName`, `.notYours`, `.expired`, `.badDuration`, `.fixed`, `.selfdestructSet`, `.reversedNeedsReactions`, `.list.needRole`, `.adopt.{notOurs,noEmbed,hasComponents,already}`, `.embed.{missing,image,invalid,cannot_send}`, `.add.{role.dangerous,role.bot_cannot,role.caller_cannot,emoji.invalid,emoji.foreign,emoji_required,label_required,full,duplicate,missing,sync.cannot_edit,sync.cannot_react}`, `.refused.{locked,blacklisted,not_whitelisted,bound,limit,nothing,role_missing,cannot_give,discord_failed}`, `.picked.{added,removed}`, `.show.{none,line,limit,whitelist,blacklist}`, `.status.{head,deleted,empty,role,reactions}`, `.purge.{askOne,askAll,confirm,cancel,cancelled,done}`, `.builder.{head,empty,pickRole,add,done,remove,finished,modalTitle,emoji,label}`, `.log.{title,moderator,message}`. Placeholders used: `{id}`, `{roles}`, `{count}`, `{channel}`, `{style}`, `{type}`, `{limit}`, `{time}`, `{role}`, `{action}`. Keep modal titles and labels at most 45 characters in every language.


---

### Task 6: Settings commands and selfdestruct job

**Files:**
- Create: `src/features/reactionroles/commands-settings.js`
- Modify: `src/features/reactionroles/commands.js` (register the subcommands), `index.js` (export `jobs`), i18n files
- Test: `test/features/reactionroles-settings.test.js`

**Tier:** sonnet — multi-file, scheduler and confirm flow

**Interfaces:**
- Consumes: Tasks 1–5; `scheduleJob`, `cancelJobs` (`src/core/scheduler.js`), `parseDuration` (`src/core/duration.js`).
- Produces: subcommands `type` (`message_id`, `type`), `limit` (`message_id`, `number`, 0 = none), `whitelist` and `blacklist` (each `add|remove|clear`, `message_id`, optional `role`), `selfdestruct` (`message_id`, `duration`, `0` or `off` cancels), `refresh` (`message_id`), `fix` (optional `message_id`), `purge` (optional `message_id`; shows a Confirm/Cancel ephemeral with customIds `reactionroles:purge:ok:<userId>:<messageId|all>` and `reactionroles:purge:no:<userId>`, handled in Task 7's router through the exported `handlePurge(interaction, ctx)`). Exports `destructJob(ctx, job)` (deletes the Discord message if it exists, then `deleteMessage`; a missing message counts as success) and `jobs = { [SELFDESTRUCT_JOB]: destructJob }`.
- [ ] **Step 1: Write failing tests:** `type` to `reversed` on a buttons message refused; `type` change leaves existing roles untouched (no role calls); `limit 0` stores null; whitelist add/remove/clear persists; `selfdestruct 1h` schedules `reactionroles.destruct` with key = message id and `selfdestruct 0` cancels it and nulls `selfdestructAt`; `destructJob` deletes the message and rows, and treats an already-deleted Discord message as success; `refresh` on an adopted message (no embed name) replies `reactionroles.noEmbedName`; `purge` without confirm changes nothing and `handlePurge` with the original user deletes entries (message rows stay for `purge message_id`, all rows for `all`); another user pressing Confirm is refused.
- [ ] **Step 2:** run → FAIL.
- [ ] **Step 3: Implement.** Each mutation logs through `logReactionRoles`. `purge` of the whole server cancels every `reactionroles.destruct` job of the guild (`cancelJobs` without key).
- [ ] **Step 4:** run new tests and the i18n test → PASS.
- [ ] **Step 5: Commit** `feat(reactionroles): type, limit, lists, selfdestruct, refresh, fix, purge`.

#### Reference code

**`src/features/reactionroles/commands-settings.js`**

```js
import { ActionRowBuilder, ButtonBuilder, ButtonStyle, MessageFlags } from 'discord.js';
import { ephemeral } from '../../core/replies.js';
import { getLang, t } from '../../i18n/index.js';
import { scheduleJob, cancelJobs } from '../../core/scheduler.js';
import { parseDuration, formatDuration } from '../../core/duration.js';
import { canManage } from '../../core/permissions.js';
import { TYPES, SELFDESTRUCT_JOB, typeAllowedForStyle } from './config.js';
import { getMessage, listMessages, updateMessage, deleteMessage, deleteGuildMessages } from './store.js';
import { syncMessage, refreshEmbed } from './render.js';
import { fetchDiscordMessage } from './setup.js';
import { logReactionRoles } from './log.js';

// Replies "no such role message" and returns null when the id is unknown or from another server.
async function loadMessage(interaction, ctx, lang) {
  const message = await getMessage(ctx.db, interaction.options.getString('message_id'));
  if (!message || message.guildId !== interaction.guildId) {
    await interaction.reply(ephemeral(t(lang, 'reactionroles.gone')));
    return null;
  }
  return message;
}

const logged = (interaction, ctx, lang, message, action, detail) =>
  logReactionRoles(ctx, interaction.guild, lang, { action, actorId: interaction.user.id, messageId: message.messageId, detail });

async function type(interaction, ctx, lang) {
  const message = await loadMessage(interaction, ctx, lang);
  if (!message) return;
  const next = interaction.options.getString('type');
  if (!typeAllowedForStyle(next, message.style)) return interaction.reply(ephemeral(t(lang, 'reactionroles.reversedNeedsReactions')));
  // Existing role holders keep their roles: only later picks follow the new type.
  await updateMessage(ctx.db, message.messageId, { type: next });
  const fresh = await getMessage(ctx.db, message.messageId);
  const discordMessage = await fetchDiscordMessage(interaction.guild, fresh);
  if (discordMessage) await syncMessage(ctx, fresh, discordMessage); // a menu's max selection depends on the type
  await logged(interaction, ctx, lang, message, 'type', next);
  return interaction.reply(ephemeral(t(lang, 'common.saved')));
}

async function limit(interaction, ctx, lang) {
  const message = await loadMessage(interaction, ctx, lang);
  if (!message) return;
  const n = interaction.options.getInteger('number');
  await updateMessage(ctx.db, message.messageId, { limit: n > 0 ? n : null });
  await logged(interaction, ctx, lang, message, 'limit', String(n));
  return interaction.reply(ephemeral(t(lang, 'common.saved')));
}

// whitelist / blacklist share one handler: the option group decides which list.
function listHandler(listName) {
  return async (interaction, ctx, lang) => {
    const message = await loadMessage(interaction, ctx, lang);
    if (!message) return;
    const mode = interaction.options.getString('mode');
    const role = interaction.options.getRole('role');
    let list = [...message[listName]];
    if (mode === 'clear') list = [];
    else if (!role) return interaction.reply(ephemeral(t(lang, 'reactionroles.list.needRole')));
    else if (mode === 'add') list = [...new Set([...list, role.id])];
    else list = list.filter((id) => id !== role.id);
    await updateMessage(ctx.db, message.messageId, { [listName]: list });
    await logged(interaction, ctx, lang, message, listName, mode);
    return interaction.reply(ephemeral(t(lang, 'common.saved')));
  };
}

async function selfdestruct(interaction, ctx, lang) {
  const message = await loadMessage(interaction, ctx, lang);
  if (!message) return;
  const text = interaction.options.getString('duration').trim().toLowerCase();
  if (text === '0' || text === 'off') {
    await cancelJobs(ctx.db, { guildId: interaction.guildId, type: SELFDESTRUCT_JOB, key: message.messageId });
    await updateMessage(ctx.db, message.messageId, { selfdestructAt: null });
    await logged(interaction, ctx, lang, message, 'selfdestruct', 'off');
    return interaction.reply(ephemeral(t(lang, 'common.saved')));
  }
  const seconds = parseDuration(text);
  if (!seconds) return interaction.reply(ephemeral(t(lang, 'reactionroles.badDuration')));
  const dueAt = Date.now() + seconds * 1000;
  await scheduleJob(ctx.db, { guildId: interaction.guildId, type: SELFDESTRUCT_JOB, key: message.messageId, payload: {}, dueAt });
  await updateMessage(ctx.db, message.messageId, { selfdestructAt: new Date(dueAt) });
  await logged(interaction, ctx, lang, message, 'selfdestruct', formatDuration(seconds));
  return interaction.reply(ephemeral(t(lang, 'reactionroles.selfdestructSet', { time: formatDuration(seconds) })));
}

async function refresh(interaction, ctx, lang) {
  const message = await loadMessage(interaction, ctx, lang);
  if (!message) return;
  if (!message.embedName) return interaction.reply(ephemeral(t(lang, 'reactionroles.noEmbedName')));
  const discordMessage = await fetchDiscordMessage(interaction.guild, message);
  if (!discordMessage) return interaction.reply(ephemeral(t(lang, 'reactionroles.gone')));
  const result = await refreshEmbed(ctx, interaction, lang, message, discordMessage);
  if (result.error) return interaction.reply(ephemeral(t(lang, `reactionroles.embed.${result.error}`)));
  await logged(interaction, ctx, lang, message, 'refresh');
  return interaction.reply(ephemeral(t(lang, 'common.saved')));
}

async function fix(interaction, ctx, lang) {
  const id = interaction.options.getString('message_id');
  const messages = id ? [await loadMessage(interaction, ctx, lang)] : null;
  if (id && !messages[0]) return;
  const targets = messages ?? (await listMessages(ctx.db, interaction.guildId));
  let fixed = 0;
  for (const m of targets) {
    const discordMessage = await fetchDiscordMessage(interaction.guild, m);
    if (discordMessage && (await syncMessage(ctx, m, discordMessage)).ok) fixed += 1;
  }
  return interaction.reply(ephemeral(t(lang, 'reactionroles.fixed', { count: fixed })));
}

async function purge(interaction, ctx, lang) {
  const id = interaction.options.getString('message_id');
  if (id && !(await loadMessage(interaction, ctx, lang))) return;
  const ok = new ButtonBuilder().setCustomId(`reactionroles:purge:ok:${interaction.user.id}:${id ?? 'all'}`)
    .setLabel(t(lang, 'reactionroles.purge.confirm')).setStyle(ButtonStyle.Danger);
  const no = new ButtonBuilder().setCustomId(`reactionroles:purge:no:${interaction.user.id}`)
    .setLabel(t(lang, 'reactionroles.purge.cancel')).setStyle(ButtonStyle.Secondary);
  return interaction.reply(ephemeral({
    content: t(lang, id ? 'reactionroles.purge.askOne' : 'reactionroles.purge.askAll'),
    components: [new ActionRowBuilder().addComponents(ok, no)],
  }));
}

/** Confirm / Cancel buttons of `purge`. Only the staff member who ran the command may press them. */
export async function handlePurge(interaction, ctx) {
  const [, , answer, userId, target] = interaction.customId.split(':');
  const lang = await getLang(ctx.db, interaction.guildId);
  if (interaction.user.id !== userId || !(await canManage(ctx.db, interaction.member))) {
    return interaction.reply({ content: t(lang, 'reactionroles.notYours'), flags: MessageFlags.Ephemeral });
  }
  if (answer !== 'ok') return interaction.update({ content: t(lang, 'reactionroles.purge.cancelled'), components: [] });
  const ids = target === 'all' ? await deleteGuildMessages(ctx.db, interaction.guildId) : [target];
  if (target !== 'all') await deleteMessage(ctx.db, target);
  for (const id of ids) {
    await cancelJobs(ctx.db, { guildId: interaction.guildId, type: SELFDESTRUCT_JOB, key: id });
  }
  await logReactionRoles(ctx, interaction.guild, lang, { action: 'purge', actorId: interaction.user.id, messageId: target });
  return interaction.update({ content: t(lang, 'reactionroles.purge.done', { count: ids.length }), components: [] });
}

/** Deletes the Discord message (already gone counts as done) and its stored rows. */
export async function destructJob(ctx, job) {
  const message = await getMessage(ctx.db, job.key);
  if (message) {
    const channel = await ctx.client.channels.fetch(message.channelId).catch(() => null);
    const discordMessage = channel && (await channel.messages.fetch(message.messageId).catch(() => null));
    if (discordMessage) await discordMessage.delete();
  }
  await deleteMessage(ctx.db, job.key);
}

export const jobs = { [SELFDESTRUCT_JOB]: destructJob };

const messageId = (o) => o.setName('message_id').setDescription('Id of the role message').setRequired(true);
const listGroup = (name) => (s) =>
  s.setName(name).setDescription(`Roles for the ${name}`)
    .addStringOption(messageId)
    .addStringOption((o) => o.setName('mode').setDescription('What to do').setRequired(true)
      .addChoices({ name: 'add', value: 'add' }, { name: 'remove', value: 'remove' }, { name: 'clear', value: 'clear' }))
    .addRoleOption((o) => o.setName('role').setDescription('The role'));

/** Adds the settings subcommands to the /reactionroles builder. */
export function settingsSubcommands(builder) {
  return builder
    .addSubcommand((s) => s.setName('type').setDescription('Change how a role message behaves')
      .addStringOption(messageId)
      .addStringOption((o) => o.setName('type').setDescription('New type').setRequired(true)
        .addChoices(...TYPES.map((v) => ({ name: v, value: v })))))
    .addSubcommand((s) => s.setName('limit').setDescription('Most roles a member may hold from a message (0 = no limit)')
      .addStringOption(messageId)
      .addIntegerOption((o) => o.setName('number').setDescription('The limit').setMinValue(0).setMaxValue(20).setRequired(true)))
    .addSubcommand(listGroup('whitelist'))
    .addSubcommand(listGroup('blacklist'))
    .addSubcommand((s) => s.setName('selfdestruct').setDescription('Delete the message after a delay (off to cancel)')
      .addStringOption(messageId)
      .addStringOption((o) => o.setName('duration').setDescription('For example 1h, or off').setRequired(true)))
    .addSubcommand((s) => s.setName('refresh').setDescription('Re-render the message from its named embed')
      .addStringOption(messageId))
    .addSubcommand((s) => s.setName('fix').setDescription('Re-add missing reactions, buttons or dropdown')
      .addStringOption((o) => o.setName('message_id').setDescription('Id of the role message (default: all)')))
    .addSubcommand((s) => s.setName('purge').setDescription('Remove one role message, or all of them')
      .addStringOption((o) => o.setName('message_id').setDescription('Id of the role message (default: all)')));
}

export const settingsHandlers = {
  type, limit, whitelist: listHandler('whitelist'), blacklist: listHandler('blacklist'), selfdestruct, refresh, fix, purge,
};
```

In `commands.js` remove the `// Task 6` tags (the `settingsSubcommands(data)` call and `...settingsHandlers`), and in `index.js` the `jobs` export. `whitelist` and `blacklist` are subcommands with a `mode` option (`add`, `remove`, `clear`).


---

### Task 7: Picks and cleanup events

**Files:**
- Create: `src/features/reactionroles/components.js`, `events.js`
- Modify: `src/features/reactionroles/index.js`, `commands.js` (use the real `handle`)
- Test: `test/features/reactionroles-picks.test.js`

**Tier:** sonnet — multiple Discord event shapes

**Interfaces:**
- Consumes: Tasks 1–6.
- Produces:
  - `components.js`: `handle(interaction, ctx)` routing on `customId.split(':')[1]`: `btn` (toggle pick), `menu` (`decideMenu` via `applyPick({kind:'menu'})`), `purge` (Task 6's `handlePurge`), `b` (Task 8's builder handler, imported lazily). Button and menu replies are ephemeral: what was added/removed, or the refusal text `reactionroles.refused.<reason>`. Disabled feature → ephemeral `reactionroles.off`. Unknown message → `reactionroles.gone`.
  - `events.js`: `createEvents(deps = {})` returning `{ name, execute }` entries for `MessageReactionAdd`, `MessageReactionRemove`, `MessageDelete`, `MessageBulkDelete`, `GuildRoleDelete`, `ChannelDelete`, `GuildMemberRemove` (`MessageReactionRemoveAll` needs no handler: it changes nothing stored, and `status` and `fix` already detect and repair a wiped message); `export const events = createEvents()`. Reaction handlers: fetch partial reaction/message, ignore bots and the bot's own reactions, look the message up in the store, ignore it when the feature is off, find the entry by `emojiKey`, `applyPick({kind:'entry', entry, action})` (`action` is `'add'` for reaction add, `'remove'` for reaction remove), then remove the member's reaction when `result.clearReaction` or the pick was refused, and remove the reactions of entries whose roles were removed (unique). `GuildRoleDelete` calls `deleteEntriesForRole` and `syncMessage` on each affected message; `GuildMemberRemove` calls `clearMemberBindings`; A reaction on a role message that matches no entry is removed by the bot.
- [ ] **Step 1: Write failing tests** using the injectable `deps` (store/apply fakes where needed, real DB elsewhere): reaction add grants through `applyPick` and removes the reaction for `verify`; a refused pick removes the reaction; a bot's reaction and the bot's own reaction are ignored; a reaction on an unknown message and a reaction while the feature is off do nothing and keep the reaction; a partial user or member that fails to fetch does not throw; button click replies ephemerally with the added role name; menu with an empty selection on a `verify` message removes nothing; `RoleDelete` removes the entry and re-syncs; `MessageDelete` removes the stored message; `GuildMemberRemove` clears bindings; clicking a button of a disabled feature replies `reactionroles.off`.
- [ ] **Step 2:** run → FAIL.
- [ ] **Step 3: Implement**, wrapping each handler in `safe(name, fn)` from `src/features/logging/send-log.js` (as `verification/events.js` does).
- [ ] **Step 4:** run new tests plus `test/features/reactionroles-*.test.js` → PASS.
- [ ] **Step 5: Commit** `feat(reactionroles): reaction, button and menu picks and cleanup events`.

#### Reference code

**`src/features/reactionroles/events.js`**

```js
import { Events } from 'discord.js';
import { getFeature } from '../../db/settings.js';
import { safe } from '../logging/send-log.js';
import { emojiKey } from './config.js';
import {
  getMessage, deleteMessage, deleteEntriesForRole, deleteMessagesInChannel, clearMemberBindings,
} from './store.js';
import { applyPick } from './apply.js';
import { syncMessage } from './render.js';

async function isOn(ctx, guildId) {
  return (await getFeature(ctx.db, guildId, 'reactionroles')).enabled;
}

// Partial reactions, messages and users must be fetched before use; false means "ignore this event".
async function hydrate(reaction, user) {
  try {
    if (reaction.partial) await reaction.fetch();
    if (reaction.message.partial) await reaction.message.fetch();
    if (user.partial) await user.fetch();
    return true;
  } catch {
    return false;
  }
}

/** Builds the event list; tests pass fakes for `apply`. */
export function createEvents(deps = {}) {
  const apply = deps.applyPick ?? applyPick;

  const onReaction = (action) => async (ctx, reaction, user) => {
    if (user.bot || user.id === ctx.client.user?.id) return;
    if (!(await hydrate(reaction, user))) return;
    const guild = reaction.message.guild;
    if (!guild) return;
    const message = await getMessage(ctx.db, reaction.message.id);
    if (!message || message.style !== 'reactions' || !(await isOn(ctx, guild.id))) return;
    const key = reaction.emoji.id ?? reaction.emoji.name;
    const entry = message.entries.find((e) => e.emoji && emojiKey(e.emoji) === key);
    if (!entry) {
      // Not one of ours: a stray reaction on a role message is cleaned up.
      if (action === 'add') await reaction.users.remove(user.id).catch(() => {});
      return;
    }
    const member = await guild.members.fetch(user.id).catch(() => null);
    if (!member) return;
    const result = await apply(ctx, member, message, { kind: 'entry', entry, action });
    if (result.clearReaction) await reaction.users.remove(user.id).catch(() => {});
    // A unique pick drops the member's other reactions on this message.
    for (const roleId of result.removed ?? []) {
      const old = message.entries.find((e) => e.roleId === roleId && e.emoji);
      const oldReaction = old && reaction.message.reactions.cache.get(emojiKey(old.emoji));
      if (oldReaction && old !== entry) await oldReaction.users.remove(user.id).catch(() => {});
    }
  };

  const onMessageDelete = async (ctx, message) => {
    await deleteMessage(ctx.db, message.id);
  };

  const onBulkDelete = async (ctx, messages) => {
    for (const id of messages.keys()) await deleteMessage(ctx.db, id);
  };

  const onRoleDelete = async (ctx, role) => {
    const affected = await deleteEntriesForRole(ctx.db, role.guild.id, role.id);
    for (const messageId of affected) {
      const message = await getMessage(ctx.db, messageId);
      const channel = message && (await role.guild.channels.fetch(message.channelId).catch(() => null));
      const discordMessage = channel && (await channel.messages.fetch(messageId).catch(() => null));
      if (discordMessage) await syncMessage(ctx, message, discordMessage);
    }
  };

  const onChannelDelete = async (ctx, channel) => {
    if (channel.guild) await deleteMessagesInChannel(ctx.db, channel.guild.id, channel.id);
  };

  const onMemberRemove = async (ctx, member) => {
    if (member.guild) await clearMemberBindings(ctx.db, member.guild.id, member.id);
  };

  return [
    { name: Events.MessageReactionAdd, execute: safe('rrReactionAdd', onReaction('add')) },
    { name: Events.MessageReactionRemove, execute: safe('rrReactionRemove', onReaction('remove')) },
    { name: Events.MessageDelete, execute: safe('rrMessageDelete', onMessageDelete) },
    { name: Events.MessageBulkDelete, execute: safe('rrBulkDelete', onBulkDelete) },
    { name: Events.GuildRoleDelete, execute: safe('rrRoleDelete', onRoleDelete) },
    { name: Events.ChannelDelete, execute: safe('rrChannelDelete', onChannelDelete) },
    { name: Events.GuildMemberRemove, execute: safe('rrMemberRemove', onMemberRemove) },
  ];
}

export const events = createEvents();
```

**`src/features/reactionroles/components.js (leave out the lines tagged `// Task 8` until that task)`**

```js
import { getFeature } from '../../db/settings.js';
import { getLang, t } from '../../i18n/index.js';
import { ephemeral } from '../../core/replies.js';
import { getMessage } from './store.js';
import { applyPick } from './apply.js';
import { PREFIX } from './render.js';
import { handlePurge } from './commands-settings.js';
import { handleBuilder } from './builder.js'; // Task 8

const roleName = (guild, id) => guild.roles.cache.get(id)?.name ?? id;

// What a member is told after a button or dropdown pick.
function summary(lang, guild, result) {
  if (!result.ok) return t(lang, `reactionroles.refused.${result.reason}`);
  const names = (ids) => ids.map((id) => roleName(guild, id)).join(', ');
  const lines = [];
  if (result.added.length) lines.push(t(lang, 'reactionroles.picked.added', { roles: names(result.added) }));
  if (result.removed.length) lines.push(t(lang, 'reactionroles.picked.removed', { roles: names(result.removed) }));
  return lines.join('\n');
}

async function pick(interaction, ctx, lang, messageId, build) {
  const message = await getMessage(ctx.db, messageId);
  if (!message) return interaction.reply(ephemeral(t(lang, 'reactionroles.gone')));
  const feature = await getFeature(ctx.db, interaction.guildId, 'reactionroles');
  if (!feature.enabled) return interaction.reply(ephemeral(t(lang, 'reactionroles.off')));
  const member = interaction.member?.roles?.cache ? interaction.member : await interaction.guild.members.fetch(interaction.user.id).catch(() => null);
  if (!member) return interaction.reply(ephemeral(t(lang, 'common.error')));
  const picked = build(message);
  if (!picked) return interaction.reply(ephemeral(t(lang, 'reactionroles.gone')));
  const result = await applyPick(ctx, member, message, picked);
  return interaction.reply(ephemeral(summary(lang, interaction.guild, result)));
}

/** Routes every `reactionroles:*` component: picks, the purge confirm and the builder panel. */
export async function handle(interaction, ctx) {
  if (!interaction.guildId) return;
  const [prefix, kind, ...rest] = interaction.customId.split(':');
  if (prefix !== PREFIX) return;
  const lang = await getLang(ctx.db, interaction.guildId);
  if (kind === 'btn') {
    const [messageId, entryId] = rest;
    return pick(interaction, ctx, lang, messageId, (message) => {
      const entry = message.entries.find((e) => String(e.id) === entryId);
      return entry ? { kind: 'entry', entry, action: 'toggle' } : null;
    });
  }
  if (kind === 'menu') {
    return pick(interaction, ctx, lang, rest[0], () => ({ kind: 'menu', roleIds: interaction.values }));
  }
  if (kind === 'purge') return handlePurge(interaction, ctx);
  if (kind === 'b') return handleBuilder(interaction, ctx); // Task 8
}
```

In `commands.js` remove the `// Task 7` tag (`components`), and in `index.js` the `events` export.


---

### Task 8: Interactive builder panel

**Files:**
- Create: `src/features/reactionroles/builder.js`
- Modify: `commands.js` (add `builder` subcommand), `components.js` (route `b`), i18n files
- Test: `test/features/reactionroles-builder.test.js`

**Tier:** sonnet — panel state across interactions

**Interfaces:**
- Consumes: `addEntry`, `removeEntry`, `getMessage`, `checkRoleForSetup`, `parseEmoji`, `checkEntryInput`, `syncMessage`, `logReactionRoles`.
- Produces: `builderPayload(lang, message, guild, { userId, startedAt, roleId? }): { content, components }` — shows current entries, a `RoleSelectMenuBuilder` (customId `reactionroles:b:role:<userId>:<messageId>`), buttons `Add` (`reactionroles:b:add:...`, opens a modal with an emoji field and a label field, modal customId `reactionroles:b:modal:<userId>:<messageId>:<roleId>`), `Remove` (a StringSelect of entries, `...:b:rm:...`), and `Done`. `handleBuilder(interaction, ctx)` rebuilds the panel from the DB on every interaction; the picked role is carried in the customId only, and ids stay under Discord's 100 characters because `startedAt` is base-36 seconds. Only the opener may use it (others get ephemeral `reactionroles.notYours`); a panel older than 10 minutes (base-36 seconds timestamp in the customId) replies `reactionroles.expired`. Every Add runs the same checks as `/reactionroles add`.
- [ ] **Step 1: Write failing tests:** `builderPayload` lists existing entries and has the four controls; role select then Add opens a modal with `<=45` char titles and labels in every language; modal submit adds the entry and re-renders the panel; a dangerous role is refused with the setup message; a second user pressing a control is refused; an expired panel is refused; Remove deletes the entry and syncs.
- [ ] **Step 2:** run → FAIL.
- [ ] **Step 3: Implement** following `src/features/embeds/panel.js` (modal builders, `showModal`, rebuild from store).
- [ ] **Step 4:** run new tests and i18n test → PASS.
- [ ] **Step 5: Commit** `feat(reactionroles): interactive builder panel`.

#### Reference code

**`src/features/reactionroles/builder.js`**

```js
import {
  ActionRowBuilder, ButtonBuilder, ButtonStyle, ModalBuilder, RoleSelectMenuBuilder, StringSelectMenuBuilder,
  TextInputBuilder, TextInputStyle, MessageFlags,
} from 'discord.js';
import { getLang, t } from '../../i18n/index.js';
import { ephemeral } from '../../core/replies.js';
import { getMessage, removeEntry } from './store.js';
import { syncMessage } from './render.js';
import { addOne, fetchDiscordMessage } from './setup.js';
import { logReactionRoles } from './log.js';

const TTL_MS = 10 * 60 * 1000;
// customId: reactionroles:b:<action>:<userId>:<messageId>:<startedAt>[:<roleId>]; startedAt is base-36 seconds so the id stays under Discord's 100 characters
const id = (action, userId, messageId, startedAt, extra) =>
  ['reactionroles', 'b', action, userId, messageId, startedAt, extra].filter((p) => p !== undefined).join(':');

/** The panel: current entries, a role picker, Add, Remove and Done. Rebuilt from the database each time. */
export function builderPayload(lang, message, guild, { userId, startedAt, roleId = null }) {
  const lines = message.entries.map((e) => `${e.emoji ?? ''} ${e.label ?? ''} <@&${e.roleId}>`.trim());
  const content = [t(lang, 'reactionroles.builder.head', { id: message.messageId }), ...(lines.length ? lines : [t(lang, 'reactionroles.builder.empty')])].join('\n');
  const picker = new RoleSelectMenuBuilder().setCustomId(id('role', userId, message.messageId, startedAt))
    .setPlaceholder(t(lang, 'reactionroles.builder.pickRole')).setMinValues(1).setMaxValues(1);
  const add = new ButtonBuilder().setCustomId(id('add', userId, message.messageId, startedAt, roleId ?? undefined))
    .setLabel(t(lang, 'reactionroles.builder.add')).setStyle(ButtonStyle.Primary).setDisabled(!roleId);
  const done = new ButtonBuilder().setCustomId(id('done', userId, message.messageId, startedAt))
    .setLabel(t(lang, 'reactionroles.builder.done')).setStyle(ButtonStyle.Secondary);
  const rows = [new ActionRowBuilder().addComponents(picker), new ActionRowBuilder().addComponents(add, done)];
  if (message.entries.length) {
    const remove = new StringSelectMenuBuilder().setCustomId(id('rm', userId, message.messageId, startedAt))
      .setPlaceholder(t(lang, 'reactionroles.builder.remove'))
      .addOptions(message.entries.map((e) => ({
        label: (e.label || guild.roles.cache.get(e.roleId)?.name || e.roleId).slice(0, 100), value: e.roleId,
      })));
    rows.splice(1, 0, new ActionRowBuilder().addComponents(remove));
  }
  return { content, components: rows };
}

export async function builderHandler(interaction, ctx, lang) {
  const message = await getMessage(ctx.db, interaction.options.getString('message_id'));
  if (!message || message.guildId !== interaction.guildId) return interaction.reply(ephemeral(t(lang, 'reactionroles.gone')));
  return interaction.reply(ephemeral(builderPayload(lang, message, interaction.guild, { userId: interaction.user.id, startedAt: Math.floor(Date.now() / 1000).toString(36) })));
}

function modal(lang, customId) {
  return new ModalBuilder().setCustomId(customId).setTitle(t(lang, 'reactionroles.builder.modalTitle'))
    .addComponents(
      new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('emoji').setLabel(t(lang, 'reactionroles.builder.emoji'))
        .setStyle(TextInputStyle.Short).setRequired(false).setMaxLength(64)),
      new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('label').setLabel(t(lang, 'reactionroles.builder.label'))
        .setStyle(TextInputStyle.Short).setRequired(false).setMaxLength(80)),
    );
}

/** Every component and modal of the panel (`reactionroles:b:*`). Only the opener may use it, for ten minutes. */
export async function handleBuilder(interaction, ctx) {
  const [, , action, userId, messageId, startedAt, roleId] = interaction.customId.split(':');
  const lang = await getLang(ctx.db, interaction.guildId);
  const refuse = (key) => interaction.reply({ content: t(lang, key), flags: MessageFlags.Ephemeral });
  if (interaction.user.id !== userId) return refuse('reactionroles.notYours');
  if (Date.now() - parseInt(startedAt, 36) * 1000 > TTL_MS) return refuse('reactionroles.expired');
  const message = await getMessage(ctx.db, messageId);
  if (!message) return refuse('reactionroles.gone');
  const state = { userId, startedAt };
  const guild = interaction.guild;

  if (action === 'role') {
    return interaction.update(builderPayload(lang, message, guild, { ...state, roleId: interaction.values[0] }));
  }
  if (action === 'add') return interaction.showModal(modal(lang, id('modal', userId, messageId, startedAt, roleId)));
  if (action === 'done') return interaction.update({ content: t(lang, 'reactionroles.builder.finished'), components: [] });
  if (action === 'rm') {
    await removeEntry(ctx.db, messageId, interaction.values[0]);
    const fresh = await getMessage(ctx.db, messageId);
    const discordMessage = await fetchDiscordMessage(guild, fresh);
    if (discordMessage) await syncMessage(ctx, fresh, discordMessage);
    await logReactionRoles(ctx, guild, lang, { action: 'remove', actorId: userId, messageId, detail: `<@&${interaction.values[0]}>` });
    return interaction.update(builderPayload(lang, fresh, guild, state));
  }
  if (action === 'modal') {
    const role = guild.roles.cache.get(roleId);
    if (!role) return refuse('reactionroles.refused.role_missing');
    const outcome = await addOne(ctx, { guild, caller: interaction.member }, message, {
      role,
      emojiText: interaction.fields.getTextInputValue('emoji').trim() || null,
      label: interaction.fields.getTextInputValue('label').trim() || null,
    });
    const fresh = await getMessage(ctx.db, messageId);
    if (outcome === 'ok') {
      await logReactionRoles(ctx, guild, lang, { action: 'add', actorId: userId, messageId, detail: `<@&${role.id}>` });
      return interaction.update(builderPayload(lang, fresh, guild, state));
    }
    return interaction.reply(ephemeral(t(lang, `reactionroles.add.${outcome}`)));
  }
}
```

Then add the lines tagged `// Task 8` in `commands.js` (the `builder` subcommand and `builderHandler`) and `components.js` (the `b` route).


---

### Task 9: Wiring, docs and intent

**Files:**
- Modify: `src/modules.js`, `src/index.js`, `src/core/registry.js:29`, `README.md`, `docs/testing-checklist.md`, `docs/memory/{roadmap,features-built,architecture,decisions,gotchas}.md`, `test/features/help.test.js` (only if it lists features)
- Test: `test/features/reactionroles-wiring.test.js`

**Tier:** sonnet — cross-cutting edits across several files

**Interfaces:**
- Produces: registry entry `f('reactionroles', 3, 'reactionroles', { enableCommand: 'reactionroles enable' })`; `import * as reactionroles from './features/reactionroles/index.js'` appended to `modules`; intent `GatewayIntentBits.GuildMessageReactions` and `Partials.Reaction` in `src/index.js`.
- [ ] **Step 1: Write failing test** `reactionroles-wiring.test.js`: `collectModules(modules)` loads without a duplicate command, component prefix or job type; the registry entry for `reactionroles` has `command: 'reactionroles'`; `/help` lists the reaction roles command (follow how `help.test.js` checks another feature).
- [ ] **Step 2:** run → FAIL.
- [ ] **Step 3: Make the edits.** README: add the invite permissions (Manage Roles, Add Reactions, Read Message History, Manage Messages) and the `/reactionroles` summary. `docs/testing-checklist.md`: new section 15 (create, adopt, add, builder, each type with each style, limit, whitelist/blacklist, selfdestruct, purge, bot offline note, role deleted). Memory notes: move reaction roles from "Planned" to "built, manual testing pending" in `roadmap.md` and add behaviour, architecture, decisions and gotchas entries only for what the code now does.
- [ ] **Step 4:** run `npm test` → all PASS.
- [ ] **Step 5: Commit** `feat(reactionroles): register the feature, intent and docs`.

#### Reference code

```js
// src/core/registry.js, replacing the stub on line 29
f('autoresponder', 3, null), f('reactionroles', 3, 'reactionroles', { enableCommand: 'reactionroles enable' }), f('quote', 3, null),

// src/modules.js
import * as reactionroles from './features/reactionroles/index.js';
export const modules = [panel, help, language, media, embeds, post, greet, autorole, logging, info, moderation, automod, verification, antiraid, reactionroles];

// src/index.js: add to the intents array and the partials
GatewayIntentBits.GuildMessageReactions,
partials: [Partials.Message, Partials.Channel, Partials.GuildMember, Partials.User, Partials.Reaction],
```

```js
// test/features/reactionroles-wiring.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { modules } from '../../src/modules.js';
import { collectModules } from '../../src/core/loader.js';
import { FEATURES } from '../../src/core/registry.js';

test('the modules load without a duplicate command, component prefix or job type', () => {
  const registry = collectModules(modules);
  assert.ok(registry.commands.has('reactionroles'));
  assert.ok(registry.components.has('reactionroles'));
  assert.ok(registry.jobs.has('reactionroles.destruct'));
});

test('the registry lists reaction roles with its command', () => {
  const feature = FEATURES.find((f) => f.key === 'reactionroles');
  assert.equal(feature.command, 'reactionroles');
});
```


---

### Task 10: Final verification

**Files:** none changed except the graph output.

**Tier:** haiku — run commands and report

**Interfaces:** none.

- [ ] **Step 1:** `npm test` — expected: every test passes; report the count and any failure verbatim.
- [ ] **Step 2:** `npm run deploy` is not run (needs the live token); instead run `node -e "import('./src/modules.js').then(m=>console.log(m.modules.length))"` — expected: `15`.
- [ ] **Step 3:** `graphify update .` — expected: finishes without error.
- [ ] **Step 4:** `git status --short` — report; commit nothing here.

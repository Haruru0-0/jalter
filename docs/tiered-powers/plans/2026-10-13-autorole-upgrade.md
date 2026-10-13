# Auto Role Upgrade Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use tiered-powers:subagent-driven-development (recommended) or tiered-powers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bring Jalter's `/autorole` up to Carl-bot's: several roles, a `show` command, timed (delayed) roles, sticky roles that come back when a member rejoins, and a blacklist for sticky roles. Also fix the two weak points found in the comparison: `setup` overwrote the other role, and a failed role add was invisible.

**Architecture:** Same as the rest of the bot (feature module exporting `{ commands, events }`, settings in `guild_settings`, everything async). The list of roles stays in `guild_settings` (feature `autorole`, config JSON). Two new tables hold what must survive a restart: roles waiting for their delay (`pending_roles`) and roles remembered for members who left (`remembered_roles`). A 30-second ticker, started when the bot is ready, hands out due roles and purges old rows.

**Tech Stack:** unchanged (Node.js, discord.js 14.27.0, PostgreSQL in Docker, `node:test`).

**Spec:** the "Design" section below. It is the user's request ("compare with Carl-bot's autoroles and timedroles, then do what is missing", docs at https://docs.carl.gg/#/roles?id=autoroles) plus my calls, marked as such. There is no separate spec file.

## Design

What Carl-bot has that we lacked, and what we do about it:

| Gap | Decision |
|---|---|
| One human role and one bot role only | Any number of roles, up to 10 in each of two lists: `roles` (given to humans) and `bot_roles` (given to bots). **My call:** 10 per list. |
| No way to see the setup | `/autorole show` lists both lists, timed roles, the sticky switch and the blacklist. |
| `setup` replaced the other role | Gone. `/autorole add` and `/autorole remove` change one role at a time. |
| No delayed roles | `/autorole timed add delay: role:` gives a role to humans after the delay; `timed remove` also cancels waiting ones. Delay from 1 minute to 30 days, written like `30m`, `2h`, `1d`, `1d12h`. **My call:** timed roles are for humans only. |
| No sticky roles | `/autorole reassign state:on\|off` (off by default). When on, a member who leaves has their roles remembered for 30 days and gets them back on rejoin, together with the auto roles (union). Roles above the bot's highest role, managed (bot or integration) roles, `@everyone` and blacklisted roles are never remembered or re-given. |
| No sticky blacklist | `/autorole blacklist add\|remove role:`, up to 25 roles. **My call:** 25. |
| A failed add is silent | `/autorole show` marks roles the bot cannot give (above its highest role, or deleted) and `add` keeps the existing warning. Failures are still logged with `console.warn` (no channel message: the member who joined cannot be told, and the log channel belongs to the `logging` feature). |

The old config keys `humanRoleId` and `botRoleId` are still read: one function folds them into the new lists, so servers set up before this change keep working with no data migration.

Command tree (all use `guard(interaction, ctx, 'autorole', { requireEnabled: false })`, replies ephemeral): `add role: [target: humans|bots]` (default humans), `remove role: [target]` (default: both lists), `show`, `reassign state:`, `blacklist add|remove role:`, `timed add delay: role:`, `timed remove role:`, `disable`. The first `add` or `timed add` turns the feature on. `registry.js` `enableCommand` becomes `autorole add`.

## Global Constraints

- Everything stays inside Discord. Setup access is Manage Server or the bot manager role (`guard`); replies to setup commands are ephemeral.
- Roles: `@everyone` (role id equals the guild id) and managed roles can never be added to any list.
- Limits: 10 roles per list (`roles`, `bot_roles`), 25 blacklisted roles, delay 60 seconds to 30 days (2,592,000 seconds), sticky memory 30 days.
- A role is never listed twice in the same list; adding an existing role is a no-op with a clear reply.
- Handlers never throw; a failed role add warns with `console.warn` and does not stop the other roles. A deleted role (Discord error 10011) or a member who left (10007) is not retried.
- Languages `en`, `ar`, `fr` per server; a test enforces that `ar.json` and `fr.json` contain every key in `en.json`. Every new key needs real translations. Remove keys that become unused.
- Tests run with `node --test --test-concurrency=1`; Postgres via `docker compose up -d`. Test output stays pristine (stub `console.warn` where a test expects a warning, restore it in `finally`).
- Do not start the bot and do not create a Discord token. Check command builders serialise with:
  `node -e "import('./src/modules.js').then(m=>console.log(m.modules.flatMap(x=>x.commands).map(c=>c.data.toJSON().name)))"`
  (descriptions 1-100 characters, required options before optional ones).
- Commit messages end with the line `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`.

## Review Focus

1. A member who joins while a timed role is pending, leaves, and rejoins must not receive the role twice or end up with two pending rows (one pending row per member and role).
2. A timed role that is removed with `/autorole timed remove` must never be given afterwards, even if a row was already waiting.
3. With sticky roles on, a returning member must not get back a role above the bot, a managed role, a blacklisted role, or one that no longer exists, and an old (over 30 days) memory must be ignored.
4. A member whose roles are not cached when they leave (partial) must not erase a good memory with an empty one.
5. Two ticker runs must never overlap (a slow run must not be started twice), and a database or Discord error inside a run must not stop the ticker.

## File Structure (after this plan)

```
src/db/migrations/003_autorole_tables.sql   new (pending_roles, remembered_roles)
src/db/index.js                             resetDb truncate list extended
src/features/autorole/
  duration.js   new  (parseDuration, formatDuration)
  config.js     new  (readConfig, addRole, removeRole, blacklist, timed helpers; pure)
  store.js      new  (queue and memory SQL)
  assign.js     new  (assignAutoRole, rememberRoles, runDue, startTicker)
  index.js      rewritten (commands, show; exports events)
src/core/registry.js                        enableCommand 'autorole add'
src/index.js                                start the ticker when ready
README.md, src/i18n/{en,ar,fr}.json
```

---

### Task 1: Duration parsing and role-list config helpers

**Files:**
- Create: `src/features/autorole/duration.js`, `src/features/autorole/config.js`
- Test: `test/features/autorole-duration.test.js`, `test/features/autorole-config.test.js`

**Tier:** sonnet — pure functions from a prose spec, two files plus tests.

**Interfaces:**
- Produces (`duration.js`):
  - `parseDuration(input: string): number | null` seconds. Accepts `s`, `m`, `h`, `d` units, case-insensitive, combined (`1d12h`, `1h 30m`), no spaces required. `null` for empty, unknown unit, a bare number, zero, or anything that does not match completely.
  - `formatDuration(seconds: number): string` e.g. `90` gives `1m30s`, `90000` gives `1d1h`; zero units are skipped; always at least one unit.
  - `MIN_DELAY = 60`, `MAX_DELAY = 2592000`.
- Produces (`config.js`, pure, never touches the database or discord.js; `config` is the raw `guild_settings.config` object):
  - `LIMITS = { roles: 10, blacklist: 25 }`
  - `readConfig(config): { roles: string[], botRoles: string[], timed: Array<{ roleId: string, seconds: number }>, reassign: boolean, blacklist: string[] }` folds the legacy `humanRoleId` into `roles` and `botRoleId` into `botRoles` when the new keys are absent; stored keys are `roles`, `botRoles`, `timed`, `reassign`, `blacklist`; missing keys give empty lists and `false`.
  - `addRole(config, target: 'humans'|'bots', roleId): { ok: true, config } | { ok: false, reason: 'exists'|'full' }` returns a full patch object (the whole new normalised config, legacy keys dropped).
  - `removeRole(config, target: 'humans'|'bots'|'both', roleId): { ok: true, config } | { ok: false, reason: 'missing' }`
  - `addTimed(config, roleId, seconds)` / `removeTimed(config, roleId)` with the same result style; reasons `exists` (replace the delay instead: the same role again with a new delay updates it and returns ok), `full` (10 timed roles), `missing`.
  - `addBlacklist(config, roleId)` / `removeBlacklist(config, roleId)`; reasons `exists`, `full`, `missing`.
  - `setReassign(config, on: boolean): config`
  - `isValidRoleId(role, guildId): boolean` false for the `@everyone` role (`role.id === guildId`) and for managed roles (`role.managed`).

- [ ] **Step 1: Write the failing tests.** `autorole-duration.test.js`: `parseDuration('30m')` is 1800; `'2h'` 7200; `'1d12h'` 129600; `'1H 30M'` 5400; `'1d'` 86400; `'45d'` parses to 3888000 (range is checked by the command, not the parser); `''`, `'2'`, `'2x'`, `'0m'`, `'h'`, `'1h junk'` give `null`. `formatDuration(90)` is `1m30s`, `formatDuration(90000)` `1d1h`, `formatDuration(3600)` `1h`. `autorole-config.test.js`: legacy fold (`{ humanRoleId: 'H', botRoleId: 'B' }` reads as roles `['H']`, botRoles `['B']`); `addRole` twice gives `exists`; the 11th role gives `full`; bots and humans lists are independent; `removeRole` with `both` removes from either list; `addTimed` of an existing role updates its delay; the timed list caps at 10; blacklist add/remove with the 25 cap; `isValidRoleId` with a fake `{ id, managed }`; every helper leaves its input object unchanged.
- [ ] **Step 2: Run** `npm test`. Expected: FAIL (modules missing).
- [ ] **Step 3: Implement** both files with the signatures above. Keep them under about 120 lines each.
- [ ] **Step 4: Run** `npm test`. Expected: PASS, output pristine.
- [ ] **Step 5: Commit** `feat: auto role config helpers and duration parsing`.

---

### Task 2: Migration and queue/memory store

**Files:**
- Create: `src/db/migrations/003_autorole_tables.sql`, `src/features/autorole/store.js`
- Modify: `src/db/index.js` (`resetDb` truncate list)
- Test: `test/features/autorole-store.test.js`

**Tier:** sonnet — migration (risky work is never below sonnet).

**Interfaces:**
- Migration: table `pending_roles (guild_id TEXT NOT NULL, user_id TEXT NOT NULL, role_id TEXT NOT NULL, due_at TIMESTAMPTZ NOT NULL, PRIMARY KEY (guild_id, user_id, role_id))` with an index on `due_at`; table `remembered_roles (guild_id TEXT NOT NULL, user_id TEXT NOT NULL, role_ids JSONB NOT NULL, left_at TIMESTAMPTZ NOT NULL DEFAULT now(), PRIMARY KEY (guild_id, user_id))`. Plain `CREATE TABLE`; no existing data is touched.
- `resetDb` truncates `pending_roles` and `remembered_roles` too. The existing "openDb twice" test already compares `schema_version` rows with the number of `.sql` files, so it needs no change.
- Produces (`store.js`, all `(db, ...)` async):
  - `queueRole(db, guildId, userId, roleId, dueAtMs): Promise<void>` upsert; a second call for the same member and role replaces `due_at`.
  - `takeDue(db, nowMs, limit = 100): Promise<Array<{ guildId, userId, roleId }>>` deletes and returns the rows whose `due_at` is at or before `nowMs`, in one statement (`DELETE ... WHERE ctid IN (SELECT ... FOR UPDATE SKIP LOCKED) RETURNING ...`), so two runs never take the same row.
  - `cancelRole(db, guildId, roleId): Promise<number>` deletes waiting rows of that role, returns the count.
  - `rememberRoles(db, guildId, userId, roleIds: string[], nowMs): Promise<void>` upsert (an empty list is allowed here; the caller decides).
  - `takeRemembered(db, guildId, userId, nowMs, maxAgeMs): Promise<string[]>` deletes the row and returns its role ids, or `[]` when absent or older than `maxAgeMs`.
  - `purgeOld(db, nowMs, maxAgeMs): Promise<number>` deletes remembered rows older than `maxAgeMs`.

- [ ] **Step 1: Write the failing test** `autorole-store.test.js` (real database, `TRUNCATE pending_roles, remembered_roles` in `beforeEach`): `queueRole` twice keeps one row with the new due time; `takeDue` returns only due rows, removes them, and a second call returns `[]`; `takeDue` respects `limit`; `cancelRole` removes only that role in that guild; `rememberRoles` then `takeRemembered` returns the ids once and then `[]`; a row older than `maxAgeMs` gives `[]` (and is deleted); `purgeOld` removes only the old rows; rows of two guilds do not mix.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Write the migration, the `resetDb` change, and `store.js`** with parameterised SQL only.
- [ ] **Step 4: Run** `npm test`. Expected: PASS.
- [ ] **Step 5: Commit** `feat: pending and remembered auto role tables`.

---

### Task 3: Assigning, remembering and the ticker

**Files:**
- Create: `src/features/autorole/assign.js`
- Test: `test/features/autorole-assign.test.js` (replaces the cases of `test/features/autorole.test.js`; delete that file when its cases are carried over)

**Tier:** sonnet — concurrency (ticker overlap) and several interacting rules; the reviewer is opus per the tiering rules.

**Interfaces:**
- Consumes: `readConfig` (Task 1), the store (Task 2), `getFeature` from `../../db/settings.js`.
- Produces:
  - `assignAutoRole(ctx, member, { now = Date.now() } = {}): Promise<void>` never throws. If the feature is off, return. Collect the role ids to give: bots get `botRoles`; humans get `roles` plus, when `reassign` is on, `takeRemembered(...)` (30 days) minus blacklisted roles, minus roles that no longer exist in `member.guild.roles.cache`, minus roles at or above the bot's highest role (`member.guild.members.me?.roles.highest.position`; when the bot's position is unknown skip this filter), minus managed roles. Remove duplicates. Add them one by one with `member.roles.add(id)`; one failure warns (`Auto role failed in <guild>: <message>`) and the others still go. For humans also `queueRole(...)` each timed role at `now + seconds*1000` (skipping roles the member already has). Memory is read only when `reassign` is on; when it is off, nothing is read or kept.
  - `rememberMemberRoles(ctx, member, { now = Date.now() } = {}): Promise<void>` never throws. When the feature is on and `reassign` is on and the member is not a bot: if `member.partial` or the member's role cache has only `@everyone`, do nothing (review focus 4). Otherwise remember the ids of all roles except `@everyone`, managed roles, blacklisted roles and roles at or above the bot's highest role.
  - `runDue(ctx, { now = Date.now() } = {}): Promise<void>` never throws. `takeDue` the due rows; for each, skip silently unless the role is still in that guild's timed list (so a removed timed role is never given, review focus 2); fetch the guild from `ctx.client.guilds.cache` and the member with `guild.members.fetch(userId)`; on Discord error 10007 or 10011 drop it quietly; on another error warn and drop it. Then `purgeOld` for remembered roles (30 days).
  - `startTicker(ctx, { intervalMs = 30000 } = {}): { stop(): void }` runs `runDue` every `intervalMs` with an in-flight flag so a run that is still going is not started again (review focus 5); errors inside a run are caught and logged with `console.warn`; the timer is `unref()`ed so it never keeps the process alive in tests.
  - `events` array: `GuildMemberAdd` → `assignAutoRole`, `GuildMemberRemove` → `rememberMemberRoles`.

- [ ] **Step 1: Write the failing test** `autorole-assign.test.js` (real database, Discord fakes in the style of the old autorole test: `member.roles.add`, `member.guild.roles.cache` as a `Map`, `member.guild.members.me.roles.highest.position`, `member.roles.cache` as a `Map`). Cases: (a) a human gets all human roles and a bot gets only bot roles; (b) legacy `humanRoleId`/`botRoleId` config still works; (c) feature off adds nothing; (d) one failing add warns and the others are still added; (e) timed roles are queued for humans only, due at `now + delay`, and a member who rejoins has one pending row per role, not two; (f) `runDue` gives a due role, ignores one not yet due, and does not give a role that was removed from the timed list since it was queued; (g) `runDue` drops a row for a member who left (error code 10007) without throwing; (h) reassign off: nothing remembered, nothing re-given; (i) reassign on: leave remembers roles minus `@everyone`, managed, blacklisted and above-bot roles; rejoin gives back remembered plus auto roles with no duplicates; (j) memory older than 30 days is ignored; (k) a partial member or one with only `@everyone` does not overwrite an existing memory; (l) a role that was deleted is not re-given; (m) `startTicker`: with a fake slow `runDue` the second tick does not start while the first is running (use a small `intervalMs` and a counter), and `stop()` ends it. Stub `console.warn` where a warning is expected and restore it in `finally`.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement `assign.js`** with the signatures above. Do not touch `index.js` yet; it still imports `assignAutoRole` from itself, so keep the old function in `index.js` untouched until Task 4 replaces it.
- [ ] **Step 4: Run** `npm test`. Expected: PASS; the old `test/features/autorole.test.js` keeps passing until Task 4 deletes it.
- [ ] **Step 5: Commit** `feat: multi-role, timed and sticky auto role logic`.

---

### Task 4: Commands, locales, registry

**Files:**
- Modify: `src/features/autorole/index.js` (rewrite), `src/core/registry.js`, `src/i18n/en.json`, `ar.json`, `fr.json`, `test/core/registry.test.js` and `test/features/panel.test.js` if they mention `autorole setup`
- Delete: `test/features/autorole.test.js` (its cases now live in `autorole-assign.test.js`)
- Test: `test/features/autorole-commands.test.js`

**Tier:** sonnet — multi-file integration from a prose spec.

**Interfaces:**
- Consumes: `config.js` (Task 1), `store.cancelRole` (Task 2), `assign.js` `events` (Task 3), `guard`, `ephemeral`, `getFeature`/`setFeature`, `handleToggle` (for `disable`).
- Produces: the `/autorole` command described in "Design", `export const commands`, and `export const events = assignEvents` (re-export from `assign.js`). `registry.js`: `enableCommand: 'autorole add'`.
- Behaviour:
  - `add`: required `role`, optional `target` choices `humans` / `bots` (default humans). Reject `@everyone` and managed roles with `autorole.badRole`. `addRole`; reasons `exists` → `autorole.exists`, `full` → `autorole.full` (with the limit). On success save the whole returned config with `setFeature` (replace semantics: since `setFeature` merges at the top level and the new config drops the legacy keys, set `humanRoleId: null` and `botRoleId: null` in the patch so the legacy keys cannot come back through `readConfig`), enable the feature, reply `autorole.added`, plus `autorole.tooHigh` when the role is at or above the bot's highest role.
  - `remove`: `removeRole`; `missing` → `autorole.notListed`.
  - `show`: one ephemeral message; roles as `<@&id>` mentions inside a message with `allowedMentions: { parse: [] }`; roles missing from the guild marked with the text `autorole.deletedRole`; roles above the bot marked `autorole.tooHigh` short form; timed roles with `formatDuration`; reassign on/off; blacklist. Cap long lists with `capList` as the other features do. Shows `autorole.nothing` when everything is empty.
  - `reassign`: required choice `state` `on` / `off`.
  - `blacklist add|remove`, `timed add|remove` (delay validated: `parseDuration`, 60 s to 30 days, otherwise `autorole.badDelay`). `timed remove` saves the config with `setFeature` then calls `cancelRole`.
  - `disable`: `handleToggle(interaction, ctx, 'autorole')` as today.
- Locale keys (en, then real ar and fr): `autorole.added`, `autorole.removed`, `autorole.exists`, `autorole.full`, `autorole.notListed`, `autorole.badRole`, `autorole.badDelay`, `autorole.timedAdded`, `autorole.timedRemoved`, `autorole.reassignOn`, `autorole.reassignOff`, `autorole.blacklistAdded`, `autorole.blacklistRemoved`, `autorole.blacklistFull`, `autorole.showTitle`, `autorole.humans`, `autorole.bots`, `autorole.timed`, `autorole.sticky`, `autorole.blacklist`, `autorole.nothing`, `autorole.deletedRole`. Remove `autorole.setupDone`. Keep `autorole.tooHigh`.

- [ ] **Step 1: Write the failing test** `autorole-commands.test.js` (no Discord, no database): the builder serialises; top-level subcommands/groups are exactly `add, remove, show, reassign, blacklist, timed, disable`; `blacklist` has `add` and `remove`; `timed` has `add` (options in the order `delay`, `role`, both required) and `remove`; `add`'s `target` option is optional with choices `humans` and `bots`; all descriptions are 1-100 characters.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement** `index.js`, the registry change, the locale keys, and update the two tests that mention `autorole setup` (search `test/` for it). Delete `test/features/autorole.test.js`.
- [ ] **Step 4: Run** `npm test` and the serialise check. Expected: PASS; the command list still shows `autorole` once and nothing else changed.
- [ ] **Step 5: Commit** `feat: /autorole add, remove, show, reassign, blacklist and timed`.

---

### Task 5: Start the ticker, README, final check

**Files:**
- Modify: `src/index.js`, `README.md`
- Test: whole suite

**Tier:** sonnet — wiring plus a README rewrite from prose.

- [ ] **Step 1:** In `src/index.js`, inside the `ClientReady` handler, call `startTicker(ctx)` from `./features/autorole/assign.js` once, and log nothing noisy. Read how the file already handles the handler and keep the style.
- [ ] **Step 2:** Update `README.md`: the features list and command list for `/autorole` (add, remove, show, reassign, blacklist, timed, disable), and the manual-check list: add roles for humans and bots, `show`, a timed role with `1m`, reassign on then leave and rejoin, blacklist a role, `timed remove` cancelling a waiting role. Remove the `/autorole setup` line.
- [ ] **Step 3:** Run `npm test` (all pass, no new console noise) and the serialise check; run `node --check src/index.js`.
- [ ] **Step 4:** Search `src/` and `test/` for `autorole.setupDone`, `autorole setup`, `humanRoleId` and `botRoleId`; the only allowed hits are the legacy fold in `config.js` and its tests. Check `ar.json` and `fr.json` have the same keys as `en.json` (the suite does) and that no `autorole.*` key is unused.
- [ ] **Step 5: Commit** `feat: run the auto role ticker; document the new /autorole`.

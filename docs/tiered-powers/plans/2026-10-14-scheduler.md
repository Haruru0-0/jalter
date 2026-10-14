# Shared Scheduler Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use tiered-powers:subagent-driven-development (recommended) or tiered-powers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One shared, restart-safe job scheduler that features plug into, with auto role's timed roles moved onto it.

**Architecture:** A `scheduled_jobs` table plus `src/core/scheduler.js`: pure DB helpers (schedule, cancel, claim, complete, fail) and a ticker (`runDueJobs`, `startScheduler`). Jobs are at-least-once: a tick claims due rows (`FOR UPDATE SKIP LOCKED`, claim expires after 5 minutes, attempt counted at claim), runs the type's handler, deletes the row on return and reschedules with backoff on throw, dropping it after 5 attempts. Features export `jobs` (type to handler) and `housekeeping` (per-tick functions); `collectModules` gathers them and `src/index.js` starts one scheduler.

**Tech Stack:** Node 22 ESM, Postgres (`pg`), discord.js 14.27, `node --test` with the real test DB (`testDb()` from `test/helpers/db.js`).

**Spec:** `docs/tiered-powers/specs/2026-10-14-scheduler-design.md` (read it; it holds the decisions this plan implements).

## Global Constraints

- Node 22, ESM, Postgres, `npm test` (`node --test --test-concurrency=1`; tests hit the DB, run `npm run db:up` first). No new dependencies.
- Follow existing style: small modules, a `now` parameter (ms since epoch) for anything time-based, `console.warn` for failures that must not crash the bot.
- No user-facing text is added, so no i18n changes.
- Existing behavior of `/autorole timed add|remove` and the 30 000 ms cadence must not change; the timer starts only after the client is ready; before that, due jobs are left alone.
- Handler contract: returning normally means done (row deleted, including "nothing to do"); throwing means retry. Max 5 attempts, backoff 1, 5, 15, 60 minutes between attempts 1-4 then drop with `console.warn`. Claim lasts 5 minutes (`CLAIM_MS = 5 * 60 * 1000`).
- A job type with no registered handler is never claimed and never counted; warn once per type per process.
- Commit after each task; run `npm test` before each commit. Commit messages carry no `Co-Authored-By` or other Claude attribution lines; the git identity is the user's (do not change git config).
- Migrations are numbered SQL files in `src/db/migrations/` (next free numbers: `004`, `005`), run once inside a transaction by `openDb`.

## Review Focus

- A handler that always throws is retried with backoff and dropped after 5 attempts (not forever); a job whose process died mid-run is re-run after the claim expires and still counts attempts.
- Two ticks claiming at once get disjoint jobs (`SKIP LOCKED`); a job claimed and still running is not claimed again.
- A job whose type has no handler stays untouched in the table and does not block jobs of other types.
- Migration `005` moves existing `pending_roles` rows into `scheduled_jobs` with their due times and drops the old table; a waiting member still gets the role.
- Auto role handler: permanent Discord errors (HTTP 4xx other than 429, e.g. missing permission, role above the bot, unknown member or role) finish the job after a log line; network or 5xx errors throw and retry; feature switched off or role no longer in the timed list finishes the job without granting.
- Scheduling the same key twice keeps one row with the new due time and resets attempts.

---

### Task 1: Jobs table and store helpers

**Files:**
- Create: `src/db/migrations/004_scheduled_jobs.sql`, `src/core/scheduler.js`
- Modify: `src/db/index.js` (add `scheduled_jobs` to the `resetDb` TRUNCATE list)
- Test: `test/core/scheduler-store.test.js`

**Tier:** sonnet — SQL claim semantics under concurrency; the signatures leave the queries to the implementer.

**Interfaces:**
- Produces (`src/core/scheduler.js`), all taking the pg pool `db` first:
  - `CLAIM_MS = 300000`, `MAX_ATTEMPTS = 5`, `BACKOFF_MS = [60000, 300000, 900000, 3600000]` (exported constants).
  - `scheduleJob(db, { guildId, type, key = null, payload = {}, dueAt }): Promise<void>` — `dueAt` in ms. With a `key`, a second call for the same guild, type and key replaces `payload` and `due_at` and resets `attempts` and `claimed_until`; with no key every call inserts a new row.
  - `cancelJobs(db, { guildId, type, key = null, payload = null }): Promise<number>` — deletes jobs of that guild and type; when `key` is given it must equal; when `payload` is given the stored payload must contain it (JSONB `@>`). Returns the count deleted.
  - `claimDue(db, nowMs, { types, limit = 100 }): Promise<Job[]>` where `Job = { id, guildId, type, key, payload, attempts, dueAt }` (`dueAt` in ms). Claims rows with `type = ANY(types)`, `due_at <= now` and an absent or expired claim, ordered by `due_at`; in the same statement sets `claimed_until = now + CLAIM_MS` and `attempts = attempts + 1` (returned `attempts` is the new value). `types` empty returns `[]`.
  - `completeJob(db, id): Promise<void>` — deletes the row.
  - `failJob(db, job, nowMs): Promise<'retry' | 'dropped'>` — if `job.attempts >= MAX_ATTEMPTS` delete and return `'dropped'`; otherwise set `due_at = now + BACKOFF_MS[min(attempts - 1, 3)]`, clear `claimed_until`, return `'retry'`.
  - `countDueOtherTypes(db, nowMs, types): Promise<string[]>` — distinct `type`s of due, claimable rows whose type is not in `types` (used to warn about missing handlers).
- Table `scheduled_jobs`: `id BIGSERIAL PRIMARY KEY`, `guild_id TEXT NOT NULL`, `type TEXT NOT NULL`, `key TEXT`, `payload JSONB NOT NULL DEFAULT '{}'`, `due_at TIMESTAMPTZ NOT NULL`, `attempts INTEGER NOT NULL DEFAULT 0`, `claimed_until TIMESTAMPTZ`; unique index on `(guild_id, type, key)` (NULL keys never conflict); index on `due_at`.

- [ ] **Step 1: Write the failing tests** in `test/core/scheduler-store.test.js` (`beforeEach` truncates `scheduled_jobs`; use `testDb()` and fixed `NOW`):
  - `scheduling the same key twice keeps one row with the new due time and reset attempts` (claim once first so attempts is 1, reschedule, claim again later and assert attempts is 1).
  - `keyless jobs always insert a new row`.
  - `claimDue returns only due jobs of the requested types, oldest first, and sets attempts to 1`.
  - `a claimed job is not claimed again until the claim expires, then attempts is 2` (claim at `NOW`, claim at `NOW + CLAIM_MS - 1` returns `[]`, at `NOW + CLAIM_MS` returns the job with `attempts` 2).
  - `claimDue respects limit and skips types not requested`; empty `types` returns `[]`.
  - `two concurrent claimDue calls return disjoint jobs` (insert 10 jobs, `Promise.all` two claims with `limit: 10`, assert no id appears twice and the union is all 10).
  - `completeJob deletes the row`.
  - `failJob reschedules with growing backoff and clears the claim` (attempts 1 gives `now + 60000`, attempts 3 gives `now + 900000`) and `failJob drops the job at attempts 5` (loop claim and fail until `'dropped'`, row gone).
  - `cancelJobs by key, by payload containment and by type only` (payload `{ roleId: 'r1' }` removes only matching rows; returns the count; other guild untouched).
  - `countDueOtherTypes lists due types without a handler`.
- [ ] **Step 2: Run** `node --test test/core/scheduler-store.test.js` — expect FAIL (module not found).
- [ ] **Step 3: Create the migration and implement** the exports above in `src/core/scheduler.js` (one parameterised query per function; `claimDue` is a single `UPDATE ... WHERE id IN (SELECT ... FOR UPDATE SKIP LOCKED) RETURNING ...`). Add `scheduled_jobs` to the `resetDb` TRUNCATE list in `src/db/index.js`.
- [ ] **Step 4: Run** the test file, then `npm test` — expect PASS.
- [ ] **Step 5: Commit** `feat(scheduler): scheduled_jobs table and claim/retry helpers`.

---

### Task 2: Ticker and module registration

**Files:**
- Modify: `src/core/scheduler.js` (add `runDueJobs`, `startScheduler`), `src/core/loader.js` (`collectModules` gathers `jobs` and `housekeeping`)
- Test: `test/core/scheduler-run.test.js`, extend `test/core/loader.test.js` if it exists (else add the loader cases to `scheduler-run.test.js`)

**Tier:** sonnet — error classification and timer behavior; tests drive the design.

**Interfaces:**
- Consumes: Task 1 helpers and constants.
- Produces:
  - `collectModules(modules)` now also returns `jobs: Map<string, (ctx, job) => Promise<void>>` (from each module's optional `jobs` object, `{ [type]: handler }`; a duplicate type throws `Duplicate job type: <type>`) and `housekeeping: Array<(ctx, { now }) => Promise<void>>` (each module's optional `housekeeping` array, concatenated).
  - `runDueJobs(ctx, { jobs, housekeeping }, { now = Date.now() } = {}): Promise<void>` — returns at once if `ctx.client.isReady?.() === false`. Otherwise: run every housekeeping function (each in its own try/catch with `console.warn`), warn once per type per process for `countDueOtherTypes` results (module-level `Set`), `claimDue` for `[...jobs.keys()]`, then run each job's handler in turn inside try/catch: return means `completeJob`; a throw means `failJob` plus `console.warn` (include type, guild, attempts and message; a different warning when the result is `'dropped'`). Never throws.
  - `startScheduler(ctx, registry, { intervalMs = 30000 } = {}): { stop }` — `setInterval` with a `running` guard against overlapping ticks, a catch that warns, `timer.unref()`; same shape as `startTicker` in `src/features/autorole/assign.js`.

- [ ] **Step 1: Write the failing tests:**
  - loader: `collectModules gathers jobs and housekeeping and rejects a duplicate job type`.
  - `a handler that returns completes the job`; `a handler that throws is retried later and dropped after 5 attempts` (loop `runDueJobs` with `now` advanced past each backoff; handler call count is 5, row gone, a warning logged — capture `console.warn`).
  - `a job claimed by a crashed run is run again after the claim expires` (claim with `claimDue` directly, never complete, then `runDueJobs` at `now + CLAIM_MS` runs the handler).
  - `jobs of a type with no handler stay untouched and other jobs still run`, and the warning for that type is logged only once across two ticks.
  - `housekeeping runs every tick and a throwing housekeeping function does not stop jobs`.
  - `nothing runs while the client is not ready` (`client.isReady = () => false`: handler not called, row untouched).
  - `one throwing handler does not stop the next job in the batch`.
  - `startScheduler ticks on an interval, does not overlap slow ticks and survives a failing tick` (adapt the existing `startTicker` test in `test/features/autorole-assign.test.js`, lines ~268-345, which Task 3 later removes); `stop()` clears the timer.
- [ ] **Step 2: Run** the new test files — expect FAIL.
- [ ] **Step 3: Implement** `runDueJobs`, `startScheduler` and the loader change.
- [ ] **Step 4: Run** `npm test` — expect PASS.
- [ ] **Step 5: Commit** `feat(scheduler): ticker, retries and module job registration`.

---

### Task 3: Move auto role's timed roles onto the scheduler

**Files:**
- Create: `src/db/migrations/005_autorole_to_scheduler.sql`
- Modify: `src/features/autorole/store.js`, `src/features/autorole/assign.js`, `src/features/autorole/index.js`, `src/index.js`, `src/db/index.js`
- Test: `test/features/autorole-store.test.js`, `test/features/autorole-assign.test.js`, `test/features/autorole-commands.test.js`, new `test/db/migration-005.test.js`

**Tier:** sonnet — multi-file migration of live behavior; existing tests must be adapted without losing coverage.

**Interfaces:**
- Consumes: Task 1 `scheduleJob`, `cancelJobs`; Task 2 `startScheduler`, `collectModules` with `jobs`/`housekeeping`.
- Produces:
  - Job type `'autorole.grant'`, key `` `${userId}:${roleId}` ``, payload `{ userId, roleId }`.
  - `src/features/autorole/store.js`: `queueRole(db, guildId, userId, roleId, dueAtMs)` and `cancelRole(db, guildId, roleId)` stay with the same signatures but now delegate to `scheduleJob` and `cancelJobs` (cancel by payload `{ roleId }`, returns the count); `takeDue` is removed; the `remembered_roles` functions are unchanged.
  - `src/features/autorole/assign.js`: `grantTimedRole(ctx, job): Promise<void>` replaces `runDue` (checks: feature enabled, `cfg.timed` still lists `job.payload.roleId`, guild in cache, then `guild.members.fetch(userId)` and `member.roles.add(roleId)`); `purgeRememberedRoles(ctx, { now }): Promise<void>` (calls `purgeOld(ctx.db, now, MEMORY_MAX_AGE_MS)` inside try/catch with a warning) replaces the purge that rode on `runDue`; `startTicker` is removed.
  - Error rule inside `grantTimedRole`: an error with `status` 400-499 except 429 is permanent — return after `console.warn` (no warning for Discord codes 10007 unknown member and 10011 unknown role, which return quietly as today); anything else is rethrown so the scheduler retries.
  - `src/features/autorole/index.js` additionally exports `jobs = { 'autorole.grant': grantTimedRole }` and `housekeeping = [purgeRememberedRoles]`.
  - `src/index.js`: replace the `startTicker(ctx)` import and call with `startScheduler(ctx, registry)`.

- [ ] **Step 1: Write the failing tests:**
  - `test/db/migration-005.test.js`: create `pending_roles` (same columns as `003_autorole_tables.sql`), insert two rows with different due times, run the full text of `005_autorole_to_scheduler.sql` through `db.query`, assert `scheduled_jobs` holds two `autorole.grant` rows with the same `due_at`, key `userId:roleId`, payload `{ userId, roleId }`, and that `pending_roles` no longer exists; the migration also tolerates an empty `pending_roles`.
  - Adapt the existing autorole tests: every `SELECT ... FROM pending_roles` becomes a query of `scheduled_jobs WHERE type = 'autorole.grant'`; every `TRUNCATE ... pending_roles` becomes `scheduled_jobs`; `autorole-store.test.js` drops the `takeDue` tests and keeps `queueRole` twice keeping one row and `cancelRole` removing only that role in that guild; `runDue` tests become `grantTimedRole` tests keeping the same intent: (f) gives the role and ignores a role removed from the timed list, (g) a member who left finishes the job quietly, disabled feature finishes the job, guild missing from cache finishes the job.
  - New: `grantTimedRole returns after a warning on a 403 (missing permission or role above the bot)`; `grantTimedRole rethrows a network error and a 500` so the scheduler retries; `purgeRememberedRoles removes memories older than 30 days`; an end-to-end `runDueJobs` test with the real autorole `jobs` and `housekeeping` that grants a due role through the scheduler.
  - The `startTicker` tests move out (Task 2 already covers `startScheduler`).
- [ ] **Step 2: Run** `node --test test/db/migration-005.test.js test/features/autorole-*.test.js` — expect FAIL.
- [ ] **Step 3: Implement.** Migration `005`: `INSERT INTO scheduled_jobs (guild_id, type, key, payload, due_at) SELECT guild_id, 'autorole.grant', user_id || ':' || role_id, jsonb_build_object('userId', user_id, 'roleId', role_id), due_at FROM pending_roles ON CONFLICT DO NOTHING;` then `DROP TABLE pending_roles;`. Update `store.js`, `assign.js`, `index.js` (autorole), `src/index.js`, and remove `pending_roles` from the `resetDb` TRUNCATE list.
- [ ] **Step 4: Run** `npm test` — expect all green, output pristine. Confirm nothing references `pending_roles`, `takeDue`, `runDue` or `startTicker`: `grep -rn "pending_roles\|takeDue\|runDue\|startTicker" src test` (only the migration files may match).
- [ ] **Step 5: Commit** `refactor(autorole): run timed roles on the shared scheduler`.

---

### Task 4: Documentation and memory notes

**Files:**
- Modify: `docs/tiered-powers/specs/2026-10-14-scheduler-design.md` (status line), `docs/tiered-powers/specs/2026-10-14-feature-roadmap.md` (Step 0 status), `docs/memory/architecture.md`, `docs/memory/roadmap.md`, `docs/memory/decisions.md`, `docs/memory/gotchas.md`, `docs/memory/features-built.md`, `docs/memory/index.md` (keep accurate)

**Tier:** sonnet — prose that must match the real code.

- [ ] **Step 1:** Read `src/core/scheduler.js` and the autorole files, then update the notes: architecture gets the scheduler (table, ticker, `jobs` and `housekeeping` exports, handler contract); roadmap moves the scheduler from "In progress" to "Done" and says moderation timed actions come next; decisions turns the "proposed" scheduler entry into the final rules; gotchas adds "handlers must be idempotent and must return (not throw) on permanent Discord errors; a feature adds a job type by exporting `jobs`"; the design doc status becomes "built". Link notes with `[[wikilinks]]`; record only what is true in the code.
- [ ] **Step 2: Commit** `docs: scheduler is built; memory and roadmap notes`.

---

### Task 5: Final verification run

**Files:** none changed.

**Tier:** haiku — run-and-report, no decisions.

```bash
npm test
python -m graphify update .
```

- [ ] **Step 1:** Run `npm test`; report pass/fail counts and the full output of any failure.
- [ ] **Step 2:** Run `python -m graphify update .`; report its last 5 lines.
- [ ] **Step 3:** Report back; do not fix failures. The manual check for the user: `/autorole timed add delay:1m role:<role>`, add a new account, the role arrives after about a minute (README manual check 12).

# Anti-raid Review Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use tiered-powers:subagent-driven-development (recommended) or tiered-powers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the eleven findings of the opus review of `src/features/antiraid` (items 1-10 from the review) on branch `phase-2`.

**Architecture:** The lockdown state stays in the `antiraid` feature config jsonb. Every write made by a running start becomes conditional on `config->>'lockedAt'` still being that start's own value, so an end, a disable or a newer lockdown can no longer be overwritten. The end reads the pre-flip config in the same statement that flips it.

**Tech Stack:** Node 22 ESM, discord.js 14, Postgres, `node:test` (`npm test`, tests hit the DB).

**Spec:** `docs/tiered-powers/specs/2026-10-19-antiraid-design.md` (original design) and the review decisions below.

## Global Constraints

- Any new user-facing text goes in `src/i18n/en.json`, `fr.json` and `ar.json`.
- Tests hit the DB: start it with `npm run db:up` first; run with `npm test` (`--test-concurrency=1`).
- Commits: no Co-Authored-By trailer; use the user's own git name and email.
- Work stays on branch `phase-2`. Do not push or merge.
- Decisions by the user: count **distinct users** per window; raid kicks send **no DM** but still create cases; fix all review items 1-6 and 8-10.

## Review Focus

- A join that loses the start race (`already_locked`) is still kicked if young.
- A start that is ended or disabled mid-run leaves no invite pause and kicks nobody afterwards.
- `kicked` equals the sum of start-loop kicks and late-join kicks.
- A lock whose end timer was never queued, or whose guild was uncached at end time, still ends.
- An admin's DM pause or extended invite pause survives start and end.
- A bot without Kick Members kicks nobody and DMs nobody.

---

### Task 1: Distinct users in the join store

**Files:**
- Modify: `src/features/antiraid/joins.js`
- Test: `test/features/antiraid-joins.test.js`

**Tier:** sonnet — small behavior change plus one test rewrite

**Interfaces:**
- Produces: `record(guildId, {userId, createdAt}, now, windowMs)` returns the number of **distinct userIds** live in the window; `recent(guildId, now, windowMs)` returns one entry per userId (its latest join), oldest first.

- [ ] **Step 1: Rewrite the test at `antiraid-joins.test.js:90`** (`the same user joining twice is counted twice`) as `the same user joining twice is counted once`: record user `a` twice inside the window, assert `record` returns 1 and `recent` has one entry for `a`. Add `a rejoin refreshes joinedAt so the user stays live`: user `a` joins at t=0 and t=50s with a 60s window, at t=70s `record` for `b` returns 2.
- [ ] **Step 2:** Run `node --test --test-concurrency=1 test/features/antiraid-joins.test.js`. Expected: the two new tests FAIL.
- [ ] **Step 3:** In `record`, replace an existing entry with the same `userId` (keep one per user, latest `joinedAt`) before pushing; count and `recent` stay filtered by `isLive`. Keep `prune`/`size` working.
- [ ] **Step 4:** Rerun the file. Expected: all PASS.
- [ ] **Step 5:** Commit `fix(antiraid): count distinct users in the join window`.

---

### Task 2: Lockdown hardening (items 2-6, 8, 9)

**Files:**
- Modify: `src/features/antiraid/lockdown.js`
- Modify: `src/i18n/en.json`, `src/i18n/fr.json`, `src/i18n/ar.json` (one key: `antiraid.start.failed`)
- Test: `test/features/antiraid-lockdown.test.js`

**Tier:** sonnet — concurrency-sensitive, one file with interdependent changes; opus reviews it in Task 6

**Interfaces:**
- Produces (internal): `flipToIdle(ctx, guildId, patch) -> Promise<object|null>` returns the config as it was before the flip, or `null` when there was no lockdown. `patchIfCurrent(ctx, guildId, lockedAt, patch) -> Promise<boolean>` merges `patch` only while `state = 'locked'` and `config->>'lockedAt'` equals `String(lockedAt)`. `bumpKicked(ctx, guildId, lockedAt)` is conditional the same way.
- Produces (public): `startLockdown` may now return `{ ok: false, reason: 'schedule_failed' }`. `endJob` ignores a job whose `payload.lockedUntil` differs from the current `lockedUntil`.

- [ ] **Step 1: Write failing tests** in `antiraid-lockdown.test.js`, one per behavior, reusing `makeGuild`/`makeMember`:
  - `start undoes the lock and returns schedule_failed when the end timer cannot be queued` (inject a failing `scheduleJob` via a new `deps.scheduleJob`; assert state idle, no kicks, reason `schedule_failed`).
  - `end called during a running start leaves no invite pause and stops the kicks` (make the injected `sendLog` call `endLockdown` before resolving; assert `setIncidentActions` last call lifted the pause and no `runAction` calls happened).
  - `kicked counts both the start loop and a late join` (run start with 3 candidates, call `kickYoungJoin` during the loop through the injected `run`; assert final `kicked` is 4).
  - `start keeps the admin's dmsDisabledUntil` (assert every `setIncidentActions` call passes `dmsDisabledUntil` equal to the guild's current value).
  - `end does not lift an invite pause that no longer matches lockedUntil`.
  - `a bot without Kick Members kicks and DMs nobody` (both `startLockdown` and `kickYoungJoin`; assert `runAction` not called).
  - `raid kicks pass config.dm false` (assert the `config` given to `runAction`).
  - `endJob ignores a job for an older lockdown` (job payload `lockedUntil` differs; state stays locked).
  - `endJob with an uncached guild forces idle on the last attempt and throws before that`.
  - `the invite pause happens before the alert is sent` (record call order).
- [ ] **Step 2:** Run `node --test --test-concurrency=1 test/features/antiraid-lockdown.test.js`. Expected: the new tests FAIL.
- [ ] **Step 3: Implement in `lockdown.js`:**
  - Item 2: after `flipToLocked`, if `scheduleJob` throws, call `flipToIdle` and return `{ ok: false, reason: 'schedule_failed' }`. Accept `deps.scheduleJob ?? scheduleJob`. In `endJob`, when the guild is not cached, throw on attempts before `MAX_ATTEMPTS` and call `forceIdle` on the last.
  - Item 3: add `patchIfCurrent`/conditional `bumpKicked`; use `patchIfCurrent` for the invite-result write and the final result write. If the invite-result write returns false and we paused invites, lift the pause immediately. Before each candidate kick, stop the loop when the lockdown is no longer ours. `flipToIdle` becomes a single statement that returns the old config (CTE selecting the locked row `FOR UPDATE`, then `UPDATE ... RETURNING` of the old config); `endLockdown` takes `invitesPausedByUs`, `lockedUntil` and `kicked` from it instead of a separate read.
  - Item 4: call `bumpKicked` after every successful candidate kick in `startLockdown`; drop `kicked` from the final write; `startLockdown` returns the count it kicked.
  - Item 5: every `setIncidentActions` call passes `dmsDisabledUntil: guild.incidentsData?.dmsDisabledUntil ?? null`. `endLockdown` lifts only when `guild.incidentsData?.invitesDisabledUntil` matches the old `lockedUntil` within 1000 ms; otherwise `lifted` stays false.
  - Item 6: before kicking (start loop and `kickYoungJoin`), return without kicking when `guild.members.me?.permissions?.has(PermissionFlagsBits.KickMembers)` is false; pass `config: { ...modConfig, dm: false }` to `run`.
  - Item 8: `endJob` loads the current config and returns when `job.payload?.lockedUntil !== cfg.lockedUntil`.
  - Item 9: move the invite-pause block (and its result write) above the alert block.
  - Add `antiraid.start.failed` to the three i18n files (`en`: "Could not start the lockdown: the end timer could not be queued. Try again.").
- [ ] **Step 4:** Rerun the file. Expected: all PASS, including the pre-existing tests (update any that assumed the old call order or `kicked` write, keeping their intent).
- [ ] **Step 5:** Commit `fix(antiraid): make the lockdown start and end race-safe`.

---

### Task 3: Detector handles lost start race and expired locks (items 1, 2)

**Files:**
- Modify: `src/features/antiraid/events.js`
- Test: `test/features/antiraid-events.test.js`

**Tier:** sonnet — two small behaviors in one handler

**Interfaces:**
- Consumes: `startLockdown` result `{ ok: false, reason: 'already_locked' | 'disabled' | 'schedule_failed' }`; `endLockdown(ctx, guild, { by: 'timer' }, deps)`.
- Produces: `createEvents(deps)` also accepts `deps.endLockdown`.

- [ ] **Step 1: Write failing tests:** `a join that loses the start race is kicked` (stub `start` returns `{ok:false, reason:'already_locked'}`; assert `kick` called with that member); `an expired lock is ended on the next join` (config `state:'locked'`, `lockedUntil` in the past; assert `end` called with `by:'timer'` and the join is then counted as idle, not kicked); `a live lock still kicks` (unchanged behavior).
- [ ] **Step 2:** Run `node --test --test-concurrency=1 test/features/antiraid-events.test.js`. Expected: new tests FAIL.
- [ ] **Step 3:** In `onMemberAdd`: if `cfg.state === 'locked' && cfg.lockedUntil && cfg.lockedUntil <= now()`, call `end(...)` and continue down the idle path; if `start` returns `already_locked`, call `kick(ctx, guild, member, deps)`.
- [ ] **Step 4:** Rerun the file. Expected: all PASS.
- [ ] **Step 5:** Commit `fix(antiraid): kick racing joins and end expired locks`.

---

### Task 4: Robust disable and start failure reply (items 2, 10)

**Files:**
- Modify: `src/features/antiraid/commands.js`
- Test: `test/features/antiraid-commands.test.js`

**Tier:** sonnet — ordering change plus error handling

**Interfaces:**
- Consumes: `startLockdown` reason `'schedule_failed'`; i18n key `antiraid.start.failed` from Task 2.

- [ ] **Step 1: Write failing tests:** `disable turns the feature off even when ending the lockdown throws` (stub `end` throws; assert feature disabled and the reply is `antiraid.disable.ended`); `disable turns the feature off before it ends the lockdown` (record call order); `start replies with the failure text on schedule_failed`.
- [ ] **Step 2:** Run `node --test --test-concurrency=1 test/features/antiraid-commands.test.js`. Expected: new tests FAIL.
- [ ] **Step 3:** In `executeDisable`: when locked, `setFeature(... enabled:false)` first, then `end(...)` inside try/catch that logs a warning (the end job and the next-join expiry check remain as backstops), then reply. In `executeStart`, map `schedule_failed` to `antiraid.start.failed`.
- [ ] **Step 4:** Rerun the file. Expected: all PASS.
- [ ] **Step 5:** Commit `fix(antiraid): disable first, then end; report a failed start`.

Note: `endLockdown` is called after the feature is off, so it must not require `enabled`; `flipToIdle` already does not.

---

### Task 5: Full suite and graph refresh

**Files:** none

**Tier:** haiku — run-and-report

- [ ] **Step 1:** `npm run db:up`, then `npm test`. Expected: 0 failures. Report counts and any failing test names verbatim.
- [ ] **Step 2:** `graphify update .`.

---

### Task 6: Final whole-branch review

**Files:** none

**Tier:** opus — concurrency review of the changed anti-raid files

- [ ] **Step 1:** Read-only review of `git diff 6498a3a..HEAD -- src/features/antiraid src/i18n test/features/antiraid-*.test.js` against the Review Focus list. Report findings with file:line; fix anything real in a follow-up commit.

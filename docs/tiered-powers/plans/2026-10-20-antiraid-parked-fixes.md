# Anti-raid Parked Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use tiered-powers:subagent-driven-development (recommended) or tiered-powers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the four anti-raid issues parked in the previous review round (M4 double kick, M5 pause hand-over, M6 blunt `forceIdle`, M9 lost invite flag).

**Architecture:** All four live in `src/features/antiraid/lockdown.js`. M4 adds a per-guild in-memory claim set shared by the two kick paths. M5 and M9 refine how the invite pause is owned and lifted. M6 makes the last-resort `forceIdle` conditional, clearing joins and logging.

**Tech Stack:** Node 22 ESM, discord.js 14, Postgres, `node:test` (`npm test`, tests hit the DB; Postgres already runs in docker).

**Spec:** `docs/tiered-powers/specs/2026-10-19-antiraid-design.md`; prior fixes in `docs/tiered-powers/plans/2026-10-20-antiraid-review-fixes.md`.

## Global Constraints

- Only `src/features/antiraid/lockdown.js` (and `events.js` if needed), `test/features/antiraid-lockdown.test.js` and `docs/memory/gotchas.md` change.
- Do not stage unrelated dirty files: `docs/memory/.obsidian/*`, `test/features/automod-*.test.js`, `AGENTS.md`.
- Commits: no Co-Authored-By trailer; the user's own git identity.
- Work stays on `phase-2`; do not push or merge.
- Run `node --test --test-concurrency=1 test/features/antiraid-*.test.js test/features/help.test.js test/features/panel.test.js` before each commit.
- Existing helpers in `lockdown.js` to reuse: `patchIfCurrent(ctx, guildId, lockedAt, patch)`, `flipToIdle`, `forceIdle`, `pauseIsOurs(guild, lockedUntil)`, `endEmbed`, `using(deps)`; in tests `makeGuild`/`makeMember`.

## Review Focus

- A join kicked by `kickYoungJoin` is never kicked again by a start loop of the same lockdown, and the claims reset between lockdowns.
- A start whose lockdown ended while a newer one began does not remove the newer lockdown's invite pause.
- `forceIdle` never touches an idle or newer-state row, and a force-ended lockdown leaves a log line and an empty join store.
- A lost invite-result write does not leave our pause in place after the lockdown ends.

---

### Task 1: Double kick and pause hand-over (M4, M5)

**Files:**
- Modify: `src/features/antiraid/lockdown.js`
- Test: `test/features/antiraid-lockdown.test.js`

**Tier:** sonnet — concurrency-sensitive, one file, signatures plus behavior

**Interfaces:**
- Produces (internal): `claimKick(guildId: string, userId: string): boolean` returns `false` when `userId` is already claimed for that guild, else claims it and returns `true`; `resetClaims(guildId: string): void`. Backed by a module-level `Map<guildId, Set<userId>>`.

- [ ] **Step 1: Write failing tests** in `antiraid-lockdown.test.js`:
  - `a join kicked by kickYoungJoin is not kicked again by a start loop` (lockdown locked; call `kickYoungJoin` for member `m1` with a counting `run`; then `startLockdown`-style loop path with `m1` among the candidates must not call `run` for `m1`; assert one `run` call for `m1`).
  - `claims reset when a lockdown ends` (kick `m1`, end the lockdown, start a new one with `m1` as candidate, assert `m1` is kicked).
  - `a failed kick releases its claim` (first `run` returns `{ok:false}`; a second attempt for the same user calls `run` again).
  - `start hands the invite pause to a newer lockdown instead of lifting it`: run start A with a `sendLog` hook that calls `endLockdown` and then flips the row to a newer locked state (new `lockedAt`/`lockedUntil`, `inviteResult:'already'`, `invitesPausedByUs:false`) before A's invite-result write; assert A does not call `setIncidentActions` with `invitesDisabledUntil: null` and the newer lock row now has `invitesPausedByUs: true`, `inviteResult: 'paused'`.
  - `start still lifts its pause when no newer lockdown exists` (existing behavior stays; keep the existing test passing).
- [ ] **Step 2:** Run `node --test --test-concurrency=1 test/features/antiraid-lockdown.test.js`. Expected: the new tests FAIL.
- [ ] **Step 3: Implement M4.** Add `claimKick`/`resetClaims`. In `kickCandidate` (start loop) and `kickYoungJoin`, call `claimKick` right before `run`; skip with the existing "not kicked" result when it returns `false`; on a failed or thrown kick release the claim (delete the id). Call `resetClaims(guildId)` in `startLockdown` right after the lock is won and in `endLockdown` right after the flip.
- [ ] **Step 4: Implement M5.** In the place where `startLockdown` finds its lock gone (the invite-result `patchIfCurrent` returns false) and it paused invites: read the current config; if `state === 'locked'` and `lockedAt` differs from this start's, call `patchIfCurrent(ctx, guildId, current.lockedAt, { invitesPausedByUs: true, inviteResult: 'paused' })` and do not lift; otherwise lift as before.
- [ ] **Step 5:** Rerun the file and the antiraid/help/panel set. Expected: all PASS.
- [ ] **Step 6:** Commit `fix(antiraid): never kick a join twice and hand the invite pause to a newer lockdown`.

---

### Task 2: `forceIdle` and the lost invite flag (M6, M9)

**Files:**
- Modify: `src/features/antiraid/lockdown.js`
- Modify: `docs/memory/gotchas.md`
- Test: `test/features/antiraid-lockdown.test.js`

**Tier:** sonnet — same file as Task 1 (run after it); small behavior changes

**Interfaces:**
- Consumes: Task 1's `resetClaims` (call it from the forced end too).
- Produces: `forceIdle(ctx, guildId, deps = {}) -> Promise<boolean>` (true when a locked row was reset); it clears `deps.joins ?? defaultJoins` for the guild and sends a best-effort mod-log line built with `endEmbed(lang, { by: 'timer', actorId: null, kicked, lifted: false })`.

- [ ] **Step 1: Write failing tests:**
  - `forceIdle leaves an idle or other row alone` (idle row stays unchanged; returns false).
  - `forceIdle on a locked row resets it, clears the joins and logs once` (inject `joins` store with entries and a `sendLog` spy).
  - `endJob forces idle on the last attempt and logs` (end throws on attempt MAX_ATTEMPTS; assert row idle and one log call).
  - `a failed invite-result write is retried once` (first `setFeature`/`patchIfCurrent` write throws, the second succeeds; assert `invitesPausedByUs` ends up true).
  - `end lifts a pause that matches our end time even when the flag was lost` (row locked with `invitesPausedByUs:false`, `inviteResult:'none'`, `guild.incidentsData.invitesDisabledUntil` equal to `lockedUntil`; end calls `setIncidentActions` with `invitesDisabledUntil: null`) and `end does not lift a pause that does not match` (different time, no lift).
- [ ] **Step 2:** Run the file. Expected: new tests FAIL.
- [ ] **Step 3: Implement M6.** Change `forceIdle` to add `AND config->>'state' = 'locked'` to its UPDATE, return `rowCount > 0`, and on true clear the joins, `resetClaims`, and best-effort log (try/catch with a warning). Pass `deps` from the two call sites (`startLockdown` undo fallback, `endJob` last attempt).
- [ ] **Step 4: Implement M9.** Wrap the invite-result write in `startLockdown` so a thrown write is retried once (a second throw is logged as now). In `endLockdown`, lift when `was.invitesPausedByUs || (was.inviteResult === 'none' && pauseIsOurs(guild, was.lockedUntil))`, still guarded by `pauseIsOurs`.
- [ ] **Step 5:** In `docs/memory/gotchas.md`, delete the sentence starting `Known, parked:` from the Anti-raid lockdown-guards gotcha (the one about the double kick and the lifted pause); keep the rest of the line.
- [ ] **Step 6:** Rerun the file and the antiraid/help/panel set. Expected: all PASS.
- [ ] **Step 7:** Commit `fix(antiraid): conditional forceIdle with log and recover a lost pause flag` (stage only `lockdown.js`, the test file and `gotchas.md`).

---

### Task 3: Full suite

**Files:** none

**Tier:** haiku — run-and-report

- [ ] **Step 1:** `npm test`. Expected: 0 failures. Report counts and any failing test names verbatim.
- [ ] **Step 2:** `graphify update .`.

---

### Task 4: Final review

**Files:** none

**Tier:** opus — concurrency review

- [ ] **Step 1:** Read-only review of `git diff 52c288e..HEAD -- src/features/antiraid test/features/antiraid-lockdown.test.js docs/memory/gotchas.md` against the Review Focus list. Report findings with file:line and fix anything real in one follow-up commit.

# Anti-raid Handover Patch Throw Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use tiered-powers:subagent-driven-development (recommended) or tiered-powers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop a start from lifting the invite pause of a newer lockdown when the handover record write throws after the pause was already moved.

**Architecture:** In the handover path of `startLockdown` (`src/features/antiraid/lockdown.js`, after commit `3caefe6`), a throw from the `patchIfCurrent` call that records the handover on the newer lockdown B is treated as "handed over" (warn, do not lift). Only a `false` result (B already ended) leads to the lift.

**Tech Stack:** Node 22 ESM, discord.js 14, Postgres, `node:test` (Postgres already runs in docker).

**Spec:** `docs/tiered-powers/plans/2026-10-20-antiraid-parked-fixes.md` (the handover, M5) and the "Known, parked" line in `docs/memory/gotchas.md`.

## Global Constraints

- Only `src/features/antiraid/lockdown.js`, `test/features/antiraid-lockdown.test.js` and `docs/memory/gotchas.md` change.
- Do not stage unrelated dirty files: `docs/memory/.obsidian/*`, `test/features/automod-*.test.js`, `AGENTS.md`.
- Commits: no Co-Authored-By trailer; the user's own git identity. Work stays on `phase-2`; no push or merge.
- Run `node --test --test-concurrency=1 test/features/antiraid-*.test.js test/features/help.test.js test/features/panel.test.js` before committing.

## Review Focus

- A thrown handover patch after a successful move never lifts the pause while B is still locked.
- A patch that returns `false` (B ended) still lifts the moved pause, as before.
- A throw in the move itself (`setIncidentActions`) keeps its current behavior (`failed`, nothing lifted).

---

### Task 1: Treat a throwing handover patch as handed over

**Files:**
- Modify: `src/features/antiraid/lockdown.js` (handover block of `startLockdown`, the `patchIfCurrent` on the newer lockdown, ~lines 417-428)
- Modify: `docs/memory/gotchas.md` (Anti-raid lockdown-guards gotcha)
- Test: `test/features/antiraid-lockdown.test.js`

**Tier:** sonnet — concurrency-sensitive, one block plus one test

**Interfaces:**
- Consumes (existing): `patchIfCurrent(ctx, guildId, lockedAt, patch) -> Promise<boolean>`, `pauseIsOurs(guild, lockedUntil)`, the `handedOver` / `pauseEnd` locals in `startLockdown`.

- [ ] **Step 1: Write the failing test** in `antiraid-lockdown.test.js`, next to the existing handover tests: `a throwing handover patch after a successful move does not lift the newer lockdown's pause`. Set it up like the existing "start hands the invite pause to a newer lockdown" test, but make the DB write that records the handover on B throw (follow the injection pattern of the nearby "retry"/failure tests, e.g. a dep or a `ctx.db.query` wrapper that throws for the `jsonb_set`/`config ||` update targeting B's `lockedAt` only after the move). Assert: `setIncidentActions` was called once with `invitesDisabledUntil` equal to B's `lockedUntil` and never with `invitesDisabledUntil: null`; B's row is still locked.
- [ ] **Step 2:** Run `node --test --test-concurrency=1 test/features/antiraid-lockdown.test.js`. Expected: the new test FAILS (the pause is lifted).
- [ ] **Step 3: Implement.** Wrap only the handover `patchIfCurrent` in its own try/catch: on a throw log a warning and set `handedOver = true` (the pause was moved; B's end or the end job lifts it by time); on `false` keep today's behavior (not handed over, lift via the existing `pauseIsOurs(guild, pauseEnd)` check); on `true` set `handedOver = true` as now. Leave the move's own failure path (`setIncidentActions` throwing → `failed`, nothing lifted) unchanged.
- [ ] **Step 4:** In `docs/memory/gotchas.md` delete the sentence starting `Known, parked: if the patch that records the handover throws` from the Anti-raid lockdown-guards gotcha; keep the rest of the line.
- [ ] **Step 5:** Run the full command from Global Constraints. Expected: all PASS.
- [ ] **Step 6:** Commit `fix(antiraid): a throwing handover patch no longer lifts the newer lockdown's pause` (stage only the three files).

---

### Task 2: Full suite

**Files:** none

**Tier:** haiku — run-and-report

- [ ] **Step 1:** `npm test`. Expected: 0 failures. Report counts and any failing test names verbatim.
- [ ] **Step 2:** `graphify update .`.

---

### Task 3: Final review

**Files:** none

**Tier:** opus — concurrency review

- [ ] **Step 1:** Read-only review of `git diff 3f687d7..HEAD -- src/features/antiraid test/features/antiraid-lockdown.test.js docs/memory/gotchas.md` against the Review Focus list; report findings with file:line and fix anything real in one follow-up commit.

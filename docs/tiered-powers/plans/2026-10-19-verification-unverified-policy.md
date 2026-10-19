# Verification: Unverified-Member Policy Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use tiered-powers:subagent-driven-development (recommended) or tiered-powers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An admin-chosen policy for members who never verify: do nothing, kick after a set time, or warn first and kick later, using the moderation engine's real warn and kick cases.

**Architecture:** Three new settings in the verification config; a `/verification unverified` subcommand to set them; two per-member scheduler jobs (`verification.warn`, `verification.kick`) queued when a human joins; the jobs call `runAction` from the moderation feature. Verifying, leaving, `policy:none` and `/verification remove` cancel the jobs.

**Tech Stack:** Node 22+ ESM, discord.js 14, Postgres, `node:test`, the shared scheduler (`src/core/scheduler.js`), moderation `runAction`.

**Spec:** `docs/tiered-powers/specs/2026-10-19-verification-unverified-policy-design.md` (extends `2026-10-17-verification-design.md`; code in `src/features/verification/`).

## Global Constraints
- Config keys (JSON, merge-written with `setFeature`, never replaced): `unverifiedPolicy` (`'none'|'kick'|'warn_kick'`, default `'none'`), `kickAfterSeconds` (default `86400`), `warnAfterSeconds` (`number|null`, default `null` = half of `kickAfterSeconds`, floored).
- Limits: kick time `600` to `2592000` seconds; for `warn_kick` the warn time must be earlier than the kick time with at least `600` seconds between them. Times are parsed with `parseDuration` and shown with `formatDuration` (`src/core/duration.js`).
- Job types `verification.warn` and `verification.kick`, `key` = the member id, registered through the module's `jobs` export. Each job carries the policy it was queued under; a later policy or time change never touches queued jobs, except `policy:none` and `/verification remove`, which cancel all of them.
- Jobs are queued only for **human** members who join while the feature is enabled and state is `rolling_out`, `active` or `failed`, and policy is not `none`. Members already waiting are never queued.
- Warn and kick are created only through `runAction(ctx, params)` (`src/features/moderation/actions.js`) with `actor: guild.members.me`; no new DM code. A warn is at-most-once. Under `warn_kick` there is no kick unless the warn succeeded.
- Spared at fire time: bots, the guild owner, a member whose highest role is at or above the bot's highest role, and anyone for whom `canManage(db, member)` (`src/core/permissions.js`) is true (bot manager role or Manage Server).
- No retry after a refused kick; one mod-log line (`logVerification` kind `unverified_failed`) says who and why.
- `/verification unverified` is a `/verification` subcommand: `guard(interaction, ctx, 'verification', { requireEnabled: false })`, private reply, works before setup.
- i18n: every user-facing string in `src/i18n/en.json`, `fr.json`, `ar.json` (flat dotted keys, real translations, `{name}` placeholders); parity is enforced by `test/i18n.test.js`.
- Tests: `node --test --test-concurrency=1 test/features/<file>`; full run `npm test` (needs Postgres: `docker compose up -d`). Fakes are inline in each test file; the DB comes from `testDb()` in `test/helpers/db.js`.
- Commits stage explicit files only; never stage `docs/memory/.obsidian/workspace.json`, README.md or `test/features/automod-*.test.js` (unrelated user edits); no `Co-Authored-By` trailer.

## Review Focus
- A member who verifies (button, captcha or manual), leaves, or leaves and rejoins is never warned or kicked by a stale job (cancel on verify and on leave; a rejoin replaces the jobs by key).
- Changing the policy from `kick` to `warn_kick` (or the reverse, or the times) while members are queued does not change what those members get; `policy:none` and `/verification remove` cancel everything.
- A refused or failed warn under `warn_kick` writes one log line and the kick for that member is skipped; a refused kick writes one log line and does not retry.
- Bots, the owner, members above the bot and managers are never warned or kicked, whatever the policy.
- A job firing while the feature is off, state `none` or the policy `none` does nothing; a rerun of the warn job never creates a second case.

## File Structure
All under `src/features/verification/` unless noted.
- `unverified.js` - constants, `effectiveWarnSeconds`, `checkTimes`, `queueUnverifiedJobs`, `cancelMemberJobs`.
- `unverified-commands.js` - `executeUnverified` (the subcommand handler).
- `unverified-jobs.js` - `warnJob`, `kickJob`, `jobs`.
- Modified: `config.js`, `commands-lists.js`, `commands.js`, `events.js`, `verify.js`, `index.js`, `src/i18n/*.json`, docs.
- Tests: `test/features/verification-unverified.test.js`, `verification-unverified-schedule.test.js`, `verification-unverified-jobs.test.js`; `verification-config.test.js` updated.

---

### Task 1: Config, time rules and the `/verification unverified` command

**Files:**
- Create: `src/features/verification/unverified.js` (constants and pure helpers only), `src/features/verification/unverified-commands.js`
- Modify: `src/features/verification/config.js` (`readConfig`), `src/features/verification/commands-lists.js` (`extendWithLists` builder entry and the `listHandlers` map, `listHandlers.unverified = executeUnverified`), `src/features/verification/commands.js` (a policy line in `executeStatus`, between the rollout lines and the lists line), `src/i18n/*.json`
- Test: `test/features/verification-unverified.test.js`; update the `readConfig` shape and subcommand-list assertions in `test/features/verification-config.test.js`

**Tier:** sonnet - several files across an existing pattern (`mode` subcommand), judgment on validation order.

**Interfaces:**
- Produces in `unverified.js`: `POLICIES = ['none','kick','warn_kick']`, `DEFAULT_KICK_SECONDS = 86400`, `KICK_MIN_SECONDS = 600`, `KICK_MAX_SECONDS = 2592000`, `MIN_GAP_SECONDS = 600`, `WARN_JOB = 'verification.warn'`, `KICK_JOB = 'verification.kick'`; `effectiveWarnSeconds(cfg: { kickAfterSeconds: number, warnAfterSeconds: number|null }): number` (= `warnAfterSeconds ?? Math.floor(kickAfterSeconds / 2)`); `checkTimes({ policy, kickAfterSeconds, warnAfterSeconds }): { ok: true } | { ok: false, reason: 'kick_range' | 'warn_gap' }` (`kick_range` when kick is outside `[600, 2592000]`; `warn_gap` only for `warn_kick`, when `effectiveWarnSeconds` is not at least 600 below `kickAfterSeconds`).
- `readConfig(raw)` additionally returns `unverifiedPolicy`, `kickAfterSeconds`, `warnAfterSeconds` (bad or missing values fall back to `'none'`, `86400`, `null`; seconds must be positive finite numbers).
- Produces `executeUnverified(interaction, ctx): Promise<void>`. Command shape: `/verification unverified policy:<none|kick|warn_kick> [kick_after:<string>] [warn_after:<string>]`.
- Consumes: `guard`, `ephemeral`, `getString` pattern and `setFeature` exactly as `executeMode` in `commands-lists.js` does; `parseDuration`, `formatDuration`; `cancelJobs` (`src/core/scheduler.js`).

- [ ] **Step 1: Write the failing tests** in `verification-unverified.test.js`: `readConfig defaults the three keys`, `readConfig rejects a bad policy and non-positive seconds`, `checkTimes accepts 24h kick and 12h default warn`, `checkTimes rejects a 5 minute kick as kick_range and a 31 day kick as kick_range`, `checkTimes rejects warn 23h55m against kick 24h as warn_gap but only for warn_kick`, `the subcommand saves policy and merges kickAfterSeconds without dropping other config keys` (seed `grantDone: true`, assert it survives), `bad_duration reply and nothing saved for kick_after:abc`, `kick_range reply and nothing saved`, `warn_gap reply and nothing saved for warn_kick`, `policy none is saved even with the times omitted`, `status shows the policy line`. Fakes as in `verification-commands.test.js`.
- [ ] **Step 2: Run** `node --test --test-concurrency=1 test/features/verification-unverified.test.js`. Expected: FAIL.
- [ ] **Step 3: Implement** `unverified.js`, the `readConfig` additions, `executeUnverified` (guard, parse the provided durations first and reply `verification.unverified.bad_duration` on `null`, merge with the saved values, run `checkTimes` and reply `verification.unverified.kick_range` / `.warn_gap`, then `setFeature` merge-write only the keys that apply: always `unverifiedPolicy`, plus `kickAfterSeconds` / `warnAfterSeconds` when given; reply `verification.unverified.saved` with the formatted times), the builder entry and the status line (`verification.status.unverified`). Add `verification.cmd.unverified`, `verification.unverified.saved|bad_duration|kick_range|warn_gap` and `verification.status.unverified` to the three i18n files with real translations. Cancelling queued jobs for `policy:none` is added in Task 2.
- [ ] **Step 4: Run** the new file, `test/features/verification-config.test.js`, `test/features/verification-commands.test.js`, `test/i18n.test.js`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(verification): unverified policy settings and command`.

### Task 2: Queue jobs on join, cancel on verify, leave, `none` and remove

**Files:**
- Modify: `src/features/verification/unverified.js` (add `queueUnverifiedJobs`, `cancelMemberJobs`), `src/features/verification/events.js` (`onMemberAdd` for humans; new `GuildMemberLeave` handler `Events.GuildMemberRemove` appended to the events array), `src/features/verification/verify.js` (after the role is added and the log call, before `return { ok: true }`, inside its own try/catch), `src/features/verification/unverified-commands.js` (cancel all on `policy:none`), `src/features/verification/commands.js` (`runRemove`, next to the existing `cancelJobs` calls)
- Test: `test/features/verification-unverified-schedule.test.js`

**Tier:** sonnet - touches four existing handlers; scheduler semantics matter.

**Interfaces:**
- Consumes: Task 1's constants; `scheduleJob(db, { guildId, type, key, payload, dueAt })` and `cancelJobs(db, { guildId, type, key? })` (`src/core/scheduler.js`; one job per `(guild, type, key)`); `runningConfig` in `events.js`.
- Produces: `queueUnverifiedJobs(ctx, member, cfg, now = Date.now()): Promise<void>` - for `kick` queues one `KICK_JOB`; for `warn_kick` queues `WARN_JOB` (due `joined + effectiveWarnSeconds`) and `KICK_JOB` (due `joined + kickAfterSeconds`); `joined = member.joinedTimestamp ?? now`, `dueAt` never earlier than `now`. Payloads: warn `{ policy: 'warn_kick', kickAt }`; kick `{ policy, kickAt }` where `kickAt` is the kick `dueAt` in epoch ms. `cancelMemberJobs(db, guildId, userId): Promise<void>` cancels both types for that key.

- [ ] **Step 1: Write the failing tests:** `a joining human is queued for kick under policy kick`, `a joining human gets warn and kick jobs under warn_kick with kickAt in both payloads`, `policy none queues nothing`, `a joining bot is never queued`, `nothing is queued when state is none or the feature is off`, `a rejoin replaces the jobs (same key)`, `successful verifyMember cancels that member's jobs and a failed one does not`, `GuildMemberRemove cancels the member's jobs`, `policy none cancels all queued warn and kick jobs`, `/verification remove cancels all queued warn and kick jobs`, `changing kick to warn_kick leaves queued jobs untouched`. Assert against the real scheduler table via `testDb()`.
- [ ] **Step 2: Run** the file. Expected: FAIL.
- [ ] **Step 3: Implement** the two helpers and wire them: humans in `onMemberAdd` (keep the bot branch unchanged), the new events entry, the `verifyMember` hook (a cancel failure must never turn a successful verification into an error), `policy none`, `runRemove` (no key, so all keys of both types).
- [ ] **Step 4: Run** the file, `verification-events.test.js`, `verification-verify.test.js`, `verification-commands.test.js`, `test/core/loader.test.js`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(verification): queue and cancel unverified-member jobs`.

### Task 3: The warn and kick jobs

**Files:**
- Create: `src/features/verification/unverified-jobs.js`
- Modify: `src/features/verification/index.js` (export `jobs` as the merge of the rollout jobs and these two; duplicate names throw in the loader), `src/i18n/*.json`
- Test: `test/features/verification-unverified-jobs.test.js`

**Tier:** opus - kicks real members; moderation engine, scheduler, at-most-once and exemptions all meet here.

**Interfaces:**
- Consumes: `runAction` (`src/features/moderation/actions.js`; returns `{ ok: true, modCase, warnings }` or `{ ok: false, reason }`), moderation `readConfig as readModConfig` from `src/features/moderation/config.js` applied to `getFeature(ctx.db, guildId, 'moderation').config`, `canManage` (`src/core/permissions.js`), `readConfig` and `RUNNING` states (`config.js` / `events.js`), `logVerification`, `scheduleJob`/`cancelJobs`, `getLang`, `t`, `formatDuration`.
- Produces: `warnJob(ctx, job, deps?)`, `kickJob(ctx, job, deps?)` (scheduler handler shape `async (ctx, job)`: throw to retry, return when permanent) and `export const jobs = { [WARN_JOB]: warnJob, [KICK_JOB]: kickJob }`. Optional `deps = { runAction, logVerification, now }` for tests.
- Behaviour (shared checks, any failure returns without action): guild in cache (missing: return), feature enabled, state in `rolling_out|active|failed`, `unverifiedPolicy !== 'none'`, member fetched (error code 10007 or not found: return; other errors: throw), member not a bot, member does not hold `cfg.roleId`, member not spared (owner, highest role at or above the bot's, `canManage`).
- **warnJob** (queued policy `warn_kick` only): first claim the warn by cancelling its own job row (`cancelJobs` type `WARN_JOB`, key = member id), then call `runAction` with `type: 'warn'`, a reason from `verification.unverified.warn_reason` (tells the person to verify in `<#cfg.channelId>` within `formatDuration` of the time left until `payload.kickAt`), `actor: guild.members.me`, `target: member`, `config: modConfig`, `lang`. Any throw from the engine counts as a failed warn. Then always reschedule the member's `KICK_JOB` with the same `kickAt` as `dueAt` and `payload: { policy, kickAt, warned: 'ok' | 'failed' }`; on a failed warn also write one `unverified_failed` log line with the reason.
- **kickJob**: when the queued policy is `warn_kick` and `payload.warned !== 'ok'`, do not kick (write one `unverified_failed` line only when `warned` is undefined, meaning the warn never ran). Otherwise `runAction` with `type: 'kick'`, reason from `verification.unverified.kick_reason` (`{time}` = `formatDuration` of the kick time since joining, from the saved `kickAfterSeconds`). `{ ok: false }` with reason `not_in_server`: return quietly; any other refusal: one `unverified_failed` line with the reason code, no retry. A thrown error is rethrown so the scheduler retries.
- Add `verification.unverified.warn_reason`, `verification.unverified.kick_reason` and `verification.log.unverified_failed` to the three i18n files with real translations.

- [ ] **Step 1: Write the failing tests** (fake guild, member, `runAction` capturing calls, the real scheduler table): `warn job warns with the bot as actor and a reason naming the verify channel`, `warn job reschedules the kick job with warned ok at the same kickAt`, `a refused warn logs once and marks warned failed so the kick is skipped`, `a thrown warn is treated as failed and a second run of the warn job does not warn again`, `kick job kicks a member who is still unverified after a warn`, `kick job under policy kick kicks without a warn`, `kick job under warn_kick with warned undefined does not kick and logs once`, `a refused kick logs unverified_failed once and does not reschedule`, `a bot, the owner, a member above the bot and a manager are never warned or kicked`, `a member who verified or left does nothing`, `feature off, state none or policy none does nothing`, `a policy change after queueing still uses the queued policy`, `member fetch 10007 returns quietly and another fetch error throws`.
- [ ] **Step 2: Run** `node --test --test-concurrency=1 test/features/verification-unverified-jobs.test.js`. Expected: FAIL.
- [ ] **Step 3: Implement** `unverified-jobs.js` and the `index.js` merge as described.
- [ ] **Step 4: Run** the new file, `verification-unverified-schedule.test.js`, `test/core/loader.test.js`, `test/i18n.test.js`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(verification): warn and kick jobs for unverified members`.

### Task 4: Docs and memory notes

**Files:**
- Modify: `docs/testing-checklist.md` (add steps to the existing Verification section), `docs/discord-bot-setup.md` (the Verification bullet: the bot also needs Kick Members for this policy), `docs/memory/` (features-built, architecture, decisions, gotchas, roadmap, index as needed)

**Tier:** sonnet - documentation that must match the code.

- [ ] **Step 1:** Checklist steps: set `policy:kick` and `policy:warn_kick` with times; refusals for a 5 minute kick and a warn too close to the kick; a new member who never verifies is warned (case, mod-log line, DM) then kicked with the reason; a member who verifies before the deadline is left alone; a member who leaves and rejoins gets a fresh clock; bots, the owner, a manager and a member above the bot are spared; `policy:none` and `/verification remove` stop everything; changing the policy does not touch members already queued; a failed kick (take Kick Members from the bot) writes one mod-log line; `/verification status` shows the policy.
- [ ] **Step 2:** Memory notes from the code: files, job types `verification.warn` and `verification.kick`, the three config keys, the at-most-once warn and the `warned` hand-off to the kick job, no retry after a refused kick, and a decision note that this reverses the earlier non-goal "kicking people who never verify". Record only what is true in the code. Keep each file's line endings.
- [ ] **Step 3: Commit** `docs: unverified policy notes and test checklist`.

### Task 5: Full verification run

**Files:** none

**Tier:** haiku - run and report.

- [ ] **Step 1: Run** the command below. Expected: all pass; report the totals and any failure with its output (do not fix).

```bash
npm test
```

- [ ] **Step 2: Run** the command below and report whether it succeeded.

```bash
graphify update .
```

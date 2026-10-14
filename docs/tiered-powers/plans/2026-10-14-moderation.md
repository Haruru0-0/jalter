# Moderation (cases, commands, timed actions) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use tiered-powers:subagent-driven-development (recommended) or tiered-powers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** YAGPDB-style moderation for Jalter: warn, warnings manager, timeout, mute, kick, ban, unban and `/reason`, with numbered cases, a mod log, DMs, per-server settings and timed bans and mutes.

**Architecture:** A new feature `src/features/moderation/`: a case store (`mod_cases` plus a per-guild counter), pure config and permission rules, an action engine (`runAction`) that checks, DMs, calls Discord, records a case, schedules expiry and logs, command files on top of the engine, and scheduler job handlers for timed unban and unmute. The mod log goes through the logging feature's `sendLog` (changed to return where it posted) under a hidden `modAction` event in the `mod` category.

**Tech Stack:** Node 22 ESM, discord.js 14.27, Postgres, `node --test` with the real test DB (`testDb()`), the shared scheduler in `src/core/scheduler.js`.

**Spec:** `docs/tiered-powers/specs/2026-10-14-moderation-design.md` (read it, including "Calls I made after the builder check"; this plan implements it).

## Global Constraints

- Node 22, ESM, discord.js 14, Postgres; `npm test` (`--test-concurrency=1`; run `npm run db:up` first); no new dependencies.
- Follow existing feature structure: `commands` and `events` exports, plus `jobs` (type to handler) for scheduler handlers; `guard()` for enabled and permission checks; `getFeature`/`setFeature` (shallow merge: write whole nested values); ephemeral replies for settings and refusals.
- Feature key `moderation`, off by default. Action commands need it on; `/moderation` settings need Manage Server or the bot manager role (`guard` default).
- All user-facing text in `src/i18n/en.json`, `fr.json`, `ar.json` (flat dotted keys, `{name}` placeholders; `test/i18n.test.js` enforces parity). Slash option choices max 25, descriptions 1 to 100 characters.
- Scheduler job types `mod.unban` and `mod.unmute`, key = the target user id, payload `{ userId }`; handlers return on permanent Discord errors (HTTP 4xx except 429) and throw on transient ones; they run even if the feature was switched off since.
- Durations: parse with the shared duration helper (Task 1); minimum 1 minute (60 s); timeout maximum 28 days (2 419 200 s); ban and mute have no maximum.
- Moderation permissions by action: warn, warnings management, timeout, untimeout, mute, unmute, `/reason` need `ModerateMembers`; kick needs `KickMembers`; ban and unban need `BanMembers`; a member with a configured permitted role may use all of them. Commands are registered with no default member permission and checked in code.
- Commit after each task; run `npm test` before each commit. Commit messages carry no `Co-Authored-By` or Claude attribution lines; do not change git identity.
- Migrations are numbered SQL files in `src/db/migrations/` (next free number: `006`).

## Review Focus

- A moderator cannot act on the server owner, themselves, a member at or above their own highest role, or a member at or above the bot's highest role; the reply says why and nothing happens (no Discord call, no case).
- Discord refuses the action (missing bot permission, hierarchy): the moderator is told, no case is created and no case number is consumed.
- Two actions at the same moment get distinct, consecutive case numbers.
- A timed ban or mute survives a restart (job in the database), is replaced by a newer timed action on the same user, and is cancelled by a manual `/unban` or `/unmute`; the expiry handler is idempotent.
- Closed DMs, logging switched off, or no `mod` log channel never fail or undo the action.
- `/ban` and `/unban` work for a user ID of someone not in the server; `/ban` on an already banned user and `/mute` on an already muted user are refused.
- A member (not a moderator) can list their own warnings and nothing else; a permitted-role holder can moderate without the Discord permission but cannot change `/moderation` settings.

---

### Task 1: Move the duration helper to core

**Files:**
- Modify: `src/features/autorole/index.js` (import path), `test/features/autorole-duration.test.js` (import path)
- Move: `src/features/autorole/duration.js` to `src/core/duration.js`

**Tier:** haiku — a mechanical move with an exact expected result.

**Interfaces:**
- Produces: `src/core/duration.js` exporting exactly what `src/features/autorole/duration.js` exports today (`MIN_DELAY`, `MAX_DELAY`, `parseDuration`, `formatDuration`), unchanged.

```bash
git mv src/features/autorole/duration.js src/core/duration.js
git mv test/features/autorole-duration.test.js test/core/duration.test.js
```

- [ ] **Step 1:** `git mv src/features/autorole/duration.js src/core/duration.js`; update the import in `src/features/autorole/index.js` to `../../core/duration.js` and in `test/features/autorole-duration.test.js` to `../../src/core/duration.js`. Move the test to `test/core/duration.test.js` (`git mv`, fix its import to `../../src/core/duration.js`).
- [ ] **Step 2:** `grep -rn "autorole/duration" src test` returns nothing; run `npm test` — expect all green with the same test count.
- [ ] **Step 3: Commit** `refactor: move the duration helper to core`.

---

### Task 2: Case store and migration

**Files:**
- Create: `src/db/migrations/006_mod_cases.sql`, `src/features/moderation/store.js`
- Modify: `src/db/index.js` (add `mod_cases, mod_counters` to the `resetDb` TRUNCATE list)
- Test: `test/features/moderation-store.test.js`

**Tier:** sonnet — atomic numbering and state queries; concurrency matters.

**Interfaces:**
- Tables: `mod_counters(guild_id TEXT PRIMARY KEY, last_number INTEGER NOT NULL)`; `mod_cases(guild_id, number INTEGER, type TEXT, target_id TEXT, moderator_id TEXT, reason TEXT, duration_ms BIGINT, ends_at TIMESTAMPTZ, created_at TIMESTAMPTZ DEFAULT now(), active BOOLEAN DEFAULT true, log_channel_id TEXT, log_message_id TEXT, PRIMARY KEY (guild_id, number))` with an index on `(guild_id, target_id)`.
- Produces (`store.js`, `db` first, times in ms since epoch; `ModCase = { guildId, number, type, targetId, moderatorId, reason, durationMs, endsAt, createdAt, active, logChannelId, logMessageId }`, `type` one of `warn timeout untimeout mute unmute kick ban unban`):
  - `createCase(db, { guildId, type, targetId, moderatorId, reason, durationMs = null, endsAt = null }): Promise<ModCase>` — number allocated atomically from `mod_counters` in the same transaction as the insert.
  - `getCase(db, guildId, number): Promise<ModCase | null>`
  - `setCaseLog(db, guildId, number, { channelId, messageId }): Promise<void>`
  - `setCaseReason(db, guildId, number, reason): Promise<boolean>` (false when no such case)
  - `listWarnings(db, guildId, userId): Promise<ModCase[]>` — active `warn` cases, oldest first.
  - `editWarning(db, guildId, number, reason): Promise<boolean>` and `deactivateWarning(db, guildId, number): Promise<boolean>` — only an active warn case; false otherwise.
  - `clearWarnings(db, guildId, userId): Promise<number>` — deactivates all active warns of the user, returns the count.
  - `topWarnings(db, guildId, limit = 10): Promise<{ userId: string, count: number }[]>` — active warns, highest count first.
  - `isCurrentlyMuted(db, guildId, userId, nowMs): Promise<boolean>` — the user's latest `mute` or `unmute` case is a `mute` whose `endsAt` is null or after `nowMs`.

- [ ] **Step 1: Write the failing tests** (`beforeEach` truncates the two tables): `case numbers are per guild and consecutive starting at 1`; `ten concurrent createCase calls give ten distinct consecutive numbers`; `getCase returns null for an unknown number`; `setCaseLog and setCaseReason persist, setCaseReason on a missing case is false`; `listWarnings returns only active warns of that user in order`; `editWarning and deactivateWarning refuse non-warn and already inactive cases`; `clearWarnings deactivates all and returns the count`; `topWarnings ranks by active count and honours limit`; `isCurrentlyMuted` across: mute without end, mute then unmute, expired timed mute, timed mute still running, no cases.
- [ ] **Step 2: Run** `node --test test/features/moderation-store.test.js` — expect FAIL.
- [ ] **Step 3: Implement** the migration, `store.js` and the `resetDb` change.
- [ ] **Step 4: Run** the test file, then `npm test` — expect PASS.
- [ ] **Step 5: Commit** `feat(moderation): case store and numbering`.

---

### Task 3: Logging returns where it posted, plus the hidden mod event

**Files:**
- Modify: `src/features/logging/send-log.js`, `src/features/logging/events.js`, `src/features/logging/config.js`
- Test: `test/features/logging.test.js` (extend), `test/features/logging-config.test.js` (extend)

**Tier:** sonnet — touches a shared contract used by every logging handler.

**Interfaces:**
- Produces:
  - `sendLog(ctx, guildId, event, embed, opts = {}): Promise<{ channelId: string, messageId: string } | null>` — the same behavior as today, returning where the message landed, or `null` when nothing was posted or on any error. Existing callers ignore the result.
  - `events.js`: `export const HIDDEN_EVENTS = { modAction: 'mod' }` and `export function categoryOf(event): string | undefined` returning `EVENTS[event] ?? HIDDEN_EVENTS[event]`. `EVENTS` stays at 24 entries, so `/logging event` choices and the `all` toggle do not include `modAction`.
  - `resolveChannelId` uses `categoryOf` (`modAction` resolves `channels.mod`, else `channels.default`, else null).
  - `trySend` (`src/core/send.js`) already returns the sent message (or `null`), so `sendLog` returns `{ channelId: message.channelId, messageId: message.id }` from it.

- [ ] **Step 1: Write the failing tests:** `sendLog returns channelId and messageId of the posted message`; `sendLog returns null when logging is off, the event is disabled, no channel resolves, or sending fails`; `modAction resolves the mod channel then default and is not listed in EVENTS or disabledEvents validation`; `the catalog still has 24 events and the event option still has 25 choices`.
- [ ] **Step 2: Run** the two test files — expect FAIL.
- [ ] **Step 3: Implement** the changes above.
- [ ] **Step 4: Run** `npm test` — expect PASS.
- [ ] **Step 5: Commit** `feat(logging): sendLog reports where it posted; hidden modAction event`.

---

### Task 4: Moderation config and rules

**Files:**
- Create: `src/features/moderation/config.js`, `src/features/moderation/rules.js`
- Test: `test/features/moderation-config.test.js`, `test/features/moderation-rules.test.js`

**Tier:** sonnet — permission and hierarchy logic is the security core; reviewed on opus.

**Interfaces:**
- Produces (`config.js`):
  - `DEFAULTS = { reasonRequired: true, dm: true, timeoutDefaultSeconds: 600, banDeleteDays: 0, muteRoleId: null, permittedRoles: [] }`, `MAX_PERMITTED = 10`.
  - `readConfig(raw): Config` — fills defaults, drops invalid values (wrong types, `banDeleteDays` outside 0 to 7, `timeoutDefaultSeconds` outside 60 to 2 419 200, non-array roles), caps and de-duplicates `permittedRoles`.
  - `addPermittedRole(config, roleId): { ok: true, config } | { ok: false, reason: 'exists' | 'full' }`, `removePermittedRole(config, roleId): { ok: true, config } | { ok: false, reason: 'missing' }` (new objects, same style as `src/features/autorole/config.js`).
- Produces (`rules.js`):
  - `ACTION_PERMISSIONS = { warn: 'ModerateMembers', warnings: 'ModerateMembers', timeout: 'ModerateMembers', untimeout: 'ModerateMembers', mute: 'ModerateMembers', unmute: 'ModerateMembers', reason: 'ModerateMembers', kick: 'KickMembers', ban: 'BanMembers', unban: 'BanMembers' }`.
  - `canUseAction(member, action, config): boolean` — true when `member.permissions.has(ACTION_PERMISSIONS[action])` or the member has any `config.permittedRoles` role in `member.roles.cache`; false for an unknown action.
  - `checkTarget({ guild, actor, target, targetId, botMember }): { ok: true } | { ok: false, reason: 'owner' | 'self' | 'bot_self' | 'actor_hierarchy' | 'bot_hierarchy' }` — `target` is the `GuildMember` or `null` when the user is not in the server (then only `owner`, `self` and `bot_self` can refuse). Hierarchy compares `roles.highest.position`: refuse when target is at or above the actor (unless the actor is the guild owner) and when at or above the bot.
  - `checkDuration(action, seconds | null): { ok: true } | { ok: false, reason: 'too_short' | 'too_long' }` — 60 s minimum for any given duration; `timeout` maximum 2 419 200 s; `null` is always ok.

- [ ] **Step 1: Write the failing tests:** config: defaults on empty input; invalid values replaced by defaults; permitted role add twice is `exists`, the 11th is `full`, remove of an absent role is `missing`. Rules: `canUseAction` for Discord permission, permitted role, neither, unknown action; `checkTarget` for owner, self, the bot itself, equal role, higher role, target above the bot, actor is owner and may act on a higher-role member (but not on the bot-above or owner), target not in server (`null`) is ok for ban/unban cases; `checkDuration` for 59 s, 60 s, 28 d, 28 d + 1 s on timeout, long ban ok. Use small fake guild/member objects (`roles.highest.position`, `id`, `permissions.has`).
- [ ] **Step 2: Run** the two test files — expect FAIL.
- [ ] **Step 3: Implement** both files.
- [ ] **Step 4: Run** `npm test` — expect PASS.
- [ ] **Step 5: Commit** `feat(moderation): config and permission rules`.

---

### Task 5: Action engine, expiry jobs and rejoin mute

**Files:**
- Create: `src/features/moderation/actions.js`, `src/features/moderation/format.js`
- Modify: `src/i18n/{en,fr,ar}.json`
- Test: `test/features/moderation-actions.test.js`

**Tier:** sonnet — the core flow with many failure paths; reviewed on opus.

**Interfaces:**
- Consumes: Task 2 store, Task 3 `sendLog`, Task 4 config and rules, `scheduleJob` and `cancelJobs` from `src/core/scheduler.js`, `parseDuration`/`formatDuration` (Task 1).
- Produces (`format.js`): `formatCase(modCase, lang): embed` (title `Case #N: <type>`, fields target, moderator, reason, duration when present; mentions as `<@id>`), and `dmText(lang, type, { guildName, reason, durationSeconds, caseNumber }): string`.
- Produces (`actions.js`):
  - `runAction(ctx, params): Promise<{ ok: true, modCase: ModCase, warnings: string[] } | { ok: false, reason: string }>` where `params = { guild, actor, type, targetId, target, reason, durationSeconds = null, deleteDays = null, config, lang }` and `type` is one of `warn timeout untimeout mute unmute kick ban unban`. `reason` on failure is an i18n key suffix under `moderation.err.` (for example `owner`, `self`, `bot_self`, `actor_hierarchy`, `bot_hierarchy`, `reason_required`, `no_mute_role`, `already_banned`, `already_muted`, `not_banned`, `not_in_server`, `too_short`, `too_long`, `discord_refused`). `warnings` carries non-fatal notes (`dm_failed`, `case_not_saved`, `log_failed`).
  - Order: reason-required check (punishments warn, timeout, mute, kick, ban only), `checkTarget` and `checkDuration`, state checks (`already_banned` via `guild.bans.fetch`, `already_muted` via `isCurrentlyMuted`, `no_mute_role` when the role is unset or no longer in the guild), DM (best effort, only when `config.dm` and the target is a member; for kick and ban before the action), the Discord action (`member.timeout(ms)` / `member.timeout(null)`, `member.roles.add|remove(muteRoleId)`, `member.kick`, `guild.members.ban(id, { deleteMessageSeconds, reason })` with `deleteDays ?? config.banDeleteDays`, `guild.members.unban(id, reason)`; a thrown Discord error becomes `discord_refused` with no case), `createCase` (a failure becomes the `case_not_saved` warning), scheduling (`ban` and `mute` with a duration: `scheduleJob` type `mod.unban` or `mod.unmute`, key = target id, payload `{ userId }`, replacing any pending one; a manual `unban` or `unmute` calls `cancelJobs` for that key; `warn` has no Discord action), then `sendLog(ctx, guild.id, 'modAction', formatCase(...))` and `setCaseLog` with the returned location. DM, log and scheduling problems never fail the action.
  - Job handlers `jobs = { 'mod.unban': expireBan, 'mod.unmute': expireMute }` (`expireBan(ctx, job)`, `expireMute(ctx, job)`): act via the same Discord calls, create an `unban`/`unmute` case with `moderatorId` = the bot's user id and reason `Timed action expired` (localized by the guild language), log it; idempotent (not banned or no longer muted: just return); permanent Discord errors return after a warning, transient ones throw.
  - `reapplyMute(ctx, member)` for `GuildMemberAdd`: if the feature is enabled and `isCurrentlyMuted`, add the mute role (errors warn and return). Exported as `events = [{ name: Events.GuildMemberAdd, execute: reapplyMute }]` wrapped like other handlers (never throws).

- [ ] **Step 1: Write the failing tests** with fake guild, member and `sendLog` collaborators (the real test DB for cases and jobs): each refusal reason leaves no case and makes no Discord call; reason required only for punishments and relaxed by config; successful `warn`, `timeout`, `kick`, `ban` (with delete days), `unban`, `mute`, `unmute` create the right case and call the right Discord method; a Discord error gives `discord_refused` and consumes no case number; closed DMs (DM throws) still succeed with a `dm_failed` warning; `ban` with a duration schedules `mod.unban` and a second timed ban replaces it; manual `unban` cancels it; `expireBan` unbans, writes a bot-authored case and is a no-op the second time; `expireMute` removes the role and finishes quietly when the member or role is gone; a 403 from the Discord call finishes the job, a 500 throws; `reapplyMute` re-adds the role for a muted rejoiner and does nothing when not muted or the feature is off; logging switched off does not fail the action; the mod log location is stored on the case.
- [ ] **Step 2: Run** `node --test test/features/moderation-actions.test.js` — expect FAIL.
- [ ] **Step 3: Implement** `actions.js` and `format.js`; add every `moderation.err.*`, DM and case-embed i18n key in en, fr and ar.
- [ ] **Step 4: Run** `npm test` — expect PASS.
- [ ] **Step 5: Commit** `feat(moderation): action engine, timed expiry and rejoin mute`.

---

### Task 6: Punishment and undo commands

**Files:**
- Create: `src/features/moderation/commands-actions.js`
- Modify: `src/i18n/{en,fr,ar}.json`
- Test: `test/features/moderation-commands-actions.test.js`

**Tier:** sonnet — slash builders plus thin execute functions over the engine.

**Interfaces:**
- Consumes: Task 5 `runAction`, Task 4 `canUseAction` and config.
- Produces: `actionCommands` — an array of `{ data, execute }` for `/warn user reason`, `/timeout user [duration] [reason]`, `/untimeout user [reason]`, `/mute user [duration] [reason]`, `/unmute user [reason]`, `/kick user [reason]`, `/ban user [duration] [delete_days] [reason]` (`delete_days` integer 0 to 7), `/unban user [reason]`. `user` is a user option (mention or ID); `reason` a string up to 400 characters (required only where the command definition makes it so: Discord needs required options first, so `reason` is registered as optional and `reason-required` is enforced by the engine); `duration` a string parsed with `parseDuration` (an unparseable value replies with a localized `moderation.err.bad_duration`). Each `execute`: `guard(interaction, ctx, 'moderation', { requireManager: false })`, `canUseAction` (else the standard not-allowed reply, ephemeral), resolve the target `GuildMember` (fetch, `null` when absent), call `runAction`, then reply: success shows the case number and, for `warn`, the warning id; failure replies with `moderation.err.<reason>`; warnings (`dm_failed`, `case_not_saved`) are appended as short notes. All replies are ephemeral; the mod log carries the public record.

- [ ] **Step 1: Write the failing tests:** structure (names, option order required before optional, descriptions 1 to 100 chars, `delete_days` 0 to 7, no default member permissions set); `execute` with a fake interaction: member without permission or permitted role is refused; permitted-role holder allowed; feature off gives the standard off message; unparseable duration; success reply contains the case number; engine failure reply uses the right key; target not in server for `ban` and `unban` passes `target: null`.
- [ ] **Step 2: Run** the test file — expect FAIL.
- [ ] **Step 3: Implement** the commands and i18n keys (en, fr, ar).
- [ ] **Step 4: Run** `npm test` — expect PASS.
- [ ] **Step 5: Commit** `feat(moderation): warn, timeout, mute, kick, ban and undo commands`.

---

### Task 7: Warnings and reason commands

**Files:**
- Create: `src/features/moderation/commands-warnings.js`
- Modify: `src/i18n/{en,fr,ar}.json`
- Test: `test/features/moderation-commands-warnings.test.js`

**Tier:** sonnet.

**Interfaces:**
- Consumes: Task 2 store, Task 3 `sendLog` result stored on cases, Task 4 `canUseAction`, Task 5 `formatCase`.
- Produces: `warningCommands` — `{ data, execute }` for `/warnings` with subcommands `list [user]`, `edit id reason`, `delete id`, `clear user`, `top`, and for `/reason case reason`.
  - `list`: with no user or the caller's own id, any member may list their own active warnings (ephemeral); a different user needs `canUseAction(member, 'warnings', config)`. Shows case number, date, reason, moderator, up to 25 lines with a "... and N more" tail.
  - `edit`, `delete`, `clear`, `top` need `canUseAction`; they only mutate warn cases (no new case, no mod log post). `top` lists the top 10 active counts. Unknown or inactive ids reply `moderation.err.no_such_warning`.
  - `/reason case reason`: needs `canUseAction(member, 'reason', config)`, reason required non-empty, updates the case, and edits the stored mod log message through `client.channels.fetch(logChannelId)` then `messages.fetch(logMessageId)` then `edit` with `formatCase` of the updated case; any failure to find or edit the message is ignored and the case still updates. Unknown case replies `moderation.err.no_such_case`.
  - All replies ephemeral; guarded by `guard(interaction, ctx, 'moderation', { requireManager: false })`.

- [ ] **Step 1: Write the failing tests:** structure (subcommand names, descriptions, option order); a member lists their own warnings but is refused for another user's; moderator lists, edits, deletes, clears and sees the top list; deleting twice replies no-such-warning; clear returns the count in the reply; `/reason` updates the case and calls `edit` on a fake message, still succeeds when the channel or message fetch throws, and refuses an empty reason and an unknown case; a feature-off guild gets the standard off message.
- [ ] **Step 2: Run** the test file — expect FAIL.
- [ ] **Step 3: Implement** and add i18n keys (en, fr, ar).
- [ ] **Step 4: Run** `npm test` — expect PASS.
- [ ] **Step 5: Commit** `feat(moderation): warnings manager and reason command`.

---

### Task 8: Settings command and wiring

**Files:**
- Create: `src/features/moderation/index.js`
- Modify: `src/core/registry.js` (replace the `moderation` stub), `src/modules.js`, `src/i18n/{en,fr,ar}.json`, `test/features/help.test.js` (it asserts `Coming soon: .*Moderation`), any other test that expects Moderation to be "coming soon" (find with `grep -rn "Moderation" test`)
- Test: `test/features/moderation-settings.test.js`

**Tier:** sonnet — settings command plus registry, loader and help integration.

**Interfaces:**
- Consumes: Tasks 4 to 7.
- Produces (`index.js`): `commands` = `[settings, ...actionCommands, ...warningCommands]`, `events` (from Task 5), `jobs` (from Task 5). Settings command `/moderation` with `toggleSubcommands` (`enable`, `disable`, handled by `handleToggle(interaction, ctx, 'moderation')`), `status`, `reason-required state:on|off`, `dm state:on|off`, `timeout-default duration:<text>`, `ban-delete-days days:0-7`, `mute-role role:<role> [apply:bool]`, `permitted-role-add role:<role>`, `permitted-role-remove role:<role>`. Settings need `guard(interaction, ctx, 'moderation', { requireEnabled: false })` (Manage Server or the bot manager role); each write sends the whole updated config through `setFeature`. `mute-role` with `apply:true` sets, on every channel the bot can manage, a permission overwrite for that role denying SendMessages, AddReactions and Speak, and reports how many channels succeeded and failed; role @everyone, managed roles and roles above the bot are refused.
- Registry: `f('moderation', 2, 'moderation', { commands: ['moderation', 'warn', 'warnings', 'timeout', 'untimeout', 'mute', 'unmute', 'kick', 'ban', 'unban', 'reason'], enableCommand: 'moderation enable' })`. `src/modules.js` imports and lists the new module.

- [ ] **Step 1: Write the failing tests:** structure (subcommands, descriptions, all commands unique across the module); every setting command writes the whole config and `status` shows it; `timeout-default` rejects out-of-range text; `mute-role` refuses @everyone, managed roles and roles above the bot; `permitted-role-add` respects the 10 limit; `apply:true` reports successes and failures with fake channels; `collectModules` over `src/modules.js` has no duplicate command names; `/help feature:moderation` lists all the moderation commands; `/panel overview` no longer lists Moderation as coming soon.
- [ ] **Step 2: Run** the new test file and `npm test` — expect FAIL.
- [ ] **Step 3: Implement** the module, registry and modules wiring, i18n, and fix the existing tests that assumed the stub.
- [ ] **Step 4: Run** `npm test` — expect PASS.
- [ ] **Step 5: Commit** `feat(moderation): settings command and feature wiring`.

---

### Task 9: Documentation and memory notes

**Files:**
- Modify: `README.md`, `docs/discord-bot-setup.md`, `docs/testing-checklist.md`, `docs/tiered-powers/specs/2026-10-14-moderation-design.md` (status line), `docs/tiered-powers/specs/2026-10-14-feature-roadmap.md` (Phase 2 steps 1 and 2 status), `docs/memory/{features-built,architecture,roadmap,decisions,gotchas}.md` (keep `index.md` accurate)

**Tier:** sonnet — prose that must match the real code.

- [ ] **Step 1:** Read the moderation code, then update: README feature list and manual checks; both invite-permission lists gain Kick Members, Ban Members and Moderate Members; the testing checklist gets a "Moderation" section (enable, settings, each command, case numbers, mod log, DMs, timed ban and mute expiring, rejoin while muted, hierarchy refusals, permitted role, warnings visibility); memory notes record the new feature, the case store, the `modAction` hidden event, the `sendLog` return value and that timed actions use `mod.unban` and `mod.unmute`. Link notes with `[[wikilinks]]`; record only what is true in the code.
- [ ] **Step 2: Commit** `docs: moderation notes, invite permissions and test checklist`.

---

### Task 10: Final verification run

**Files:** none changed.

**Tier:** haiku — run-and-report, no decisions.

```bash
npm test
npm run deploy
python -m graphify update .
```

- [ ] **Step 1:** Run `npm test`; report pass/fail counts and the full output of any failure.
- [ ] **Step 2:** Run `npm run deploy` only if `.env` contains a `DISCORD_TOKEN`; report its last lines (it registers the new commands). If the token is missing, say so and skip.
- [ ] **Step 3:** Run `python -m graphify update .`; report the last 5 lines.
- [ ] **Step 4:** Report back; do not fix failures. The manual checks are in `docs/testing-checklist.md` for the owner.

# Verification Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use tiered-powers:subagent-driven-development (recommended) or tiered-powers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Verified-role gate: newcomers see only a verify channel and the public channels (read-only), and unlock the server with a button or an image captcha; existing members are grandfathered; the permission changes are undoable.

**Architecture:** A pure planner computes the exact permission overwrites each channel needs; an applier writes them and records the originals for undo; two restart-safe scheduler jobs roll out in a fixed order (grant everyone Verified, then gate channels). Stage 1 (Tasks 1-10) is a complete button-mode system; Stage 2 (Tasks 11-12) adds the captcha, reusing the `@napi-rs/canvas` and Noto fonts already in `package.json`.

**Tech Stack:** Node 22+ ESM, discord.js 14, Postgres, `node:test`, `@napi-rs/canvas` (existing).

**Spec:** `docs/tiered-powers/specs/2026-10-17-verification-design.md`

## Global Constraints
- Feature key `verification`, folder `src/features/verification/`, off by default; all commands under `/verification`, registered without default member permissions and checked with `guard(interaction, ctx, 'verification')` (manager); replies ephemeral. Public notices only where stated.
- One component prefix for the whole feature: `verification`. CustomIds: `verification:go` (verify button), `verification:enter:<userId>` (captcha enter button), `verification:code:<userId>` (captcha modal), `verification:setup:ok:<userId>:<createdAt>` and `verification:setup:no:<userId>` (setup confirm; valid 2 minutes, only for that admin).
- Verified role: created with no permissions, named "Verified" (localized), no colour, not hoisted, not mentionable. It must sit below the bot's top role (`botCanGive` from `src/core/role-safety.js`).
- Gate bits (names from `PermissionFlagsBits`): `SEND_BITS = SendMessages, SendMessagesInThreads, CreatePublicThreads, CreatePrivateThreads, AddReactions, UseApplicationCommands`. Voice/stage in the public list additionally deny `Connect, Speak`. No other bit is ever changed; other roles' and members' overwrites are never touched (the bot's own member overwrite on the verify channel is the one addition).
- "`@everyone` can view" = the computed `@everyone` permission alone: guild-level `@everyone` ViewChannel bit adjusted by the channel's `@everyone` overwrite. Channels where it is false are left untouched.
- Setup states: `none`, `rolling_out`, `active`, `failed`. Rollout order is fixed: create role/channel/message, then grant Verified to every member present at Confirm (bots included), then gate channels, then `active`. Never gate before granting is finished.
- Undo record: the first recorded original per channel wins and is never overwritten; a missing overwrite is recorded as `existed: false`.
- Captcha (Stage 2): 5 characters from `ABCDEFGHJKMNPQRSTUVWXYZ23456789`, case-insensitive entry, valid 5 minutes, single use, in memory; 3 wrong entries then a 30-second cooldown, then a new code. The captcha is **always in English**, whatever the server language: the image uses only Latin letters and digits, and every message, button and modal text in the captcha flow comes from fixed English strings (`verification.captcha.*` keys exist in all three i18n files with the same English text, so parity holds and nothing is translated).
- Mod log: one line through `sendLog(ctx, guildId, 'modAction', embed)` for setup confirmed, rollout finished/failed, member verified, manual verify/unverify, undo, and a failed gate of a new channel. Failed captcha attempts are not logged.
- i18n: every user-facing string in `src/i18n/en.json`, `fr.json`, `ar.json` (flat dotted keys under `verification.`, real translations, `{name}` placeholders); parity is enforced by `test/i18n.test.js`.
- Bot permissions checked at setup: Manage Roles, Manage Channels, View Channel, Send Messages, Embed Links, Attach Files. Missing one refuses with a localized reply.
- Tests: `node --test --test-concurrency=1 test/features/<file>`; full run `npm test`. Fakes are built inline in each test file; the DB comes from `testDb()` in `test/helpers/db.js`.
- Commits stage explicit files only; never stage `README.md`; no `Co-Authored-By` trailer.

## Review Focus
- An unverified member cannot see any gated channel and cannot send, react, thread or use commands in a public or the verify channel (planner tests with real bit math).
- A channel `@everyone` cannot view today is untouched, so Verified never opens a private channel; a channel where another role has an explicit View allow is reported in the preview.
- A restart or crash mid-rollout, and a second run of either rollout job, change nothing twice and never gate before the grant is finished.
- Verify clicked twice, by an already-verified member, after the member left, with the role deleted or above the bot, or while verification is disabled: a private answer, no crash, no duplicate log.
- Setup with a missing bot permission, with the role already existing, or run twice: refused or idempotent with a clear reply.

## File Structure
All under `src/features/verification/` unless noted.
- `config.js` - `readConfig`, defaults, list mutators.
- `store.js` - undo records (migration `src/db/migrations/008_verification_overwrites.sql`).
- `plan.js` - pure permission planner.
- `apply.js` - applies/reverts a planned overwrite on a real channel.
- `log.js` - mod log helper.
- `verify.js` - `verifyMember`, the verify message, the button handler.
- `rollout.js` - the two scheduler jobs and `startRollout`.
- `commands.js` / `commands-lists.js` - `/verification` subcommands.
- `events.js` - bot joins and new channels.
- `captcha-image.js`, `captcha.js` - Stage 2.
- `index.js` - exports `commands`, `events`, `jobs`.
- Modified: `src/core/registry.js`, `src/modules.js`, `src/db/index.js` (`resetDb` table list), `src/i18n/*.json`, docs.
- Tests: `test/features/verification-*.test.js`.

---

## Stage 1: button mode (a complete system)

### Task 1: Feature skeleton and config

**Files:**
- Create: `src/features/verification/config.js`, `src/features/verification/index.js`, `src/features/verification/commands.js` (command shell with `enable`/`disable` only)
- Modify: `src/core/registry.js` (replace the `f('verification', 2, null)` stub with `f('verification', 2, 'verification', { enableCommand: 'verification enable' })`), `src/modules.js` (add the namespace import and list entry), `src/i18n/*.json` (add `verification.cmd.*` command and subcommand descriptions; the existing `feature.verification` name key stays)
- Test: `test/features/verification-config.test.js`

**Tier:** sonnet - follows the automod feature pattern across several files.

**Interfaces:**
- Consumes: `core/toggle.js` (see how `src/features/automod/commands.js` wires `enable`/`disable`), `getFeature`/`setFeature`.
- Produces: `readConfig(raw): { mode: 'button'|'captcha', roleId: string|null, channelId: string|null, messageId: string|null, state: 'none'|'rolling_out'|'active'|'failed', publicChannels: string[], skippedChannels: string[], cutoff: number|null }` (bad values fall back to defaults: mode `button`, state `none`, lists deduped, max 200 ids each); `classify(channelId, cfg): 'verify'|'public'|'skip'|'gated'`; `export const commands`.

- [ ] **Step 1: Write the failing tests:** `readConfig fills defaults`, `readConfig rejects a bad mode and state`, `readConfig dedupes and caps lists`, `classify gives verify, public, skip, gated in that order of precedence`, `verification is listed as a real command in the registry`.
- [ ] **Step 2: Run** `node --test --test-concurrency=1 test/features/verification-config.test.js`. Expected: FAIL.
- [ ] **Step 3: Implement** the config module, the shell command (name `verification`, `enable`/`disable`), the registry and modules entries.
- [ ] **Step 4: Run** the file, `test/i18n.test.js` and `test/core/loader.test.js`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(verification): feature skeleton and config`.

### Task 2: Undo store

**Files:**
- Create: `src/db/migrations/008_verification_overwrites.sql`, `src/features/verification/store.js`
- Modify: `src/db/index.js` (add `verification_overwrites` to the `resetDb` truncate list)
- Test: `test/features/verification-store.test.js`

**Tier:** sonnet - a migration plus SQL.

**Interfaces:**
- Produces: table `verification_overwrites(guild_id TEXT, channel_id TEXT, everyone JSONB, verified JSONB, bot JSONB, created_at TIMESTAMPTZ DEFAULT now(), PRIMARY KEY (guild_id, channel_id))` where each JSONB is `{ existed: boolean, allow: string, deny: string }` (bit strings) or `null` for "not touched". Functions: `recordOriginal(db, guildId, channelId, { everyone, verified, bot }): Promise<boolean>` (inserts only if no row exists; returns whether it inserted), `getRecord(db, guildId, channelId)`, `listRecords(db, guildId)`, `deleteRecord(db, guildId, channelId)`, `countRecords(db, guildId)`.

- [ ] **Step 1: Write the failing tests:** `recordOriginal inserts once and keeps the first record`, `a second call returns false and changes nothing`, `existed false round-trips`, `listRecords is per guild`, `deleteRecord removes one`.
- [ ] **Step 2: Run the file.** Expected: FAIL.
- [ ] **Step 3: Implement** the migration (`NNN_snake_case.sql`, never edited after) and the five functions; add the table to `resetDb`.
- [ ] **Step 4: Run** the file and `test/db/*.test.js`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(verification): undo store and migration 008`.

### Task 3: Permission planner (pure)

**Files:**
- Create: `src/features/verification/plan.js`
- Test: `test/features/verification-plan.test.js`

**Tier:** opus - the invariant that decides whether the gate is safe; reviewed on opus.

**Interfaces:**
- Consumes: `PermissionFlagsBits`, `ChannelType` from discord.js (no Discord objects at runtime; plain data in).
- Produces:
  - `type Snapshot = { id: string, type: number, everyoneBase: bigint, overwrites: Array<{ id: string, type: 0|1, allow: bigint, deny: bigint }> }`
  - `canEveryoneView(snap, everyoneId): boolean`
  - `roleViewers(snap, everyoneId, verifiedId): string[]` ids of other role overwrites with an explicit View allow (for the preview warning)
  - `planChannel(snap, kind: 'gated'|'public'|'verify'|'skip', ids: { everyoneId, verifiedId, botId }): { skip: boolean, reason?: 'private'|'kind_skip', everyone?: {allow: bigint, deny: bigint}, verified?: {allow: bigint, deny: bigint}, bot?: {allow: bigint, deny: bigint} }` - target overwrites that change only the allowed bits of the existing overwrites (existing other bits preserved). `skip: true` when `kind` is `skip`, or when `canEveryoneView` is false.
  - `planBack(original, current)`: not here (undo uses the stored originals in Task 4).
- Rules (from the spec): gated = `@everyone` deny ViewChannel, Verified allow ViewChannel. public = `@everyone` deny `SEND_BITS` (+ Connect, Speak for voice 2 and stage 13), Verified allow the same bits. verify = `@everyone` deny `SEND_BITS`, Verified deny ViewChannel, bot member allow ViewChannel, SendMessages, ReadMessageHistory, EmbedLinks, AttachFiles, ManageMessages. Bits are removed from the opposite mask when set so allow and deny never overlap.

- [ ] **Step 1: Write the failing tests** with real bit math: `canEveryoneView follows the base bit and the @everyone overwrite and ignores other roles`, `a channel @everyone cannot view is skipped for every kind`, `gated adds the View deny for @everyone and the View allow for Verified and changes no other bit`, `existing unrelated bits in the @everyone overwrite are preserved`, `public denies exactly SEND_BITS`, `public voice also denies Connect and Speak`, `verify hides the channel from Verified and gives the bot its allows`, `allow and deny never share a bit`, `roleViewers lists roles with an explicit View allow`, `skip returns skip true`.
- [ ] **Step 2: Run the file.** Expected: FAIL.
- [ ] **Step 3: Implement** the functions in `plan.js`; pure, no I/O, bigint arithmetic.
- [ ] **Step 4: Run the file.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(verification): pure permission planner`.

### Task 4: Applier and reverter

**Files:**
- Create: `src/features/verification/apply.js`
- Test: `test/features/verification-apply.test.js`

**Tier:** sonnet - maps real discord.js channels to the planner and the store.

**Interfaces:**
- Consumes: `planChannel`, `canEveryoneView` (Task 3); `recordOriginal`, `getRecord`, `deleteRecord` (Task 2); `classify` (Task 1).
- Produces:
  - `snapshotOf(channel, guild): Snapshot` (reads `permissionOverwrites.cache`, `guild.roles.everyone.permissions.bitfield`).
  - `gateChannel(ctx, guild, channel, cfg): Promise<'changed'|'skipped'|'failed'>` - classifies the channel, plans, records the originals first (`recordOriginal`), writes the overwrites with `channel.permissionOverwrites.edit/set` using only the planned bits, and returns `'skipped'` for `skip`/private channels. A channel that is `permissionsLocked` with a parent of the same kind is skipped (it inherits). Never throws; permanent Discord errors return `'failed'`.
  - `revertChannel(ctx, guild, channel): Promise<'restored'|'missing'|'failed'>` - restores `@everyone`, Verified and bot overwrites from the record (`existed: false` deletes the overwrite, otherwise sets it back, touching only the bits the gate changed), then deletes the record.

- [ ] **Step 1: Write the failing tests** (fake channels recording `edit`/`delete` calls): `gateChannel records the original before writing`, `a private channel is skipped and not recorded`, `a skipped-list channel is untouched`, `a second gate keeps the first record`, `revert restores bits and deletes an overwrite that did not exist`, `revert leaves bits it did not change alone`, `a permanent error returns failed and does not throw`, `a synced child of a gated category is skipped`.
- [ ] **Step 2: Run the file.** Expected: FAIL.
- [ ] **Step 3: Implement** the three functions.
- [ ] **Step 4: Run the file.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(verification): gate and revert a channel`.

### Task 5: Mod log helper

**Files:**
- Create: `src/features/verification/log.js`
- Modify: `src/i18n/*.json`
- Test: `test/features/verification-log.test.js`

**Tier:** sonnet - the code is verbatim, but the ten French and Arabic strings need real translation.

**Interfaces:**
- Produces: `logVerification(ctx, guildId, lang, { kind, userId, actorId, detail }): Promise<void>` where `kind` is one of `setup`, `rollout`, `verified`, `manual_verify`, `manual_unverify`, `undo`, `gate_failed`. Never throws.

- [ ] **Step 1: Write the failing test** `logVerification sends one modAction embed and never throws when sendLog rejects`, injecting `sendLog` as an optional last parameter `deps = { sendLog }`.
- [ ] **Step 2: Run the file.** Expected: FAIL.
- [ ] **Step 3: Create `src/features/verification/log.js`:**

```js
import { sendLog } from '../logging/send-log.js';
import { t } from '../../i18n/index.js';

export async function logVerification(ctx, guildId, lang, { kind, userId, actorId, detail }, deps = { sendLog }) {
  try {
    const fields = [];
    if (userId) fields.push({ name: t(lang, 'verification.log.member'), value: `<@${userId}>`, inline: true });
    if (actorId) fields.push({ name: t(lang, 'verification.log.actor'), value: `<@${actorId}>`, inline: true });
    if (detail) fields.push({ name: t(lang, 'verification.log.detail'), value: String(detail).slice(0, 1000) });
    await deps.sendLog(ctx, guildId, 'modAction', { title: t(lang, `verification.log.${kind}`), fields });
  } catch (err) {
    console.warn('verification log failed:', err?.message ?? err);
  }
}
```

Add the keys `verification.log.member`, `.actor`, `.detail`, `.setup`, `.rollout`, `.verified`, `.manual_verify`, `.manual_unverify`, `.undo`, `.gate_failed` to the three i18n files (real fr/ar).
- [ ] **Step 4: Run** the file and `test/i18n.test.js`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(verification): mod log helper`.

### Task 6: Verify core, panel and button

**Files:**
- Create: `src/features/verification/verify.js`
- Modify: `src/features/verification/commands.js` (add the `components` entry with prefix `verification`; handler dispatches on the second customId segment), `src/features/verification/index.js`, `src/i18n/*.json` (`verification.msg.*`, `verification.button.verify`)
- Test: `test/features/verification-verify.test.js`

**Tier:** sonnet - several cases, one handler.

**Interfaces:**
- Consumes: `readConfig` (Task 1), `botCanGive` (`core/role-safety.js`), `logVerification` (Task 5), `guard`/`getLang`.
- Produces:
  - `verifyMember(ctx, guild, member, { method: 'button'|'captcha'|'manual', actorId? }): Promise<{ ok: true } | { ok: false, reason: 'no_role'|'role_too_high'|'already'|'discord_error' }>`
  - `postPanel(ctx, guild, channel, lang): Promise<string|null>` posts the single Verify button message (`customId verification:go`) and returns its message id.
  - `handleVerifyButton(interaction, ctx)`: when disabled or state `none` answers privately "off"; when the member already holds Verified answers privately "already verified"; in `button` mode calls `verifyMember` and answers privately; in `captcha` mode (Stage 2, Task 12) it is a stub that answers "not available" until then.
  - Exports `handle(interaction, ctx)` for the `components` entry; later tasks add more branches.

- [ ] **Step 1: Write the failing tests:** `button mode grants the role and answers privately`, `an already verified member is told so and nothing changes`, `a disabled feature answers off and does nothing`, `state none answers off`, `a member who left (fetch error) is handled`, `a deleted role gives no_role`, `a role above the bot gives role_too_high`, `a double click grants once and logs once`, `postPanel posts one button message with the verify customId`.
- [ ] **Step 2: Run the file.** Expected: FAIL.
- [ ] **Step 3: Implement** `verifyMember`, `postPanel`, the handler and the `components` registration.
- [ ] **Step 4: Run** the file, `test/core/loader.test.js` and `test/i18n.test.js`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(verification): verify button and panel`.

### Task 7: Rollout jobs

**Files:**
- Create: `src/features/verification/rollout.js`
- Modify: `src/features/verification/index.js` (export `jobs`)
- Test: `test/features/verification-rollout.test.js`

**Tier:** sonnet - scheduler jobs and ordering; its review is opus (concurrency).

**Interfaces:**
- Consumes: `scheduleJob`, `cancelJobs` (`core/scheduler.js`; handler shape `async (ctx, job)`, throw to retry, return on permanent errors), `gateChannel` (Task 4), `logVerification`, `readConfig`/`setFeature`.
- Produces: job types `verification.grant` and `verification.gate`, both with key `rollout`, payload `{ after?: string }` (cursor); `startRollout(ctx, guild, lang, adminId): Promise<void>` sets state `rolling_out`, `cutoff = Date.now()`, schedules `verification.grant`; `grantBatch(ctx, job)`: fetches members, grants Verified (skipping those who joined after `cutoff`, who hold it, or have left) in batches of 20 with a cursor, reschedules itself until done, then schedules `verification.gate`; `gateBatch(ctx, job)`: applies `gateChannel` to every channel (categories first) in batches of 10 with a cursor, then sets state `active`, posts the finished line to the mod log, or sets `failed` with a count when channels failed. Both handlers are idempotent and never gate before the grant job reports done. Export `jobs = { 'verification.grant': grantBatch, 'verification.gate': gateBatch }`.

- [ ] **Step 1: Write the failing tests:** `startRollout sets rolling_out and schedules the grant job`, `grantBatch grants members present at the cutoff and skips later joiners`, `grantBatch is idempotent on a rerun`, `grantBatch reschedules until the last batch then schedules gate`, `gateBatch never runs gating while the grant job is still pending`, `gateBatch sets active when all channels are done`, `a channel that fails marks failed with a count and the rest still gate`, `a rerun of gateBatch changes nothing twice`, `a member who left mid-batch is skipped`.
- [ ] **Step 2: Run the file.** Expected: FAIL.
- [ ] **Step 3: Implement** the handlers and `startRollout`; wire `jobs` through `index.js` (`collectModules` collects it).
- [ ] **Step 4: Run** the file and `test/core/loader.test.js`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(verification): restart-safe rollout jobs`.

### Task 8: Setup, status and remove commands

**Files:**
- Modify: `src/features/verification/commands.js`, `src/features/verification/verify.js` (confirm-button branches), `src/i18n/*.json` (`verification.setup.*`, `verification.status.*`, `verification.remove.*`)
- Test: `test/features/verification-commands.test.js`

**Tier:** sonnet - three subcommands plus the confirm flow (model it on `/purge channel` in `src/features/moderation/commands-purge.js`).

**Interfaces:**
- Consumes: `startRollout` (Task 7), `postPanel` (Task 6), `ensureChannel` (`core/auto-channel.js`), `botCanGive`, `snapshotOf`/`roleViewers`/`canEveryoneView` (Tasks 3-4), `revertChannel`, `listRecords`.
- Produces: `/verification setup [mode] [role] [channel]` - refuses when state is not `none`, when a bot permission is missing, or when the given role cannot be given; creates the role (name "Verified", positioned just below the bot's top role) and verify channel when missing, then replies with the preview (counts of channels to gate, public, skipped, already private, and members to grant; plus channels where another role has an explicit View allow) and Confirm/Cancel buttons (`verification:setup:ok:<userId>:<createdAt>` / `...:no:<userId>`); Confirm switches the feature on, posts the panel, saves config, logs `setup` and calls `startRollout`. `/verification status`: mode, role, verify channel, state, rollout progress, list sizes, number of recorded channels. `/verification remove`: reverts every recorded channel, deletes the panel message, disables the feature, sets state `none`, logs `undo`; reports exactly which channels failed to restore. Role and verify channel are left in place.

- [ ] **Step 1: Write the failing tests:** `setup refuses when state is not none`, `setup refuses when the bot lacks Manage Roles`, `setup preview counts channels and names a leaking role`, `confirm by another admin or after 2 minutes does nothing`, `confirm creates what is missing, posts the panel and starts the rollout`, `cancel changes nothing`, `status shows the state`, `remove restores every recorded channel and reports failures`, `remove leaves the role and verify channel`.
- [ ] **Step 2: Run the file.** Expected: FAIL.
- [ ] **Step 3: Implement** the three subcommands and the confirm branches.
- [ ] **Step 4: Run** the file and `test/i18n.test.js`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(verification): setup, status and remove`.

### Task 9: Mode, lists and manual verify commands

**Files:**
- Create: `src/features/verification/commands-lists.js`
- Modify: `src/features/verification/commands.js`, `src/i18n/*.json` (`verification.lists.*`, `verification.manual.*`)
- Test: `test/features/verification-commands-lists.test.js`

**Tier:** sonnet - follows `src/features/automod/commands-lists.js`.

**Interfaces:**
- Consumes: `gateChannel`, `revertChannel` (Task 4), `verifyMember` (Task 6), `logVerification`, `readConfig`.
- Produces: `/verification mode <button|captcha>`; `/verification public|skip add|remove|list <channel>` (max 200; a channel cannot be in both lists or be the verify channel; adding a channel `@everyone` cannot view to `public` is refused; when state is `active` an add/remove re-applies that one channel from its recorded original: revert, then gate with the new kind); `/verification verify <member>` and `/verification unverify <member>` (hierarchy and bot checks, state must not be `none`; each logs `manual_verify` / `manual_unverify` with the actor). `unverify` refuses bots and never punishes.

- [ ] **Step 1: Write the failing tests:** `mode saves captcha`, `public add applies the channel when active`, `public add of a private channel is refused`, `a channel cannot be in both lists`, `skip add reverts a gated channel to its original`, `list shows ids`, `verify grants and logs manual_verify`, `unverify removes the role and logs`, `unverify refuses a bot`, `both refuse when state is none`.
- [ ] **Step 2: Run the file.** Expected: FAIL.
- [ ] **Step 3: Implement** the subcommands and handlers.
- [ ] **Step 4: Run** the file and `test/i18n.test.js`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(verification): mode, channel lists and manual verify`.

### Task 10: Bot joins and new channels

**Files:**
- Create: `src/features/verification/events.js`
- Modify: `src/features/verification/index.js` (`export { events }`)
- Test: `test/features/verification-events.test.js`

**Tier:** sonnet - two Discord events (same export shape as `src/features/automod/events.js`).

**Interfaces:**
- Consumes: `verifyMember`, `gateChannel`, `readConfig`, `logVerification`.
- Produces: `GuildMemberAdd` - when state is `rolling_out` or `active` and the member is a bot, grant Verified immediately (humans: nothing); `ChannelCreate` - when state is `rolling_out` or `active`, `gateChannel` the new channel (it follows its list kind; a new channel is `gated` unless listed), logging `gate_failed` when it fails or is skipped because the bot lacks permission. Neither handler throws.

- [ ] **Step 1: Write the failing tests:** `a joining bot is granted Verified`, `a joining human is not`, `nothing happens when state is none or the feature is off`, `a new channel @everyone can view is gated`, `a new private channel is left alone`, `a failed gate logs gate_failed once`.
- [ ] **Step 2: Run the file.** Expected: FAIL.
- [ ] **Step 3: Implement** the two handlers and export them.
- [ ] **Step 4: Run** the file and `test/core/loader.test.js`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(verification): bots and new channels follow the gate`.

---

## Stage 2: captcha

### Task 11: Captcha image and challenge store

**Files:**
- Create: `src/features/verification/captcha-image.js`, `src/features/verification/captcha.js`
- Test: `test/features/verification-captcha.test.js`

**Tier:** sonnet - drawing with the existing canvas dependency plus a small state machine.

**Interfaces:**
- Consumes: `@napi-rs/canvas` (see how the greet card registers the bundled Noto fonts; reuse that registration, do not add a dependency).
- Produces:
  - `makeCode(random = Math.random): string` (5 characters from `ABCDEFGHJKMNPQRSTUVWXYZ23456789`)
  - `renderCaptcha(code: string, random?): Promise<Buffer>` PNG, distorted and noisy (per-character rotation and offset, noise lines and dots)
  - `createChallengeStore({ now = Date.now, random = Math.random })` returning `{ issue(guildId, userId): { code }, check(guildId, userId, input): 'ok'|'wrong'|'expired'|'none'|'cooldown', cooldownLeft(guildId, userId): number, clear(guildId, userId) }`: code valid 300000 ms, single use (a correct entry clears it), entry compared case-insensitively after trim, 3 wrong entries start a 30000 ms cooldown after which `issue` creates a fresh code, a new `issue` replaces the old code, entries pruned on each call.

- [ ] **Step 1: Write the failing tests:** `makeCode uses only the allowed characters and length 5`, `renderCaptcha returns a PNG buffer (signature bytes)`, `check accepts the code case-insensitively and clears it`, `a correct code cannot be reused`, `an expired code returns expired`, `three wrong entries start the cooldown and check returns cooldown`, `after the cooldown a new issue works`, `issue replaces the previous code`, `one user's code does not validate for another`.
- [ ] **Step 2: Run the file.** Expected: FAIL.
- [ ] **Step 3: Implement** the three exports.
- [ ] **Step 4: Run the file.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(verification): captcha image and challenge store`.

### Task 12: Captcha flow

**Files:**
- Modify: `src/features/verification/verify.js` (captcha branches in the handler), `src/i18n/*.json` (`verification.captcha.*`)
- Test: `test/features/verification-captcha-flow.test.js`

**Tier:** sonnet - button, ephemeral image, modal.

**Interfaces:**
- Consumes: `createChallengeStore`, `renderCaptcha` (Task 11), `verifyMember` (Task 6).
- Produces: in `captcha` mode `verification:go` replies privately with the image attachment and a button `verification:enter:<userId>` (during a cooldown it says how long to wait); that button opens a modal `verification:code:<userId>` with one required text input (min 5, max 5 length); a modal submit from a user other than `<userId>` is refused; a correct code calls `verifyMember` with method `captcha` and answers privately; a wrong code says how many tries remain or that a cooldown started and offers the Verify button again. The challenge store is created once per process in `verify.js`.

- [ ] **Step 1: Write the failing tests:** `go in captcha mode replies with an image and the enter button`, `the enter button opens the modal for the right user`, `the modal from another user is refused`, `a correct code verifies and answers privately`, `a wrong code reports tries left`, `three wrong codes show the cooldown`, `captcha texts are English even when the server language is French or Arabic` (all captcha replies, the enter button and the modal use `t('en', 'verification.captcha.*')`), `button mode is unchanged`.
- [ ] **Step 2: Run the file.** Expected: FAIL.
- [ ] **Step 3: Implement** the branches.
- [ ] **Step 4: Run** the file, the button-mode file (`verification-verify.test.js`) and `test/i18n.test.js`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(verification): image captcha flow`.

---

## Wrap-up

### Task 13: Setup guide invite list

**Files:**
- Modify: `docs/discord-bot-setup.md`

**Tier:** haiku - append the verbatim lines.

**Interfaces:**
- Produces: documentation only.

- [ ] **Step 1: Append** this one bullet at the end of the invite list section (verbatim):

```markdown
- Verification: Manage Roles (creates and grants the Verified role, which must sit below the bot's top role), Manage Channels (creates the verify channel and edits channel overwrites), View Channel, Send Messages, Embed Links and Attach Files (the verify message and the captcha image). Run `npm run deploy` to register `/verification`; migration 008 runs on the next start.
```

- [ ] **Step 2: Commit** `docs: verification invite list in the setup guide`.

### Task 14: Checklist and memory notes

**Files:**
- Modify: `docs/testing-checklist.md` (new numbered section "Verification"), `docs/memory/` (features-built, architecture, roadmap, decisions, gotchas, index)

**Tier:** sonnet - documentation that must match the code.

- [ ] **Step 1:** Add the checklist section: setup preview and confirm; grandfathered members keep access; a new account sees only the verify channel and public channels; sending in a public channel is refused; button verify; captcha verify, wrong code, cooldown; skip and public lists; bot join; new channel; manual verify/unverify; status; remove restores permissions; Discord Onboarding with the public channels.
- [ ] **Step 2:** Update the memory notes from the code: files, job types `verification.grant` and `verification.gate`, state machine, undo record, the one `verification` component prefix, `@napi-rs/canvas` reuse, roadmap status (built on `phase-2`, manual testing pending), gotchas (computed `@everyone` view rule, first record wins, leaking-role warning is informational, the Verified role must stay below the bot).
- [ ] **Step 3: Commit** `docs: verification notes and test checklist`.

### Task 15: Full verification run

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

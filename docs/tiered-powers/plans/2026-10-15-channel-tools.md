# Channel tools (purge, slowmode, lock) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use tiered-powers:subagent-driven-development (recommended) or tiered-powers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `/purge messages`, `/purge channel`, `/slowmode`, `/lock` and `/unlock` to the existing moderation feature, with a mod-log line for each and no cases.

**Architecture:** New files under `src/features/moderation/`: a shared access/notice/log helper, a transactional channel-id mover, two command files (`commands-purge.js`, `commands-channel.js`), wired through `index.js` and the `moderation` registry entry. The whole-channel purge clones the channel, moves stored channel ids in one database transaction, then deletes the old channel, behind a confirm button routed through the loader's `components` mechanism.

**Tech Stack:** Node 22 ESM, discord.js 14, Postgres, `node --test` with the real test DB (`testDb()`).

**Spec:** `docs/tiered-powers/specs/2026-10-15-channel-tools-design.md` (read it, including "Calls I made"; this plan implements it).

## Global Constraints

- Node 22, ESM, discord.js 14; `npm test` (`--test-concurrency=1`; run `npm run db:up` first); no new dependencies; no new database tables or migrations.
- New commands live in `src/features/moderation/` in their own files; do NOT add them to `DEFS` in `commands-actions.js` (a test hardcodes its 8 names). `index.js` exports `commands = [settings, ...actionCommands, ...warningCommands, ...toolCommands]`.
- Each `execute` starts like `commands-actions.js`: `guard(interaction, ctx, 'moderation', { requireManager: false })`, `getFeature` + `readConfig`, then `canUseAction`; replies are ephemeral except the public notices named in the spec.
- Permissions: `ACTION_PERMISSIONS` gains `purge: 'ManageMessages'`, `purgeall: 'ManageChannels'`, `slowmode: 'ManageChannels'`, `lock: 'ManageChannels'`, `unlock: 'ManageChannels'` (a permitted role may use all; `canUseAction` refuses unknown actions). Commands have no default member permissions.
- All user-facing text in `src/i18n/en.json`, `fr.json`, `ar.json` (flat dotted keys, `{name}` placeholders, real French and Arabic; `test/i18n.test.js` enforces parity). Slash option descriptions 1 to 100 characters. New keys use the prefix `moderation.tools.`.
- Mod log: `sendLog(ctx, guildId, 'modAction', embed)` with a plain embed (no case, no `createCase`); logging off or no channel never fails the action.
- Settings writes use `setFeature` (shallow merge: write whole nested values). Moving channel ids touches only `guild_settings` (logging `config.channels.*` values and `config.ignore.channels`; greet, leave, boost and media `config.channelId`).
- Commit after each task; run `npm test` before each commit. Commit messages carry no `Co-Authored-By` or Claude attribution lines; do not change git identity. Do not run `npm run deploy`.

## Review Focus

- `/purge channel` can only be confirmed by the moderator who ran it, within 2 minutes, and always wipes the channel the warning named (the id is in the button's custom id, not "the current channel").
- Clone fails: nothing changed. Settings move fails: the copy is deleted and the original is untouched. Delete of the old channel fails: the moderator is told and settings already point at the copy.
- A channel that holds media library items (`media_items.channel_id`) is refused for `/purge channel`.
- Lock changes only SendMessages on the @everyone overwrite, leaves other overwrites and other bits alone, and an already locked/unlocked channel is a no-op reply; unlock sets SendMessages back to unset (null), not allow.
- Purge skips pinned messages and messages older than 14 days, never exceeds `count`, refuses `user` + `bots` together, and its own reply is not counted.
- A moderator who cannot see the target channel, or a bot that lacks the needed permission in it, is refused with no change; a failed public notice after a successful lock/slowmode change is a note, not a failure.
- Members without the Discord permission or a permitted role cannot use any of the five commands; the feature being off gives the standard off reply.

---

### Task 1: Permissions and shared helpers

**Files:**
- Modify: `src/features/moderation/rules.js` (ACTION_PERMISSIONS), `src/i18n/{en,fr,ar}.json`
- Create: `src/features/moderation/tools-common.js`
- Test: `test/features/moderation-tools-common.test.js`; extend `test/features/moderation-rules.test.js` (new actions allowed for the right permission, refused otherwise)

**Tier:** sonnet — permission checks and best-effort side effects need judgment; reviewed on sonnet.

**Interfaces:**
- Produces (`tools-common.js`):
  - `checkToolAccess({ interaction, action, config, channel, botPermissions }): { ok: true } | { ok: false, reason: 'not_allowed' | 'no_view' | 'bot_missing' | 'bad_channel' }` — `not_allowed` when `canUseAction(interaction.member, action, config)` is false; `no_view` when the moderator lacks ViewChannel in `channel` (`channel.permissionsFor(interaction.member)`); `bot_missing` when the bot lacks any of `botPermissions` (array of permission names, always including ViewChannel and the action's own permission) in `channel` (`channel.permissionsFor(guild.members.me)`); `bad_channel` when `channel` is null.
  - `postNotice(channel, payload): Promise<boolean>` — best effort send via `trySend` from `src/core/send.js`; true when a message was sent.
  - `logTool(ctx, guild, lang, { tool, actorId, channelId, detail, reason }): Promise<void>` — builds a plain embed (title `moderation.tools.log.title` with the tool name, fields moderator `<@id>`, channel `<#id>`, optional detail, optional reason) and calls `sendLog(ctx, guild.id, 'modAction', embed)`; never throws.
  - i18n keys: `moderation.tools.err.not_allowed`, `.no_view`, `.bot_missing`, `.bad_channel`, `moderation.tools.log.title`, `.moderator`, `.channel`, `.reason`, and `moderation.tools.notice_failed` (short note appended to a reply when a public notice could not be posted).

- [ ] **Step 1: Write the failing tests:** `ACTION_PERMISSIONS` maps the five new actions as in Global Constraints; `canUseAction` allows a member with ManageMessages for `purge` but not ManageChannels-only, allows a permitted role for all five, still refuses `nuke`; `checkToolAccess` returns each refusal reason with small fake channel/member objects (`permissionsFor(x).has(...)`), and ok otherwise; `postNotice` returns false when `channel.send` throws; `logTool` calls the injected `sendLog` path once (use the real `sendLog` with logging off and assert it does not throw, plus a fake-collaborator test if the module allows injection) and never throws.
- [ ] **Step 2: Run** `node --test test/features/moderation-rules.test.js test/features/moderation-tools-common.test.js` — expect FAIL.
- [ ] **Step 3: Implement** the ACTION_PERMISSIONS entries, `tools-common.js` and the i18n keys (en, fr, ar).
- [ ] **Step 4: Run** the two files, then `npm test` — expect PASS.
- [ ] **Step 5: Commit** `feat(moderation): permissions and shared helpers for channel tools`.

---

### Task 2: Move stored channel ids in one transaction

**Files:**
- Create: `src/features/moderation/channel-move.js`
- Test: `test/features/moderation-channel-move.test.js`

**Tier:** sonnet — data migration plus transaction handling (risky work; reviewed on opus).

**Interfaces:**
- Produces:
  - `mediaHoldsChannel(db, guildId, channelId): Promise<boolean>` — true when `media_items` has a row with that `guild_id` and `channel_id`.
  - `moveChannelId(db, guildId, oldId, newId): Promise<{ moved: number }>` — in ONE transaction (`db.connect()`, BEGIN/COMMIT/ROLLBACK, release in `finally`, the pattern in `src/db/index.js`), reads the `logging`, `greet`, `leave`, `boost` and `media` rows of `guild_settings` for the guild with `FOR UPDATE`, replaces `oldId` with `newId` in: logging `config.channels` values (every category key whose value equals `oldId`) and `config.ignore.channels` array entries; `config.channelId` of greet, leave, boost and media; writes back only the config objects that changed (whole objects), and returns the number of settings rows changed. Throws (after ROLLBACK) on any database error, leaving nothing changed. Other config keys are preserved untouched. Look at `src/db/settings.js` for the table/column names and the JSON column type.

- [ ] **Step 1: Write the failing tests** (real test DB, `beforeEach` truncates via `resetDb`): replaces matching ids in logging channels (multiple categories), logging ignore channels, and `channelId` for greet, leave, boost and media; leaves non-matching ids and other config keys alone; guild isolation (another guild with the same old id is untouched); returns the changed count; nothing to move returns `{ moved: 0 }`; a forced failure (for example an invalid JSON write via a stubbed client, or a thrown error injected through a wrapper around `db.connect`) rolls back so no row changed; `mediaHoldsChannel` true and false.
- [ ] **Step 2: Run** `node --test test/features/moderation-channel-move.test.js` — expect FAIL.
- [ ] **Step 3: Implement** `channel-move.js`.
- [ ] **Step 4: Run** the file, then `npm test` — expect PASS.
- [ ] **Step 5: Commit** `feat(moderation): move stored channel ids in one transaction`.

---

### Task 3: Slowmode, lock and unlock

**Files:**
- Create: `src/features/moderation/commands-channel.js`
- Modify: `src/i18n/{en,fr,ar}.json`
- Test: `test/features/moderation-commands-channel.test.js`

**Tier:** sonnet — permission overwrite logic with failure paths; reviewed on opus.

**Interfaces:**
- Consumes: Task 1 `checkToolAccess`, `postNotice`, `logTool`; `getFeature`, `readConfig`, `guard`, `ephemeral`, `t`.
- Produces: `channelCommands` — array `[slowmode, lock, unlock]` of `{ data, execute }`:
  - `/slowmode seconds [channel] [reason]`: `seconds` integer 0 to 21600 required; `channel` channel option (text channels and threads); `reason` string max 400. Action `slowmode`; bot permissions needed: ViewChannel, SendMessages, ManageChannels (ManageThreads for a thread). Same value as current = ephemeral "already" reply, no change. Else `channel.setRateLimitPerUser(seconds, reason)`, then `postNotice` (public text with who and reason when given), then `logTool`, then an ephemeral reply (plus the `notice_failed` note when the notice failed). Announcement channels are refused (`bad_channel`).
  - `/lock [channel] [reason]` and `/unlock [channel] [reason]`: `channel` text or announcement channels only (others `bad_channel`). Lock: read the @everyone overwrite (`channel.permissionOverwrites.cache.get(guild.id)`); if its SendMessages is already denied reply "already locked", no change; else `channel.permissionOverwrites.edit(guild.roles.everyone, { SendMessages: false }, { reason })`. Unlock: if SendMessages is not denied reply "not locked"; else edit with `{ SendMessages: null }`. Notice, log line and reply as for slowmode. Only the SendMessages bit of the @everyone overwrite changes.
  - i18n keys under `moderation.tools.slowmode.*`, `.lock.*`, `.unlock.*` (reply, notice, already) as needed.

- [ ] **Step 1: Write the failing tests** with fake interactions/channels (look at `test/features/moderation-commands-actions.test.js` for the fake-interaction style; use the real test DB for `setFeature`): structure (names, option order, required first, `seconds` 0 to 21600, descriptions 1 to 100 chars, no default member permissions); slowmode sets the value, posts one notice, logs, replies privately; same value is a no-op; announcement channel and no-permission member are refused; lock edits only `SendMessages: false` on @everyone and posts the notice; already-locked no-op; unlock edits `SendMessages: null`; unlock of an unlocked channel no-op; a throwing `send` gives the `notice_failed` note but the change stands; bot lacking ManageChannels refuses with no edit call; feature off gives the standard off reply; permitted-role holder allowed.
- [ ] **Step 2: Run** `node --test test/features/moderation-commands-channel.test.js` — expect FAIL.
- [ ] **Step 3: Implement** the three commands and i18n keys (en, fr, ar).
- [ ] **Step 4: Run** the file, then `npm test` — expect PASS.
- [ ] **Step 5: Commit** `feat(moderation): slowmode, lock and unlock commands`.

---

### Task 4: Purge messages

**Files:**
- Create: `src/features/moderation/commands-purge.js` (the `/purge` command with the `messages` subcommand only in this task; Task 5 adds `channel`)
- Modify: `src/i18n/{en,fr,ar}.json`
- Test: `test/features/moderation-commands-purge.test.js`

**Tier:** sonnet — message filtering and Discord limits.

**Interfaces:**
- Consumes: Task 1 helpers.
- Produces: `purgeCommand` — `{ data, execute }` for `/purge` with subcommand `messages count [user] [bots] [reason]` (`count` integer 1 to 100 required; `user` user option; `bots` boolean; `reason` string max 400); `execute` dispatches on the subcommand name so Task 5 can add `channel`. Also exports `selectPurgeTargets(messages, { count, userId, botsOnly, nowMs }): { toDelete: Message[], skippedOld: number, skippedPinned: number }` (pure: newest first, skips pinned and messages older than 14 days = 1 209 600 000 ms, applies the filters, stops at `count`).
  - `messages` flow: access check (action `purge`, bot permissions ViewChannel, ManageMessages, ReadMessageHistory); `user` and `bots` together is refused (`moderation.tools.purge.pick_one`); `deferReply` ephemeral; fetch up to 500 recent messages in the channel in pages of 100 (excluding the command's own reply); `selectPurgeTargets`; `channel.bulkDelete(toDelete, true)`; ephemeral reply with the deleted count and a note when fewer than `count` were found or old/pinned were skipped; `logTool` (tool name "purge", detail with the count). Works in text and announcement channels and threads; other types `bad_channel`.

- [ ] **Step 1: Write the failing tests:** `selectPurgeTargets` pure tests (pinned skipped, older than 14 days skipped and counted, user filter, bots filter, `count` cap, newest first); structure (subcommand name, option order, `count` 1 to 100, descriptions); execute: deletes matches and replies with the count; refuses `user` + `bots`; refuses a member without permission; refuses when the bot lacks ManageMessages; fewer found than `count` reports it; logs one mod line; the reply and the defer are ephemeral.
- [ ] **Step 2: Run** `node --test test/features/moderation-commands-purge.test.js` — expect FAIL.
- [ ] **Step 3: Implement** `commands-purge.js` (messages subcommand) and i18n keys under `moderation.tools.purge.*`.
- [ ] **Step 4: Run** the file, then `npm test` — expect PASS.
- [ ] **Step 5: Commit** `feat(moderation): purge messages`.

---

### Task 5: Purge a whole channel

**Files:**
- Modify: `src/features/moderation/commands-purge.js` (add the `channel` subcommand and the button handler), `src/i18n/{en,fr,ar}.json`
- Test: extend `test/features/moderation-commands-purge.test.js`

**Tier:** sonnet — destructive flow with rollback paths and a button handler; reviewed on opus.

**Interfaces:**
- Consumes: Task 1 helpers, Task 2 `moveChannelId` and `mediaHoldsChannel`.
- Produces: the `/purge` command gains subcommand `channel [channel] [reason]` (`channel` channel option: text and announcement channels only; default the current channel; `reason` string max 400) and `purgeCommand.components = { prefix: 'purge', handle }`.
  - `channel` flow: action `purgeall`, bot permissions ViewChannel, ManageChannels; refuse rules/community-updates channels (`guild.rulesChannelId`, `guild.publicUpdatesChannelId`) and non text/announcement types; refuse when `mediaHoldsChannel` is true (`moderation.tools.purge.media_here`); then reply ephemeral with the warning (names `<#id>`, lists what is lost: messages, pins, webhooks, invites, threads, announcement followers) and two buttons Confirm and Cancel. Custom ids: `purge:ok:<userId>:<channelId>:<createdAtMs>` and `purge:no:<userId>`.
  - `handle(interaction, ctx)`: parse the custom id; only the moderator whose id is in it may press (otherwise ephemeral refusal); Confirm is valid for 2 minutes from `<createdAtMs>` (otherwise "expired"); Cancel edits the message to "cancelled". On Confirm: re-run `guard` and the access check (permission may have changed), re-check `mediaHoldsChannel`, then: (1) `channel.clone({ reason })`, on failure edit the reply with an error and stop; (2) set the clone's position to the old channel's position; (3) `moveChannelId(ctx.db, guild.id, oldId, clone.id)`, on failure delete the clone, tell the moderator, stop; (4) `oldChannel.delete(reason)`, on failure tell the moderator the old channel still exists and settings already point at the copy; (5) post a short public notice in the clone via `postNotice`, `logTool` (tool name "purge channel", channel = the clone), edit the confirm message with the result including the new channel mention. Never use "the current channel": always the id from the custom id.

- [ ] **Step 1: Write the failing tests** (fake guild/channels with `clone`, `delete`, `setPosition`; real test DB for settings): structure of the `channel` subcommand (optional `channel`, descriptions); refuses a rules channel, a voice channel, and a channel with media items (no buttons shown); shows the warning with `<#id>` and the two buttons carrying the ids; a button pressed by another user is refused; an expired confirm is refused; Cancel clears the buttons; Confirm happy path clones, moves the logging/greet ids to the clone id in the DB, deletes the old channel, posts a notice, logs once; clone failure: nothing moved, nothing deleted; move failure (stub `moveChannelId` or force a DB error): the clone is deleted, old channel kept; old-channel delete failure: reply says so and settings point at the clone; the wiped channel is the one in the custom id even when the command was run elsewhere.
- [ ] **Step 2: Run** `node --test test/features/moderation-commands-purge.test.js` — expect FAIL.
- [ ] **Step 3: Implement** the subcommand and `components.handle`, plus i18n keys.
- [ ] **Step 4: Run** the file, then `npm test` — expect PASS.
- [ ] **Step 5: Commit** `feat(moderation): purge a whole channel with confirm and clone`.

---

### Task 6: Wiring and registry

**Files:**
- Modify: `src/features/moderation/index.js` (export `toolCommands = [purgeCommand, ...channelCommands]` into `commands`), `src/core/registry.js` (add `purge`, `slowmode`, `lock`, `unlock` to the `moderation` entry's `commands`), `test/features/moderation-settings.test.js` (the `ALL` list), any other test that enumerates the moderation command names (find with `grep -rn "'unban'" test`)
- Test: extend `test/features/moderation-settings.test.js` with a test that `collectModules` over `src/modules.js` has no duplicate command names or component prefixes and that `purge` registers its `purge` component prefix; `/help feature:moderation` lists the four new commands.

**Tier:** sonnet — integration across registry, loader and help tests.

**Interfaces:**
- Consumes: Tasks 3 to 5 exports `channelCommands`, `purgeCommand` (with `components`).

- [ ] **Step 1: Write the failing tests** described above (extend `ALL`, duplicate checks, help lists the new commands).
- [ ] **Step 2: Run** `node --test test/features/moderation-settings.test.js test/features/help.test.js` — expect FAIL.
- [ ] **Step 3: Implement** the index.js export and registry entry; fix any enumerating tests.
- [ ] **Step 4: Run** `npm test` — expect PASS.
- [ ] **Step 5: Commit** `feat(moderation): wire channel tools into the moderation feature`.

---

### Task 7: Documentation and memory notes

**Files:**
- Modify: `README.md`, `docs/discord-bot-setup.md` (invite lists gain Manage Messages; Manage Channels becomes required rather than optional for purge, slowmode and lock), `docs/testing-checklist.md` (Moderation section: purge messages with each filter and old/pinned messages, purge channel confirm/cancel/expiry/wrong user/media refusal, settings moved, slowmode, lock/unlock and the unlock limit, permitted role, refusals), `docs/tiered-powers/specs/2026-10-15-channel-tools-design.md` (status line), `docs/tiered-powers/specs/2026-10-14-feature-roadmap.md` (Phase 2 step 3 status), `docs/memory/{features-built,architecture,roadmap,decisions,gotchas}.md` (keep `index.md` accurate)

**Tier:** sonnet — prose that must match the real code.

- [ ] **Step 1:** Read the new moderation code, then update the files above; record only what is true in the code (command names and options, the confirm button flow and what it moves, the unlock limit, the media refusal, old mod-log links not moved). Link notes with `[[wikilinks]]`.
- [ ] **Step 2: Commit** `docs: channel tools notes, invite permissions and test checklist`.

---

### Task 8: Final verification run

**Files:** none changed.

**Tier:** haiku — run-and-report, no decisions.

```bash
npm test
python -m graphify update .
```

- [ ] **Step 1:** Run `npm test`; report pass/fail counts and the full output of any failure.
- [ ] **Step 2:** Run `python -m graphify update .`; report the last 5 lines, then `git status --short`.
- [ ] **Step 3:** Report back; do not fix failures and do not run `npm run deploy` (the owner runs it; new commands must be registered with it).

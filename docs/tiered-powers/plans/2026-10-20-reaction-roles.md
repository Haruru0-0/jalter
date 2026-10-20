# Reaction Roles Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use tiered-powers:subagent-driven-development (recommended) or tiered-powers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let staff attach roles to a named-embed message that members pick with reactions, buttons or a dropdown, with Carl-bot-style types, limit, whitelist/blacklist and selfdestruct.

**Architecture:** A new feature module `src/features/reactionroles/`. Two pure layers (`config.js` parsing, `rules.js` pick decisions) feed `apply.js`, the only place that changes roles (per-member-per-message serialized). `render.js` builds the Discord components and reactions; `events.js` and `components.js` translate Discord events into picks; `commands.js`, `commands-settings.js` and `builder.js` are the staff surface. State lives in three new tables (migration 009); the on/off flag lives in `guild_settings`.

**Tech Stack:** discord.js 14.27, Node 22 ESM, Postgres, `node --test`.

**Spec:** `docs/tiered-powers/specs/2026-10-20-reaction-roles-design.md`

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
- Create `src/features/reactionroles/render.js` — components, reactions, `syncMessage`, `postRoleMessage`
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
  - `postRoleMessage(ctx, interaction, lang, channel, embedName, style): Promise<Message | null>` — loads the named embed, builds its payload with `buildEmbedPayload`, sends it with `allowedMentions: safeMentions()` via `trySend`, returns the sent message or null (caller reports).
  - `refreshEmbed(ctx, guild, message, discordMessage)` — re-renders the named embed payload and edits the message, keeping components.
- [ ] **Step 1: Write failing tests:** buttons split 12 entries into rows of 5,5,2; 20 entries fit; a menu with `unique` has `maxValues 1`, with `normal` and 4 entries has 4; `reactions` style returns `[]`; `missingReactions` lists only the emoji the bot has not reacted with; `syncMessage` on reactions removes a stale own reaction and adds a missing one (fake message with a `reactions.cache`).
- [ ] **Step 2:** run → FAIL.
- [ ] **Step 3: Implement** with discord.js builders (`ButtonBuilder`, `StringSelectMenuBuilder`, `ActionRowBuilder`). Option/label text truncated to Discord's limits (80 for button label, 100 for option label).
- [ ] **Step 4:** run → PASS.
- [ ] **Step 5: Commit** `feat(reactionroles): render components and sync reactions`.

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
  - `events.js`: `createEvents(deps = {})` returning `{ name, execute }` entries for `MessageReactionAdd`, `MessageReactionRemove`, `MessageReactionRemoveAll`, `MessageDelete`, `MessageBulkDelete`, `RoleDelete`, `ChannelDelete`, `GuildMemberRemove`; `export const events = createEvents()`. Reaction handlers: fetch partial reaction/message, ignore bots and the bot's own reactions, look the message up in the store, ignore it when the feature is off, find the entry by `emojiKey`, `applyPick({kind:'entry', entry, action})` (`action` is `'add'` for reaction add, `'remove'` for reaction remove), then remove the member's reaction when `result.clearReaction` or the pick was refused, and remove the reactions of entries whose roles were removed (unique). `RoleDelete` calls `deleteEntriesForRole` and `syncMessage` on each affected message; `GuildMemberRemove` calls `clearMemberBindings`; `MessageReactionRemoveAll` does nothing but is registered so `status` and `fix` can report (no DB change).
- [ ] **Step 1: Write failing tests** using the injectable `deps` (store/apply fakes where needed, real DB elsewhere): reaction add grants through `applyPick` and removes the reaction for `verify`; a refused pick removes the reaction; a bot's reaction and the bot's own reaction are ignored; a reaction on an unknown message and a reaction while the feature is off do nothing and keep the reaction; a partial user or member that fails to fetch does not throw; button click replies ephemerally with the added role name; menu with an empty selection on a `verify` message removes nothing; `RoleDelete` removes the entry and re-syncs; `MessageDelete` removes the stored message; `GuildMemberRemove` clears bindings; clicking a button of a disabled feature replies `reactionroles.off`.
- [ ] **Step 2:** run → FAIL.
- [ ] **Step 3: Implement**, wrapping each handler in `safe(name, fn)` from `src/features/logging/send-log.js` (as `verification/events.js` does).
- [ ] **Step 4:** run new tests plus `test/features/reactionroles-*.test.js` → PASS.
- [ ] **Step 5: Commit** `feat(reactionroles): reaction, button and menu picks and cleanup events`.

---

### Task 8: Interactive builder panel

**Files:**
- Create: `src/features/reactionroles/builder.js`
- Modify: `commands.js` (add `builder` subcommand), `components.js` (route `b`), i18n files
- Test: `test/features/reactionroles-builder.test.js`

**Tier:** sonnet — panel state across interactions

**Interfaces:**
- Consumes: `addEntry`, `removeEntry`, `getMessage`, `checkRoleForSetup`, `parseEmoji`, `checkEntryInput`, `syncMessage`, `logReactionRoles`.
- Produces: `builderPayload(ctx, lang, message, draft, guild): { content/embeds, components }` — shows current entries, a `RoleSelectMenuBuilder` (customId `reactionroles:b:role:<userId>:<messageId>`), buttons `Add` (`reactionroles:b:add:...`, opens a modal with an emoji field and a label field, modal customId `reactionroles:b:modal:<userId>:<messageId>:<roleId>`), `Remove` (a StringSelect of entries, `...:b:rm:...`), and `Done`. `handleBuilder(interaction, ctx)` rebuilds the panel from the DB on every interaction; the draft role is carried in the customId only. Only the opener may use it (others get ephemeral `reactionroles.notYours`); a panel older than 10 minutes (timestamp in the customId) replies `reactionroles.expired`. Every Add runs the same checks as `/reactionroles add`.
- [ ] **Step 1: Write failing tests:** `builderPayload` lists existing entries and has the four controls; role select then Add opens a modal with `<=45` char titles and labels in every language; modal submit adds the entry and re-renders the panel; a dangerous role is refused with the setup message; a second user pressing a control is refused; an expired panel is refused; Remove deletes the entry and syncs.
- [ ] **Step 2:** run → FAIL.
- [ ] **Step 3: Implement** following `src/features/embeds/panel.js` (modal builders, `showModal`, rebuild from store).
- [ ] **Step 4:** run new tests and i18n test → PASS.
- [ ] **Step 5: Commit** `feat(reactionroles): interactive builder panel`.

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

---

### Task 10: Final verification

**Files:** none changed except the graph output.

**Tier:** haiku — run commands and report

**Interfaces:** none.

- [ ] **Step 1:** `npm test` — expected: every test passes; report the count and any failure verbatim.
- [ ] **Step 2:** `npm run deploy` is not run (needs the live token); instead run `node -e "import('./src/modules.js').then(m=>console.log(m.modules.length))"` — expected: `15`.
- [ ] **Step 3:** `graphify update .` — expected: finishes without error.
- [ ] **Step 4:** `git status --short` — report; commit nothing here.

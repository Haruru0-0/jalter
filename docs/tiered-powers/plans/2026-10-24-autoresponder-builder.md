# Autoresponder Builder Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use tiered-powers:subagent-driven-development (recommended) or tiered-powers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `/autoresponder builder` opens an ephemeral click-through panel where staff build a new rule (trigger, reply, conditions, actions), try it, and save it; every existing `/autoresponder` command stays as it is.

**Architecture:** A structured draft held in memory per panel (`builder/`) is turned into script text by a pure generator; every change that touches the script is applied tentatively, compiled with the existing `compileScript`, and reverted with the localized errors if it fails, so the builder can never hold or save what the text editor would refuse. Save runs the same path as the text editor (`checkTrigger`, `compileScript`, `createRule`, `invalidate`, `logAutoresponder`). The dry run behind `/autoresponder test` moves into a shared function that Try it reuses.

**Tech Stack:** discord.js 14.27 (select menus, modals), Node 22 ESM, Postgres, `node --test`.

**Spec:** `docs/tiered-powers/specs/2026-10-24-autoresponder-builder-design.md` (the "calls made after the builder check" are binding). Stage 1 spec: `docs/tiered-powers/specs/2026-10-24-autoresponder-design.md`.

## Global Constraints

- Node 22+, ESM, discord.js 14.27.0, no new dependency, no new intent, no new migration.
- Every user-facing string goes in all three of `src/i18n/en.json`, `fr.json`, `ar.json` (`test/i18n.test.js` checks parity), real translations, keys under `autoresponder.builder.*`. Each task adds the keys it uses. Reuse the existing `autoresponder.error.<CODE>` strings for compile errors. Slash descriptions stay English-only like the rest of `/autoresponder`.
- The builder is one more subcommand `builder` (no options). Existing subcommands, ids and behaviour are unchanged. Setup replies are ephemeral; the panel needs the feature on and Manage Server or the bot manager role: `guard(interaction, ctx, 'autoresponder')` runs on the command AND on every panel interaction and modal submit.
- Component custom ids: `autoresponder:b:<action>:<userId>:<panelId>[:<extra>]`, at most 100 characters (a test asserts the longest id). Only the opener (`userId` in the id) may use a panel.
- Draft: in memory only, bounded (500 panels), one per member per server (opening again replaces), expires 15 minutes after the last click (sliding), lost on restart. An expired, replaced or unknown panel replies `autoresponder.builder.expired` and never throws.
- Discord limits: at most 5 component rows per message, 25 options per select, panel message content at most 2000 characters (`fitLines`), modal at most 5 inputs. Panel replies set `allowedMentions: { parse: [] }`.
- Language limits stay the compiler's: script 4000, cooldown 1 to 604800, `delete_reply` 1 to 300, 5 reactions combined, 3 role/nickname actions together, 10 values per gate. The compiler is the source of truth.
- Tests hit the DB (`npm test`, concurrency 1). Pure parts (generator, draft, store) are tested without Discord. Commit style `feat(autoresponder): ...`, the user's own git name and email, no Co-Authored-By Claude trailer. Never stage `docs/memory/roadmap.md`, `docs/memory/.obsidian/workspace.json` or `test/features/automod-*.test.js` (the user's own uncommitted edits).

## Plan notes (departures from the spec text, same behaviour)

- **Caps by compile-and-revert:** the spec says the draft model enforces the language caps. Instead each mutation is compiled and reverted with the compiler's own error message on failure (same refusal, one source of truth, no duplicated limits). The draft ops only prevent duplicates they can see (a second cooldown replaces the first).
- **Reply text is inserted verbatim** so `{user}` and other placeholders work; Save and every mutation compile the result, so a stray function typed into the text is checked like any script. Only argument values built by the panel (nickname) escape `|` and `\`.

## Review Focus

1. A member clicking another member's panel, a non-manager with a copied or forged id, or the feature switched off mid-session: refused, nothing changes (Task 2).
2. A click on an expired, replaced or restarted panel (unknown panel id): the expired reply, no throw (Task 2).
3. Save with an invalid draft stores nothing, writes no log line, keeps the draft and shows the localized errors; the 101st rule replies `autoresponder.full`; pressing Save twice at once creates one rule (Task 2).
4. Reply text with braces, placeholders, a trailing backslash, and a nickname containing `|` or `\`: the generated script compiles to what the panel shows, never silently different (Task 1).
5. Discord limits: a server with more than 25 stored embeds or more than 25 roles-worth of choices, a long summary, the longest custom id (Tasks 2 to 4).

---

## File Structure

- Create `src/features/autoresponder/builder/draft.js` - the draft shape and pure ops
- Create `src/features/autoresponder/builder/generate.js` - draft to script text
- Create `src/features/autoresponder/builder/drafts.js` - in-memory panel store
- Create `src/features/autoresponder/builder/summary.js` - readable summary lines
- Create `src/features/autoresponder/builder/panel.js` - custom ids and page payloads
- Create `src/features/autoresponder/builder/handlers.js` - interaction router and every panel action
- Create `src/features/autoresponder/dryrun.js` - shared dry run
- Modify `src/features/autoresponder/commands.js` (`builder` subcommand, route `b`, use `dryrun.js`, export `errorLines`), `src/i18n/{en,fr,ar}.json`, `README.md`, `docs/testing-checklist.md`, `docs/memory/*`
- Tests: `test/features/autoresponder-builder-*.test.js`, `test/features/autoresponder-dryrun.test.js`

---

### Task 1: Pure core - draft model, generator, store and shared dry run

**Tier:** sonnet - pure logic, an in-memory store with a save lock, and a no-behaviour-change refactor

#### Part A: Draft model and script generator

**Files:**
- Create: `src/features/autoresponder/builder/draft.js`, `src/features/autoresponder/builder/generate.js`
- Test: `test/features/autoresponder-builder-draft.test.js`

**Interfaces:**
- Produces in `draft.js`:
  - `Draft = { trigger: string, matchMode: string, text: string, dest: 'reply'|'dm'|'channel', channelId: string|null, embed: null | { kind: 'plain', color: string|null } | { kind: 'named', name: string }, deleteTrigger: boolean, deleteReplyAfter: number|null, silent: boolean, gates: Gate[], actions: Action[], mode: 'guided'|'script', scriptText: string|null }`
  - `Gate = { fn: 'cooldown', seconds: number } | { fn: 'requirerole'|'denyrole', ids: string[] } | { fn: 'requireperm'|'denyperm', perms: string[] } | { fn: 'requirechannel'|'denychannel', ids: string[] } | { fn: 'requireuser', ids: string[] }`; `Action = { fn: 'addrole'|'removerole', id: string } | { fn: 'setnick', text: string } | { fn: 'react'|'reactreply', emoji: string }`
  - `newDraft(matchMode = 'exact'): Draft`; immutable ops, each returns a new Draft: `setTrigger(d, trigger, matchMode?)`, `patch(d, partial)` (any top-level scalar field), `addGate(d, gate)` (a `cooldown` replaces an existing one), `removeGate(d, index)`, `addAction(d, action)`, `removeAction(d, index)`, `toScriptMode(d, scriptText)`.
- Produces in `generate.js`: `generateScript(d: Draft): string`. Script mode returns `d.scriptText`. Guided output: the reply text verbatim, then one function per line in this order: gates in draft order, actions in draft order, then `{embed}` / `{embed:#rrggbb}` / `{embed:<name>}`, `{dm}` or `{sendto:<#id>}` (by `dest`), `{delete}`, `{delete_reply:N}`, `{silent}`. Arguments: roles `<@&id>`, channels `<#id>`, users `<@id>`, permissions by name, several values joined with `|`; `setnick` text and emoji pass through `escapeArg` (escapes `\` and `|`). Text first, functions after, so the evaluator's trim drops the trailing line breaks.

- [ ] **Step 1: Write failing tests** `autoresponder-builder-draft.test.js`: `newDraft` defaults; each op returns a new object and leaves the input unchanged (deep-frozen input); a second `cooldown` replaces the first; `generateScript` for: text only; text plus `cooldown 30`; `requirerole` with two ids (`{requirerole:<@&1>|<@&2>}`); `denyperm`; `requireuser`; `addrole` and `removerole`; `setnick` with `a|b\c` (escaped as `a\|b\\c`); `react` and `reactreply`; each embed form; `dest: 'dm'`, `dest: 'channel'` with an id, `dest: 'reply'` (no function); `deleteTrigger`, `deleteReplyAfter`, `silent`; the documented order; script mode returns `scriptText` untouched; **round trip**: for a draft using one of every function, `parseScript(generateScript(d))` returns `ok: true` and the call names are exactly the expected list; reply text containing `{user}`, `[x]`, a backslash and a line break is emitted verbatim.
- [ ] **Step 2:** `node --test --test-concurrency=1 test/features/autoresponder-builder-draft.test.js` -> FAIL (modules missing).
- [ ] **Step 3: Implement** both modules with the signatures above.
- [ ] **Step 4:** run -> PASS. **Step 5: Commit** `feat(autoresponder): builder draft model and script generator`.

---

#### Part B: Draft store

**Files:**
- Create: `src/features/autoresponder/builder/drafts.js`
- Test: `test/features/autoresponder-builder-drafts.test.js`

**Interfaces:**
- Consumes: `newDraft` (Task 1).
- Produces: `createDraftStore({ now = Date.now, ttlMs = 900000, max = 500 } = {})` returning `{ open(guildId, userId, draft): string, get(panelId): Entry | null, update(panelId, patch): Entry | null, beginSave(panelId): Entry | null, endSave(panelId, done: boolean): void, drop(panelId): void, size(): number }` and a default instance `export const drafts`. `Entry = { panelId, guildId, userId, draft, page: string, pending: string|null, saving: boolean, expiresAt: number }`. `panelId` is 8 random base-36 characters. `open` replaces the member's earlier panel in that server. `get` and `update` slide `expiresAt`; an expired entry is removed and returns `null`. When over `max`, the oldest entry is evicted. `beginSave` returns `null` if the entry is missing, expired or already saving, else sets `saving` and returns it; `endSave(id, true)` drops it, `endSave(id, false)` clears `saving`.

- [ ] **Step 1: Write failing tests:** open then get returns the entry; ids are 8 chars and unique over 1000 opens; opening again for the same member and server drops the first panel; two servers or two members do not interfere; get after `ttlMs` returns null and removes it (injected `now`); a get inside the window slides expiry; the 501st open evicts the oldest; `beginSave` twice in a row gives an entry then null; `endSave(false)` allows another `beginSave`; `endSave(true)` removes the entry; update on a missing id returns null.
- [ ] **Step 2:** run -> FAIL. **Step 3: Implement.** **Step 4:** run -> PASS. **Step 5: Commit** `feat(autoresponder): builder draft store`.

---

#### Part C: Shared dry run

**Files:**
- Create: `src/features/autoresponder/dryrun.js`
- Modify: `src/features/autoresponder/commands.js` (use it; keep every reply identical)
- Test: `test/features/autoresponder-dryrun.test.js`; the existing `autoresponder-testcmd.test.js` must pass unchanged

**Interfaces:**
- Consumes: the current `gateLines`, `actionLines`, `evaluate`, `buildScriptVars` code inside `commands.js` (`dryRun`, `pickRule`, `gateLines`, `actionLines`).
- Produces: `describeRun(lang, { compiled, text, member, guild, channel, channelId, author }): string[]` - the gate lines, then (when no gate fails) the rendered text and the action list, exactly as `/autoresponder test` prints them today after its rule header lines. It builds the fake message and `vars` itself, calls `evaluate`, never touches the database or Discord. `commands.js` `dryRun` keeps the rule choice (`pickRule`) and the header lines and appends `describeRun(...)`.

- [ ] **Step 1: Write failing tests** `autoresponder-dryrun.test.js` with a compiled rule (compile a script with `compileScript` in the test DB): passing gates give `gate.pass` lines then text then actions; a failing `requirerole` gives `gate.fail` and no text or actions; the cooldown gate prints its seconds line; `describeRun` performs no `db.query` (spy) and calls no write method on the fake member or channel.
- [ ] **Step 2:** run -> FAIL. **Step 3: Extract** the logic into `dryrun.js` and call it from `dryRun`. **Step 4:** run the new test and `test/features/autoresponder-testcmd.test.js` and `test/features/autoresponder-commands.test.js` -> PASS with no test changes. **Step 5: Commit** `refactor(autoresponder): share the dry run`.

---

### Task 2: Builder core - command, panel shell, Basics, Reply, Review, Save

**Files:**
- Create: `src/features/autoresponder/builder/summary.js`, `builder/panel.js`, `builder/handlers.js`
- Modify: `src/features/autoresponder/commands.js` (add `builder` subcommand, `HANDLERS.builder`, route component kind `b` and builder modals to `handleBuilder`, export `errorLines`), `src/i18n/{en,fr,ar}.json`
- Test: `test/features/autoresponder-builder-core.test.js`

**Tier:** sonnet - security-relevant checks on every interaction plus the Save path; reviewer should be opus

**Interfaces:**
- Consumes: Task 1 (Parts A to C); `guard`, `ephemeral`, `fitLines`, `checkTrigger`, `MATCH_MODES`, `compileScript`, `createRule` (returns `'full'` at the cap), `invalidate`, `logAutoresponder` through the existing `log` helper in `commands.js` (action `add`, detail = the trigger plus the builder note key `autoresponder.builder.logDetail`), `errorLines(lang, errors)` (export it from `commands.js`).
- Produces in `panel.js`: `builderId(action, userId, panelId, extra?): string`; `parseBuilderId(customId): { action, userId, panelId, extra } | null`; `PAGES` (array of page keys: `basics`, `reply`, `review` for now; later tasks append); `panelPayload(lang, entry): { content, components, allowedMentions }`. Rows: row 1 is always the page select (`nav`, options from `PAGES`); the rest per page: **basics** (a Trigger button opening modal `mtrigger` with one `trigger` input max `MAX_TRIGGER_LENGTH`; a match-mode string select `mode` from `MATCH_MODES`); **reply** (an Edit reply button opening modal `mtext` with a paragraph `text` input max 2000; destination select `dest`: reply in place, DM, channel; a `channel` ChannelSelect, text channels only, shown only when `dest` is `channel`; toggle buttons `delete` (delete the trigger message) and `silent`); **review** (the summary, Save, Cancel).
- Produces in `summary.js`: `summaryLines(lang, draft): string[]` - trigger and mode, then one readable line per reply setting, gate and action using keys `autoresponder.builder.sum.<fn>` with `{value}` (define the keys for every stage 1 function now so later tasks only add controls), and a note line when `deleteTrigger` is set together with a `react` action.
- Produces in `handlers.js`: `tryChange(interaction, ctx, lang, entry, nextDraft, rerender)` (exported; applies `nextDraft` tentatively: regenerate the script, `compileScript` with the pressing member as writer; on errors send an ephemeral follow-up with `errorLines` and leave the entry unchanged; on success store the draft with `drafts.update` and call `rerender`) - every later control uses it. `PAGES` is an ordered array with `review` always last; later tasks insert their pages before it. Transient views (a pending condition kind, the embed picker) live in `entry.page` / `entry.pending` and fall back to their owning nav page on `nav`. Also: `openBuilder(interaction, ctx, lang)` (the `builder` subcommand: `drafts.open(...)`, ephemeral reply with `panelPayload`) and `handleBuilder(interaction, ctx)` (the router). For every interaction it: parses the id (unparseable -> ignore), refuses a different user with `autoresponder.builder.notYours`, runs `guard` (refusal replies are the guard's own), looks up the entry with `drafts.get` (missing -> `autoresponder.builder.expired`), then dispatches by action: `nav`, `mode`, `dest`, `channel`, `delete`, `silent` (each applies the change to the draft, regenerates the script, runs `compileScript`; on errors the change is reverted and the errors are sent as an ephemeral follow-up using `errorLines`; on success the panel is re-rendered with `interaction.update`), `trigger` and `text` (open modals; the modal submit applies the value the same way, `checkTrigger` first for the trigger with `autoresponder.badTrigger.<code>`), `cancel` (drops the entry, replaces the panel with the cancelled text, components removed), `save` (below). Slow work calls `deferUpdate` first.
- Save: `drafts.beginSave` (null -> expired reply), `checkTrigger` (bad -> `badTrigger` reply, `endSave(false)`), `compileScript(generateScript(draft), { db, guild, writer: interaction.member })` (errors -> `errorLines` reply, `endSave(false)`, draft kept), `createRule` (`'full'` -> `autoresponder.full`, `endSave(false)`), then `invalidate`, one log line, `endSave(true)`, panel replaced by the created text with the rule id and no components.
- i18n keys added here (en, fr, ar): `builder.*` panel texts (`head`, page names, button and select labels, `notYours`, `expired`, `cancelled`, `saved`, `logDetail`, `modal.trigger`, `modal.text`, input labels at most 45 characters) and all `builder.sum.*` keys.

- [ ] **Step 1: Write failing tests** `autoresponder-builder-core.test.js` (fakes as in `autoresponder-commands.test.js`; real DB): `/autoresponder builder` opens an ephemeral panel whose row 1 is the page select and whose component custom ids are all at most 100 characters; every existing subcommand still works (run `list` and `add` after the change); the panel is refused for a non-manager and when the feature is off (`guard` replies); **another member's click is refused with `notYours` and changes nothing; a manager-less member with a copied id is refused; an unknown or expired panel id (advance an injected clock or use `drafts.drop`) gets `expired` and does not throw; a panel replaced by reopening gets `expired`**; setting the trigger through the modal (valid, empty -> `badTrigger.EMPTY_TRIGGER`, regex mode with a bad pattern -> `badTrigger.BAD_REGEX`); mode, destination and the channel select update the draft and re-render; **a change that breaks the compile (set the reply text to `{nope}`) is reverted, the panel keeps the old value and the follow-up lists `autoresponder.error.UNKNOWN_FUNCTION` with the 1-based position**; Save with a valid draft stores one rule with the generated script and `compiled`, invalidates the cache (`getRules` sees it), writes exactly one log line, and replies with the id; **Save with an invalid reply text stores nothing, writes no log line, keeps the entry and lists the errors**; Save with an empty trigger -> `badTrigger.EMPTY_TRIGGER`; the 101st rule -> `autoresponder.full` and nothing stored; **two simultaneous Save presses (`Promise.all`) create exactly one rule**; Cancel drops the entry and a later click gets `expired`; a stored rule made by the builder appears in `list` and `show` and `edit` opens it with the generated script prefilled; the `notYours` / `expired` / panel texts exist in en, fr and ar.
- [ ] **Step 2:** `node --test --test-concurrency=1 test/features/autoresponder-builder-core.test.js` -> FAIL.
- [ ] **Step 3: Implement** `summary.js`, `panel.js`, `handlers.js`; in `commands.js` add the `builder` subcommand (no options, English description), `HANDLERS.builder = openBuilder`, route custom ids whose second segment is `b` to `handleBuilder` (before the existing modal-only check), and export `errorLines`. Add the i18n keys.
- [ ] **Step 4:** run the new test, `test/features/autoresponder-commands.test.js`, `test/features/autoresponder-testcmd.test.js`, `test/i18n.test.js` -> PASS. **Step 5: Commit** `feat(autoresponder): builder panel with trigger, reply and save`.

---

### Task 3: Conditions and actions pages

**Tier:** sonnet - several pickers sharing one pending-kind flow, role-safety cases

#### Part A: Conditions page

**Files:**
- Modify: `src/features/autoresponder/builder/panel.js`, `builder/handlers.js`, `src/i18n/{en,fr,ar}.json`
- Test: `test/features/autoresponder-builder-conditions.test.js`

**Interfaces:**
- Consumes: Task 2's router, `addGate`/`removeGate` (Task 1 Part A), `entry.pending` (Task 1 Part B), `tryChange` from Task 2.
- Produces: `PAGES` gains `conditions`. The page has: a `cond` string select with the eight kinds (`cooldown`, `requirerole`, `denyrole`, `requireperm`, `denyperm`, `requirechannel`, `denychannel`, `requireuser`) that sets `entry.pending`; then exactly one input row for the pending kind: `cooldown` -> a button opening modal `mcooldown` (one `seconds` input); role kinds -> RoleSelect, 1 to 10 values; permission kinds -> a string select of the 25 most used permission names (`ManageMessages`, `ManageRoles`, `ManageChannels`, `ManageGuild`, `ManageNicknames`, `KickMembers`, `BanMembers`, `ModerateMembers`, `Administrator`, `MentionEveryone`, `SendMessages`, `AttachFiles`, `EmbedLinks`, `AddReactions`, `UseExternalEmojis`, `ViewChannel`, `Connect`, `Speak`, `ReadMessageHistory`, `ManageThreads`, `ManageEvents`, `ManageWebhooks`, `CreateInstantInvite`, at most 25 options and no duplicates) plus an Other button opening modal `mperm` (one `perm` input); channel kinds -> ChannelSelect (text, 1 to 10); `requireuser` -> UserSelect (1 to 10); and a `rmgate` string select listing the draft's gates (hidden when none; labels from `summaryLines`). A picked value applies through compile-and-revert and clears `pending`.
- i18n: `builder.cond.*` labels (kind names, placeholders, modal titles/labels at most 45 characters).

- [ ] **Step 1: Write failing tests:** the page has at most 5 rows and every id at most 100 characters; choosing each of the eight kinds shows the matching input (assert component types); a cooldown modal with `30` adds `{cooldown:30}` to the generated script; `0`, `604801` and `abc` are refused with `COOLDOWN_RANGE`/`BAD_ARGUMENT` and the draft is unchanged; a second cooldown replaces the first; a role pick adds `requirerole`; **a dangerous role (Administrator) is refused with `ROLE_DANGEROUS` and not added**; two roles for one gate produce `{requirerole:<@&a>|<@&b>}`; a permission pick, and the Other modal with `ManageMessages` and with `Nope` (`INVALID_PERMISSION`, reverted); a channel pick and a user pick add their gates; removing a gate through `rmgate` removes exactly that one; Save after conditions stores a rule whose `compiled.gates` match; every new i18n key exists in en, fr and ar.
- [ ] **Step 2:** run -> FAIL. **Step 3: Implement.** **Step 4:** run this file, the core builder test and `test/i18n.test.js` -> PASS. **Step 5: Commit** `feat(autoresponder): builder conditions page`.

---

#### Part B: Actions page

**Files:**
- Modify: `src/features/autoresponder/builder/panel.js`, `builder/handlers.js`, `src/i18n/{en,fr,ar}.json`
- Test: `test/features/autoresponder-builder-actions.test.js`

**Interfaces:**
- Consumes: Part A's pending-kind flow, `addAction`/`removeAction`.
- Produces: `PAGES` gains `actions`. A `act` string select with `addrole`, `removerole`, `setnick`, `react`, `reactreply` sets `entry.pending`; then one input row: role kinds -> RoleSelect (exactly 1); `setnick` -> a button opening modal `mnick` (one `nick` input, max 32); reactions -> a button opening modal `memoji` (one `emoji` input, max 64). An `rmact` select lists existing actions (hidden when none). Compile-and-revert gives the language's own refusals (`TOO_MANY_ROLE_ACTIONS`, `TOO_MANY_REACTIONS`, `ROLE_ABOVE_BOT`, `ROLE_ABOVE_YOU`, `ROLE_DANGEROUS`, `INVALID_EMOJI`, `NICK_TOO_LONG`).

- [ ] **Step 1: Write failing tests:** page row and id limits; `addrole` with a normal role adds `{addrole:<@&id>}`; a role above the bot -> `ROLE_ABOVE_BOT`, above the writer -> `ROLE_ABOVE_YOU`, Administrator -> `ROLE_DANGEROUS`, each reverted; a fourth role/nickname action -> `TOO_MANY_ROLE_ACTIONS`; `removerole` works; `setnick` with `Mr. {x}`-free text adds it, a 33-character nickname -> `NICK_TOO_LONG`, and a nickname containing `|` and `\` is escaped and compiles to the same text (assert `compiled.actions[0].text`); `react` with `🔥` adds, a sixth reaction (mix of `react` and `reactreply`) -> `TOO_MANY_REACTIONS`, a custom emoji of another server -> `INVALID_EMOJI`; removing an action removes exactly that one; Save stores `compiled.actions` matching the draft; i18n keys in en, fr and ar.
- [ ] **Step 2:** run -> FAIL. **Step 3: Implement.** **Step 4:** run this file, the conditions and core tests, `test/i18n.test.js` -> PASS. **Step 5: Commit** `feat(autoresponder): builder actions page`.

---

### Task 4: Reply options, Try it and script mode

**Tier:** sonnet - embed picker with the 25-option limit, a side-effect-free dry run, a one-way mode switch

#### Part A: Embed and cleanup options on the Reply page

**Files:**
- Modify: `src/features/autoresponder/builder/panel.js`, `builder/handlers.js`, `src/i18n/{en,fr,ar}.json`
- Test: `test/features/autoresponder-builder-reply.test.js`

**Interfaces:**
- Consumes: `listEmbeds(db, guildId): Promise<string[]>` from `src/features/embeds/store.js`; Task 2's reply page (its button row has room for two more buttons: five buttons maximum in a row).
- Produces: on the Reply page an Embed button and a Delete-reply button. Embed opens a view with a string select `embed` of: no embed, plain colour (opens modal `mcolor`, one `color` input, `#rrggbb` or empty), and up to 24 named embeds from `listEmbeds` (a note line when there are more); picking applies through compile-and-revert (`{embed}`, `{embed:#rrggbb}`, `{embed:<name>}`; a name deleted since the list was read -> `EMBED_NOT_FOUND`, reverted). Delete-reply opens modal `mdelreply` (one `seconds` input, empty clears it; `DELETE_REPLY_RANGE` outside 1 to 300).

- [ ] **Step 1: Write failing tests:** with 30 stored embeds the select has at most 25 options and the note line appears; picking a named embed adds `{embed:name}`; **an embed deleted between listing and picking is refused with `EMBED_NOT_FOUND` and reverted**; a plain colour with `#ec948a` and with `ec948a` (`BAD_ARGUMENT`); no embed clears it; delete-reply `10` adds `{delete_reply:10}`, `0` and `301` are refused, empty clears; the Reply page still has at most 5 rows and 5 buttons per row; Save stores `compiled.flags.embed` and `deleteReplyAfter`; i18n in en, fr and ar.
- [ ] **Step 2:** run -> FAIL. **Step 3: Implement.** **Step 4:** run this file, core, conditions, actions tests, `test/i18n.test.js` -> PASS. **Step 5: Commit** `feat(autoresponder): builder embed and delete-reply options`.

---

#### Part B: Try it

**Files:**
- Modify: `src/features/autoresponder/builder/panel.js`, `builder/handlers.js`, `src/i18n/{en,fr,ar}.json`
- Test: `test/features/autoresponder-builder-try.test.js`

**Interfaces:**
- Consumes: `describeRun` (Task 1 Part C), `matchRule` and `checkTrigger` (`match.js`), `compileScript`.
- Produces: a Try it button on the Review page opening modal `mtry` (one `sample` input, paragraph, max 1000). On submit: compile the generated script (errors -> `errorLines`), build the rule view `{ trigger, matchMode, enabled: true }`, print whether the sample matches the draft trigger (`builder.try.match` / `builder.try.nomatch`), and, when it matches or even when it does not (show it anyway under a "would run if matched" line), the `describeRun` lines for the pressing member in the current channel. Reply is ephemeral and the panel stays. It never writes the database, never sends, changes no role, writes no cooldown and no log line.

- [ ] **Step 1: Write failing tests:** a matching sample shows the match line, the gates, the rendered text with the member's placeholders and the action list; a non-matching sample shows `try.nomatch`; a failing `requirerole` shows `gate.fail`; a draft that does not compile replies with the errors; **no `INSERT`/`UPDATE`/`DELETE` reaches `db.query` (spy) and the fake member/channel throw on every write method**; output at most 2000 characters; expired panel -> `expired`; i18n in en, fr and ar.
- [ ] **Step 2:** run -> FAIL. **Step 3: Implement.** **Step 4:** run this file and the earlier builder tests -> PASS. **Step 5: Commit** `feat(autoresponder): builder Try it`.

---

#### Part C: Edit script text and script mode

**Files:**
- Modify: `src/features/autoresponder/builder/panel.js`, `builder/handlers.js`, `src/i18n/{en,fr,ar}.json`
- Test: `test/features/autoresponder-builder-script.test.js`

**Interfaces:**
- Consumes: `modalFor`-style script modal (reuse the field limits `MAX_SCRIPT` 4000), `toScriptMode` (Task 1 Part A), `compileScript`.
- Produces: an Edit script text button on the Review page. It opens modal `mscript` with one paragraph input `script` (max 4000) prefilled with `generateScript(draft)` (clipped by Discord's own limit; if the generated text is over 4000 the prefill is empty and a note says so). Cancelling the modal changes nothing. On submit: compile; errors -> `errorLines` and the draft is unchanged; success -> `toScriptMode(draft, script)` and the panel re-renders in script mode: the nav select is replaced by nothing (only Review is available), the summary is replaced by the script text in a code block (clipped with `fitLines`-style handling to fit 2000 characters, with a note when clipped), and only Try it, Edit script text (to edit the text again), Save and Cancel remain. Trigger and mode stay editable in script mode through a Basics button. There is no way back to guided mode for that draft.

- [ ] **Step 1: Write failing tests:** the modal is prefilled with the generated script; submitting a valid edited script switches to script mode and Save stores exactly that text; submitting an invalid script keeps guided mode and the draft unchanged and lists the errors; closing the modal (no submit) changes nothing (assert the entry); in script mode the nav select is gone and the summary is the code block; Edit script text again works and keeps script mode; Try it and Save work in script mode; the trigger can still be changed; a 4000-character script is accepted and a 4001-character one is refused with `SCRIPT_TOO_LONG` (Discord caps the input; test through the handler with a fake field); i18n in en, fr and ar.
- [ ] **Step 2:** run -> FAIL. **Step 3: Implement.** **Step 4:** run this file and all earlier builder tests -> PASS. **Step 5: Commit** `feat(autoresponder): builder script text editing`.

---

### Task 5: Docs, wiring check and final verification

**Tier:** sonnet - cross-cutting docs that must match the code, then run-and-report

#### Part A: Docs, help and wiring check

**Files:**
- Modify: `README.md`, `docs/testing-checklist.md` (section 16), `docs/memory/{features-built,architecture,decisions,gotchas,index}.md`, `test/features/autoresponder-wiring.test.js` (add assertions)
- Test: `test/features/autoresponder-wiring.test.js`, `test/features/help.test.js`

**Interfaces:** none new.

- [ ] **Step 1: Write failing assertions** in `autoresponder-wiring.test.js`: the `autoresponder` command definition (from `buildData()` JSON) lists `builder` together with all ten existing subcommands; `/help` lists `autoresponder builder`; the component prefix is still `autoresponder` with no duplicate prefixes.
- [ ] **Step 2:** run -> FAIL (or PASS for what already exists) and note which. **Step 3: Docs** (record only what is true in the code - read the builder files first): README `/autoresponder builder` paragraph (what the panel pages are, 15-minute sliding expiry, in-memory draft lost on restart, Try it, Edit script text and the one-way script mode, `npm run deploy` needed once for the new subcommand); testing checklist section 16 gets a "Builder" subsection (open, each page, every condition and action kind, refusals for a dangerous role and for caps, Try it has no side effects, Edit script text and script mode, Save twice, Cancel, expired panel after waiting or reopening, another member's click, non-manager, the saved rule in `list`/`show`/`edit`); memory notes: features-built (builder built, manual testing pending), architecture (files, draft store, compile-and-revert, shared dry run), decisions (draft in memory until Save, new rules only, one-way script mode, compile-and-revert instead of duplicated caps, reply text verbatim), gotchas (drafts lost on restart; 100-character custom ids; selects limited to 25 options so only the first 24 named embeds are listed; the panel needs `npm run deploy` once), index.
- [ ] **Step 4:** `npm test` -> everything passes. **Step 5: Commit** in two commits: `test(autoresponder): builder wiring assertions` and `docs(autoresponder): builder README, checklist and memory notes`.

---

#### Part B: Final verification (run after Part A is committed; commit nothing here)

**Files:** none changed.

**Interfaces:** none.

- [ ] **Step 1:** `docker compose up -d`, then `npm test` - expected: every test passes; report the counts and any failure verbatim.
- [ ] **Step 2:** `node -e "import('./src/features/autoresponder/commands.js').then(m=>console.log(JSON.stringify(m.buildData().toJSON().options.map(o=>o.name))))"` - expected: a list that contains `builder` and `enable`, `disable`, `add`, `edit`, `editmatchmode`, `toggle`, `remove`, `list`, `show`, `test`.
- [ ] **Step 3:** `graphify update .` - expected: finishes without error.
- [ ] **Step 4:** `git status --short` and `git log --oneline -15` - report; commit nothing here.

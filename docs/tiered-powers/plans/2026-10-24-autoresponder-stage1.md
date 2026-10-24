# Autoresponder, Stage 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use tiered-powers:subagent-driven-development (recommended) or tiered-powers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Staff can create autoresponder rules (a trigger plus a Mimu-style reply script) and the bot answers or acts on matching messages: matching, placeholders, gates and actions. Random functions, message arguments and buttons are stages 2 and 3 (separate plans).

**Architecture:** A new feature module `src/features/autoresponder/`. A pure pipeline (`script/parse.js` -> `script/compile.js` -> `script/evaluate.js`) turns a script into a compiled JSON stored with the rule; `match.js` chooses the one rule that runs; `execute.js` is the only code that touches Discord; `events.js` ties it to `messageCreate`. A tiny shared module `core/message-outcome.js` lets the handler learn that auto-mod already acted on a message.

**Tech Stack:** discord.js 14.27, Node 22 ESM, Postgres, RE2 (via `features/automod/regex-safe.js`), `node --test`.

**Spec:** `docs/tiered-powers/specs/2026-10-24-autoresponder-design.md` (the builder-check answers in it are binding).

## Global Constraints

- Node 22+, ESM, discord.js 14.27.0; no new dependencies.
- Every user-facing string goes in all three of `src/i18n/en.json`, `fr.json`, `ar.json` (`test/i18n.test.js` checks parity). Keys are namespaced `autoresponder.*`.
- Off by default; setup commands call `guard(interaction, ctx, 'autoresponder', { requireManager: true })` and reply ephemerally; `enable`/`disable` go through `handleToggle` (it uses `requireEnabled: false`).
- A rule: `trigger` up to 100 characters, `match_mode` one of `exact`, `startswith`, `endswith`, `includes`, `regex`, `script` up to 4000 characters. At most 100 rules per server. Trigger matching is case-insensitive and ignores surrounding whitespace; `regex` uses the same RE2 compile and length limits as auto-mod patterns (`MAX_PATTERN_LENGTH` 250).
- Which rule runs: among enabled matching rules, non-regex rules rank by trigger length (longest wins), a regex rule ranks below every matching non-regex rule and among regex rules by pattern length; ties go to the lowest rule id. Only that rule is considered: if its gates fail, nothing else runs for the message.
- Never matched: messages from bots, webhooks, the bot itself, system messages, DMs, messages auto-mod acted on, and any message while the feature is off. The bot's own replies never trigger rules.
- Order inside a script does not matter. Phases: parse and validate; evaluate gates; render the text; run actions in the fixed order delete, role changes, nickname, reactions, then the message (DM, channel, or reply in place).
- Syntax: `{name}` or `{name:arg|arg}`; backslash escapes `{` and `[`. An unknown name is a save-time error. `[` values (`[$N]`, `[range]`…) belong to stage 2.
- Stage 1 functions: gates `cooldown`, `requirerole`, `requireperm`, `requirechannel`, `requireuser`, `denyrole`, `denyperm`, `denychannel`; actions `addrole`, `removerole`, `embed`, `dm`, `sendto`, `delete`, `delete_reply`, `react`, `reactreply`, `setnick`, `silent`. The second argument of `addrole`/`removerole` is reserved: refused with `TARGET_NOT_ALLOWED_YET` until stage 2.
- Limits: at most 10 embeds, 5 reactions per script; nickname at most 32 characters; at most 3 calls of `addrole`/`removerole`/`setnick` together; cooldown 1 second to 7 days (604800); `delete_reply` 1 to 300 seconds; rendered message content at most 2000 characters (refuse at run time with a logged error, never truncate).
- Role safety: at save the writer must be able to give each role (`callerCanGive`) and it must not be dangerous (`isDangerousRole`) or above the bot (`botCanGive`); at run time only `isDangerousRole` and `botCanGive` are re-checked; roles are resolved at save to ids (a name matching more than one role is refused). "The member" is the person whose message triggered the rule.
- Pings: a script reply may ping only the triggering member and explicitly mentioned users; never roles, `@everyone` or `@here` (`allowedMentions: { parse: [], users: [...] }`).
- Gate notice: a reply to the triggering message without a ping, deleted by the bot after 8 seconds, at most one per member per rule per 30 seconds (in memory), only for cooldown and missing-role gates, never when `{silent}` is present.
- Run-time errors: a refused action is skipped, the rest still runs, one mod-log line (`modAction`) per rule per hour (in memory).
- Rules are cached per server in memory and invalidated on any change; a server with the feature off or no rules costs no database read per message.
- Migration `010_autoresponder.sql`; add new tables to the `TRUNCATE` list in `resetDb` (`src/db/index.js`).
- Tests hit the DB (`npm test`, concurrency 1); pure logic is tested without Discord. Commit style: `feat(autoresponder): ...`, the user's own git name and email, no Co-Authored-By Claude trailer (project memory rule).

## Review Focus

- A message from a bot, a webhook or the bot itself never triggers a rule, so a rule's reply cannot loop (Task 8).
- A script with an unclosed `{`, an unknown function, a stray backslash at the end, or an empty `{}` gives a save-time error with a position and never throws (Task 3).
- A catastrophic or over-long regex pattern is refused at save (Task 2) and matching a very long message does not stall (Task 2).
- A role deleted after the rule was saved: that action is skipped with one log line while the other actions still run (Task 6).
- Two messages from the same member inside the cooldown, sent at the same moment, run the rule once (Task 7).
- A message auto-mod deleted is not answered (Task 8).

---

## File Structure

- Create `src/db/migrations/010_autoresponder.sql`
- Create `src/features/autoresponder/store.js` - rules and cooldown SQL
- Create `src/features/autoresponder/match.js` - `matchRule`, `chooseRule`, `MATCH_MODES`
- Create `src/features/autoresponder/cache.js` - per-server rule cache
- Create `src/features/autoresponder/script/parse.js` - tokenizer and AST
- Create `src/features/autoresponder/script/placeholders.js` - placeholder names and `buildScriptVars`
- Create `src/features/autoresponder/script/functions.js` - the stage 1 function table
- Create `src/features/autoresponder/script/compile.js` - validation and resolution to a stored `compiled` JSON
- Create `src/features/autoresponder/script/evaluate.js` - gates and rendering, pure
- Create `src/features/autoresponder/execute.js` - runs a plan against Discord
- Create `src/features/autoresponder/cooldown.js` - atomic cooldown claim and pruning
- Create `src/features/autoresponder/throttle.js` - in-memory notice and error-log throttles
- Create `src/features/autoresponder/events.js` - the `messageCreate` handler
- Create `src/features/autoresponder/log.js` - mod-log line for run-time errors and setup actions
- Create `src/features/autoresponder/commands.js` - `/autoresponder` and the editor modal
- Create `src/features/autoresponder/index.js`
- Create `src/core/message-outcome.js` - "auto-mod acted on this message" signal
- Modify `src/features/automod/events.js` and `enforce.js` (outcome signal), `src/db/index.js`, `src/modules.js`, `src/core/registry.js`, `src/i18n/{en,fr,ar}.json`, `README.md`, `docs/testing-checklist.md`, `docs/memory/*`
- Tests in `test/features/autoresponder-*.test.js` and `test/core/message-outcome.test.js`

---

### Task 1: Migration, store and cache

**Files:**
- Create: `src/db/migrations/010_autoresponder.sql`, `src/features/autoresponder/store.js`, `src/features/autoresponder/cache.js`
- Modify: `src/db/index.js` (the `TRUNCATE` list)
- Test: `test/features/autoresponder-store.test.js`

**Tier:** sonnet - migration plus SQL concurrency (the 100-rule cap, the atomic cooldown claim lives in Task 7)

**Interfaces:**
- Produces in `store.js` (all take `db` first; ids are numbers for rules, strings for guilds/users):
  - `MAX_RULES = 100`
  - `createRule(db, { guildId, trigger, matchMode, script, compiled, createdBy }): Promise<Rule | 'full'>`
  - `getRule(db, guildId, id): Promise<Rule | null>`
  - `listRules(db, guildId): Promise<Rule[]>` (ordered by id)
  - `updateRule(db, guildId, id, patch): Promise<boolean>` - patch keys any of `trigger, matchMode, script, compiled, enabled`
  - `deleteRule(db, guildId, id): Promise<boolean>`
  - `Rule = { id, guildId, trigger, matchMode, script, compiled, enabled, createdBy, createdAt }`
- Consumes in `cache.js`: `getFeature` from `src/db/settings.js` (the on/off flag is stored in `guild_settings` under the feature key `autoresponder`).
- Produces in `cache.js`: `getRules(db, guildId): Promise<Rule[]>` - the enabled rules, or `[]` while the feature is off; one read of the flag plus one of the rules on a cache miss, then served from memory; `invalidate(guildId): void` (called on every rule change AND on `enable`/`disable`), `clearCache(): void` (tests).

- [ ] **Step 1: Write failing tests** in `autoresponder-store.test.js` (pattern: `test/features/reactionroles-store.test.js`): `createRule then getRule returns the stored fields` (compiled round-trips as JSON); `listRules orders by id and is per guild`; `createRule returns 'full' for the 101st rule of a guild and a second guild is unaffected`; `two concurrent createRule calls on a guild at 99 rules produce exactly one 'full'`; `updateRule changes only the given keys and returns false for another guild's id`; `deleteRule is per guild`; cache: `getRules returns only enabled rules`, `getRules returns [] while the feature is off and the rules once it is switched on and invalidate is called`, `a second getRules call does not query the database` (spy on `db.query`), `invalidate makes the next call re-read`.
- [ ] **Step 2:** `node --test --test-concurrency=1 test/features/autoresponder-store.test.js` -> FAIL (module missing).
- [ ] **Step 3: Write migration 010:** `autoresponder_rules(id SERIAL PRIMARY KEY, guild_id TEXT NOT NULL, trigger TEXT NOT NULL, match_mode TEXT NOT NULL, script TEXT NOT NULL, compiled JSONB NOT NULL, enabled BOOLEAN NOT NULL DEFAULT true, created_by TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now())` with an index on `guild_id`; `autoresponder_cooldowns(rule_id INTEGER NOT NULL REFERENCES autoresponder_rules(id) ON DELETE CASCADE, user_id TEXT NOT NULL, until TIMESTAMPTZ NOT NULL, PRIMARY KEY (rule_id, user_id))`. Add `autoresponder_rules, autoresponder_cooldowns` to the `TRUNCATE` list in `resetDb`.
- [ ] **Step 4: Implement `store.js` and `cache.js`.** `createRule` runs in a transaction that first takes `pg_advisory_xact_lock(hashtext($guildId))`, counts the guild's rules, and inserts only below `MAX_RULES` (so two concurrent creates cannot both pass 99). The cache is a `Map` keyed by guild holding the enabled rules; it must never be used for `list`/`show` commands (those read the store).
- [ ] **Step 5:** run the test file -> PASS; run `node --test --test-concurrency=1 test/db` to confirm migrations still apply.
- [ ] **Step 6: Commit** `feat(autoresponder): tables, store and rule cache`.

---

### Task 2: Matching and rule choice

**Files:**
- Create: `src/features/autoresponder/match.js`
- Test: `test/features/autoresponder-match.test.js`

**Tier:** sonnet - ranking rules with many edge cases, RE2 integration

**Interfaces:**
- Consumes: `compilePatterns`, `validatePattern`, `matchPatterns`, `MAX_PATTERN_LENGTH`, `MAX_TEST_LENGTH` from `src/features/automod/regex-safe.js` (read its exact signatures first).
- Produces: `MATCH_MODES = ['exact','startswith','endswith','includes','regex']`; `checkTrigger(trigger, matchMode): { ok: true } | { ok: false, code: 'EMPTY_TRIGGER' | 'TRIGGER_TOO_LONG' | 'BAD_MODE' | 'BAD_REGEX' }` (regex validated through `validatePattern`); `matchRule(rule, text): boolean`; `chooseRule(rules, text): Rule | null`.

- [ ] **Step 1: Write failing tests:** `exact` matches the whole message ignoring case and surrounding whitespace and not a longer message; `startswith`, `endswith`, `includes` each match their position (`'!hug @sam'` startswith `'!hug'`; `'oh !hug'` does not; `'dumbo'` includes `'dumb'` - substring, no word boundary); `regex` matches through RE2 and a catastrophic pattern such as `(a+)+$` is refused by `checkTrigger` (code `BAD_REGEX`) rather than hanging; a pattern over 250 characters is refused; text over `MAX_TEST_LENGTH` for a regex rule does not match and does not throw; `chooseRule` returns the longest non-regex trigger (`'!hug'` startswith beats `'hug'` includes), ties go to the lower id, a matching regex rule loses to any matching non-regex rule and wins only when alone, `null` for no match, and disabled rules are ignored; an empty trigger and a 101-character trigger are refused by `checkTrigger`.
- [ ] **Step 2:** run -> FAIL.
- [ ] **Step 3: Implement** the functions. Normalise with `trim().toLowerCase()` (locale-independent) on both sides for the non-regex modes; compile regex rules once per rule via `compilePatterns` with a small `WeakMap`/`Map` keyed by rule id and pattern; `chooseRule` sorts candidates by (non-regex first, trigger length descending, id ascending).
- [ ] **Step 4:** run -> PASS. **Step 5: Commit** `feat(autoresponder): rule matching and choice`.

---

### Task 3: Script parser

**Files:**
- Create: `src/features/autoresponder/script/parse.js`
- Test: `test/features/autoresponder-parse.test.js`

**Tier:** sonnet - a small hand-written parser; the tests define it fully

**Interfaces:**
- Produces: `parseScript(source: string): { ok: true, nodes: Node[] } | { ok: false, errors: ScriptError[] }` where `Node = { t: 'text', v: string } | { t: 'call', name: string, args: string[], pos: number }` and `ScriptError = { code: string, pos: number, detail?: string }`. A `{name}` with no colon is a call with no args; the compiler (Task 4) decides whether it is a placeholder or a function. Codes: `UNBALANCED_BRACE`, `EMPTY_NAME`, `BAD_NAME`, `TRAILING_BACKSLASH`.

- [ ] **Step 1: Write failing tests:** plain text becomes one `text` node; `'Hi {user}!'` becomes text, call `user` (no args), text; `'{cooldown:30}'` has args `['30']`; `'{requirerole:Mods|Admins}'` splits on unescaped `|` into two args and trims each; `\{` and `\[` and `\|` and `\\` become literal characters in text and in args; `{embed:#ec948a}` keeps the `#` colour as one arg; text nodes keep line breaks; an unclosed `{` returns `UNBALANCED_BRACE` with the position of the `{`; `}` with no opening is plain text; `{}` returns `EMPTY_NAME`; `{bad name}` (a space or character outside `a-z0-9_`, case-insensitive) returns `BAD_NAME`; a trailing lone backslash returns `TRAILING_BACKSLASH`; several errors are all reported in one pass in order; a 4000-character script of plain text parses in under 50 ms; nested braces inside an argument (`{sendto:{user}}`) are an error (`UNBALANCED_BRACE` at the inner `{` - nesting is not supported).
- [ ] **Step 2:** run -> FAIL.
- [ ] **Step 3: Implement** `parseScript` as a single left-to-right scan with an escape flag; name characters `[A-Za-z0-9_]`, lower-cased in the node; `pos` is the zero-based character index of the opening `{`; never throws on any input (including an empty string -> `{ ok: true, nodes: [] }`).
- [ ] **Step 4:** run -> PASS. **Step 5: Commit** `feat(autoresponder): script parser`.

---

### Task 4: Function table, placeholders and compiler

**Files:**
- Create: `src/features/autoresponder/script/placeholders.js`, `script/functions.js`, `script/compile.js`
- Test: `test/features/autoresponder-compile.test.js`

**Tier:** sonnet - validation rules across many functions, role/channel/embed resolution

**Interfaces:**
- Consumes: `parseScript` (Task 3); `parseEmoji` from `src/features/reactionroles/config.js` (reuse; do not copy); `isDangerousRole`, `botCanGive`, `callerCanGive` from `src/core/role-safety.js`; `getEmbed` from `src/features/embeds/store.js`; `buildVars` from `src/core/placeholders.js`.
- Produces in `placeholders.js`: `PLACEHOLDER_NAMES: Set<string>` (the keys `buildVars` returns plus `user_id, user_nick, user_joindate, user_createdate, user_displaycolor, user_boostsince, server_id, server_boostlevel, channel, channel_name, message_id, message_content, message_link`); `buildScriptVars({ message, member, guild, lang, now? }): Record<string, string|number>` (spreads `buildVars` and adds the extras; dates as `<t:unix:D>`, `user_boostsince` as `<t:unix:D>` or an empty string).
- Produces in `compile.js`: `compileScript(source, env): Promise<{ ok: true, compiled: Compiled } | { ok: false, errors: ScriptError[] }>` with `env = { db, guild, writer }` (`writer` is the GuildMember saving the rule). `Compiled = { version: 1, template: Part[], gates: Gate[], actions: Action[], flags: { silent: boolean, dm: boolean, delete: boolean, embed: null | { kind: 'plain', color: number|null } | { kind: 'named', name: string }, sendTo: string|null, deleteReplyAfter: number|null } }` where `Part = { t: 'text', v } | { t: 'ph', name }`, `Gate = { fn: 'cooldown', seconds } | { fn: 'requirerole'|'denyrole', roleIds: string[] } | { fn: 'requireperm'|'denyperm', perms: string[] } | { fn: 'requirechannel'|'denychannel', channelIds: string[] } | { fn: 'requireuser', userIds: string[] }`, `Action = { fn: 'addrole'|'removerole', roleId, raw } | { fn: 'setnick', text } | { fn: 'react', emoji } | { fn: 'reactreply', emoji }`. The result contains only JSON-safe values.
- Error codes added here (each gets an i18n key in Task 9): `UNKNOWN_FUNCTION`, `MISSING_ARGUMENT`, `BAD_ARGUMENT`, `TOO_MANY_ARGUMENTS`, `DUPLICATE_FUNCTION` (a second `cooldown`, `embed`, `sendto`, `dm`, `delete`, `delete_reply`, `silent`), `COOLDOWN_RANGE`, `DELETE_REPLY_RANGE`, `TOO_MANY_EMBEDS`, `TOO_MANY_REACTIONS`, `TOO_MANY_ROLE_ACTIONS`, `ROLE_NOT_FOUND`, `ROLE_AMBIGUOUS`, `ROLE_DANGEROUS`, `ROLE_ABOVE_BOT`, `ROLE_ABOVE_YOU`, `CHANNEL_NOT_FOUND`, `EMBED_NOT_FOUND`, `INVALID_PERMISSION`, `INVALID_USER`, `INVALID_EMOJI`, `NICK_TOO_LONG`, `TARGET_NOT_ALLOWED_YET`, `SCRIPT_TOO_LONG`, plus the parser's codes.

- [ ] **Step 1: Write failing tests** (fake guild with roles/channels caches, fake writer with a top role, the real test DB for `getEmbed`): a script of only text compiles to a single text part; `{user}` becomes a `ph` part; an unknown name -> `UNKNOWN_FUNCTION`; `{cooldown:30}` -> gate; `{cooldown:0}`, `{cooldown:604801}` and `{cooldown:abc}` -> `COOLDOWN_RANGE`/`BAD_ARGUMENT`; two cooldowns -> `DUPLICATE_FUNCTION`; `{requirerole:Mods}` resolves a role by exact case-insensitive name, by `<@&id>` and by raw id to `roleIds`, a name shared by two roles -> `ROLE_AMBIGUOUS`, an unknown role -> `ROLE_NOT_FOUND`; `{addrole:Staff}` where Staff has Administrator -> `ROLE_DANGEROUS`, a role at or above the bot -> `ROLE_ABOVE_BOT`, above the writer (non-owner) -> `ROLE_ABOVE_YOU`, the owner writer may give a role below the bot; `{addrole:Red|@sam}` -> `TARGET_NOT_ALLOWED_YET`; a fourth role/nick action -> `TOO_MANY_ROLE_ACTIONS`; `{embed:#ec948a}` -> plain colour, `{embed}` -> plain with no colour, `{embed:welcome}` -> named (missing name -> `EMBED_NOT_FOUND`); eleven `{embed}`-style embeds cannot occur (one `embed` allowed) so `TOO_MANY_EMBEDS` is not reachable in stage 1 and is not tested; six `{react:...}` -> `TOO_MANY_REACTIONS`; `{react:🔥}` valid, a custom emoji of another server -> `INVALID_EMOJI`; `{setnick:` + 33 characters + `}` -> `NICK_TOO_LONG`; `{requireperm:ManageMessages}` valid (case-insensitive flag name), `{requireperm:Nope}` -> `INVALID_PERMISSION`; `{sendto:#chat}` by mention, id or name; unknown -> `CHANNEL_NOT_FOUND`; `{requireuser:<@id>}` and a raw id valid, `{requireuser:abc}` -> `INVALID_USER`; a 4001-character script -> `SCRIPT_TOO_LONG`; several independent errors are all reported; the returned `compiled` survives `JSON.parse(JSON.stringify(...))` unchanged; every `ph` name is in `PLACEHOLDER_NAMES`.
- [ ] **Step 2:** run -> FAIL.
- [ ] **Step 3: Implement** `placeholders.js`, a function table in `functions.js` (name -> `{ min, max, check(args, env, acc) }` writing into an accumulator, so adding stage 2 functions later means adding table rows), and `compileScript` (parse, then walk nodes: a call whose name is in `PLACEHOLDER_NAMES` and has no args becomes a `ph` part; a call in the function table runs its `check`; anything else is `UNKNOWN_FUNCTION`). Permission names validate against `PermissionsBitField.Flags` keys (case-insensitive, stored in canonical form).
- [ ] **Step 4:** run -> PASS. **Step 5: Commit** `feat(autoresponder): function table, placeholders and script compiler`.

---

### Task 5: Evaluator

**Files:**
- Create: `src/features/autoresponder/script/evaluate.js`
- Test: `test/features/autoresponder-evaluate.test.js`

**Tier:** sonnet - pure logic with a precise output shape

**Interfaces:**
- Consumes: `Compiled`, `buildScriptVars` (Task 4); `renderPlaceholders` from `src/core/placeholders.js`.
- Produces: `evaluate(compiled, ctx): Plan` with `ctx = { member, channelId, vars }` (`member` has `id`, `roles.cache`, `permissions`; `vars` from `buildScriptVars`) and
  `Plan = { status: 'skip', gate: 'cooldown'|'role'|'perm'|'channel'|'user', notice: boolean } | { status: 'run', cooldown: number|null, text: string, flags: Compiled['flags'], actions: Action[] }`.
  Gate logic: `requirerole`/`requireperm`/`requirechannel`/`requireuser` pass when the member matches ANY listed value; `denyrole`/`denyperm`/`denychannel` fail when the member matches ANY. The `cooldown` gate is NOT checked here (it needs the database): it is returned as `cooldown` seconds for the handler. `notice` is true only for a failed `requirerole` (gate `role`) and only when `flags.silent` is false.

- [ ] **Step 1: Write failing tests:** text-only script -> `run` with the text; `ph` parts render from `vars` and an unknown `ph` key renders as an empty string (never as `{name}`); each gate type passes and fails correctly (any-of for the `require*`, any-of-denies for `deny*`); a failed `requirerole` gives `skip` with `notice: true`, with `silent` it gives `notice: false`; a failed `requireperm`/`requirechannel`/`requireuser`/`deny*` gives `notice: false`; with several gates the first failing one in script order wins; `cooldown` seconds are returned on `run` and are `null` when absent; evaluate does not mutate `compiled` (deep-frozen input does not throw); the rendered text is trimmed of surrounding whitespace but keeps inner line breaks; output carries `actions` and `flags` unchanged from `compiled`.
- [ ] **Step 2:** run -> FAIL. **Step 3: Implement** `evaluate`. **Step 4:** run -> PASS. **Step 5: Commit** `feat(autoresponder): script evaluator`.

---

### Task 6: Executor

**Files:**
- Create: `src/features/autoresponder/execute.js`, `src/features/autoresponder/throttle.js`, `src/features/autoresponder/log.js`
- Test: `test/features/autoresponder-execute.test.js`

**Tier:** sonnet - Discord side effects, partial failure handling, role safety at run time

**Interfaces:**
- Consumes: `Plan` (Task 5), `buildEmbedPayload`/`getEmbed` (embeds), `safeMentions` is NOT used (build `allowedMentions` here), `trySend`, `isDangerousRole`, `botCanGive`, `sendLog`.
- Produces in `throttle.js`: `createThrottle(everyMs, now = Date.now): { allow(key: string): boolean }` (true at most once per key per window; bounded to 5000 keys, oldest evicted).
- Produces in `log.js`: `logAutoresponder(ctx, guild, lang, { action, actorId, ruleId, detail }, deps = {}): Promise<void>` (one `modAction` line, never throws, modelled on `reactionroles/log.js`), and `logRunError(ctx, guild, lang, { ruleId, errors }, deps = {})` throttled once per rule per hour via `createThrottle(3600000)`.
- Produces in `execute.js`: `executePlan(ctx, { rule, message, member, plan, lang }, deps = {}): Promise<{ errors: RunError[] }>` with `RunError = { code: string, action: string, detail?: string }`; run-time codes `ROLE_MISSING`, `ROLE_UNSAFE`, `CANNOT_MANAGE_NICK`, `CANNOT_DELETE`, `CANNOT_REACT`, `CANNOT_DM`, `CANNOT_SEND`, `RENDERED_TOO_LONG`, `EMBED_FAILED`. Also exports `scheduleDelete(message, seconds, deps)` (in-memory `setTimeout`, unref'd, best effort, not restart-safe) used for `delete_reply` and gate notices, and `sendGateNotice(ctx, message, lang, deps)`.
- Order: delete the trigger message; role changes with SINGLE-role calls (`member.roles.add(id)` / `remove(id)`, never the array forms - see `docs/memory/gotchas.md`); nickname; `react` on the trigger message; then the message: the rendered text (and the plain or named embed) goes to the DM, the `sendto` channel, or as a reply to the trigger message (a `reply` with `failIfNotExists: false`; if the trigger was deleted by `{delete}`, send to the channel instead); then `reactreply` on the sent message; then `delete_reply`. Every step is in its own try/catch and appends a `RunError`.
- `allowedMentions` is `{ parse: [], users: <ids found as <@id> in the final text>, repliedUser: false }`; roles, everyone and here are never allowed.

- [ ] **Step 1: Write failing tests** with fakes that record calls: actions run in the fixed order (record the call sequence: delete, role, nick, react, send, reactreply); `addrole` uses `roles.add(id)` with a single id; a role deleted since save -> `ROLE_MISSING`, the other actions still run; a role that became dangerous -> `ROLE_UNSAFE` and no add; a role the bot can no longer give -> `ROLE_UNSAFE`; `removerole` of a role the member lacks is not an error; `setnick` on a member the bot cannot manage -> `CANNOT_MANAGE_NICK`; DM closed (`send` throws 50007) -> `CANNOT_DM` and the other steps still happened; `{sendto}` to a channel the bot cannot send in -> `CANNOT_SEND`; in-place reply uses the message reply with no ping of the replied user, falls back to channel send when `{delete}` removed the trigger; a text containing `@everyone`, `@here` and a role mention produces `allowedMentions` with no `everyone`/`roles` and `parse: []`, while `<@123>` is allowed in `users`; rendered text over 2000 characters -> `RENDERED_TOO_LONG` and nothing sent; a named embed missing at run time -> `EMBED_FAILED` while the text still sends; `delete_reply` schedules a delete via the injected timer function; `createThrottle` allows once per window and again after the window, `logRunError` writes one line for two calls in the same hour and one for a different rule; `logAutoresponder` never throws when `sendLog` throws.
- [ ] **Step 2:** run -> FAIL. **Step 3: Implement** the three modules. **Step 4:** run -> PASS. **Step 5: Commit** `feat(autoresponder): executor, throttles and logging`.

---

### Task 7: Cooldowns

**Files:**
- Create: `src/features/autoresponder/cooldown.js`
- Test: `test/features/autoresponder-cooldown.test.js`

**Tier:** sonnet - an atomic SQL claim under concurrency

**Interfaces:**
- Produces: `claimCooldown(db, ruleId, userId, seconds, now = Date.now()): Promise<{ ok: true } | { ok: false, retryAfterMs: number }>` (one `INSERT ... ON CONFLICT (rule_id, user_id) DO UPDATE SET until = ... WHERE autoresponder_cooldowns.until <= now RETURNING`; no row returned means the cooldown is still running); `pruneCooldowns(ctx, { now }): Promise<number>` (deletes expired rows; this is the `housekeeping` function shape `(ctx, { now })` used by `core/scheduler.js`); `clearRuleCooldowns(db, ruleId)`.

- [ ] **Step 1: Write failing tests:** the first claim is ok and a second claim inside the window returns `ok: false` with a positive `retryAfterMs`; after the window it is ok again; two different users or two different rules do not interfere; **two simultaneous claims (`Promise.all`) for the same rule and user give exactly one `ok: true`**; `pruneCooldowns` removes only expired rows and returns the count; deleting a rule cascades its cooldown rows.
- [ ] **Step 2:** run -> FAIL. **Step 3: Implement.** **Step 4:** run -> PASS. **Step 5: Commit** `feat(autoresponder): atomic per-member cooldowns`.

---

### Task 8: Message handler and the auto-mod signal

**Files:**
- Create: `src/core/message-outcome.js`, `src/features/autoresponder/events.js`
- Modify: `src/features/automod/events.js`, `src/features/automod/enforce.js`
- Test: `test/core/message-outcome.test.js`, `test/features/autoresponder-events.test.js`; run `test/features/automod-events.test.js` and `automod-enforce.test.js` to prove nothing regressed

**Tier:** sonnet - ordering between two listeners and a change to existing tested code

**Interfaces:**
- Produces in `message-outcome.js`: `beginOutcome(messageId): void` (registers a pending outcome, bounded to 2000 entries), `markActed(messageId): void`, `finishOutcome(messageId): void`, `awaitOutcome(messageId, timeoutMs = 3000): Promise<'clean' | 'acted'>` (resolves when `finishOutcome` is called, or `'clean'` on timeout or when no outcome was begun; entries are removed after 30 seconds).
- Auto-mod change: in `automod/events.js` `onCreate` call `beginOutcome(message.id)` as its FIRST statement (before any `await`, so it runs before the autoresponder listener, which is later in `modules.js`), wrap the existing call in `try/finally` and call `finishOutcome(message.id)` in the `finally`; in `automod/enforce.js` call `markActed(message.id)` before the message is deleted or any action is taken (only when a `message` is present).
- Produces in `autoresponder/events.js`: `createEvents(deps = {}): Event[]` and `export const events`, one `{ name: Events.MessageCreate, execute }` entry. The handler: ignore when `message.author?.bot`, `message.webhookId`, `message.system`, no `message.guild`, or `message.author.id === client.user.id`; call `getRules(db, guildId)` (it already returns `[]` while the feature is off, and is served from memory, so a server with the feature off or no rules costs no database read per message) and stop on an empty list; `chooseRule(rules, message.content)`; if none, stop; `await awaitOutcome(message.id)` and stop when `'acted'`; fetch the member (`message.member` or `guild.members.fetch`, stop on failure); `evaluate`; on `skip` send the gate notice if `notice` and `throttle.allow(guildId:ruleId:userId)` (30 s); on `run` claim the cooldown (Task 7) when `plan.cooldown` is set and stop (with a notice if allowed) when it is running; then `executePlan`; if `errors.length` call `logRunError`. Wrap the whole handler in `safe('autoresponderMessage', ...)` from `features/logging/send-log.js`.

- [ ] **Step 1: Write failing tests.** `message-outcome`: `awaitOutcome` resolves `'acted'` after `markActed` + `finishOutcome`; `'clean'` after `finishOutcome` alone; `'clean'` for an unknown id; `'clean'` after the timeout when `finishOutcome` never comes; the map stays bounded. `autoresponder-events` (fakes for message/guild/member, a seeded rule in the real test DB, `executePlan` injected): a bot author, a webhook message, a system message, a DM and the bot's own message never reach `chooseRule` (spy); a message in a server with no rules or with the feature off causes no `db.query` call after the first cached read (spy on `db.query`) and executes nothing; no matching rule -> nothing; a matching rule runs `executePlan` once with the chosen rule; the longest-trigger rule wins when two match; a message auto-mod acted on (`beginOutcome`, `markActed`, `finishOutcome` before the handler resolves) is not answered; a failed `requirerole` gate sends one notice and a second identical message inside 30 seconds sends none; `{silent}` suppresses the notice; two simultaneous messages by one member inside a cooldown run `executePlan` exactly once; errors from `executePlan` produce one `logRunError` call; an exception inside the handler does not escape. `automod-events`: `beginOutcome` is called synchronously before the first `await` (assert with a spy that fires before the engine fake is awaited) and `finishOutcome` runs even when the engine throws; `automod-enforce`: `markActed` is called before `message.delete`.
- [ ] **Step 2:** run -> FAIL. **Step 3: Implement.** **Step 4:** run the new tests plus the existing automod events/enforce/pipeline tests -> PASS. **Step 5: Commit** `feat(autoresponder): message handler and auto-mod outcome signal`.

---

### Task 9: Commands and the script editor

**Files:**
- Create: `src/features/autoresponder/commands.js`, `src/features/autoresponder/index.js`
- Modify: `src/i18n/{en,fr,ar}.json`
- Test: `test/features/autoresponder-commands.test.js`

**Tier:** sonnet - multi-file integration with a modal flow and i18n

**Interfaces:**
- Consumes: Tasks 1 to 8; `guard`, `handleToggle`, `ephemeral`, `fitLines` (`src/features/reactionroles/setup.js` - reuse), `compileScript`, `checkTrigger`, `invalidate` (cache), `logAutoresponder`.
- Produces: `createAutoresponderCommand()` returning `{ data, execute, components: { prefix: 'autoresponder', handle } }`; `index.js` exports `commands`, `events`, `housekeeping = [pruneCooldowns]`. Subcommands: `enable`, `disable` (both call `invalidate(guildId)` after the toggle, so the cache sees the flag at once), `add` (option `match`, default `exact`), `edit` (`id`), `editmatchmode` (`id`, `match`), `toggle` (`id`), `remove` (`id`), `list`, `show` (`id`). `add` and `edit` answer with `interaction.showModal`: customId `autoresponder:m:add:<match>` or `autoresponder:m:edit:<id>`, two fields - `trigger` (short, max 100) and `script` (paragraph, max 4000, prefilled on edit). The modal submit validates with `checkTrigger` and `compileScript` (writer = the submitting member) and either replies with the localized errors (each `autoresponder.error.<CODE>` with `{detail}` and the position, at most 10 lines, fitted to 2000 characters) or saves, invalidates the cache, writes one mod-log line, and replies with the rule id. Removing or editing a rule also clears its cooldowns; `remove` asks for no confirmation (it is reversible by re-adding). All replies ephemeral. `list` and `show` read the store (not the cache) and truncate with `fitLines`.
- i18n keys to add in en, fr, ar: `autoresponder.created`, `.updated`, `.removed`, `.toggled`, `.matchChanged`, `.gone`, `.full`, `.list.none`, `.list.line`, `.show.head`, `.badTrigger.<EMPTY_TRIGGER|TRIGGER_TOO_LONG|BAD_MODE|BAD_REGEX>`, `.modal.title`, `.modal.trigger`, `.modal.script`, `.errors.head`, `.error.<CODE>` for every code listed in Tasks 3 and 4, `.notice.cooldown` (`{seconds}`), `.notice.role`, `.log.title`, `.log.moderator`, `.log.rule`, `.log.error` (run-time error line with `{code}`), `.run.<RunError code>`. Modal titles and labels at most 45 characters in every language.

- [ ] **Step 1: Write failing tests** (fake interactions as in `reactionroles-commands.test.js`; real DB): after `enable`/`disable` the next message sees the new state (cache invalidated); while the feature is off every subcommand except `enable`/`disable` is refused with the "off" reply and a normal member is refused everywhere; `add` shows a modal with the documented customId and two inputs of the documented lengths; submitting a valid script stores the rule (with `compiled`), invalidates the cache (the next `getRules` sees it), writes exactly one mod-log line and replies with the id; submitting a script with two errors stores nothing, writes no log line and replies listing both localized codes with positions; a bad regex trigger is refused with `badTrigger.BAD_REGEX`; the 101st rule replies `autoresponder.full`; `edit` prefills trigger and script and saves changes; `editmatchmode` re-validates the stored trigger under the new mode and refuses an invalid combination; `toggle` flips `enabled` and the cache drops it; `remove` deletes the rule and its cooldown rows; a rule id from another server replies `gone`; `list` with 120 stored lines stays under 2000 characters with the "and N more" line; every `autoresponder.error.<CODE>` and `autoresponder.run.<CODE>` exists in en, fr and ar (loop over the code arrays exported from `compile.js` and `execute.js`).
- [ ] **Step 2:** run -> FAIL. **Step 3: Implement** `commands.js` and `index.js`; add the keys to all three locale files. **Step 4:** run the new tests and `test/i18n.test.js` -> PASS. **Step 5: Commit** `feat(autoresponder): /autoresponder commands and the script editor`.

---

### Task 10: The `test` dry run

**Files:**
- Modify: `src/features/autoresponder/commands.js`, `src/i18n/{en,fr,ar}.json`
- Test: `test/features/autoresponder-testcmd.test.js`

**Tier:** sonnet - reuses the pure pipeline; needs care to have no side effects

**Interfaces:**
- Consumes: `getRules` is NOT used (read the store so disabled rules can be tried too: `listRules`), `chooseRule`, `evaluate`, `buildScriptVars`.
- Produces: the subcommand `test` with a required string option `message` (what a member would type). It builds a context from the invoking member and channel, finds the rule that would run, and replies ephemerally with: the matching rule (id, trigger, mode) or "no rule matches"; whether it is disabled; the result of each gate (pass/fail and, for a failed gate, which); the rendered text; and the action list in execution order (delete, roles, nickname, reactions, message route). It never sends a message, changes a role, writes a cooldown or a log line, and never calls `executePlan`.
- i18n keys: `autoresponder.test.none`, `.test.rule`, `.test.disabled`, `.test.gates`, `.test.gate.pass`, `.test.gate.fail`, `.test.text`, `.test.actions`, `.test.action.<fn>`.

- [ ] **Step 1: Write failing tests:** a message matching one rule replies with that rule, `pass` for its gates and the rendered text with the invoking member's placeholders; two matching rules show only the winner; a failing `requirerole` shows `fail` for that gate; a disabled matching rule is tried and flagged; no match replies `test.none`; **the command makes no Discord side-effect calls and no database writes** (fakes throw on `send`, `reply` to a channel, `roles.add`, and a spy on `db.query` sees only SELECTs); output stays under 2000 characters (use `fitLines`).
- [ ] **Step 2:** run -> FAIL. **Step 3: Implement.** **Step 4:** run -> PASS. **Step 5: Commit** `feat(autoresponder): /autoresponder test dry run`.

---

### Task 11: Wiring, docs and checklist

**Files:**
- Modify: `src/modules.js`, `src/core/registry.js:29`, `README.md`, `docs/testing-checklist.md`, `docs/memory/{roadmap,features-built,architecture,decisions,gotchas}.md`, `docs/memory/index.md`
- Test: `test/features/autoresponder-wiring.test.js`

**Tier:** sonnet - cross-cutting edits across several files

**Interfaces:**
- Produces: registry entry `f('autoresponder', 3, 'autoresponder', { enableCommand: 'autoresponder enable' })` replacing the stub; `import * as autoresponder from './features/autoresponder/index.js'` appended to `modules` AFTER `automod` (the message listeners must run in that order); no new intents.

- [ ] **Step 1: Write failing test** `autoresponder-wiring.test.js`: `collectModules(modules)` loads with no duplicate command, component prefix or job type and has the `autoresponder` command and component prefix; the `autoresponder` module appears after `automod` in the `modules` array; the registry entry has `command: 'autoresponder'`; `/help` lists the command (follow `test/features/help.test.js`); the housekeeping list contains `pruneCooldowns`.
- [ ] **Step 2:** run -> FAIL. **Step 3: Make the edits.** README: a `/autoresponder` section (what a rule is, the four plus regex match modes, the stage 1 functions and placeholders with one worked example each, the gate notice behaviour, that stages 2 and 3 are coming, the permissions the bot needs: Send Messages, Manage Roles, Manage Messages, Add Reactions, Manage Nicknames). `docs/testing-checklist.md`: a new section 16 (the existing "Permissions and robustness" section moves to 17; grep for references to the old number first and update them) covering: add/edit/list/show/remove/toggle/editmatchmode, each match mode, longest-trigger wins, regex refused when catastrophic, every stage 1 function and gate, role safety at save and at run, mentions never ping roles/everyone, `{delete_reply}`, the gate notice and its throttle, cooldown, the `test` dry run, a message auto-mod deleted is not answered, the feature disabled, a script error list in all languages. Memory notes: move the autoresponder from "planned" to "stage 1 built, manual testing pending", architecture (the file list, the script pipeline, the outcome signal, the tables, the housekeeping), decisions (two-phase evaluation, atomic cooldown claim, regex ranks last, no fall-through, role safety split between save and run), gotchas (an unclosed `{` is an error, nesting unsupported, `delete_reply` is lost on restart, single-role calls, the auto-mod ordering dependency on `modules.js` order), and `index.md`. Record only what is true in the code.
- [ ] **Step 4:** run `npm test` -> everything passes. **Step 5: Commit** in two commits: `feat(autoresponder): register the feature` (code and the wiring test) and `docs(autoresponder): README, testing checklist and memory notes`.

---

### Task 12: Final verification

**Files:** none changed.

**Tier:** haiku - run commands and report

**Interfaces:** none.

- [ ] **Step 1:** `npm test` - expected: every test passes; report the counts and any failure verbatim.
- [ ] **Step 2:** `node -e "import('./src/modules.js').then(m=>console.log(m.modules.length))"` - expected output `16`.
- [ ] **Step 3:** `graphify update .` - expected: finishes without error.
- [ ] **Step 4:** `git status --short` and `git log --oneline -15` - report; commit nothing here.

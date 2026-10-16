# Auto-mod Phase 1: Core Engine Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use tiered-powers:subagent-driven-development (recommended) or tiered-powers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Auto-mod that scans messages for spam, invites, links and bad words, counts strikes with tiered escalation, enforces through the existing moderation actions, renames bad nicknames, and keeps a short history.

**Architecture:** A new feature `automod` in `src/features/automod/` (registry stub already exists as `f('automod', 2, null)`). Small pure modules (normaliser, detectors, strike counter) feed one pipeline that deletes the message, adds strikes, and calls moderation's `runAction` for warn/timeout. Strikes live in memory (sliding window); history is a DB table. Phase 2 (`2026-10-16-automod-phase2-advanced.md`) adds regex, honeypot, timed role, account-age conditions and the native AutoMod trigger.

**Tech Stack:** Node 22 ESM, discord.js 14, Postgres, `node:test` (`npm test`, `--test-concurrency=1`).

**Spec:** `docs/tiered-powers/specs/2026-10-16-automod-design.md`

## Global Constraints
- Own feature key `automod`, off by default, own `/automod enable|disable` (my call, differs from the spec's "off until `/moderation enable`": the registry already has an `automod` stub and a separate toggle keeps `/help` clean). It reuses moderation's `runAction`, `readConfig` and `canUseAction`.
- Configure with Manage Server or the bot manager role (use `guard(interaction, ctx, 'automod', {requireEnabled:false})`); replies ephemeral.
- Every user-facing string goes in `src/i18n/en.json`, `fr.json` and `ar.json` (the i18n test checks parity).
- Strike defaults: 3 strikes in 600 seconds; first offence deleted when delete is on; strikes reset when a rule's top step fires.
- Exempt (always): the bot, bots, members with Manage Server, holders of the bot manager role, moderation `permittedRoles`; plus admin-chosen `exemptRoles` and `exemptChannels`.
- One enforcement per rule per message; one mod log line per message.
- Intents already present: GuildMembers, GuildMessages, MessageContent. Bot permissions needed: Manage Messages, Moderate Members, Manage Nicknames.
- Tests: `node --test --test-concurrency=1 test/features/<file>`; full run `npm test`.

## Review Focus
- Message from a bot, webhook, DM or system message is ignored (no crash, no strike).
- Message already deleted when we try to delete it (Discord code 10008): ignore, continue with the other actions.
- Bot lacks permission or target outranks the bot: `runAction` returns `{ok:false}`; log a warning, still delete/log, never throw.
- Empty content, attachment-only, sticker-only, 4000-character message, Arabic/RTL text, 200 mentions: detectors return a result without throwing.
- A message edited into a violation is checked again; an edit that does not change content is not counted twice.

## File Structure
All under `src/features/automod/` unless noted.
- `normalize.js` - `normalizeText`.
- `config.js` - defaults, `readConfig`, pure config mutators.
- `strikes.js` - sliding-window strike store, `stepReached`.
- `detect-links.js` - link and invite extraction and allow/block evaluation.
- `detect-words.js`, `words-default.js` - bad-word matching and starter lists.
- `detect-spam.js` - spam tracker (burst, identical, caps, emoji, mentions, attachments, link rate).
- `history.js` - history table access (migration `src/db/migrations/007_automod_history.sql`).
- `exempt.js` - exemption check.
- `pipeline.js` - `handleMessage`: scan, strike, enforce, log, history.
- `nickname.js` - nickname/username check.
- `events.js` - Discord event wiring.
- `commands.js`, `commands-lists.js` - `/automod`.
- `index.js` - exports `commands`, `events`.
- Tests: `test/features/automod-*.test.js`.

---

### Task 1: History table and store

**Files:**
- Create: `src/db/migrations/007_automod_history.sql`, `src/features/automod/history.js`
- Test: `test/features/automod-history.test.js`

**Tier:** sonnet - migration plus a small data module.

**Interfaces:**
- Produces: `addHistory(db, { guildId, userId, rules: string[], messageId: string|null, actions: string[], caseNumber: number|null }): Promise<void>` (inserts, then trims to the newest 200 rows for the guild); `listHistory(db, guildId, { userId = null, limit = 10 }): Promise<Array<{ id, userId, rules, messageId, actions, caseNumber, createdAt }>>` newest first.

- [ ] **Step 1: Write the failing tests** in `test/features/automod-history.test.js` (use `testDb` from `../helpers/db.js`, like `test/features/moderation-store.test.js`): `adds and lists newest first`, `filters by user`, `keeps only the newest 200 rows per guild` (insert 205, expect 200 and that the oldest 5 are gone), `guilds are separate`.
- [ ] **Step 2: Run** `node --test --test-concurrency=1 test/features/automod-history.test.js`. Expected: FAIL (module missing).
- [ ] **Step 3: Create the migration** `automod_history(id BIGSERIAL PRIMARY KEY, guild_id TEXT NOT NULL, user_id TEXT NOT NULL, rules TEXT[] NOT NULL, message_id TEXT, actions TEXT[] NOT NULL, case_number INTEGER, created_at TIMESTAMPTZ NOT NULL DEFAULT now())` and an index on `(guild_id, created_at DESC)`; follow the style of `006_mod_cases.sql`.
- [ ] **Step 4: Implement** `addHistory` and `listHistory` in `history.js` with the signatures above; trim with one `DELETE ... WHERE id IN (SELECT id ... ORDER BY id DESC OFFSET 200)` per guild after the insert.
- [ ] **Step 5: Run the tests.** Expected: PASS.
- [ ] **Step 6: Commit** `feat(automod): history table and store`.

### Task 2: Text normaliser

**Files:**
- Create: `src/features/automod/normalize.js`
- Test: `test/features/automod-normalize.test.js`

**Tier:** sonnet - small algorithm, several edge cases.

**Interfaces:**
- Produces: `normalizeText(text: string): string`; `tokens(text: string): string[]` (normalised text split on whitespace and punctuation, no empty items).

- [ ] **Step 1: Write the failing tests:** `lowercases and strips accents` (`'Ĥéĺĺó'` -> `'hello'`), `maps simple letter swaps` (`'h3ll0'` -> `'hello'`, `'$pam'` -> `'spam'`), `collapses 3+ repeated characters to 2` (`'heeeello'` -> `'heello'`), `collapses whitespace`, `keeps Arabic letters and removes Arabic diacritics` (tashkeel), `empty and non-string input return ''`, `tokens splits on punctuation`.
- [ ] **Step 2: Run the file.** Expected: FAIL.
- [ ] **Step 3: Implement** both functions: NFKD, strip combining marks (`\p{M}`), lowercase, swap map `0->o 1->i 3->e 4->a 5->s 7->t @->a $->s`, collapse runs of 3+ identical characters to 2, collapse whitespace, trim. Never throws.
- [ ] **Step 4: Run the file.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(automod): shared text normaliser`.

### Task 3: Config

**Files:**
- Create: `src/features/automod/config.js`
- Test: `test/features/automod-config.test.js`

**Tier:** sonnet - schema with validation and many defaults.

**Interfaces:**
- Produces: `RULES = ['spam','invites','links','words']`; `readConfig(raw): AutomodConfig` (defaults for anything missing or invalid, like `moderation/config.js`).

Config shape (all fields always present after `readConfig`):
```
{ exemptRoles: string[], exemptChannels: string[],
  nickname: { enabled: boolean },
  rules: { [rule]: { enabled: boolean, delete: boolean, windowSeconds: number,
                     steps: Array<{ strikes: number, action: 'warn'|'timeout', timeoutSeconds: number|null }> } } }
```
Rule extras: `spam` has `burst {enabled,messages:5,seconds:5}`, `identical {enabled,count:4,seconds:60}`, `caps {enabled,minLength:10,percent:70}`, `emoji {enabled,max:10}`, `mentions {enabled,max:5}`, `attachments {enabled,count:5,seconds:30}`, `linkRate {enabled,count:5,seconds:30}`; `invites` and `links` have `allow: string[]`, `block: string[]`, `blockAllExceptAllowed: boolean` (invites default true, links default false); `words` has `custom: string[]`, `removedBuiltin: string[]`, `useBuiltin: boolean` (true). Defaults: `enabled:false`, `delete:true`, `windowSeconds:600`, `steps:[{strikes:3,action:'warn',timeoutSeconds:null}]`. Limits: 10 exempt roles, 20 exempt channels, 100 entries per list, 8 steps, strikes 1-50, window 10-86400, timeoutSeconds 60-2419200 (a `timeout` step with none uses 600), `percent` 10-100.
- Also produces pure mutators returning `{ok:true, config}` or `{ok:false, reason}` (`'exists'|'missing'|'full'|'invalid'`): `addToList(config, path, value)`, `removeFromList(config, path, value)` where `path` is one of `exemptRoles`, `exemptChannels`, `invites.allow`, `invites.block`, `links.allow`, `links.block`, `words.custom`, `words.removedBuiltin`; `setSteps(config, rule, steps)` (sorted ascending by strikes, validated).

- [ ] **Step 1: Write the failing tests:** `defaults for empty and garbage input`, `invalid numbers fall back`, `lists are deduped and capped`, `steps are sorted and validated`, `invites default to blockAllExceptAllowed true and links to false`, `addToList rejects duplicates and full lists`, `setSteps rejects empty, duplicate or out-of-range steps`.
- [ ] **Step 2: Run the file.** Expected: FAIL.
- [ ] **Step 3: Implement** `config.js` with the shape above, using the `bool`/`intIn` helper style of `moderation/config.js`.
- [ ] **Step 4: Run the file.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(automod): config schema and mutators`.

### Task 4: Strike store with tiered escalation

**Files:**
- Create: `src/features/automod/strikes.js`
- Test: `test/features/automod-strikes.test.js`

**Tier:** sonnet - small but easy to get subtly wrong.

**Interfaces:**
- Produces: `createStrikeStore(): { add(guildId, userId, rule, now, windowMs): { previous: number, count: number }, reset(guildId, userId, rule): void, prune(now, maxWindowMs): void }` (in memory; `count` is strikes inside the window including this one); `stepReached(steps, previous, count): Step | null` returns the highest step with `previous < step.strikes <= count`, or `null`; `isTopStep(steps, step): boolean`.

- [ ] **Step 1: Write the failing tests:** `counts strikes inside the window only` (old strikes drop out), `separate per guild, user and rule`, `stepReached returns the highest step reached`, `stepReached returns null when no new step is crossed`, `a jump over two steps fires only the highest`, `reset clears the count`, `prune drops expired entries`.
- [ ] **Step 2: Run the file.** Expected: FAIL.
- [ ] **Step 3: Implement** with a `Map` keyed `guild:user:rule` holding an array of timestamps; trim on `add`.
- [ ] **Step 4: Run the file.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(automod): strike store and step selection`.

### Task 5: Link and invite detection

**Files:**
- Create: `src/features/automod/detect-links.js`
- Test: `test/features/automod-links.test.js`

**Tier:** sonnet - parsing plus an async resolver.

**Interfaces:**
- Consumes: `normalizeText` is not used here (URLs keep their case).
- Produces: `extractLinks(text): string[]` (lowercase hostnames of http(s) URLs and bare `domain.tld/...`, without invite links); `extractInviteCodes(text): string[]` (from `discord.gg/x`, `discord.com/invite/x`, `discordapp.com/invite/x`); `domainMatches(host, list): boolean` (exact or subdomain); `evaluateLinks(text, cfg): { violated: boolean, matches: string[] }` where `cfg` is `config.rules.links`; `evaluateInvites(text, cfg, { ownGuildId, resolve }): Promise<{ violated, matches }>` where `resolve(code): Promise<string|null>` returns the target guild id (null if unknown). Rules for both: an `allow` entry always passes; otherwise a `block` entry violates; otherwise violated only when `blockAllExceptAllowed`. For invites the own guild always passes and an unresolvable code counts as foreign.

- [ ] **Step 1: Write the failing tests:** `extracts hosts from urls and bare domains`, `ignores invite links in extractLinks`, `extracts invite codes from all three forms`, `subdomains match a listed domain`, `allow beats block`, `blockAllExceptAllowed blocks unlisted links`, `own server invite passes`, `foreign invite violates by default`, `allowed server id passes`, `resolve failure is treated as foreign`, `resolve is called once per distinct code`.
- [ ] **Step 2: Run the file.** Expected: FAIL.
- [ ] **Step 3: Implement** the five functions above in `detect-links.js`. Cap extraction at 20 links per message.
- [ ] **Step 4: Run the file.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(automod): link and invite detection`.

### Task 6: Bad-word detection and starter lists

**Files:**
- Create: `src/features/automod/detect-words.js`, `src/features/automod/words-default.js`
- Test: `test/features/automod-words.test.js`

**Tier:** sonnet - matching rules across scripts.

**Interfaces:**
- Consumes: `normalizeText`, `tokens` from Task 2.
- Produces: `BUILTIN_WORDS: { en: string[], fr: string[], ar: string[] }` (about 10 mild profanity entries each; no slurs in the repo); `effectiveWords(cfg /* rules.words */): string[]` (builtin of all three languages unless `useBuiltin` is false, minus `removedBuiltin`, plus `custom`, all normalised, deduped); `findBadWord(text, words): string | null` returns the first matching word. Matching: a normalised token equals a word; words containing a space or in a script without spaces (Arabic) match as substrings of the normalised text.

- [ ] **Step 1: Write the failing tests:** `matches whole words only` ("class" does not match "ass"), `ignores case, accents and letter swaps`, `matches a phrase`, `matches an Arabic word as a substring`, `removedBuiltin removes a builtin word`, `useBuiltin false uses custom only`, `empty text and empty list return null`.
- [ ] **Step 2: Run the file.** Expected: FAIL.
- [ ] **Step 3: Implement** both files. Compile once per call, not per word, for lists up to 300 words.
- [ ] **Step 4: Run the file.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(automod): bad-word detection and starter lists`.

### Task 7: Spam detection

**Files:**
- Create: `src/features/automod/detect-spam.js`
- Test: `test/features/automod-spam.test.js`

**Tier:** sonnet - several stateful and stateless checks.

**Interfaces:**
- Consumes: `normalizeText`.
- Produces: `createSpamTracker(): { check(msg: SpamInput, cfg /* rules.spam */, now: number): string[], prune(now): void }` where `SpamInput = { guildId, userId, channelId, content, mentionCount, attachmentCount, linkCount }`; returns the names of tripped checks from `['burst','identical','caps','emoji','mentions','attachments','linkRate']` (only checks with `enabled: true`). `countEmoji(text): number` counts unicode emoji and `<a?:name:id>` custom emoji. Definitions: burst = more than `messages` messages by one user in `seconds` across all channels; identical = the same normalised content `count` times in a row inside `seconds`; caps = content length >= `minLength` and uppercase letters / letters >= `percent`; attachments and linkRate = totals inside `seconds` reach `count`; mentions and emoji = per message above `max`.

- [ ] **Step 1: Write the failing tests** (pass an explicit `now`): `burst trips on the sixth message in five seconds`, `identical trips on the fourth repeat and not when another message is between`, `caps ignores short messages`, `caps trips at the percent`, `emoji counts custom and unicode`, `mentions per message`, `attachments total over time`, `linkRate total over time`, `disabled checks never trip`, `empty content does not throw`, `prune frees old state`.
- [ ] **Step 2: Run the file.** Expected: FAIL.
- [ ] **Step 3: Implement** with per-user timestamp arrays in `Map`s keyed `guild:user`.
- [ ] **Step 4: Run the file.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(automod): spam detection`.

### Task 8: Exemptions and pipeline

**Files:**
- Create: `src/features/automod/exempt.js`, `src/features/automod/pipeline.js`
- Modify: `src/i18n/en.json`, `fr.json`, `ar.json` (keys `automod.reason`, `automod.log.title`, `automod.log.rules`, `automod.log.actions`)
- Test: `test/features/automod-pipeline.test.js`

**Tier:** sonnet - the integration core; the final branch review of this task is opus.

**Interfaces:**
- Consumes: `readConfig` (automod, Task 3), moderation `readConfig` from `../moderation/config.js`, `canUseAction` from `../moderation/rules.js` (use action `'warn'` for the Moderate Members check), `runAction` from `../moderation/actions.js`, `sendLog` from `../logging/send-log.js`, strike store, detectors, `addHistory`, `getFeature`, `getLang`, `t`.
- Produces: `isExempt(member, channel, autoConfig, modConfig, managerRoleId): boolean`; `createEngine(): { handleMessage(ctx, message, { edited }): Promise<void>, strikes, spam }` where `ctx = { db, client }`. `handleMessage` must run in this order and never throw: (1) ignore bots/webhooks/system/DM messages, (2) feature enabled, (3) exemptions, (4) edited message with unchanged content is ignored, (5) evaluate enabled rules cheaply first (spam, then words, then links, then invites - invites last because they may call the API), (6) if any findings: for each tripped rule add a strike; delete the message once if any tripped rule has `delete` (ignore code 10008 and permission errors, warn in the console); for each rule, `stepReached` -> run `runAction` as the bot with `type` `warn` or `timeout` (`durationSeconds` = step.timeoutSeconds ?? 600) and the reason `t(lang,'automod.reason',{rules})`, then reset the rule's strikes if it was the top step; (7) if no case was created, post one merged line via `sendLog(ctx, guildId, 'modAction', embed)` listing rules and actions; (8) `addHistory`.
- The manager role id comes from the existing panel setting (`getFeature(db, guildId, 'panel')` config, as `core/permissions.js` does).

- [ ] **Step 1: Write the failing tests** with fake message, member, channel and guild objects and an injected `deps` (second argument to `createEngine`) for `runAction`, `sendLog` and `resolveInvite`: `ignores bot, webhook and DM messages`, `ignores when the feature is off`, `ignores exempt members, roles and channels`, `ignores an unchanged edit`, `deletes and counts a strike for a bad word`, `merges two tripped rules into one log line`, `fires warn at the threshold and resets the rule`, `only the highest step fires when two are crossed`, `a failed delete (10008) does not stop the warn`, `runAction failure does not throw`, `writes a history row`, `no log line when runAction already created a case`.
- [ ] **Step 2: Run the file.** Expected: FAIL.
- [ ] **Step 3: Implement** `exempt.js` and `pipeline.js` to the contract above, with `deps` defaulting to the real functions. Add the four i18n keys in all three languages.
- [ ] **Step 4: Run the file, then** `node --test --test-concurrency=1 test/i18n.test.js`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(automod): exemptions and enforcement pipeline`.

### Task 9: Message events and feature wiring

**Files:**
- Create: `src/features/automod/events.js`, `src/features/automod/index.js`
- Modify: `src/modules.js`, `src/core/registry.js` (replace `f('automod', 2, null)` with `f('automod', 2, 'automod', { enableCommand: 'automod enable' })`)
- Test: `test/features/automod-events.test.js`

**Tier:** sonnet - wiring across loader, registry and events.

**Interfaces:**
- Consumes: `createEngine` (Task 8), `safe` from `../logging/send-log.js`.
- Produces: `events` = `[{ name: Events.MessageCreate, execute }, { name: Events.MessageUpdate, execute }]` where `execute(ctx, ...args)` calls `engine.handleMessage(ctx, message, { edited })` (for updates use the new message; fetch it if partial; skip if it cannot be fetched); one shared engine per process; a 60-second `setInterval` (unref'd) pruning strike and spam state. `index.js` exports `commands` (from Tasks 11-12; export `[]` until then) and `events`.

- [ ] **Step 1: Write the failing tests:** `messageCreate calls the engine with edited false`, `messageUpdate fetches a partial message and calls with edited true`, `an engine error is swallowed`, `loader accepts the automod module` (call `collectModules` from `src/core/loader.js` with the real `modules`), and `registry lists automod with command automod` (follow `test/core/registry.test.js`).
- [ ] **Step 2: Run the file.** Expected: FAIL.
- [ ] **Step 3: Implement** `events.js`, `index.js`; add the module to `src/modules.js`; edit the registry entry.
- [ ] **Step 4: Run** the new test, `test/core/registry.test.js` and `test/core/loader.test.js`. Expected: PASS. Fix `test/features/help.test.js` expectations only if they list automod as "coming soon".
- [ ] **Step 5: Commit** `feat(automod): message events and feature wiring`.

### Task 10: Nickname and username check

**Files:**
- Create: `src/features/automod/nickname.js`
- Modify: `src/features/automod/events.js` (add `GuildMemberAdd`, `GuildMemberUpdate`), `src/i18n/*.json` (keys `automod.nickname.reason`, `automod.nickname.log`)
- Test: `test/features/automod-nickname.test.js`

**Tier:** sonnet - events plus Discord rename rules.

**Interfaces:**
- Consumes: `effectiveWords`, `findBadWord`, `isExempt`, `getFeature`.
- Produces: `placeholderName(): string` returns `Moderated Nickname NNNN` (4 random digits); `checkMember(ctx, member, { lastRenamed = new Map() }): Promise<void>` - when the feature and `nickname.enabled` are on, the member is not exempt, and their nickname or username (display name when no nickname) contains a listed word, set the nickname to `placeholderName()` (audit reason from the i18n key) and post one `modAction` line; at most one rename per member per 10 seconds; failures (hierarchy, permission) are logged to the console and never thrown. Events: `GuildMemberAdd`, `GuildMemberUpdate` when the nickname changed, and the first `messageCreate` of a member after start (call `checkMember` from `handleMessage` once per member, remembering ids in a Set).

- [ ] **Step 1: Write the failing tests:** `renames a bad nickname`, `checks the username when there is no nickname`, `skips exempt members`, `skips when nickname.enabled is false`, `does not rename twice within 10 seconds`, `a failing setNickname does not throw`, `placeholderName matches /^Moderated Nickname \d{4}$/`.
- [ ] **Step 2: Run the file.** Expected: FAIL.
- [ ] **Step 3: Implement** and wire the events; add i18n keys in all three languages.
- [ ] **Step 4: Run** the file and `test/i18n.test.js`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(automod): nickname and username check`.

### Task 11: Settings commands

**Files:**
- Create: `src/features/automod/commands.js`
- Modify: `src/features/automod/index.js` (export the command), `src/i18n/*.json` (keys `automod.settings.*`, `automod.rule.*`)
- Test: `test/features/automod-commands.test.js`

**Tier:** sonnet - slash command surface with validation.

**Interfaces:**
- Consumes: `guard`, `handleToggle`, `toggleSubcommands` (pattern in `moderation/index.js`), automod `readConfig`, `setSteps`, `parseDuration`, `formatDuration`.
- Produces: command `/automod` with subcommands `enable`, `disable`, `status`, `rule <rule> <state>` (rule choice from `RULES`, state on/off), `delete <rule> <state>`, `steps <rule> <steps>` (text like `3:warn,5:timeout:10m,8:timeout:1d`, parsed with `parseDuration`), `window <rule> <duration>` (10 s to 1 day), `spam-check <check> <state>` (burst, identical, caps, emoji, mentions, attachments, linkRate), `spam-limit <check> <value>` (the primary number of that check), `nickname <state>`. Export `parseSteps(text): { ok, steps } | { ok:false, reason }` for testing. Replies ephemeral with `allowedMentions: { parse: [] }`.

- [ ] **Step 1: Write the failing tests:** `parseSteps accepts 3:warn,5:timeout:10m`, `parseSteps rejects duplicates, unknown actions and out-of-range values`, and handler tests with a fake interaction (follow `test/features/moderation-settings.test.js`): `status shows each rule`, `rule on enables a rule`, `steps saves sorted steps`, `window rejects 5s`, `non-managers are refused by the guard`.
- [ ] **Step 2: Run the file.** Expected: FAIL.
- [ ] **Step 3: Implement** the command and keys in all three languages.
- [ ] **Step 4: Run** the file and `test/i18n.test.js`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(automod): settings commands`.

### Task 12: List, exemption and history commands

**Files:**
- Create: `src/features/automod/commands-lists.js`
- Modify: `src/features/automod/commands.js` (add the subcommand groups), `src/i18n/*.json` (keys `automod.lists.*`, `automod.history.*`)
- Test: `test/features/automod-commands-lists.test.js`

**Tier:** sonnet - many small subcommands, one shared handler.

**Interfaces:**
- Consumes: `addToList`, `removeFromList`, `listHistory`, `capList` from `../../core/lists.js`.
- Produces: subcommand groups on `/automod`: `exempt add-role|remove-role|add-channel|remove-channel`, `words add|remove|builtin-remove|builtin-restore|builtin <state>|list`, `domains <links|invites> <allow|block> <add|remove> <value>` (invites take a server id, links a domain; validate the format), `mode <links|invites> <state>` (blockAllExceptAllowed), and `history [user]` (latest 10, shows rules, actions, case number, time). Duplicate or full lists give a clear error reply.

- [ ] **Step 1: Write the failing tests:** `exempt add-role stores the role`, `words add normalises and stores`, `builtin-remove hides a builtin word`, `domains rejects a bad domain and a non-numeric server id`, `mode toggles blockAllExceptAllowed`, `history lists newest first and filters by user`, `lists are capped with a clear message`.
- [ ] **Step 2: Run the file.** Expected: FAIL.
- [ ] **Step 3: Implement** and add the keys in all three languages.
- [ ] **Step 4: Run** the file and `test/i18n.test.js`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(automod): lists, exemptions and history commands`.

### Task 13: Docs, checklist and full verification

**Files:**
- Modify: `docs/testing-checklist.md` (new section for auto-mod), README or wherever invite permissions are listed (add Manage Messages, Moderate Members, Manage Nicknames; find with `grep -rn "Manage Messages" README.md docs/`), `docs/memory/features-built.md`, `architecture.md`, `roadmap.md`, `gotchas.md`, `index.md` if needed
- Test: full suite

**Tier:** sonnet - documentation that must match the code.

- [ ] **Step 1:** Add a checklist section: enable, each rule on a test member, strike escalation, exempt role, edit bypass, nickname rename, `/automod history`.
- [ ] **Step 2:** Update the invite-permission docs and the memory notes (features-built, architecture, roadmap, gotchas: strikes are in memory and reset on restart; phase 2 pending).
- [ ] **Step 3: Run** `npm test`. Expected: all pass; report the totals.
- [ ] **Step 4:** Run `graphify update .` (no LLM needed).
- [ ] **Step 5: Commit** `docs: auto-mod phase 1 notes and test checklist`.

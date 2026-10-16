# Auto-mod Phase 2: Advanced Layer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use tiered-powers:subagent-driven-development (recommended) or tiered-powers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add regex rules, a honeypot channel, account-age conditions, a timed role effect, and a `native` rule that reacts to Discord's own AutoMod, all on top of the Phase 1 engine.

**Architecture:** Phase 1 (`2026-10-16-automod-phase1-core.md`) must be merged first. Task 1 extracts the enforcement step of `pipeline.js` into a function every source of findings can call (messages, honeypot, native events). The other tasks add findings sources and one extra effect.

**Tech Stack:** Node 22 ESM, discord.js 14, Postgres, `node:test`.

**Spec:** `docs/tiered-powers/specs/2026-10-16-automod-design.md` (sections "Additions after comparing...", "Discord native AutoMod as a trigger")

## Global Constraints
- Same constraints as Phase 1 (own `automod` feature, Manage Server to configure, ephemeral replies, i18n in en/fr/ar, one enforcement per rule per message, one log line per message).
- Regex: patterns validated when saved; max 100 characters per pattern, max 10 patterns per server; flags fixed to `iu`; reject backreferences, lookarounds and nested quantifiers; matching runs on at most the first 1000 characters of normalised-for-regex input. No new npm dependency (my call; if the user prefers a safe-regex engine such as `re2`, swap `regex-safe.js` only).
- Native AutoMod needs the `AutoModerationExecution` gateway intent and the bot's Manage Server permission. The bot never creates or edits native rules.
- Native de-duplication: in memory for 5 seconds on `ruleId:userId:messageId`.
- Tests: `node --test --test-concurrency=1 test/features/<file>`; full run `npm test`.

## Review Focus
- A catastrophic pattern such as `(a+)+$` is rejected on save and a stored bad pattern cannot freeze the bot (invalid stored patterns are skipped with a warning).
- Honeypot post by an exempt member (staff testing it) is not punished; the honeypot channel being deleted leaves the setting stale without errors.
- Native event for a message Discord already blocked (no message to fetch) still records a strike and logs once; the same execution delivered twice counts once.
- Timed role: the role is deleted, or the member left, before the removal job runs: the job finishes quietly; a role above the bot's top role is refused at setup.
- Account-age condition with a missing `createdTimestamp` or `joinedTimestamp` (partial member) skips the rule instead of crashing.

## File Structure
All under `src/features/automod/` unless noted.
- `enforce.js` - `enforce(ctx, input)` extracted from `pipeline.js` (Task 1).
- `regex-safe.js` - pattern validation and safe matching.
- `age.js` - account-age condition.
- `honeypot.js` - honeypot findings.
- `role-effect.js` - give a role now, remove it later via the scheduler.
- `native.js` - Discord AutoMod execution listener and `/automod native` helpers.
- Modified: `config.js`, `pipeline.js`, `events.js`, `commands.js`, `commands-lists.js`, `nickname.js`, `src/index.js`, `docs`.
- Tests: `test/features/automod-*.test.js`.

---

### Task 1: Extract enforcement

**Files:**
- Create: `src/features/automod/enforce.js`
- Modify: `src/features/automod/pipeline.js`
- Test: `test/features/automod-pipeline.test.js` (existing tests must keep passing), `test/features/automod-enforce.test.js`

**Tier:** sonnet - refactor of the core, behaviour must not change.

**Interfaces:**
- Consumes: the strike, `runAction`, `sendLog`, `addHistory` and delete logic currently inside `handleMessage`.
- Produces: `enforce(ctx, { guild, member, message, findings, autoConfig, modConfig, lang, deps, strikes }): Promise<void>` where `message` may be `null` (nothing to delete) and `findings = [{ rule: string, reason: string }]`. Behaviour is exactly the Phase 1 steps 6-8 (strike per rule, delete once, steps via `stepReached`, reset on top step, merged log line only when no case was created, history row). `handleMessage` now only filters, scans, then calls `enforce`.

- [ ] **Step 1: Write the failing test** `automod-enforce.test.js`: `enforce with a null message does not try to delete`, `enforce warns at the threshold using the findings' rules`, `enforce never throws when runAction rejects`.
- [ ] **Step 2: Run** `node --test --test-concurrency=1 test/features/automod-enforce.test.js`. Expected: FAIL.
- [ ] **Step 3: Move** the enforcement code into `enforce.js` with the signature above and call it from `pipeline.js`.
- [ ] **Step 4: Run** `node --test --test-concurrency=1 test/features/automod-pipeline.test.js test/features/automod-enforce.test.js`. Expected: PASS.
- [ ] **Step 5: Commit** `refactor(automod): extract enforce from the pipeline`.

### Task 2: Safe regex

**Files:**
- Create: `src/features/automod/regex-safe.js`
- Modify: `src/features/automod/config.js` (`rules.words.patterns: string[]`, path `words.patterns` in `addToList`/`removeFromList`, limit 10), `src/features/automod/detect-words.js`
- Test: `test/features/automod-regex.test.js`

**Tier:** sonnet - security-sensitive input handling; its review is opus.

**Interfaces:**
- Produces: `validatePattern(source: string): { ok: true } | { ok: false, reason: 'too_long'|'unsafe'|'invalid' }`; `compilePatterns(sources: string[]): RegExp[]` (flags `iu`, skips invalid ones with a console warning); `matchPatterns(text: string, regexes: RegExp[]): string | null` returns the source of the first match, testing at most the first 1000 characters. `findBadWord` is unchanged; add `findPattern(text, cfg /* rules.words */): string | null` in `detect-words.js` that uses the above.

- [ ] **Step 1: Write the failing tests:** `accepts a plain pattern`, `rejects over 100 characters`, `rejects (a+)+$ and (a*)*`, `rejects backreferences and lookarounds`, `rejects an invalid expression`, `matching is case-insensitive`, `only the first 1000 characters are tested`, `compilePatterns skips a stored invalid pattern`, `addToList words.patterns refuses an unsafe pattern and the 11th pattern`.
- [ ] **Step 2: Run the file.** Expected: FAIL.
- [ ] **Step 3: Implement** the three functions: unsafe detection by scanning the source for `\1`-style backreferences, `(?=`, `(?!`, `(?<=`, `(?<!`, and a group followed by `+`, `*` or `{n,}` that itself contains a `+`, `*` or `{n,}`.
- [ ] **Step 4: Run the file.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(automod): safe regex patterns for the word rule`.

### Task 3: Regex in the pipeline, nickname check and commands

**Files:**
- Modify: `src/features/automod/pipeline.js`, `src/features/automod/nickname.js`, `src/features/automod/commands-lists.js`, `src/i18n/*.json` (keys `automod.patterns.*`)
- Test: `test/features/automod-pipeline.test.js`, `test/features/automod-nickname.test.js`, `test/features/automod-commands-lists.test.js`

**Tier:** sonnet - three consumers of Task 2.

**Interfaces:**
- Consumes: `findPattern`, `validatePattern`, `addToList` with path `words.patterns`.
- Produces: the words rule also trips on a pattern match (reason `pattern`); the nickname/username check also matches patterns; `/automod patterns add|remove|list` (validation error replies per reason).

- [ ] **Step 1: Write the failing tests:** `a pattern match trips the words rule`, `a pattern match renames a nickname`, `patterns add rejects an unsafe pattern with the unsafe message`, `patterns list shows the patterns`, `patterns remove deletes one`.
- [ ] **Step 2: Run the three files.** Expected: FAIL.
- [ ] **Step 3: Implement** the pipeline and nickname hooks and the command group; add i18n in all three languages.
- [ ] **Step 4: Run** the three files and `test/i18n.test.js`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(automod): regex patterns in messages, nicknames and commands`.

### Task 4: Account-age conditions

**Files:**
- Create: `src/features/automod/age.js`
- Modify: `src/features/automod/config.js` (per rule `age: { accountYoungerThanSeconds: number|null, joinedWithinSeconds: number|null }`, defaults `null`), `pipeline.js`, `commands.js` (`/automod age <rule> <account|joined> <duration|off>`), `src/i18n/*.json`
- Test: `test/features/automod-age.test.js`

**Tier:** sonnet - config, condition and command together.

**Interfaces:**
- Produces: `passesAge(member, ruleCfg, now): boolean` - true when no limits are set; otherwise true only if every set limit holds (`now - user.createdTimestamp < accountYoungerThanSeconds * 1000` and `now - member.joinedTimestamp < joinedWithinSeconds * 1000`); a missing timestamp makes it return false. The pipeline skips a rule whose `passesAge` is false before running that rule's detector (cheap check first).

- [ ] **Step 1: Write the failing tests:** `no limits always passes`, `young account passes and old account fails`, `recent joiner passes and old member fails`, `both limits must hold`, `missing timestamps fail`, `pipeline skips a rule the member does not match`, `age command saves and clears a limit`.
- [ ] **Step 2: Run the file.** Expected: FAIL.
- [ ] **Step 3: Implement** and add i18n in all three languages.
- [ ] **Step 4: Run** the file and `test/i18n.test.js`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(automod): account-age conditions`.

### Task 5: Timed role effect

**Files:**
- Create: `src/features/automod/role-effect.js`
- Modify: `src/features/automod/config.js` (per rule `giveRole: { roleId: string|null, seconds: number }`, default `{ roleId: null, seconds: 600 }`, seconds 60 to 7 days), `enforce.js` (call it when any step of the rule fires), `index.js` (export `jobs`), `commands.js` (`/automod role <rule> <role|off> [duration]`), `src/i18n/*.json`
- Test: `test/features/automod-role-effect.test.js`

**Tier:** sonnet - uses the shared scheduler (job contract in `docs/memory/architecture.md`).

**Interfaces:**
- Consumes: `scheduleJob`, `cancelJobs` from `../../core/scheduler.js`.
- Produces: `grantTimedRole(ctx, member, ruleCfg, now): Promise<boolean>` adds the role (skips if the member has it or the role is missing or above the bot) and schedules job type `automod.removeRole` with key `<userId>:<roleId>`, payload `{ userId, roleId }`, `dueAt = now + seconds * 1000`; `removeTimedRole(ctx, job): Promise<void>` is the handler (finishes quietly when the guild, member or role is gone or on a permanent 4xx error; throws on transient errors so the scheduler retries). Export `jobs = { 'automod.removeRole': removeTimedRole }`.

- [ ] **Step 1: Write the failing tests** (fake guild and member, fake db for the scheduler as in `test/core/scheduler-store.test.js`): `grants the role and schedules removal`, `skips when the member already has the role`, `a re-trigger moves the removal time`, `the handler removes the role`, `the handler is quiet when the member left`, `the handler is quiet when the role was deleted`, `setup refuses a role above the bot`.
- [ ] **Step 2: Run the file.** Expected: FAIL.
- [ ] **Step 3: Implement** the module and wire `jobs` through `index.js` (the loader's `collectModules` collects it); add i18n in all three languages.
- [ ] **Step 4: Run** the file, `test/core/loader.test.js` and `test/i18n.test.js`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(automod): timed role effect`.

### Task 6: Honeypot

**Files:**
- Create: `src/features/automod/honeypot.js`
- Modify: `src/features/automod/config.js` (`RULES` gains `'honeypot'`; `honeypot: { channelId: string|null }` plus the common rule fields; default steps `[{ strikes: 1, action: 'timeout', timeoutSeconds: 600 }]`, `delete: true`), `pipeline.js`, `commands.js` (`/automod honeypot <channel|off>`), `src/i18n/*.json`
- Test: `test/features/automod-honeypot.test.js`

**Tier:** sonnet - small config, pipeline and command change.

**Interfaces:**
- Produces: `honeypotFinding(message, autoConfig): { rule: 'honeypot', reason: 'honeypot' } | null` - non-null when the rule is enabled and `message.channelId === rules.honeypot.channelId`. The pipeline checks it first (before any scan) and still applies exemptions (an exempt member is never punished). The setup command refuses a channel the bot cannot see or manage messages in.

- [ ] **Step 1: Write the failing tests:** `a post in the honeypot channel produces a finding`, `a post elsewhere does not`, `disabled rule does not`, `an exempt member is not punished`, `the first post deletes and times out with the default steps`, `command refuses a channel the bot cannot manage`, `command off clears the channel`.
- [ ] **Step 2: Run the file.** Expected: FAIL.
- [ ] **Step 3: Implement** and add i18n in all three languages.
- [ ] **Step 4: Run** the file and `test/i18n.test.js`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(automod): honeypot channel`.

### Task 7: Native AutoMod trigger

**Files:**
- Create: `src/features/automod/native.js`
- Modify: `src/index.js` (add `GatewayIntentBits.AutoModerationExecution`), `src/features/automod/config.js` (`RULES` gains `'native'`; `native: { ruleIds: string[] }` plus the common rule fields; default `delete: false`, steps `[{ strikes: 3, action: 'warn', timeoutSeconds: null }]`), `events.js` (add `Events.AutoModerationActionExecution`), `commands.js` (`/automod native list`, `/automod native add-rule <id>`, `/automod native remove-rule <id>`), `src/i18n/*.json`
- Test: `test/features/automod-native.test.js`

**Tier:** sonnet - Discord event, dedupe, and a command; its review is opus (new privileged intent).

**Interfaces:**
- Consumes: `enforce` (Task 1), `isExempt`, config.
- Produces: `createNativeHandler(deps): { handle(ctx, execution): Promise<void> }` - for a `discord.js` `AutoModerationActionExecution` (`guild`, `userId`, `ruleId`, `ruleTriggerType`, `content`, `matchedKeyword`, `messageId`, `channelId`): ignore when the feature or the `native` rule is off; ignore when `ruleIds` is non-empty and does not include `ruleId`; de-duplicate on `ruleId:userId:messageId` for 5 seconds (in memory, pruned); fetch the member (skip if gone) and, when `messageId` is set and `delete` is on, try to fetch and delete the message (ignore unknown-message and permission errors); then call `enforce` with the finding `{ rule: 'native', reason: ruleName or ruleId }`. `listNativeRules(guild): Promise<Array<{ id, name, enabled }>>` uses `guild.autoModerationRules.fetch()` (empty array and a clear message on missing permission). Add the intent in `src/index.js`; document that the bot needs Manage Server.

- [ ] **Step 1: Write the failing tests:** `ignores when the rule is off`, `ignores a native rule id not in the list`, `an empty list reacts to all native rules`, `the same execution twice counts once`, `a missing message still records a strike and logs once`, `a member who left is skipped`, `listNativeRules returns id, name and enabled`, `listNativeRules without permission returns an empty list`, `native list command shows ids`.
- [ ] **Step 2: Run the file.** Expected: FAIL.
- [ ] **Step 3: Implement** the handler, command group, intent and event wiring; add i18n in all three languages.
- [ ] **Step 4: Run** the file and `test/i18n.test.js`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(automod): react to Discord AutoMod executions`.

### Task 8: Docs, checklist and full verification

**Files:**
- Modify: `docs/testing-checklist.md` (honeypot, regex, age limit, timed role, native rule sections), invite-permission docs (Manage Server, Manage Roles for the timed role), `docs/memory/*` (features-built, architecture, roadmap, decisions, gotchas), `README.md` if it lists features

**Tier:** sonnet - documentation that must match the code.

- [ ] **Step 1:** Add the checklist sections and permission notes.
- [ ] **Step 2:** Update the memory notes: strikes in memory, regex limits, native intent needs Manage Server, timed role job type `automod.removeRole`, Phase 2 done.
- [ ] **Step 3: Run** `npm test`. Expected: all pass; report totals.
- [ ] **Step 4:** Run `graphify update .`.
- [ ] **Step 5: Commit** `docs: auto-mod phase 2 notes and test checklist`.

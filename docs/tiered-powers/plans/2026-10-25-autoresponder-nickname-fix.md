# Autoresponder Nickname Fix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use tiered-powers:subagent-driven-development (recommended) or tiered-powers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A `{setnick}` that uses a word checked as a user (`{requirearg:N|user}`) sets the member's display name in the nickname, not the literal mention text `<@id>`; reply text keeps rendering the mention.

**Architecture:** `checkArgType` already fetches the member for a `user` check; it also returns the member's display name. `prepareRun` returns a second word list for nicknames (`nickWords`) in which a checked user word is replaced by that display name (typed word as the fallback); `executePlan` and the dry run render `{setnick}` from `nickWords`. Reply text, embeds and pings are untouched.

**Tech Stack:** Node 22 ESM, discord.js 14.27, `node --test`.

**Spec:** `docs/tiered-powers/specs/2026-10-24-autoresponder-stage2-design.md` (the "Words after the trigger" and "Role targets" parts); this plan resolves the parked nickname finding from the stage 2 final fix-wave review.

## Global Constraints

- Node 22+, ESM, discord.js 14.27.0, no new dependency, no new intent, no migration; stored compiled rules unchanged (version 1 and 2 keep running).
- Only `{setnick}` text changes. Reply text, embeds, `allowedUsers` (pings) and role targets must behave exactly as before. A word checked as `user` still renders as `<@id>` in reply text and still pings only through `allowedUsers`.
- A display name is member-controlled text: it is rendered once and never scanned again for `[$N]` tokens, placeholders or the escape sentinel; the existing `NICK_EMPTY` / `NICK_TOO_LONG` run checks apply to the rendered nickname unchanged (never truncate).
- `/autoresponder test` and Try it must show the same nickname the live handler would set.
- Tests hit the DB (`npm test`, concurrency 1; one test process at a time). Commit style `fix(autoresponder): ...`, the user's own git name and email, no Co-Authored-By Claude trailer. Never stage `docs/memory/roadmap.md`, `docs/memory/.obsidian/workspace.json` or `test/features/automod-*.test.js` (the user's uncommitted edits).

## Review Focus

1. A checked user word in a nickname gives the display name; an unchecked word, a word checked as another type, or a rule with no `requirearg` is unchanged (Task 1).
2. A display name that looks like a token (`[$2]`, `[range]`, `{user}`, `<@123>`) is inserted literally and never re-rendered (Task 1).
3. A very long display name still gives `NICK_TOO_LONG` and an empty one `NICK_EMPTY`, never a truncated nickname; the reply text and pings for the same message are unchanged (Task 1).

---

### Task 1: Nickname words

**Files:**
- Modify: `src/features/autoresponder/script/args.js` (`checkArgType`), `src/features/autoresponder/script/run.js` (`prepareRun`), `src/features/autoresponder/script/evaluate.js` (carry `nickWords` on the run plan), `src/features/autoresponder/execute.js` (setnick rendering), `src/features/autoresponder/dryrun.js` (setnick line), `docs/memory/gotchas.md`, `README.md` (only where they describe the nickname behaviour)
- Test: `test/features/autoresponder-stage2-run.test.js` (additions), `test/features/autoresponder-args.test.js` (additions)

**Tier:** sonnet - touches the live nickname path across four files; the tests define it

**Interfaces:**
- Produces in `args.js`: `checkArgType(type, word, guild)` result for a passing `user` check gains `name: string` (the fetched member's `displayName`; empty string when unavailable); other types unchanged.
- Produces in `run.js`: `prepareRun(...)` returns `{ words, nickWords, draws, argResults }`; `nickWords` is a `Words` (same shape as `words`) in which each word checked as `user` (argResults entry ok, type user) is replaced by that entry's `name` (the typed word when `name` is empty); everything else, including spacing and `rest(n)`, behaves as `words`. For rules on the fast path `nickWords` is `words`.
- Produces in `evaluate.js`: the run plan carries `nickWords` next to `words`.
- Consumes in `execute.js` / `dryrun.js`: `{setnick}` text renders `[$N]` tokens from `plan.nickWords` (falling back to `plan.words` for plans built without it); random tokens and placeholders in the nickname render as today; the display name is inserted in a single pass (`renderArgsInText` semantics).

- [ ] **Step 1: Write failing tests:** `checkArgType('user', '<@id>' / bare id, guild)` returns `name` equal to the fake member's `displayName`, empty string when the member has none; `prepareRun` for a rule with `{requirearg:1|user}` and a word that is a member id gives `nickWords.list[0] === 'Sam'` while `words.list[0]` keeps the typed word, and an unchecked word, a word checked as `number`, and a rule without `requirearg` give `nickWords` equal to `words`; end to end through `evaluate` + `executePlan` with a fake member: `{requirearg:1|user}{setnick:[$1] fan club}` and message `!fan 123456789012345678` sets nickname `Sam fan club` while the reply text for `{user} hugs [$1]` still renders `<@123456789012345678>` and `allowedUsers` still contains only that user (assert both); a display name `[$2]` and one `<@999>` and one `{user}` are inserted literally in the nickname (single pass); a 40-character display name gives `NICK_TOO_LONG` and nothing is set, an empty-name member falls back to the typed word; `describeRunFor` (`/autoresponder test`, Try it) prints the same nickname line as `executePlan` would set; a version 1 rule with `{setnick:Hi [$1]}`-free text behaves exactly as before (run the existing evaluate/execute/dryrun/stage2-run tests unmodified).
- [ ] **Step 2:** `node --test --test-concurrency=1 test/features/autoresponder-args.test.js test/features/autoresponder-stage2-run.test.js` -> FAIL.
- [ ] **Step 3: Implement** the `name` field, `nickWords`, and the setnick rendering from `nickWords` in `execute.js` and `dryrun.js`. Update `docs/memory/gotchas.md` and `README.md` where they currently say a checked user word shows as a mention "also in a nickname": the nickname uses the member's display name.
- [ ] **Step 4:** run all `test/features/autoresponder-*.test.js` and `test/i18n.test.js` (foreground, one process) -> PASS. **Step 5: Commit** `fix(autoresponder): nicknames use the display name of a checked user word`.

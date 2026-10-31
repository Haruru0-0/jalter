# Autoresponder Chained-Button Role Check Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use tiered-powers:subagent-driven-development (recommended) or tiered-powers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When a rule or button attaches a stored button (`{addbutton:name}`), the saver must be allowed to give the roles of EVERY button reachable through that button's own `{addbutton}` chain, not only the directly attached one.

**Architecture:** `attachedRoleError` in `script/functions.js` already checks the role actions of the directly attached stored button against the saver (`callerCanGive`, dangerous role, role above the bot). Extend it to walk the stored buttons that the attached button itself attaches (`compiled.buttons` entries of kind `stored`), breadth first, with a visited set (cycles are allowed by the spec and must terminate) and a hard cap on distinct buttons visited, checking each reachable button's role actions the same way.

**Tech Stack:** Node 22 ESM, discord.js 14.27, Postgres, `node --test`.

**Spec:** `docs/tiered-powers/specs/2026-10-31-autoresponder-stage3-design.md` (the "Anti-goals": a press must not bypass a safety check a normal rule has; "Chained buttons"). This plan resolves the parked residual from the stage 3 final fix-wave re-review.

## Global Constraints

- Node 22+, ESM, discord.js 14.27.0, no new dependency, no migration.
- Same refusals and order as the direct check: stored role missing -> skipped; then `ROLE_DANGEROUS`, `ROLE_ABOVE_BOT`, `ROLE_ABOVE_YOU` (detail: the name of the button whose role action failed). The guild owner and a saver who may give every role are unaffected. Only role actions (`addrole`, `removerole`) are checked; the check reads stored `roleId`s through the role cache and stored buttons through `getButton(db, guild.id, name)`, one read per distinct button.
- Cycles (a button that attaches itself, or two buttons attaching each other) terminate and are not an error. A missing intermediate stored button is skipped (it answers "expired" at press time). At most 25 distinct stored buttons are visited per `{addbutton}` check; if the chain reaches a 26th distinct button the save is refused with the new compile error `BUTTON_CHAIN_TOO_LONG` (add it to `COMPILE_ERROR_CODES` with real `autoresponder.error.BUTTON_CHAIN_TOO_LONG` translations in en, fr, ar), because an unchecked tail is not safe.
- A button edited AFTER others attached it is not re-checked (the check is at save time only): document this in `docs/memory/gotchas.md` and the README stage 3 section.
- Scripts without `{addbutton}` do no extra work; the direct-button behaviour and every existing test stay unchanged.
- Tests hit the DB (`npm test`, concurrency 1; one test process at a time). Commit style `fix(autoresponder): ...`, the user's own git name and email, no Co-Authored-By Claude trailer. Never stage `docs/memory/roadmap.md`, `docs/memory/.obsidian/workspace.json` or `test/features/automod-*.test.js`.

## Review Focus

1. A lower-ranked saver cannot expose a role through a chain of two, three or more stored buttons (Task 1).
2. A cycle terminates, an unreachable/missing intermediate button is skipped, and a long chain is refused rather than partly checked (Task 1).
3. The check cannot be bypassed through any `compileScript` call path (commands add/edit with `buttonScript: true`, the builder's compile-and-revert, Save, Try it, `editmatchmode`) and reads at most one stored button per distinct name (Task 1).

---

### Task 1: Walk the attached-button chain

**Files:**
- Modify: `src/features/autoresponder/script/functions.js` (`attachedRoleError` / `addbutton.check`), `src/features/autoresponder/script/compile.js` (`COMPILE_ERROR_CODES`), `src/i18n/{en,fr,ar}.json`, `docs/memory/gotchas.md`, `README.md` (stage 3 section)
- Test: `test/features/autoresponder-buttons-compile.test.js` (additions)

**Tier:** sonnet - a bounded graph walk inside a security check; reviewer should be opus

**Interfaces:**
- Consumes: `getButton(db, guildId, name)` (`buttons/store.js`), `callerCanGive`, `isDangerousRole`, `botCanGive` (`core/role-safety.js`), the existing `attachedRoleError` helper and its refusal order.
- Produces: `attachedRoleError` (or a new helper it calls) that, given the directly attached button, visits `compiled.buttons` entries of `kind: 'stored'` breadth first with a `Set` of visited names, checking each visited button's `addrole`/`removerole` actions as before, returning the first refusal `{ code, detail }` or `null`; a chain that would visit more than 25 distinct buttons returns `{ code: 'BUTTON_CHAIN_TOO_LONG', detail: <name of the attached button> }`.

- [ ] **Step 1: Write failing tests** (real DB, stored buttons created with `createButton`, fake guild/writer as in the existing `{addbutton}` role tests): `adm2` (script `More {addbutton:adm}`, no role action) attaching `adm` (script `{addrole:Mod}`): a lower-ranked writer attaching `adm2` gets `ROLE_ABOVE_YOU` (this fails today), a writer who can give the role compiles fine, the guild owner compiles fine; a three-level chain `a -> b -> c` where only `c` gives the role is refused for the lower writer; a dangerous role (Administrator) and a role above the bot at depth 2 give `ROLE_DANGEROUS` / `ROLE_ABOVE_BOT`; `removerole` at depth 2 is checked too; a cycle (`a` attaches `b`, `b` attaches `a`, one of them gives a role the writer can give) terminates and compiles, and with a role the writer cannot give is refused; a self-attaching button terminates; a missing intermediate stored button is skipped (the script still compiles if the rest is fine); a chain of 26 distinct buttons gives `BUTTON_CHAIN_TOO_LONG` and one of exactly 25 distinct buttons is fully checked; a spy on `getButton` shows each distinct button is read once even with a cycle and with the same button reachable twice; inside another button's script (`buttonScript: true`) the chain check applies; the direct case and scripts without `{addbutton}` behave exactly as before (existing tests unmodified); `BUTTON_CHAIN_TOO_LONG` is in `COMPILE_ERROR_CODES` with en, fr, ar strings.
- [ ] **Step 2:** `node --test --test-concurrency=1 test/features/autoresponder-buttons-compile.test.js` -> FAIL.
- [ ] **Step 3: Implement** the walk and the new code with translations; update `docs/memory/gotchas.md` and the README stage 3 section (attaching a button checks the roles of the whole chain; a button edited later is not re-checked; a chain of more than 25 buttons is refused).
- [ ] **Step 4:** run all `test/features/autoresponder-*.test.js` and `test/i18n.test.js` (foreground, one process), then the full `npm test` once -> PASS. **Step 5: Commit** `fix(autoresponder): check the roles of the whole attached-button chain`.

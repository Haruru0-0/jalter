# AGENTS.md

Jalter is a Discord bot (discord.js 14, Node 22+, ESM) with a modular feature design. Most features are off by default and a server admin turns them on. Setup replies are private (ephemeral) and need Manage Server or the bot manager role.

## Setup commands

- Install deps: `npm install`
- Start Postgres: `npm run db:up` (same as `docker compose up -d`)
- Register slash commands: `npm run deploy` — required after any new or changed command
- Run the bot: `npm start`
- Test: `npm test` (node's own test runner; needs Postgres up)
- There is no lint or typecheck script, and no ESLint or Prettier config.

## Project layout

- `src/features/<name>/` — one folder per feature; each is listed in `src/modules.js` and `src/core/registry.js`
- `src/core/` — shared helpers: `guard.js`, `registry.js`, `toggle.js`, `permissions.js`, `replies.js`, `send.js`, `duration.js`, `scheduler.js`, `role-safety.js`
- `src/db/` — pool and `resetDb()`, `settings.js`, `migrations/NNN_name.sql`
- `src/i18n/` — `en.json`, `fr.json`, `ar.json`, plus `t(lang, key, vars)` and `getLang`
- `test/` — `node:test` files mirroring `src/`; helpers in `test/helpers/db.js`
- `docs/` — setup guide and testing checklist; `docs/tiered-powers/{specs,plans}/` hold design specs and task plans
- `docs/memory/` — Obsidian vault of durable decisions and gotchas
- `assets/`, `docker/`, `scripts/` — fonts, Postgres init, GitLab mirror script

## Code style

- ESM everywhere, 2-space indent, single quotes, semicolons, no TypeScript
- Short arrow helpers for tiny pure functions; exported `function` declarations for anything named
- One-line JSDoc comments above non-obvious exports; explain *why* in a comment, not what the code does
- Config is read through a `readConfig(raw)` that fills defaults, never throws, and returns a complete object. Config mutators return `{ ok: true, config }` or `{ ok: false, reason }` (see `src/features/moderation/config.js`)
- Handlers receive `ctx = { db, client, commands }`. Command handlers start with `guard(interaction, ctx, '<feature>', { requireManager, requireEnabled })`, which replies ephemerally on a failure and returns the server language (or `null` when it refused)

## Testing instructions

- Everything: `npm test`. One file: `node --test --test-concurrency=1 test/features/<file>`
- Tests hit the real Postgres — `testDb()` in `test/helpers/db.js` resets it — so start Postgres first and never run two test processes at once
- Fakes are inline in each test file; there is no shared mock library
- Add a test for every new behaviour, next to the existing `*.test.js` for that area

## Project conventions that break if ignored

- **Every user-facing string goes in all three of `en.json`, `fr.json`, `ar.json`** under a flat dotted key; `test/i18n.test.js` enforces parity. French and Arabic need real translations, not English copies.
- A new feature needs an entry in `src/core/registry.js` (`f('<key>', <phase>, '<command>')`) *and* an import plus a `modules` entry in `src/modules.js`. Phases 2+ that are not built yet are stubs with `command: null`.
- `setFeature` **merges** into the stored JSON, it does not replace it. Always write the whole nested object, never a partial one, or sibling keys are dropped.
- A new table needs a new numbered migration in `src/db/migrations/`; it runs on the next bot start. A new slash command needs `npm run deploy`.
- Scheduler work: a feature exports `jobs` (`{ 'type': handler }`) and/or `housekeeping` from its module, and a duplicate job type throws at load. Handlers must be idempotent (delivery is at-least-once) and must *return* on permanent Discord errors rather than throw, or they retry and are dropped after 5 attempts.
- Permission overwrites must be read from a forced fetch (`guild.channels.fetch(id, { force: true })`); the discord.js overwrite cache lags your own writes and `edit()` merges onto the cached overwrite.
- The bot's highest role must sit above any role it gives, and roles carrying staff permissions are refused. `src/core/role-safety.js` holds those checks.

## Branching and commits

- One branch per phase; `autorole-upgrade` is the default branch — never push to it directly
- Conventional commits with a scope: `feat(verification): image captcha flow`, `fix(verification): ...`, `docs: ...`
- No `Co-Authored-By` trailer
- Stage explicit files only. Never stage `docs/memory/.obsidian/workspace.json` or unrelated `test/features/automod-*.test.js` edits already sitting in the working tree
- Do not commit unless asked

## Memory

- `docs/memory/` is an Obsidian vault — read `docs/memory/index.md` at the start of a session
- Save durable decisions and facts there as Markdown, link with `[[wikilinks]]`, and add one line to `index.md`
- The notes hold the rules that are easy to get wrong (e.g. a DM goes out *before* the Discord action; the unverified policy fails toward *not* kicking). Check `gotchas.md` before changing an existing feature

## Code map

- `graphify-out/GRAPH_REPORT.md` summarizes the structure — check it before a broad file search
- Query with `graphify query "<question>"`, `graphify path A B`, `graphify explain X`
- Refresh after code changes with `graphify update .` (no API cost). The checked-in copy can be stale — compare its commit with `git rev-parse HEAD`

## Security

- Never commit secrets: `.env` holds the bot token and database URL and is git-ignored
- Postgres binds to `127.0.0.1` only. Change the default password `bot` before hosting anywhere reachable

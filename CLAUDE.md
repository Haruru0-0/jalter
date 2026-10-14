# Jalter

Discord bot (discord.js 14, Node 22+, ESM, Postgres via Docker). Modular: features live in `src/features/<name>/`, shared helpers in `src/core/`, DB in `src/db/`, strings in `src/i18n/{en,fr,ar}.json`.

## Commands
- `docker compose up -d` (or `npm run db:up`): start Postgres
- `npm run deploy`: register slash commands
- `npm start`: run the bot
- `npm test`: node test runner (`--test-concurrency=1`, tests hit the DB)

## Conventions
- Most features are off by default; admins enable them. Setup replies are ephemeral and need Manage Server or the bot manager role.
- Any user-facing text goes in all three i18n files (en, fr, ar).
- `.env` holds secrets and is never committed; see `.env.example`.

## Memory
- Notes live in `docs/memory/` (an Obsidian vault). Read `docs/memory/index.md` at the start of a session.
- Save durable decisions and facts there as Markdown, link with [[wikilinks]], and add a line to `index.md`.

## Code map
- `graphify-out/GRAPH_REPORT.md` summarizes the code structure. Check it before broad file searches.
- Query with `graphify query "<question>"`, `graphify path A B`, `graphify explain X`.
- After code changes, refresh with `graphify update .` (no LLM needed).

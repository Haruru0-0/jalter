# Decisions

Record choices that are not obvious from the code, with the reason.

- 2026-10-14: Memory is an Obsidian vault in `docs/memory/`; code structure comes from Graphify (`graphify-out/`, git-ignored, refresh with `graphify update .`).
- 2026-10-14: A global Stop/SessionStart hook (`~/.claude/hooks/memory-sync.mjs`) asks before setting up memory in a new git project and before updating notes; Graphify map refreshes automatically. Declined projects are listed in `~/.claude/memory-sync-declined.json`.
- Features are modular and off by default; admins opt in per server. Why: keeps the bot quiet and permissions minimal until needed.
- Setup replies are ephemeral and gated by Manage Server or the bot manager role (`core/guard.js`).
- All user-facing text lives in the three i18n files, so nothing is hard-coded in English.
- Autorole: timed roles and sticky memory (`reassign`, 30 days) live in autorole, not a separate "stickyroles" feature. Blacklisted, managed and above-the-bot roles are never remembered.
- Postgres binds to `127.0.0.1` only; change the default password `bot` before hosting anywhere reachable.
- Tests run with `--test-concurrency=1` because they share the database.

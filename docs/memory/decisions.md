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
- Scheduler (built 2026-10-14, [[architecture]]): jobs are at-least-once. A tick claims due rows (`FOR UPDATE SKIP LOCKED`), the attempt is counted at claim, and the claim expires after 5 minutes (`CLAIM_MS`), so a job whose process died is re-run later. A handler that returns finishes the job (row deleted, including "nothing to do"); one that throws is retried. Max 5 attempts (`MAX_ATTEMPTS`); backoff after attempts 1-4 is 1, 5, 15 and 60 minutes, then the job is dropped with a `console.warn`. Job types with no registered handler are never claimed or counted and wait untouched (one warning per type per process). Scheduling the same guild+type+key twice keeps one row with the new due time and resets attempts; this needs a non-null key (NULL keys never conflict, so keyless jobs always add a row), and `cancelJobs` with no key matches any key. Finishing a job (`completeJob`/`failJob`) also matches the claimed attempts, so a handler still running when its key is rescheduled cannot delete or move the new row. Spec: `docs/tiered-powers/specs/2026-10-14-scheduler-design.md`.
- Auto role timed grants: the handler finishes without granting when the feature is off or the role is no longer in the timed list; unknown member/role and other HTTP 4xx (except 429) log and finish; network, 5xx and 429 errors throw and retry.

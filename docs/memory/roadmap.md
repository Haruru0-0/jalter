# Roadmap

Full detail: `docs/tiered-powers/specs/2026-10-14-feature-roadmap.md`. Original design: `docs/tiered-powers/specs/2026-10-13-discord-bot-design.md`. Plans in `docs/tiered-powers/plans/`.

## Build order
1. **Step 0 shared pieces**: generic scheduler (done, see below), mod-case store, extra intents (GuildModeration and GuildVoiceStates are already added by logging; GuildMessageReactions is still to come) and invite permissions - add each only when its first feature ships.
2. **Phase 2 Moderation**, strict order: mod cases + warn/kick/ban/timeout -> timed actions (next; the scheduler is ready for them) -> channel tools (purge, slowmode, lock) -> auto-mod -> verification -> anti-raid.
3. **Phase 3 Automation**, any order: autoresponder, reaction roles, quote.
4. **Phase 4 Community**: scheduler group (reminders, birthdays, stats channels); event group (AFK, leveling, starboard); staff group (tickets, confessions). Extend `/userinfo` last (needs levels, warnings, birthdays).
5. **Phase 5**: backup/restore, translate (needs an API key in `.env`).

## Done
- **Logging Carl-parity** (plan: `docs/tiered-powers/plans/2026-10-14-logging-carl-parity.md`): built and merged into `autorole-upgrade` (not yet deployed: run `npm run deploy` to register the new subcommands). See [[features-built]]. Modlog and cases are deliberately left for Phase 2 (mod-case store), which can log to the existing `mod` category.
- **Shared scheduler (Step 0)**: built and merged into `autorole-upgrade` (pushed to origin; migration 005 runs on the next bot start) (spec: `docs/tiered-powers/specs/2026-10-14-scheduler-design.md`, plan: `docs/tiered-powers/plans/`). `scheduled_jobs` table, one 30 s ticker, at-least-once with retries; auto role's timed roles run on it and migration 005 moved waiting `pending_roles` rows over. See [[architecture]]. Moderation timed actions (temp ban, timed mute) are the next consumer.

## In progress
- **Moderation (Phase 2 steps 1 and 2)**: design approved and plan written (10 tasks, not started): spec `docs/tiered-powers/specs/2026-10-14-moderation-design.md`, plan `docs/tiered-powers/plans/2026-10-14-moderation.md` (YAGPDB-style commands, numbered cases, mod log through the `mod` logging category, timed bans and mutes on the scheduler). Next: choose subagent-driven or native execution, then run the plan.

## Planned, not built
- Everything in the build order above except logging and the scheduler.

## Dependencies worth remembering
- Verification must exist before anti-raid (lockdown raises verification).
- Anti-raid also needs the scheduler and logging alerts.
- Leveling before the `/userinfo` update.

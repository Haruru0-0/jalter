# Roadmap

Full detail: `docs/tiered-powers/specs/2026-10-14-feature-roadmap.md`. Original design: `docs/tiered-powers/specs/2026-10-13-discord-bot-design.md`. Plans in `docs/tiered-powers/plans/`.

## Build order
1. **Step 0 shared pieces**: generic scheduler (generalise the autorole ticker), mod-case store, extra intents (GuildModeration and GuildVoiceStates are already added by logging; GuildMessageReactions is still to come) and invite permissions - add each only when its first feature ships.
2. **Phase 2 Moderation**, strict order: mod cases + warn/kick/ban/timeout -> timed actions -> channel tools (purge, slowmode, lock) -> auto-mod -> verification -> anti-raid.
3. **Phase 3 Automation**, any order: autoresponder, reaction roles, quote.
4. **Phase 4 Community**: scheduler group (reminders, birthdays, stats channels); event group (AFK, leveling, starboard); staff group (tickets, confessions). Extend `/userinfo` last (needs levels, warnings, birthdays).
5. **Phase 5**: backup/restore, translate (needs an API key in `.env`).

## Done
- **Logging Carl-parity** (plan: `docs/tiered-powers/plans/2026-10-14-logging-carl-parity.md`): built and merged into `autorole-upgrade` (not yet deployed: run `npm run deploy` to register the new subcommands). See [[features-built]]. Modlog and cases are deliberately left for Phase 2 (mod-case store), which can log to the existing `mod` category.

## In progress
- **Scheduler (Step 0)**: brainstorming started 2026-10-14, no design written yet. Next: design, then plan in `docs/tiered-powers/plans/`.

## Planned, not built
- Everything in the build order above except logging.

## Dependencies worth remembering
- Verification must exist before anti-raid (lockdown raises verification).
- Anti-raid also needs the scheduler and logging alerts.
- Leveling before the `/userinfo` update.

# Jalter: Feature Order and Dependencies

Status as of 2026-10-14 (branch `autorole-upgrade`). Source: the design spec, `src/core/registry.js`, `src/modules.js`.

## Already built (Phase 1)
Panel, language, media, embeds, post, greet/leave/boost, autorole (timed roles, sticky memory via `reassign`, blacklist), logging, info.

**Stale entry:** `stickyroles` is still a "coming soon" stub in the registry, but `/autorole reassign` and `/autorole blacklist` already do it. Remove the stub (or make it point at `/autorole`).

## Shared pieces to build first (Step 0)
Several later features need the same groundwork. Building these once avoids doing it per feature.

| Piece | Needed by | Notes |
|---|---|---|
| Shared scheduler (built: `src/core/scheduler.js`, autorole timed roles run on it) | temp ban, timed timeout, reminders, birthdays, stats channels, anti-raid end, ticket auto-close | Autorole's ticker is the starting point |
| Mod-case store (case numbers, mod-action log category) | warn, kick, ban, timeout, auto-mod, anti-raid, info (warnings field) | Logging already has the category stub |
| New intents: GuildModeration, GuildVoiceStates, GuildMessageReactions | moderation/bans, leveling (voice), starboard, reaction roles | Add only when the first feature needing each ships |
| Bigger invite permissions: Kick, Ban, Moderate Members, Manage Messages, Manage Channels, Manage Nicknames | grouped under the features below | Update README invite list per phase |

## Phase 2: Moderation (strict order)
1. **Mod-case store + moderation commands**: warn, warnings, kick, ban, unban, timeout. Everything else here sits on top of cases.
2. **Timed actions**: temp ban, timed mute. Needs the scheduler.
3. **Channel tools**: purge, slowmode, lock/unlock. Independent of cases; can be built alongside step 2.
4. **Auto-mod**. Needs step 1 (its actions are delete, warn, timeout) and the message-content intent (already on).
5. **Verification**. Needs a member role to grant and a restricted state. Must exist before anti-raid, because lockdown "raises verification".
6. **Anti-raid**. Needs verification (5), mod alerts (logging) and the scheduler.

## Phase 3: Automation (any order, all independent)
- **Autoresponder**: depends only on embeds + placeholders (done).
- **Reaction roles**: needs reaction intent. Standalone.
- **Quote**: standalone. Image-card option reuses the greet card renderer.

## Phase 4: Community (three groups)
**A. Scheduler-based** (need Step 0 scheduler):
1. Reminders
2. Birthdays (also adds the birthday field for info)
3. Stats channels (rename rate limit)

**B. Message/event-based:**
1. AFK (nickname changes need Manage Nicknames)
2. **Leveling** (voice XP needs the voice intent). Build before the info update.
3. Starboard (reaction intent; shares setup with reaction roles)

**C. Staff workflows:**
1. Tickets (Manage Channels; transcripts go to a log channel)
2. Confessions (hidden mod record vs fully untraceable, per server)

**After A2 + B2 + Phase 2:** extend `/userinfo` with level, warnings and birthday. It depends on moderation, leveling and birthdays all existing, so it goes last.

## Phase 5: Extras
Both are independent of each other.
- Backup/restore: owner-only, Manage Roles/Channels at restore time.
- Translate: needs an outside service (free tier) and an API key in `.env`.

## Dependency map (A → B means A first)
```
scheduler ─┬─> temp ban/mute ─> (anti-raid end)
           ├─> reminders, birthdays, stats channels
           └─> ticket auto-close
mod cases ─┬─> warn/kick/ban/timeout ─> auto-mod
           ├─> anti-raid (alerts)
           └─> info warnings field
verification ─> anti-raid
leveling + birthdays + mod cases ─> info extension
embeds + placeholders (done) ─> autoresponder
```

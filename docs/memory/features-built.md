# Features built (Phase 1)

Branch at seeding time: `autorole-upgrade`. Most features are off by default; admins enable them. Setup replies are ephemeral and need Manage Server or the bot manager role.

- **Panel** `/panel overview`, `/panel manager-role` (always on).
- **Language** en / fr / ar per server (always on).
- **Media** `/media add`; only `/media add` registers an image, not uploading to the storage channel.
- **Embeds** `/embed create|edit|show`; use in text with `{embed:name}` (always on).
- **Post** `/post text|buttons`, mentions blocked, user must see and send in the channel (always on).
- **Greet / leave / boost** `/set ...` and `/test`; optional card image and DM (greet, boost). Retries as plain text if Discord rejects the embed.
- **Autorole** `/autorole add|remove|show|disable`, `timed add|remove` (delay 1m-30d), `reassign on|off` (30-day sticky roles), `blacklist add|remove`. See [[decisions]].
- **Logging** `/logging set|clear|event|ignore|unignore|prefix-add|prefix-remove|setup|export|import|status` plus enable/disable. 24 events in categories default, messages, members, join, server, voice, mod; `event` toggles one or `all`. Ignore lists (channels, members, prefixes) apply to message events only. Ban, unban, timeout, channel and role create/delete and some message deletes add a "By" field from the audit log (only if the entry is under 10 s old; no View Audit Log means no field, not an error). Voice logs only join, move, leave (mute/deafen logs nothing). `setup` makes a private "Logs" category with five channels; running it again makes new ones and leaves the old. `export`/`import` carry disabled events and prefixes only. The `mod` category exists but nothing logs to it. Code in `src/features/logging/`. See [[gotchas]], [[roadmap]].
- **Info** `/userinfo`, `/avatar`, `/banner`, `/serverinfo`.
- **Help** `/help [feature]` (always on, open to everyone). Overview lists each feature with its on/off state and top-level commands, plus the "coming soon" names. `/help <feature>` lists every runnable command path with its description. Built from `FEATURES` and the loaded commands' JSON, so new commands show up without editing help. Uncommitted at last check (branch `autorole-upgrade`).

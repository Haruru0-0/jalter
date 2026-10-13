# Jalter (Discord Bot): Design

## Intent
A multi-purpose Discord bot in the spirit of MEE6, Mimu and YAGPDB. The owner wants one bot that replaces several, configured entirely inside Discord (slash commands plus a `/panel` menu). No website dashboard.

## Goals
- Everything configurable in Discord via `/panel` (buttons, dropdowns, modals) and slash commands.
- Each feature can be turned on/off and configured per server. Settings persist across restarts.
- Built in phases; each phase is usable before the next begins.
- Three languages for bot messages and the panel: English, Arabic (RTL-aware text), French. Per-server setting; easy to add more.

## Non-goals
- No web dashboard. No music playback. No AI chat/image generation. No economy/shop.
- Not designed for thousands of servers (own server or a few).

## Anti-goals (failure even if it "works")
- Bot demanding Administrator when narrower permissions suffice.
- Settings lost on restart.
- Confessions traceable by ordinary members.
- Moderation commands usable by people without the matching Discord permission.

## Features (by phase)

**Phase 1: Core**
- `/panel` (overview; manager role set by Manage Server holders): shows what is on or off and the command that sets each feature up.
- Named embeds, Mimu-style: `/embed create`, `edit`, `list`, `delete`, `show` (parts: author, title, description, thumbnail, image, color, footer, timestamp, plus fields). Embeds and `/post` (plain text, link buttons) are always available to managers.
- Greet, leave and boost messages, Mimu-style: `/set greet|leave|boost channel|message`, `/test greet|leave|boost`; a message can contain `{embed:name}`; Mimu-style placeholders (`{user}`, `{user_name}`, `{server_membercount_ordinal}`, `{newline}`, ...).
- Auto role on join.
- Logging: message edit/delete, joins/leaves, nickname and role changes, channel/role/emoji changes. Log channel per category. No voice logging (owner decision).
- Language setting (en/ar/fr).
- User, avatar and server info commands.

**Phase 2: Moderation**
- YAGPDB-style commands: kick, ban (incl. temp ban), unban, timeout/mute (incl. timed), warn, warnings list/clear, purge, slowmode, lock/unlock channel. Mod-action log with case numbers.
- Auto-mod: spam, invite links, configurable bad words, mass mentions, excessive caps; action per rule (delete, warn, timeout).
- Anti-raid: join-rate threshold triggers lockdown (raise verification, optionally kick/timeout very new accounts, alert mods).
- Verification: new members get a restricted state until they pass a button (captcha-style option) check; then gain the member role.
- Sticky roles: roles restored when a member rejoins.

**Phase 3: Automation**
- Autoresponder: trigger (exact/contains), reply (text, optionally with `{embed:name}`), per-server list managed from the panel.
- Reaction roles: created from the panel; user chooses type per setup: button, emoji reaction, or command-created. Supports multiple roles per message and remove-on-unclick.
- Quote: `/quote` (and message context menu) renders a chosen message as a quote embed with author, text and jump link.

**Phase 4: Community**
- Leveling: XP from text (with cooldown) and voice time; `/rank`, leaderboards (text, voice); level-up roles; configurable XP rates and ignored channels.
- Tickets: panel button opens a private ticket channel/thread; staff role access; close with transcript to log channel.
- Reminders: `/remind` with relative or absolute time, delivered by ping or DM.
- Birthdays: members set theirs; bot announces in a channel; optional birthday role for the day.
- Confessions: anonymous submit via modal; posted by the bot; hidden mod-only record kept so moderators can trace abuse.
- Starboard: messages reaching N star reactions are reposted in a highlights channel.
- AFK: `/afk [reason]`; bot informs people who mention the member; cleared on their next message.
- Server stats channels: voice/text channels renamed to show member count etc., respecting Discord's rename rate limit.

**Phase 5: Extras (depend on outside pieces)**
- Backup and restore: snapshot channels, categories, roles and permissions; restore into a server.
- Translate: `/translate` and message context menu, via an external translation service.

## Constraints
- Language and stack: JavaScript (Node.js) with discord.js (builder's call, confirmed by the owner after comparing options). Storage: PostgreSQL, chosen by the owner, run in Docker for now. Runs on the owner's Windows PC first; must be movable to a cheap host later.
- Git: one branch per phase. `phase-1` holds Phase 1; `phase-2` is created from `phase-1` and holds Phases 1 and 2; and so on.
- Secrets (bot token, translation key) come from environment/`.env`, never committed.
- Slash commands and component interactions, not prefix commands (except where noted).
- Request only the permissions and intents each feature needs; message-content and server-members intents are required by autoresponder/auto-mod/leveling/sticky roles.

## Decided by the owner
- Everything inside Discord; no website.
- Feature list above, including languages en/ar/fr.
- Reaction roles: choice of button, emoji, or command, selected in the panel.

## Left to the builder
- Code structure, module system, database schema and migrations.
- Exact panel layout, wording of messages, default values (XP rates, auto-mod thresholds, raid thresholds).
- Which translation service (prefer a free tier); how backup data is stored.
- Captcha style for verification.

## Further decisions by the owner
- Confessions: the admin chooses per server between a hidden mod record (traceable by Manage Messages holders) and fully untraceable (no author stored).
- Translate: an outside free-tier service is fine.
- Moderation commands use Discord permissions only (no extra mod role).
- Leveling: MEE6-style defaults (about 15-25 XP per message, 1 minute cooldown, a set amount per voice minute), all adjustable in the panel.
- Tickets: each opens as a private channel in a Tickets category.
- Verification: the admin chooses button or captcha in the panel.
- Anti-raid: alert mods, raise verification and pause invites until a mod ends the lockdown. No automatic kicks.
- Birthdays: announcement in a channel, a birthday role for 24 hours, and a DM, all three.
- Reaction roles: the admin chooses per setup between toggle, add-only and one-role-at-a-time.
- Auto-mod: spam, invite links, bad words and mass mentions/caps are all on by default.
- Starboard: the admin sets the star count and emoji when enabling it.
- Stats channels: total members, online members, bots vs humans, and boosts.

## Second round of owner decisions
- Welcome, leave and **boost** messages: the admin chooses per event between plain text, embed, image card, and an additional DM greeting.
- Autoresponder: exact-message and contains matching only (no regex).
- Logging: messages, members (joins, leaves, nickname and role changes) and server changes. Voice logging is not requested.
- Reminders: delivered in the same channel with a ping.
- Sticky roles: all roles the bot is able to give back, with an exclusion list.
- AFK: replies when mentioned, adds [AFK] to the nickname, clears on the member's next message, server-wide.
- Backup: roles with permissions, and channels/categories with permission overwrites. Bot settings and emojis are not included.
- Quote: the admin chooses embed or image card in the panel.
- Embed builder: both a form with live preview (edit, send, save as template) and a quick slash command.
- Lock/unlock and slowmode: single channel, with the reason announced in the channel.
- Language: per server only.
- Info commands: user (join date, roles, account age, level, warnings, birthday), avatar and banner, server (members, boosts, channels, roles).

## Third round of owner decisions
- Auto role: one role for humans and a separate optional role for bots, given on join.
- Post message: plain text, embeds (builder or saved template), link buttons and role pings. Editing posted messages is not requested.
- Panel layout: each feature has its own command group (for example `/set greet channel`, `/autorole setup`; see the fifth round for the greet commands), and `/panel` is a summary/overview that shows what is on and links to each feature's settings. This replaces the earlier idea of one big menu for everything.
- The panel and setup replies are private (only the person who opened them sees them).

## Fourth round of owner decisions
- Every feature is off by default, including commands. An admin turns each on from its own setup command. `/panel` shows what is on and off.
- Images can come from either source: an external link the admin pastes, or an image stored in the media storage channel. Anywhere the bot takes an image, the admin chooses which.
- Media storage channel: the admin picks a channel where staff upload images. The embed builder, welcome cards and similar features can pick from those images instead of needing an outside link. Builder's note: Discord attachment links expire, so the bot should store the message and channel IDs and fetch a fresh link (or re-upload) whenever it uses an image, rather than saving the raw link.

## Fifth round of owner decisions: copy Mimu (docs.mimu.bot)
The owner asked for the same design as Mimu for embeds and for greet, leave and boost messages. This replaces the earlier `/welcome <event>` command, the embed builder with templates, and the text/embed/card style switch.
- **Greet, leave and boost are three separate features**, each with its own on/off state in `/panel`. Commands: `/set greet channel`, `/set greet message`, and the same for `leave` and `boost`; `/test greet`, `/test leave`, `/test boost`. Setting a message to `none` or `disable` turns that one off. `/set <kind> message` with no text opens a multi-line form (slash commands cannot take line breaks).
- **Embeds are named objects**, as in Mimu: name up to 16 characters with no spaces. `/embed create name:`, `/embed edit all` (buttons and forms, saved automatically), `/embed edit <part>` for one part (blank removes it), `/embed list`, `/embed delete`, `/embed show embed: [channel:]`. Parts: author (text and icon), title, description, thumbnail, image, color, footer, timestamp, plus fields (kept from the earlier design). No limit on the number of embeds (Mimu limits to 5 on free servers; not copied).
- **An embed is attached to a message by writing `{embed:name}` in its text** (greet, leave, boost messages; later also the autoresponder). The embed's parts may contain placeholders, including image parts (`{user_avatar}`, `{server_icon}`).
- **Placeholders (Mimu's names):** `{user}`, `{user_name}`, `{user_tag}`, `{user_avatar}`, `{server_name}`, `{server_icon}`, `{server_owner}`, `{server_createdate}`, `{server_membercount}`, `{server_membercount_ordinal}`, `{server_boostcount}`, `{date}`, `{newline}`. The earlier `{username}`, `{server}`, `{count}`, `{boosts}` keep working.
- **Embeds and `/post` are always available to managers** (no enable/disable). `/post` keeps plain text and link buttons; posting an embed is `/embed show`.
- Not copied from Mimu: the 5-embed limit, premium and webhook options, currency placeholders.
- Additions beyond Mimu's documented behavior (my calls): an optional image card (`/set <kind> card`, with `/set <kind> background`), an optional DM that sends the same message to the member (`/set greet dm`, `/set boost dm`; not for leave), and the "Add field" button.

## Calls made by me (not yet checked by the owner)
- `/panel` requires the Manage Server permission, or a "bot manager" role the owner can set in the panel. Not full Administrator.
- Moderation commands check the matching Discord permission, plus the bot's own role position (it refuses to act on anyone ranked above it). A configurable mod role is optional.
- Stack: Node.js, discord.js and PostgreSQL in Docker (confirmed by the owner). Storage and Discord access sit behind thin layers so they can be swapped.
- Scale: "own server or a few" is firm. The bot requires the message-content and server-members intents from the start, enabled in the developer portal. No degraded mode.
- Phase 1 ships the mod-action log category and panel entries for later features as disabled stubs.
- Each phase is done when its commands work end to end on a test server and survive a restart.
- Backup and restore: restore is add-only by default (it creates missing roles and channels and never deletes anything), is run by the server owner only, and asks for the extra permission only at that moment. Member role assignments are not included.
- Confessions: "moderators" means members with the Manage Messages permission.

## Open for the owner
Nothing.


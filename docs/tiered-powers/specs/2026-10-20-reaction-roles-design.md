# Reaction roles (Phase 3): design

Status: draft, builder check done, waiting for owner approval. Roadmap: `2026-10-14-feature-roadmap.md`, Phase 3 (Automation). Benchmark: Carl-bot's reaction roles (https://docs.carl.gg/#/roles?id=reaction-roles). Registry key `reactionroles` already exists as a "coming soon" stub (`src/core/registry.js`).

## Intent and why

Members should be able to pick their own roles (colors, pings, pronouns, games) from a message staff posts once. The owner wants Carl-bot parity for the everyday cases, so staff coming from Carl find the same concepts: the same message types (unique, verify, drop and so on), whitelist and blacklist, and a per-message limit. The owner also wants all three ways of picking: emoji reactions, buttons and dropdown menus, because some servers like reactions, some find buttons cleaner, and dropdowns suit long role lists.

## Goals

- A staff member can post a role message in a channel, or attach roles to a message the bot already posted, with a list of roles. Each role is picked by one of three input styles chosen per message: **reactions**, **buttons**, or one **dropdown** menu.
- Per-message **type** (Carl's names and behavior): `normal`, `unique`, `verify`, `drop`, `reversed`, `binding`, `lock`.
- Per-message **limit** (most roles one member may hold from the message), **whitelist** and **blacklist** of roles (who may use the message).
- Per-message **selfdestruct** timer (the message and its configuration are deleted after a delay).
- Management commands: add, remove, show, purge, edit, type changes, limit, whitelist, blacklist, selfdestruct, fix (re-add missing reactions).
- Safety on every grant: the bot only hands out roles it may give; dangerous roles are refused at setup.
- Replies in English, French and Arabic (`src/i18n/{en,fr,ar}.json`).
- Off by default; setup needs Manage Server or the bot manager role, replies are ephemeral (project convention).

## Non-goals (first version)

- Linked messages (one role across several messages), per-role member caps (`maxroles`), temporary roles (`temp`), `move`, one-command `aio`, `fixforeign`, message accent `color`. These are in Carl's docs and can be added later; temporary roles would use the scheduler.
- Mention-command (`@bot rr ...`) variants. Slash commands only.
- A web dashboard.
- Custom emoji from servers the bot is not in (this is what Carl's `fixforeign` works around).

## Anti-goals (a failure even if it technically works)

- Giving a member a role the bot should not hand out (admin or other dangerous permissions, a role above the bot, a managed/integration role, @everyone).
- A member getting a role they were blocked from (blacklist, whitelist, `lock`, a full `limit`, a `unique` or `binding` rule) because two clicks or reactions raced.
- Roles gained or lost silently with no sign to the member of what happened. Reactions need the bot to remove them or react again; buttons and menus answer ephemerally.
- Reaction events lost across a restart or for uncached messages leaving roles out of sync with the message.
- Deleting a role message or a role leaving stale configuration behind.

## Constraints

- Node 22, discord.js 14, ESM, Postgres. Features are modules in `src/features/reactionroles/` listed in `src/modules.js`; the registry entry changes from stub to a real feature with command `/reactionroles` (guard with `requireManager: true`).
- Needs the new intent `GuildMessageReactions` in `src/index.js`. `Partials.Message` is already set, and `Partials.Reaction` must be added so reactions on uncached messages are received.
- New table(s) via a migration `009_reaction_roles.sql`. Shared role checks come from `src/core/role-safety.js` (`botCanGive`, `isDangerousRole`, `callerCanGive`), which autorole already uses.
- Components follow the verification pattern: one component prefix (`reactionroles`) with a `handle` function, customIds carrying the message id.
- The bot needs Manage Roles, and for reactions also Add Reactions, Read Message History and Manage Messages (to remove a member's reaction when the type needs it); document them in the README invite list.
- Any user-facing text goes in all three i18n files.

## What it does

### The role message

A **reaction role message** is always an **embed message** the bot posted: a role message is an embed (the named embeds of the embeds feature, edited with `/embed`) with the roles attached to it. It is stored with:

| Field | Meaning |
|-------|---------|
| `embed_name` | name of the embed in the embeds feature that this message was posted from, or none when adopted from an embed message the bot posted earlier |
| `style` | `reactions`, `buttons` or `menu`; chosen when the message is created and fixed afterwards |
| `type` | `normal`, `unique`, `verify`, `drop`, `reversed`, `binding`, `lock` (default `normal`) |
| `limit` | max roles one member may hold from this message, or none |
| `whitelist` / `blacklist` | role ids: with a whitelist only holders may use the message; blacklist holders may not |
| `selfdestruct_at` | when the message is deleted, or none |
| entries | up to 20 (see below): the pairing of one choice to one role |

An **entry** is `(emoji | label, role)`. Reactions use an emoji; buttons and menus use a label (emoji optional). The same role cannot appear twice on one message.

Limits (builder confirms against Discord): a message holds at most 20 reactions, 25 buttons (5 rows of 5) or 25 menu options. This design caps all styles at 20 entries per message for simplicity (my call).

### Types (Carl's behavior, translated per style)

- **normal**: picking toggles the role. Reactions: add the reaction to gain it, remove it to lose it. Buttons: each click toggles. Menu: the member's selection is the set of roles they want (selecting adds, deselecting removes).
- **unique**: a member holds at most one role from the message; choosing a new one removes the old (the old reaction is removed by the bot).
- **verify**: choices only add roles, never remove. Reactions are removed by the bot after the grant; removing a reaction does nothing.
- **drop**: choices only remove roles. Reacting removes the role, then the reaction is cleared.
- **reversed**: reacting removes the role, removing the reaction adds it. For buttons and menus (no "remove reaction" action) `reversed` is refused; the builder returns a localized error.
- **binding**: `verify` plus `unique`: one permanent choice per member from this message.
- **lock**: no role is handed out or taken; every pick gets a localized "this role message is locked". Reactions are removed.

### Limit, whitelist, blacklist

Checked before every grant, in this order: type lock, blacklist, whitelist, binding/unique state, limit. Any failure refuses the pick with a clear message and changes nothing. For reactions, the refused reaction is removed by the bot.

### Commands (`/reactionroles`)

All need Manage Server or the bot manager role (guard `requireManager: true`), replies ephemeral. The feature must be enabled (`enable` and `disable` subcommands via `handleToggle`).

- `create embed style [channel] [type]`: post the named embed `embed` (autocompleted from the server's embeds, like `/embed`) in `channel` (default the current one) through the embeds feature's `buildEmbedPayload`, so placeholders, images and validation behave exactly as in `/embed post`. The message starts with no entries; staff then `add` them. The embed text is written and edited with `/embed`, not here.
- `adopt message_id style [channel]`: attach role entries to an embed message the bot already posted (Carl's `add` on an existing message). Only messages authored by the bot that have an embed; the embed is kept as is.
- `add message_id role [emoji] [label]`: add one entry. Emoji is required for `reactions`, label or emoji for `buttons` and `menu`. Updates the message (adds the reaction, or re-renders buttons or menu).
- `builder message_id`: an interactive ephemeral panel for adding several roles to one message without typing a command each time (the owner's choice, next to `add`; same pattern as the embed editor panel and verification's builder). It shows the message's current entries and offers a role picker (a role select menu), a button that opens a small modal for the emoji or label, an Add button, a remove control for existing entries, and Done. Every Add goes through the same checks as `add`. The panel works only for its opener, expires after 10 minutes and is rebuilt from the database on each interaction, so a restart loses nothing.
- `remove message_id role`: remove one entry (its reaction, button or option goes too).
- `show [message_id]`: list all messages with their id, channel, type, style and entry count; with an id, show that message's entries, type, limit, lists and timer.
- `type message_id type`: change the type.
- `limit message_id number`: set (0 = none) the limit.
- `whitelist add|remove message_id role` and `blacklist add|remove message_id role`, plus `clear` for each list.
- `selfdestruct message_id duration`: set the timer (0 = cancel). Duration parsed by `core/duration.js`; handled by a scheduler job `reactionroles.destruct` (key `message_id`).
- `refresh message_id`: re-render the message from its named embed after the embed was changed with `/embed edit`, keeping its reactions, buttons or menu. Not available for adopted messages (no named embed); for those, the embed can only be changed by reposting.
- `purge [message_id]`: remove all entries from one message, or from the whole server; each asks for a confirm button first (server-wide always).
- `fix [message_id]`: re-add missing reactions on `reactions`-style messages, re-render buttons or menu if the message lost its components.
- `status`: show the feature settings and any messages with problems (deleted message, deleted role, role the bot can no longer give). Enable, disable and status are the only toggles.

### Safety checks (every time a role is given)

- At **setup** (`add`, `adopt`): refuse a role if `isDangerousRole`, if the bot cannot give it (`botCanGive`: managed, above the bot's top role, @everyone), or if the caller could not give it themselves (`callerCanGive`).
- At **grant time**: re-check `botCanGive` (roles can change). If it now fails, refuse and log once per hour per message, like verification's staff-role log, so a broken message does not spam.
- A pick by a bot is ignored.

### How a pick is processed

One function, `applyChoice(ctx, member, message, entry, action)`, used by all three input styles, does the checks and role change and returns a reason code. Input styles only translate their event into `(member, message, entry, 'add'|'remove'|'toggle')`.

- **Reactions**: `MessageReactionAdd` and `MessageReactionRemove` (bot's own reactions and bots ignored). Fetch partial reaction/message/user as needed. After a pick the bot removes the member's reaction when the type needs it (verify, drop, lock, refused picks, the old reaction under unique).
- **Buttons**: customId `reactionroles:btn:<messageId>:<entryId>`; ephemeral reply says what happened ("You now have X" / "You no longer have X" / the refusal).
- **Menu**: customId `reactionroles:menu:<messageId>`; the submitted selection is compared with the member's current roles from this message; roles in the selection are added, roles out of it are removed; ephemeral summary reply.
- Role changes for one member on one message are serialized (an in-memory per-member lock keyed by message and user) so a fast double click or react cannot bypass `limit`, `unique` or `binding`.

### Data

One migration `009_reaction_roles.sql`:

- `reaction_role_messages(guild_id, message_id primary key, channel_id, embed_name, style, type, "limit", whitelist jsonb, blacklist jsonb, selfdestruct_at, created_by, created_at)`
- `reaction_role_entries(id, message_id references reaction_role_messages on delete cascade, role_id, emoji, label, position)`, unique on `(message_id, role_id)` and on `(message_id, emoji)` where emoji is not null.
- Binding picks need a record that a member has chosen: `reaction_role_bindings(message_id, user_id, role_id)`, primary key `(message_id, user_id)`.

The feature's enabled flag lives in `guild_settings` (`reactionroles`) as for other features; no per-message data goes in `config`.

### Events and housekeeping

- `MessageDelete` / `MessageBulkDelete`: delete the stored message (cascades to entries and bindings), unless the bot's own `selfdestruct` job already did.
- `RoleDelete`: delete entries for that role; the message is updated (reaction removed, button/menu re-rendered). A message left with no entries stays stored but is flagged in `status`.
- `ChannelDelete`: delete stored messages in the channel.
- `GuildMemberRemove`: delete the member's binding rows for the guild (so a rejoin can choose again); my call.
- Selfdestruct is a scheduler job `reactionroles.destruct`, key `message_id`, which deletes the Discord message and the stored rows; a message already gone counts as success. Pinned messages are not protected here (Carl protects pinned messages from purge; our `purge` is about configuration, not deleting messages).

### Permissions and failure messages

- Missing Manage Roles, Add Reactions, Read Message History or Manage Messages: the command that needs it replies with a localized refusal naming the permission; nothing changes.
- A pick fails because the bot lost the role hierarchy: the member sees a short "I cannot give this role right now, ask staff", not an error.
- Reaction style on a message the bot cannot see (channel permission removed): `fix` and `status` surface it.

## Added after review

- **Clear all reactions:** a `MessageReactionRemoveAll` event on a reaction-style message changes nothing in the database; `status` flags the message as missing its reactions and `fix` re-adds them.
- **Changing a type:** existing role holders keep their roles; the new type applies to later picks only. `limit` and `unique` are never enforced retroactively.
- **Emoji input:** `add` accepts a Unicode emoji or a custom emoji of this server; a custom emoji the bot cannot use is refused with a clear message.
- **Staff-action logging:** create, adopt, add, remove, type, limit, whitelist, blacklist, selfdestruct, refresh and purge each write one `mod` log line (as the channel tools do, through `logTool`-style `modAction` lines). Member picks are never logged.
- **Rate limits:** a failed role change is reported to the member ("I could not change your roles, try again") and never retried silently.

## Decisions I made (the owner can reverse them)

- All three input styles from day one, chosen per message and fixed once created (editing the style would mean rebuilding the message).
- Cap of 20 entries per message in every style.
- `reversed` is refused for buttons and menus.
- Binding rows are cleared when a member leaves.
- `drop`, `verify`, `lock` clear the member's reaction after the pick.
- Slash commands only; no mention commands.
- Selfdestruct deletes the Discord message too (Carl does).

## Builder-check answers

- **Downtime (owner's answer):** reactions made while the bot was offline are not replayed. Only `fix` re-adds the bot's own reactions; it never grants or removes roles. Roles may drift after downtime; buttons and menus are unaffected.
- **Feature disabled (my call):** existing messages stay but go inert. Every event and component handler checks the enabled flag; a button or menu pick gets an ephemeral "reaction roles are off"; a reaction pick is ignored (the reaction is left alone).
- **`adopt` (my call):** refused if the message already has components. Existing reactions from members are ignored (not treated as picks); the bot adds its own reactions for the entries. Overwriting another feature's components is never allowed.
- **Types on buttons and menus (my call):** `drop` means a pick removes the role; `verify` means a pick only adds (a second click does nothing); `lock` refuses every pick. For a `unique` or `binding` menu the max selection is set to 1. A menu submission that violates `limit` is refused whole, with nothing applied, so `applyChoice` decides on the full set of picks and returns one result.
- **What counts toward `limit`, `unique`, `binding` (my call):** any role the member currently holds that matches an entry on this message, however it was granted. Only `binding` stores anything (the `reaction_role_bindings` row, so a permanent choice survives the member later losing the role).
- **Process model (my call):** one bot process; the in-memory per-member lock is enough. A sharded deployment would need a database lock instead.

## Left to the builder

- Exact command and option names and the shape of the create flow (one command with options, or a small modal).
- How `create` and `refresh` call the embeds feature (`getEmbed`, `buildEmbedPayload`); whether to extract a small shared helper for posting an embed with extra components.
- Whether `show` paginates.
- Exact customId layout and the lock implementation, as long as picks per member per message are serialized.
- The test plan; tests hit the database (`npm test`, concurrency 1), so the pure parts (`applyChoice` decision, type rules, limit logic) should be testable without Discord.
- Updating the README invite list, `docs/testing-checklist.md` (new section), and `docs/memory/` (roadmap, features-built, architecture, gotchas).

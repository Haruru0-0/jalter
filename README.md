# Jalter

Jalter is a Discord bot with a modular design. Every feature is off by default and a server admin turns it on. Replies to setup commands are private (ephemeral) and need the Manage Server permission or the bot manager role.

## Phase 1 features

- Panel: `/panel overview` shows which features are on, off or coming later (always on).
- Language: English, French and Arabic, set per server (always on).
- Media: store images for the server with `/media add` and use them by name. Uploading a file straight into the storage channel does not register it; only `/media add` does.
- Embeds: `/embed quick`, an interactive builder (with an Add field button), and saved templates.
- Post: send text or embeds as the bot, with mentions blocked. You can only post in channels where you can see and send messages yourself.
- Welcome, leave and boost messages in text, embed or card style, with an optional DM and an image (`/welcome image`: the card background, or the embed image).
- Auto role: separate roles for new humans and new bots. The bot's highest role must sit above any role it gives, or Discord refuses.
- Logging: messages (edits and deletes), members (joins, leaves, nickname and role changes) and server changes (channels, roles, emojis). No voice logging yet.
- Bot manager role: `/panel manager-role` lets a role use the setup commands. Only members with Manage Server can set or clear it, and @everyone or bot-managed roles are refused.
- Info: `/userinfo`, `/avatar`, `/banner`, `/serverinfo`.

## Prerequisites

- Node.js 22 or newer
- Docker Desktop (runs Postgres)

## Setup

1. Copy `.env.example` to `.env` and fill it in:
   - `DISCORD_TOKEN`: the bot token from the developer portal.
   - `CLIENT_ID`: the application ID.
   - `DEV_GUILD_ID` (optional): a test server ID. When set, commands register to that server only and update instantly.
   - `DATABASE_URL`: defaults to the Postgres from `docker-compose.yml`.
2. Run:

```
docker compose up -d
npm install
npm run deploy
npm start
```

`npm run deploy` prints `Registered N commands ...` and `npm start` prints `Logged in as <bot>`.

Postgres only listens on this computer (`127.0.0.1`). Before hosting the bot anywhere reachable from the network, change the database password (`POSTGRES_PASSWORD` in `docker-compose.yml` and the password in `DATABASE_URL`) from the default `bot`.

## Discord developer portal

1. Go to the Discord developer portal and create an application.
2. Open the Bot tab, create the bot and copy its token into `.env`.
3. Under Privileged Gateway Intents enable Server Members and Message Content. The bot also uses the Guilds, Guild Messages and Guild Expressions (emoji events, used by logging) intents; those are not privileged, so they are granted automatically and need no switch in the portal.
4. Copy the application ID into `.env` as `CLIENT_ID`.
5. Invite the bot with the `bot` and `applications.commands` scopes and these permissions: View Channels, Send Messages, Read Message History, Embed Links, Attach Files, Manage Roles. Read Message History lets the bot fetch stored images from the media channel.

## Tests

```
npm test
```

The tests use Postgres, so run `docker compose up -d` first.

## Branching

One branch per phase. Phase 1 lives on `phase-1`. Phase 2 starts with `git switch -c phase-2` from `phase-1`.

## Manual check on a test server

Run these on a test server with the bot invited and started. Confirm each item.

1. `/panel overview` shows Panel and Language as Core, other Phase 1 features Off, later phases Coming soon.
2. As a normal member (no Manage Server), every setup command is refused with the permission message.
3. `/language set` to French changes `/panel overview` to French; Arabic shows Arabic.
4. `/media setup`, `/media add logo`, `/media list`; then `/embed enable`, `/embed quick` with image `logo` shows the image.
5. `/embed builder`: fill the form, see the preview, press Add field and add a field, press Send; press Save as template; `/embed template use`.
6. A text over the limits (for example a 300-character title) shows the error and posts nothing.
7. `/post enable`, `/post text` with `@everyone` in the text does not ping.
8. `/welcome setup join`, then `/welcome test join` in text, embed and card styles; the card looks right with an Arabic username; the DM option works; `/welcome message` changes the embed text; `/welcome image join logo` shows the image.
9. `/autorole setup` gives the right role to a new human account and to a bot.
10. `/logging set messages`: edit and delete a message and see the log; edits inside the log channel itself are not logged.
11. `/info enable`, then `/userinfo`, `/avatar`, `/banner`, `/serverinfo` work; with `/info disable` they refuse.
12. Delete the welcome channel, trigger `/welcome test join`: the bot does not crash.
13. Stop and restart the bot, then run `docker compose restart`: all settings are still there.

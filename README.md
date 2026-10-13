# Jalter

Jalter is a Discord bot with a modular design. Most features are off by default and a server admin turns them on. Replies to setup commands are private (ephemeral) and need the Manage Server permission or the bot manager role.

## Phase 1 features

- Panel: `/panel overview` shows which features are on, off or coming later (always on).
- Language: English, French and Arabic, set per server (always on).
- Media: store images for the server with `/media add` and use them by name. Uploading a file straight into the storage channel does not register it; only `/media add` does.
- Embeds (always available): save named embeds with `/embed create`, edit them with buttons or `/embed edit`, and post one with `/embed show` (in the channel you pick, default the current one). Use one in a message with `{embed:name}`.
- Post (always available): send text (`/post text`) or text with a link button (`/post buttons`) as the bot, with mentions blocked. You can only post in channels where you can see and send messages yourself.
- Greet, leave and boost messages, set with `/set greet|leave|boost ...` (channel, message, card, background, and DM for greet and boost) and tried out with `/test`. A message can hold `{embed:name}` and an optional card image.
- Auto role: give new members one or more roles, for humans, for bots, or both. The bot's highest role must sit above any role it gives, or Discord refuses.
  - `/autorole add role:<role> [target:humans|bots]` adds a role, `/autorole remove role:<role>` removes it, `/autorole show` lists the setup, `/autorole disable` turns the feature off; `/autorole add` turns it back on, even with a role already listed.
  - `/autorole timed add delay:<time> role:<role>` gives a role to a new human only after a delay, such as `30m`, `2h` or `1d` (1 minute to 30 days). `/autorole timed remove role:<role>` cancels it, including for members already waiting.
  - `/autorole reassign state:on|off` (off by default): a member who leaves gets their roles back if they return within 30 days. Blacklisted, managed and above-the-bot roles are never remembered.
  - `/autorole blacklist add|remove role:<role>` keeps a role from being given back to members who leave and return.
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
4. `/media setup`, `/media add logo`, `/media list`.
5. `/embed create name:rules` works without enabling anything and opens the editor; use the buttons to set the title, description and fields, then `/embed edit title ...` and `/embed show`. An embed with `logo` as its image shows the image.
6. A text over the limits (for example a 300-character title) shows the error and saves nothing.
7. `/post` works without enabling anything; `@everyone` in the text does not ping.
8. `/set greet channel`, then `/set greet message` with text, and again without text (it opens the form). Put placeholders such as `{user}` and `{server_name}` in it, add `{embed:rules}`, and run `/test greet`. Then `/set greet message none` turns that one message off (`/test greet` says it is off) while the leave and boost messages keep working.
9. `/set greet card on` and `/test greet`: the card looks right with an Arabic username. Try `/set greet background logo` and `/set greet dm on` (the DM arrives).
10. Repeat step 8 for `/set leave ...` and `/set boost ...` with `/test leave` and `/test boost`, and the card and DM checks of step 9 for boost. Leave has the card and background but no `dm` option.
11. `/autorole add role:<role>` for humans and `/autorole add role:<role> target:bots` with another role, then `/autorole show`: both are listed. A new human account gets the first role and a bot gets the second.
12. `/autorole timed add delay:1m role:<role>`, then add a new account: it gets the role after about a minute.
13. `/autorole timed add delay:1d role:<role>`, add a new account, then `/autorole timed remove role:<role>` with that role: the waiting member never gets it.
14. `/autorole reassign state:on`, give a member a role, let them leave and rejoin: the roles come back. With `state:off` they do not.
15. With `reassign` on, give a member a role, then `/autorole blacklist add` that role. Have the member leave and rejoin: they do not get the role back. `blacklist remove` allows it again.
16. `/logging set messages`: edit and delete a message and see the log; edits inside the log channel itself are not logged.
17. `/info enable`, then `/userinfo`, `/avatar`, `/banner`, `/serverinfo` work; with `/info disable` they refuse.
18. Delete the greet channel, run `/test greet`: the bot does not crash.
19. Stop and restart the bot, then run `docker compose restart`: all settings are still there.

# Create the Discord bot and run Jalter

This guide takes you from nothing to a Jalter bot online in a test server. It uses the Discord developer portal, so you need a Discord account and a server where you have Manage Server (create a throwaway server for testing).

## 1. Create the application

1. Open <https://discord.com/developers/applications> and sign in.
2. Click **New Application**, name it (for example "Jalter"), accept the terms and click **Create**.
3. On **General Information** copy the **Application ID**. This is `CLIENT_ID` in `.env`.

## 2. Create the bot user and copy its token

1. Open the **Bot** tab.
2. Click **Reset Token**, confirm, and copy the token. This is `DISCORD_TOKEN` in `.env`. Discord shows it once; if you lose it, reset it again.
3. Treat the token like a password. Never commit it or paste it in chat. `.env` is git-ignored. If it leaks, reset it right away.
4. Optional: turn **Public Bot** off so nobody else can invite your bot.

## 3. Turn on the privileged intents

Still on the **Bot** tab, under **Privileged Gateway Intents**, switch on:

- **Server Members Intent** (joins, leaves, role changes, auto role)
- **Message Content Intent** (message edit and delete logs, invite detection)

Save the changes. Without these two the bot refuses to log in, or logs show "content not available".

The other intents Jalter uses (Guilds, Auto Moderation Execution, Guild Messages, Guild Expressions, Guild Moderation, Guild Voice States) are not privileged and need no switch.

## 4. Invite the bot to your server

1. Open **OAuth2** then **URL Generator**.
2. Under **Scopes** tick `bot` and `applications.commands`.
3. Under **Bot Permissions** tick:
   - View Channels, Send Messages, Read Message History, Embed Links, Attach Files (core)
   - Manage Roles (auto role, the moderation mute role and the auto-mod timed role)
   - Kick Members, Ban Members, Moderate Members (moderation: `/kick`, `/ban` and `/unban`, `/timeout` and `/untimeout`)
   - View Audit Log (logging "By" field; optional)
   - Manage Messages (`/purge messages`, and auto-mod deleting offending messages)
   - Manage Nicknames (auto-mod nickname check; optional)
   - Manage Server (auto-mod reading Discord AutoMod rules and receiving their events; optional, only for the `native` rule)
   - Manage Channels (`/purge channel`, `/slowmode`, `/lock`, `/unlock`; also `/logging setup` and the log, welcome, goodbye and boost channels the bot creates when none was chosen)
   - Verification: Manage Roles (creates and grants the Verified role, which must sit below the bot's top role), Manage Channels (creates the verify channel and edits channel overwrites), View Channel, Send Messages, Embed Links and Attach Files (the verify message and the captcha image). Run `npm run deploy` to register `/verification`.
4. Copy the generated URL, open it, choose your server and click **Authorize**.

The bot appears offline until you start it.

Important for auto role: in Server Settings > Roles drag the bot's role **above** every role it should give. Discord refuses to assign roles higher than the bot's own.

## 5. Find your test server ID (recommended)

1. In Discord open User Settings > Advanced and turn on **Developer Mode**.
2. Right-click your server icon and choose **Copy Server ID**. This is `DEV_GUILD_ID`.

With `DEV_GUILD_ID` set, slash commands register to that server only and appear instantly. Without it they register globally and can take up to an hour to show up.

## 6. Configure and start Jalter

1. Copy `.env.example` to `.env` and fill it in:

   ```
   DISCORD_TOKEN=<token from step 2>
   CLIENT_ID=<application ID from step 1>
   DEV_GUILD_ID=<server ID from step 5>
   DATABASE_URL=postgres://bot:bot@localhost:5432/bot
   ```

2. Start Postgres (Docker Desktop must be running), install and register commands:

   ```bash
   docker compose up -d
   npm install
   npm run deploy
   npm start
   ```

3. `npm run deploy` prints `Registered N commands ...`. `npm start` prints `Logged in as <bot>` and the bot shows online.
4. Run `npm run deploy` again whenever commands change (new features, new subcommands).

## 7. First checks in Discord

1. Type `/` and confirm Jalter's commands appear.
2. Run `/panel overview`. Panel and Language show as Core, the other features as Off.
3. Run `/help` to see every feature and its commands.
4. Continue with [testing-checklist.md](testing-checklist.md) to test each feature.

## Troubleshooting

| Symptom | Cause and fix |
|---|---|
| Bot crashes on start with "Used disallowed intents" | Step 3: enable Server Members and Message Content, save, restart. |
| Bot is online but `/` shows no Jalter commands | Run `npm run deploy`. For global commands wait up to an hour, or set `DEV_GUILD_ID`. Re-invite with the `applications.commands` scope if still missing. |
| "Missing Access" or "Missing Permissions" in the log | Give the bot the permission from step 4, and check channel-level overrides. |
| Auto role does nothing | The bot's role is below the role it should give (step 4). |
| `/logging setup` fails | The bot lacks Manage Channels. |
| `/purge`, `/slowmode`, `/lock` or `/unlock` says the bot is missing permissions | Give the bot Manage Messages (purge messages) or Manage Channels (the rest), plus Manage Roles for lock, unlock and purge channel, and check the channel overrides (View Channel; Read Message History for purge messages; Manage Threads for slowmode in a thread). Send Messages is not needed for these commands; if it is missing the public notice is skipped and the reply says so. |
| Auto-mod does nothing | Check in order: `/automod status` shows the feature on and the rule on; the member is not exempt (Manage Server, bot manager role, Moderate Members, a moderation permitted role, `/automod exempt` roles and channels, and bots are never checked); the bot has View Channel, Read Message History and Manage Messages in the channel (to delete), Moderate Members (timeout) and Manage Nicknames (rename); the bot's role is above the member's (otherwise the delete works but warn, timeout and rename are refused). The console prints a warning when Discord refuses an action. |
| Logs have no "By" field | The bot lacks View Audit Log, or the audit entry was over 10 seconds old. |
| Database connection error | Docker Desktop is not running. Start it, then `docker compose up -d`. |
| Setup commands say you lack permission | You need Manage Server or the bot manager role (`/panel manager-role`). |
| Token leaked | Bot tab > Reset Token, update `.env`, restart. |

## Before hosting it anywhere reachable

Change the Postgres password from the default `bot` (`POSTGRES_PASSWORD` in `docker-compose.yml` and in `DATABASE_URL`). Postgres only listens on `127.0.0.1` by default.

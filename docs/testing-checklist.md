# Feature testing checklist

Run these on a test server with the bot invited and running (see [discord-bot-setup.md](discord-bot-setup.md)). Tick each box as you confirm it. Use two accounts when a step needs a normal member, and a spare account (or alt) for join and leave tests.

Automated tests (`npm test`, needs `docker compose up -d`) cover the code. This list covers what only a real Discord server shows.

## 0. Before you start

- [ ] `npm run deploy` printed `Registered N commands ...`, `npm start` printed `Logged in as <bot>`.
- [ ] The bot's role is above every role you will test giving.
- [ ] The bot has View Audit Log and Manage Channels (for the logging tests).

## 1. Panel and permissions

- [ ] `/panel overview` shows Panel, Help and Language as Core, the Phase 1 features Off, later phases Coming soon.
- [ ] As a normal member (no Manage Server) every setup command is refused with the permission message.
- [ ] `/panel manager-role role:<role>` lets a member with that role run setup commands. `/panel manager-role-clear` removes it. @everyone and bot-managed roles are refused.

## 2. Help

- [ ] `/help` lists every feature with On/Off and its commands, and the Coming soon list.
- [ ] `/help feature:logging` lists all logging subcommands with descriptions.
- [ ] `/help feature:autorole` lists every autorole command.
- [ ] `/help feature:nonsense` says there is no such feature.
- [ ] A normal member can use `/help`.

## 3. Language

- [ ] `/language set` to French: `/panel overview` and `/help` are in French.
- [ ] Arabic shows Arabic (right-to-left). Set it back to English afterwards.

## 4. Media

- [ ] `/media setup` turns the feature on and prepares storage.
- [ ] `/media add name:logo` with an image attached, then `/media list` shows `logo`.
- [ ] Uploading a file straight into the storage channel does not register it.
- [ ] `/media remove name:logo` removes it. Re-add it for later steps.
- [ ] `/media disable` and `/media enable` turn it off and on.

## 5. Embeds

- [ ] `/embed create name:rules` works without enabling anything and opens the editor.
- [ ] The buttons set title, description and fields; `/embed edit title ...` changes the title.
- [ ] `/embed show name:rules` posts it in the current channel and in a channel you pick.
- [ ] An embed with `logo` as its image shows the image.
- [ ] A 300-character title shows an error and saves nothing.
- [ ] `/embed list` and `/embed delete` work.

## 6. Post

- [ ] `/post text` sends the text as the bot; `@everyone` in it does not ping.
- [ ] `/post buttons` sends text with a working link button.
- [ ] You cannot post in a channel you cannot see or send in yourself.

## 7. Greet, leave and boost messages

Repeat for `greet`, `leave` and `boost` (leave has no `dm` option).

- [ ] `/set greet channel channel:<channel>` turns it on.
- [ ] `/set greet message` with text, and again without text (it opens a form).
- [ ] Placeholders such as `{user}` and `{server_name}` and `{embed:rules}` work in `/test greet`.
- [ ] `/set greet message none` turns that message off (`/test greet` says so); the other two features keep working.
- [ ] `/set greet card on` then `/test greet`: the card looks right with an Arabic username.
- [ ] `/set greet background logo` uses the stored image.
- [ ] `/set greet dm on`: the DM arrives (greet and boost only).
- [ ] A real join, leave and server boost send the matching message.
- [ ] Delete the greet channel, run `/test greet`: the bot does not crash.

## 8. Auto role

- [ ] `/autorole add role:<role>` for humans and `/autorole add role:<role> target:bots` with another role; `/autorole show` lists both.
- [ ] A new human account gets the first role, a bot gets the second.
- [ ] `/autorole timed add delay:1m role:<role>`: a new account gets the role after about a minute.
- [ ] `/autorole timed add delay:1d role:<role>`, add a new account, then `/autorole timed remove role:<role>`: the waiting member never gets it.
- [ ] `/autorole reassign state:on`: give a member a role, they leave and rejoin, the roles come back. With `state:off` they do not.
- [ ] With reassign on, `/autorole blacklist add` a role: it is not given back. `blacklist remove` allows it again.
- [ ] `/autorole disable` turns it off; `/autorole add` turns it back on.

## 9. Logging

Set up a log channel first: `/logging setup` (needs Manage Channels) or `/logging set category:messages channel:<channel>`.

### Messages

- [ ] Edit and delete a message: both logs appear. Edits inside the log channel itself are not logged.
- [ ] Delete a message as a moderator (View Audit Log granted): the log has a "By" field.
- [ ] Bulk delete several messages (for example with a purge bot): one log with the count.
- [ ] Post a `discord.gg/...` invite link: an invite log appears.

### Members

- [ ] Nickname change, role added and role removed are logged.
- [ ] Change your avatar or username: logged in servers the bot shares with you.
- [ ] Ban a test member, then unban: each log has a "By" field with you.
- [ ] Time out a test member, then remove the timeout: each is logged, with the end time and "By".
- [ ] Remove View Audit Log from the bot and repeat a ban: the log still arrives, without "By".

### Join and leave

- [ ] A join and a leave log in the join channel. With no join channel set they go to the members channel.

### Server

- [ ] Create, rename and delete a channel, a role and an emoji: each is logged; channel and role create/delete show "By".
- [ ] Rename the server or change its icon: a server update log.
- [ ] Delete or rename the log channel itself: that change is still logged (in another log channel).

### Voice

- [ ] `/logging set category:voice channel:<channel>`, then join, switch and leave a voice channel: three logs.
- [ ] Muting, deafening or starting a stream logs nothing.

### Controls

- [ ] `/logging event event:messageEdit enabled:false`: edits are no longer logged; `enabled:true` brings them back.
- [ ] `/logging event event:all enabled:false` turns everything off, `enabled:true` back on.
- [ ] `/logging ignore channel:<channel>`, `member:<member>` and `/logging prefix-add prefix:!`: messages in that channel, by that member, or starting with `!` are not logged. `unignore` and `prefix-remove` undo each.
- [ ] `/logging prefix-add` with an empty prefix is refused.
- [ ] `/logging status` shows the channels, disabled events, ignored channels and members, and prefixes.
- [ ] `/logging clear category:voice` stops voice logs.
- [ ] `/logging disable` stops all logging; `/logging enable` resumes.

### Setup, export and import

- [ ] `/logging setup` creates a private "Logs" category with log-messages, log-members, log-joins, log-server and log-voice, and points the categories at them. @everyone cannot see it.
- [ ] Running `/logging setup` again creates a second "Logs" category (the old one stays).
- [ ] `/logging export` gives a code. On another test server `/logging import code:<code>` copies toggles and prefixes (not channels or ignored members).
- [ ] `/logging import code:garbage` shows an error and changes nothing.

## 10. Info commands

- [ ] `/info enable`, then `/userinfo`, `/avatar`, `/banner`, `/serverinfo` all work.
- [ ] `/info disable`: those commands refuse.

## 11. Permissions and robustness

- [ ] Every setup reply is ephemeral (only you see it).
- [ ] A normal member cannot run `/logging`, `/autorole`, `/set`, `/media` setup commands.
- [ ] Stop the bot and start it again, then run `docker compose restart`: all settings are still there.
- [ ] The console shows no unhandled errors during the steps above.

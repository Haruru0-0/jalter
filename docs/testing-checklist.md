# Feature testing checklist

Run these on a test server with the bot invited and running (see [discord-bot-setup.md](discord-bot-setup.md)). Tick each box as you confirm it. Use two accounts when a step needs a normal member, and a spare account (or alt) for join and leave tests.

Automated tests (`npm test`, needs `docker compose up -d`) cover the code. This list covers what only a real Discord server shows.

## 0. Before you start

- [ ] `npm run deploy` printed `Registered N commands ...`, `npm start` printed `Logged in as <bot>`.
- [ ] The bot's role is above every role you will test giving.
- [ ] The bot has View Audit Log and Manage Channels (for the logging tests), and Kick Members, Ban Members and Moderate Members (for the moderation tests). The auto-mod tests also need Manage Messages, Manage Nicknames and Moderate Members.

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

- [ ] In `/embed delete`, `/embed show` and every `/embed edit ...`, the `embed` option suggests your saved embeds as you type (managers only; run `npm run deploy` first).
- [ ] `/embed list` shows one card titled "Saved embeds (N)" with a numbered list of names and a hint line; with none saved it says so.
- [ ] `/embed create name:rules` works without enabling anything and opens the editor as a public message that explains how to use `{embed:rules}`; only managers can use its menu and button. The menu options (Basic info, Author, Footer, Images, Add field) each open a form: Basic info is title, description and color; Author and Footer are text with an optional icon (Footer also has the timestamp yes/no); Images is the main image and the thumbnail.
- [ ] The "Choose what to edit" menu opens a form for each part (Basic info, Author, Footer, Images, Add field) and the Clear fields button (grey, not red) empties the fields; there is no Show here button (use `/embed show`); `/embed edit title ...` changes the title.
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
- [ ] Auto-create (bot has Manage Channels): on a fresh server, `/set greet message text:hi` creates a public `#welcome`, turns greet on and the reply mentions it; `/test greet` posts there. Same for `leave` (`#goodbye`) and `boost` (`#boosts`). With a channel chosen first (`/set greet channel`), nothing is created. Without Manage Channels the reply says the message is saved but off.

## 8. Auto role

- [ ] `/autorole add role:<role>` for humans and `/autorole add role:<role> target:bots` with another role; `/autorole show` lists both.
- [ ] A new human account gets the first role, a bot gets the second.
- [ ] `/autorole timed add delay:1m role:<role>`: a new account gets the role after about a minute.
- [ ] `/autorole timed add delay:1d role:<role>`, add a new account, then `/autorole timed remove role:<role>`: the waiting member never gets it.
- [ ] `/autorole reassign state:on`: give a member a role, they leave and rejoin, the roles come back. With `state:off` they do not.
- [ ] With reassign on, `/autorole blacklist add` a role: it is not given back. `blacklist remove` allows it again.
- [ ] `/autorole add` and `/autorole timed add` refuse @everyone, a bot-managed role, a role at or above the bot's top role, a role with staff permissions (such as Administrator or Ban Members) and a role at or above your own top role (unless you own the server); a harmless lower role is accepted.
- [ ] `/autorole disable` turns it off; `/autorole add` turns it back on.

## 9. Logging

Set up a log channel first: `/logging setup` (needs Manage Channels) or `/logging set category:messages channel:<channel>`.

### Messages

- [ ] Auto-create: with logging on and no channel chosen for a category (and no default), the first event of that category (for example deleting a message) creates a private "Logs" category with `messages-logs` (`mod-logs`, `server-logs` and so on for other categories) and posts there. Further events reuse it; a chosen channel or default channel is used instead and nothing is created.

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

## 11. Moderation

Needs the bot to have Kick Members, Ban Members, Moderate Members and Manage Roles, with its role above the test accounts. Use a spare account as the target.

### Enable and settings

- [ ] `npm run deploy` was run after updating (registers the new commands) and the bot was restarted (migration 006 creates the case tables).
- [ ] Before `/moderation enable`, `/warn` replies that the feature is off. `/moderation enable` turns it on.
- [ ] `/logging set category:mod channel:<channel>` (with logging enabled) so cases are posted.
- [ ] `/moderation status` shows reasons required on, DMs on, timeout default 10m, ban delete days 0, no mute role and no permitted roles.
- [ ] `/moderation reason-required state:off` and `/moderation dm state:off` change and show in `status`; set them back on for the steps below.
- [ ] `/moderation timeout-default duration:5m` works; `30s` and `40d` are refused.
- [ ] `/moderation ban-delete-days days:1` works (0 to 7 only).
- [ ] `/moderation mute-role role:<role>` works; @everyone, a bot-managed role and a role above the bot are refused. With `apply:true` the role is denied Send Messages, Add Reactions and Speak in the channels the bot can manage, and the reply counts successes and failures.
- [ ] A normal member cannot run the `/moderation` settings.

### Commands and cases

- [ ] `/warn user:<target> reason:test` replies with a case number (1 on a fresh server) and posts an embed in the mod log. The next action gets the next number.
- [ ] A refused or failed action does not use a case number.
- [ ] With reasons required, `/warn` without a reason is refused; with it off it works and the log shows "no reason".
- [ ] `/timeout user:<target> duration:5m reason:test` times the target out; without a duration it uses the default. `/untimeout` removes it. A timeout of 40d is refused.
- [ ] `/mute` without a mute role set is refused. With one set, `/mute` gives the role; `/mute` again is refused as already muted; `/unmute` removes it.
- [ ] `/kick` removes the member. `/ban user:<target>` bans (the user does not have to be in the server); `delete_days` deletes their recent messages. `/ban` again is refused as already banned. `/unban` unbans; unbanning someone who is not banned is refused.
- [ ] A bad duration such as `abc` or `30s` is refused with a message.
- [ ] `/reason case:<n> reason:<text>` changes the reason and the mod log message for that case is edited. An unknown case number is refused.

### DMs

- [ ] With DMs on, the target receives a message (with the reason and duration) for warn, timeout, mute, kick and ban, before the action happens.
- [ ] With the target's DMs closed, the action still works and the moderator is told the DM failed.
- [ ] With DMs off, nothing is sent.

### Timed ban and mute

- [ ] `/ban user:<target> duration:1m`: after about a minute (the scheduler ticks every 30 seconds) the user is unbanned and an "unban" case ("expired") appears in the mod log.
- [ ] `/mute user:<target> duration:1m`: after about a minute the mute role is removed and an "unmute" case ("expired") is logged.
- [ ] `/unban` or `/unmute` before the time is up: nothing happens at the original end time (no second case).
- [ ] A mute with no duration is permanent. A new timed `/mute` after an `/unmute` ends at the new time.
- [ ] A timed ban or mute still ends if `/moderation disable` was run in the meantime.

### Rejoin while muted

- [ ] Mute a member, have them leave and rejoin: the mute role is back. After `/unmute`, or after a timed mute has ended, rejoining does not give it back.
- [ ] With the feature disabled or no mute role set, nothing is re-applied.

### Hierarchy refusals

- [ ] Each action on the server owner, on yourself and on the bot is refused with its own message.
- [ ] A moderator cannot act on a member whose top role is equal to or above theirs (the server owner is exempt from this check).
- [ ] Nobody can act on a member whose top role is equal to or above the bot's.
- [ ] `/kick`, `/timeout`, `/untimeout`, `/mute` and `/unmute` on a user who left the server are refused as not in the server; `/warn`, `/ban` and `/unban` still work by user ID.

### Permitted role and permissions

- [ ] A member with only Moderate Members can use `/warn`, `/timeout`, `/untimeout`, `/mute`, `/unmute`, `/warnings` and `/reason` but not `/kick` or `/ban`; Kick Members allows `/kick`, Ban Members allows `/ban` and `/unban`.
- [ ] A member with none of these is refused. `/moderation permitted-role-add role:<role>` lets a member with that role use all of the moderation commands; `permitted-role-remove` takes it away. Adding the same role twice, @everyone, or an 11th role is refused. A permitted role does not grant the `/moderation` settings and does not bypass the hierarchy rules or required reasons.
- [ ] The replies to the action commands are only visible to the moderator.

### Warnings visibility

- [ ] `/warnings list` (no user) shows your own active warnings. A normal member can list their own but is refused for another user.
- [ ] A moderator can run `/warnings list user:<target>`, `edit id:<n> reason:<text>`, `delete id:<n>`, `clear user:<target>` and `top`. The id is the warning's case number. Deleted and cleared warnings disappear from the list, and edits, deletes and clears post nothing to the mod log.
- [ ] A long list is cut with a "more" line instead of failing.

### Channel tools: purge messages

Needs the bot to have Manage Messages and Read Message History in the test channel. Post a mix of messages from two accounts and a bot first.

- [ ] `/purge messages count:5` deletes the 5 newest messages (not the command's own reply) and the ephemeral reply says how many.
- [ ] `user:<member>` deletes only that member's messages; `bots:true` only bot messages. Giving both is refused.
- [ ] A count larger than the matching messages deletes what exists and says fewer were found.
- [ ] A pinned message and a message older than 14 days are kept, and the reply says how many were skipped.
- [ ] Nothing matching replies that nothing was found, and no mod log line is written.
- [ ] A successful purge writes one "Channel tool: purge" line to the mod log (moderator, channel, count, reason); no case number is used.
- [ ] Run in a voice or category channel, or without View Channel / Manage Messages for the bot: refused with a clear message.

### Channel tools: purge channel

Needs the bot to have Manage Channels, Manage Roles and View Channel (Send Messages is not required; without it the notice in the new channel is skipped and the reply says so). Use a throwaway channel.

- [ ] Purging a channel locked with `/lock` works (the bot is not refused for missing Send Messages); the copy stays locked and the reply notes the notice could not be posted.

- [ ] `/purge channel` shows a warning and Confirm and Cancel buttons only you can see. Cancel replies "Purge cancelled" and nothing changes.
- [ ] Confirm deletes the channel and makes an empty copy with the same name, topic, permissions and position; a notice is posted in it and one "Channel tool: purge channel" line goes to the mod log.
- [ ] Wait more than 2 minutes, then Confirm: "expired", nothing happens. Pressing Confirm twice quickly does not purge twice ("in progress" or the old channel is gone).
- [ ] A different user pressing the buttons gets "only the moderator who ran the command". Nobody but the runner can purge.
- [ ] Set the greet, leave, boost, media and logging channels to the channel before purging: afterwards the settings point to the new channel (check `/panel overview`, `/logging status`) and events still post.
- [ ] A channel that holds stored media (`/media add`) is refused until the media is removed. The rules and community updates channels are refused. Voice, category and thread targets are refused.
- [ ] A reason given on the command appears in the mod log line and the audit log. (It is kept in memory, so it is lost if the bot restarts before Confirm.)
- [ ] Old mod-log message links to the purged channel's messages stop working; this is expected (they are not moved).

### Channel tools: slowmode, lock, unlock

- [ ] `/slowmode seconds:10` sets 10 s and posts a notice in the channel; running it again says nothing changed; `seconds:0` turns it off. More than 21600 is rejected by Discord. In a thread it needs Manage Threads for the bot.
- [ ] `reason:<text>` is added to the channel notice and the mod log line.
The bot needs View Channel and Manage Channels (plus Manage Roles for lock and unlock, Manage Threads for slowmode in a thread). Send Messages is not required: a notice that cannot be posted only adds a note to the reply.

- [ ] `/lock` posts its notice first, then denies Send Messages for @everyone; a member without a bypass cannot type. Roles explicitly allowed to speak still can. `/lock` again says it is already locked (not "missing permissions"). If the lock itself fails, the notice is removed again.
- [ ] `/unlock` removes the deny and posts a notice; on an unlocked channel it says it is not locked. Test with a bot that is not Administrator and has no allow overwrite of its own: `/unlock` still works on a channel `/lock` locked.
- [ ] `/slowmode` works in a locked channel (the reply notes that the notice could not be posted when the bot cannot send there).
- [ ] Unlock limit: if an admin denied Send Messages for @everyone by hand, `/unlock` clears that deny too (it cannot tell it from its own).
- [ ] `/lock channel:<other>` works on a text or announcement channel; voice, category and thread targets are refused. Each action writes one mod log line and no case.

### Channel tools: permissions and refusals

- [ ] With the feature off, all of these reply that moderation is off.
- [ ] A member with Manage Messages can `/purge messages` but not `/purge channel`, `/slowmode`, `/lock` or `/unlock`; Manage Channels allows those. A permitted role holder may run every one of them, including `/purge channel`.
- [ ] A member without View Channel on the target channel is refused. If the bot lacks a needed permission in the channel (Manage Roles for lock, unlock and purge channel), the reply says so and nothing changes.
- [ ] `npm run deploy` was run so the new commands appear.

## 12. Auto-mod

Needs the bot to hold View Channel, Read Message History, Manage Messages (delete), Moderate Members (timeout) and Manage Nicknames (rename), with its role above the test member. Test on a normal member with no Manage Server, no Moderate Members, no bot manager role and no moderation permitted role: those members are never checked. Run `npm run deploy` first so `/automod` appears. Rules start off, and strikes are kept in memory (a bot restart clears them).

### Setup

- [ ] `/automod status` as a normal member is refused. As an admin it works even while auto-mod is off and lists the rules (spam, invites, links, words, honeypot, native) as off, each with a 10 minute window and delete on (delete is off for native), plus the nickname check. The steps are `3 strikes: warn` for invites, links, words and native, `1 strike: timeout 10m` for honeypot, and `3 strikes: warn, 5 strikes: timeout 10m` for spam. It also shows the exempt roles and channels (none), each spam check with its limit, and for invites and links the mode (invites block everything except the allowed list, links only the blocked list) with allowed and blocked entries.
- [ ] `/automod enable` turns it on (`/automod disable` turns it off). Auto-mod is separate from `/moderation enable`, but its warn and timeout steps use moderation's case log, so also run `/moderation enable` and `/logging set category:mod` for the case tests.
- [ ] With the feature off, or a rule off, nothing is checked. `/automod rule rule:spam state:on` turns a rule on; `/automod delete rule:<rule> state:off` stops deleting for that rule.

### Spam

Turn the rule on and set `/automod steps rule:spam steps:2:warn` so a second strike acts quickly.

- [ ] Burst: send 6 messages within 5 seconds. The 6th is flagged (more than 5 messages in 5 seconds).
- [ ] Identical: send the same text 4 times within 60 seconds (case and spacing differences count as the same). The 4th is flagged.
- [ ] Caps: a message of 20 or more characters that is 70% or more capital letters is flagged; a shorter one is not.
- [ ] Emoji: a message with more than 10 emoji (custom emoji count too) is flagged.
- [ ] Mentions: a message with more than 5 mentions (users plus roles) is flagged.
- [ ] Attachments: 5 attachments within 30 seconds (in one or several messages) is flagged.
- [ ] Link rate: 5 links or invites within 30 seconds is flagged.
- [ ] Attachments and link rate only flag a message that itself adds an attachment or link: after 5 attachments, a plain text message in the next 30 seconds is not flagged.
- [ ] Editing a message re-checks caps, emoji and mentions (an edit to 6 mentions is flagged) but an edit never counts toward burst, identical, attachments or link rate.
- [ ] `/automod spam-check check:caps state:off` stops caps being flagged; `/automod spam-limit check:emoji value:3` makes 4 emoji trip it. A value outside the check's range is refused and the reply shows the allowed range.

### Invites

- [ ] `/automod rule rule:invites state:on`. An invite to this server is allowed. An invite to another server is deleted (an expired or unknown invite counts as foreign).
- [ ] `/automod domains type:invites list:allow action:add value:<server id>` lets that server's invites through. `list:block` blocks it even with `/automod mode type:invites state:off`. A value that is not a server id is refused.
- [ ] `discord.com/invite/<code>`, `discordapp.com/invite/<code>`, `ptb.discord.com/invite/<code>` and `canary.discord.com/invite/<code>` are caught like `discord.gg/<code>`.

### Links

- [ ] `/automod rule rule:links state:on`. Links are allowed until you block them: `/automod domains type:links list:block action:add value:example.com` deletes `https://example.com/x` and `https://sub.example.com` but not other sites.
- [ ] `/automod domains type:links list:allow action:add value:good.com` and `/automod mode type:links state:on` block every link except `good.com` and its subdomains. `mode state:off` returns to blocklist only.
- [ ] A value with a scheme or a path (`https://x.com/a`) is refused: only plain domains are accepted. `action:remove` takes an entry out.

### Bad words

- [ ] `/automod rule rule:words state:on`. A built-in word is deleted, including inside a sentence and with look-alike digits or symbols (`sh1t`).
- [ ] A stretched spelling like `shiiiit` is caught, and so is a listed word with a zero-width character inside, and a harmless word that merely contains a listed word is not.
- [ ] `/automod words add word:<word>` adds a custom word, `words list` shows custom and removed built-in words and the built-in count, `words remove` takes it out. `words builtin-remove` stops banning a built-in word and `builtin-restore` brings it back. `words builtin state:off` turns the whole built-in list off.
- [ ] Arabic words in the list match as parts of the text; a banned phrase of several words matches as a phrase.

### Strike escalation

- [ ] `/automod steps rule:spam steps:2:warn,4:timeout:10m`, then trip the rule twice within the window: a warn case is created. Four times: the member is timed out for 10 minutes (case created), and their strikes for that rule reset.
- [ ] With the default spam steps and no changes, the 3rd spam strike in 10 minutes warns and the 5th times the member out for 10 minutes (case created) and resets their spam strikes.
- [ ] Invalid input such as `0:warn`, `3:ban` or two steps with the same count is refused and nothing changes. `/automod status` shows the steps.
- [ ] `/automod window rule:spam duration:30s`: violations more than 30 seconds apart do not add up. A duration outside 10 seconds to 1 day is refused.
- [ ] Strikes are per rule: one spam strike and one links strike do not add together.
- [ ] A message that trips two rules and reaches a step on both gets one action (a timeout beats a warn, the longer timeout wins), not two.

### Mod log

- [ ] A first offence is deleted, no case is made, and the mod log gets one auto-mod line with the member, channel, rules and actions.
- [ ] A message that reaches a warn or timeout step gets that case's own mod log line and no extra auto-mod line. Either way each offending message produces one mod log line.

### Exemptions

- [ ] `/automod exempt add-role role:<role>`, then a member with that role breaks a rule: nothing happens. `remove-role` brings checking back. @everyone is refused.
- [ ] `/automod exempt add-channel channel:<channel>`: the same message in that channel is ignored and still caught elsewhere. A category exempts the channels inside it. `remove-channel` undoes it.
- [ ] Members with Manage Server, the bot manager role, Moderate Members or a moderation permitted role, and bots, are never checked.

### Edit bypass

- [ ] Post a harmless message, then edit it into a violation (a blocked link or word): it is deleted. An edit that does not change the text adds no strike.

### Nickname check

- [ ] `/automod nickname state:on`. Change a test member's nickname to a banned word: the bot renames them to `Moderated Nickname` plus 4 random digits and a line goes to the mod log. A member who joins with a banned username is renamed too, and a member's first message after the bot starts is checked.
- [ ] A nickname that is already the placeholder is left alone, and a second change within 10 seconds is not renamed again. `/automod nickname state:off` stops the check.
- [ ] Without Manage Nicknames, or for a member above the bot's role, nothing changes and the console shows a warning, not a crash.

### Honeypot (Phase 2)

Needs the bot to see the trap channel and hold Manage Messages in it. Use a hidden test channel and a normal test member.

- [ ] `/automod honeypot channel:#trap` replies that it is set and reminds you to turn the rule on; `/automod status` shows the honeypot channel. Setting the channel does not enable the rule: a post there changes nothing until `/automod rule rule:honeypot state:on`.
- [ ] If the bot cannot see the channel or lacks Manage Messages in it, the command is refused. Only text and announcement channels can be picked. `/automod honeypot off:true` clears it.
- [ ] With the rule on, any post in the trap channel (even an empty-looking or harmless one) is deleted and the default step (`1 strike: timeout 10m`) times the member out (case created, mod log line). Posts elsewhere are not affected.
- [ ] Editing a trapped message (or an embed unfurling on it, or pinning it, if it was not deleted) does not punish the member again: no second timeout, case or log line.
- [ ] Exempt members (Manage Server, bot manager role, Moderate Members, permitted role, `/automod exempt` roles) and bots are untouched. An `/automod age` limit on the honeypot rule makes it catch only matching members.
- [ ] Deleting the trap channel causes no console error; nothing matches afterwards.

### Regex patterns (Phase 2)

- [ ] `/automod patterns add pattern:...` adds a pattern to the words rule (rule `words` must be on). `patterns list` shows them, `patterns remove` takes one out. A pattern is checked against messages and against nicknames and usernames (the nickname check, `/automod nickname state:on`).
- [ ] Matching is case-insensitive and runs on the raw text (not normalised: no look-alike or stretched-letter folding) and only on the first 1000 characters of a message.
- [ ] A pattern longer than 250 characters, an invalid one, or one with a backreference or lookaround is refused with a clear reply. A duplicate and an 11th pattern are refused (max 10).
- [ ] A hostile pattern such as `(a+)+$` against a long run of `a` followed by `!` does not freeze the bot.

### Account age and join age limits (Phase 2)

- [ ] `/automod age rule:links kind:account duration:7d`: links are only enforced against accounts younger than 7 days. An older account posting a blocked link is not flagged. `kind:joined` limits to members who joined within the duration. `duration:off` clears that limit. Durations outside 1 minute to 10 years are refused.
- [ ] `/automod status` shows an age line for a rule that has a limit. With both limits set, both must hold for the rule to apply.

### Timed role (Phase 2)

Needs Manage Roles, and the chosen role must be below the bot's top role.

- [ ] `/automod role rule:spam role:@Muted-ish duration:10m` is accepted. @everyone, a managed (bot or integration) role, a role at or above the bot's top role, a role with staff permissions (Administrator, Manage Server, Manage Roles, Ban, Kick, Timeout, Manage Channels, Manage Messages, Manage Webhooks or Mention Everyone), or a role at or above your own top role (unless you own the server) is refused, and so is a duration outside 1 minute to 7 days. If the role gains a staff permission later, the bot stops giving it and logs a console warning. `off:true` stops giving a role; omitting `duration` keeps the current length (default 10 minutes).
- [ ] When the rule reaches a step (the strike count that triggers warn or timeout), the member also gets the role and the history row lists `role` among the actions. The role is removed after the duration (scheduler job `automod.removeRole`, checked every 30 s). A strike below the first step gives no role.
- [ ] Triggering again while the role is still pending moves the removal time. A member who already has the role from elsewhere (no pending removal) is left alone and keeps it.
- [ ] Restart the bot during the timer: the role is still removed afterwards. If the member left or the role was deleted, nothing errors.

### Native Discord AutoMod (Phase 2)

Needs the Manage Server permission for the bot (the AutoMod execution events and the rule list) and the AutoModerationExecution intent (set in code). Create a Discord AutoMod rule first (Server Settings > Safety Setup > AutoMod) with a block-message keyword.

- [ ] `/automod native list` shows the server's AutoMod rules (id, name, on or off). Without Manage Server, or with no rules, it says it found none.
- [ ] `/automod rule rule:native state:on`. A member triggering the Discord rule gets a strike on the `native` rule (default step `3 strikes: warn`); a mod log line or history row appears. Native delete is off by default, and a message Discord already blocked has nothing left to delete.
- [ ] `/automod native add-rule id:<rule id>` makes the bot follow only that rule (a non-numeric id is refused, a duplicate says it exists, the list holds up to 25). `remove-rule` undoes it; with an empty list every Discord AutoMod rule counts.
- [ ] Exempt members and bots are skipped, and an age limit on the native rule applies.
- [ ] Two different messages blocked by the same rule from the same member within 5 seconds count as two strikes (blocked messages have no message id, so they are told apart by their content). Known limit: the same blocked text sent twice within 5 seconds counts once.

### History and permissions

- [ ] `/automod history` shows the latest actions (up to 10) with member, rules, actions, case number and time; `user:<member>` filters. With none it says so. Only the newest 200 entries per server are kept.
- [ ] Without Manage Messages the offending message stays and the console shows a warning. Without Moderate Members a timeout step is refused (console warning) and the message is still deleted and logged.
- [ ] A 4000-character message, an attachment-only message, a sticker-only message, Arabic text and 200 mentions cause no console error. Bot, webhook and DM messages are ignored.
- [ ] Strikes are kept in memory: restart the bot and every member's strikes are zero again (history is kept).
- [ ] After deploying Phase 2 run `npm run deploy` so `/automod patterns`, `age`, `role`, `honeypot` and `native` appear.

## 13. Verification

Needs two accounts: your admin account and a test account that joins fresh (an alt or a friend). The bot needs Manage Roles, Manage Channels, View Channel, Send Messages, Embed Links and Attach Files, and its top role must sit above the Verified role. Make the test server have a private staff channel (@everyone cannot see it), a public-looking channel such as #rules, and a few ordinary channels.

### Setup

- [ ] Run `npm run deploy` first so `/verification` appears. As a normal member it is refused; as an admin `/verification status` works while the feature is off.
- [ ] `/verification setup` replies (only you see it) with a preview: channels to gate, public, skipped, already private (the staff channel), and members to grant, with Confirm and Cancel buttons. Nothing has changed yet: check that channels and roles are untouched.
- [ ] Cancel says nothing was changed. Run setup again and wait over 2 minutes before Confirm: it says the confirmation expired. Another admin pressing Confirm is told only the admin who ran the command can use it.
- [ ] If an ordinary channel has an extra role with its own View Channel allow, the preview lists it as a channel where that role keeps seeing it (informational only).
- [ ] Confirm creates a "Verified" role just below the bot, a `verify` channel with a Verify embed and button, then the rollout starts. `/verification status` shows state rolling out (granting, then gating) and finally active, with the number of undo records.
- [ ] Setup refuses (with a clear message) when: the bot lacks a permission, the chosen verify channel is hidden from @everyone, @everyone has Administrator, the chosen role is above the bot or managed, the chosen role has a staff permission (for example Manage Messages or Ban Members), the chosen role is not below your own highest role (use an admin who is not the owner), verification is already set up, or a remove is still running or left channels to restore (run remove again first).
- [ ] `/verification setup` also takes `mode` (button or captcha), `role` and `channel`: your own role and channel are used instead of creating new ones.

### Existing members and the gate

- [ ] Grandfathered: every member who was already in the server (and every bot) has the Verified role and still sees and writes everywhere they could before.
- [ ] The private staff channel is untouched (still hidden from @everyone, Verified does not see it).
- [ ] A new account joining after setup sees only the verify channel and the public channels. Ordinary channels are hidden.
- [ ] The new account cannot send in the verify channel. After `/verification public add channel:#rules`, the new account can read #rules but sending, reacting, creating threads and using slash commands there are refused; verified members can still write there if they could before.
- [ ] A public channel where @everyone could never send (announcements) stays read-only for verified members too: Verified is never given more than @everyone had.
- [ ] `/verification public add` on a channel @everyone cannot see is refused. A channel cannot be on both lists, and the verify channel cannot be added to either.
- [ ] `/verification skip add channel:#x`: the channel's permissions are left exactly as they were (check before and after). `skip remove` gates it again.
- [ ] `/verification public list` and `skip list` show the channels, or say the list is empty. `public remove` / `skip remove` on a channel that is not listed says so.
- [ ] A voice channel in the public list: unverified members can see it but not Connect or Speak.
- [ ] A channel synced to its category (Permissions show "Synced") is gated too: the unverified account cannot see it, and it gets its own @everyone and Verified overwrites (it may show as no longer synced). Editing a category in Discord never changes its channels, so each one is gated on its own.
- [ ] Right after a list change, change it back at once (`public add channel:#x` then `public remove channel:#x` within a few seconds): #x ends gated (hidden from the unverified account), and after `public add` again it is visible and read-only. The replies match what happened.

### Verifying

- [ ] Button mode: the new account presses Verify, gets "You are verified", and now sees the gated channels. Pressing it again says already verified. Only the clicker sees replies.
- [ ] `/verification mode mode:captcha`, then the new account (use `/verification unverify` first) presses Verify: an image with 5 characters appears with an Enter code button. The message is in English whatever the server language.
- [ ] Entering the right code (case does not matter) verifies the account. Another user pressing Enter code on someone else's captcha is refused.
- [ ] Entering a wrong code says how many tries are left; the third wrong code starts a 30 second cooldown, and pressing Verify during the cooldown shows the seconds left instead of a new image. After the cooldown a new image is issued.
- [ ] A code older than 5 minutes is expired, with a Verify button to get a new one. Restart the bot: any open captcha stops working (codes are only kept in memory) and a new one can be requested.
- [ ] Switch back with `/verification mode mode:button`: the Verify button gives the role at once again.
- [ ] A bot invited after setup gets the Verified role by itself and sees the channels (no mod-log line for it).
- [ ] Create a new text channel as an admin: it is gated like the others (hidden from the unverified account, visible to Verified). Create one inside a category that is already gated and it follows the category; after `/verification remove` that channel is visible to everyone again (like its category). A private new channel is left alone.
- [ ] Give the Verified role a staff permission (for example Manage Messages) in Server Settings: Verify, the captcha and `/verification verify` refuse to give it ("staff permissions"), and a bot that joins does not get it. `/verification status` shows a staff-permissions warning, and the first refusal writes one mod-log line (more refusals within the hour write none). Remove the permission again afterwards.
- [ ] `/verification verify member:<user>` gives the role and writes a mod-log line naming you; running it again says already verified. `/verification unverify member:<user>` removes the role and logs it; on a bot it is refused; on someone with a role at or above yours it is refused. Both are refused while verification is not set up (state none).

### Status and removal

- [ ] `/verification status` lists enabled, mode, role, verify channel, state, the public and skip counts, and the undo record count.
- [ ] Stop the bot during the grant and start it again: the rollout carries on and finishes (a job that was running reruns only after the scheduler claim window, so wait up to 5 minutes; status shows progress; if it says it is stuck, or the state is failed, recover with `/verification remove` and then `/verification setup` again).
- [ ] Where the bot cannot edit a channel (for example it lacks Manage Permissions there), the rollout or a list change reports the failure (state failed with the number of channels and, in `/verification status`, up to 10 of those channels by name, or an error reply) instead of ignoring it. While failed, new channels are still gated and a bot that joins still gets Verified. A failed rollout is retried with `/verification remove` and then `/verification setup` again.
- [ ] `/verification remove` restores every channel to the permissions it had before setup (compare with the earlier notes: the @everyone and Verified overwrites, and the bot overwrite in the verify channel, are back or gone as they were), deletes the Verify message and turns the feature off. The Verified role and the verify channel are left in place.
- [ ] If a channel cannot be restored (remove the bot's permission in one channel first), remove lists those channels, keeps verification on (a rollout that was still running shows as failed) and keeps their records; fix the permission and run remove again.
- [ ] Run `/verification remove` while the rollout is still gating channels (status says gating): every channel ends restored, none is left hidden, and the state is not set up.
- [ ] After remove, run setup again: it works from a clean start. A channel deleted while gated just loses its record.

### Unverified members

Needs the bot to have Kick Members. Use short times: the minimum kick time is 10 minutes, so each run takes a while. Have the test account ready to join and leave.

- [ ] `/verification unverified policy:kick kick_after:1h` replies with the saved policy, and `/verification status` shows "Unverified members: kicked after 1h". `policy:warn_kick kick_after:1d` shows "Unverified members: warned after 12h, then kicked after 1d" (the warn time defaults to half the kick time). Add `warn_after:6h` and status shows it.
- [ ] Refusals: `kick_after:5m` is refused (minimum 10 minutes; also refused above 30 days or when the time cannot be read). `policy:warn_kick kick_after:1h warn_after:55m` is refused because the warn must come at least 10 minutes before the kick. Nothing is saved on a refusal: status is unchanged.
- [ ] `policy:warn_kick kick_after:20m warn_after:10m`: the new account joins and never verifies. At 10 minutes it gets a warning (a DM with the reason and the time left if moderation DMs are on (the default), a warn case with the bot as moderator and a mod-log line; the case is recorded even when the moderation feature is off, but `/warnings member:<user>` only works while moderation is enabled, so enable it first or look for the case in the mod log), and at 20 minutes it is kicked (a kick case by the bot, reason "Did not verify within 20m.", mod-log line). The moderation feature does not need to be enabled for this.
- [ ] `policy:kick kick_after:10m`: a member who never verifies is kicked at 10 minutes with no warning first.
- [ ] A member who verifies before the deadline is not warned or kicked (check after the deadline passes). A member who leaves and rejoins gets a fresh clock from the new join.
- [ ] Spared: only members who join while the policy is on are queued, so test with fresh joins. With `policy:kick kick_after:10m`, let a fresh test account join, then before the deadline give it the bot manager role (or Manage Server), or a role at or above the bot's top role. At the deadline it is not kicked (and under `warn_kick` not warned). Repeat for each case with a new join. The owner and bot cases are covered by automated tests only: they cannot be exercised by a fresh join.
- [ ] Changing the policy or the times does not touch members already queued: a member who joined under `kick_after:1h` is still kicked on that schedule after you change to `kick_after:1d`, and new members get the new times.
- [ ] `policy:none` stops everything: members already queued are not warned or kicked, and status shows nothing happens to them. The same after `/verification remove`.
- [ ] Take Kick Members from the bot, then let a queued member reach the deadline: no kick, and exactly one mod-log line says the unverified kick failed with the reason. It is not retried. Give the permission back afterwards.

### Discord Onboarding

- [ ] In Server Settings, Onboarding, choose default channels that are on the public list. The new account sees them and the onboarding questions before verifying, and the gate does not block finishing Onboarding.

## 14. Permissions and robustness

- [ ] Every setup reply is ephemeral (only you see it).
- [ ] A normal member cannot run `/logging`, `/autorole`, `/set`, `/media` or `/moderation` setup commands.
- [ ] Stop the bot and start it again, then run `docker compose restart`: all settings are still there.
- [ ] The console shows no unhandled errors during the steps above.

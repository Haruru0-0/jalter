# Autoresponder (Phase 3): design

Status: draft, builder check done, waiting for owner approval. Roadmap: `2026-10-14-feature-roadmap.md`, Phase 3 (Automation). Registry key `autoresponder` already exists as a "coming soon" stub (`src/core/registry.js`). Prior art: Mimu's autoresponder (https://docs.mimu.bot/autoresponder/your-first-autoresponder and its guide pages); the owner chose Mimu-style scripts.

## Intent and why

Staff want the bot to answer or act on messages by itself: reply to a question, hand out a role, post a random line, send an embed with buttons, without writing code. The owner wants the Mimu experience: a rule is a trigger plus a **reply script**, a small language written inside the reply text with `{functions}` and `[values]`. A script can set conditions (cooldown, required role), act (give a role, DM, send to a channel, delete the message), pick randomly, and read words from the member's message. Jalter already has placeholders, named embeds and a safe-regex layer; this feature adds the rules, the language and the runtime on top of them.

## Decisions by the owner

- **Scope:** Mimu-style scripts (a mini-language in the reply), not just a text reply with separate options.
- **No economy:** the balance, inventory, shop and currency parts of Mimu are out. Jalter has no currency feature; they come back only if one is built.
- **Stages:** one design, built in three stages, each shipped and tested before the next:
  1. Rules, matching, placeholders, gates and actions.
  2. Random functions and message arguments.
  3. Buttons.
- **Several rules matching one message:** only the most specific rule runs (longest matching trigger wins, ties go to the oldest rule).

## Goals

- Staff create, edit, list, show, remove and test rules with `/autoresponder`; the reply script is written in a multi-line editor.
- A rule matches by `exact`, `startswith`, `endswith`, `includes` (Mimu's four modes) and `regex` (my guess; Jalter has safe RE2 matching from auto-mod).
- The reply script language below, with every function checked when the script is saved and again when it runs.
- Placeholders: all existing Jalter placeholders (`src/core/placeholders.js`) plus the Mimu member, server, channel and message ones that need no economy.
- Safe by default: a script cannot hand out a staff role, mass-ping, or loop.
- Off by default; setup needs Manage Server or the bot manager role; replies to setup are ephemeral. All user-facing text (command replies, script error messages) in `src/i18n/{en,fr,ar}.json`.

## Non-goals

- Economy functions and placeholders (`modifybal`, `modifyinv`, `requirebal`, `requireitem`, balance, items, currency) and any stored per-user or per-server variables.
- Loops, user-defined variables, nested conditionals, arithmetic. Gates are the only conditions.
- Slash-command autoresponders, premium tiers, importing rules from Mimu.
- Editing a reply after it is sent.

## Anti-goals (a failure even if it technically works)

- A script that makes the bot answer itself or another bot's autoresponder in a loop, or lets one message trigger a chain of replies.
- Privilege escalation: a script giving a role with staff permissions, a role above the bot or above the person who wrote the rule, `@everyone`/`@here` or role pings, or nickname changes on members the bot cannot manage.
- A regex or script that stalls the bot (catastrophic regex, huge replies, unbounded repetition).
- Half-done actions with no word to staff: a script whose gates pass but whose action is refused must say so once, not fail silently every time.
- Slowing every message in every server: matching must be cheap when a server has no rules or the feature is off.
- A broken script saved with no warning, only to fail when a member triggers it.

## Constraints

- Node 22, discord.js 14.27, ESM, Postgres. New feature module `src/features/autoresponder/` in `src/modules.js`; registry stub becomes a real feature with command `/autoresponder` and `autoresponder enable` as its enable command.
- Reuse, do not duplicate: `core/placeholders.js` (`renderPlaceholders`, `buildVars`), `features/embeds` (`getEmbed`, `buildEmbedPayload`), `features/automod/regex-safe.js` (RE2), `core/role-safety.js` (`isDangerousRole`, `botCanGive`, `callerCanGive`), `core/duration.js`, `core/scheduler.js` (housekeeping), `core/send.js`, `core/mentions.js` (`safeMentions`), and the component pattern from reaction roles (one component prefix, customIds carry ids).
- The message content intent and `GuildMessages` are already on; no new intents for stages 1 and 2. Stage 3 adds component handlers only.
- Migration `010_autoresponder.sql` (next number after reaction roles' 009).
- Pure parts (parser, evaluator, matcher, rule choice) must be testable without Discord; tests hit the database with `npm test`, concurrency 1.

## What it does

### A rule

`autoresponder_rules`: id, guild, `trigger` (up to 100 characters), `match_mode`, `script` (up to 4000 characters), `enabled`, creator, created. At most 100 rules per server (my call). Trigger matching is case-insensitive and ignores surrounding whitespace; `regex` uses the same RE2 compile and length limits as auto-mod patterns.

### Which rule runs

On a guild text message (not from a bot or webhook, not in DMs, not deleted by auto-mod, feature on): collect the enabled rules that match; if several match, run only the one with the longest trigger (for `regex`, the pattern source length), ties to the oldest rule. Run its script. The bot's own messages are never matched, so replies cannot trigger rules.

### The script language

Syntax: `{name}` or `{name:arg|arg}` for functions and placeholders; `[$N]`, `[$N+]`, `[$N-M]` for message words (stage 2); `[range]`, `[choice]`, `[lockedchoice]` (and the numbered `1`–`3` forms) for random results (stage 2); a backslash escapes `{` or `[`. Placeholders and functions share the `{}` form; a name that is a placeholder is replaced by text, a name that is a function does something. An unknown name is a save-time error.

**Order does not matter** (unlike Mimu, my call). A script runs in phases: parse and validate; evaluate gates; compute random values once; render the text; run actions in a fixed order (delete, role changes, nickname, reactions, then the message: DM, channel or in place).

**Stage 1 functions**
- Gates (the rule is skipped, with a short ephemeral-style notice only when `{silent}` is absent): `{cooldown:seconds}` (per member per rule), `{requirerole:role}`, `{requireperm:perm}`, `{requirechannel:channel}`, `{requireuser:user}`, and the `{denyrole:}`, `{denyperm:}`, `{denychannel:}` versions.
- Actions: `{addrole:role}`, `{removerole:role}` (role by mention, name or id, optional target after a pipe in stage 2), `{embed}` / `{embed:#hex}` / `{embed:name}` (plain colour embed or a named embed), `{dm}`, `{sendto:channel}`, `{delete}`, `{delete_reply:seconds}`, `{react:emoji}`, `{reactreply:emoji}`, `{setnick:text}`, `{silent}`.
- Placeholders: the existing ones plus `{user_id}`, `{user_nick}`, `{user_joindate}`, `{user_createdate}`, `{user_displaycolor}`, `{user_boostsince}`, `{server_id}`, `{server_boostlevel}`, `{channel}`, `{channel_name}`, `{message_id}`, `{message_content}`, `{message_link}`.

**Stage 2 functions**
- Random: `{range:min-max}` (up to four, `[range]`…`[range3]`), `{choose:a|b|c}` (up to four, `[choice]`…), `{weightedchoose:60%|30%|10%}` (percentages, integers or decimals, one per option, relative weights), `{lockedchoose:x|y|z}` (the value paired with the option `choose` picked; counts must match).
- Arguments: `[$N]`, `[$N+]`, `[$N-M]`; `{requirearg:N}` and `{requirearg:N|type}` with types `user`, `channel`, `color`, `role`, `number`.

**Stage 3 (buttons)**
- Button responders: a named button with label, emoji, colour (blue, green, grey, red) and its own reply script that runs when pressed, with the person who pressed as "the member".
- Attach with `{addbutton:name}` (up to 25 per message) and `{addlinkbutton:...}` for link buttons.
- Instanced behaviour: `invoker_only` (only the member whose message or event created the button may press) and `limitations` (`none`, `limited` = disabled after one press, `strict` = all buttons of the message disabled after one press).
- Button state survives a restart (customId carries the button name and message id; stored settings in the database).

### Limits (taken from Mimu's documented limits, builder confirms against Discord)

At most 10 embeds, 5 reactions and 25 buttons per reply; nickname at most 32 characters; message content 2000 characters on Discord's side (my call: reject scripts whose rendered message would exceed Discord limits at run time with a clear error, not truncate); embed description 4096 and combined embed text 6000; at most 3 roles or nickname targets per script; cooldown from 1 second to 7 days.

### Errors, in three places (as in Mimu)

- **At save:** the script is parsed and checked (unknown function, bad argument, too many embeds, mismatched `choose`/`lockedchoose` counts, a missing named embed, a dangerous role, a role the writer cannot give). A script with an error is refused with the exact problem and position; `/autoresponder test` shows the same.
- **At trigger:** a failed gate skips the rule. Without `{silent}` the member gets a short localized notice only for the gates where a reason helps (cooldown, missing role); otherwise nothing is said.
- **At run:** a refused action (bot missing permission, DMs closed, target outranks the bot) is skipped, the rest still runs, and one mod-log line per rule per hour tells staff.

Error messages are localized; each carries a short English code in capitals (for example `INVALID_USER`, `CHOICE_NOT_CHOSEN_YET`) so staff can look it up.

### Commands (`/autoresponder`)

All need Manage Server or the bot manager role except where noted; replies are ephemeral. `enable`, `disable` (via the shared toggle).
- `add trigger match`: opens a multi-line editor (modal) for the script; saves only if it validates; replies with the rule id.
- `edit id`: opens the editor prefilled; `editmatchmode id match`; `remove id`; `enable`/`disable` for one rule (`toggle id`).
- `list`: rules with id, trigger, mode; `show id`: the script and its settings.
- `test message:<text>` (my call): a dry run that shows which rule would match, the validation result and what each phase would do, with no side effects.
- Stage 3: `button add|edit|remove|list`.
Setup actions write one mod-log line each; triggering a rule is never logged except the run-time error line above.

### Data and cost

Tables in migration 010: `autoresponder_rules`, `autoresponder_cooldowns(rule_id, user_id, until)` pruned by a scheduler housekeeping function, and in stage 3 `autoresponder_buttons`. Rules are cached per server in memory and invalidated on any change, so a message in a server with no rules or with the feature off costs no database read.

## Decisions I made (the owner can reverse them)

- Regex match mode.
- Order of functions does not matter (two-phase evaluation).
- 100 rules per server; script up to 4000 characters; trigger up to 100.
- Cooldowns stored in the database (survive restarts), per member per rule.
- Role pings and `@everyone` never allowed from a script; only the triggering member and explicitly mentioned users can be pinged.
- `/autoresponder test` dry-run command.
- A modal editor for writing the script instead of a slash option.
- Stage 1 includes `{setnick}`, `{react}`, `{delete}`, `{dm}`, `{sendto}` as actions.
- The rule with the longest trigger wins; regex rules rank by pattern length.

## Builder-check answers (all my calls; the owner can reverse them)

- **Run-time privilege check.** At save, the writer must be able to give every role in the script (`callerCanGive`) and no role may be dangerous or above the bot. At run time only the role itself is re-checked (`isDangerousRole`, `botCanGive`); the writer's current standing is not, and a rule whose writer left or was demoted keeps working. "The member" for every action is the person whose message triggered the rule (in stage 3, the person who pressed the button).
- **Gate notices.** A message has no private reply, so a gate notice is a normal reply to the triggering message without pinging anyone, deleted by the bot after 8 seconds. Each member gets at most one notice per rule per 30 seconds (kept in memory). Only cooldown and missing-role gates say anything; `{silent}` turns notices off.
- **Tie-break and fall-through.** "Oldest" means lowest rule id. Only the most specific matching rule is considered; if its gates fail, nothing else runs for that message (no fall-through to a less specific rule).
- **Ranking across modes.** Non-regex rules rank by trigger length. A `regex` rule ranks below every non-regex rule that matches the same message, and among regex rules by pattern length.
- **Named embeds.** `{embed:name}` renders the named embed with the existing `{}` placeholders plus the new message ones (`{message_content}`, `{message_link}`, and so on). The `[$N]` argument values and the `[range]`/`[choice]` random values are substituted only in the script's own text, not inside a stored embed.
- **Roles.** A role in a script is written as a mention, an id or an exact name (case-insensitive). It is resolved at save and stored as an id next to the raw text; a name matching more than one role is refused at save with a request for a mention or id. If the role is deleted later, the action is skipped and the run-time error line is written.
- **Targets (grammar reserved from stage 1).** `{addrole:role}` and `{removerole:role}` act on the triggering member. The second argument `{addrole:role|target}` is reserved in the grammar from stage 1 but only accepted from stage 2, where the target is a user mention or a `[$N]` argument checked as a user. At most 3 calls of `addrole`, `removerole` and `setnick` together per script.
- **Throttle and mod log.** The "one error line per rule per hour" throttle is in memory, like reaction roles' alert; lines go through `sendLog` with the `modAction` category (as `logReactionRoles` does).
- **Migrations.** `010_autoresponder.sql` creates `autoresponder_rules` and `autoresponder_cooldowns` (stages 1 and 2 need no more); stage 3 adds `011_autoresponder_buttons.sql`.

## Left to the builder

- The parser (a hand-written recursive-descent parser is expected) and the shape of its error objects.
- File layout and names inside `src/features/autoresponder/`.
- Exact argument syntax edge cases (spaces around pipes, quoting, escaping).
- The per-stage test plan; the evaluator, matcher and rule choice are pure and should have the bulk of the tests.
- Updating the README invite list, `docs/testing-checklist.md`, and `docs/memory/` at the end of each stage.

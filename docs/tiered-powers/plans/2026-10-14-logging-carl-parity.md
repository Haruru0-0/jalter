# Logging Carl-parity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use tiered-powers:subagent-driven-development (recommended) or tiered-powers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bring `/logging` to feature parity with Carl-bot's logging (everything except modlog/cases): per-event toggles, ignore lists, the missing events, voice/join channels, moderator attribution, one-command setup, export/import and a status view.

**Architecture:** Split the 237-line `src/features/logging/index.js` into a pure layer (`events.js`, `config.js`), a delivery layer (`send-log.js`, `audit.js`), handler files grouped by area, and a `commands.js`. Every log goes through one `sendLog(ctx, guildId, event, embed, opts)` that applies the on/off toggle, ignore lists, channel fallback and loop guard. Config stays in the `logging` feature row's JSONB (`setFeature` shallow-merges top-level keys, so always write whole nested objects).

**Tech Stack:** discord.js 14.27, Node 22 ESM, Postgres, `node --test` (tests hit the DB via `testDb()` from `test/helpers/db.js`).

**Spec:** No separate design doc. The user skipped brainstorming ("just want it like Carl bot; modlog later"). Scope source: Carl docs https://docs.carl.gg/#/logging and the comparison in this session. Roadmap context: `docs/tiered-powers/specs/2026-10-14-feature-roadmap.md` (mod-case store is Phase 2, out of scope here).

## Global Constraints

- Out of scope: modlog, cases, infractions, `/modlog *`. The `mod` category stays selectable and unused.
- All user-facing text goes in `src/i18n/en.json`, `fr.json` and `ar.json` (flat dotted keys, `{name}` placeholders). `test/i18n.test.js` fails if fr/ar miss an en key.
- Setup replies are ephemeral and need Manage Server or the bot-manager role: use `guard(interaction, ctx, 'logging', { requireEnabled: false })` and `ephemeral(...)` as the current `execute` does.
- Event handlers must never throw into the event loop: wrap with the `safe()` helper.
- `/help` builds its list from the command definitions (`src/features/help/index.js`), so new `/logging` subcommands appear there from their descriptions; write each description as user-facing text.
- Slash option choices max out at 25. Command descriptions max 100 characters.
- New intents (`GuildModeration`, `GuildVoiceStates`) are not privileged. Features stay off by default.
- Existing behaviour must not regress: bots' messages are skipped; events inside a configured log channel are not logged (loop guard); joins and leaves previously went to the `members` channel and must keep doing so until a `join` channel is set.
- Commit after each task. Run `npm test` (needs `npm run db:up`) before each commit.

## Design decisions (my calls, not the user's)

- **Categories** become `default, messages, members, join, server, voice, mod`. Channel lookup for an event: `channels[category]`, else for `join` category `channels.members`, else `channels.default`, else none.
- **Events** (24, each belongs to a category): `messageDelete messageEdit messagePurge invitePosted` (messages); `roleChange avatarChange nameChange ban unban timeout timeoutRemoved` (members); `memberJoin memberLeave` (join); `channelCreate channelUpdate channelDelete roleCreate roleUpdate roleDelete emoji guildUpdate` (server); `voiceJoin voiceMove voiceLeave` (voice). `nameChange` covers nicknames and usernames; `emoji` covers create/update/delete.
- **Toggle storage:** `config.disabledEvents: string[]` (everything on by default once a channel resolves).
- **Ignore storage:** `config.ignore = { channels: string[], members: string[], prefixes: string[] }`. Applies to message events only (`messageDelete messageEdit messagePurge invitePosted`).
- **Export code:** base64url of `{"v":1,"disabledEvents":[...],"prefixes":[...]}`. Channel and member IDs are not exported (they are guild specific).
- **Attribution:** audit-log lookup adds a "By" field for ban, unban, timeout, timeoutRemoved, messageDelete (only when a matching entry is under 10 s old), channelCreate/Delete, roleCreate/Delete. Missing View Audit Log permission means no field, never an error.
- **Setup (`/logging setup`)** creates a private "Logs" category with `log-messages log-members log-joins log-server log-voice` and points the matching categories at them.

## Review Focus

- Message deleted while uncached (no author, no content): must still log, and must not crash the ignore check.
- Bot lacks View Audit Log: logs still sent, no "By" field.
- Bulk delete of uncached messages: logs a count, not a crash.
- Voice state change where the channel did not change (mute/deafen/stream): must log nothing.
- `/logging import` with garbage, wrong version or oversized input: ephemeral error, config untouched.

---

### Task 1: Pure event and config helpers

**Files:**
- Create: `src/features/logging/events.js`, `src/features/logging/config.js`
- Test: `test/features/logging-config.test.js`

**Tier:** haiku — every step's code is verbatim, two small pure files.

**Interfaces:**
- Produces (`events.js`): `CATEGORIES: string[]`, `EVENTS: Record<string,string>` (event → category, the 24 above), `MESSAGE_EVENTS: string[]`.
- Produces (`config.js`): `isEventEnabled(config, event): boolean`, `resolveChannelId(config, event): string | null`, `isIgnored(config, { channelId, userId, content }): boolean`, `encodeSettings(config): string`, `decodeSettings(code): { disabledEvents: string[], prefixes: string[] } | null`.

- [ ] **Step 1: Create `test/features/logging-config.test.js`**

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EVENTS } from '../../src/features/logging/events.js';
import {
  isEventEnabled, resolveChannelId, isIgnored, encodeSettings, decodeSettings,
} from '../../src/features/logging/config.js';

test('the catalog has 24 events', () => {
  assert.equal(Object.keys(EVENTS).length, 24);
});

test('joins fall back to members, then default, and use their own channel when set', () => {
  assert.equal(resolveChannelId({ channels: { members: 'm' } }, 'memberJoin'), 'm');
  assert.equal(resolveChannelId({ channels: { members: 'm', join: 'j' } }, 'memberJoin'), 'j');
  assert.equal(resolveChannelId({ channels: { default: 'd' } }, 'memberJoin'), 'd');
  assert.equal(resolveChannelId({ channels: { default: 'd' } }, 'ban'), 'd');
  assert.equal(resolveChannelId({}, 'ban'), null);
});

test('an event is on unless listed as disabled', () => {
  assert.equal(isEventEnabled({}, 'ban'), true);
  assert.equal(isEventEnabled({ disabledEvents: ['ban'] }, 'ban'), false);
  assert.equal(isEventEnabled({ disabledEvents: ['ban'] }, 'unban'), true);
});

test('ignore matches channel, member and prefix, and survives missing data', () => {
  const cfg = { ignore: { channels: ['c1'], members: ['u1'], prefixes: ['!'] } };
  assert.equal(isIgnored(cfg, { channelId: 'c1' }), true);
  assert.equal(isIgnored(cfg, { userId: 'u1' }), true);
  assert.equal(isIgnored(cfg, { content: '!help' }), true);
  assert.equal(isIgnored(cfg, { channelId: 'c2', userId: 'u2', content: 'hi' }), false);
  assert.equal(isIgnored({}, { channelId: 'c1' }), false);
  assert.equal(isIgnored(cfg, {}), false);
  assert.equal(isIgnored(cfg, { content: null }), false);
});

test('settings round-trip and bad codes are rejected', () => {
  const cfg = { disabledEvents: ['ban', 'voiceJoin'], ignore: { prefixes: ['!', '?'] } };
  assert.deepEqual(decodeSettings(encodeSettings(cfg)), { disabledEvents: ['ban', 'voiceJoin'], prefixes: ['!', '?'] });
  assert.equal(decodeSettings('%%%'), null);
  const enc = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  assert.equal(decodeSettings(enc({ v: 2, disabledEvents: [], prefixes: [] })), null);
  assert.equal(decodeSettings(enc({ v: 1, disabledEvents: ['nope'], prefixes: [] })), null);
  assert.equal(decodeSettings(enc({ v: 1, disabledEvents: ['constructor'], prefixes: [] })), null);
  assert.equal(decodeSettings('a'.repeat(2001)), null);
});
```

- [ ] **Step 2: Run** `node --test test/features/logging-config.test.js` — expect FAIL (modules not found).
- [ ] **Step 3: Create `src/features/logging/events.js`**

```js
export const CATEGORIES = ['default', 'messages', 'members', 'join', 'server', 'voice', 'mod'];

export const EVENTS = {
  messageDelete: 'messages',
  messageEdit: 'messages',
  messagePurge: 'messages',
  invitePosted: 'messages',
  roleChange: 'members',
  avatarChange: 'members',
  nameChange: 'members',
  ban: 'members',
  unban: 'members',
  timeout: 'members',
  timeoutRemoved: 'members',
  memberJoin: 'join',
  memberLeave: 'join',
  channelCreate: 'server',
  channelUpdate: 'server',
  channelDelete: 'server',
  roleCreate: 'server',
  roleUpdate: 'server',
  roleDelete: 'server',
  emoji: 'server',
  guildUpdate: 'server',
  voiceJoin: 'voice',
  voiceMove: 'voice',
  voiceLeave: 'voice',
};

export const MESSAGE_EVENTS = ['messageDelete', 'messageEdit', 'messagePurge', 'invitePosted'];
```

- [ ] **Step 4: Create `src/features/logging/config.js`**

```js
import { EVENTS } from './events.js';

export function isEventEnabled(config, event) {
  return !(config.disabledEvents ?? []).includes(event);
}

export function resolveChannelId(config, event) {
  const channels = config.channels ?? {};
  const category = EVENTS[event];
  if (channels[category]) return channels[category];
  if (category === 'join' && channels.members) return channels.members;
  return channels.default ?? null;
}

export function isIgnored(config, { channelId, userId, content } = {}) {
  const ignore = config.ignore ?? {};
  if (channelId && (ignore.channels ?? []).includes(channelId)) return true;
  if (userId && (ignore.members ?? []).includes(userId)) return true;
  if (typeof content === 'string' && content) {
    return (ignore.prefixes ?? []).some((prefix) => content.startsWith(prefix));
  }
  return false;
}

export function encodeSettings(config) {
  const payload = {
    v: 1,
    disabledEvents: config.disabledEvents ?? [],
    prefixes: config.ignore?.prefixes ?? [],
  };
  return Buffer.from(JSON.stringify(payload)).toString('base64url');
}

export function decodeSettings(code) {
  if (typeof code !== 'string' || code.length > 2000) return null;
  try {
    const p = JSON.parse(Buffer.from(code, 'base64url').toString('utf8'));
    if (p?.v !== 1 || !Array.isArray(p.disabledEvents) || !Array.isArray(p.prefixes)) return null;
    if (!p.disabledEvents.every((e) => Object.hasOwn(EVENTS, e))) return null;
    if (!p.prefixes.every((x) => typeof x === 'string' && x.length <= 10)) return null;
    return { disabledEvents: p.disabledEvents, prefixes: p.prefixes };
  } catch {
    return null;
  }
}
```

- [ ] **Step 5: Run** `node --test test/features/logging-config.test.js` — expect PASS (5 tests).
- [ ] **Step 6: Commit** `feat(logging): event catalog and config helpers`.

---

### Task 2: Central sendLog and handler split

**Files:**
- Create: `src/features/logging/send-log.js`, `src/features/logging/handlers-messages.js`, `handlers-members.js`, `handlers-server.js`, `src/features/logging/commands.js`
- Modify: `src/features/logging/index.js` (becomes thin: imports and exports `commands` and `events`), `src/features/logging/format.js` (add `withExecutor`)
- Test: update `test/features/logging.test.js`

**Tier:** sonnet — multi-file refactor that must keep behaviour, tests already exist.

**Interfaces:**
- Consumes: Task 1 helpers.
- Produces (`send-log.js`): `sendLog(ctx, guildId, event, embed, opts = {}): Promise<void>` where `opts = { sourceChannelId?, ignore?: { channelId, userId, content } }`. Order: feature enabled, `isEventEnabled`, `isIgnored(config, opts.ignore)` when given, `resolveChannelId`, loop guard (`sourceChannelId` is one of the configured channel IDs), `fetchSendable`, `trySend` with `allowedMentions: { parse: [] }` and a timestamped embed. Never throws. Also exports `safe(name, handler)` (moved unchanged).
- Produces (`format.js`): `withExecutor(embed, executorId, lang): embed` — appends field `{ name: t(lang,'logging.by'), value: '<@id>' }`, returns embed unchanged when `executorId` is falsy. Add `logging.by` ("By"/fr/ar) to all three i18n files.
- Handler files export `const events: {name, execute}[]` arrays; `index.js` concatenates them and re-exports `commands`.
- Mapping of the existing 14 handlers to events: edit→`messageEdit` (pass `ignore: {channelId, userId: author.id, content: old content ?? new content}`), delete→`messageDelete` (same), join/leave→`memberJoin`/`memberLeave`, nickname→`nameChange`, roles→`roleChange`, channel c/u/d→`channelCreate/Update/Delete`, role c/u/d→`roleCreate/Update/Delete`, emoji c/u/d→`emoji`.

- [ ] **Step 1: Update `test/features/logging.test.js`** to call `sendLog(ctx, gid, 'messageDelete', embed)` instead of category names; add tests: event listed in `disabledEvents` sends nothing; `memberJoin` falls back to the `members` channel; unset category falls back to `channels.default`; an `ignore` hit sends nothing.
- [ ] **Step 2: Run** `node --test test/features/logging.test.js` — expect FAIL.
- [ ] **Step 3: Implement** `send-log.js`, `withExecutor`, move handlers unchanged in behaviour, move the command builder/`execute` into `commands.js` (still only enable/disable/set/clear, `set`/`clear` choices now `CATEGORIES`), shrink `index.js`.
- [ ] **Step 4: Run** `npm test` — expect all green (including logging-format and i18n parity).
- [ ] **Step 5: Commit** `refactor(logging): route every log through event-aware sendLog`.

---

### Task 3: Audit-log lookup and intents

**Files:**
- Create: `src/features/logging/audit.js`
- Modify: `src/index.js:15-22` (add `GatewayIntentBits.GuildModeration`, `GatewayIntentBits.GuildVoiceStates`)
- Test: `test/features/logging-audit.test.js`

**Tier:** sonnet — external-API edge cases (permissions, timing).

**Interfaces:**
- Produces: `findExecutor(guild, auditType, targetId, now = Date.now()): Promise<string | null>` — calls `guild.fetchAuditLogs({ type: auditType, limit: 5 })`, returns `executor.id` of the newest entry whose `target?.id === targetId` and `now - createdTimestamp < 10_000`; returns `null` on no match or any thrown error (never rethrows).

- [ ] **Step 1: Write failing tests** with a fake guild: matching fresh entry returns executor id; entry 11 s old returns null; entry for another target returns null; `fetchAuditLogs` rejecting returns null.
- [ ] **Step 2: Run** `node --test test/features/logging-audit.test.js` — expect FAIL.
- [ ] **Step 3: Implement** `findExecutor`; add the two intents.
- [ ] **Step 4: Run** the test, then `npm test` — expect PASS.
- [ ] **Step 5: Commit** `feat(logging): audit-log executor lookup, moderation and voice intents`.

---

### Task 4: New message events and attribution on deletes

**Files:**
- Modify: `src/features/logging/handlers-messages.js`, `format.js`, `src/i18n/{en,fr,ar}.json`
- Test: `test/features/logging-messages.test.js`

**Tier:** sonnet — new gateway events with partial-data cases.

**Interfaces:**
- Consumes: `sendLog`, `safe`, `withExecutor`, `findExecutor` (use `AuditLogEvent.MessageDelete`, target = the message author's id).
- Produces: handlers for `Events.MessageBulkDelete` → event `messagePurge` (embed shows channel and `messages.size`; contents not listed) and `Events.MessageCreate` → event `invitePosted` (regex `/(discord\.gg|discord(?:app)?\.com\/invite)\/\S+/i` on content, skip bots/DMs, embed shows author, channel, jump link). `format.js` adds `formatPurge(count, channelId, lang)` and `formatInvite(message, lang)`. i18n keys: `logging.messagesPurged`, `logging.invitePosted`, `logging.count`.
- `messageDelete` handler now adds the executor via `withExecutor` when `findExecutor` finds one. Skip the `findExecutor` call when the message is uncached (no `author`); log without a "By" field.

- [ ] **Step 1: Write failing tests** for `formatPurge` (title key, count in a field) and `formatInvite`; invite regex matches `discord.gg/abc` and `https://discord.com/invite/abc`, not `discord.gg` alone; handler test: a message with no `guildId` is ignored; purge of an empty-cache collection still sends with the count.
- [ ] **Step 2: Run** `node --test test/features/logging-messages.test.js` — expect FAIL.
- [ ] **Step 3: Implement** the handlers and formatters; add the i18n keys in all three languages.
- [ ] **Step 4: Run** `npm test` — expect PASS.
- [ ] **Step 5: Commit** `feat(logging): purge and invite logs, delete attribution`.

---

### Task 5: Member events (ban, unban, timeout, avatar, username)

**Files:**
- Modify: `src/features/logging/handlers-members.js`, `format.js`, `src/i18n/{en,fr,ar}.json`
- Test: `test/features/logging-members.test.js`

**Tier:** sonnet — several event shapes, cache and multi-guild edge cases.

**Interfaces:**
- Consumes: `sendLog`, `findExecutor` (`AuditLogEvent.MemberBanAdd`, `MemberBanRemove`, `MemberUpdate` for timeouts), `withExecutor`.
- Produces: handlers for `Events.GuildBanAdd` (`ban`), `Events.GuildBanRemove` (`unban`), a timeout branch inside the existing `GuildMemberUpdate` handler comparing `communicationDisabledUntilTimestamp` (`timeout` when it becomes a future time, `timeoutRemoved` when it goes from future to null/past; embed shows the end time with `<t:unix:F>`), and `Events.UserUpdate` for `avatarChange` (avatar hash differs) and `nameChange` (username differs): for each guild in `client.guilds.cache` where `guild.members.cache.has(user.id)`, send one log. A guild-avatar change in `GuildMemberUpdate` (`avatar` hash) also logs `avatarChange`. Pure helper `timeoutTransition(oldTs, newTs, now): 'timeout' | 'timeoutRemoved' | null` exported from `format.js`.
- i18n keys: `logging.memberBanned`, `logging.memberUnbanned`, `logging.memberTimedOut`, `logging.timeoutRemoved`, `logging.timeoutUntil`, `logging.avatarChanged`, `logging.usernameChanged`.

- [ ] **Step 1: Write failing tests** for `timeoutTransition` (null→future = `timeout`; future→null = `timeoutRemoved`; past→null = null; future→later future = `timeout`; null→null = null) and for the `UserUpdate` handler sending only to guilds that cache the member.
- [ ] **Step 2: Run** `node --test test/features/logging-members.test.js` — expect FAIL.
- [ ] **Step 3: Implement** handlers and helper; i18n in all three languages. Ban handler needs the user from the ban object (`ban.user`); fetch partial bans before use.
- [ ] **Step 4: Run** `npm test` — expect PASS.
- [ ] **Step 5: Commit** `feat(logging): ban, unban, timeout, avatar and username logs`.

---

### Task 6: Server update and voice events

**Files:**
- Modify: `src/features/logging/handlers-server.js`; Create: `src/features/logging/handlers-voice.js`; Modify: `index.js`, `format.js`, `src/i18n/{en,fr,ar}.json`
- Test: `test/features/logging-voice.test.js`

**Tier:** sonnet.

**Interfaces:**
- Produces: `Events.GuildUpdate` handler → `guildUpdate` (log only when `name` or `icon` changed; before/after fields). Attribution via `withExecutor` + `findExecutor` for `channelCreate`/`channelDelete`/`roleCreate`/`roleDelete` (`AuditLogEvent.ChannelCreate`, etc.).
- `Events.VoiceStateUpdate` handler in `handlers-voice.js` using pure `voiceTransition(oldChannelId, newChannelId): 'voiceJoin' | 'voiceMove' | 'voiceLeave' | null` exported from `format.js` (null when both equal, including both null). Bots are skipped. Embed shows member and channel mention(s). i18n: `logging.guildUpdated`, `logging.voiceJoined`, `logging.voiceMoved`, `logging.voiceLeft`.

- [ ] **Step 1: Write failing tests** for `voiceTransition` (null→A join, A→B move, A→null leave, A→A null, null→null null).
- [ ] **Step 2: Run** `node --test test/features/logging-voice.test.js` — expect FAIL.
- [ ] **Step 3: Implement**; i18n in all three languages.
- [ ] **Step 4: Run** `npm test` — expect PASS.
- [ ] **Step 5: Commit** `feat(logging): voice, server update logs, create/delete attribution`.

---

### Task 7: Event toggles, ignore lists and status commands

**Files:**
- Modify: `src/features/logging/commands.js`, `src/i18n/{en,fr,ar}.json`
- Test: `test/features/logging-commands.test.js`

**Tier:** sonnet — builder plus stateful config writes.

**Interfaces:**
- Produces subcommands on `/logging`:
  - `event` — `event` string option with 24 choices from `Object.keys(EVENTS)` plus `all` (25 total), required boolean `enabled`. Writes the whole `disabledEvents` array (`all` clears it or fills it with every event).
  - `ignore` — optional `channel` and `member` (user) options; at least one required; appends to `config.ignore` deduplicated. `unignore` mirrors it.
  - `prefix-add` / `prefix-remove` — required string `prefix` (max 10 chars).
  - `status` — ephemeral embed: enabled flag, each category's channel (or "not set" / "falls back to X"), disabled events, ignored channels/members, prefixes.
- Pure helpers exported from `config.js` for testing: `toggleEvent(config, event, enabled): string[]`, `addIgnore(config, kind, id): object`, `removeIgnore(config, kind, id): object` (return new nested objects; callers pass them to `setFeature` as whole values). Every write sends the complete `ignore` object and complete `disabledEvents` array.
- i18n keys prefixed `logging.event*`, `logging.ignore*`, `logging.prefix*`, `logging.status*`.

- [ ] **Step 1: Write failing tests** for the three helpers (toggling `all` off disables all 24; adding the same channel twice keeps one entry; removing an absent id is a no-op) and for the command data: `event` option has exactly 25 choices and every subcommand name/description is under the 100-char limit.
- [ ] **Step 2: Run** `node --test test/features/logging-commands.test.js` — expect FAIL.
- [ ] **Step 3: Implement** helpers, subcommands and `execute` branches; i18n in all three languages.
- [ ] **Step 4: Run** `npm test` — expect PASS.
- [ ] **Step 5: Commit** `feat(logging): per-event toggles, ignore lists, status`.

---

### Task 8: One-command setup and export/import

**Files:**
- Modify: `src/features/logging/commands.js`, `src/i18n/{en,fr,ar}.json`
- Test: extend `test/features/logging-commands.test.js`

**Tier:** sonnet — creates Discord channels, parses untrusted input.

**Interfaces:**
- Consumes: `encodeSettings`, `decodeSettings`.
- Produces: `setup` subcommand (needs bot Manage Channels; on failure reply ephemeral `logging.setupFailed`): creates category "Logs" (type `GuildCategory`, `@everyone` denied `ViewChannel`, the bot allowed `ViewChannel` and `SendMessages`) and five text channels `log-messages log-members log-joins log-server log-voice`, writes `channels` for `messages members join server voice`, sets `enabled: true`. `export` subcommand replies ephemeral with the code from `encodeSettings`. `import` subcommand with required string `code` (max 2000): on `decodeSettings` null reply `logging.importInvalid` and change nothing; otherwise write `disabledEvents` and `ignore: { ...existing, prefixes }`.
- Pure helper `setupPlan(): { name: string, category: string }[]` in `config.js` returning the five channel names and their categories.

- [ ] **Step 1: Write failing tests** for `setupPlan` (5 entries, categories `messages members join server voice`) and for import handling: garbage code leaves the stored config untouched (assert via `getFeature` after the handler runs against the test DB).
- [ ] **Step 2: Run** the test file — expect FAIL.
- [ ] **Step 3: Implement** the three subcommands; i18n in all three languages.
- [ ] **Step 4: Run** `npm test` — expect PASS.
- [ ] **Step 5: Commit** `feat(logging): setup, export and import commands`.

---

### Task 9: Docs and memory notes

**Files:**
- Modify: `README.md` (line 19 feature summary, line 52 intents note: add Guild Moderation and Guild Voice States, line 87 manual checks: add steps for event toggle, ignore, voice, ban attribution, setup, export/import), `docs/memory/features-built.md`, `docs/memory/roadmap.md` (move the logging entry from "Planned, not built" to done), `docs/memory/gotchas.md` (note: ignore/toggle config shape, join to members fallback, modlog deferred to Phase 2)

**Tier:** sonnet — prose across files, must match real behaviour.

- [ ] **Step 1:** Update the files as listed; link notes with `[[wikilinks]]`; keep `docs/memory/index.md` accurate.
- [ ] **Step 2: Commit** `docs: logging parity notes and manual checks`.

---

### Task 10: Final verification run

**Files:** none changed.

**Tier:** haiku — run-and-report, no decisions.

```bash
npm test
npm run deploy
graphify update .
```

- [ ] **Step 1:** Run `npm test`; report pass/fail counts and the full output of any failure.
- [ ] **Step 2:** Run `npm run deploy`; report the output (registers the new subcommands).
- [ ] **Step 3:** Run `graphify update .`; report the output.
- [ ] **Step 4:** Report back; do not fix failures. The manual checks in the README are for the user to run against a test server.

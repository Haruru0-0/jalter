import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Events } from 'discord.js';
import { modules } from '../../src/modules.js';
import { collectModules } from '../../src/core/loader.js';
import { FEATURES } from '../../src/core/registry.js';
import { buildHelp } from '../../src/features/help/index.js';
import * as automod from '../../src/features/automod/index.js';
import * as autoresponder from '../../src/features/autoresponder/index.js';
import { pruneCooldowns } from '../../src/features/autoresponder/cooldown.js';

test('the modules load without a duplicate command, component prefix or job type', () => {
  const registry = collectModules(modules);
  assert.ok(registry.commands.has('autoresponder'));
  assert.ok(registry.components.has('autoresponder'));
});

test('the autoresponder module comes after auto-mod, so its message listener runs second', () => {
  assert.ok(modules.indexOf(autoresponder) > modules.indexOf(automod));
  assert.ok(modules.indexOf(automod) >= 0);
  const { events } = collectModules(modules);
  const automodAt = events.indexOf(automod.events.find((e) => e.name === Events.MessageCreate));
  const responderAt = events.indexOf(autoresponder.events.find((e) => e.name === Events.MessageCreate));
  assert.ok(automodAt >= 0 && responderAt > automodAt);
});

test('the registry lists the autoresponder with its command', () => {
  const feature = FEATURES.find((f) => f.key === 'autoresponder');
  assert.equal(feature.command, 'autoresponder');
  assert.equal(feature.enableCommand, 'autoresponder enable');
});

test('help lists the autoresponder command and gives it a page', () => {
  const { commands } = collectModules(modules);
  const { description } = buildHelp('en', new Map(), commands);
  assert.match(description, /\/autoresponder/);
  const page = buildHelp('en', new Map(), commands, 'autoresponder');
  assert.equal(page.title, 'Autoresponder (Off)');
  assert.match(page.description, /`\/autoresponder add`/);
});

test('the housekeeping list prunes the cooldowns', () => {
  assert.ok(collectModules(modules).housekeeping.includes(pruneCooldowns));
});

test('the autoresponder command lists builder together with every older subcommand', () => {
  const { commands } = collectModules(modules);
  const names = commands.get('autoresponder').data.toJSON().options.map((o) => o.name);
  for (const sub of ['builder', 'enable', 'disable', 'add', 'edit', 'editmatchmode', 'toggle', 'remove', 'list', 'show', 'test']) {
    assert.ok(names.includes(sub), `missing subcommand ${sub}`);
  }
  assert.equal(new Set(names).size, names.length);
});

test('help lists the autoresponder builder subcommand', () => {
  const { commands } = collectModules(modules);
  const page = buildHelp('en', new Map(), commands, 'autoresponder');
  assert.match(page.description, /`\/autoresponder builder`: .+/);
});

test('the autoresponder component prefix is registered exactly once', () => {
  const owners = modules.flatMap((m) => m.commands ?? []).filter((c) => c.components?.prefix === 'autoresponder');
  assert.equal(owners.length, 1);
  assert.equal(collectModules(modules).components.get('autoresponder'), owners[0].components);
});

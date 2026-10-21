import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { modules } from '../../src/modules.js';
import { collectModules } from '../../src/core/loader.js';
import { FEATURES } from '../../src/core/registry.js';
import { buildHelp } from '../../src/features/help/index.js';

test('the modules load without a duplicate command, component prefix or job type', () => {
  const registry = collectModules(modules);
  assert.ok(registry.commands.has('reactionroles'));
  assert.ok(registry.components.has('reactionroles'));
  assert.ok(registry.jobs.has('reactionroles.destruct'));
});

test('the registry lists reaction roles with its command', () => {
  const feature = FEATURES.find((f) => f.key === 'reactionroles');
  assert.equal(feature.command, 'reactionroles');
});

test('help lists the reaction roles command and gives it a page', () => {
  const { commands } = collectModules(modules);
  const { description } = buildHelp('en', new Map(), commands);
  assert.match(description, /\*\*Reaction roles\*\* \(Off\): .*\/reactionroles/);
  const page = buildHelp('en', new Map(), commands, 'reactionroles');
  assert.equal(page.title, 'Reaction roles (Off)');
  assert.match(page.description, /`\/reactionroles create`/);
});

test('the client asks for reaction events and partial reactions', () => {
  const source = readFileSync(new URL('../../src/index.js', import.meta.url), 'utf8');
  assert.match(source, /GatewayIntentBits\.GuildMessageReactions/);
  assert.match(source, /Partials\.Reaction/);
});

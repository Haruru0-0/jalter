import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildHelp, commandPaths } from '../../src/features/help/index.js';
import { collectModules } from '../../src/core/loader.js';
import { modules } from '../../src/modules.js';

const { commands } = collectModules(modules);

test('overview lists features with status and commands, and the later ones as coming soon', () => {
  const { description } = buildHelp('en', new Map(), commands);
  assert.match(description, /\*\*Auto role\*\* \(Off\): .*\/autorole add/);
  assert.match(description, /\*\*Embeds\*\* \(Core\): .*\/embed create/);
  assert.match(description, /\*\*Greet messages\*\* \(Off\): \/set greet, \/test greet/);
  assert.match(description, /\*\*Info commands\*\* \(Off\): .*\/userinfo.*\/serverinfo/);
  assert.match(description, /Coming soon: .*Auto-mod/);
});

test('an enabled feature says On', () => {
  const { description } = buildHelp('en', new Map([['logging', { enabled: true }]]), commands);
  assert.match(description, /\*\*Logging\*\* \(On\)/);
});

test('one feature shows every path with its description, found by key or name', () => {
  const byKey = buildHelp('en', new Map(), commands, 'greet');
  assert.match(byKey.description, /`\/set greet channel`: Choose the channel/);
  assert.match(byKey.description, /`\/test greet`/);
  assert.doesNotMatch(byKey.description, /leave/);
  assert.equal(buildHelp('en', new Map(), commands, 'Auto role').title, 'Auto role (Off)');
});

test('an unknown or coming-soon feature returns null', () => {
  assert.equal(buildHelp('en', new Map(), commands, 'nonsense'), null);
  assert.equal(buildHelp('en', new Map(), commands, 'automod'), null);
});

test('the text follows the language', () => {
  assert.equal(buildHelp('fr', new Map(), commands).title, 'Commandes');
});

test('every registered command appears in the overview', () => {
  const { description } = buildHelp('en', new Map(), commands);
  for (const name of commands.keys()) assert.ok(description.includes(`/${name}`), name);
});

test('commandPaths handles a plain command with no subcommands', () => {
  const json = commands.get('serverinfo').data.toJSON();
  assert.deepEqual(commandPaths(json, 'info', false), [{ path: 'serverinfo', description: 'About this server' }]);
});

test('the logging detail lists every logging subcommand with its description', () => {
  const { description } = buildHelp('en', new Map(), commands, 'logging');
  for (const sub of ['set', 'event', 'ignore', 'prefix-add', 'setup', 'export', 'import', 'status']) {
    assert.match(description, new RegExp(`\`/logging ${sub}\`: .+`));
  }
});

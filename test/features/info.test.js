import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildUserInfo, buildServerInfo } from '../../src/features/info/build.js';

const fieldValue = (info, name) => info.fields.find((f) => f.name === name)?.value;

test('buildServerInfo shows members, boosts, channels and roles', () => {
  const guild = {
    name: 'Home', memberCount: 12, premiumSubscriptionCount: 3, premiumTier: 1,
    channels: { cache: { size: 8 } }, roles: { cache: { size: 5 } },
    createdTimestamp: 1_700_000_000_000,
  };
  const info = buildServerInfo(guild, 'en');
  assert.equal(fieldValue(info, 'Members'), '12');
  assert.match(fieldValue(info, 'Boosts'), /3/);
  assert.equal(fieldValue(info, 'Channels'), '8');
  assert.equal(fieldValue(info, 'Roles'), '5');
});

test('buildUserInfo lists roles without @everyone and shows not-yet-available lines', () => {
  const member = {
    user: { username: 'Sam', createdTimestamp: 1_600_000_000_000 },
    joinedTimestamp: 1_700_000_000_000,
    roles: { cache: new Map([['1', { id: '1', name: '@everyone' }], ['2', { id: '2', name: 'Mod' }]]) },
  };
  const info = buildUserInfo(member, 'en');
  assert.equal(fieldValue(info, 'Roles'), '<@&2>');
  assert.match(fieldValue(info, 'Level'), /not available/i);
  assert.match(fieldValue(info, 'Warnings'), /not available/i);
  assert.match(fieldValue(info, 'Birthday'), /not available/i);
});

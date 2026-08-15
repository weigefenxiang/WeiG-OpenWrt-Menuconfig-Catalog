#!/usr/bin/env node
// SPDX-FileCopyrightText: 2026 weigefenxiang <weigefenxiang@gmail.com>
// SPDX-License-Identifier: GPL-3.0-or-later
import assert from 'node:assert/strict';
import {
  PROFILE_GROUP_ENCODING, PROFILE_GROUP_FIELDS, PROFILE_GROUP_SCHEMA, PROFILE_GROUP_STATE_GROUPS,
  buildIdentityTopology, buildProfileGroupDocument, deriveIdentityValues,
  groupConfigPairs, mapConcurrentOrdered, normalizeProfileGroupJobs, ungroupConfigPairs,
} from './generate-profile-config-groups.mjs';

assert.equal(PROFILE_GROUP_SCHEMA, 3);
assert.equal(PROFILE_GROUP_ENCODING, 'branch-common-plus-exact-config-groups-v1');
assert.deepEqual(PROFILE_GROUP_FIELDS, [
  'target', 'board', 'subtarget', 'profile', 'name', 'boardSelector', 'selector', 'targetSelector',
  'nativeHash', 'symbolCount', 'groupId',
]);
assert.deepEqual(PROFILE_GROUP_STATE_GROUPS, ['n', 'm', 'y', 'otherIndexValue']);

const entry = (target, subtarget, profile, selector, targetSelector) => ({
  target: { id: target, board: 'x86', subtarget },
  profile: { id: profile, name: profile },
  selectors: { board: 'TARGET_x86', target: targetSelector, profile: selector },
  values: new Map(),
});
const rows = [
  entry('x86/64', '64', 'DEVICE_a', 'TARGET_x86_64_DEVICE_a', 'TARGET_x86_64'),
  entry('x86/64', '64', 'DEVICE_b', 'TARGET_x86_64_DEVICE_b', 'TARGET_x86_64'),
  entry('x86', '', 'Generic', 'TARGET_x86_64', 'TARGET_x86'),
  entry('x86/64', '64', 'Generic', 'TARGET_x86_64_Generic', 'TARGET_x86_64'),
];
const topology = buildIdentityTopology(rows);
for (let index = 0; index < rows.length; index += 1) {
  const identityIndex = index === 2 ? 3 : index;
  rows[index].values = new Map([['COMMON', 'y'], ...deriveIdentityValues(topology, identityIndex)]);
}
const payload = buildProfileGroupDocument(rows, { id: 'Fixture', branch: 'test', commit: 'fixture' });
assert.equal(payload.profiles.length, 4);
assert.equal(payload.groups.length, 1, 'identity-only differences must share one exact Config Group');
assert.deepEqual(payload.identity.aliases, [[2, 3]], 'canonical Native identity alias must be preserved');
assert.equal(payload.metrics.reconstructionMismatches, 0);
assert.equal(payload.metrics.profilesInSharedGroups, 4);
assert.equal(payload.profileFields.indexOf('boardSelector'), 5, 'Profile rows must carry the exact Catalog board selector');
assert(payload.profiles.every((row) => row[5] === 'TARGET_x86'), 'fixture board selectors must round-trip exactly');
assert(!payload.symbols.some((symbol) => symbol.startsWith('TARGET_')), 'derived identity symbols must not be repeated in semantic dictionary');

const changed = rows.map((row) => ({ ...row, values: new Map(row.values) }));
changed[1].values.set('FEATURE', 'y');
const split = buildProfileGroupDocument(changed, { id: 'Fixture', branch: 'test', commit: 'fixture' });
assert.equal(split.groups.length, 2, 'real semantic differences must not collapse into one Config Group');
assert.equal(split.metrics.reconstructionMismatches, 0);

const grouped = groupConfigPairs([[0, 'n'], [1, 'm'], [2, 'y'], [3, '"hello"'], [4, '123']]);
assert.deepEqual(grouped, [[0], [1], [2], [3, '"hello"', 4, '123']]);
assert.deepEqual(ungroupConfigPairs(grouped), [[0, 'n'], [1, 'm'], [2, 'y'], [3, '"hello"'], [4, '123']]);
for (const invalid of [null, [[], [], []], [[], [], [], [0]], [[], [], [], [], []]]) {
  assert.throws(() => ungroupConfigPairs(invalid));
}

assert.equal(normalizeProfileGroupJobs('', 8), 4);
assert.equal(normalizeProfileGroupJobs('1', 8), 1);
assert.equal(normalizeProfileGroupJobs('9', 8), 4);
let active = 0;
let maxActive = 0;
const ordered = await mapConcurrentOrdered([40, 10, 30, 5], async (delay, index) => {
  active += 1;
  maxActive = Math.max(maxActive, active);
  try {
    await new Promise((resolve) => setTimeout(resolve, delay));
    return `row-${index}`;
  } finally {
    active -= 1;
  }
}, 2);
assert.equal(maxActive, 2);
assert.deepEqual(ordered, ['row-0', 'row-1', 'row-2', 'row-3']);

console.log('E Profile Config Group checks passed: exact grouping, exact board selectors, identity alias reconstruction, semantic split, grouped states, bounded workers.');

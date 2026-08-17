#!/usr/bin/env node
// SPDX-FileCopyrightText: 2026 weigefenxiang <weigefenxiang@gmail.com>
// SPDX-License-Identifier: GPL-3.0-or-later
import assert from 'node:assert/strict';
import {
  buildProfileSeed,
  compareConfigSemantics,
  configSemanticHash,
  normalizeConfigSemantics,
  parseConfigSymbols,
} from './profile-config-contract.mjs';
import {
  buildDataBranchForCodeRef,
  fixDataBranchForCodeRef,
  runtimeDataBranchForChannel,
} from './catalog-channels.mjs';

const target = { board: 'mediatek', subtarget: 'filogic' };
const profile = { id: 'DEVICE_demo' };
const selectors = {
  board: 'TARGET_mediatek',
  target: 'TARGET_mediatek_filogic',
  profile: 'TARGET_mediatek_filogic_DEVICE_demo',
};
const seed = buildProfileSeed(target, profile, selectors);
assert.equal(seed,
  'CONFIG_HAVE_DOT_CONFIG=y\n' +
  'CONFIG_TARGET_mediatek=y\n' +
  'CONFIG_TARGET_mediatek_filogic=y\n' +
  'CONFIG_TARGET_mediatek_filogic_DEVICE_demo=y\n');

const left = [
  'CONFIG_ZETA="demo"',
  '# CONFIG_ALPHA is not set',
  'CONFIG_BETA=m',
  '',
].join('\r\n');
const right = [
  'CONFIG_BETA=m',
  'CONFIG_ALPHA=n',
  'CONFIG_ZETA="demo"',
  '',
].join('\n');
assert.deepEqual(Object.fromEntries(parseConfigSymbols(left)), {
  ZETA: '"demo"', ALPHA: 'n', BETA: 'm',
});
assert.equal(normalizeConfigSemantics(left),
  'CONFIG_ALPHA=n\nCONFIG_BETA=m\nCONFIG_ZETA="demo"\n');
assert.equal(normalizeConfigSemantics(left), normalizeConfigSemantics(right));
assert.equal(configSemanticHash(left), configSemanticHash(right));
assert.deepEqual(compareConfigSemantics(left, right).differences, []);
assert.equal(compareConfigSemantics(left, right).equal, true);

const changed = compareConfigSemantics(left, right.replace('CONFIG_BETA=m', 'CONFIG_BETA=y'));
assert.equal(changed.equal, false);
assert.deepEqual(changed.differences, [{ symbol: 'BETA', left: 'm', right: 'y' }]);
assert.throws(() => parseConfigSymbols('CONFIG_DUP=y\n# CONFIG_DUP is not set\n'), /conflicting Kconfig value/);

assert.equal(fixDataBranchForCodeRef('fix-profile-contract'), 'catalog-fix-profile-contract');
assert.equal(buildDataBranchForCodeRef('fix-profile-contract'), 'catalog-fix-profile-contract');
assert.equal(runtimeDataBranchForChannel('fix-profile-contract'), 'catalog-fix-profile-contract');

console.log('D profile config contract checks passed.');

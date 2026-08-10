#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  createProbePlan,
  dataBranchForCodeRef,
  probeTargetConfig,
  resolveProbePackages,
} from './package-probe-controller.mjs';
import { parseProbeLog, requestedPackageStates } from './write-package-probe-evidence.mjs';
import { sourceAllowsBranch } from './source-policy.mjs';

const ROOT = resolve(import.meta.dirname, '..');
const policy = JSON.parse(readFileSync(resolve(ROOT, '.github', 'automation-policy.json'), 'utf8'));
const config = JSON.parse(readFileSync(resolve(ROOT, 'catalog.config.json'), 'utf8'));
const workflow = readFileSync(resolve(ROOT, '.github', 'workflows', 'package-probe.yml'), 'utf8');
const applications = { items: [{ id: 'oscam', package: 'luci-app-oscam' }] };
const index = {
  schema: 2,
  sources: [{
    id: 'ImmortalWrt', label: 'ImmortalWrt', repo: 'example/immortal',
    branches: [
      { branch: 'master', commit: 'a'.repeat(40), state: 'fresh' },
      { branch: 'openwrt-30.01', commit: 'b'.repeat(40), state: 'fresh' },
      { branch: 'openwrt-29.12', commit: 'c'.repeat(40), state: 'stale' },
      { branch: 'broken', commit: 'd'.repeat(40), state: 'unavailable' },
    ],
  }],
};

assert.equal(dataBranchForCodeRef('main'), 'catalog-data');
assert.equal(dataBranchForCodeRef('dev'), 'catalog-dev');
assert.equal(dataBranchForCodeRef('staging'), 'catalog-staging');
assert.equal(dataBranchForCodeRef('fix/probe'), 'catalog-fix');
assert.deepEqual(resolveProbePackages(['oscam', 'raw-package'], applications).packages,
  ['luci-app-oscam', 'raw-package']);
const selectableTarget = (id, selector, profile = '') => ({
  id,
  targetSelector: selector,
  contract: { selectable: true, boardSelector: selector.split('_').slice(0, 2).join('_') },
  profiles: profile ? [{ id: profile, selector: `${selector}_${profile}`, targetSelector: selector,
    boardSelector: selector.split('_').slice(0, 2).join('_'), selectable: true }] : [],
});
const preferredTarget = probeTargetConfig({
  schema: 6,
  targets: [selectableTarget('other/default', 'TARGET_other_default', 'Default'),
    selectableTarget('x86/64', 'TARGET_x86_64', 'DEVICE_generic')],
});
assert.equal(preferredTarget.target, 'x86/64');
assert.equal(preferredTarget.profile, 'DEVICE_generic');
assert(preferredTarget.config.includes('CONFIG_TARGET_x86_64_DEVICE_generic=y'));
const fallbackTarget = probeTargetConfig({
  schema: 6, targets: [selectableTarget('future/board', 'TARGET_future_board', 'Default')],
});
assert.equal(fallbackTarget.target, 'future/board');
assert(fallbackTarget.config.includes('CONFIG_TARGET_future_board_Default=y'));
assert.throws(() => probeTargetConfig({ schema: 6, targets: [] }), /no selectable Target/);

const ownerPlan = createProbePlan({
  index, applications, policy,
  env: {
    PROBE_PACKAGES: 'oscam', PROBE_MODE: 'compile', SOURCE_PATTERN: '*', BRANCH_PATTERN: '*',
    REPOSITORY_OWNER: 'owner', GITHUB_ACTOR: 'owner', MAX_PARALLEL: '0', CODE_REF: 'dev',
    DATA_BRANCH: 'catalog-dev',
  },
});
assert.equal(ownerPlan.matrix.include.length, 3);
assert.equal(ownerPlan.maxParallel, 3);
assert.deepEqual(ownerPlan.resolvedPackages, ['luci-app-oscam']);
assert(!ownerPlan.matrix.include.some((row) => row.branch === 'broken'));

const collaboratorPlan = createProbePlan({
  index, applications, policy,
  env: {
    PROBE_PACKAGES: 'oscam', PROBE_MODE: 'co-install', SOURCE_PATTERN: 'Immortal*', BRANCH_PATTERN: 'openwrt-*',
    REPOSITORY_OWNER: 'owner', GITHUB_ACTOR: 'writer', MAX_PARALLEL: '20', CODE_REF: 'dev',
    DATA_BRANCH: 'catalog-dev',
  },
});
assert.equal(collaboratorPlan.matrix.include.length, 2);
assert.equal(collaboratorPlan.maxParallel, 2);
assert.equal(collaboratorPlan.mode, 'co-install');

const branches = (count) => Array.from({ length: count }, (_, indexValue) => ({
  branch: `openwrt-${1000 + indexValue}.01`, commit: 'e'.repeat(40), state: 'fresh',
}));
const largeIndex = (count) => ({
  schema: 2, sources: [{ id: 'OpenWrt', repo: 'example/openwrt', branches: branches(count) }],
});
assert.equal(createProbePlan({
  index: largeIndex(256), applications, policy,
  env: { PROBE_PACKAGES: 'oscam', REPOSITORY_OWNER: 'owner', GITHUB_ACTOR: 'owner', MAX_PARALLEL: '0' },
}).matrix.include.length, 256);
assert.throws(() => createProbePlan({
  index: largeIndex(257), applications, policy,
  env: { PROBE_PACKAGES: 'oscam', REPOSITORY_OWNER: 'owner', GITHUB_ACTOR: 'owner', MAX_PARALLEL: '0' },
}), /configured limit is 256/);

const apkIssues = parseProbeLog(
  'ERROR: luci-app-openvpn-server-3.0-r0: trying to overwrite etc/config/openvpn owned by openvpn-openssl-2.7.4-r3.\n' +
  'ERROR: package/feeds/packages/ovpn-dco failed to build.\n' +
  'ERROR: requested package states did not survive make defconfig: missing=y');
assert(apkIssues.some((row) => row.type === 'file-ownership' && row.manager === 'apk' &&
  row.path === '/etc/config/openvpn'));
assert(apkIssues.some((row) => row.type === 'build-failure' && row.target.endsWith('/ovpn-dco')));
assert(apkIssues.some((row) => row.type === 'kconfig-unresolved'));
const opkgIssues = parseProbeLog(
  'Package alpha wants to install file /etc/example\nBut that file is already provided by package beta.');
assert(opkgIssues.some((row) => row.type === 'file-ownership' && row.manager === 'opkg'));
assert.deepEqual(requestedPackageStates(
  'CONFIG_PACKAGE_alpha=m\nCONFIG_PACKAGE_beta=y\n# CONFIG_PACKAGE_gamma is not set\n',
  ['alpha', 'beta', 'gamma', 'missing']), { alpha: 'm', beta: 'y', gamma: 'n', missing: 'missing' });

const lede = config.sources.find((source) => source.id === 'lede');
assert(sourceAllowsBranch(lede, 'master'));
for (const version of ['openwrt-27.01', 'openwrt-28.12', 'openwrt-29.10', 'openwrt-30.01']) {
  assert(sourceAllowsBranch(lede, version), `lede future branch was not discovered: ${version}`);
}

assert(workflow.includes('strategy:') && workflow.includes('matrix: ${{ fromJSON(needs.plan.outputs.matrix) }}'));
assert(workflow.includes('max-parallel: ${{ fromJSON(needs.plan.outputs.max_parallel) }}'));
assert(workflow.includes('"package/${package}/compile"') && !workflow.includes('make -j"$(nproc)" package/compile'));
assert(workflow.includes('PROBE_TARGET_CONFIG: ${{ matrix.targetConfig }}') &&
  workflow.includes(`printf '%s\\n' "$PROBE_TARGET_CONFIG" > .config`) &&
  !workflow.includes('CONFIG_TARGET_x86'));
assert(!workflow.includes('package-probe-child.yml') && !workflow.includes('/dispatches'));
assert(workflow.includes('retention-days: 60') && workflow.includes('retention-days: 30'));
assert.equal(policy.probe.collaboratorMaxParallel, 3);
assert.equal(policy.probe.maxMatrixJobs, 256);
assert.equal(policy.probe.normalizedEvidenceDays, 60);
assert.equal(policy.probe.fullLogDays, 30);

console.log('package probe checks passed');

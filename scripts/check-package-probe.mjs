#!/usr/bin/env node
import assert from 'node:assert/strict';
import { gzipSync } from 'node:zlib';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  createProbePlan,
  normalizePackageConfig,
  normalizeProbeMode,
  normalizeProbeRequest,
  probeTargetConfig,
  probeTargetConfigs,
} from './package-probe-controller.mjs';
import { runtimeDataBranchForChannel } from './catalog-channels.mjs';
import { parseProbeStateToken, PROBE_STATE_PREFIX } from './package-probe-state.mjs';
import {
  isProbeIssue,
  probeCancellationAuthorized,
  probeCancellationRequested,
  probeIssueCommand,
  probeRunMarkers,
} from './package-probe-issue.mjs';
import { aggregateScopeConclusions, createEvidence, evidenceSummaryLines, parseProbeLog,
  requestedPackageStates } from './write-package-probe-evidence.mjs';
import { sourceAllowsBranch } from './source-policy.mjs';

const ROOT = resolve(import.meta.dirname, '..');
const policy = JSON.parse(readFileSync(resolve(ROOT, '.github', 'automation-policy.json'), 'utf8'));
const config = JSON.parse(readFileSync(resolve(ROOT, 'catalog.config.json'), 'utf8'));
const workflow = readFileSync(resolve(ROOT, '.github', 'workflows', 'package-probe.yml'), 'utf8');
const gatewayWorkflow = readFileSync(resolve(ROOT, '.github', 'workflows', 'package-probe-request.yml'), 'utf8');
const issueForm = readFileSync(resolve(ROOT, '.github', 'ISSUE_TEMPLATE', 'package-probe.yml'), 'utf8');
const catalogWorkflow = readFileSync(resolve(ROOT, '.github', 'workflows', 'catalog.yml'), 'utf8');
const controller = readFileSync(resolve(ROOT, 'scripts', 'package-probe-controller.mjs'), 'utf8');
const issueGateway = readFileSync(resolve(ROOT, 'scripts', 'package-probe-issue.mjs'), 'utf8');
const runner = readFileSync(resolve(ROOT, 'scripts', 'run-package-probe.mjs'), 'utf8');
const probeUi = JSON.parse(readFileSync(resolve(ROOT, 'translations', 'probe-ui.json'), 'utf8'));

const packageConfig = [
  'CONFIG_PACKAGE_luci-app-oscam=y',
  'CONFIG_PACKAGE_oscam=y',
  'CONFIG_PACKAGE_libexample=m',
].join('\n') + '\n';
const baseRequest = {
  schema: 2, channel: 'dev', mode: 'firmware-integration', packageConfig,
  scope: { mode: 'pairs', pairs: [['ImmortalWrt', 'master']] },
  targetPolicy: { mode: 'auto' }, maxParallel: 0, execute: true,
};
const index = {
  schema: 2,
  sources: [{ id: 'ImmortalWrt', label: 'ImmortalWrt', repo: 'example/immortal', branches: [
    { branch: 'master', commit: 'a'.repeat(40), state: 'fresh' },
    { branch: 'openwrt-30.01', commit: 'b'.repeat(40), state: 'fresh' },
    { branch: 'openwrt-29.12', commit: 'c'.repeat(40), state: 'stale' },
    { branch: 'broken', commit: 'd'.repeat(40), state: 'unavailable' },
  ] }],
};

assert.equal(runtimeDataBranchForChannel('main'), 'catalog-data');
assert.equal(runtimeDataBranchForChannel('dev'), 'catalog-dev');
assert.equal(runtimeDataBranchForChannel('staging'), 'catalog-staging');
assert.equal(runtimeDataBranchForChannel('fix/probe'), 'catalog-fix');
assert.equal(normalizeProbeMode('compile'), 'package-compile');
assert.equal(normalizeProbeMode('co-install'), 'rootfs-integration');
assert.throws(() => normalizeProbeMode('plugin-special-case'), /unsupported probe mode/);

const normalizedState = normalizePackageConfig(packageConfig);
assert.equal(normalizedState.packageConfig, packageConfig);
assert.deepEqual(normalizedState.packages, ['luci-app-oscam', 'oscam', 'libexample']);
assert.equal(normalizedState.states.get('libexample'), 'm');
assert.throws(() => normalizePackageConfig('CONFIG_PACKAGE_bad=z\n'), /invalid packageConfig/);
assert.throws(() => normalizePackageConfig('CONFIG_PACKAGE_alpha=m\nCONFIG_PACKAGE_alpha=y\n'), /conflicting package state/);
const manyPackages = Array.from({ length: 24 }, (_, i) => `CONFIG_PACKAGE_pkg-${i}=y`).join('\n') + '\n';
assert.equal(normalizePackageConfig(manyPackages).packages.length, 24, 'Probe must not retain the old 8-package cap');

const request = normalizeProbeRequest(baseRequest);
assert.equal(request.schema, 2);
assert.equal(request.packageConfig, packageConfig);
assert.deepEqual(request.packages, ['luci-app-oscam', 'oscam', 'libexample']);
assert.throws(() => normalizeProbeRequest({ ...baseRequest, schema: 1 }), /schema 2/);
assert.throws(() => normalizeProbeRequest({ ...baseRequest, unknown: true }), /unknown keys/);
assert.equal(normalizeProbeRequest({ ...baseRequest, channel: 'fix/source-compatibility' }).channel,
  'fix/source-compatibility');

const token = PROBE_STATE_PREFIX + gzipSync(Buffer.from(JSON.stringify(baseRequest))).toString('base64url');
const parsedState = parseProbeStateToken(`### Generated probe state\n\n${token}\n`);
assert.deepEqual(parsedState.raw, baseRequest);
assert.match(parsedState.sha256, /^[a-f0-9]{64}$/);
assert.throws(() => parseProbeStateToken('no generated state'), /exactly one/);
assert.throws(() => parseProbeStateToken(`${token}\n${token}`), /exactly one/);
assert.throws(() => parseProbeStateToken(`${PROBE_STATE_PREFIX}${Buffer.from('not gzip').toString('base64url')}`), /gzip/);

assert(isProbeIssue({ title: '[probe] package', user: { login: 'author' } }));
assert(!isProbeIssue({ title: '[build] package' }));
assert(!isProbeIssue({ title: '[probe] pull', pull_request: {} }));
assert.equal(probeIssueCommand(' /CANCEL\n'), 'cancel');
assert.equal(probeIssueCommand('/cancel now'), '');
assert(probeCancellationAuthorized({ requester: 'Author', commenter: 'author', permission: 'read' }));
for (const permission of ['write', 'maintain', 'admin']) assert(probeCancellationAuthorized({ requester: 'author', commenter: 'helper', permission }));
assert(!probeCancellationAuthorized({ requester: 'author', commenter: 'reader', permission: 'read' }));
for (const version of [1, 2]) {
  const marker = `<!-- WEIG_PACKAGE_PROBE_RUN_V${version} run=123 sha=${'a'.repeat(64)} -->`;
  assert.deepEqual(probeRunMarkers([{ body: marker }, { body: marker }]), [{ runId: 123, sha256: 'a'.repeat(64) }]);
}
assert(probeCancellationRequested([{ body: '<!-- WEIG_PACKAGE_PROBE_CANCEL_V1 -->' }]));

const selectableTarget = (id, selector, profile = '') => ({ id, targetSelector: selector,
  contract: { selectable: true, boardSelector: selector.split('_').slice(0, 2).join('_') },
  profiles: profile ? [{ id: profile, selector: `${selector}_${profile}`, targetSelector: selector,
    boardSelector: selector.split('_').slice(0, 2).join('_'), selectable: true }] : [] });
const core = { schema: 6, targets: [selectableTarget('other/default', 'TARGET_other_default', 'Default'),
  selectableTarget('x86/64', 'TARGET_x86_64', 'DEVICE_generic')] };
const preferredTarget = probeTargetConfig(core);
assert.equal(preferredTarget.target, 'x86/64');
assert.equal(preferredTarget.profile, 'DEVICE_generic');
assert(preferredTarget.config.includes('CONFIG_TARGET_x86_64_DEVICE_generic=y'));
assert.equal(probeTargetConfigs(core, { mode: 'boot-smoke', bootTargetPatterns: ['x86/64'] }).length, 1);

const ownerPlan = createProbePlan({ index, policy, request: {
  ...baseRequest, mode: 'package-compile', scope: { mode: 'all' }, targetPolicy: { mode: 'auto' },
}, env: { REPOSITORY_OWNER: 'owner', GITHUB_ACTOR: 'owner', PROBE_AUTHORIZATION: 'admin' } });
assert.equal(ownerPlan.matrix.include.length, 3);
assert.equal(ownerPlan.maxParallel, 3);
assert.equal(ownerPlan.mode, 'package-compile');
assert.equal(ownerPlan.evidenceLevel, 1);
assert.equal(ownerPlan.timeoutMinutes, 360);
assert.deepEqual(ownerPlan.resolvedPackages, ['luci-app-oscam', 'oscam', 'libexample']);
assert.equal(ownerPlan.packageConfig, packageConfig);
assert.deepEqual(ownerPlan.mappings, []);
assert(ownerPlan.matrix.include.every((row) => row.packages === 'luci-app-oscam,oscam,libexample'));
assert(!ownerPlan.matrix.include.some((row) => row.branch === 'broken'));

const collaboratorPlan = createProbePlan({ index, policy, request: {
  ...baseRequest, mode: 'rootfs-integration', scope: { mode: 'patterns', source: 'Immortal*', branch: 'openwrt-*' },
  maxParallel: 20,
}, env: { REPOSITORY_OWNER: 'owner', GITHUB_ACTOR: 'writer', PROBE_AUTHORIZATION: 'write' } });
assert.equal(collaboratorPlan.matrix.include.length, 2);
assert.equal(collaboratorPlan.maxParallel, 2);

const apkIssues = parseProbeLog(
  'ERROR: luci-app-openvpn-server-3.0-r0: trying to overwrite etc/config/openvpn owned by openvpn-openssl-2.7.4-r3.\n' +
  'ERROR: package/feeds/packages/ovpn-dco failed to build.\n' +
  'ERROR: requested package states did not survive make defconfig: missing=y');
assert(apkIssues.some((row) => row.type === 'rootfs-conflict' && row.manager === 'apk' && row.path === '/etc/config/openvpn'));
assert(apkIssues.some((row) => row.type === 'package-build-failure'));
assert(apkIssues.some((row) => row.type === 'kconfig-unsatisfied'));
assert.deepEqual(requestedPackageStates('CONFIG_PACKAGE_alpha=m\nCONFIG_PACKAGE_beta=y\n# CONFIG_PACKAGE_gamma is not set\n',
  ['alpha', 'beta', 'gamma', 'missing']), { alpha: 'm', beta: 'y', gamma: 'n', missing: 'missing' });
const infrastructure = createEvidence({ log: 'No space left on device', runtime: { conclusion: 'fully-incompatible', attempts: [] },
  env: { PROBE_PACKAGES: 'alpha', PROBE_CONCLUSION: 'failure' } });
assert.equal(infrastructure.conclusion, 'infrastructure-failure');
const recovered = createEvidence({ log: '', runtime: { conclusion: 'sampled-compatible',
  attempts: [{ result: 'success', stages: { packageCompile: 'success' }, serialRetries: [{ label: 'package:alpha', result: 'recovered' }] }] },
  env: { PROBE_PACKAGES: 'alpha', PROBE_CONCLUSION: 'success' } });
assert(evidenceSummaryLines(recovered).some((line) => line.includes('Serial recovery / 串行复核恢复')));
const coverageRow = (target, result, issue = { type: 'package-build-failure' }) => ({
  source: 'Source', branch: 'branch', target, mode: 'package-compile', packages: ['package'],
  coverage: { requested: 2, attempted: 1 }, attempts: [{ target, result, stages: { packageCompile: result } }], issues: issue ? [issue] : [],
});
assert.equal(aggregateScopeConclusions([coverageRow('target/a', 'failure'), coverageRow('target/b', 'failure')])[0].conclusion, 'fully-incompatible');
assert.equal(aggregateScopeConclusions([coverageRow('target/a', 'success', null), coverageRow('target/b', 'failure')])[0].conclusion, 'partially-compatible');

const lede = config.sources.find((source) => source.id === 'lede');
assert(sourceAllowsBranch(lede, 'master'));
for (const version of ['openwrt-27.01', 'openwrt-28.12', 'openwrt-29.10', 'openwrt-30.01']) {
  assert(sourceAllowsBranch(lede, version), `lede future branch was not discovered: ${version}`);
}

assert(gatewayWorkflow.includes('\n  issues:\n') && gatewayWorkflow.includes('\n  issue_comment:\n') && gatewayWorkflow.includes('node scripts/package-probe-gateway.mjs'));
assert(gatewayWorkflow.includes('actions: write') && gatewayWorkflow.includes('issues: write'));
assert(issueForm.includes('id: state') && !issueForm.includes('type: upload') && !issueForm.includes('probe-request.json') && issueForm.includes('`/cancel`'));
assert(workflow.includes('package_config:') && workflow.includes('state_sha256:') && workflow.includes('PROBE_PACKAGE_CONFIG'));
assert(!workflow.includes('inputs.packages') && !workflow.includes('inputs.request') && !workflow.includes('PROBE_REQUEST_SHA256'));
assert(workflow.includes('timeout-minutes: ${{ fromJSON(needs.plan.outputs.timeout_minutes) }}'));
assert(controller.includes('normalizePackageConfig') && controller.includes('parseProbeStateToken'));
assert(!controller.includes('applications.json.gz') && !controller.includes('resolveProbePackages') && !controller.includes('maxPackages'));
assert(!issueGateway.includes('downloadProbeRequest') && !issueGateway.includes('probe-request.json'));
assert(runner.includes('const state = PACKAGE_STATES.get(packageName)') && runner.includes('states[name] === PACKAGE_STATES.get(name)') && !runner.includes("PACKAGE_STATES.get(packageName) || 'n'"));
assert(runner.includes('writeConfig(candidate, [])'), 'firmware baseline must exclude the shared package state');
assert(workflow.includes('node scripts/run-package-probe.mjs') && runner.includes('package/install'));
assert(workflow.includes('retention-days: 60') && workflow.includes('retention-days: 30'));
assert.equal(policy.probe.collaboratorMaxParallel, 3);
assert.equal(policy.probe.maxMatrixJobs, 256);
assert.equal(policy.probe.maxPackageConfigBytes, 131072);
assert.equal(policy.probe.normalizedEvidenceDays, 60);
assert.equal(policy.probe.fullLogDays, 30);
assert(!('maxPackages' in policy.probe));
for (const key of ['howTo', 'submittedState', 'stateInstruction', 'invalid']) assert(probeUi.strings[key]?.en && probeUi.strings[key]?.['zh-CN']);
assert(!probeUi.strings.downloadedRequest && !probeUi.strings.uploadInstruction);
assert(catalogWorkflow.includes('!scripts/run-package-probe.mjs') && catalogWorkflow.includes('!scripts/package-probe-*.mjs'));

console.log('Package probe shared-state checks passed.');

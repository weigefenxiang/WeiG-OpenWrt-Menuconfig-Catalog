#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  createProbePlan,
  dataBranchForCodeRef,
  normalizeProbeMode,
  normalizeProbeRequest,
  probeTargetConfig,
  probeTargetConfigs,
  resolveProbePackages,
} from './package-probe-controller.mjs';
import {
  downloadProbeRequest,
  parseProbeRequestBytes,
  probeRequestAttachment,
  PROBE_REQUEST_MAX_BYTES,
} from './package-probe-request.mjs';
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
const runner = readFileSync(resolve(ROOT, 'scripts', 'run-package-probe.mjs'), 'utf8');
const probeUi = JSON.parse(readFileSync(resolve(ROOT, 'translations', 'probe-ui.json'), 'utf8'));
const applications = { items: [{ id: 'oscam', package: 'luci-app-oscam' }] };
const index = {
  schema: 2,
  sources: [{ id: 'ImmortalWrt', label: 'ImmortalWrt', repo: 'example/immortal', branches: [
    { branch: 'master', commit: 'a'.repeat(40), state: 'fresh' },
    { branch: 'openwrt-30.01', commit: 'b'.repeat(40), state: 'fresh' },
    { branch: 'openwrt-29.12', commit: 'c'.repeat(40), state: 'stale' },
    { branch: 'broken', commit: 'd'.repeat(40), state: 'unavailable' },
  ] }],
};

assert.equal(dataBranchForCodeRef('main'), 'catalog-data');
assert.equal(dataBranchForCodeRef('dev'), 'catalog-dev');
assert.equal(dataBranchForCodeRef('staging'), 'catalog-staging');
assert.equal(dataBranchForCodeRef('fix/probe'), 'catalog-fix');
assert.equal(normalizeProbeMode('compile'), 'package-compile');
assert.equal(normalizeProbeMode('co-install'), 'rootfs-integration');
assert.throws(() => normalizeProbeMode('plugin-special-case'), /unsupported probe mode/);
assert.deepEqual(resolveProbePackages(['oscam', 'raw-package'], applications).packages,
  ['luci-app-oscam', 'raw-package']);

const request = normalizeProbeRequest({ schema: 1, channel: 'dev', mode: 'firmware-integration',
  packages: ['oscam'], scope: { mode: 'pairs', pairs: [['ImmortalWrt', 'master']] },
  targetPolicy: { mode: 'auto' }, maxParallel: 0, execute: true });
assert.throws(() => normalizeProbeRequest({ ...request, unknown: true }), /unknown keys/);
assert.equal(normalizeProbeRequest({ ...request, channel: 'fix/source-compatibility' }).channel,
  'fix/source-compatibility');

const requestBytes = Buffer.from(JSON.stringify(request) + '\n');
const attachmentBody = '[probe-request.json](https://github.com/user-attachments/files/123/probe-request.json)';
assert.equal(probeRequestAttachment(attachmentBody).name, 'probe-request.json');
assert.throws(() => probeRequestAttachment('no attachment'), /exactly one/);
assert.throws(() => probeRequestAttachment(`${attachmentBody}\n${attachmentBody.replace('/123/', '/456/')}`), /exactly one/);
assert.throws(() => probeRequestAttachment('[request.txt](https://github.com/user-attachments/files/123/request.txt)'), /JSON/);
assert.deepEqual(parseProbeRequestBytes(requestBytes).raw, request);
assert.throws(() => parseProbeRequestBytes(Buffer.from([0xC3, 0x28])), /UTF-8/);
assert.throws(() => parseProbeRequestBytes(Buffer.concat([Buffer.from([0xEF, 0xBB, 0xBF]), requestBytes])), /BOM/);
assert.throws(() => parseProbeRequestBytes(Buffer.from('{"schema":1}\0')), /NUL/);
assert.throws(() => parseProbeRequestBytes(Buffer.alloc(PROBE_REQUEST_MAX_BYTES + 1, 0x20)), /size/);
assert.throws(() => parseProbeRequestBytes(Buffer.from('{broken')), /invalid JSON/);
const downloadedRequest = await downloadProbeRequest(attachmentBody, { fetcher: async () => ({
  ok: true, status: 200, headers: new Headers({ 'content-length': String(requestBytes.length) }),
  arrayBuffer: async () => requestBytes,
}) });
assert.deepEqual(downloadedRequest.raw, request);
assert.match(downloadedRequest.sha256, /^[a-f0-9]{64}$/);

assert(isProbeIssue({ title: '[probe] package', user: { login: 'author' } }));
assert(!isProbeIssue({ title: '[build] package' }));
assert(!isProbeIssue({ title: '[probe] pull', pull_request: {} }));
assert.equal(probeIssueCommand(' /CANCEL\n'), 'cancel');
assert.equal(probeIssueCommand('/cancel now'), '');
assert(probeCancellationAuthorized({ requester: 'Author', commenter: 'author', permission: 'read' }));
for (const permission of ['write', 'maintain', 'admin']) {
  assert(probeCancellationAuthorized({ requester: 'author', commenter: 'helper', permission }));
}
assert(!probeCancellationAuthorized({ requester: 'author', commenter: 'reader', permission: 'read' }));
const runMarker = `<!-- WEIG_PACKAGE_PROBE_RUN_V1 run=123 sha=${'a'.repeat(64)} -->`;
assert.deepEqual(probeRunMarkers([{ body: runMarker }, { body: runMarker }]), [{ runId: 123, sha256: 'a'.repeat(64) }]);
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
const exactProfileCore = structuredClone(core);
exactProfileCore.targets[1].profiles.push({ id: 'DEVICE_custom', selector: 'TARGET_x86_64_DEVICE_custom',
  targetSelector: 'TARGET_x86_64', boardSelector: 'TARGET_x86', selectable: true });
const exactProfile = probeTargetConfigs(exactProfileCore, {
  selections: [{ target: 'x86/64', profile: 'DEVICE_custom' }],
});
assert.equal(exactProfile.length, 1);
assert.equal(exactProfile[0].profile, 'DEVICE_custom');
assert(exactProfile[0].config.includes('CONFIG_TARGET_x86_64_DEVICE_custom=y'));
assert.throws(() => probeTargetConfigs(core, { mode: 'boot-smoke', bootTargetPatterns: ['not-present/*'] }),
  /no selectable Target/);

const ownerPlan = createProbePlan({ index, applications, policy, request: { schema: 1, channel: 'dev',
  mode: 'package-compile', packages: ['oscam'], scope: { mode: 'all' }, targetPolicy: { mode: 'auto' },
  maxParallel: 0, execute: true },
env: { REPOSITORY_OWNER: 'owner', GITHUB_ACTOR: 'owner', PROBE_AUTHORIZATION: 'admin' } });
assert.equal(ownerPlan.matrix.include.length, 3);
assert.equal(ownerPlan.maxParallel, 3);
assert.equal(ownerPlan.mode, 'package-compile');
assert.equal(ownerPlan.evidenceLevel, 1);
assert.equal(ownerPlan.timeoutMinutes, 360);
assert.deepEqual(ownerPlan.resolvedPackages, ['luci-app-oscam']);
assert(!ownerPlan.matrix.include.some((row) => row.branch === 'broken'));

const collaboratorPlan = createProbePlan({ index, applications, policy, request: { schema: 1, channel: 'dev',
  mode: 'rootfs-integration', packages: ['oscam'], scope: { mode: 'patterns', source: 'Immortal*', branch: 'openwrt-*' },
  targetPolicy: { mode: 'auto' }, maxParallel: 20, execute: true },
env: { REPOSITORY_OWNER: 'owner', GITHUB_ACTOR: 'writer', PROBE_AUTHORIZATION: 'write' } });
assert.equal(collaboratorPlan.matrix.include.length, 2);
assert.equal(collaboratorPlan.maxParallel, 2);
assert.equal(collaboratorPlan.mode, 'rootfs-integration');

const branches = (count) => Array.from({ length: count }, (_, indexValue) => ({
  branch: `openwrt-${1000 + indexValue}.01`, commit: 'e'.repeat(40), state: 'fresh',
}));
const largeIndex = (count) => ({ schema: 2,
  sources: [{ id: 'OpenWrt', repo: 'example/openwrt', branches: branches(count) }] });
assert.equal(createProbePlan({ index: largeIndex(256), applications, policy,
  request: { schema: 1, channel: 'main', mode: 'package-compile', packages: ['oscam'], scope: { mode: 'all' },
    targetPolicy: { mode: 'auto' }, maxParallel: 0, execute: false },
  env: { REPOSITORY_OWNER: 'owner', GITHUB_ACTOR: 'owner' } }).matrix.include.length, 256);

const apkIssues = parseProbeLog(
  'ERROR: luci-app-openvpn-server-3.0-r0: trying to overwrite etc/config/openvpn owned by openvpn-openssl-2.7.4-r3.\n' +
  'ERROR: package/feeds/packages/ovpn-dco failed to build.\n' +
  'ERROR: requested package states did not survive make defconfig: missing=y');
assert(apkIssues.some((row) => row.type === 'rootfs-conflict' && row.manager === 'apk' && row.path === '/etc/config/openvpn'));
assert(apkIssues.some((row) => row.type === 'package-build-failure' && row.target.endsWith('/ovpn-dco')));
assert(apkIssues.some((row) => row.type === 'kconfig-unsatisfied'));
assert(parseProbeLog('ERROR: package compile failed: alpha').some((row) => row.type === 'package-build-failure'));
assert(parseProbeLog('ERROR: RootFS integration failed after package compilation')
  .some((row) => row.type === 'rootfs-integration-failure'));
assert(parseProbeLog('ERROR: package-enabled firmware failed after baseline success')
  .some((row) => row.type === 'package-firmware-failure'));
const opkgIssues = parseProbeLog('Package alpha wants to install file /etc/example\nBut that file is already provided by package beta.');
assert(opkgIssues.some((row) => row.type === 'rootfs-conflict' && row.manager === 'opkg'));
assert.deepEqual(requestedPackageStates('CONFIG_PACKAGE_alpha=m\nCONFIG_PACKAGE_beta=y\n# CONFIG_PACKAGE_gamma is not set\n',
  ['alpha', 'beta', 'gamma', 'missing']), { alpha: 'm', beta: 'y', gamma: 'n', missing: 'missing' });
const infrastructure = createEvidence({ log: 'No space left on device', runtime: { conclusion: 'fully-incompatible', attempts: [] },
  env: { PROBE_PACKAGES: 'alpha', PROBE_CONCLUSION: 'failure' } });
assert.equal(infrastructure.conclusion, 'infrastructure-failure');
const timedOut = createEvidence({ log: 'Process terminated after timeout',
  runtime: { conclusion: 'fully-incompatible', attempts: [{ result: 'failure', stages: { packageCompile: 'failure' } }] },
  env: { PROBE_PACKAGES: 'alpha', PROBE_CONCLUSION: 'failure' } });
assert.equal(timedOut.conclusion, 'inconclusive');
const environmentFailure = createEvidence({ log: 'make: build environment failed',
  runtime: { conclusion: 'fully-incompatible', attempts: [{ result: 'failure', stages: { environment: 'failure' } }] },
  env: { PROBE_PACKAGES: 'alpha', PROBE_CONCLUSION: 'failure' } });
assert.equal(environmentFailure.conclusion, 'inconclusive');
const recovered = createEvidence({ log: '', runtime: { conclusion: 'sampled-compatible',
  attempts: [{ result: 'success', stages: { packageCompile: 'success' },
    serialRetries: [{ label: 'package:alpha', result: 'recovered' }] }] },
  env: { PROBE_PACKAGES: 'alpha', PROBE_CONCLUSION: 'success' } });
assert(evidenceSummaryLines(recovered).some((line) =>
  line.includes('Serial recovery / 串行复核恢复') && line.includes('package:alpha')));
const coverageRow = (target, result, issue = { type: 'package-build-failure' }) => ({
  source: 'Source', branch: 'branch', target, mode: 'package-compile', packages: ['package'],
  coverage: { requested: 2, attempted: 1 }, attempts: [{ target, result, stages: { packageCompile: result } }],
  issues: issue ? [issue] : [],
});
assert.equal(aggregateScopeConclusions([
  coverageRow('target/a', 'failure'), coverageRow('target/b', 'failure'),
])[0].conclusion, 'fully-incompatible');
assert.equal(aggregateScopeConclusions([coverageRow('target/a', 'failure')])[0].conclusion, 'sampled-incompatible');
assert.equal(aggregateScopeConclusions([
  coverageRow('target/a', 'failure'), coverageRow('target/b', 'failure', { type: 'timeout' }),
])[0].conclusion, 'inconclusive');
assert.equal(aggregateScopeConclusions([
  coverageRow('target/a', 'success', null), coverageRow('target/b', 'failure'),
])[0].conclusion, 'partially-compatible');

const lede = config.sources.find((source) => source.id === 'lede');
assert(sourceAllowsBranch(lede, 'master'));
for (const version of ['openwrt-27.01', 'openwrt-28.12', 'openwrt-29.10', 'openwrt-30.01']) {
  assert(sourceAllowsBranch(lede, version), `lede future branch was not discovered: ${version}`);
}

assert(!workflow.includes('\n  issues:\n') && !controller.includes('WEIG_PACKAGE_PROBE_REQUEST_V1'));
assert(gatewayWorkflow.includes('\n  issues:\n') && gatewayWorkflow.includes('\n  issue_comment:\n') &&
  gatewayWorkflow.includes('node scripts/package-probe-issue.mjs'));
assert(gatewayWorkflow.includes('actions: write') && gatewayWorkflow.includes('issues: write') &&
  gatewayWorkflow.includes('runs-on: ubuntu-24.04'));
assert(issueForm.includes('type: upload') && issueForm.includes('probe-request.json') && issueForm.includes('`/cancel`'));
assert(workflow.includes('permissions: {}') && workflow.includes('issues: write'));
assert(workflow.includes('PROBE_ISSUE_NUMBER: ${{ inputs.issue_number }}') &&
  workflow.includes('PROBE_REQUEST_SHA256: ${{ inputs.request_sha256 }}') &&
  workflow.includes("inputs.issue_number != ''"));
assert(workflow.includes('matrix: ${{ fromJSON(needs.plan.outputs.matrix) }}'));
assert(workflow.includes('max-parallel: ${{ fromJSON(needs.plan.outputs.max_parallel) }}'));
assert(workflow.includes('node scripts/run-package-probe.mjs') && runner.includes('package/install'));
assert(workflow.includes('timeout-minutes: ${{ fromJSON(needs.plan.outputs.timeout_minutes) }}') &&
  policy.probe.timeoutMinutes === 360 &&
  Object.values(policy.probe.modeTimeoutMinutes).every((minutes) => minutes === 360),
  'every probe depth must use the maximum GitHub-hosted job duration');
assert(!workflow.includes('PROBE_JOBS: 2') && runner.includes("from 'node:os'") &&
  runner.includes('availableParallelism() + 1'),
  'probe Make concurrency must adapt to the runner CPU quota');
assert(catalogWorkflow.includes('!scripts/run-package-probe.mjs') &&
  catalogWorkflow.includes('!scripts/package-probe-*.mjs') &&
  catalogWorkflow.includes('!scripts/write-package-probe-evidence.mjs'),
  'probe-only implementation changes must not rebuild the complete Catalog matrix');
assert((runner.match(/makeWithSerialRetry\(/g) || []).length >= 6 &&
  runner.includes("await make(['defconfig'], false)") && runner.includes("await make(['dirclean'], false)") &&
  runner.includes("await make(['clean'], false)"),
  'expensive builds must retry serially while Kconfig and cleanup remain serial');
assert(workflow.includes('python3 python3-setuptools') && !workflow.includes('python3-distutils'),
  'probe runner must use the Ubuntu 24.04 Python build dependency contract');
assert(runner.includes("if (!existsSync(LOG_FILE)) writeFileSync(LOG_FILE, '')") &&
  (workflow.match(/tee -a "\$PROBE_LOG"/g) || []).length >= 4,
  'complete probe log does not preserve dependency, clone, feeds, build, and boot stages');
assert(workflow.includes('write-package-probe-evidence.mjs --aggregate'));
assert(!workflow.includes('[[ "$PROBE_RESULT" == success ]]') &&
  workflow.includes('the normalized evidence remains authoritative'));
assert(workflow.includes('Package Compatibility Probe / 软件包兼容探针'));
assert(!workflow.includes('package-probe-child.yml') && !workflow.includes('/dispatches'));
assert(workflow.includes('retention-days: 60') && workflow.includes('retention-days: 30'));
assert.equal(policy.probe.collaboratorMaxParallel, 3);
assert.equal(policy.probe.maxMatrixJobs, 256);
assert.equal(policy.probe.normalizedEvidenceDays, 60);
assert.equal(policy.probe.fullLogDays, 30);
assert.deepEqual(policy.probe.reductionMaxAttempts, {
  'package-compile': 8, 'rootfs-integration': 4, 'firmware-integration': 2, 'boot-smoke': 0,
});
assert(runner.includes('async function reduceFailureSet') && runner.includes('candidateMinimalFailureSet') &&
  runner.includes('PROBE_REDUCTION_BUDGET'), 'bounded multi-package failure reduction is missing');
assert.deepEqual(probeUi.languages, ['en', 'zh-CN', 'zh-TW']);
for (const key of [
  'title', 'intro', 'howTo', 'search', 'selected', 'depth', 'scope', 'targets',
  'allSources', 'currentSource', 'customScope', 'autoTarget', 'currentTarget', 'allTargets',
  'packageCompile', 'packageCompileHelp', 'rootfsIntegration', 'rootfsIntegrationHelp',
  'firmwareIntegration', 'firmwareIntegrationHelp', 'bootSmoke', 'bootSmokeHelp',
  'preview', 'submit', 'downloadedRequest', 'uploadInstruction', 'cancelInstruction',
  'permission', 'retention', 'planOnly', 'issueTitle', 'loading', 'empty', 'invalid',
]) {
  assert(probeUi.strings[key]?.en && probeUi.strings[key]?.['zh-CN'], `missing probe UI translation: ${key}`);
}
assert.equal(probeUi.strings.bootSmoke['zh-CN'], '启动自检');

console.log('package probe checks passed');

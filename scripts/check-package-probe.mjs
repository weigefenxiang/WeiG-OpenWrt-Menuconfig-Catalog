#!/usr/bin/env node
import assert from 'node:assert/strict';
import { gzipSync } from 'node:zlib';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  attachProbeTargets, createProbePlan, normalizePackageConfig, normalizeProbeMode, normalizeProbeRequest,
  probePlanSummary, probeTargetConfig, resolveProbeTargetConfigs, selectProbeCoverage,
} from './package-probe-controller.mjs';
import { runtimeDataBranchForChannel } from './catalog-channels.mjs';
import { parseProbeStateToken, PROBE_STATE_PREFIX } from './package-probe-state.mjs';
import { isProbeIssue, normalizeGatewayRequest, probeCancellationAuthorized, probeCancellationRequested,
  probeIssueCommand, probeRunMarkers } from './package-probe-gateway.mjs';
import { createEvidence, parseProbeLog } from './write-package-probe-evidence.mjs';
import { sourceAllowsBranch } from './source-policy.mjs';

const ROOT = resolve(import.meta.dirname, '..');
const policy = JSON.parse(readFileSync(resolve(ROOT, '.github', 'automation-policy.json'), 'utf8'));
const config = JSON.parse(readFileSync(resolve(ROOT, 'catalog.config.json'), 'utf8'));
const workflow = readFileSync(resolve(ROOT, '.github', 'workflows', 'package-probe.yml'), 'utf8');
const gatewayWorkflow = readFileSync(resolve(ROOT, '.github', 'workflows', 'package-probe-request.yml'), 'utf8');
const issueForm = readFileSync(resolve(ROOT, '.github', 'ISSUE_TEMPLATE', 'package-probe.yml'), 'utf8');
const catalogWorkflow = readFileSync(resolve(ROOT, '.github', 'workflows', 'catalog.yml'), 'utf8');
const controller = readFileSync(resolve(ROOT, 'scripts', 'package-probe-controller.mjs'), 'utf8');
const issueGateway = readFileSync(resolve(ROOT, 'scripts', 'package-probe-gateway.mjs'), 'utf8');
const runner = readFileSync(resolve(ROOT, 'scripts', 'run-package-probe.mjs'), 'utf8');
const evidenceWriter = readFileSync(resolve(ROOT, 'scripts', 'write-package-probe-evidence.mjs'), 'utf8');
const probeUi = JSON.parse(readFileSync(resolve(ROOT, 'translations', 'probe-ui.json'), 'utf8'));
assert.equal(probeUi.strings?.configResolve?.['zh-CN'], '官方配置求解');
assert.equal(probeUi.strings?.environmentLimit?.en, 'Probe environments');
assert.match(probeUi.strings?.sourceExcluded?.en || '', /hanwckf/);

const baselinePackageConfig = 'CONFIG_PACKAGE_oscam=y\n';
const packageConfig = [
  'CONFIG_PACKAGE_oscam=y',
  'CONFIG_PACKAGE_luci-app-oscam=y',
  'CONFIG_PACKAGE_libexample=m',
].join('\n') + '\n';
const baseRequest = {
  schema: 3, channel: 'dev', mode: 'config-resolve', useDefconfig: true,
  baselinePackageConfig, packageConfig,
  packageIntent: [{ package: 'luci-app-oscam', before: 'n', after: 'y' }],
  environmentScope: { sources: ['*'], branches: ['*'], targetSystems: ['*'], subtargets: ['*'], profiles: ['*'] },
  coverage: { mode: 'auto', limit: 40 }, maxParallel: 0, execute: true,
};
const index = { schema: 2, sources: [
  { id: 'ImmortalWrt', label: 'ImmortalWrt', repo: 'example/immortal', branches: [
    { branch: 'master', commit: 'a'.repeat(40), state: 'fresh', assets: { core: { asset: 'imm-master.core.json.gz', hash: 'a'.repeat(64) } } },
    { branch: 'openwrt-30.01', commit: 'b'.repeat(40), state: 'fresh', assets: { core: { asset: 'imm-30.core.json.gz', hash: 'b'.repeat(64) } } },
    { branch: 'broken', commit: 'c'.repeat(40), state: 'unavailable' },
  ] },
  { id: 'OpenWrt', label: 'OpenWrt', repo: 'example/openwrt', branches: [
    { branch: 'main', commit: 'd'.repeat(40), state: 'fresh', assets: { core: { asset: 'ow-main.core.json.gz', hash: 'd'.repeat(64) } } },
  ] },
  { id: 'hanwckf', label: 'hanwckf mt798x', repo: 'example/hanwckf', branches: [
    { branch: 'master', commit: 'e'.repeat(40), state: 'fresh', assets: { core: { asset: 'hanwckf.core.json.gz', hash: 'e'.repeat(64) } } },
  ] },
] };

assert.equal(runtimeDataBranchForChannel('dev'), 'catalog-dev');
assert.equal(runtimeDataBranchForChannel('fix-probe'), 'catalog-fix-probe');
assert.equal(normalizeProbeMode('config-resolve'), 'config-resolve');
assert.equal(normalizeProbeMode('compile'), 'package-compile');
assert.equal(normalizeProbeMode('co-install'), 'rootfs-integration');
assert.throws(() => normalizeProbeMode('plugin-special-case'), /unsupported probe mode/);

const finalState = normalizePackageConfig(packageConfig);
assert.deepEqual(finalState.packages, ['oscam', 'luci-app-oscam', 'libexample']);
assert.equal(normalizePackageConfig('', 131072, { allowEmpty: true }).packages.length, 0);
assert.throws(() => normalizePackageConfig('CONFIG_PACKAGE_bad=z\n'), /invalid packageConfig/);
assert.throws(() => normalizePackageConfig('CONFIG_PACKAGE_alpha=m\nCONFIG_PACKAGE_alpha=y\n'), /conflicting package state/);

const request = normalizeProbeRequest(baseRequest);
assert.equal(request.schema, 3);
assert.deepEqual(request.roots, ['luci-app-oscam']);
assert.equal(request.packages.length, 1);
assert.equal(request.packageConfig, 'CONFIG_PACKAGE_luci-app-oscam=y\n');
assert.equal(request.baselinePackageConfig, '');
assert.equal(request.useDefconfig, true);
assert.equal(normalizeProbeRequest({ ...baseRequest, useDefconfig: false }).useDefconfig, true);
assert.throws(() => normalizeProbeRequest({ ...baseRequest, schema: 2 }), /schema 3/);
assert.throws(() => normalizeProbeRequest({ ...baseRequest, scope: {} }), /unknown keys: scope/);
assert.throws(() => normalizeProbeRequest({ ...baseRequest, packageIntent: [{ package: 'oscam', before: 'n', after: 'y' }] }), /baseline mismatch/);
assert.throws(() => normalizeProbeRequest({ ...baseRequest, environmentScope: { ...baseRequest.environmentScope, sources: ['*', 'OpenWrt'] } }), /wildcard cannot be mixed/);
assert.deepEqual(normalizeProbeRequest({ ...baseRequest, coverage: { mode: 'all' } }).coverage, { mode: 'all' });
assert.throws(() => normalizeProbeRequest({ ...baseRequest, coverage: { mode: 'auto', limit: 257 } }), /1 to 256/);

const gatewayRequest = normalizeGatewayRequest(baseRequest);
assert.deepEqual(gatewayRequest.roots, ['luci-app-oscam']);
assert.equal(gatewayRequest.finalPackageCount, 1);
assert.equal(gatewayRequest.useDefconfig, true);

const token = PROBE_STATE_PREFIX + gzipSync(Buffer.from(JSON.stringify(baseRequest))).toString('base64url');
const parsed = parseProbeStateToken(`state\n${token}\n`);
assert.deepEqual(parsed.raw, baseRequest);
assert.match(parsed.sha256, /^[a-f0-9]{64}$/);
assert.throws(() => parseProbeStateToken('WEIG_PACKAGE_PROBE_STATE_V2:abc'), /schema has changed/);
assert.throws(() => parseProbeStateToken(`${token}\n${token}`), /exactly one/);

assert(isProbeIssue({ title: '[probe] package' }));
assert.equal(probeIssueCommand(' /CANCEL\n'), 'cancel');
assert(probeCancellationAuthorized({ requester: 'Author', commenter: 'author', permission: 'read' }));
assert(probeCancellationAuthorized({ requester: 'author', commenter: 'helper', permission: 'write' }));
assert(!probeCancellationAuthorized({ requester: 'author', commenter: 'reader', permission: 'read' }));
const marker = `<!-- WEIG_PACKAGE_PROBE_RUN_V3 run=123 sha=${'a'.repeat(64)} batch=2 -->`;
assert.deepEqual(probeRunMarkers([{ body: marker }, { body: marker }]), [{ runId: 123, sha256: 'a'.repeat(64), batchIndex: 2 }]);
assert(probeCancellationRequested([{ body: '<!-- WEIG_PACKAGE_PROBE_CANCEL_V1 -->' }]));

function target(id, board, subtarget, profileId = 'DEVICE_generic') {
  const selectorStem = `TARGET_${board}_${subtarget}`;
  return { id, board, systemName: board, subtarget, subtargetLabel: subtarget, targetSelector: selectorStem,
    contract: { selectable: true, boardSelector: `TARGET_${board}`, targetSelector: selectorStem },
    profiles: [{ id: profileId, name: profileId === 'DEVICE_generic' ? 'Generic' : profileId,
      selector: `${selectorStem}_${profileId}`, boardSelector: `TARGET_${board}`, targetSelector: selectorStem, selectable: true }] };
}
const core = { schema: 6, targets: [target('x86/64', 'x86', '64'), target('mediatek/filogic', 'mediatek', 'filogic', 'DEVICE_router')] };
const preferred = probeTargetConfig(core);
assert.equal(preferred.target, 'x86/64');
assert.equal(preferred.profile, 'DEVICE_generic');
assert(preferred.config.includes('CONFIG_TARGET_x86_64_DEVICE_generic=y'));
const filtered = resolveProbeTargetConfigs(core, { mode: 'config-resolve', environmentScope: {
  sources: ['*'], branches: ['*'], targetSystems: ['mediatek'], subtargets: ['filogic'], profiles: ['*'],
} });
assert.equal(filtered.rows.length, 1);
assert.equal(filtered.rows[0].targetSystem, 'mediatek');
assert.equal(filtered.rows[0].subtarget, 'filogic');
assert.equal(resolveProbeTargetConfigs(core, { mode: 'boot-smoke', bootTargetPatterns: ['x86/64'], environmentScope: baseRequest.environmentScope }).rows.length, 1);

const legacy = { schema: 6, targets: [target('x86/64', 'x86', '64', 'Generic')] };
const mapped = resolveProbeTargetConfigs(legacy, { mode: 'config-resolve', selections: [{ target: 'x86/64', profile: 'DEVICE_generic' }] });
assert.equal(mapped.rows[0].profile, 'Generic');
assert.equal(mapped.mappings[0].reason, 'unique-selectable-profile');

const preliminary = createProbePlan({ index, policy, request, env: {
  REPOSITORY_OWNER: 'owner', GITHUB_ACTOR: 'owner', PROBE_AUTHORIZATION: 'admin', PROBE_AUTHORIZED: 'true', PROBE_BATCH_INDEX: '0',
} });
assert.equal(preliminary.matrix.include.length, 3);
assert.deepEqual(preliminary.requested, ['luci-app-oscam']);
assert.equal(preliminary.useDefconfig, true);
const cores = new Map([['master', core], ['openwrt-30.01', core], ['main', core]]);
const plan = await attachProbeTargets(preliminary, { policy, dataRef: 'f'.repeat(40), runId: '100', loadCore: async (row) => cores.get(row.branch) });
assert.equal(plan.coverage.total, 6);
assert.equal(plan.coverage.planned, 6, 'Auto must run all candidates when total <= limit');
assert.equal(plan.coverage.sampled, false);
assert.equal(plan.matrix.include.length, 3, 'L1 groups environments by Source/Branch to reuse checkout and feeds');
assert.equal(plan.matrix.include.reduce((sum, row) => sum + row.environmentCount, 0), 6);
assert.equal(plan.dataCommit, 'f'.repeat(40));
assert.match(probePlanSummary(plan), /Defconfig: `on`/);

const manyRows = [];
for (const source of ['A', 'B', 'C', 'D']) for (let branch = 0; branch < 5; branch++) for (let profile = 0; profile < 5; profile++) {
  manyRows.push({ source, branch: `b${branch}`, targetSystem: profile % 2 ? 'x86' : 'mediatek', subtarget: profile % 2 ? '64' : 'filogic', profile: `p${profile}`, target: `t${profile}` });
}
const scopeAll = { sources: ['*'], branches: ['*'], targetSystems: ['*'], subtargets: ['*'], profiles: ['*'] };
const sampleA = selectProbeCoverage(manyRows, { coverage: { mode: 'auto', limit: 20 }, environmentScope: scopeAll, samplingSeed: 'seed-a' });
const sampleAgain = selectProbeCoverage(manyRows, { coverage: { mode: 'auto', limit: 20 }, environmentScope: scopeAll, samplingSeed: 'seed-a' });
const sampleB = selectProbeCoverage(manyRows, { coverage: { mode: 'auto', limit: 20 }, environmentScope: scopeAll, samplingSeed: 'seed-b' });
assert.equal(sampleA.length, 20);
assert.deepEqual(sampleA, sampleAgain, 'same seed must reproduce the same Auto sample');
assert.notDeepEqual(sampleA, sampleB, 'new run seed should rotate the sample');
assert.equal(new Set(sampleA.map((row) => row.source)).size, 4, 'Auto must preserve Source breadth before filling the budget');

const apkIssues = parseProbeLog('ERROR: luci-app-openvpn-server-3.0-r0: trying to overwrite etc/config/openvpn owned by openvpn-openssl-2.7.4-r3.\n' +
  'ERROR: Final package-enabled firmware failed after Baseline success\n');
assert(apkIssues.some((row) => row.type === 'rootfs-conflict' && row.path === '/etc/config/openvpn'));
assert(apkIssues.some((row) => row.type === 'package-firmware-failure'));
const infrastructure = createEvidence({ log: 'No space left on device', runtime: { conclusion: 'incompatible', attempts: [] },
  env: { PROBE_ROOTS: 'alpha', PROBE_CONCLUSION: 'failure' } });
assert.equal(infrastructure.conclusion, 'inconclusive');

const lede = config.sources.find((source) => source.id === 'lede');
for (const version of ['master', 'openwrt-27.01', 'openwrt-30.01']) assert(sourceAllowsBranch(lede, version));

assert(gatewayWorkflow.includes('\n  issues:\n') && gatewayWorkflow.includes('\n  issue_comment:\n') && gatewayWorkflow.includes('node scripts/package-probe-gateway.mjs'));
assert(issueForm.includes('id: state') && !issueForm.includes('type: upload') && issueForm.includes('`/cancel`'));
for (const input of ['baseline_package_config:', 'roots:', 'use_defconfig:', 'target_system:', 'subtarget:', 'target_profile:', 'coverage_mode:', 'batch_index:', 'sampling_seed:', 'data_commit:']) assert(workflow.includes(input), `workflow missing ${input}`);
assert(workflow.includes('actions: write') && workflow.includes('WEIG_PACKAGE_PROBE_BATCH_V3'));
assert(workflow.includes('PROBE_TARGET_BATCH') && workflow.includes('config-resolve'));
assert(controller.includes("toLowerCase() !== 'hanwckf'"));
assert(runner.includes("SOURCE.toLowerCase() === 'hanwckf'") && runner.includes("make(['scripts/config/conf']"));
assert(runner.includes("join(ROOT, 'scripts', 'prepare-metadata.sh')") && runner.includes("'metadata-only'"),
  'L1 Probe must reuse the shared metadata-only prerequisite boundary');
assert(runner.indexOf("join(ROOT, 'scripts', 'prepare-metadata.sh')") < runner.indexOf("make(['scripts/config/conf']"),
  'L1 Probe must prepare reusable metadata before compiling the Kconfig resolver');
assert(runner.includes("if (results.includes('inconclusive')) overallResult = 'inconclusive';") &&
  runner.includes("else if (results.includes('incompatible')) overallResult = 'incompatible';"),
  'L1 Probe must let infrastructure errors dominate business incompatibility');
assert(runner.includes("process.exitCode = attempts.every((row) => ['compatible', 'incompatible', 'skipped'].includes(row.result)) ? 0 : 1;"),
  'Probe process status must accept only known conclusive/skipped results and fail runtime/unknown results');
assert(runner.includes("return reason === 'root-kconfig-rejected' ? 'incompatible' : 'inconclusive';"),
  'failed config execution must remain inconclusive unless upstream Kconfig conclusively rejects the root');
assert(workflow.includes('const comments = await github.paginate(') && !workflow.includes('const { data: comments } = await github.paginate('),
  'Probe summary must treat github.paginate() as the returned comments array');
assert(controller.includes('environmentScope') && controller.includes('selectProbeCoverage') && !controller.includes('maxAutoTargetAttempts'));
assert(!issueGateway.includes('WEIG_PACKAGE_PROBE_RUN_V2') && issueGateway.includes('WEIG_PACKAGE_PROBE_RUN_V3'));
assert(!existsSync(resolve(ROOT, 'scripts', 'package-probe-issue.mjs')));
assert(runner.includes('Source-Makefile:') || runner.includes('Source-Makefile'));
assert(runner.includes('tmp/.packageinfo') || runner.includes("'tmp', '.packageinfo'"));
assert(runner.includes('const compiled = await makeWithSerialRetry(resolved.targets'));
assert(!runner.includes('for (const packageName of activePackages)'));
assert(!runner.includes('reduceFailureSet') && !runner.includes('PROBE_REDUCTION_BUDGET') && !runner.includes('PROBE_FALLBACK_TARGETS'));
assert(runner.includes("['package/install']"));
assert(runner.includes("prepareConfig(BASELINE_STATES") && runner.includes("prepareConfig(FINAL_STATES"));
assert(runner.includes('BUILD_LOG=1'));
assert(evidenceWriter.includes('sampled-incompatible') && evidenceWriter.includes('fully-incompatible') && evidenceWriter.includes('partially-compatible'));
assert.equal(policy.probe.maxMatrixJobs, 256);
assert.deepEqual(policy.probe.autoCoverageLimits, { 'package-compile': 200, 'rootfs-integration': 100, 'firmware-integration': 30, 'boot-smoke': 10, 'config-resolve': 40 });
assert(!('maxAutoTargetAttempts' in policy.probe) && !('reductionMaxAttempts' in policy.probe));
for (const key of ['howTo', 'submittedState', 'stateInstruction', 'invalid']) assert(probeUi.strings[key]?.en && probeUi.strings[key]?.['zh-CN']);
assert(catalogWorkflow.includes('scripts/catalog-change-impact.mjs'));

console.log('Package Probe V3 contracts passed.');

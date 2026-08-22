#!/usr/bin/env node
import assert from 'node:assert/strict';
import { gzipSync } from 'node:zlib';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  attachProbeTargets, createProbePlan, normalizePackageConfig, normalizeProbeMode, normalizeProbeRequest,
  probePlanSummary, probeTargetConfig, PROBE_COVERAGE_LIMITS, resolveProbeTargetConfigs, selectProbeCoverage,
} from './package-probe-controller.mjs';
import { runtimeDataBranchForChannel } from './catalog-channels.mjs';
import { parseProbeStateToken, PROBE_STATE_PREFIX } from './package-probe-state.mjs';
import { isProbeIssue, normalizeGatewayRequest, probeCancellationAuthorized, probeCancellationRequested,
  probeDisplayContext, probeIssueCommand, probeRunMarkers } from './package-probe-gateway.mjs';
import { aggregateScopeConclusions, createEvidence, parseProbeLog } from './write-package-probe-evidence.mjs';
import { sourceAllowsBranch } from './source-policy.mjs';
import { buildCuratedApplications } from './curated-applications.mjs';

const ROOT = resolve(import.meta.dirname, '..');
const policy = JSON.parse(readFileSync(resolve(ROOT, '.github', 'automation-policy.json'), 'utf8'));
const config = JSON.parse(readFileSync(resolve(ROOT, 'catalog.config.json'), 'utf8'));
const workflow = readFileSync(resolve(ROOT, '.github', 'workflows', 'package-probe.yml'), 'utf8');
const gatewayWorkflow = readFileSync(resolve(ROOT, '.github', 'workflows', 'package-probe-request.yml'), 'utf8');
const issueForm = readFileSync(resolve(ROOT, '.github', 'ISSUE_TEMPLATE', 'package-probe.yml'), 'utf8');
const catalogWorkflow = readFileSync(resolve(ROOT, '.github', 'workflows', 'catalog.yml'), 'utf8');
const compatibilityDoc = readFileSync(resolve(ROOT, 'docs', 'COMPATIBILITY.md'), 'utf8');
const controller = readFileSync(resolve(ROOT, 'scripts', 'package-probe-controller.mjs'), 'utf8');
const issueGateway = readFileSync(resolve(ROOT, 'scripts', 'package-probe-gateway.mjs'), 'utf8');
const runner = readFileSync(resolve(ROOT, 'scripts', 'run-package-probe.mjs'), 'utf8');
const evidenceWriter = readFileSync(resolve(ROOT, 'scripts', 'write-package-probe-evidence.mjs'), 'utf8');
const failureClassification = readFileSync(resolve(ROOT, 'scripts', 'package-probe-failure-classification.mjs'), 'utf8');
const finalizer = readFileSync(resolve(ROOT, 'scripts', 'finalize-package-probe.mjs'), 'utf8');
const probeUi = JSON.parse(readFileSync(resolve(ROOT, 'translations', 'probe-ui.json'), 'utf8'));
assert.equal(probeUi.strings?.configResolve?.['zh-CN'], '官方配置求解');
assert.equal(probeUi.strings?.environmentLimit?.en, 'Probe environments');
assert.match(probeUi.strings?.sourceExcluded?.en || '', /hanwckf/);
const probeDepthUi = [
  ['depth1Short', 'L1 插件', 'configResolve', 'configResolveHelp'],
  ['depth2Short', 'L2 编译', 'packageCompile', 'packageCompileHelp'],
  ['depth3Short', 'L3 根系统', 'rootfsIntegration', 'rootfsIntegrationHelp'],
  ['depth4Short', 'L4 集成', 'firmwareIntegration', 'firmwareIntegrationHelp'],
  ['depth5Short', 'L5 启动', 'bootSmoke', 'bootSmokeHelp'],
  ['depth6Short', 'L6 运行', 'runtimeHealth', 'runtimeHealthHelp'],
  ['depth7Short', 'L7 重启', 'rebootValidation', 'rebootValidationHelp'],
];
for (const obsoleteKey of ['level1', 'l1Intro', 'l1HowTo', 'l1StateInstruction', 'l1Submitted']) {
  assert.equal(obsoleteKey in probeUi.strings, false, `obsolete probe UI key must be removed: ${obsoleteKey}`);
}
for (const [shortKey, shortZh, titleKey, helpKey] of probeDepthUi) {
  assert.equal(probeUi.strings?.[shortKey]?.['zh-CN'], shortZh);
  for (const language of probeUi.languages) {
    assert.match(String(probeUi.strings?.[shortKey]?.[language] || ''), /^L[1-7]\s\S/);
    assert(String(probeUi.strings?.[titleKey]?.[language] || '').trim());
    assert(String(probeUi.strings?.[helpKey]?.[language] || '').trim());
  }
}
assert.match(probeUi.strings.rootfsIntegrationHelp['zh-CN'], /安装进 RootFS/);
assert.match(probeUi.strings.firmwareIntegrationHelp['zh-CN'], /只构建一次完整 Final 固件/);
for (const language of probeUi.languages) {
  assert.doesNotMatch(probeUi.strings.firmwareIntegrationHelp[language], /Baseline|A\/B|基线|基線/i);
}

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
  coverage: { mode: 'auto', limit: 32 }, maxParallel: 0, execute: true,
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
assert.equal(normalizeProbeMode('runtime-health'), 'runtime-health');
assert.equal(normalizeProbeMode('reboot-validation'), 'reboot-validation');
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
assert.equal(request.comparison, null, 'legacy requests must keep A/B disabled');
assert.equal(request.pairedComparison, false);
const pairedRequest = normalizeProbeRequest({ ...baseRequest,
  comparison: { mode: 'paired-exclusion', executionOrder: ['baseline', 'final'] },
});
assert.deepEqual(pairedRequest.comparison, { mode: 'paired-exclusion', executionOrder: ['baseline', 'final'] });
assert.equal(pairedRequest.pairedComparison, true);
assert.throws(() => normalizeProbeRequest({ ...baseRequest, comparison: { mode: 'paired-exclusion', executionOrder: ['final', 'baseline'] } }), /executionOrder/);
assert.throws(() => normalizeProbeRequest({ ...baseRequest, comparison: { mode: 'paired-exclusion', executionOrder: ['baseline', 'final'], extra: true } }), /unknown keys/);
assert.throws(() => normalizeProbeRequest({ ...baseRequest, useDefconfig: false }), /requires upstream defconfig/);
for (const mode of ['config-resolve', 'package-compile', 'rootfs-integration', 'firmware-integration', 'boot-smoke', 'runtime-health', 'reboot-validation']) {
  const depthRequest = normalizeProbeRequest({ ...baseRequest, mode });
  assert.equal(depthRequest.packageConfig, 'CONFIG_PACKAGE_luci-app-oscam=y\n', `${mode} must keep only direct roots`);
  assert.equal(depthRequest.baselinePackageConfig, '', `${mode} must not submit the resolved baseline`);
  assert.deepEqual(depthRequest.packages, ['luci-app-oscam'], `${mode} must not submit automatic dependencies`);
}
const mixedDirectRequest = normalizeProbeRequest({ ...baseRequest, mode: 'package-compile',
  baselinePackageConfig: 'CONFIG_PACKAGE_beta=y\nCONFIG_PACKAGE_automatic-old=m\n',
  packageConfig: 'CONFIG_PACKAGE_alpha=m\nCONFIG_PACKAGE_automatic-new=y\n',
  packageIntent: [
    { package: 'alpha', before: 'n', after: 'm' },
    { package: 'beta', before: 'y', after: 'n' },
  ],
});
assert.equal(mixedDirectRequest.baselinePackageConfig, 'CONFIG_PACKAGE_beta=y\n');
assert.equal(mixedDirectRequest.packageConfig, 'CONFIG_PACKAGE_alpha=m\n');
assert.deepEqual(mixedDirectRequest.packages, ['alpha']);
assert.deepEqual(mixedDirectRequest.packageIntent.map((row) => `${row.package}:${row.before}->${row.after}`),
  ['alpha:n->m', 'beta:y->n'], 'N/M/Y direct intent must survive while automatic packages are discarded');
assert.throws(() => normalizeProbeRequest({ ...baseRequest, schema: 2 }), /schema 3/);
assert.throws(() => normalizeProbeRequest({ ...baseRequest, scope: {} }), /unknown keys: scope/);
assert.throws(() => normalizeProbeRequest({ ...baseRequest, packageIntent: [{ package: 'oscam', before: 'n', after: 'y' }] }), /baseline mismatch/);
assert.throws(() => normalizeProbeRequest({ ...baseRequest, environmentScope: { ...baseRequest.environmentScope, sources: ['*', 'OpenWrt'] } }), /wildcard cannot be mixed/);
assert.deepEqual(normalizeProbeRequest({ ...baseRequest, coverage: { mode: 'all' } }).coverage, { mode: 'all' });
assert.deepEqual(PROBE_COVERAGE_LIMITS, { defaultLimit: 32, maxLimit: 128 });
assert.throws(() => normalizeProbeRequest({ ...baseRequest, coverage: { mode: 'auto', limit: 129 } }), /1 to 128/);

const gatewayRequest = normalizeGatewayRequest(baseRequest);
assert.deepEqual(gatewayRequest.roots, ['luci-app-oscam']);
assert.equal(gatewayRequest.requestedPackageCount, 1);
assert.equal(gatewayRequest.useDefconfig, true);
assert.equal(probeDisplayContext(gatewayRequest, 33), 'luci-app-oscam · #33 · dev');
assert.equal(probeDisplayContext({ ...gatewayRequest, roots: ['alpha', 'beta', 'gamma'] }, 34), 'alpha +2 · #34 · dev');

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
assert.equal(resolveProbeTargetConfigs(core, { mode: 'runtime-health', bootTargetPatterns: ['x86/64'], environmentScope: baseRequest.environmentScope }).rows.length, 1);
assert.equal(resolveProbeTargetConfigs(core, { mode: 'reboot-validation', bootTargetPatterns: ['x86/64'], environmentScope: baseRequest.environmentScope }).rows.length, 1);

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

const scopeAll = { sources: ['*'], branches: ['*'], targetSystems: ['*'], subtargets: ['*'], profiles: ['*'] };
const priorityRows = selectProbeCoverage([
  { source: 'OpenWrt', branch: 'main', targetSystem: 'x86', subtarget: '64', profile: 'generic', target: 'x86/64' },
  { source: 'lede', branch: 'master', targetSystem: 'x86', subtarget: '64', profile: 'generic', target: 'x86/64' },
  { source: 'ImmortalWrt', branch: 'master', targetSystem: 'x86', subtarget: '64', profile: 'generic', target: 'x86/64' },
], { coverage: { mode: 'all' }, environmentScope: scopeAll, samplingSeed: 'priority' });
assert.deepEqual(priorityRows.map((row) => row.source), ['ImmortalWrt', 'lede', 'OpenWrt'],
  'Probe Matrix must use the soft Source priority ImmortalWrt -> lede -> OpenWrt');

const manyRows = [];
for (const source of ['A', 'B', 'C', 'D']) for (let branch = 0; branch < 5; branch++) for (let profile = 0; profile < 5; profile++) {
  manyRows.push({ source, branch: `b${branch}`, targetSystem: profile % 2 ? 'x86' : 'mediatek', subtarget: profile % 2 ? '64' : 'filogic', profile: `p${profile}`, target: `t${profile}` });
}
const sampleA = selectProbeCoverage(manyRows, { coverage: { mode: 'auto', limit: 20 }, environmentScope: scopeAll, samplingSeed: 'seed-a' });
const sampleAgain = selectProbeCoverage(manyRows, { coverage: { mode: 'auto', limit: 20 }, environmentScope: scopeAll, samplingSeed: 'seed-a' });
const sampleB = selectProbeCoverage(manyRows, { coverage: { mode: 'auto', limit: 20 }, environmentScope: scopeAll, samplingSeed: 'seed-b' });
assert.equal(sampleA.length, 20);
assert.deepEqual(sampleA, sampleAgain, 'same seed must reproduce the same Auto sample');
assert.notDeepEqual(sampleA, sampleB, 'new run seed should rotate the sample');
assert.equal(new Set(sampleA.map((row) => row.source)).size, 4, 'Auto must preserve Source breadth before filling the budget');
const overLimitRows = Array.from({ length: 129 }, (_, index) => ({
  source: `s${index}`, branch: 'main', targetSystem: 'x86', subtarget: '64', profile: 'generic', target: `t${index}`,
}));
assert.throws(() => selectProbeCoverage(overLimitRows, { coverage: { mode: 'all' }, environmentScope: scopeAll, samplingSeed: 'all' }),
  /narrow the scope to at most 128/, 'Exhaustive coverage must preserve real leaves rather than silently truncate beyond the hard limit');

const apkIssues = parseProbeLog('ERROR: luci-app-openvpn-server-3.0-r0: trying to overwrite etc/config/openvpn owned by openvpn-openssl-2.7.4-r3.\n' +
  'ERROR: Final package-enabled firmware failed\n');
assert(apkIssues.some((row) => row.type === 'rootfs-conflict' && row.path === '/etc/config/openvpn'));
assert(apkIssues.some((row) => row.type === 'package-firmware-failure'));
const infrastructure = createEvidence({ log: 'No space left on device', runtime: { conclusion: 'incompatible', attempts: [] },
  env: { PROBE_ROOTS: 'alpha', PROBE_CONCLUSION: 'failure' } });
assert.equal(infrastructure.conclusion, 'inconclusive');

const packageUnavailableEvidence = createEvidence({
  log: 'SKIP: Probe root package unavailable in Source/Branch: alpha',
  runtime: { roots: ['alpha'], conclusion: 'skipped', attempts: [{
    result: 'skipped', reason: 'root-absent-source', unavailableRoots: ['alpha'], rejectedRoots: ['alpha'],
  }] },
  env: { PROBE_ROOTS: 'alpha', PROBE_CONCLUSION: 'success' },
});
assert.equal(packageUnavailableEvidence.conclusion, 'skipped');
assert(packageUnavailableEvidence.issues.some((row) => row.type === 'not-applicable' && row.roots.includes('alpha')));
assert.equal(packageUnavailableEvidence.issues.some((row) => row.type === 'package-unavailable'), false,
  'a source-absent package must not retain the legacy package-unavailable evidence type');
assert.equal(packageUnavailableEvidence.issues.some((row) => row.type === 'kconfig-unsatisfied'), false,
  'a source-absent package must not be reported as a generic Kconfig rejection');

const kconfigEvidence = createEvidence({
  runtime: { roots: ['alpha'], conclusion: 'incompatible', attempts: [{
    result: 'incompatible', reason: 'kconfig-unsatisfied', rejectedRoots: ['alpha'],
  }] },
  env: { PROBE_ROOTS: 'alpha', PROBE_CONCLUSION: 'success' },
});
assert.equal(kconfigEvidence.conclusion, 'incompatible');
assert(kconfigEvidence.issues.some((row) => row.type === 'kconfig-unsatisfied' && row.roots.includes('alpha')));

const attributionScopes = aggregateScopeConclusions([
  { source: 'ImmortalWrt', branch: 'master', conclusion: 'incompatible', reason: 'package-compile-failure', roots: ['alpha'], issues: [] },
  { source: 'ImmortalWrt', branch: 'openwrt-24.10', conclusion: 'incompatible', reason: 'package-compile-failure', roots: ['alpha'], issues: [] },
  { source: 'OpenWrt', branch: 'main', conclusion: 'skipped', reason: 'root-absent-source', roots: ['alpha'], issues: [{ type: 'not-applicable', roots: ['alpha'] }], unavailableRoots: ['alpha'] },
  { source: 'lede', branch: 'master', conclusion: 'inconclusive', reason: 'package-compile-prerequisite-failure', roots: ['alpha'], issues: [] },
], { depth: 1, exhaustive: true });
const immortalAttribution = attributionScopes.find((row) => row.source === 'ImmortalWrt');
const openwrtAttribution = attributionScopes.find((row) => row.source === 'OpenWrt');
const ledeAttribution = attributionScopes.find((row) => row.source === 'lede');
assert.equal(immortalAttribution.selectedPackagePrimaryFailures, 2);
assert.equal(immortalAttribution.selectedPackagePrimaryRate, 1);
assert.equal(immortalAttribution.selectedPackagePrimaryCause, 'compile/link');
assert.equal(openwrtAttribution.selectedPackagePrimaryFailures, 0);
assert.equal(openwrtAttribution.selectedPackagePrimaryCause, '—');
assert.equal(openwrtAttribution.skipped, 1);
assert.equal(ledeAttribution.selectedPackagePrimaryFailures, 0);
assert.equal(ledeAttribution.selectedPackagePrimaryCause, '—');

const lede = config.sources.find((source) => source.id === 'lede');
for (const version of ['master', 'openwrt-27.01', 'openwrt-30.01']) assert(sourceAllowsBranch(lede, version));

assert(gatewayWorkflow.includes('\n  issues:\n') && gatewayWorkflow.includes('\n  issue_comment:\n') && gatewayWorkflow.includes('node scripts/package-probe-gateway.mjs'));
assert(issueForm.includes('id: state') && !issueForm.includes('type: upload') && issueForm.includes('`/cancel`'));
for (const input of ['baseline_package_config:', 'roots:', 'target_system:', 'subtarget:', 'target_profile:', 'coverage_mode:', 'display_context:', 'batch_index:', 'sampling_seed:', 'data_commit:']) assert(workflow.includes(input), `workflow missing ${input}`);
const workflowInputs = workflow.slice(workflow.indexOf('workflow_dispatch:'), workflow.indexOf('\npermissions:'));
assert(!/\n\s+use_defconfig:/.test(workflowInputs), 'Defconfig must not remain a manual Probe switch');
for (const [mode, level] of [['config-resolve', 'L1'], ['package-compile', 'L2'], ['rootfs-integration', 'L3'], ['firmware-integration', 'L4'], ['boot-smoke', 'L5'], ['runtime-health', 'L6'], ['reboot-validation', 'L7']]) {
  assert(workflow.includes(`inputs.mode == '${mode}' && '${level}'`), `run name must map ${mode} to ${level}`);
}
assert(workflow.includes("|| 'L?'"), 'run name must not silently label an unknown mode as a valid Probe level');
assert(workflow.includes("format('[probe · {0}] {1}',"), 'Issue run name must prefix the display-only Gateway context with the Probe level');
assert(!workflow.includes("format('[probe] {0}', inputs.display_context)"), 'legacy run-name prefix must not return');
assert(workflow.includes('DISPLAY_CONTEXT: ${{ inputs.display_context }}') && workflow.includes('display_context: process.env.DISPLAY_CONTEXT'),
  'display-only context must survive continuation batches');
assert(workflow.includes("String(row.display_title || '').includes(`#${issueNumber}`)") && workflow.includes("String(row.display_title || '').includes(`b${next}`)"),
  'continuation lookup must follow the current compact Probe run-name format');
assert(!workflow.includes("finalConclusion !== 'inconclusive'"), 'completed Probe requests must not stay open only because evidence is inconclusive');
assert(workflow.includes("values.some((row) => row === 'incomplete')"),
  'a batch with mixed conclusive and infrastructure results must remain incomplete at final aggregation');
assert(workflow.includes("state: 'closed', state_reason: 'completed'"), 'the final Probe batch must close the Issue after recording its conclusion');
assert(issueGateway.includes('display_context: probeDisplayContext(request, issue.number)'), 'Gateway must supply a display-only run label from the validated request');
assert(issueGateway.includes('mode: request.mode'), 'Gateway dispatch must pass the validated Probe mode so the run-name level remains authoritative');
assert(!controller.includes('display_context'), 'Controller must not consume display-only context as Probe authority');
assert(workflow.includes('actions: write') && workflow.includes('WEIG_PACKAGE_PROBE_BATCH_V3'));
assert(workflow.includes('PROBE_TARGET_BATCH') && workflow.includes('config-resolve'));
assert(controller.includes("toLowerCase() !== 'hanwckf'"));
assert(controller.includes("Object.freeze(['immortalwrt', 'lede', 'openwrt'])") && controller.includes('compareProbeRows'),
  'Probe Matrix must preserve the approved soft Source scheduling priority');
assert(runner.includes("SOURCE.toLowerCase() === 'hanwckf'") && runner.includes("make(['scripts/config/conf']"));
assert(runner.includes("join(ROOT, 'scripts', 'prepare-metadata.sh')") && runner.includes("'metadata-only'"),
  'L1 Probe must reuse the shared metadata-only prerequisite boundary');
assert(runner.indexOf("join(ROOT, 'scripts', 'prepare-metadata.sh')") < runner.indexOf("make(['scripts/config/conf']"),
  'L1 Probe must prepare reusable metadata before compiling the Kconfig resolver');
assert(runner.includes("if (results.includes('inconclusive')) overallResult = 'inconclusive';") &&
  runner.includes("else if (results.includes('incompatible')) overallResult = 'incompatible';"),
  'L1 Probe must let infrastructure errors dominate business incompatibility');
assert(runner.includes("from './package-probe-failure-classification.mjs'") &&
  evidenceWriter.includes("from './package-probe-failure-classification.mjs'"),
  'Runner and Evidence must share one Target prerequisite classification module');
assert(failureClassification.includes('export function isReportedInconclusive(row)') &&
  failureClassification.includes('REPORTED_PREREQUISITE_REASON_SET.has(reason)') &&
  failureClassification.includes('isAllowedTargetPrerequisiteCause(cause)') &&
  failureClassification.includes('export function probeResultExitCode'),
  'Target prerequisite reported inconclusive exit must validate result, reason, and explicit cause allowlist');
assert(runner.includes('process.exitCode = probeResultExitCode(attempts);'),
  'Runner process status must use the shared reported-inconclusive allowlist');
assert(workflow.includes('node scripts/finalize-package-probe.mjs') && finalizer.includes('probeResultExitCode(attempts)'),
  'Finalize must validate structured runtime/evidence conclusions instead of blindly mirroring build outcome');
assert(runner.includes('classifyConfigFailure') && runner.includes("result: 'skipped'") &&
  runner.includes("reason: 'root-absent-source'") && runner.includes("reason: 'kconfig-unsatisfied'") &&
  !runner.includes("reason: 'package-unavailable'") &&
  !runner.includes('direct Probe intent did not survive upstream defconfig'),
  'L2-L7 config attribution must skip missing packages while retaining genuine upstream Kconfig rejection');
assert(runner.includes('classifyPackageBuildFailure') && runner.includes('package-compile-prerequisite-failure') &&
  runner.includes('package-compile-unattributed-failure'),
  'L2-L7 must not promote unrelated or unattributed build failures to selected-package incompatibility');
assert(failureClassification.includes('export function classifyTargetPrerequisiteFailure') && failureClassification.includes('patch-apply') &&
  failureClassification.includes('toolchain-kernel-version') && failureClassification.includes('target-build') && failureClassification.includes('kernel-prerequisite') &&
  !runner.includes('Patch failed') && !evidenceWriter.includes('Patch failed'),
  'Target prerequisite failures must use one generic evidence-based classifier without duplicated cause regexes');
assert(workflow.includes('const comments = await github.paginate(') && !workflow.includes('const { data: comments } = await github.paginate('),
  'Probe summary must treat github.paginate() as the returned comments array');
assert(controller.includes('environmentScope') && controller.includes('selectProbeCoverage') && !controller.includes('maxAutoTargetAttempts'));
assert(!issueGateway.includes('WEIG_PACKAGE_PROBE_RUN_V2') && issueGateway.includes('WEIG_PACKAGE_PROBE_RUN_V3'));
assert(!existsSync(resolve(ROOT, 'scripts', 'package-probe-issue.mjs')));
assert(runner.includes('Source-Makefile:') || runner.includes('Source-Makefile'));
assert(runner.includes('tmp/.packageinfo') || runner.includes("'tmp', '.packageinfo'"));
assert(runner.includes('makeWithSerialRetry(resolved.targets'));
assert(runner.includes("makeWithSerialRetry(['prepare'], 'Target build prerequisites'"),
  'L2 must prepare generic upstream Target/kernel prerequisites before Root compilation');
assert(!runner.includes("makeWithSerialRetry(['tools/install', 'toolchain/install']"),
  'L2 must not use a partial tools/toolchain substitute for the upstream Target preparation boundary');
assert(runner.includes("makeWithSerialRetry(['target/install'], 'final package firmware'"),
  'L4 must extend the completed L3 chain with the upstream firmware integration target');
assert(!runner.includes("makeWithSerialRetry([], 'final package firmware'"),
  'L4-L7 must not restart an independent world build after the earlier Probe stages');
assert(!runner.includes('for (const packageName of activePackages)'));
assert(!runner.includes('reduceFailureSet') && !runner.includes('PROBE_REDUCTION_BUDGET') && !runner.includes('PROBE_FALLBACK_TARGETS'));
assert(runner.includes("['package/install']"));
assert(runner.includes('BASELINE_STATES') && runner.includes('BASELINE_DIRECT_STATES') && runner.includes('resolveProbeConfig') &&
  runner.includes('runDepthPaired') && runner.includes('configResolvePaired'),
  'L1-L7 must share one Target/Profile resolver while supporting optional paired B→A execution');
assert(!runner.includes('PROBE_USE_DEFCONFIG') && !runner.includes('prepare-tmpinfo'),
  'the obsolete Defconfig-off execution branch must be removed');
assert(runner.includes('runVirtualProbe') && !runner.includes('qemu-system-x86_64'),
  'L5-L7 must use the upstream qemustart adapter instead of a Target-specific QEMU command');
assert(runner.includes('deepestPassedLevel') && runner.includes('durationMs'),
  'Probe runtime must preserve selected depth, deepest passed depth, and duration evidence');
assert(runner.includes('BUILD_LOG=1'));
assert(evidenceWriter.includes('sampled-incompatible') && evidenceWriter.includes('fully-incompatible') && evidenceWriter.includes('partially-compatible'));
assert(evidenceWriter.includes('Package-caused rate<br>插件主因率') &&
  evidenceWriter.includes('| Source<br>源码源 | Compatible<br>兼容 | Success rate<br>成功率 | Incompatible<br>不兼容 | Inconclusive<br>待定 |'),
  'Source summary must expose two-line bilingual headers, success rate, and package-caused rate');
assert(evidenceWriter.includes("type: 'target-prerequisite-failure'") &&
  evidenceWriter.includes('Upstream Target/Toolchain prerequisite reported inconclusive / 插件编译前上游 Target/Toolchain 前置失败待定'),
  'Target prerequisite evidence must be structured, excluded from plugin-primary attribution, and visible in Source summary Notes');
assert(compatibilityDoc.includes('reported inconclusive') && compatibilityDoc.includes('operational/unattributed inconclusive') &&
  compatibilityDoc.includes('normalized evidence'),
  'Compatibility policy must document the reported-vs-operational inconclusive double axis');
assert.equal(policy.probe.maxMatrixJobs, 256);
assert.deepEqual(policy.probe.coverage, { defaultLimit: 32, maxLimit: 128 });
assert(!('autoCoverageLimits' in policy.probe) && !('maxAutoCoverage' in policy.probe),
  'obsolete per-depth coverage budgets must not compete with the shared Probe coverage authority');
const applications = buildCuratedApplications(ROOT);
assert.deepEqual(applications.probeUi.coverage, { defaultLimit: 32, maxLimit: 128 },
  'applications.json must publish the same Probe coverage authority to the browser');
assert(controller.includes('PROBE_COVERAGE_DEFAULT_LIMIT') && controller.includes('PROBE_COVERAGE_MAX_LIMIT'));
assert(!controller.includes('coverage limit is required for ${mode} until a measured default is approved'));
assert(!('maxAutoTargetAttempts' in policy.probe) && !('reductionMaxAttempts' in policy.probe));
for (const key of ['howTo', 'submittedState', 'stateInstruction', 'invalid']) assert(probeUi.strings[key]?.en && probeUi.strings[key]?.['zh-CN']);
assert(catalogWorkflow.includes('scripts/catalog-change-impact.mjs'));

console.log('Package Probe V3 contracts passed.');

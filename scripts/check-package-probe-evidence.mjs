#!/usr/bin/env node
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  aggregateEvidence, aggregateRunStatus, aggregateScopeConclusions, createEvidence, evidenceSummaryLines, parseProbeLog,
} from './write-package-probe-evidence.mjs';

const state = (env, count = 0) => aggregateRunStatus(env, count).state;
assert.equal(state({ PLAN_RESULT: 'failure', PROBE_RESULT: 'skipped' }), 'plan-failure');
assert.equal(state({ PLAN_RESULT: 'success', PROBE_RESULT: 'skipped', EXECUTE: 'false', AUTHORIZED: 'true' }), 'plan-only');
assert.equal(state({ PLAN_RESULT: 'success', PROBE_RESULT: 'failure', EXECUTE: 'true', AUTHORIZED: 'true' }, 1), 'execution-collected-with-failures');
assert.equal(state({ PLAN_RESULT: 'success', PROBE_RESULT: 'success', EXECUTE: 'true', AUTHORIZED: 'true' }, 1), 'execution-success');

const row = (source, branch, conclusion) => ({ schema: 4, source, branch, targetSystem: 'x86', subtarget: '64', target: 'x86/64', profile: 'DEVICE_generic',
  roots: ['luci-app-test'], conclusion, issues: [], attempts: [], fingerprint: 'a'.repeat(64) });
assert.equal(aggregateScopeConclusions([row('A', 'main', 'compatible'), row('A', 'main', 'compatible')], { exhaustive: true })[0].conclusion, 'fully-compatible');
assert.equal(aggregateScopeConclusions([row('A', 'main', 'incompatible')], { exhaustive: false })[0].conclusion, 'sampled-incompatible');
assert.equal(aggregateScopeConclusions([row('A', 'main', 'compatible'), row('A', 'main', 'incompatible')], { exhaustive: true })[0].conclusion, 'partially-compatible');
assert.equal(aggregateScopeConclusions([row('A', 'main', 'compatible'), row('A', 'main', 'incompatible'), row('A', 'main', 'inconclusive')], { exhaustive: true })[0].conclusion, 'inconclusive',
  'infrastructure uncertainty must dominate mixed business compatibility results');

const workflow = readFileSync(resolve(import.meta.dirname, '../.github/workflows/package-probe.yml'), 'utf8');
assert(workflow.includes("format('[probe] {0} · #{1} · {2} · {3}'"), 'Issue-triggered run name must expose Probe roots, Issue, channel, and mode');
assert(workflow.includes("inputs.batch_index != '0'"), 'batch suffix must be omitted for the first batch and retained for continuations');
assert(!workflow.includes('Package probe issue #{0} · batch {1}'), 'legacy opaque Issue run name must not return');

const infrastructure = createEvidence({ log: 'No space left on device', runtime: { conclusion: 'incompatible', attempts: [] }, env: { PROBE_ROOTS: 'alpha' } });
assert.equal(infrastructure.conclusion, 'inconclusive');

const hostPrerequisite = createEvidence({
  log: "Checking 'python'... failed.\nBuild dependency: Please install Python 2.x\nPrerequisite check failed. Use FORCE=1 to override.\n",
  runtime: { conclusion: 'incompatible', reason: 'kconfig-resolver-failure', attempts: [] }, env: { PROBE_ROOTS: 'alpha' },
});
assert.equal(hostPrerequisite.conclusion, 'inconclusive');
assert(hostPrerequisite.issues.some((issue) => issue.type === 'infrastructure-failure' && issue.reason === 'host-prerequisite'));
const reasonOnly = createEvidence({ log: '', runtime: { conclusion: 'inconclusive', reason: 'metadata-unresolved', attempts: [] }, env: { PROBE_ROOTS: 'alpha' } });
assert(evidenceSummaryLines(reasonOnly).some((line) => line.includes('metadata-unresolved')), 'evidence summary must expose runtime reason when no normalized issue exists');

const timeoutPackageNames = parseProbeLog([
  'Package: python-async-timeout:',
  'Package: python3-async-timeout:',
  'Package: cttimeout:',
].join('\n'));
assert(!timeoutPackageNames.some((issue) => issue.type === 'timeout'), 'package names containing timeout must not be classified as runner timeout');
assert(parseProbeLog('ERROR: operation timed out after 300 seconds').some((issue) => issue.type === 'timeout'));
const packageNameEvidence = createEvidence({
  log: 'Package: python-async-timeout:\nPackage: cttimeout:\nERROR: package compile failed for Probe roots: alpha\n',
  runtime: { conclusion: 'incompatible', attempts: [] }, env: { PROBE_ROOTS: 'alpha' },
});
assert.equal(packageNameEvidence.conclusion, 'incompatible', 'timeout-like package names must not downgrade a conclusive package failure');

const dir = mkdtempSync(join(tmpdir(), 'probe-evidence-'));
try {
  for (const [i, evidence] of [row('A', 'main', 'incompatible'), row('B', 'main', 'incompatible')].entries()) {
    const sub = join(dir, String(i)); mkdirSync(sub); writeFileSync(join(sub, 'evidence.json'), JSON.stringify(evidence));
  }
  const sampled = aggregateEvidence(dir, { PLAN_RESULT: 'success', PROBE_RESULT: 'failure', EXECUTE: 'true', AUTHORIZED: 'true',
    COVERAGE_TOTAL: '100', COVERAGE_PLANNED: '2', COVERAGE_SAMPLED: 'true', BATCH_COUNT: '1' });
  assert.equal(sampled.overallConclusion, 'sampled-incompatible');
  assert.equal(sampled.overallResult, 'FAIL (sampled)');
  assert.equal(sampled.summaryScopes.length, 2, 'Source summary must always retain one top-level row per source');
  assert(sampled.lines.some((line) => line.includes('| A | **FAIL (sampled)** | **0%** | 0/1 | 0 | 0 |')), 'sampled 0% source must be explicit without claiming full incompatibility');
  assert(sampled.lines.some((line) => line.includes('Probe roots / 测试入口: `luci-app-test`')), 'summary must expose the probed package/root');
  const full = aggregateEvidence(dir, { PLAN_RESULT: 'success', PROBE_RESULT: 'failure', EXECUTE: 'true', AUTHORIZED: 'true',
    COVERAGE_TOTAL: '2', COVERAGE_PLANNED: '2', COVERAGE_SAMPLED: 'false', BATCH_COUNT: '1' });
  assert.equal(full.overallConclusion, 'fully-incompatible');
  assert.equal(full.overallResult, 'FAIL');
  const batch = aggregateEvidence(dir, { PLAN_RESULT: 'success', PROBE_RESULT: 'failure', EXECUTE: 'true', AUTHORIZED: 'true',
    COVERAGE_TOTAL: '600', COVERAGE_PLANNED: '600', COVERAGE_SAMPLED: 'false', BATCH_COUNT: '3' });
  assert.equal(batch.overallConclusion, 'sampled-incompatible', 'one exhaustive batch must not claim whole-range completion');


  const mixedDir = join(dir, 'mixed'); mkdirSync(mixedDir);
  for (const [i, evidence] of [row('OpenWrt', 'main', 'compatible'), row('OpenWrt', 'openwrt-23.05', 'incompatible'),
    row('ImmortalWrt', 'openwrt-23.05', 'incompatible')].entries()) {
    const sub = join(mixedDir, String(i)); mkdirSync(sub); writeFileSync(join(sub, 'evidence.json'), JSON.stringify(evidence));
  }
  const mixed = aggregateEvidence(mixedDir, { PLAN_RESULT: 'success', PROBE_RESULT: 'success', EXECUTE: 'true', AUTHORIZED: 'true',
    COVERAGE_TOTAL: '3', COVERAGE_PLANNED: '3', COVERAGE_SAMPLED: 'false', BATCH_COUNT: '1' });
  assert(mixed.lines.some((line) => line.includes('| OpenWrt | **MIXED** | **50%** | 1/2 | 0 | 0 |')), 'mixed source must keep its top-level total');
  assert(mixed.lines.some((line) => line.includes('<summary>OpenWrt · Branch breakdown / 分支明细</summary>')), 'mixed source must expose branch breakdown');
  assert(!mixed.lines.some((line) => line.includes('<summary>ImmortalWrt · Branch breakdown / 分支明细</summary>')), 'uniform source must stay compact');

  const errorDir = join(dir, 'error'); mkdirSync(errorDir);
  for (const [i, evidence] of [row('OpenWrt', 'main', 'compatible'), row('OpenWrt', 'openwrt-18.06', 'inconclusive')].entries()) {
    const sub = join(errorDir, String(i)); mkdirSync(sub); writeFileSync(join(sub, 'evidence.json'), JSON.stringify(evidence));
  }
  const error = aggregateEvidence(errorDir, { PLAN_RESULT: 'success', PROBE_RESULT: 'failure', EXECUTE: 'true', AUTHORIZED: 'true',
    COVERAGE_TOTAL: '2', COVERAGE_PLANNED: '2', COVERAGE_SAMPLED: 'false', BATCH_COUNT: '1' });
  assert.equal(error.overallResult, 'ERROR');
  assert(error.lines.some((line) => line.includes('| OpenWrt | **ERROR** | **100%** | 1/1 | 0 | 1 |')), 'infrastructure uncertainty must be visually distinct from business FAIL');
} finally { rmSync(dir, { recursive: true, force: true }); }

const missing = resolve(import.meta.dirname, '.package-probe-evidence-test-missing');
assert.equal(aggregateEvidence(missing, { PLAN_RESULT: 'failure', PROBE_RESULT: 'skipped' }).runStatus.state, 'plan-failure');
const skippedEvidence = createEvidence({ log: '', runtime: { mode: 'config-resolve', conclusion: 'skipped', roots: ['alpha'], attempts: [{
  source: 'OpenWrt', branch: 'main', targetSystem: 'x86', subtarget: '64', target: 'x86/64', profile: 'DEVICE_generic',
  result: 'skipped', reason: 'root-not-applicable', unavailableRoots: ['alpha'], rootStates: { alpha: 'n' },
}] }, env: { PROBE_ROOTS: 'alpha', PROBE_MODE: 'config-resolve' } });
assert.equal(skippedEvidence.conclusion, 'skipped');
assert(skippedEvidence.issues.some((row) => row.type === 'not-applicable'));

console.log('Package Probe V3 evidence checks passed.');

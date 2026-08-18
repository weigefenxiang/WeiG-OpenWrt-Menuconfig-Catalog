#!/usr/bin/env node
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  aggregateEvidence, aggregateRunStatus, aggregateScopeConclusions, createEvidence, parseProbeLog,
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

const infrastructure = createEvidence({ log: 'No space left on device', runtime: { conclusion: 'incompatible', attempts: [] }, env: { PROBE_ROOTS: 'alpha' } });
assert.equal(infrastructure.conclusion, 'inconclusive');

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
  const full = aggregateEvidence(dir, { PLAN_RESULT: 'success', PROBE_RESULT: 'failure', EXECUTE: 'true', AUTHORIZED: 'true',
    COVERAGE_TOTAL: '2', COVERAGE_PLANNED: '2', COVERAGE_SAMPLED: 'false', BATCH_COUNT: '1' });
  assert.equal(full.overallConclusion, 'fully-incompatible');
  const batch = aggregateEvidence(dir, { PLAN_RESULT: 'success', PROBE_RESULT: 'failure', EXECUTE: 'true', AUTHORIZED: 'true',
    COVERAGE_TOTAL: '600', COVERAGE_PLANNED: '600', COVERAGE_SAMPLED: 'false', BATCH_COUNT: '3' });
  assert.equal(batch.overallConclusion, 'sampled-incompatible', 'one exhaustive batch must not claim whole-range completion');
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

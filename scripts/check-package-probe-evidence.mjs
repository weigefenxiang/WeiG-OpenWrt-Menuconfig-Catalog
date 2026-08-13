#!/usr/bin/env node
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { aggregateEvidence, aggregateRunStatus, aggregateScopeConclusions, createEvidence } from './write-package-probe-evidence.mjs';

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
console.log('Package Probe V3 evidence checks passed.');

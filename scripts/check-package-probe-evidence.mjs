#!/usr/bin/env node
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { aggregateEvidence, aggregateRunStatus } from './write-package-probe-evidence.mjs';

const state = (env, evidenceCount = 0) => aggregateRunStatus(env, evidenceCount).state;

assert.equal(state({ PLAN_RESULT: 'failure', PROBE_RESULT: 'skipped', REQUESTED_PLAN_ONLY: 'false' }),
  'plan-failure');
assert.equal(state({ PLAN_RESULT: 'success', PROBE_RESULT: 'skipped', EXECUTE: 'false', AUTHORIZED: 'true' }),
  'plan-only');
assert.equal(state({ PLAN_RESULT: 'success', PROBE_RESULT: 'failure', EXECUTE: 'true', AUTHORIZED: 'true' }),
  'execution-failure');
assert.equal(state({ PLAN_RESULT: 'success', PROBE_RESULT: 'success', EXECUTE: 'true', AUTHORIZED: 'true' }, 1),
  'execution-success');
assert.equal(state({ PLAN_RESULT: 'success', PROBE_RESULT: 'success', EXECUTE: 'true', AUTHORIZED: 'true' }),
  'execution-evidence-missing');
assert.equal(state({ PLAN_RESULT: 'success', PROBE_RESULT: 'skipped', EXECUTE: 'false', AUTHORIZED: 'false' }),
  'authorization-denied');

const missingDirectory = resolve(import.meta.dirname, '.package-probe-evidence-test-missing');
const failedPlan = aggregateEvidence(missingDirectory, {
  PLAN_RESULT: 'failure', PROBE_RESULT: 'skipped', REQUESTED_PLAN_ONLY: 'false',
});
assert.equal(failedPlan.runStatus.state, 'plan-failure');
assert(failedPlan.lines.some((line) => line.includes('Probe planning failed before Matrix creation')));
assert(!failedPlan.lines.some((line) => line.startsWith('> Plan only;')));

const planOnly = aggregateEvidence(missingDirectory, {
  PLAN_RESULT: 'success', PROBE_RESULT: 'skipped', EXECUTE: 'false', AUTHORIZED: 'true',
});
assert.equal(planOnly.runStatus.state, 'plan-only');
assert(planOnly.lines.some((line) => line.startsWith('> Plan only;')));

console.log('Package probe evidence checks passed.');

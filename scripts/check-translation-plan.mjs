#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createTranslationPlan } from './translation-plan.mjs';

const defaults = createTranslationPlan({});
assert.deepEqual(defaults, {
  batchSize: 500,
  batchCount: 1,
  totalItems: 500,
  totalItemLimit: 5000,
  totalTimeBudgetSeconds: 3000,
  perBatchTimeBudgetSeconds: 3000,
  publishMode: 'each-batch',
});

const tenBatches = createTranslationPlan({
  TRANSLATE_BATCH_SIZE: '500',
  TRANSLATE_BATCH_COUNT: '10',
});
assert.equal(tenBatches.totalItems, 5000);
assert.equal(tenBatches.perBatchTimeBudgetSeconds, 300);

assert.throws(() => createTranslationPlan({
  TRANSLATE_BATCH_SIZE: '5000',
  TRANSLATE_BATCH_COUNT: '10',
}), /Requested 50000 descriptions.*per-run limit is 5000/);
assert.throws(() => createTranslationPlan({ TRANSLATE_BATCH_SIZE: '99' }), /Batch size/);
assert.throws(() => createTranslationPlan({ TRANSLATE_BATCH_COUNT: '21' }), /Batch count/);
assert.throws(() => createTranslationPlan({ TRANSLATE_PUBLISH_MODE: 'never' }), /Publish mode/);

console.log('translation plan checks passed: 60m job / 50m shared budget / 5000 items');

#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createTranslationPlan, remainingTranslationSeconds, deferTranslationRetries } from './translation-plan.mjs';

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

assert.equal(remainingTranslationSeconds(2000, 600, 1000), 600);
assert.equal(remainingTranslationSeconds(1500, 600, 1000), 200);
assert.equal(remainingTranslationSeconds(1200, 600, 1000), 0);
const retries = deferTranslationRetries([], [['demo', { english: 'Keep product name' }]], {}, 'zh-CN', 0);
assert.equal(retries[0].attempts, 1);
assert.equal(retries[0].nextAttemptAt, '1970-01-02T00:00:00.000Z');
assert.deepEqual(deferTranslationRetries(retries, [], { demo: { translations: { 'zh-CN': 'translated' } } }, 'zh-CN', 0), []);
console.log('translation plan checks passed: 60m job / 50m shared budget / 5000 items');

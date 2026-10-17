#!/usr/bin/env node
import { appendFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const integer = (value, name, minimum, maximum) => {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${name} must be an integer from ${minimum} to ${maximum}`);
  }
  return parsed;
};

export function createTranslationPlan(env = process.env) {
  const batchSize = integer(env.TRANSLATE_BATCH_SIZE || 500, 'Batch size', 100, 5000);
  const batchCount = integer(env.TRANSLATE_BATCH_COUNT || 1, 'Batch count', 1, 20);
  const totalItemLimit = integer(env.TRANSLATE_TOTAL_ITEM_LIMIT || 5000, 'Total item limit', 100, 5000);
  const totalTimeBudgetSeconds = integer(
    env.TRANSLATE_TOTAL_TIME_BUDGET_SECONDS || 3000, 'Total time budget', 600, 3300);
  const totalItems = batchSize * batchCount;
  if (totalItems > totalItemLimit) {
    throw new Error(
      `Requested ${totalItems} descriptions (${batchCount} × ${batchSize}); ` +
      `the per-run limit is ${totalItemLimit}. Split this into multiple workflow runs.`);
  }
  const publishMode = env.TRANSLATE_PUBLISH_MODE || 'each-batch';
  if (!['each-batch', 'final'].includes(publishMode)) {
    throw new Error('Publish mode must be each-batch or final');
  }
  return {
    batchSize,
    batchCount,
    totalItems,
    totalItemLimit,
    totalTimeBudgetSeconds,
    perBatchTimeBudgetSeconds: Math.floor(totalTimeBudgetSeconds / batchCount),
    publishMode,
  };
}

// A deadline covers setup, decoding, translation, encoding, checks and publication.
export function remainingTranslationSeconds(deadline, perBatch, now = Date.now() / 1000, reserve = 300) {
  if (!Number.isFinite(Number(deadline)) || Number(deadline) <= 0) return Number(perBatch);
  return Math.max(0, Math.min(Number(perBatch), Math.floor(Number(deadline) - now - reserve)));
}
export function deferTranslationRetries(previous, pending, entries, language, now = Date.now()) {
  const prior = new Map(previous.map(row => [row.id, row]));
  for (const [id, row] of pending) {
    if (entries[id]?.translations?.[language]) { prior.delete(id); continue; }
    const attempts = Number(prior.get(id)?.attempts || 0) + 1;
    prior.set(id, { id, text: row.english, attempts, reason: 'unchanged-or-rejected-output',
      nextAttemptAt: new Date(now + Math.min(7, 2 ** Math.min(attempts - 1, 3)) * 86400000).toISOString() });
  }
  return [...prior.values()].filter(row => !entries[row.id]?.translations?.[language]);
}

function main() {
  if (process.argv[2] === 'remaining') {
    console.log(remainingTranslationSeconds(Number(process.argv[3]), Number(process.argv[4])));
    return;
  }
  const plan = createTranslationPlan();
  const message =
    `Configured translation: ${plan.batchCount} batch(es) × ${plan.batchSize} descriptions ` +
    `= ${plan.totalItems}/${plan.totalItemLimit}; shared translation budget ` +
    `${plan.totalTimeBudgetSeconds}s (${plan.perBatchTimeBudgetSeconds}s per batch); ` +
    `publish ${plan.publishMode}.`;
  console.log(message);
  if (process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, [
      '## Translation plan',
      `- Items: \`${plan.batchSize} × ${plan.batchCount} = ${plan.totalItems}/${plan.totalItemLimit}\``,
      `- Shared translation budget: \`${plan.totalTimeBudgetSeconds}s\` ` +
        `(\`${plan.perBatchTimeBudgetSeconds}s\` per batch)`,
      `- Publish mode: \`${plan.publishMode}\``,
      '',
    ].join('\n'));
  }
  if (!process.env.GITHUB_OUTPUT) return;
  appendFileSync(process.env.GITHUB_OUTPUT, [
    `deadline_unix=${Math.floor(Date.now() / 1000) + plan.totalTimeBudgetSeconds}`,
    `batch_size=${plan.batchSize}`,
    `batch_count=${plan.batchCount}`,
    `total_items=${plan.totalItems}`,
    `total_item_limit=${plan.totalItemLimit}`,
    `total_time_budget_seconds=${plan.totalTimeBudgetSeconds}`,
    `per_batch_time_budget_seconds=${plan.perBatchTimeBudgetSeconds}`,
    `publish_mode=${plan.publishMode}`,
    '',
  ].join('\n'));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  try {
    main();
  } catch (error) {
    console.error(`Translation plan rejected: ${error.message}`);
    process.exitCode = 1;
  }
}

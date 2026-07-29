#!/usr/bin/env node
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { safeSlug } from './lib.mjs';

const required = ['SOURCE_ID', 'SOURCE_LABEL', 'SOURCE_REPO', 'SOURCE_BRANCH', 'RUN_URL'];
for (const name of required) {
  if (!process.env[name]) throw new Error(`缺少 ${name}`);
}
const steps = [
  ['tools', process.env.TOOLS_OUTCOME],
  ['clone', process.env.CLONE_OUTCOME],
  ['feeds', process.env.FEEDS_OUTCOME],
  ['defconfig', process.env.DEFCONFIG_OUTCOME],
  ['extract', process.env.EXTRACT_OUTCOME],
  ['upload', process.env.UPLOAD_OUTCOME],
];
const failed = steps.find(([, outcome]) => outcome && outcome !== 'success' && outcome !== 'skipped');
const status = process.env.JOB_STATUS === 'success' ? 'success' : 'failure';
const outDir = resolve(process.env.ATTEMPT_DIR || 'attempts');
const attempt = {
  schema: 1,
  source: {
    id: process.env.SOURCE_ID,
    label: process.env.SOURCE_LABEL,
    repo: process.env.SOURCE_REPO,
    legacy: process.env.SOURCE_LEGACY === 'true',
  },
  branch: process.env.SOURCE_BRANCH,
  status,
  stage: status === 'success' ? 'complete' : (failed?.[0] || 'unknown'),
  attemptedAt: new Date().toISOString(),
  runUrl: process.env.RUN_URL,
};
mkdirSync(outDir, { recursive: true });
const name = `${safeSlug(attempt.source.id)}--${safeSlug(attempt.branch)}.attempt.json`;
writeFileSync(resolve(outDir, name), JSON.stringify(attempt, null, 2) + '\n');
console.log(`${attempt.source.id}/${attempt.branch}: ${attempt.status} @ ${attempt.stage}`);

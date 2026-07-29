#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const order = process.env.CATALOG_ORDER || '00';
const outDir = resolve(process.env.PUBLISH_DIAGNOSTICS_DIR || 'publish-diagnostics');
const attemptsDir = resolve(process.env.ATTEMPT_DIR || 'current-attempts');
mkdirSync(outDir, { recursive: true });
const attempts = existsSync(attemptsDir)
  ? readdirSync(attemptsDir).filter((name) => name.endsWith('.attempt.json')).sort()
    .map((name) => JSON.parse(readFileSync(join(attemptsDir, name), 'utf8')))
  : [];
const stages = [
  ['collect', process.env.COLLECT_OUTCOME || 'not-run'],
  ['index', process.env.INDEX_OUTCOME || 'not-run'],
  ['catalog-data', process.env.DATA_OUTCOME || 'not-run'],
  ['release', process.env.RELEASE_OUTCOME || 'skipped'],
];
const failedStage = stages.find(([, outcome]) => outcome === 'failure')?.[0] || '-';
const artifact = process.env.CATALOG_ARTIFACT_NAME || `${order}-publish`;
const lines = [
  '## Menuconfig catalog health / 目录健康状态',
  '',
  `- Matrix result: \`${process.env.MATRIX_RESULT || 'unknown'}\``,
  `- Publish job: \`${order} · Publish / 发布目录与 Release\``,
  `- Publish Artifact: \`${artifact}\``,
  `- Failed stage: \`${failedStage}\``,
  `- Run: [${process.env.RUN_ID || '-'} attempt ${process.env.RUN_ATTEMPT || '-'}](${process.env.RUN_URL || '#'})`,
  '',
  '| No. | Job | Artifact | Status | Failed stage / log |',
  '|---:|---|---|---|---|',
  ...attempts.sort((a, b) => (a.order || 0) - (b.order || 0)).map((item) =>
    `| ${item.orderText || '-'} | ${item.jobName || `${item.source.label} · ${item.branch}`} | ` +
    `\`${item.artifactName || '-'}\` | ${item.status} | ` +
    `${item.status === 'failure' ? `${item.stage} / \`${item.failureLog || '-'}\`` : '-'} |`),
  `| ${order} | Publish / 发布目录与 Release | \`${artifact}\` | ` +
    `${failedStage === '-' ? 'success' : 'failure'} | ${failedStage} |`,
  '',
  'Publish stages:',
  ...stages.map(([name, outcome]) => `- ${name}: ${outcome}`),
  '',
];
const text = lines.join('\n');
writeFileSync(join(outDir, `${order}-publish--SUMMARY.txt`), text);
console.log(text);

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
const manifestFile = join(outDir, 'publish-inputs.json');
const manifest = existsSync(manifestFile)
  ? JSON.parse(readFileSync(manifestFile, 'utf8')) : { branches: [] };
const publishedByArtifact = new Map((manifest.branches || [])
  .map((item) => [item.artifactName, item]));
const stages = [
  ['collect', process.env.COLLECT_OUTCOME || 'not-run'],
  ['translate', process.env.TRANSLATE_OUTCOME || 'not-run'],
  ['index', process.env.INDEX_OUTCOME || 'not-run'],
  ['catalog-data', process.env.DATA_OUTCOME || 'not-run'],
  ['release', process.env.RELEASE_OUTCOME || 'skipped'],
];
const failedStage = stages.filter(([name]) => name !== 'translate')
  .find(([, outcome]) => outcome === 'failure')?.[0] || '-';
const artifact = process.env.CATALOG_ARTIFACT_NAME || `${order}-publish`;
const lines = [
  '## Menuconfig catalog health / 目录健康状态',
  '',
  `- Matrix result: \`${process.env.MATRIX_RESULT || 'unknown'}\``,
  `- Complete snapshot: \`${process.env.COLLECT_COMPLETE || manifest.complete || false}\``,
  `- Rolling publish: fresh=\`${manifest.fresh || 0}\`, last-good=\`${manifest.lastGood || 0}\``,
  `- Publish job: \`${order} · Publish / 发布目录与 Release\``,
  `- Publish Artifact: \`${artifact}\``,
  `- Failed stage: \`${failedStage}\``,
  `- Run: [${process.env.RUN_ID || '-'} attempt ${process.env.RUN_ATTEMPT || '-'}](${process.env.RUN_URL || '#'})`,
  '',
  '| No. | Job | Artifact | Build | Published | Diagnostic |',
  '|---:|---|---|---|---|---|',
  ...attempts.sort((a, b) => (a.order || 0) - (b.order || 0)).map((item) => {
    const published = publishedByArtifact.get(item.artifactName);
    const state = published?.publishState === 'fresh' ? 'Fresh / 本次成功'
      : published?.publishState === 'last-good' ? 'Stale / 使用旧数据'
        : 'Unavailable / 暂无数据';
    const diagnostic = published?.issues?.length
      ? published.issues.join('<br>') : (item.status === 'failure'
        ? `${item.stage} / \`${item.failureLog || '-'}\`` : '-');
    return (
    `| ${item.orderText || '-'} | ${item.jobName || `${item.source.label} · ${item.branch}`} | ` +
    `\`${item.artifactName || '-'}\` | ${item.status} | ${state} | ${diagnostic} |`);
  }),
  `| ${order} | Publish / 发布目录与 Release | \`${artifact}\` | ` +
    `${failedStage === '-' ? 'success' : 'failure'} | Rolling catalog-data | ${failedStage} |`,
  '',
  'Publish stages:',
  ...stages.map(([name, outcome]) => `- ${name}: ${outcome}`),
  '',
];
const text = lines.join('\n');
writeFileSync(join(outDir, `${order}-publish--SUMMARY.txt`), text);
console.log(text);

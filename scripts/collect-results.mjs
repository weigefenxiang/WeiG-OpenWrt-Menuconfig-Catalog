#!/usr/bin/env node
import { createHash } from 'node:crypto';
import {
  copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync,
} from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { basename, join, resolve } from 'node:path';

const [rawArg = 'current', previousArg = 'previous', distArg = 'dist',
  attemptsArg = 'current-attempts', diagnosticsArg = 'publish-diagnostics'] = process.argv.slice(2);
const rawDir = resolve(rawArg);
const previousDir = resolve(previousArg);
const distDir = resolve(distArg);
const attemptsDir = resolve(attemptsArg);
const diagnosticsDir = resolve(diagnosticsArg);
for (const dir of [distDir, attemptsDir, diagnosticsDir]) mkdirSync(dir, { recursive: true });

const walk = (dir) => {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).sort().flatMap((name) => {
    const file = join(dir, name);
    return statSync(file).isDirectory() ? walk(file) : [file];
  });
};
const digest = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');
const currentFiles = walk(rawDir);
const accepted = currentFiles.filter((file) =>
  /\.(json\.gz|meta\.json|translations\.json|attempt\.json|log)$/.test(file) ||
  file.endsWith('--SUMMARY.txt'));
const byName = new Map();
const errors = [];
for (const file of accepted) {
  const name = basename(file);
  const hash = digest(file);
  if (byName.has(name) && byName.get(name).hash !== hash) {
    errors.push(`下载的 Artifact 含同名不同内容文件:${name}`);
    continue;
  }
  byName.set(name, { file, hash });
}

for (const file of walk(previousDir).filter((item) =>
  item.endsWith('.json.gz') || item.endsWith('.translations.json'))) {
  copyFileSync(file, join(distDir, basename(file)));
}
for (const { file } of byName.values()) {
  const name = basename(file);
  if (/\.(json\.gz|meta\.json|translations\.json)$/.test(name)) {
    copyFileSync(file, join(distDir, name));
  } else {
    copyFileSync(file, join(attemptsDir, name));
  }
}

const attempts = readdirSync(attemptsDir).filter((name) => name.endsWith('.attempt.json')).sort()
  .map((name) => JSON.parse(readFileSync(join(attemptsDir, name), 'utf8')));
if (!attempts.length) errors.push('未收集到任何分支 attempt 记录');
const metas = readdirSync(distDir).filter((name) => name.endsWith('.meta.json')).sort()
  .map((name) => JSON.parse(readFileSync(join(distDir, name), 'utf8')));
const metaByBranch = new Map(metas.map((meta) =>
  [`${meta.source.id}\0${meta.source.branch}`, meta]));
for (const attempt of attempts) {
  const summary = readdirSync(attemptsDir).find((name) =>
    name.startsWith(`${attempt.orderText}-`) && name.endsWith('--SUMMARY.txt') &&
    readFileSync(join(attemptsDir, name), 'utf8').includes(`Branch: ${attempt.branch}`));
  if (!summary) errors.push(`${attempt.orderText} ${attempt.source.id}/${attempt.branch}:缺 SUMMARY`);
  if (attempt.status === 'failure') {
    if (!attempt.failureLog || !existsSync(join(attemptsDir, attempt.failureLog))) {
      errors.push(`${attempt.orderText} ${attempt.source.id}/${attempt.branch}:缺失败日志 ${attempt.failureLog || '-'}`);
    }
    continue;
  }
  const meta = metaByBranch.get(`${attempt.source.id}\0${attempt.branch}`);
  if (!meta) {
    errors.push(`${attempt.orderText} ${attempt.source.id}/${attempt.branch}:缺 meta`);
    continue;
  }
  const asset = join(distDir, meta.asset);
  const translations = join(distDir, meta.asset.replace(/\.json\.gz$/, '.translations.json'));
  if (!existsSync(asset)) errors.push(`${attempt.orderText} ${attempt.source.id}/${attempt.branch}:缺 ${meta.asset}`);
  if (!existsSync(translations)) {
    errors.push(`${attempt.orderText} ${attempt.source.id}/${attempt.branch}:缺 translations`);
  }
  if (existsSync(asset)) {
    const jsonHash = createHash('sha256').update(gunzipSync(readFileSync(asset))).digest('hex');
    if (meta.sha256 && meta.sha256 !== jsonHash) {
      errors.push(`${attempt.orderText} ${attempt.source.id}/${attempt.branch}:catalog SHA-256 不一致`);
    }
  }
}
const manifest = {
  schema: 1,
  collectedAt: new Date().toISOString(),
  rawFiles: currentFiles.length,
  acceptedFiles: byName.size,
  attempts: attempts.map((item) => ({
    order: item.order, orderText: item.orderText, jobName: item.jobName,
    source: item.source.id, repo: item.source.repo, branch: item.branch, version: item.version,
    status: item.status, stage: item.stage, artifactName: item.artifactName,
    failureLog: item.failureLog,
  })),
  errors,
};
writeFileSync(join(diagnosticsDir, 'publish-inputs.json'), JSON.stringify(manifest, null, 2) + '\n');
if (errors.length) throw new Error(`Artifact 完整性检查失败:\n- ${errors.join('\n- ')}`);
console.log(`collected ${attempts.length} attempts / ${metas.length} metadata rows / ${byName.size} files`);

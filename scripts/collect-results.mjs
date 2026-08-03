#!/usr/bin/env node
import { createHash } from 'node:crypto';
import {
  appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync,
  writeFileSync,
} from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { basename, join, resolve } from 'node:path';
import { safeSlug } from './lib.mjs';

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
const warnings = [];
const fatalErrors = [];
const copied = new Map();
const copyUnique = (file, dir, scope) => {
  const name = basename(file);
  const hash = digest(file);
  const key = `${dir}\0${name}`;
  if (copied.has(key) && copied.get(key) !== hash) {
    warnings.push(`${scope}:同名不同内容文件 ${name}`);
    return false;
  }
  copyFileSync(file, join(dir, name));
  copied.set(key, hash);
  return true;
};

for (const file of walk(previousDir).filter((item) =>
  item.endsWith('.json.gz') || item.endsWith('.translations.json') || item.endsWith('.contract.json'))) {
  copyFileSync(file, join(distDir, basename(file)));
}
for (const name of ['i18n-cache.json', 'translation-state.json', 'translation-retry-queue.json']) {
  const file = join(previousDir, name);
  if (existsSync(file)) copyFileSync(file, join(distDir, name));
}
const fallbackState = (attempt) => {
  const asset = `${safeSlug(attempt.source?.id)}--${safeSlug(attempt.branch)}.json.gz`;
  return existsSync(join(distDir, asset)) ? 'last-good' : 'unavailable';
};

const artifactDirs = existsSync(rawDir)
  ? readdirSync(rawDir).sort().map((name) => join(rawDir, name))
    .filter((item) => statSync(item).isDirectory())
  : [];
const attempts = [];
const branches = [];
let acceptedFiles = 0;
for (const artifactDir of artifactDirs) {
  const artifactName = basename(artifactDir);
  const files = walk(artifactDir);
  const accepted = files.filter((file) =>
    /\.(json\.gz|meta\.json|contract\.json|translations\.json|attempt\.json|log)$/.test(file) ||
    file.endsWith('--SUMMARY.txt'));
  acceptedFiles += accepted.length;
  for (const file of accepted.filter((item) =>
    item.endsWith('.attempt.json') || item.endsWith('--SUMMARY.txt') || item.endsWith('.log'))) {
    copyUnique(file, attemptsDir, artifactName);
  }
  const attemptFiles = accepted.filter((file) => file.endsWith('.attempt.json'));
  if (attemptFiles.length !== 1) {
    warnings.push(`${artifactName}:attempt 数量=${attemptFiles.length},已隔离`);
    continue;
  }
  let attempt;
  try {
    attempt = JSON.parse(readFileSync(attemptFiles[0], 'utf8'));
  } catch (error) {
    warnings.push(`${artifactName}:attempt 无法解析:${error.message}`);
    continue;
  }
  attempts.push(attempt);
  const identity = `${attempt.orderText || '-'} ${attempt.source?.id || 'unknown'}/${attempt.branch || 'unknown'}`;
  const issues = [];
  const summary = accepted.find((file) => file.endsWith('--SUMMARY.txt') &&
    readFileSync(file, 'utf8').includes(`Branch: ${attempt.branch}`));
  if (!summary) issues.push('缺 SUMMARY');
  if (attempt.status !== 'success') {
    if (!attempt.failureLog || !accepted.some((file) => basename(file) === attempt.failureLog)) {
      issues.push(`缺失败日志 ${attempt.failureLog || '-'}`);
    }
    warnings.push(...issues.map((item) => `${identity}:${item}`));
    branches.push({
      orderText: attempt.orderText, source: attempt.source.id, branch: attempt.branch,
      artifactName, attemptStatus: attempt.status, publishState: fallbackState(attempt),
      stage: attempt.stage, failureLog: attempt.failureLog, issues,
    });
    continue;
  }

  const metaFiles = accepted.filter((file) => file.endsWith('.meta.json'));
  let meta;
  if (metaFiles.length !== 1) issues.push(`meta 数量=${metaFiles.length}`);
  if (!issues.length) {
    try {
      meta = JSON.parse(readFileSync(metaFiles[0], 'utf8'));
    } catch (error) {
      issues.push(`meta 无法解析:${error.message}`);
    }
  }
  if (meta && (meta.source?.id !== attempt.source.id || meta.source?.branch !== attempt.branch)) {
    issues.push('meta 与 attempt 身份不一致');
  }
  const assetFile = meta && accepted.find((file) => basename(file) === meta.asset);
  const translationName = meta?.asset?.replace(/\.json\.gz$/, '.translations.json');
  const translationFile = translationName &&
    accepted.find((file) => basename(file) === translationName);
  const contractName = meta?.asset?.replace(/\.json\.gz$/, '.contract.json');
  const contractFile = contractName && accepted.find((file) => basename(file) === contractName);
  if (meta && !assetFile) issues.push(`缺 ${meta.asset}`);
  if (meta && !translationFile) issues.push('缺 translations');
  if (meta && !contractFile) issues.push('缺 target contract');
  if (contractFile) {
    try {
      const contract = JSON.parse(readFileSync(contractFile, 'utf8'));
      if (contract.source?.id !== attempt.source.id || contract.source?.branch !== attempt.branch ||
          !Number.isInteger(contract.summary?.selectableTargets)) {
        issues.push('target contract 与 attempt 身份不一致');
      }
    } catch (error) {
      issues.push(`target contract 无法解析:${error.message}`);
    }
  }
  if (assetFile) {
    try {
      const jsonHash = createHash('sha256').update(gunzipSync(readFileSync(assetFile))).digest('hex');
      if (meta.sha256 && meta.sha256 !== jsonHash) issues.push('catalog SHA-256 不一致');
    } catch (error) {
      issues.push(`catalog 无法解压:${error.message}`);
    }
  }
  let fresh = false;
  if (!issues.length) {
    fresh = copyUnique(assetFile, distDir, identity) &&
      copyUnique(metaFiles[0], distDir, identity) &&
      copyUnique(contractFile, distDir, identity) &&
      copyUnique(translationFile, distDir, identity);
    if (!fresh) issues.push('输出文件名冲突');
  }
  warnings.push(...issues.map((item) => `${identity}:${item}`));
  branches.push({
    orderText: attempt.orderText, source: attempt.source.id, branch: attempt.branch,
    artifactName, attemptStatus: attempt.status,
    publishState: fresh ? 'fresh' : fallbackState(attempt),
    stage: fresh ? 'complete' : 'publish-validation', failureLog: attempt.failureLog, issues,
  });
}

if (!attempts.length) fatalErrors.push('未收集到任何可解析的分支 attempt 记录');
const dataAssets = readdirSync(distDir).filter((name) => name.endsWith('.json.gz'));
if (!dataAssets.length) fatalErrors.push('没有本次成功数据或历史 last-good 数据可发布');
const complete = attempts.length > 0 && branches.length === attempts.length &&
  branches.every((item) => item.attemptStatus === 'success' &&
    item.publishState === 'fresh' && item.issues.length === 0) && warnings.length === 0;
const manifest = {
  schema: 2,
  collectedAt: new Date().toISOString(),
  rawFiles: walk(rawDir).length,
  acceptedFiles,
  complete,
  fresh: branches.filter((item) => item.publishState === 'fresh').length,
  lastGood: branches.filter((item) => item.publishState === 'last-good').length,
  attempts: attempts.map((item) => ({
    order: item.order, orderText: item.orderText, jobName: item.jobName,
    source: item.source.id, repo: item.source.repo, branch: item.branch, version: item.version,
    status: item.status, stage: item.stage, artifactName: item.artifactName,
    failureLog: item.failureLog,
  })),
  branches,
  warnings,
  fatalErrors,
};
writeFileSync(join(diagnosticsDir, 'publish-inputs.json'), JSON.stringify(manifest, null, 2) + '\n');
if (process.env.GITHUB_OUTPUT) {
  appendFileSync(process.env.GITHUB_OUTPUT, `complete=${complete}\n`);
  appendFileSync(process.env.GITHUB_OUTPUT, `fresh=${manifest.fresh}\n`);
  appendFileSync(process.env.GITHUB_OUTPUT, `last-good=${manifest.lastGood}\n`);
}
if (fatalErrors.length) throw new Error(`Artifact 收集无法继续:\n- ${fatalErrors.join('\n- ')}`);
if (warnings.length) console.warn(`Artifact 分支级警告:\n- ${warnings.join('\n- ')}`);
console.log(`collected ${attempts.length} attempts; fresh=${manifest.fresh}` +
  ` last-good=${manifest.lastGood} complete=${complete}`);

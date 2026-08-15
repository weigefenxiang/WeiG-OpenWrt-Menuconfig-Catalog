#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

export const PRODUCTION_CANDIDATE_BRANCH = 'catalog-candidate';
export const PRODUCTION_DATA_BRANCH = 'catalog-data';
const GIT_SHA_RE = /^[0-9a-f]{40}$/i;

const BUILD_DATA_BRANCHES = Object.freeze({
  dev: 'catalog-dev',
  staging: 'catalog-staging',
  main: PRODUCTION_CANDIDATE_BRANCH,
  'fix-E': 'catalog-fix-E',
});

const RUNTIME_DATA_BRANCHES = Object.freeze({
  dev: 'catalog-dev',
  staging: 'catalog-staging',
  main: PRODUCTION_DATA_BRANCH,
  'fix-E': 'catalog-fix-E',
});

function dExperimentDataBranch(ref) {
  const match = /^fix\/(DA|DB)$/i.exec(ref);
  return match ? `catalog-${match[1].toUpperCase()}` : '';
}

export function fixDataBranchForCodeRef(codeRef) {
  const ref = String(codeRef || '').trim();
  if (!ref.startsWith('fix/')) return '';
  const dBranch = dExperimentDataBranch(ref);
  if (dBranch) return dBranch;
  const lane = /-([ABC])$/i.exec(ref)?.[1]?.toUpperCase() || '';
  return lane ? `catalog-fix-${lane}` : 'catalog-fix';
}

export function buildDataBranchForCodeRef(codeRef) {
  const ref = String(codeRef || '').trim();
  if (BUILD_DATA_BRANCHES[ref]) return BUILD_DATA_BRANCHES[ref];
  if (ref.startsWith('fix/')) return fixDataBranchForCodeRef(ref);
  return '';
}

export function runtimeDataBranchForChannel(channel) {
  const ref = String(channel || '').trim();
  if (RUNTIME_DATA_BRANCHES[ref]) return RUNTIME_DATA_BRANCHES[ref];
  if (ref.startsWith('fix/')) return fixDataBranchForCodeRef(ref);
  return '';
}

export function translationChannel(channel) {
  const value = String(channel || '').trim();
  if (value === 'candidate') return { codeRef: 'main', dataBranch: PRODUCTION_CANDIDATE_BRANCH };
  if (value === 'dev') return { codeRef: 'dev', dataBranch: 'catalog-dev' };
  if (value === 'staging') return { codeRef: 'staging', dataBranch: 'catalog-staging' };
  if (value === 'fix-E') return { codeRef: 'fix-E', dataBranch: 'catalog-fix-E' };
  if (value.startsWith('fix/')) return { codeRef: value, dataBranch: fixDataBranchForCodeRef(value) };
  return null;
}

export function pushBeforeSha(event = {}) {
  const before = String(event?.before || '').trim().toLowerCase();
  if (!GIT_SHA_RE.test(before) || /^0{40}$/.test(before)) return '';
  return before;
}

export function ensurePushBeforeCommitAvailable({
  eventName = process.env.GITHUB_EVENT_NAME || '',
  eventPath = process.env.GITHUB_EVENT_PATH || '',
  cwd = process.cwd(),
} = {}) {
  if (eventName !== 'push' || !eventPath) return '';
  const before = pushBeforeSha(JSON.parse(readFileSync(eventPath, 'utf8')));
  if (!before) return '';
  try {
    execFileSync('git', ['cat-file', '-e', `${before}^{commit}`], { cwd, stdio: 'ignore' });
    return before;
  } catch {
    execFileSync('git', ['fetch', '--no-tags', '--depth=1', 'origin', before], { cwd, stdio: 'inherit' });
    execFileSync('git', ['cat-file', '-e', `${before}^{commit}`], { cwd, stdio: 'ignore' });
    return before;
  }
}

function printResult(mode, value) {
  if (mode === 'build') {
    const branch = buildDataBranchForCodeRef(value);
    if (!branch) throw new Error(`unsupported Catalog code ref: ${value}`);
    process.stdout.write(`${branch}\n`);
    return;
  }
  if (mode === 'runtime') {
    const branch = runtimeDataBranchForChannel(value);
    if (!branch) throw new Error(`unsupported Catalog runtime channel: ${value}`);
    process.stdout.write(`${branch}\n`);
    return;
  }
  if (mode === 'translation') {
    const resolved = translationChannel(value);
    if (!resolved) throw new Error(`unsupported Catalog translation channel: ${value}`);
    process.stdout.write(`code_ref=${resolved.codeRef}\ndata_branch=${resolved.dataBranch}\n`);
    return;
  }
  throw new Error(`unsupported Catalog channel mode: ${mode}`);
}

const invokedDirectly = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  ensurePushBeforeCommitAvailable();
  printResult(process.argv[2] || '', process.argv[3] || '');
}

#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

export const PRODUCTION_CANDIDATE_BRANCH = 'catalog-candidate';
export const PRODUCTION_DATA_BRANCH = 'catalog-main';
const GIT_SHA_RE = /^[0-9a-f]{40}$/i;
const CANONICAL_FIX_RE = /^fix-([A-Za-z0-9][A-Za-z0-9._-]{0,95})$/;
const CANONICAL_FIX_DATA_RE = /^catalog-fix-([A-Za-z0-9][A-Za-z0-9._-]{0,95})$/;

const BUILD_DATA_BRANCHES = Object.freeze({
  dev: 'catalog-dev',
  staging: 'catalog-staging',
  main: PRODUCTION_CANDIDATE_BRANCH,
});

const RUNTIME_DATA_BRANCHES = Object.freeze({
  dev: 'catalog-dev',
  staging: 'catalog-staging',
  main: PRODUCTION_DATA_BRANCH,
});

function canonicalFixDataBranch(ref) {
  const suffix = CANONICAL_FIX_RE.exec(ref)?.[1] || '';
  return suffix ? `catalog-fix-${suffix}` : '';
}

export function fixDataBranchForCodeRef(codeRef) {
  const ref = String(codeRef || '').trim();
  return canonicalFixDataBranch(ref);
}

export function buildDataBranchForCodeRef(codeRef) {
  const ref = String(codeRef || '').trim();
  if (BUILD_DATA_BRANCHES[ref]) return BUILD_DATA_BRANCHES[ref];
  return fixDataBranchForCodeRef(ref);
}

export function runtimeDataBranchForChannel(channel) {
  const ref = String(channel || '').trim();
  if (RUNTIME_DATA_BRANCHES[ref]) return RUNTIME_DATA_BRANCHES[ref];
  return fixDataBranchForCodeRef(ref);
}

export function translationChannel(channel) {
  const value = String(channel || '').trim();
  if (value === 'candidate') return { codeRef: 'main', dataBranch: PRODUCTION_CANDIDATE_BRANCH };
  if (value === 'dev') return { codeRef: 'dev', dataBranch: 'catalog-dev' };
  if (value === 'staging') return { codeRef: 'staging', dataBranch: 'catalog-staging' };
  const fixBranch = fixDataBranchForCodeRef(value);
  return fixBranch ? { codeRef: value, dataBranch: fixBranch } : null;
}

export function codeRefForDataBranch(dataBranch) {
  const branch = String(dataBranch || '').trim();
  if (branch === 'catalog-dev') return 'dev';
  if (branch === 'catalog-staging') return 'staging';
  if (branch === PRODUCTION_CANDIDATE_BRANCH || branch === PRODUCTION_DATA_BRANCH) return 'main';
  const canonical = CANONICAL_FIX_DATA_RE.exec(branch)?.[1] || '';
  if (canonical) return `fix-${canonical}`;
  return '';
}

export function isWritableNonProductionDataBranch(dataBranch) {
  const branch = String(dataBranch || '').trim();
  return branch === 'catalog-dev' || branch === 'catalog-staging' || branch === PRODUCTION_CANDIDATE_BRANCH ||
    CANONICAL_FIX_DATA_RE.test(branch);
}

export function defaultReuseSourceForCodeRef(codeRef) {
  const ref = String(codeRef || '').trim();
  if (canonicalFixDataBranch(ref)) return { codeRef: 'dev', dataBranch: 'catalog-dev' };
  if (ref === 'dev') return { codeRef: 'dev', dataBranch: 'catalog-dev' };
  if (ref === 'staging') return { codeRef: 'dev', dataBranch: 'catalog-dev' };
  if (ref === 'main') return { codeRef: 'main', dataBranch: PRODUCTION_DATA_BRANCH };
  return null;
}

function configuredReuseMarker(cwd = process.cwd()) {
  try {
    return String(readFileSync(resolve(cwd, '.catalog-reuse-source'), 'utf8') || '').trim();
  } catch {
    return '';
  }
}

export function configuredReuseSourceForCodeRef(codeRef, { cwd = process.cwd() } = {}) {
  const ref = String(codeRef || '').trim();
  const marker = configuredReuseMarker(cwd);
  // A canonical fix may seed from another validated fix snapshot, and dev may inherit
  // the exact validated fix snapshot it is promoting. Staging keeps the validated dev
  // predecessor, while main preserves the current production snapshot before revalidation.
  if (marker && (Boolean(canonicalFixDataBranch(ref)) || ref === 'dev')) {
    try {
      const validated = validatePromotionSource(ref, marker);
      return { codeRef: validated.sourceCodeRef, dataBranch: validated.sourceDataBranch };
    } catch {
      // Invalid or stale markers never weaken the canonical fallback promotion edge.
    }
  }
  return defaultReuseSourceForCodeRef(ref);
}

export function validatePromotionSource(targetCodeRef, sourceDataBranch) {
  const target = String(targetCodeRef || '').trim();
  const source = String(sourceDataBranch || '').trim();
  const targetDataBranch = buildDataBranchForCodeRef(target);
  const sourceCodeRef = codeRefForDataBranch(source);
  if (!targetDataBranch || !sourceCodeRef || !isWritableNonProductionDataBranch(targetDataBranch)) {
    throw new Error(`unsupported Catalog promotion: ${source || '(missing)'} -> ${target || '(missing)'}`);
  }
  const canonicalTargetFix = Boolean(canonicalFixDataBranch(target));
  const canonicalSourceFix = Boolean(CANONICAL_FIX_DATA_RE.test(source));
  // Canonical fix branches may seed from dev, self-reuse, or explicitly reuse another
  // canonical fix snapshot. The workflow still requires complete provenance, immutable
  // asset identity, source-code ancestry, and a cumulative Data Surface impact of none.
  const allowed = canonicalTargetFix ? (source === 'catalog-dev' || canonicalSourceFix)
    : target === 'dev' ? (source === 'catalog-dev' || canonicalSourceFix)
      : target === 'staging' ? source === 'catalog-dev'
        : target === 'main' ? source === PRODUCTION_DATA_BRANCH
          : false;
  if (!allowed) throw new Error(`Catalog promotion edge is not allowed: ${source} -> ${targetDataBranch}`);
  return { sourceCodeRef, sourceDataBranch: source, targetDataBranch };
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

function printResult(mode, value, extra = '') {
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
  if (mode === 'code-for-data') {
    const codeRef = codeRefForDataBranch(value);
    if (!codeRef) throw new Error(`unsupported Catalog data branch: ${value}`);
    process.stdout.write(`${codeRef}\n`);
    return;
  }
  if (mode === 'validate-non-production') {
    if (!isWritableNonProductionDataBranch(value)) throw new Error(`unsupported or production Catalog data branch: ${value}`);
    process.stdout.write(`${value}\n`);
    return;
  }
  if (mode === 'reuse-source') {
    const source = configuredReuseSourceForCodeRef(value);
    if (!source) throw new Error(`unsupported Catalog reuse code ref: ${value}`);
    process.stdout.write(`source_code_ref=${source.codeRef}\nsource_data_branch=${source.dataBranch}\n`);
    return;
  }
  if (mode === 'validate-promotion') {
    const result = validatePromotionSource(value, extra);
    process.stdout.write(`source_code_ref=${result.sourceCodeRef}\nsource_data_branch=${result.sourceDataBranch}\ntarget_data_branch=${result.targetDataBranch}\n`);
    return;
  }
  throw new Error(`unsupported Catalog channel mode: ${mode}`);
}

const invokedDirectly = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  ensurePushBeforeCommitAvailable();
  printResult(process.argv[2] || '', process.argv[3] || '', process.argv[4] || '');
}

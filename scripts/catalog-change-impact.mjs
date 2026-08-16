#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { configuredReuseSourceForCodeRef } from './catalog-channels.mjs';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const GIT_SHA_RE = /^[0-9a-f]{40}$/i;
const PROMOTION_ONLY_PUSH_REFS = new Set(['dev', 'staging', 'main']);

const REGISTRY = Object.freeze({
  applications: Object.freeze([
    'curated-sizes.json',
    'translations/probe-ui.json',
    'scripts/curated-applications.mjs',
  ]),
  compatibility: Object.freeze([
    'compatibility.json',
    'scripts/compatibility-rules.mjs',
  ]),
  full: Object.freeze([
    'catalog.config.json',
    'translations/menu-i18n.json',
    'translations/zh-CN.json',
    'scripts/build-index.mjs',
    'scripts/clone-upstream.sh',
    'scripts/compact-relations.mjs',
    'scripts/discover.mjs',
    'scripts/generate-catalog.mjs',
    'scripts/generate-profile-config-groups.mjs',
    'scripts/index-contract.mjs',
    'scripts/kconfig-relations.mjs',
    'scripts/lib.mjs',
    'scripts/prepare-metadata.sh',
    'scripts/profile-config-contract.mjs',
    'scripts/source-policy.mjs',
  ]),
  none: Object.freeze([
    '.github/workflows/catalog-production.yml',
    '.github/workflows/catalog-reuse.yml',
    '.github/workflows/catalog.yml',
    '.github/workflows/probe-contracts.yml',
    'package.json',
    'scripts/catalog-change-impact.mjs',
    'scripts/collect-results.mjs',
    'scripts/stamp-catalog-snapshot.mjs',
    'scripts/benchmark-profile-config-groups.mjs',
    'scripts/benchmark-profile-wire-format.mjs',
    'scripts/catalog-channels.mjs',
    'scripts/catalog-size-report.mjs',
    'scripts/check-catalog-change-impact.mjs',
    'scripts/check-catalog-snapshot.mjs',
    'scripts/check-collector.mjs',
    'scripts/check-index-assets.mjs',
    'scripts/check-index.mjs',
    'scripts/check-legacy-metadata.mjs',
    'scripts/check-package-probe-evidence.mjs',
    'scripts/check-package-probe.mjs',
    'scripts/check-probe-authorization.mjs',
    'scripts/check-production-boundary.mjs',
    'scripts/check-production-promotion.mjs',
    'scripts/check-profile-config-contract.mjs',
    'scripts/check-profile-config-groups.mjs',
    'scripts/check-profile-wire-format-benchmark.mjs',
    'scripts/check-public-terminology.mjs',
    'scripts/check-release-publication.mjs',
    'scripts/check-translation-assets.mjs',
    'scripts/check-translation-plan.mjs',
    'scripts/check-translation-rotation.mjs',
    'scripts/check.mjs',
    'scripts/collect-curated-size-samples.mjs',
    'scripts/curated-sizes.mjs',
    'scripts/import-curated-i18n.mjs',
    'scripts/package-probe-controller.mjs',
    'scripts/package-probe-gateway.mjs',
    'scripts/package-probe-state.mjs',
    'scripts/publish-release.sh',
    'scripts/refresh-curated-applications.mjs',
    'scripts/refresh-curated-sizes.mjs',
    'scripts/requirements-argos.txt',
    'scripts/resolve-translation-provider.mjs',
    'scripts/run-boot-smoke.sh',
    'scripts/run-package-probe.mjs',
    'scripts/run-stage.sh',
    'scripts/sync-index-assets.mjs',
    'scripts/sync-translation-assets.mjs',
    'scripts/test-argos.py',
    'scripts/translate-argos.py',
    'scripts/translate-catalog.mjs',
    'scripts/translation-catalog-assets.mjs',
    'scripts/translation-index-assets.mjs',
    'scripts/translation-plan.mjs',
    'scripts/translation-sparse-paths.mjs',
    'scripts/verify-production-candidate.mjs',
    'scripts/verify-target-contracts.mjs',
    'scripts/write-attempt.mjs',
    'scripts/write-package-probe-evidence.mjs',
    'scripts/write-publish-summary.mjs',
    'scripts/write-translation-summary.mjs',
  ]),
});

const CLASS_BY_PATH = new Map();
for (const [impact, paths] of Object.entries(REGISTRY)) {
  for (const path of paths) {
    if (CLASS_BY_PATH.has(path)) throw new Error(`duplicate Catalog impact classification: ${path}`);
    CLASS_BY_PATH.set(path, impact);
  }
}

function normalizePath(path) {
  return String(path || '').trim().replaceAll('\\', '/').replace(/^\.\//, '');
}

const MANAGED_WORKFLOWS = new Set([
  '.github/workflows/catalog-production.yml',
  '.github/workflows/catalog-reuse.yml',
  '.github/workflows/catalog.yml',
  '.github/workflows/probe-contracts.yml',
]);

function isManagedPath(path) {
  return path.startsWith('scripts/') || path.startsWith('translations/') ||
    MANAGED_WORKFLOWS.has(path) || (!path.includes('/') && path.endsWith('.json'));
}

export function classifyCatalogPath(input) {
  const path = normalizePath(input);
  if (!path) return 'none';
  const impact = CLASS_BY_PATH.get(path);
  if (impact) return impact;
  if (isManagedPath(path)) {
    throw new Error(`Unclassified Catalog-impact file: ${path}\nRegister it as none / applications / compatibility / full.`);
  }
  return 'none';
}

export function catalogChangeImpact(inputs) {
  const changed = [...new Set((inputs || []).map(normalizePath).filter(Boolean))];
  const classified = changed.map((path) => ({ path, impact: classifyCatalogPath(path) }));
  if (classified.some((item) => item.impact === 'full')) {
    return { mode: 'full', fastAssets: [], classified };
  }
  const fastAssets = [...new Set(classified
    .map((item) => item.impact)
    .filter((impact) => impact === 'applications' || impact === 'compatibility'))].sort();
  return { mode: fastAssets.length ? 'root-assets' : 'none', fastAssets, classified };
}

export function isPromotionOnlyPush(codeRef, eventName) {
  return String(eventName || '').trim() === 'push' &&
    PROMOTION_ONLY_PUSH_REFS.has(String(codeRef || '').trim());
}

export function assertPromotionPushReusesSnapshot({ eventName, codeRef, source, snapshotImpact } = {}) {
  if (!isPromotionOnlyPush(codeRef, eventName)) return false;
  if (!source?.dataBranch || !source?.codeRef) {
    throw new Error(`Catalog promotion push ${codeRef} requires a validated predecessor snapshot`);
  }
  if (!snapshotImpact || snapshotImpact.mode !== 'none') {
    throw new Error(`Catalog promotion push ${codeRef} cannot start heavy generation; generate and validate runtime data in the source lane first`);
  }
  return true;
}

export function catalogPromotionImpact(pushImpact, snapshotImpact, identity = {}) {
  if (snapshotImpact?.mode !== 'none') return pushImpact;
  return {
    ...pushImpact,
    mode: 'none',
    fastAssets: [],
    reuseSource: String(identity.dataBranch || ''),
    snapshotBaseSha: String(identity.baseSha || ''),
  };
}

function gitText(args, cwd = ROOT, stdio = ['ignore', 'pipe', 'pipe']) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio }).trim();
}

function ensureCommitAvailable(sha, cwd = ROOT) {
  try {
    execFileSync('git', ['cat-file', '-e', `${sha}^{commit}`], { cwd, stdio: 'ignore' });
  } catch {
    execFileSync('git', ['fetch', '--no-tags', '--depth=1', 'origin', sha], { cwd, stdio: 'ignore' });
    execFileSync('git', ['cat-file', '-e', `${sha}^{commit}`], { cwd, stdio: 'ignore' });
  }
}

function ensureAncestorAvailable(base, target, cwd = ROOT) {
  try {
    execFileSync('git', ['merge-base', '--is-ancestor', base, target], { cwd, stdio: 'ignore' });
    return;
  } catch (initialError) {
    const shallow = gitText(['rev-parse', '--is-shallow-repository'], cwd);
    if (shallow !== 'true') throw initialError;
    execFileSync('git', ['fetch', '--no-tags', '--unshallow', 'origin'], { cwd, stdio: 'ignore' });
    ensureCommitAvailable(base, cwd);
    ensureCommitAvailable(target, cwd);
    execFileSync('git', ['merge-base', '--is-ancestor', base, target], { cwd, stdio: 'ignore' });
  }
}

function readRemoteSnapshot(dataBranch, cwd = ROOT) {
  const remoteRef = `refs/remotes/origin/${dataBranch}`;
  execFileSync('git', [
    'fetch', '--no-tags', '--depth=1', 'origin',
    `refs/heads/${dataBranch}:${remoteRef}`,
  ], { cwd, stdio: 'ignore' });
  return JSON.parse(gitText(['show', `${remoteRef}:index.json`], cwd));
}

export function catalogImpactBetweenCommits(baseSha, targetSha, { cwd = ROOT } = {}) {
  const base = String(baseSha || '').trim().toLowerCase();
  const target = String(targetSha || '').trim().toLowerCase();
  if (!GIT_SHA_RE.test(base) || !GIT_SHA_RE.test(target)) throw new Error('Catalog snapshot comparison requires full Git SHAs');
  ensureCommitAvailable(base, cwd);
  ensureCommitAvailable(target, cwd);
  ensureAncestorAvailable(base, target, cwd);
  const output = gitText(['diff', '--name-only', base, target], cwd);
  const changed = output ? output.split(/\r?\n/).filter(Boolean) : [];
  return catalogChangeImpact(changed);
}

export function promotionAwareCatalogChangeImpact(inputs, {
  eventName = process.env.GITHUB_EVENT_NAME || '',
  codeRef = process.env.GITHUB_REF_NAME || '',
  targetSha = process.env.GITHUB_SHA || '',
  cwd = ROOT,
  warn = (message) => process.stderr.write(`${message}\n`),
} = {}) {
  const pushImpact = catalogChangeImpact(inputs);
  if (eventName !== 'push' || !codeRef || !GIT_SHA_RE.test(String(targetSha || '').trim())) return pushImpact;
  const promotionOnly = isPromotionOnlyPush(codeRef, eventName);
  const source = configuredReuseSourceForCodeRef(codeRef, { cwd });
  if (!source?.dataBranch || !source?.codeRef) {
    if (promotionOnly) assertPromotionPushReusesSnapshot({ eventName, codeRef, source });
    return pushImpact;
  }

  try {
    const index = readRemoteSnapshot(source.dataBranch, cwd);
    const provenance = index?.provenance || {};
    const baseSha = String(provenance.codeSha || '').trim().toLowerCase();
    const assetRef = String(index?.assetRef || '').trim().toLowerCase();
    if (provenance.complete !== true || provenance.codeRef !== source.codeRef ||
        !GIT_SHA_RE.test(baseSha) || !GIT_SHA_RE.test(assetRef)) {
      if (promotionOnly) {
        throw new Error(`Catalog predecessor ${source.dataBranch} is not a complete reusable snapshot for ${source.codeRef}`);
      }
      return pushImpact;
    }
    const snapshotImpact = catalogImpactBetweenCommits(baseSha, targetSha, { cwd });
    assertPromotionPushReusesSnapshot({ eventName, codeRef, source, snapshotImpact });
    const result = catalogPromotionImpact(pushImpact, snapshotImpact, {
      dataBranch: source.dataBranch,
      baseSha,
    });
    if (result.mode === 'none' && pushImpact.mode !== 'none') {
      warn(`Reusable Catalog snapshot ${source.dataBranch}@${assetRef} already covers the target Data Surface; skip duplicate heavy generation.`);
    }
    return result;
  } catch (error) {
    if (promotionOnly) {
      throw new Error(`Catalog promotion push ${codeRef} is fail-closed: ${error.message}`);
    }
    warn(`Catalog snapshot reuse precheck unavailable; keep conservative ${pushImpact.mode} mode: ${error.message}`);
    return pushImpact;
  }
}

export function catalogImpactRegistryCoverage(root = ROOT) {
  const managed = [
    ...readdirSync(resolve(root, 'scripts')).map((name) => `scripts/${name}`),
    ...readdirSync(resolve(root, 'translations')).map((name) => `translations/${name}`),
    ...readdirSync(root).filter((name) => name.endsWith('.json')),
    ...MANAGED_WORKFLOWS,
  ].sort();
  const missing = managed.filter((path) => !CLASS_BY_PATH.has(path));
  const stale = [...CLASS_BY_PATH.keys()].filter((path) => isManagedPath(path) && !managed.includes(path)).sort();
  return { managed, missing, stale };
}

function printResult(paths) {
  const result = promotionAwareCatalogChangeImpact(paths);
  process.stdout.write(`mode=${result.mode}\n`);
  process.stdout.write(`fast_assets=${result.fastAssets.join(',')}\n`);
  process.stdout.write(`classified=${JSON.stringify(result.classified)}\n`);
  if (result.reuseSource) process.stdout.write(`reuse_source=${result.reuseSource}\n`);
  if (result.snapshotBaseSha) process.stdout.write(`snapshot_base_sha=${result.snapshotBaseSha}\n`);
}

const invokedDirectly = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  if (process.argv.includes('--check-registry')) {
    const coverage = catalogImpactRegistryCoverage();
    if (coverage.missing.length || coverage.stale.length) {
      if (coverage.missing.length) console.error(`Unclassified managed files:\n${coverage.missing.join('\n')}`);
      if (coverage.stale.length) console.error(`Stale Catalog impact registry entries:\n${coverage.stale.join('\n')}`);
      process.exit(1);
    }
    console.log(`Catalog impact registry covers ${coverage.managed.length} managed files.`);
  } else {
    printResult(process.argv.slice(2));
  }
}

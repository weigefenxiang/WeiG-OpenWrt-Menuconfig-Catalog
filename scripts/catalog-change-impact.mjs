#!/usr/bin/env node
import { readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));

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
    '.github/workflows/catalog.yml',
    'catalog.config.json',
    'translations/menu-i18n.json',
    'translations/zh-CN.json',
    'scripts/build-index.mjs',
    'scripts/clone-upstream.sh',
    'scripts/collect-results.mjs',
    'scripts/compact-relations.mjs',
    'scripts/discover.mjs',
    'scripts/generate-catalog.mjs',
    'scripts/index-contract.mjs',
    'scripts/kconfig-relations.mjs',
    'scripts/lib.mjs',
    'scripts/prepare-metadata.sh',
    'scripts/source-policy.mjs',
  ]),
  none: Object.freeze([
    'package.json',
    'scripts/catalog-change-impact.mjs',
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
    'scripts/profile-config-contract.mjs',
    'scripts/publish-release.sh',
    'scripts/refresh-curated-applications.mjs',
    'scripts/refresh-curated-sizes.mjs',
    'scripts/requirements-argos.txt',
    'scripts/resolve-translation-provider.mjs',
    'scripts/run-boot-smoke.sh',
    'scripts/run-package-probe.mjs',
    'scripts/run-stage.sh',
    'scripts/stamp-catalog-snapshot.mjs',
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

function isManagedPath(path) {
  return path.startsWith('scripts/') || path.startsWith('translations/') ||
    path === '.github/workflows/catalog.yml' || (!path.includes('/') && path.endsWith('.json'));
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

export function catalogImpactRegistryCoverage(root = ROOT) {
  const managed = [
    ...readdirSync(resolve(root, 'scripts')).map((name) => `scripts/${name}`),
    ...readdirSync(resolve(root, 'translations')).map((name) => `translations/${name}`),
    ...readdirSync(root).filter((name) => name.endsWith('.json')),
    '.github/workflows/catalog.yml',
  ].sort();
  const missing = managed.filter((path) => !CLASS_BY_PATH.has(path));
  const stale = [...CLASS_BY_PATH.keys()].filter((path) => isManagedPath(path) && !managed.includes(path)).sort();
  return { managed, missing, stale };
}

function printResult(paths) {
  const result = catalogChangeImpact(paths);
  process.stdout.write(`mode=${result.mode}\n`);
  process.stdout.write(`fast_assets=${result.fastAssets.join(',')}\n`);
  process.stdout.write(`classified=${JSON.stringify(result.classified)}\n`);
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

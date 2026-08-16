#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  catalogChangeImpact,
  catalogImpactRegistryCoverage,
  classifyCatalogPath,
} from './catalog-change-impact.mjs';
import { pushBeforeSha } from './catalog-channels.mjs';

assert.equal(classifyCatalogPath('.github/workflows/catalog.yml'), 'none');
assert.equal(classifyCatalogPath('.github/workflows/catalog-reuse.yml'), 'none');
assert.equal(classifyCatalogPath('.github/workflows/catalog-production.yml'), 'none');
assert.equal(classifyCatalogPath('scripts/package-probe-controller.mjs'), 'none');
assert.equal(classifyCatalogPath('translations/probe-ui.json'), 'applications');
assert.equal(classifyCatalogPath('compatibility.json'), 'compatibility');
assert.equal(classifyCatalogPath('scripts/generate-catalog.mjs'), 'full');
assert.equal(classifyCatalogPath('scripts/build-index.mjs'), 'full');
assert.equal(classifyCatalogPath('scripts/generate-profile-config-groups.mjs'), 'full');
assert.equal(classifyCatalogPath('scripts/profile-config-contract.mjs'), 'full');
assert.equal(classifyCatalogPath('scripts/catalog-change-impact.mjs'), 'none');
assert.equal(classifyCatalogPath('scripts/stamp-catalog-snapshot.mjs'), 'none');
assert.equal(classifyCatalogPath('scripts/check-profile-config-groups.mjs'), 'none');
assert.equal(classifyCatalogPath('scripts/benchmark-profile-config-groups.mjs'), 'none');
assert.equal(classifyCatalogPath('docs/COMPATIBILITY.md'), 'none');

assert.equal(pushBeforeSha({ before: 'A'.repeat(40) }), 'a'.repeat(40));
assert.equal(pushBeforeSha({ before: '0'.repeat(40) }), '');
assert.equal(pushBeforeSha({ before: 'bad' }), '');

assert.deepEqual(catalogChangeImpact([
  'scripts/package-probe-controller.mjs',
  'scripts/check-package-probe.mjs',
]), { mode: 'none', fastAssets: [], classified: [
  { path: 'scripts/package-probe-controller.mjs', impact: 'none' },
  { path: 'scripts/check-package-probe.mjs', impact: 'none' },
] });
assert.equal(catalogChangeImpact([
  '.github/workflows/catalog.yml',
  'scripts/catalog-change-impact.mjs',
]).mode, 'none');
assert.equal(catalogChangeImpact([
  'scripts/generate-profile-config-groups.mjs',
  'scripts/check-profile-config-groups.mjs',
]).mode, 'full');
assert.equal(catalogChangeImpact([
  'scripts/profile-config-contract.mjs',
]).mode, 'full');
assert.equal(catalogChangeImpact([
  'scripts/stamp-catalog-snapshot.mjs',
  'scripts/check-catalog-snapshot.mjs',
]).mode, 'none');
assert.equal(catalogChangeImpact([
  'scripts/build-index.mjs',
]).mode, 'full');

assert.deepEqual(catalogChangeImpact([
  'translations/probe-ui.json',
  'curated-sizes.json',
]).fastAssets, ['applications']);
assert.deepEqual(catalogChangeImpact([
  'translations/probe-ui.json',
  'compatibility.json',
]), { mode: 'root-assets', fastAssets: ['applications', 'compatibility'], classified: [
  { path: 'translations/probe-ui.json', impact: 'applications' },
  { path: 'compatibility.json', impact: 'compatibility' },
] });
assert.equal(catalogChangeImpact([
  'translations/probe-ui.json',
  'scripts/generate-catalog.mjs',
]).mode, 'full');

assert.throws(() => classifyCatalogPath('scripts/new-catalog-output.mjs'), /Unclassified Catalog-impact file/);
assert.throws(() => classifyCatalogPath('translations/new-runtime-ui.json'), /Unclassified Catalog-impact file/);

const catalogWorkflow = readFileSync(resolve('.github/workflows/catalog.yml'), 'utf8');
assert(!catalogWorkflow.includes('- "scripts/**"'), 'Menuconfig Catalog push must not watch every script');
assert(!catalogWorkflow.includes('- ".github/workflows/catalog.yml"'), 'Menuconfig Catalog push must not self-trigger on control changes');
for (const required of [
  'scripts/generate-catalog.mjs', 'scripts/generate-profile-config-groups.mjs',
  'scripts/profile-config-contract.mjs', 'scripts/build-index.mjs', 'catalog.config.json',
  'translations/menu-i18n.json', 'translations/zh-CN.json', 'compatibility.json', 'curated-sizes.json',
]) {
  assert(catalogWorkflow.includes(`- "${required}"`), `Catalog runtime input missing from push.paths: ${required}`);
}

const coverage = catalogImpactRegistryCoverage();
assert.deepEqual(coverage.missing, []);
assert.deepEqual(coverage.stale, []);
console.log(`Catalog change impact checks passed (${coverage.managed.length} managed files).`);

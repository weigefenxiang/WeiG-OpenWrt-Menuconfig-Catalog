#!/usr/bin/env node
import assert from 'node:assert/strict';
import {
  catalogChangeImpact,
  catalogImpactRegistryCoverage,
  classifyCatalogPath,
} from './catalog-change-impact.mjs';

assert.equal(classifyCatalogPath('.github/workflows/catalog.yml'), 'full');
assert.equal(classifyCatalogPath('.github/workflows/catalog-reuse.yml'), 'none');
assert.equal(classifyCatalogPath('scripts/package-probe-controller.mjs'), 'none');
assert.equal(classifyCatalogPath('translations/probe-ui.json'), 'applications');
assert.equal(classifyCatalogPath('compatibility.json'), 'compatibility');
assert.equal(classifyCatalogPath('scripts/generate-catalog.mjs'), 'full');
assert.equal(classifyCatalogPath('docs/COMPATIBILITY.md'), 'none');

assert.deepEqual(catalogChangeImpact([
  'scripts/package-probe-controller.mjs',
  'scripts/check-package-probe.mjs',
]), { mode: 'none', fastAssets: [], classified: [
  { path: 'scripts/package-probe-controller.mjs', impact: 'none' },
  { path: 'scripts/check-package-probe.mjs', impact: 'none' },
] });
assert.equal(catalogChangeImpact([
  '.github/workflows/catalog.yml',
  'scripts/package-probe-controller.mjs',
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

const coverage = catalogImpactRegistryCoverage();
assert.deepEqual(coverage.missing, []);
assert.deepEqual(coverage.stale, []);
console.log(`Catalog change impact checks passed (${coverage.managed.length} managed files).`);

#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  assertPromotionPushReusesSnapshot,
  catalogChangeImpact,
  catalogImpactRegistryCoverage,
  catalogPromotionImpact,
  classifyCatalogPath,
  isPromotionOnlyPush,
} from './catalog-change-impact.mjs';
import { configuredReuseSourceForCodeRef, pushBeforeSha } from './catalog-channels.mjs';

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

assert.deepEqual(configuredReuseSourceForCodeRef('dev'), {
  codeRef: 'dev', dataBranch: 'catalog-dev',
}, 'dev promotion must use the canonical catalog-dev fallback when no explicit reuse marker exists');
assert.deepEqual(configuredReuseSourceForCodeRef('staging'), {
  codeRef: 'dev', dataBranch: 'catalog-dev',
}, 'staging promotion must preserve the canonical catalog-dev predecessor');
assert.deepEqual(configuredReuseSourceForCodeRef('main'), {
  codeRef: 'main', dataBranch: 'catalog-main',
}, 'main promotion must preserve the current production catalog-main snapshot');

for (const ref of ['dev', 'staging', 'main']) {
  assert.equal(isPromotionOnlyPush(ref, 'push'), true, `${ref} push must be promotion-only`);
  assert.equal(assertPromotionPushReusesSnapshot({
    eventName: 'push',
    codeRef: ref,
    source: { codeRef: ref === 'dev' ? 'dev' : ref === 'staging' ? 'dev' : 'main', dataBranch: 'catalog-source' },
    snapshotImpact: { mode: 'none' },
  }), true, `${ref} promotion must accept an unchanged validated snapshot`);
  assert.throws(() => assertPromotionPushReusesSnapshot({
    eventName: 'push',
    codeRef: ref,
    source: { codeRef: 'source', dataBranch: 'catalog-source' },
    snapshotImpact: { mode: 'full' },
  }), /cannot start heavy generation/, `${ref} promotion must fail closed instead of falling back to heavy generation`);
  assert.throws(() => assertPromotionPushReusesSnapshot({
    eventName: 'push',
    codeRef: ref,
    snapshotImpact: { mode: 'none' },
  }), /requires a validated predecessor snapshot/, `${ref} promotion must fail when no predecessor snapshot is proven`);
}
assert.equal(isPromotionOnlyPush('fix-F', 'push'), false, 'fix lanes may generate new runtime data when necessary');
assert.equal(isPromotionOnlyPush('main', 'schedule'), false, 'scheduled upstream refresh is not a code-promotion push');
assert.equal(isPromotionOnlyPush('main', 'workflow_dispatch'), false, 'explicit manual generation is not a code-promotion push');

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

const pushFull = catalogChangeImpact(['scripts/profile-config-contract.mjs']);
const snapshotSame = catalogChangeImpact([]);
const promoted = catalogPromotionImpact(pushFull, snapshotSame, {
  dataBranch: 'catalog-fix-F', baseSha: 'a'.repeat(40),
});
assert.equal(promoted.mode, 'none', 'matching snapshot Data Surface must suppress duplicate heavy generation');
assert.equal(promoted.reuseSource, 'catalog-fix-F');
assert.equal(promoted.snapshotBaseSha, 'a'.repeat(40));
assert.equal(catalogPromotionImpact(pushFull,
  catalogChangeImpact(['scripts/profile-config-contract.mjs'])).mode, 'full',
'changed snapshot Data Surface must keep full generation enabled outside promotion-only pushes');

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
assert.match(catalogWorkflow, /node scripts\/catalog-change-impact\.mjs/, 'heavy workflow must pass through the promotion-aware Data Surface gate');
assert.match(catalogWorkflow, /needs\.mode\.outputs\.mode == 'full'/, 'heavy discover/generate jobs must require explicit full mode');
for (const required of [
  'scripts/generate-catalog.mjs', 'scripts/generate-profile-config-groups.mjs',
  'scripts/profile-config-contract.mjs', 'scripts/build-index.mjs', 'catalog.config.json',
  'translations/menu-i18n.json', 'translations/zh-CN.json', 'compatibility.json', 'curated-sizes.json',
]) {
  assert(catalogWorkflow.includes(`- "${required}"`), `Catalog runtime input missing from push.paths: ${required}`);
}

const reuseWorkflow = readFileSync(resolve('.github/workflows/catalog-reuse.yml'), 'utf8');
assert.match(reuseWorkflow, /node scripts\/catalog-change-impact\.mjs/, 'snapshot reuse must use the same promotion-aware Data Surface gate');
assert.match(reuseWorkflow, /needs\.preflight\.outputs\.reuse == 'true'/, 'snapshot promotion must require verified reusable identity');

const coverage = catalogImpactRegistryCoverage();
assert.deepEqual(coverage.missing, []);
assert.deepEqual(coverage.stale, []);
console.log(`Catalog zero-heavy promotion and change impact checks passed (${coverage.managed.length} managed files).`);

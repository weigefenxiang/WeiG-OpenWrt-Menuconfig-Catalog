#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildTargetTree,
  incompleteSelectableTargets,
  parseInfoRecords,
  parseKconfigTree,
  parsePackageInfo,
  resolvePackageOption,
  resolveTargetSelectors,
  targetBuildContract,
} from './lib.mjs';
import { buildKconfigRelations } from './kconfig-relations.mjs';
import { compactRelations, expandCompactRelations } from './compact-relations.mjs';
import { buildCatalogSizeReport } from './catalog-size-report.mjs';
import { normalizeCompatibilityDocument } from './compatibility-rules.mjs';
import { buildProbeConfig, verifyProbeConfig } from './verify-target-contracts.mjs';
import { activeCuratedGroups, buildCuratedApplications } from './curated-applications.mjs';
import { aggregateCuratedSizes, parseApkDump, parseOpkgPackages } from './curated-sizes.mjs';
import { sourceAllowsBranch } from './source-policy.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const fixture = join(ROOT, 'tests', 'fixture');
const read = (...parts) => readFileSync(join(ROOT, ...parts), 'utf8');
const json = (...parts) => JSON.parse(read(...parts));

// Public project identity and licensing must remain self-contained for forks.
const license = read('LICENSE');
const notice = read('NOTICE');
const reuse = read('REUSE.toml');
const licenseZh = read('LICENSE.zh-CN.md');
assert(license.includes('GNU GENERAL PUBLIC LICENSE'));
assert(license.includes('Version 3, 29 June 2007'));
assert(license.includes('END OF TERMS AND CONDITIONS'));
assert(notice.includes('GPL-3.0-or-later'));
assert(notice.includes('weigefenxiang@gmail.com'));
assert(reuse.includes('SPDX-License-Identifier = "GPL-3.0-or-later"'));
assert(licenseZh.includes('非官方中文说明'));

const policy = json('catalog.config.json');
const compatibility = json('compatibility.json');
const automation = json('.github', 'automation-policy.json');
const translations = json('translations', 'zh-CN.json');
const menuI18n = json('translations', 'menu-i18n.json');

// Source/Branch policy is data-driven and future branches stay discoverable.
assert.equal(policy.sources.length, 4);
const immortal = policy.sources.find((row) => row.id === 'ImmortalWrt');
const openwrt = policy.sources.find((row) => row.id === 'OpenWrt');
const lede = policy.sources.find((row) => row.id === 'lede');
assert(immortal && openwrt && lede);
assert.deepEqual(immortal.branches?.include, ['master', 'openwrt-*']);
assert(sourceAllowsBranch(immortal, 'master'));
assert(sourceAllowsBranch(immortal, 'openwrt-30.01'));
assert(!sourceAllowsBranch(immortal, 'main'));
assert.deepEqual(openwrt.branches?.include, ['main', 'openwrt-*']);
assert(sourceAllowsBranch(openwrt, 'main'));
assert(!sourceAllowsBranch(openwrt, 'master'));
assert(sourceAllowsBranch(lede, 'master'));
assert(sourceAllowsBranch(lede, 'openwrt-30.01'));

// Official Target/Profile parsing and selector contracts.
const targets = parseInfoRecords(readFileSync(join(fixture, 'targetinfo'), 'utf8'));
const menu = parseKconfigTree(fixture);
const symbols = new Set((menu.allOptions || menu.options).map((row) => row.symbol));
for (const target of targets) {
  target.contract = targetBuildContract(target, symbols);
  target.targetSelector = target.contract.targetSelector || '';
  const profileContracts = new Map((target.contract.profileContracts || []).map((row) => [row.id, row]));
  for (const profile of target.profiles) {
    const contract = profileContracts.get(profile.id);
    profile.selector = contract?.selector || '';
    profile.selectable = contract?.selectable !== false;
  }
}
assert.equal(targets.length, 4);
assert.equal(targets.find((row) => row.id === 'x86/64')?.arch, 'x86_64');
assert.equal(targets.find((row) => row.id === 'mediatek/filogic')?.arch, 'aarch64');
assert.equal(targetBuildContract(targets.find((row) => row.id === 'abstract-board')).kind, 'abstract');
assert.equal(targetBuildContract(targets.find((row) => row.id === 'unavailable-board')).kind, 'unavailable');
assert.deepEqual(incompleteSelectableTargets(targets).map((row) => row.id), ['unavailable-board']);

const targetTree = buildTargetTree(targets.filter((row) => row.contract.selectable), menu.options);
const x86 = targetTree.find((row) => row.value === 'x86');
const x8664 = x86?.children.find((row) => row.value === '64');
assert.equal(x86?.labelEn, 'x86');
assert.equal(x8664?.labelEn, 'x86_64');
assert.deepEqual(x8664?.children.map((row) => row.labelEn), ['Generic x86/64', 'QEMU Q35']);

const x86Target = targets.find((row) => row.id === 'x86/64');
const x86Profile = x86Target?.profiles[0];
const selectors = resolveTargetSelectors(x86Target, x86Profile);
const probe = buildProbeConfig(x86Target, x86Profile, selectors);
assert(probe.includes('CONFIG_TARGET_x86=y'));
assert(verifyProbeConfig(probe, x86Target, x86Profile, selectors).valid);
assert(!verifyProbeConfig(probe.replace(`CONFIG_${selectors.profile}=y`, `# CONFIG_${selectors.profile} is not set`),
  x86Target, x86Profile, selectors).valid);

// Package/menu metadata and generic Kconfig relation graph.
const packages = parsePackageInfo(readFileSync(join(fixture, 'packageinfo'), 'utf8'));
assert.equal(packages.length, 3);
assert.equal(packages[0].category, 'LuCI');
assert.equal(packages[0].description, 'Demonstration web interface package');
assert.deepEqual(packages[0].conflicts, ['kmod-demo']);
const packageInfoOnly = parsePackageInfo('Package: luci-app-packageinfo-only\nTitle: Metadata only\nDescription: No Kconfig symbol\n');
assert.equal(resolvePackageOption(packageInfoOnly[0], new Set(['packageinfo-only'])), '');

const demo = menu.options.find((row) => row.symbol === 'PACKAGE_luci-app-demo');
const luci = menu.options.find((row) => row.symbol === 'PACKAGE_luci');
const hiddenLanguage = (menu.allOptions || menu.options).find((row) => row.symbol === 'PACKAGE_luci-i18n-demo-zh-cn');
assert.equal(demo?.type, 'tristate');
assert(demo?.depends.includes('TARGET_x86'));
assert(demo?.help?.includes('if the application is enabled'));
assert.equal(demo?.parent, luci?.symbol);
assert.equal(hiddenLanguage?.visible, false);
assert.equal(hiddenLanguage?.userSettable, false);
assert.equal(menu.choices.length, 1);

const relations = buildKconfigRelations(menu.allOptions || menu.options, packages, menu.choices);
assert.equal(relations.schema, 2);
const demoRelations = relations.records.find((row) => row.package === 'luci-app-demo');
assert.deepEqual(demoRelations?.states, ['n', 'm', 'y']);
assert(demoRelations?.kconfig.depends.includes('PACKAGE_luci'));
assert(demoRelations?.dependencyPackages.includes('luci-base'));
assert(demoRelations?.conflicts.includes('kmod-demo'));
assert(relations.validation.structurallyValid);
const compact = compactRelations(relations);
const expanded = expandCompactRelations(compact);
assert.equal(compact.schema, 3);
assert.deepEqual(expanded.indexes.reverseDependencies, relations.indexes.reverseDependencies);
assert(Buffer.byteLength(JSON.stringify(compact)) < Buffer.byteLength(JSON.stringify(relations)) * 0.5);

// Duplicate symbols must be merged generically, not by package-specific exceptions.
const duplicate = parseKconfigTree(join(ROOT, 'tests', 'duplicate'));
const rustdesk = duplicate.options.find((row) => row.symbol === 'PACKAGE_luci-app-rustdesk-server');
assert.equal(duplicate.options.length, 1);
assert.equal(rustdesk?.nodes?.length, 2);
assert.equal(duplicate.validation.duplicateCount, 1);
assert.equal(duplicate.validation.conflicts.length, 0);
const hardDuplicate = parseKconfigTree(join(ROOT, 'tests', 'duplicate-hard'));
assert(hardDuplicate.validation.conflicts.length > 0);

// Curated applications/groups and size aggregation remain generic data contracts.
const curated = policy.curatedApplications || [];
const activeGroups = activeCuratedGroups(policy.curatedGroups, curated);
const groupFixture = activeCuratedGroups(['alpha', 'empty', 'alpha', 'beta'], [{ group: 'beta' }, { group: 'alpha' }]);
assert.deepEqual(groupFixture, ['alpha', 'beta']);
assert.equal(activeGroups.length, policy.curatedGroups.length);
const curatedDocument = buildCuratedApplications(ROOT);
assert.deepEqual(curatedDocument.groups, activeGroups);
assert.equal(curatedDocument.items.length, curated.length);
assert(curatedDocument.items.every((row) => row.id && row.titleZh && row.usageZh));
assert.equal(new Set(curated.flatMap((row) => row.packages || [])).size,
  curated.reduce((count, row) => count + (row.packages?.length || 0), 0));

const opkg = parseOpkgPackages('Package: luci-app-demo\nSize: 100\nInstalled-Size: 250\nDepends: demo-lib (>= 1), +demo-data\n\n' +
  'Package: demo-lib\nSize: 20\n\nPackage: demo-data\nSize: 5\n');
const apk = parseApkDump({ packages: [
  { info: { name: 'luci-app-demo', file_size: 120, installed_size: 280, depends: ['demo-lib>=1'] } },
  { info: { name: 'demo-lib', file_size: 30, depends: [] } },
] });
assert.equal(opkg[0].installedSize, 250);
assert.equal(apk[0].installedSize, 280);
const sizes = aggregateCuratedSizes(['luci-app-demo'], [{ source: 'opkg', packages: opkg }, { source: 'apk', packages: apk }]);
assert.equal(sizes.bytes['luci-app-demo'], 150);
assert.equal(sizes.coverage['luci-app-demo']?.length, 2);
const sizeRows = buildCatalogSizeReport([{ source: { id: 'fixture', branch: 'test', commit: 'a'.repeat(40) },
  sizeReport: { legacy: { bytes: 1000 }, split: { initialBytes: 300, bytes: 700 }, readableRelationsJsonBytes: 10000, compactRelationsJsonBytes: 2500 } }]);
assert.equal(sizeRows[0].initialReductionPercent, 70);
assert.equal(sizeRows[0].relationsReductionPercent, 75);

// Compatibility v4 adds bounded build-dependency evidence while v2/v3 remain readable.
const normalizedCompatibility = normalizeCompatibilityDocument(compatibility, policy);
assert.equal(normalizedCompatibility.schema, 4);
assert.equal(normalizedCompatibility.rules.length, 5);
assert.equal(normalizedCompatibility.rules[0]?.id, 'OWN-0001');
assert.equal(normalizedCompatibility.rules[0]?.issue, 'file-ownership');
assert.throws(() => normalizeCompatibilityDocument({ schema: 1, rules: [] }, policy));
assert.equal(normalizeCompatibilityDocument({ schema: 2, rules: [] }, policy).schema, 2);
assert.equal(normalizeCompatibilityDocument({ schema: 3, rules: [] }, policy).schema, 3);
assert.equal(normalizedCompatibility.rules.find((rule) => rule.id === 'BLD-0003')?.sourceCommits?.[0],
  '6081813a7ec91aba6555a74dc3f4d34f504f8a53');
const dockerdRule = normalizedCompatibility.rules.find((rule) => rule.id === 'BLD-0003');
assert.deepEqual(dockerdRule?.buildDependency, {
  package: 'dockerd', triggerPackages: ['docker', 'containerd', 'runc', 'tini'],
});
assert.equal(normalizedCompatibility.rules.find((rule) => rule.id === 'BLD-0004'), undefined);
assert.equal(normalizedCompatibility.rules.find((rule) => rule.id === 'BLD-0005')?.failure?.phase,
  'rootfs-install');
assert(!dockerdRule.buildDependency.triggerPackages.includes('docker-compose'));
assert(!dockerdRule.buildDependency.triggerPackages.some((packageId) => packageId.startsWith('luci-')));

// Schema-4 build dependency evidence is strict, bounded by exact source commits,
// and unavailable to file-ownership or legacy schema-3 rules.
const rawDockerdRule = compatibility.rules.find((rule) => rule.id === 'BLD-0003');
const withBuildDependency = (buildDependency, overrides = {}) => ({
  ...rawDockerdRule, ...overrides, buildDependency,
});
assert.throws(() => normalizeCompatibilityDocument({
  schema: 4, rules: [withBuildDependency({ package: 'dockerd', triggerPackages: ['docker'], extra: true })],
}, policy), /buildDependency contains unsupported field: extra/);
assert.throws(() => normalizeCompatibilityDocument({
  schema: 4, rules: [withBuildDependency({ package: 'dockerd', triggerPackages: ['docker'] }, { sourceCommits: undefined })],
}, policy), /buildDependency requires exact sourceCommits/);
assert.throws(() => normalizeCompatibilityDocument({
  schema: 4, rules: [withBuildDependency({ package: 'dockerd', triggerPackages: ['docker/compose'] })],
}, policy), /triggerPackages\[0\] must be a valid package ID/);
assert.throws(() => normalizeCompatibilityDocument({
  schema: 4, rules: [withBuildDependency({ package: 'not-dockerd', triggerPackages: ['docker'] })],
}, policy), /buildDependency\.package must be listed in the rule packages/);
assert.throws(() => normalizeCompatibilityDocument({
  schema: 4, rules: [withBuildDependency({ package: 'dockerd', triggerPackages: ['dockerd'] })],
}, policy), /triggerPackages must not include the failed package/);
assert.throws(() => normalizeCompatibilityDocument({
  schema: 4, rules: [{ ...compatibility.rules[0], buildDependency: { package: 'openvpn-openssl', triggerPackages: ['openvpn-openssl'] } }],
}, policy), /buildDependency is only valid for build-failure/);
assert.throws(() => normalizeCompatibilityDocument({
  schema: 3, rules: [withBuildDependency({ package: 'dockerd', triggerPackages: ['docker'] })],
}, policy), /contains unsupported field: buildDependency/);

// Public translation and automation policy contracts.
assert.deepEqual(translations.policy?.languages, ['en', 'zh-CN', 'zh-TW', 'ru', 'es', 'pt', 'ja', 'ko', 'de', 'fr', 'vi']);
assert(translations.entries?.['PACKAGE_luci-app-samba4']?.usageZh);
assert(translations.entries?.['PACKAGE_luci-app-samba4']?.usageI18n?.de);
for (const label of ['Top level', 'General settings', 'Global build settings', 'LuCI']) {
  for (const language of ['zh-CN', 'zh-TW', 'ru', 'es', 'pt', 'ja', 'ko', 'de', 'fr', 'vi']) {
    assert(menuI18n[label]?.[language], `missing menu i18n: ${label}/${language}`);
  }
}
assert.equal(automation.schema, 1);
assert.equal(automation.probe?.collaboratorMaxParallel, 3);
assert.equal(automation.probe?.maxMatrixJobs, 256);
assert.equal(automation.probe?.normalizedEvidenceDays, 60);
assert.equal(automation.probe?.fullLogDays, 30);
assert.equal(automation.translation?.defaultDataBranch, 'catalog-candidate');
assert.equal(automation.translation?.batchSize, 500);
assert.equal(automation.translation?.batchCount, 5);
assert.equal(automation.translation?.totalItemLimit, 5000);
assert.equal(automation.translation?.totalTimeBudgetSeconds, 3000);
assert.equal(automation.catalog?.cloneAttempts, 3);

console.log(`catalog checks passed: ${targets.length} targets, ${packages.length} packages, ${(menu.options || []).length} visible / ${(menu.allOptions || menu.options).length} total Kconfig options`);

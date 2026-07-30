#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseInfoRecords, parseKconfigTree, parsePackageInfo } from './lib.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const fixture = join(ROOT, 'tests', 'fixture');
const targets = parseInfoRecords(readFileSync(join(fixture, 'targetinfo'), 'utf8'));
const packages = parsePackageInfo(readFileSync(join(fixture, 'packageinfo'), 'utf8'));
const menu = parseKconfigTree(fixture);
const workflow = readFileSync(join(ROOT, '.github', 'workflows', 'catalog.yml'), 'utf8');
const discover = readFileSync(join(ROOT, 'scripts', 'discover.mjs'), 'utf8');
const metadata = readFileSync(join(ROOT, 'scripts', 'prepare-metadata.sh'), 'utf8');
const stageRunner = readFileSync(join(ROOT, 'scripts', 'run-stage.sh'), 'utf8');
const attemptWriter = readFileSync(join(ROOT, 'scripts', 'write-attempt.mjs'), 'utf8');
const collector = readFileSync(join(ROOT, 'scripts', 'collect-results.mjs'), 'utf8');
const release = readFileSync(join(ROOT, 'scripts', 'publish-release.sh'), 'utf8');
const policy = JSON.parse(readFileSync(join(ROOT, 'catalog.config.json'), 'utf8'));
const generator = readFileSync(join(ROOT, 'scripts', 'generate-catalog.mjs'), 'utf8');
const menuI18n = JSON.parse(readFileSync(join(ROOT, 'translations', 'menu-i18n.json'), 'utf8'));
const translations = JSON.parse(readFileSync(join(ROOT, 'translations', 'zh-CN.json'), 'utf8'));
const autoTranslator = readFileSync(join(ROOT, 'scripts', 'translate-catalog.mjs'), 'utf8');
const failures = [];
const unsafePlainRunContinuation = /^\s*run:\s+[^\n]*\\\s*$/m.test(workflow);
if (targets.length !== 2 || targets.reduce((n, item) => n + item.profiles.length, 0) !== 3) failures.push('targetinfo');
if (packages.length !== 2 || packages[0].category !== 'LuCI' ||
    packages[0].description !== 'Demonstration web interface package') failures.push('packageinfo');
const demo = menu.options.find((item) => item.symbol === 'PACKAGE_luci-app-demo');
const luci = menu.options.find((item) => item.symbol === 'PACKAGE_luci');
const demoExtra = menu.options.find((item) => item.symbol === 'PACKAGE_luci-app-demo-extra');
const image = menu.options.find((item) => item.symbol === 'TARGET_IMAGES_GZIP');
if (!demo || demo.type !== 'tristate' || !demo.depends.includes('TARGET_x86') ||
    demo.depends.some((item) => item.includes('sentence remains help')) ||
    !demo.help?.includes('if the application is enabled') ||
    !demo.help?.includes('menu, endmenu and source')) failures.push('help/tristate/dependency');
if (!luci || luci.kind !== 'menuconfig' || demo?.parent !== luci.symbol ||
    demoExtra?.parent !== demo?.symbol) failures.push('implicit menuconfig hierarchy');
if (!image || image.path[0] !== 'Target Images') failures.push('menu path');
if (menu.choices.length !== 1 || !menu.options.some((item) => item.choice)) failures.push('choice');
if (!workflow.includes('scripts/prepare-metadata.sh') ||
    workflow.includes('max-parallel:') ||
    workflow.includes('apt-get') ||
    !workflow.includes('fail-fast: false') ||
    !workflow.includes("if: needs.generate.result == 'success'") ||
    !workflow.includes('scripts/write-attempt.mjs') ||
    !workflow.includes('scripts/run-stage.sh') ||
    !workflow.includes('pattern: "*-catalog-*"') ||
    !workflow.includes('attempts/*--SUMMARY.txt') ||
    !workflow.includes('retention-days: 14') ||
    !workflow.includes('actions/upload-artifact@v7') ||
    !workflow.includes('actions/download-artifact@v8') ||
    !workflow.includes('models: read') ||
    !workflow.includes('scripts/translate-catalog.mjs') ||
    !workflow.includes('01 · Discover / 发现源码分支') ||
    !workflow.includes('matrix.jobName') ||
    !workflow.includes('matrix.artifactPrefix') ||
    !workflow.includes('publish-order') ||
    !workflow.includes('Upload publish diagnostic') ||
    !workflow.includes('scripts/collect-results.mjs') ||
    !workflow.includes('run: bash scripts/run-stage.sh index node scripts/build-index.mjs dist dist/index.json previous/index.json current-attempts') ||
    unsafePlainRunContinuation) failures.push('workflow resilience');
if (!discover.includes("'openwrt-18.06', 'openwrt-19.07'") ||
    !discover.includes('metadataCompat') ||
    !metadata.includes('touch staging_dir/host/.prereq-build') ||
    !metadata.includes('make defconfig FORCE=1')) failures.push('legacy metadata compatibility');
if (!stageRunner.includes('Source ID:') ||
    !stageRunner.includes('Upstream commit:') ||
    !stageRunner.includes('CATALOG_ARTIFACT_NAME') ||
    !stageRunner.includes('CATALOG_ORDER') ||
    !stageRunner.includes('last 40 relevant lines') ||
    !attemptWriter.includes('--SUMMARY.txt') ||
    !attemptWriter.includes('failureLog') ||
    !attemptWriter.includes('orderText') ||
    !collector.includes('publish-inputs.json') ||
    !collector.includes('publishState') ||
    !collector.includes('last-good') ||
    !collector.includes('complete=${complete}') ||
    release.includes('gh release delete') ||
    !release.includes('gh release upload') ||
    !release.includes('--clobber')) failures.push('diagnostic identity');
if (policy.sources.length !== 4 || policy.sources[0].id !== 'ImmortalWrt' ||
    policy.sources[0].branches.join(',') !==
      'openwrt-21.02,openwrt-23.05,openwrt-24.10,openwrt-25.12') failures.push('stable branch policy');
const openwrt = policy.sources.find((item) => item.id === 'OpenWrt');
if (openwrt?.branches !== 'all' ||
    openwrt.exclude.join(',') !== 'lede-17.01,pcs-standalone-back,master') failures.push('OpenWrt branch policy');
if (!policy.sources.some((item) => item.id === 'lede' && item.label === 'Lean LEDE')) failures.push('LEDE source policy');
if (!policy.sources.some((item) => item.id === 'hanwckf' &&
    item.repo === 'hanwckf/immortalwrt-mt798x' &&
    item.branches.join(',') === 'openwrt-21.02' && item.legacy === true)) {
  failures.push('hanwckf legacy source policy');
}
if (!generator.includes("option.path[0] !== 'Target Devices'") ||
    !generator.includes('menu: compactMenu') ||
    !generator.includes('targetSelectors') ||
    !generator.includes('targetTree') ||
    !generator.includes('pollutedDependencies') ||
    !generator.includes('menuI18n') ||
    !generator.includes('promptZh') ||
    !generator.includes('.translations.json') ||
    generator.includes('\n  packages,\n')) failures.push('compact payload');
const requiredLanguages = ['zh-CN', 'zh-TW', 'ru', 'es', 'pt', 'ja', 'ko', 'de', 'fr', 'vi'];
if (!['Top level', 'General settings', 'Global build settings', 'LuCI'].every((label) =>
  requiredLanguages.every((lang) => menuI18n[label]?.[lang]))) failures.push('menu i18n');
if (translations.policy?.languages?.join(',') !== 'en,zh-CN,zh-TW,ru,es,pt,ja,ko,de,fr,vi' ||
    !translations.entries?.['PACKAGE_luci-app-samba4']?.usageZh) failures.push('English/Chinese translations');
if (!translations.entries?.['PACKAGE_luci-app-samba4']?.usageI18n?.['zh-TW'] ||
    !translations.entries?.['PACKAGE_luci-app-samba4']?.usageI18n?.de) {
  failures.push('curated 11-language translations');
}
if (!autoTranslator.includes('i18n-cache.json') ||
    !autoTranslator.includes('https://models.github.ai/inference/chat/completions') ||
    !autoTranslator.includes('pendingFields')) failures.push('incremental translation automation');
if (failures.length) throw new Error(`检查失败:${failures.join(',')}`);
console.log(`catalog checks passed: ${targets.length} targets, ${packages.length} packages, ${menu.options.length} visible Kconfig options`);

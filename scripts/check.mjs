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
const policy = JSON.parse(readFileSync(join(ROOT, 'catalog.config.json'), 'utf8'));
const generator = readFileSync(join(ROOT, 'scripts', 'generate-catalog.mjs'), 'utf8');
const translations = JSON.parse(readFileSync(join(ROOT, 'translations', 'zh-CN.json'), 'utf8'));
const failures = [];
if (targets.length !== 2 || targets.reduce((n, item) => n + item.profiles.length, 0) !== 3) failures.push('targetinfo');
if (packages.length !== 2 || packages[0].category !== 'LuCI' ||
    packages[0].description !== 'Demonstration web interface package') failures.push('packageinfo');
const demo = menu.options.find((item) => item.symbol === 'PACKAGE_luci-app-demo');
const luci = menu.options.find((item) => item.symbol === 'PACKAGE_luci');
const demoExtra = menu.options.find((item) => item.symbol === 'PACKAGE_luci-app-demo-extra');
const image = menu.options.find((item) => item.symbol === 'TARGET_IMAGES_GZIP');
if (!demo || demo.type !== 'tristate' || !demo.depends.includes('TARGET_x86')) failures.push('tristate/dependency');
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
    !workflow.includes('pattern: catalog-*') ||
    !workflow.includes('attempts/*--SUMMARY.txt') ||
    !workflow.includes('retention-days: 14') ||
    !workflow.includes('actions/upload-artifact@v7') ||
    !workflow.includes('actions/download-artifact@v8')) failures.push('workflow resilience');
if (!discover.includes("'openwrt-18.06', 'openwrt-19.07'") ||
    !discover.includes('metadataCompat') ||
    !metadata.includes('touch staging_dir/host/.prereq-build') ||
    !metadata.includes('make defconfig FORCE=1')) failures.push('legacy metadata compatibility');
if (!stageRunner.includes('Source ID:') ||
    !stageRunner.includes('Upstream commit:') ||
    !stageRunner.includes('CATALOG_ARTIFACT_NAME') ||
    !stageRunner.includes('last 40 relevant lines') ||
    !attemptWriter.includes('--SUMMARY.txt') ||
    !attemptWriter.includes('failureLog')) failures.push('diagnostic identity');
if (policy.sources.length !== 3 || policy.sources[0].id !== 'ImmortalWrt' ||
    policy.sources[0].branches.join(',') !==
      'openwrt-21.02,openwrt-23.05,openwrt-24.10,openwrt-25.12') failures.push('stable branch policy');
const openwrt = policy.sources.find((item) => item.id === 'OpenWrt');
if (openwrt?.branches !== 'all' ||
    openwrt.exclude.join(',') !== 'lede-17.01,pcs-standalone-back,master') failures.push('OpenWrt branch policy');
if (!policy.sources.some((item) => item.id === 'lede' && item.label === 'Lean LEDE')) failures.push('LEDE source policy');
if (!generator.includes("option.path[0] !== 'Target Devices'") ||
    !generator.includes('menu: compactMenu') ||
    !generator.includes('targetSelectors') ||
    !generator.includes('targetTree') ||
    !generator.includes('promptZh') ||
    !generator.includes('.translations.json') ||
    generator.includes('\n  packages,\n')) failures.push('compact payload');
if (translations.policy?.primary?.join(',') !== 'en,zh-CN' ||
    !translations.entries?.['PACKAGE_luci-app-samba4']?.usageZh) failures.push('English/Chinese translations');
if (failures.length) throw new Error(`检查失败:${failures.join(',')}`);
console.log(`catalog checks passed: ${targets.length} targets, ${packages.length} packages, ${menu.options.length} visible Kconfig options`);

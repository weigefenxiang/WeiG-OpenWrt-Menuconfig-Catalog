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
const policy = JSON.parse(readFileSync(join(ROOT, 'catalog.config.json'), 'utf8'));
const generator = readFileSync(join(ROOT, 'scripts', 'generate-catalog.mjs'), 'utf8');
const failures = [];
if (targets.length !== 2 || targets.reduce((n, item) => n + item.profiles.length, 0) !== 3) failures.push('targetinfo');
if (packages.length !== 2 || packages[0].category !== 'LuCI') failures.push('packageinfo');
const demo = menu.options.find((item) => item.symbol === 'PACKAGE_luci-app-demo');
const image = menu.options.find((item) => item.symbol === 'TARGET_IMAGES_GZIP');
if (!demo || demo.type !== 'tristate' || !demo.depends.includes('TARGET_x86')) failures.push('tristate/dependency');
if (!image || image.path[0] !== 'Target Images') failures.push('menu path');
if (menu.choices.length !== 1 || !menu.options.some((item) => item.choice)) failures.push('choice');
if (!workflow.includes('make defconfig FORCE=1') ||
    workflow.includes('max-parallel:') ||
    workflow.includes('apt-get') ||
    !workflow.includes('fail-fast: false') ||
    !workflow.includes("if: needs.generate.result == 'success'") ||
    !workflow.includes('scripts/write-attempt.mjs') ||
    !workflow.includes('scripts/run-stage.sh') ||
    !workflow.includes('pattern: result-*') ||
    !workflow.includes('actions/upload-artifact@v7') ||
    !workflow.includes('actions/download-artifact@v8')) failures.push('workflow resilience');
if (policy.sources.length !== 1 || policy.sources[0].id !== 'ImmortalWrt' ||
    policy.sources[0].branches.join(',') !==
      'openwrt-21.02,openwrt-23.05,openwrt-24.10,openwrt-25.12') failures.push('stable branch policy');
if (!generator.includes("option.path[0] !== 'Target Devices'") ||
    !generator.includes('menu: compactMenu') ||
    generator.includes('\n  packages,\n')) failures.push('compact payload');
if (failures.length) throw new Error(`检查失败:${failures.join(',')}`);
console.log(`catalog checks passed: ${targets.length} targets, ${packages.length} packages, ${menu.options.length} visible Kconfig options`);

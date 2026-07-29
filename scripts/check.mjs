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
    !workflow.includes('scripts/write-attempt.mjs')) failures.push('workflow resilience');
if (failures.length) throw new Error(`检查失败:${failures.join(',')}`);
console.log(`catalog checks passed: ${targets.length} targets, ${packages.length} packages, ${menu.options.length} visible Kconfig options`);

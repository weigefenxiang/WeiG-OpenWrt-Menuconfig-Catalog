#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseInfoRecords, safeSlug, targetBuildContract } from './lib.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

function configValue(value) {
  return `"${String(value).replace(/"/g, '\\"')}"`;
}

export function buildProbeConfig(target, profile) {
  const requiredPackages = [...new Set([...(target.packages || []), ...(profile.packages || [])])];
  return [
    'CONFIG_HAVE_DOT_CONFIG=y',
    `CONFIG_TARGET_${target.board}=y`,
    `CONFIG_TARGET_${target.board}_${target.subtarget}=y`,
    `CONFIG_TARGET_${target.board}_${target.subtarget}_${profile.id}=y`,
    `CONFIG_${target.arch}=y`,
    `CONFIG_ARCH=${configValue(target.arch)}`,
    `CONFIG_TARGET_BOARD=${configValue(target.board)}`,
    `CONFIG_TARGET_SUBTARGET=${configValue(target.subtarget)}`,
    `CONFIG_TARGET_PROFILE=${configValue(profile.id)}`,
    `CONFIG_TARGET_ARCH_PACKAGES=${configValue(target.archPackages)}`,
    ...requiredPackages.map((name) => `CONFIG_PACKAGE_${name}=y`),
    '',
  ].join('\n');
}

function configSymbols(text) {
  const values = new Map();
  for (const line of String(text).replace(/\r\n/g, '\n').split('\n')) {
    const enabled = line.match(/^CONFIG_([A-Za-z0-9_.+-]+)=(.*)$/);
    if (enabled) values.set(enabled[1], enabled[2]);
    const disabled = line.match(/^# CONFIG_([A-Za-z0-9_.+-]+) is not set$/);
    if (disabled) values.set(disabled[1], 'n');
  }
  return values;
}

export function verifyProbeConfig(text, target, profile) {
  const values = configSymbols(text);
  const expected = new Map([
    [`TARGET_${target.board}`, 'y'],
    [`TARGET_${target.board}_${target.subtarget}`, 'y'],
    [`TARGET_${target.board}_${target.subtarget}_${profile.id}`, 'y'],
    [target.arch, 'y'],
    ['ARCH', configValue(target.arch)],
    ['TARGET_BOARD', configValue(target.board)],
    ['TARGET_SUBTARGET', configValue(target.subtarget)],
    ['TARGET_PROFILE', configValue(profile.id)],
    ['TARGET_ARCH_PACKAGES', configValue(target.archPackages)],
    ...[...new Set([...(target.packages || []), ...(profile.packages || [])])]
      .map((name) => [`PACKAGE_${name}`, 'y']),
  ]);
  const changed = [...expected].flatMap(([symbol, value]) =>
    values.get(symbol) === value ? [] : [{ symbol, expected: value, actual: values.get(symbol) ?? null }]);
  return { valid: changed.length === 0, changed };
}

const args = {};
for (let index = 2; index < process.argv.length; index += 2) {
  args[process.argv[index]?.replace(/^--/, '')] = process.argv[index + 1];
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  for (const key of ['tree', 'source-id', 'branch', 'out']) {
    if (!args[key]) throw new Error(`Missing --${key}`);
  }
  const tree = resolve(args.tree);
  const outDir = resolve(args.out);
  const slug = `${safeSlug(args['source-id'])}--${safeSlug(args.branch)}`;
  const contractPath = join(outDir, `${slug}.contract.json`);
  if (!existsSync(contractPath)) throw new Error(`Missing generated target contract: ${contractPath}`);
  const report = JSON.parse(readFileSync(contractPath, 'utf8'));
  const targets = parseInfoRecords(readFileSync(join(tree, 'tmp', '.targetinfo'), 'utf8'));
  for (const target of targets) target.contract = targetBuildContract(target);
  const probeTargets = targets.filter((target) => target.contract.selectable);
  const probeDir = join(outDir, `${slug}.kconfig-probes`);
  mkdirSync(probeDir, { recursive: true });
  const result = {
    schema: 1,
    mode: 'representative-profile-per-target',
    generatedAt: new Date().toISOString(),
    targets: probeTargets.length,
    passed: 0,
    failed: [],
  };
  try {
    execFileSync('make', ['-C', tree, 'scripts/config/conf'], { stdio: 'inherit' });
    const conf = join(tree, 'scripts', 'config', 'conf');
    if (!existsSync(conf)) throw new Error(`Upstream Kconfig resolver is unavailable: ${conf}`);
    for (const target of probeTargets) {
      const profile = target.profiles[0];
      const label = `${target.board}/${target.subtarget}/${profile.id}`;
      const configPath = join(probeDir, `${safeSlug(target.board)}--${safeSlug(target.subtarget)}.config`);
      writeFileSync(configPath, buildProbeConfig(target, profile));
      try {
        execFileSync(conf, [`--defconfig=${configPath}`, '-w', configPath, 'Config.in'], {
          cwd: tree, stdio: 'pipe', encoding: 'utf8', timeout: 120000,
        });
        const verification = verifyProbeConfig(readFileSync(configPath, 'utf8'), target, profile);
        if (!verification.valid) throw new Error(JSON.stringify(verification.changed));
        result.passed++;
        console.log(`Kconfig target contract: ${label} OK`);
      } catch (error) {
        result.failed.push({ target: target.id, profile: profile.id, error: error.message.slice(0, 2000) });
        console.error(`Kconfig target contract: ${label} FAILED: ${error.message}`);
      }
    }
  } catch (error) {
    result.failed.push({ target: '(resolver)', profile: '', error: error.message.slice(0, 2000) });
  }
  report.kconfigProbe = result;
  writeFileSync(contractPath, JSON.stringify(report, null, 2) + '\n');
  if (result.failed.length) throw new Error(`Kconfig target contract failed: ${result.failed.length}/${result.targets}`);
  console.log(`Kconfig target contract passed: ${result.passed}/${result.targets}`);
}

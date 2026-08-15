#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { gunzipSync, gzipSync } from 'node:zlib';
import {
  parseInfoRecords, parseKconfigTree, resolveTargetSelectors, safeSlug, targetBuildContract,
} from './lib.mjs';
import { buildProfileSeed, parseConfigSymbols } from './profile-config-contract.mjs';

export { buildProfileSeed, parseConfigSymbols };
export const buildProbeConfig = buildProfileSeed;

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

export function verifyProbeConfig(text, target, profile, selectors = resolveTargetSelectors(target, profile)) {
  const values = parseConfigSymbols(text);
  const expected = new Map([
    [selectors.target, 'y'],
    [selectors.profile, 'y'],
  ]);
  const changed = [...expected].flatMap(([symbol, value]) =>
    symbol && values.get(symbol) === value ? [] : [{ symbol, expected: value, actual: values.get(symbol) ?? null }]);
  return { valid: changed.length === 0, changed };
}

export function quarantineGeneratedProfiles(outDir, slug, quarantined) {
  if (!quarantined.length) return null;
  const assetPath = join(outDir, `${slug}.json.gz`);
  const metaPath = join(outDir, `${slug}.meta.json`);
  if (!existsSync(assetPath) || !existsSync(metaPath)) {
    throw new Error(`Generated catalog asset is missing: ${assetPath}`);
  }
  // A failed target-level probe invalidates every sibling profile. Never leave
  // an untested profile visible after its representative fails.
  const failedTargets = new Set(quarantined.map((item) => item.target));
  const removed = new Set(quarantined.map((item) => `${item.target}\0${item.profile}`));
  const payload = JSON.parse(gunzipSync(readFileSync(assetPath)).toString('utf8'));
  for (const target of payload.targets || []) {
    const targetRemoved = new Set((target.profiles || [])
      .filter((profile) => failedTargets.has(target.id) || removed.has(`${target.id}\0${profile.id}`))
      .map((profile) => profile.id));
    if (!targetRemoved.size) continue;
    target.profiles = (target.profiles || []).filter((profile) => !targetRemoved.has(profile.id));
    for (const contract of target.contract?.profileContracts || []) {
      if (targetRemoved.has(contract.id)) {
        contract.selectable = false;
        contract.reason = 'kconfig-probe';
      }
    }
    if (!target.profiles.some((profile) => profile.selectable !== false)) {
      target.contract = {
        ...(target.contract || {}), kind: 'unavailable', selectable: false,
        missing: [...new Set([...(target.contract?.missing || []), 'kconfig-probe'])],
      };
    }
  }
  payload.targetTree = (payload.targetTree || []).map((system) => ({
    ...system,
    children: (system.children || []).map((subtarget) => ({
      ...subtarget,
      children: (subtarget.children || []).filter((profile) =>
        !failedTargets.has(subtarget.targetId) &&
        !removed.has(`${subtarget.targetId}\0${profile.profileId || profile.value}`)),
    })).filter((subtarget) => subtarget.children?.length),
  })).filter((system) => system.children?.length);
  const selectableTargets = payload.targetTree.reduce((total, system) =>
    total + (system.children || []).length, 0);
  const visibleProfiles = payload.targetTree.reduce((total, system) =>
    total + (system.children || []).reduce((count, subtarget) => count + (subtarget.children || []).length, 0), 0);
  payload.counts = {
    ...(payload.counts || {}), selectableTargets, profiles: visibleProfiles,
    unavailableTargets: (payload.targets || []).filter((target) => target.contract?.kind === 'unavailable').length,
  };
  const json = JSON.stringify(payload);
  writeFileSync(assetPath, gzipSync(Buffer.from(json), { level: 9 }));
  const meta = JSON.parse(readFileSync(metaPath, 'utf8'));
  meta.counts = payload.counts;
  meta.sha256 = createHash('sha256').update(json).digest('hex');
  writeFileSync(metaPath, JSON.stringify(meta, null, 2) + '\n');
  return payload.counts;
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
  const menu = parseKconfigTree(tree);
  const kconfigSymbols = new Set(menu.options.map((option) => option.symbol));
  for (const target of targets) target.contract = targetBuildContract(target, kconfigSymbols);
  const probeTargets = targets.filter((target) => target.contract.selectable);
  const probeDir = join(outDir, `${slug}.kconfig-probes`);
  mkdirSync(probeDir, { recursive: true });
  const result = {
    schema: 1,
    mode: 'target-chain-and-representative-profile',
    generatedAt: new Date().toISOString(),
    targets: probeTargets.length,
    passed: 0,
    passedScope: 'target chain plus one representative profile; all siblings remain hidden on failure',
    quarantined: [],
  };
  try {
    execFileSync('make', ['-C', tree, 'scripts/config/conf'], { stdio: 'inherit' });
    const conf = join(tree, 'scripts', 'config', 'conf');
    if (!existsSync(conf)) throw new Error(`Upstream Kconfig resolver is unavailable: ${conf}`);
    for (const target of probeTargets) {
      const profile = target.profiles.find((item) => item.selectable !== false);
      const selectors = resolveTargetSelectors(target, profile, kconfigSymbols);
      const label = `${target.board}/${target.subtarget || '(no-subtarget)'}/${profile.id}`;
      const configPath = join(probeDir, `${safeSlug(target.id)}--${safeSlug(profile.id)}.config`);
      writeFileSync(configPath, buildProfileSeed(target, profile, selectors));
      try {
        execFileSync(conf, [`--defconfig=${configPath}`, '-w', configPath, 'Config.in'], {
          cwd: tree, stdio: 'pipe', encoding: 'utf8', timeout: 120000,
        });
        const verification = verifyProbeConfig(readFileSync(configPath, 'utf8'), target, profile, selectors);
        if (!verification.valid) throw new Error(JSON.stringify(verification.changed));
        result.passed++;
        console.log(`Kconfig target contract: ${label} OK`);
      } catch (error) {
        result.quarantined.push({ target: target.id, profile: profile.id, error: error.message.slice(0, 2000) });
        console.error(`Kconfig target contract: ${label} FAILED: ${error.message}`);
      }
    }
  } catch (error) {
    result.fatal = { target: '(resolver)', profile: '', error: error.message.slice(0, 2000) };
  }
  if (!result.fatal && result.targets > 0 && result.passed === 0) {
    result.fatal = {
      target: '(all-targets)', profile: '',
      error: `No usable Target/Profile after Kconfig probes (${result.quarantined.length} quarantined)`,
    };
  }
  report.kconfigProbe = result;
  if (result.quarantined.length && !result.fatal) {
    report.summary.quarantinedProfiles = result.quarantined.length;
    report.unavailable = [
      ...(report.unavailable || []),
      ...result.quarantined.map((item) => ({
        target: item.target, profile: item.profile, missing: ['kconfig-probe'],
      })),
    ];
    const counts = quarantineGeneratedProfiles(outDir, slug, result.quarantined);
    report.summary.selectableTargets = counts.selectableTargets;
    report.summary.unavailableTargets = counts.unavailableTargets;
  }
  writeFileSync(contractPath, JSON.stringify(report, null, 2) + '\n');
  if (result.fatal) throw new Error(`Kconfig resolver failed: ${result.fatal.error}`);
  console.log(`Kconfig target contract passed: ${result.passed}/${result.targets}; ` +
    `quarantined: ${result.quarantined.length}`);
}

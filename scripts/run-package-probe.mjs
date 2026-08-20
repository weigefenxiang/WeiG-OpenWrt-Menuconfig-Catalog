#!/usr/bin/env node
// SPDX-FileCopyrightText: 2026 weigefenxiang <weigefenxiang@gmail.com>
// SPDX-License-Identifier: GPL-3.0-or-later
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { availableParallelism } from 'node:os';
import { dirname, join, posix, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runVirtualProbe } from './package-probe-virtual.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PACKAGE_RE = /^[A-Za-z0-9][A-Za-z0-9+_.@-]{0,95}$/;
const WORKDIR = resolve(process.env.PROBE_WORKDIR || join(ROOT, 'work', 'upstream'));
const LOG_FILE = resolve(process.env.PROBE_LOG || join(ROOT, 'probe.log'));
const RUNTIME_FILE = resolve(process.env.PROBE_RUNTIME || join(ROOT, 'probe-runtime.json'));
const MODE = String(process.env.PROBE_MODE || 'config-resolve');
const TARGET = String(process.env.PROBE_TARGET || '');
const PROFILE = String(process.env.PROBE_PROFILE || '');
const TARGET_SYSTEM = String(process.env.PROBE_TARGET_SYSTEM || '');
const SUBTARGET = String(process.env.PROBE_SUBTARGET || '');
const TARGET_CONFIG = String(process.env.PROBE_TARGET_CONFIG || '');
const SOURCE = String(process.env.PROBE_SOURCE || '');
const BRANCH = String(process.env.PROBE_BRANCH || '');
const TARGET_BATCH = MODE === 'config-resolve' ? parseTargetBatch(process.env.PROBE_TARGET_BATCH || '') : [];
const FINAL_PACKAGE_CONFIG = Buffer.from(String(process.env.PROBE_PACKAGE_CONFIG || ''), 'base64url').toString('utf8');
const INTENT_JSON = Buffer.from(String(process.env.PROBE_PACKAGE_INTENT || 'W10'), 'base64url').toString('utf8');
const FINAL_STATES = parsePackageConfig(FINAL_PACKAGE_CONFIG);
const INTENT = parseIntent(INTENT_JSON);
const DIRECT_STATES = directIntentStates(INTENT);
const ROOTS = String(process.env.PROBE_ROOTS || '').split(',').map((row) => row.trim()).filter(Boolean);
const MAKE_COMMAND = String(process.env.PROBE_MAKE_COMMAND || 'make');
const MAKE_PREFIX = String(process.env.PROBE_MAKE_ARGUMENT || '').trim();
const requestedJobs = Number(process.env.PROBE_JOBS || 0);
const JOBS = Number.isSafeInteger(requestedJobs) && requestedJobs > 0 ? requestedJobs : Math.max(1, availableParallelism() + 1);
const COMMAND_OUTPUT_LIMIT = 256 * 1024;

const MODE_LEVELS = Object.freeze({
  'config-resolve': 1,
  'package-compile': 2,
  'rootfs-integration': 3,
  'firmware-integration': 4,
  'boot-smoke': 5,
  'runtime-health': 6,
  'reboot-validation': 7,
});
if (!MODE_LEVELS[MODE]) {
  throw new Error(`unsupported probe mode: ${MODE}`);
}
if (SOURCE.toLowerCase() === 'hanwckf') throw new Error('hanwckf is excluded from Package Probe');
if (MODE === 'config-resolve') {
  if (!TARGET_BATCH.length) throw new Error('L1 Probe environment batch is required');
} else if (!TARGET || !TARGET_CONFIG) throw new Error('Probe Target config is required');
if (!ROOTS.length || ROOTS.some((name) => !PACKAGE_RE.test(name))) throw new Error('invalid PROBE_ROOTS');
for (const root of ROOTS) {
  if (!['m', 'y'].includes(FINAL_STATES.get(root))) throw new Error(`Probe root is not enabled in Final state: ${root}`);
}

mkdirSync(dirname(LOG_FILE), { recursive: true });
if (!existsSync(LOG_FILE)) writeFileSync(LOG_FILE, '');

function parsePackageConfig(text, allowEmpty = false) {
  const states = new Map();
  const normalized = String(text || '').replace(/\r\n/g, '\n').trim();
  if (!normalized && !allowEmpty) throw new Error('Final package config is empty');
  if (!normalized) return states;
  for (const line of normalized.split('\n')) {
    const match = line.match(/^CONFIG_PACKAGE_([A-Za-z0-9][A-Za-z0-9+_.@-]{0,95})=([my])$/);
    if (!match) throw new Error(`invalid package config line: ${line}`);
    if (states.has(match[1]) && states.get(match[1]) !== match[2]) throw new Error(`conflicting package config state: ${match[1]}`);
    states.set(match[1], match[2]);
  }
  return states;
}

function parseIntent(text) {
  let rows;
  try { rows = JSON.parse(text || '[]'); }
  catch { throw new Error('PROBE_PACKAGE_INTENT is invalid JSON'); }
  if (!Array.isArray(rows)) throw new Error('PROBE_PACKAGE_INTENT must be an array');
  return rows;
}

function directIntentStates(rows) {
  const states = new Map();
  for (const row of rows) {
    const packageName = String(row?.package || '');
    const value = String(row?.after || 'n');
    if (!PACKAGE_RE.test(packageName) || !['n', 'm', 'y'].includes(value) || states.has(packageName)) {
      throw new Error(`invalid or duplicate direct package intent: ${packageName}`);
    }
    states.set(packageName, value);
  }
  return states;
}

function parseTargetBatch(text) {
  if (!String(text || '').trim()) return [];
  let rows;
  try { rows = JSON.parse(text); }
  catch { throw new Error('PROBE_TARGET_BATCH is invalid JSON'); }
  if (!Array.isArray(rows) || rows.length > 256) throw new Error('PROBE_TARGET_BATCH must contain up to 256 environments');
  return rows.map((row, index) => {
    if (!row || typeof row !== 'object' || Array.isArray(row)) throw new Error(`invalid L1 environment at index ${index}`);
    const target = String(row.target || '');
    const targetConfig = String(row.targetConfig || '');
    if (!target || !targetConfig) throw new Error(`L1 environment ${index} is missing Target config`);
    return {
      targetSystem: String(row.targetSystem || ''), targetSystemLabel: String(row.targetSystemLabel || ''),
      subtarget: String(row.subtarget || ''), subtargetLabel: String(row.subtargetLabel || ''),
      target, profile: String(row.profile || ''), profileLabel: String(row.profileLabel || ''), targetConfig,
    };
  });
}

function log(line = '') {
  const text = `${line}\n`;
  process.stdout.write(text);
  appendFileSync(LOG_FILE, text);
}

function stageStatus(value) {
  if (value?.result === 'skipped') return 'skipped';
  if (value?.result === 'inconclusive') return 'failure';
  if (value?.result === 'incompatible') return 'failure';
  return value?.ok === false ? 'failure' : 'success';
}

async function runStage(attempt, name, action) {
  const started = Date.now();
  const startedAt = new Date(started).toISOString();
  try {
    const value = await action();
    attempt.stages[name] = {
      status: stageStatus(value), startedAt, finishedAt: new Date().toISOString(),
      durationMs: Math.max(0, Date.now() - started),
    };
    return value;
  } catch (error) {
    attempt.stages[name] = {
      status: 'failure', startedAt, finishedAt: new Date().toISOString(),
      durationMs: Math.max(0, Date.now() - started),
    };
    throw error;
  }
}

log(`Make concurrency / Make 并发: -j${JOBS}`);
log('Defconfig: on (upstream resolver)');
log(`Probe roots / 测试入口: ${ROOTS.join(', ')}`);

function appendCommandOutput(current, chunk) {
  const next = current + String(chunk || '');
  return next.length > COMMAND_OUTPUT_LIMIT ? next.slice(-COMMAND_OUTPUT_LIMIT) : next;
}

async function command(file, args, options = {}) {
  log(`\n$ ${file} ${args.join(' ')}`);
  return new Promise((resolvePromise) => {
    let output = '';
    const child = spawn(file, args, {
      cwd: options.cwd || WORKDIR,
      env: { ...process.env, ...(options.env || {}) },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout.on('data', (chunk) => {
      output = appendCommandOutput(output, chunk);
      process.stdout.write(chunk); appendFileSync(LOG_FILE, chunk);
    });
    child.stderr.on('data', (chunk) => {
      output = appendCommandOutput(output, chunk);
      process.stderr.write(chunk); appendFileSync(LOG_FILE, chunk);
    });
    child.on('error', (error) => {
      const text = `ERROR: ${error.message}`;
      output = appendCommandOutput(output, text);
      log(text); resolvePromise({ ok: false, code: -1, output });
    });
    child.on('close', (code) => resolvePromise({ ok: code === 0, code, output }));
  });
}

async function make(args, parallel = true) {
  const makeArgs = parallel ? [`-j${JOBS}`, ...args] : ['-j1', ...args];
  return command(MAKE_COMMAND, [...(MAKE_PREFIX ? [MAKE_PREFIX] : []), ...makeArgs]);
}

function verboseMakeArgs(args) {
  const rows = [...args];
  if (!rows.some((arg) => /^V=/.test(arg))) rows.push('V=s');
  if (!rows.some((arg) => /^BUILD_LOG=/.test(arg))) rows.push('BUILD_LOG=1');
  return rows;
}

async function makeWithSerialRetry(args, label, attempt) {
  const primary = await make(args);
  if (primary.ok) return primary;
  log(`Retry serial verbose / 串行详细复核: ${label}`);
  const serial = await make(verboseMakeArgs(args), false);
  attempt.serialRetries.push({
    label, primaryCode: primary.code, serialCode: serial.code,
    result: serial.ok ? 'recovered' : 'failure',
  });
  return serial;
}

function failedMakeIsInfrastructure(result) {
  const text = String(result?.output || '');
  if (/No space left on device|Prerequisite check failed|Build dependency:\s+Please install|Please install Python 2\.x/i.test(text)) return true;
  if (/Hash check failed|download failed|Connection timed out|Could not resolve host|RPC failed|HTTP\s+(?:429|5\d\d)|returned error:\s*(?:429|5\d\d)|expected ['"]?packfile|early EOF|Connection reset|TLS.*(?:error|failed)|GnuTLS.*error|SSL.*(?:error|failed)/i.test(text)) return true;
  if (/(?:^|[\s:])(?:timed\s*out|timeout:)/i.test(text)) return true;
  return /No rule to make target[^\n]*build_dir[^\n]*\/linux-[^/\s]+\/linux-[^/\s]+\/\.config/i.test(text);
}

function normalizePackageBuildTarget(value) {
  return String(value || '').replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/compile$/, '').replace(/\/+$/, '');
}

function failedPackageBuildTargets(result) {
  const text = String(result?.output || '');
  const targets = [];
  for (const match of text.matchAll(/(?:ERROR:\s+)?(package\/[A-Za-z0-9_./+@-]+)\s+failed to build/gi)) {
    targets.push(normalizePackageBuildTarget(match[1]));
  }
  for (const match of text.matchAll(/\]\s+(package\/[A-Za-z0-9_./+@-]+\/compile)\s+Error\b/gi)) {
    targets.push(normalizePackageBuildTarget(match[1]));
  }
  for (const match of text.matchAll(/\*\*\*\s+(?:\[[^\]]+\]\s+)?(package\/[A-Za-z0-9_./+@-]+\/compile)\b/gi)) {
    targets.push(normalizePackageBuildTarget(match[1]));
  }
  return [...new Set(targets)];
}

function classifyPackageBuildFailure(result, rootTargets, attempt, reasons) {
  if (failedMakeIsInfrastructure(result)) return { result: 'inconclusive', reason: reasons.infrastructure };
  const failedTargets = failedPackageBuildTargets(result);
  attempt.failedBuildTargets = failedTargets;
  const roots = new Set((rootTargets || []).map(normalizePackageBuildTarget));
  if (failedTargets.some((target) => roots.has(target))) return { result: 'incompatible', reason: reasons.root };
  return { result: 'inconclusive', reason: failedTargets.length ? reasons.prerequisite : reasons.unattributed };
}

function unversionedPackageName(value) {
  return String(value || '').replace(/-[0-9][A-Za-z0-9.+:~_-]*$/, '');
}

function rootfsConflictPackages(result) {
  const text = String(result?.output || '');
  const packages = [];
  for (const match of text.matchAll(/(?:ERROR:\s+)?([^\s:]+?)(?:-[0-9][^:\s]*)?:\s+trying to overwrite\s+[^\s,]+\s+owned by\s+([^\s,.]+)/gi)) {
    packages.push(unversionedPackageName(match[1]), unversionedPackageName(match[2]));
  }
  for (const match of text.matchAll(/Package\s+([^\s]+)\s+wants to install file\s+[^\s]+.*?already provided by package\s+([^\s.]+)/gis)) {
    packages.push(unversionedPackageName(match[1]), unversionedPackageName(match[2]));
  }
  return [...new Set(packages.filter(Boolean))];
}

function classifyRootfsInstallFailure(result, attempt) {
  if (failedMakeIsInfrastructure(result)) return { result: 'inconclusive', reason: 'rootfs-install-infrastructure' };
  const conflictPackages = rootfsConflictPackages(result);
  attempt.rootfsConflictPackages = conflictPackages;
  if (conflictPackages.some((packageName) => ROOTS.includes(packageName))) {
    return { result: 'incompatible', reason: 'rootfs-conflict' };
  }
  return { result: 'inconclusive', reason: conflictPackages.length ? 'rootfs-install-prerequisite-failure' : 'rootfs-install-unattributed-failure' };
}

function safeSlug(value) {
  return String(value || 'default').replace(/[^A-Za-z0-9_.-]/g, '-').replace(/-+/g, '-').slice(0, 120) || 'default';
}

function packageStatesFromText(text) {
  return new Map([...String(text || '').matchAll(/^CONFIG_PACKAGE_([A-Za-z0-9][A-Za-z0-9+_.@-]{0,95})=([my])$/gm)]
    .map((match) => [match[1], match[2]]));
}

function rootRequestedStates() {
  return new Map(ROOTS.map((root) => [root, DIRECT_STATES.get(root) || FINAL_STATES.get(root) || 'y']));
}

function probeConfigText(targetConfig, requestedStates) {
  const lines = ['CONFIG_HAVE_DOT_CONFIG=y', String(targetConfig || '').trim()];
  for (const [packageName, state] of requestedStates) {
    lines.push(state === 'n' ? `# CONFIG_PACKAGE_${packageName} is not set` : `CONFIG_PACKAGE_${packageName}=${state}`);
  }
  return `${lines.filter(Boolean).join('\n')}\n`;
}

async function resolveProbeConfig({ targetConfig, requestedStates, file, resolveConfig, roots, attempt, label }) {
  writeFileSync(file, probeConfigText(targetConfig, requestedStates));
  const result = await resolveConfig(file);
  if (!result.ok) return { ok: false, states: {}, config: file, reason: `${label}-defconfig-failure`, rejectedRoots: [] };
  const resolvedStates = packageStatesFromText(readFileSync(file, 'utf8'));
  const actual = Object.fromEntries(roots.map((root) => [root, resolvedStates.get(root) || 'n']));
  const directActual = Object.fromEntries([...requestedStates].map(([packageName]) => [packageName, resolvedStates.get(packageName) || 'n']));
  const rejected = [...requestedStates].filter(([packageName, state]) => directActual[packageName] !== state)
    .map(([packageName]) => packageName);
  if (attempt) {
    attempt.configPath = file;
    attempt.resolvedPackageCount = resolvedStates.size;
  }
  if (rejected.length) {
    log(`FAIL: direct Probe intent did not survive upstream defconfig: ${JSON.stringify(directActual)}`);
    return { ok: false, states: actual, config: file, reason: 'root-kconfig-rejected', rejectedRoots: rejected };
  }
  return { ok: true, states: actual, config: file, resolvedPackageCount: resolvedStates.size, rejectedRoots: [] };
}

async function solveL1Config(environment, roots, suffix, attempt) {
  const directory = join(WORKDIR, '.probe-configs');
  mkdirSync(directory, { recursive: true });
  const file = join(directory, `${safeSlug(environment.target)}--${safeSlug(environment.profile)}--${safeSlug(suffix)}.config`);
  return resolveProbeConfig({
    targetConfig: environment.targetConfig, requestedStates: roots, file, roots: [...roots.keys()], attempt,
    label: 'l1', resolveConfig: (configFile) => command(join(WORKDIR, 'scripts', 'config', 'conf'),
      [`--defconfig=${configFile}`, '-w', configFile, 'Config.in']),
  });
}

async function prepareConfig(attempt, label = 'final') {
  return resolveProbeConfig({
    targetConfig: TARGET_CONFIG, requestedStates: DIRECT_STATES, file: join(WORKDIR, '.config'), roots: ROOTS, attempt, label,
    resolveConfig: () => make(['defconfig'], false),
  });
}

function packageNamesFromInfo(text) {
  return new Set([...String(text || '').matchAll(/^Package:\s*(\S+)$/gm)].map((match) => match[1]));
}

function newL1Attempt(environment) {
  return {
    source: SOURCE, branch: BRANCH,
    targetSystem: environment.targetSystem, subtarget: environment.subtarget,
    target: environment.target, profile: environment.profile, profileLabel: environment.profileLabel,
    stages: {}, rootStates: {}, unavailableRoots: [], rejectedRoots: [], serialRetries: [],
  };
}

async function configResolve() {
  log(`L1 environment batch / L1 环境批次: ${TARGET_BATCH.length}`);
  const metadata = await command('bash', [join(ROOT, 'scripts', 'prepare-metadata.sh'), 'metadata-only']);
  if (!metadata.ok) {
    return TARGET_BATCH.map((environment) => ({ ...newL1Attempt(environment), result: 'inconclusive', reason: 'metadata-failure',
      stages: { metadata: 'failure' } }));
  }
  const resolver = await make(['scripts/config/conf'], false);
  if (!resolver.ok) {
    return TARGET_BATCH.map((environment) => ({ ...newL1Attempt(environment), result: 'inconclusive', reason: 'kconfig-resolver-failure',
      stages: { metadata: 'success', resolver: 'failure' } }));
  }
  const packageInfoPath = join(WORKDIR, 'tmp', '.packageinfo');
  if (!existsSync(packageInfoPath)) {
    return TARGET_BATCH.map((environment) => ({ ...newL1Attempt(environment), result: 'inconclusive', reason: 'metadata-unresolved',
      stages: { metadata: 'success', resolver: 'success' } }));
  }
  const packageNames = packageNamesFromInfo(readFileSync(packageInfoPath, 'utf8'));
  if (!packageNames.size) {
    return TARGET_BATCH.map((environment) => ({ ...newL1Attempt(environment), result: 'inconclusive', reason: 'metadata-unresolved',
      stages: { metadata: 'success', resolver: 'success' } }));
  }
  const globallyAbsent = ROOTS.filter((root) => !packageNames.has(root));
  const requested = new Map(DIRECT_STATES);
  const attempts = [];
  for (const environment of TARGET_BATCH) {
    const attempt = newL1Attempt(environment);
    attempt.stages = { metadata: 'success', resolver: 'success' };
    if (globallyAbsent.length) {
      attempt.result = 'skipped'; attempt.reason = 'root-absent-source'; attempt.unavailableRoots = [...globallyAbsent];
      attempt.rootStates = Object.fromEntries(ROOTS.map((root) => [root, globallyAbsent.includes(root) ? 'missing' : 'unknown']));
      attempts.push(attempt); continue;
    }
    log(`\nL1 Profile / 配置环境: ${SOURCE}/${BRANCH}/${environment.targetSystem}/${environment.subtarget}/${environment.profile}`);
    const combined = await solveL1Config(environment, requested, 'combined', attempt);
    attempt.stages.kconfig = combined.ok ? 'success' : 'failure';
    if (!combined.ok) {
      attempt.result = 'inconclusive'; attempt.reason = 'defconfig-failure'; attempts.push(attempt); continue;
    }
    attempt.rootStates = combined.states;
    const rejected = ROOTS.filter((root) => !['m', 'y'].includes(combined.states[root]));
    attempt.rejectedRoots = [...rejected];
    if (!rejected.length) {
      attempt.result = 'compatible'; attempt.reason = ''; attempts.push(attempt); continue;
    }
    const unavailable = [];
    for (const root of rejected) {
      const single = await solveL1Config(environment, new Map([[root, requested.get(root) || 'y']]), `single-${root}`);
      if (!single.ok) {
        attempt.result = 'inconclusive'; attempt.reason = 'single-root-defconfig-failure';
        attempt.stages.singleRoot = 'failure'; break;
      }
      if (!['m', 'y'].includes(single.states[root])) unavailable.push(root);
    }
    if (attempt.result === 'inconclusive') { attempts.push(attempt); continue; }
    attempt.stages.singleRoot = 'success';
    attempt.unavailableRoots = unavailable;
    if (unavailable.length) {
      attempt.result = 'skipped'; attempt.reason = 'root-not-applicable';
    } else {
      attempt.result = 'incompatible'; attempt.reason = 'root-combination-rejected';
      log(`FAIL: L1 root combination rejected by upstream Kconfig: ${rejected.join(', ')}`);
    }
    attempts.push(attempt);
  }
  return attempts;
}

export function parseUpstreamPackageInfo(text) {
  const mapping = new Map();
  let sourceMakefile = '';
  for (const rawLine of String(text || '').split(/\r?\n/)) {
    const line = rawLine.trim();
    const source = line.match(/^Source-Makefile:\s*(.+)$/);
    if (source) {
      sourceMakefile = source[1].trim().replace(/\\/g, '/');
      continue;
    }
    const pkg = line.match(/^Package:\s*(\S+)$/);
    if (!pkg || !sourceMakefile) continue;
    if (!mapping.has(pkg[1])) mapping.set(pkg[1], new Set());
    mapping.get(pkg[1]).add(sourceMakefile);
  }
  return mapping;
}

function safeSourceMakefile(value) {
  const source = String(value || '').replace(/\\/g, '/');
  if (!source.startsWith('package/') || !source.endsWith('/Makefile') || source.includes('../') || source.includes('/./')) {
    throw new Error(`unsafe upstream Source-Makefile: ${value}`);
  }
  return source;
}

export function resolveRootBuildTargets(packageInfo, roots = ROOTS) {
  const mapping = parseUpstreamPackageInfo(packageInfo);
  const sourceMakefiles = [];
  const rootMappings = [];
  for (const root of roots) {
    const sources = [...(mapping.get(root) || [])].map(safeSourceMakefile).sort();
    if (sources.length !== 1) {
      const error = new Error(sources.length ? `ambiguous upstream Source-Makefile for ${root}: ${sources.join(', ')}`
        : `upstream package metadata does not contain Probe root: ${root}`);
      error.code = 'PROBE_METADATA_UNRESOLVED';
      throw error;
    }
    rootMappings.push({ package: root, sourceMakefile: sources[0] });
    sourceMakefiles.push(sources[0]);
  }
  const uniqueSources = [...new Set(sourceMakefiles)];
  const targets = uniqueSources.map((source) => `${posix.dirname(source)}/compile`);
  return { rootMappings, sourceMakefiles: uniqueSources, targets };
}

function readPackageInfo() {
  const path = join(WORKDIR, 'tmp', '.packageinfo');
  if (!existsSync(path)) {
    const error = new Error('upstream tmp/.packageinfo is missing after metadata preparation');
    error.code = 'PROBE_METADATA_UNRESOLVED';
    throw error;
  }
  return readFileSync(path, 'utf8');
}

function classifyConfigFailure(config, attempt) {
  if (config.reason !== 'root-kconfig-rejected') return { result: 'inconclusive', reason: config.reason };
  attempt.rejectedRoots = config.rejectedRoots || [];
  let packageInfo;
  try { packageInfo = readPackageInfo(); }
  catch (error) {
    log(`ERROR: ${error.message}`);
    return { result: 'inconclusive', reason: error.code || 'metadata-unresolved' };
  }
  const mapping = parseUpstreamPackageInfo(packageInfo);
  const unavailableRoots = ROOTS.filter((root) => !(mapping.get(root)?.size));
  if (unavailableRoots.length) {
    attempt.unavailableRoots = unavailableRoots;
    log(`FAIL: Probe root package unavailable in Source/Branch: ${unavailableRoots.join(', ')}`);
    return { result: 'incompatible', reason: 'package-unavailable' };
  }
  return { result: 'incompatible', reason: 'kconfig-unsatisfied' };
}

async function packageCompile(attempt) {
  const config = await runStage(attempt, 'config', () => prepareConfig(attempt));
  attempt.rootStates = config.states;
  if (!config.ok) return classifyConfigFailure(config, attempt);
  let resolved;
  try { resolved = await runStage(attempt, 'metadata', async () => resolveRootBuildTargets(readPackageInfo())); }
  catch (error) {
    log(`ERROR: ${error.message}`);
    return { result: 'inconclusive', reason: error.code || 'metadata-unresolved' };
  }
  attempt.rootMappings = resolved.rootMappings;
  attempt.sourceMakefiles = resolved.sourceMakefiles;
  attempt.rootTargets = resolved.targets;
  log(`Upstream root build targets / 上游入口目标: ${resolved.targets.join(' ')}`);
  const target = await runStage(attempt, 'targetPrepare', () =>
    makeWithSerialRetry(['prepare'], 'Target build prerequisites', attempt));
  if (!target.ok) return { result: 'inconclusive', reason: 'target-prerequisite-failure' };
  const compiled = await runStage(attempt, 'packageCompile', () =>
    makeWithSerialRetry(resolved.targets, `probe roots: ${ROOTS.join(',')}`, attempt));
  if (!compiled.ok) {
    log(`FAIL: package compile failed for Probe roots: ${ROOTS.join(', ')}`);
    return classifyPackageBuildFailure(compiled, resolved.targets, attempt, {
      root: 'package-compile-failure', infrastructure: 'package-compile-infrastructure',
      prerequisite: 'package-compile-prerequisite-failure', unattributed: 'package-compile-unattributed-failure',
    });
  }
  return { result: 'compatible', reason: '' };
}

async function rootfsIntegration(attempt) {
  const compiled = await packageCompile(attempt);
  if (compiled.result !== 'compatible') return compiled;
  const packages = await runStage(attempt, 'rootfsPackages', () =>
    makeWithSerialRetry(['package/compile'], 'RootFS selected packages', attempt));
  if (!packages.ok) return classifyPackageBuildFailure(packages, attempt.rootTargets, attempt, {
    root: 'rootfs-package-compile-failure', infrastructure: 'rootfs-package-infrastructure',
    prerequisite: 'rootfs-package-prerequisite-failure', unattributed: 'rootfs-package-unattributed-failure',
  });
  const installed = await runStage(attempt, 'rootfsInstall', () =>
    makeWithSerialRetry(['package/install'], 'rootfs install', attempt));
  if (!installed.ok) {
    log('FAIL: RootFS integration failed after Probe-root compilation');
    return classifyRootfsInstallFailure(installed, attempt);
  }
  return { result: 'compatible', reason: '' };
}

async function firmwareIntegration(attempt) {
  const rootfs = await rootfsIntegration(attempt);
  if (rootfs.result !== 'compatible') return rootfs;
  const firmware = await runStage(attempt, 'firmwareBuild', () =>
    makeWithSerialRetry(['target/install'], 'final package firmware', attempt));
  if (!firmware.ok) {
    log('FAIL: Final package-enabled firmware failed');
    return classifyPackageBuildFailure(firmware, attempt.rootTargets, attempt, {
      root: 'final-firmware-failure', infrastructure: 'firmware-build-infrastructure',
      prerequisite: 'firmware-prerequisite-failure', unattributed: 'firmware-unattributed-failure',
    });
  }
  if (MODE === 'firmware-integration') return { result: 'compatible', reason: '' };
  const virtual = await runVirtualProbe({
    mode: MODE,
    workdir: WORKDIR,
    targetSystem: TARGET_SYSTEM,
    subtarget: SUBTARGET,
    installedRoots: ROOTS.filter((root) => FINAL_STATES.get(root) === 'y'),
    logFile: join(dirname(LOG_FILE), 'probe-virtual.log'),
    bootTimeoutMs: Number(process.env.PROBE_BOOT_TIMEOUT_SECONDS || 180) * 1000,
    controlTimeoutMs: Number(process.env.PROBE_CONTROL_TIMEOUT_SECONDS || 30) * 1000,
    observationMs: Number(process.env.PROBE_RUNTIME_OBSERVATION_SECONDS || 15) * 1000,
    onOutput: (text) => { process.stdout.write(text); appendFileSync(LOG_FILE, text); },
  });
  Object.assign(attempt.stages, virtual.stages);
  attempt.virtualCapabilities = virtual.capabilities;
  attempt.virtualLog = virtual.logFile;
  return { result: virtual.result, reason: virtual.reason };
}

function stagePassed(attempt, name) {
  return attempt.stages?.[name]?.status === 'success';
}

function deepestPassedLevel(attempt) {
  if (stagePassed(attempt, 'secondRuntimeHealth')) return 7;
  if (stagePassed(attempt, 'runtimeHealth')) return 6;
  if (stagePassed(attempt, 'boot')) return 5;
  if (stagePassed(attempt, 'firmwareBuild')) return 4;
  if (stagePassed(attempt, 'rootfsInstall')) return 3;
  if (stagePassed(attempt, 'packageCompile')) return 2;
  return 0;
}

const runtimeStarted = Date.now();
let attempts;
let overallResult;
let overallReason = '';
if (MODE === 'config-resolve') {
  attempts = await configResolve();
  const results = attempts.map((row) => row.result);
  if (results.includes('inconclusive')) overallResult = 'inconclusive';
  else if (results.includes('incompatible')) overallResult = 'incompatible';
  else if (results.includes('compatible')) overallResult = 'compatible';
  else overallResult = 'skipped';
  overallReason = attempts.find((row) => row.result === overallResult)?.reason || '';
} else {
  const attempt = {
    source: SOURCE, branch: BRANCH,
    targetSystem: TARGET_SYSTEM, subtarget: SUBTARGET, target: TARGET, profile: PROFILE,
    stages: {}, rootStates: {}, rootMappings: [], sourceMakefiles: [], rootTargets: [], unavailableRoots: [], rejectedRoots: [], serialRetries: [],
  };
  const attemptStarted = Date.now();
  attempt.startedAt = new Date(attemptStarted).toISOString();
  let result;
  if (MODE === 'package-compile') result = await packageCompile(attempt);
  else if (MODE === 'rootfs-integration') result = await rootfsIntegration(attempt);
  else result = await firmwareIntegration(attempt);
  attempt.result = result.result; attempt.reason = result.reason;
  attempt.selectedLevel = MODE_LEVELS[MODE];
  attempt.deepestPassedLevel = deepestPassedLevel(attempt);
  attempt.finishedAt = new Date().toISOString();
  attempt.durationMs = Math.max(0, Date.now() - attemptStarted);
  attempts = [attempt]; overallResult = result.result; overallReason = result.reason;
}

const runtime = {
  schema: 3,
  generatedAt: new Date().toISOString(),
  mode: MODE,
  selectedLevel: MODE_LEVELS[MODE],
  useDefconfig: true,
  roots: ROOTS,
  packageIntent: INTENT,
  requestedPackageCount: ROOTS.length,
  environment: { source: SOURCE, branch: BRANCH, targetSystem: TARGET_SYSTEM, subtarget: SUBTARGET, target: TARGET, profile: PROFILE },
  attempts,
  conclusion: overallResult,
  reason: overallReason,
  durationMs: Math.max(0, Date.now() - runtimeStarted),
};
writeFileSync(RUNTIME_FILE, JSON.stringify(runtime, null, 2) + '\n');
if (runtime.reason) log(`Probe reason / 探针原因: ${runtime.reason}`);
log(`Probe conclusion / 探针结论: ${runtime.conclusion}`);
process.exitCode = attempts.every((row) => ['compatible', 'incompatible', 'skipped'].includes(row.result)) ? 0 : 1;

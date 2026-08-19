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
const USE_DEFCONFIG = String(process.env.PROBE_USE_DEFCONFIG || 'true') !== 'false';
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
const ROOTS = String(process.env.PROBE_ROOTS || '').split(',').map((row) => row.trim()).filter(Boolean);
const MAKE_COMMAND = String(process.env.PROBE_MAKE_COMMAND || 'make');
const MAKE_PREFIX = String(process.env.PROBE_MAKE_ARGUMENT || '').trim();
const requestedJobs = Number(process.env.PROBE_JOBS || 0);
const JOBS = Number.isSafeInteger(requestedJobs) && requestedJobs > 0 ? requestedJobs : Math.max(1, availableParallelism() + 1);

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
log(`Defconfig: ${USE_DEFCONFIG ? 'on' : 'off'}`);
log(`Probe roots / 测试入口: ${ROOTS.join(', ')}`);

async function command(file, args, options = {}) {
  log(`\n$ ${file} ${args.join(' ')}`);
  return new Promise((resolvePromise) => {
    const child = spawn(file, args, {
      cwd: options.cwd || WORKDIR,
      env: { ...process.env, ...(options.env || {}) },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout.on('data', (chunk) => { process.stdout.write(chunk); appendFileSync(LOG_FILE, chunk); });
    child.stderr.on('data', (chunk) => { process.stderr.write(chunk); appendFileSync(LOG_FILE, chunk); });
    child.on('error', (error) => { log(`ERROR: ${error.message}`); resolvePromise({ ok: false, code: -1 }); });
    child.on('close', (code) => resolvePromise({ ok: code === 0, code }));
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

function writeConfig(states) {
  const lines = [TARGET_CONFIG.trim()];
  for (const [packageName, state] of states) lines.push(`CONFIG_PACKAGE_${packageName}=${state}`);
  writeFileSync(join(WORKDIR, '.config'), `${lines.filter(Boolean).join('\n')}\n`);
}

function packageState(packageName) {
  const text = readFileSync(join(WORKDIR, '.config'), 'utf8');
  const escaped = packageName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = text.match(new RegExp(`^CONFIG_PACKAGE_${escaped}=([my])$`, 'm'));
  return match?.[1] || 'n';
}

function rootStates() {
  return Object.fromEntries(ROOTS.map((name) => [name, packageState(name)]));
}

async function prepareConfig(states, attempt, { roots = false, metadata = false, label = 'config' } = {}) {
  writeConfig(states);
  let result = { ok: true, code: 0 };
  if (USE_DEFCONFIG) result = await make(['defconfig'], false);
  else if (metadata) result = await make(['prepare-tmpinfo'], false);
  if (!result.ok) return { ok: false, states: {}, reason: `${label}-${USE_DEFCONFIG ? 'defconfig' : 'metadata'}-failure` };
  const actual = roots ? rootStates() : {};
  if (roots) {
    const rejected = ROOTS.filter((name) => actual[name] !== FINAL_STATES.get(name));
    if (rejected.length) {
      log(`FAIL: directly selected Probe roots did not survive ${USE_DEFCONFIG ? 'make defconfig' : 'submitted config'}: ${JSON.stringify(actual)}`);
      return { ok: false, states: actual, reason: 'root-kconfig-rejected' };
    }
  }
  if (!USE_DEFCONFIG && metadata) {
    // prepare-tmpinfo must not rewrite the submitted .config; root state is checked after metadata preparation.
    const after = rootStates();
    const changed = ROOTS.filter((name) => after[name] !== FINAL_STATES.get(name));
    if (changed.length) {
      log(`ERROR: prepare-tmpinfo changed directly selected Probe roots: ${JSON.stringify(after)}`);
      return { ok: false, states: after, reason: 'root-state-changed' };
    }
    return { ok: true, states: after };
  }
  return { ok: true, states: actual };
}


function safeSlug(value) {
  return String(value || 'default').replace(/[^A-Za-z0-9_.-]/g, '-').replace(/-+/g, '-').slice(0, 120) || 'default';
}

function packageStateFromText(text, packageName) {
  const escaped = packageName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return String(text || '').match(new RegExp(`^CONFIG_PACKAGE_${escaped}=([my])$`, 'm'))?.[1] || 'n';
}

function rootRequestedStates() {
  const direct = new Map(INTENT.filter((row) => ROOTS.includes(String(row?.package || '')))
    .map((row) => [String(row.package), String(row.after || 'y')]));
  return new Map(ROOTS.map((root) => [root, ['m', 'y'].includes(direct.get(root)) ? direct.get(root) : (FINAL_STATES.get(root) || 'y')]));
}

function l1ConfigText(environment, roots) {
  const lines = ['CONFIG_HAVE_DOT_CONFIG=y', String(environment.targetConfig || '').trim()];
  for (const [packageName, state] of roots) lines.push(`CONFIG_PACKAGE_${packageName}=${state}`);
  return `${lines.filter(Boolean).join('\n')}\n`;
}

async function solveL1Config(environment, roots, suffix, attempt) {
  const directory = join(WORKDIR, '.probe-configs');
  mkdirSync(directory, { recursive: true });
  const file = join(directory, `${safeSlug(environment.target)}--${safeSlug(environment.profile)}--${safeSlug(suffix)}.config`);
  writeFileSync(file, l1ConfigText(environment, roots));
  const result = await command(join(WORKDIR, 'scripts', 'config', 'conf'), [`--defconfig=${file}`, '-w', file, 'Config.in']);
  if (!result.ok) return { ok: false, states: {}, config: file };
  const text = readFileSync(file, 'utf8');
  const states = Object.fromEntries(ROOTS.map((root) => [root, packageStateFromText(text, root)]));
  if (attempt) attempt.configPath = file;
  return { ok: true, states, config: file };
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
  const requested = rootRequestedStates();
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

function configFailureResult(reason) {
  return reason === 'root-kconfig-rejected' ? 'incompatible' : 'inconclusive';
}

async function packageCompile(attempt) {
  const config = await runStage(attempt, 'config', () =>
    prepareConfig(FINAL_STATES, attempt, { roots: true, metadata: true, label: 'final' }));
  attempt.rootStates = config.states;
  if (!config.ok) return { result: configFailureResult(config.reason), reason: config.reason };
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
  const environment = await runStage(attempt, 'buildEnvironment', () =>
    makeWithSerialRetry(['tools/install', 'toolchain/install'], 'build environment', attempt));
  if (!environment.ok) return { result: 'inconclusive', reason: 'build-environment-failure' };
  const compiled = await runStage(attempt, 'packageCompile', () =>
    makeWithSerialRetry(resolved.targets, `probe roots: ${ROOTS.join(',')}`, attempt));
  if (!compiled.ok) log(`FAIL: package compile failed for Probe roots: ${ROOTS.join(', ')}`);
  return { result: compiled.ok ? 'compatible' : 'incompatible', reason: compiled.ok ? '' : 'package-compile-failure' };
}

async function rootfsIntegration(attempt) {
  const compiled = await packageCompile(attempt);
  if (compiled.result !== 'compatible') return compiled;
  const target = await runStage(attempt, 'rootfsTarget', () =>
    makeWithSerialRetry(['prepare'], 'RootFS target prerequisites', attempt));
  if (!target.ok) return { result: 'inconclusive', reason: 'build-environment-failure' };
  const packages = await runStage(attempt, 'rootfsPackages', () =>
    makeWithSerialRetry(['package/compile'], 'RootFS selected packages', attempt));
  if (!packages.ok) return { result: 'incompatible', reason: 'rootfs-package-compile-failure' };
  const installed = await runStage(attempt, 'rootfsInstall', () =>
    makeWithSerialRetry(['package/install'], 'rootfs install', attempt));
  if (!installed.ok) log('FAIL: RootFS integration failed after Probe-root compilation');
  return { result: installed.ok ? 'compatible' : 'incompatible', reason: installed.ok ? '' : 'rootfs-install-failure' };
}

async function firmwareIntegration(attempt) {
  const finalConfig = await runStage(attempt, 'config', () =>
    prepareConfig(FINAL_STATES, attempt, { roots: true, metadata: false, label: 'final' }));
  attempt.rootStates = finalConfig.states;
  if (!finalConfig.ok) return { result: configFailureResult(finalConfig.reason), reason: finalConfig.reason };
  const firmware = await runStage(attempt, 'firmwareBuild', () =>
    makeWithSerialRetry([], 'final package firmware', attempt));
  if (!firmware.ok) {
    log('FAIL: Final package-enabled firmware failed');
    return { result: 'incompatible', reason: 'final-firmware-failure' };
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
    stages: {}, rootStates: {}, rootMappings: [], sourceMakefiles: [], rootTargets: [], serialRetries: [],
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
  useDefconfig: MODE === 'config-resolve' ? true : USE_DEFCONFIG,
  roots: ROOTS,
  packageIntent: INTENT,
  finalPackageCount: FINAL_STATES.size,
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

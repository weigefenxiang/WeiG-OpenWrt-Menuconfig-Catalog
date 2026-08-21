#!/usr/bin/env node
// SPDX-FileCopyrightText: 2026 weigefenxiang <weigefenxiang@gmail.com>
// SPDX-License-Identifier: GPL-3.0-or-later
import { appendFileSync, copyFileSync, createReadStream, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { availableParallelism } from 'node:os';
import { dirname, join, posix, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runVirtualProbe } from './package-probe-virtual.mjs';
import { classifyTargetPrerequisiteFailure, isMakeInfrastructureFailure, probeResultExitCode } from './package-probe-failure-classification.mjs';

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
const BASELINE_PACKAGE_CONFIG = Buffer.from(String(process.env.PROBE_BASELINE_PACKAGE_CONFIG || ''), 'base64url').toString('utf8');
const INTENT_JSON = Buffer.from(String(process.env.PROBE_PACKAGE_INTENT || 'W10'), 'base64url').toString('utf8');
const FINAL_STATES = parsePackageConfig(FINAL_PACKAGE_CONFIG);
const BASELINE_STATES = parsePackageConfig(BASELINE_PACKAGE_CONFIG, true);
const INTENT = parseIntent(INTENT_JSON);
const BASELINE_DIRECT_STATES = directIntentStates(INTENT, 'before');
const FINAL_DIRECT_STATES = directIntentStates(INTENT, 'after');
const DIRECT_STATES = FINAL_DIRECT_STATES;
const PAIRED_COMPARISON = String(process.env.PROBE_PAIRED_COMPARISON || '').toLowerCase() === 'true';
const BASELINE_ROOTS = INTENT.filter((row) => ['m', 'y'].includes(String(row?.before || 'n'))).map((row) => row.package);
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
let ACTIVE_PHASE_LOG = '';
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

function directIntentStates(rows, stateKey = 'after') {
  const states = new Map();
  for (const row of rows) {
    const packageName = String(row?.package || '');
    const value = String(row?.[stateKey] || 'n');
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
  if (ACTIVE_PHASE_LOG && resolve(ACTIVE_PHASE_LOG) !== resolve(LOG_FILE)) appendFileSync(ACTIVE_PHASE_LOG, text);
}

function phaseLogPath(label) {
  return join(dirname(LOG_FILE), `probe-${safeSlug(label)}.log`);
}

async function withPhaseLog(label, action) {
  const previous = ACTIVE_PHASE_LOG;
  const file = phaseLogPath(label);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, '');
  ACTIVE_PHASE_LOG = file;
  try {
    return await action(file);
  } finally {
    ACTIVE_PHASE_LOG = previous;
  }
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
      if (ACTIVE_PHASE_LOG && resolve(ACTIVE_PHASE_LOG) !== resolve(LOG_FILE)) appendFileSync(ACTIVE_PHASE_LOG, chunk);
    });
    child.stderr.on('data', (chunk) => {
      output = appendCommandOutput(output, chunk);
      process.stderr.write(chunk); appendFileSync(LOG_FILE, chunk);
      if (ACTIVE_PHASE_LOG && resolve(ACTIVE_PHASE_LOG) !== resolve(LOG_FILE)) appendFileSync(ACTIVE_PHASE_LOG, chunk);
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
  return isMakeInfrastructureFailure(result?.output);
}

function normalizePackageBuildTarget(value) {
  return String(value || '').replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/compile$/, '').replace(/\/+$/, '');
}

function failedPackageBuildTargets(result) {
  const text = String(result?.output || '');
  const candidates = [];
  const add = (target, index, source) => {
    const normalized = normalizePackageBuildTarget(target);
    if (!normalized) return;
    candidates.push({ target: normalized, index, source, depth: normalized.split('/').length });
  };
  for (const match of text.matchAll(/(ERROR:\s+)?(package\/[A-Za-z0-9_./+@-]+)\s+failed to build/gi)) {
    add(match[2], match.index || 0, match[1] ? 'explicit' : 'generic');
  }
  for (const match of text.matchAll(/\]\s+(package\/[A-Za-z0-9_./+@-]+\/compile)\s+Error\b/gi)) {
    add(match[1], match.index || 0, 'make');
  }
  for (const match of text.matchAll(/make(?:\[\d+\])?:\s+\*{3}\s+\[(package\/[A-Za-z0-9_./+@-]+\/compile)\]\s+Error\b/gim)) {
    add(match[1], match.index || 0, 'gnu-make');
  }
  for (const match of text.matchAll(/\*\*\*\s+(?:\[[^\]]+\]\s+)?(package\/[A-Za-z0-9_./+@-]+\/compile)\b/gi)) {
    add(match[1], match.index || 0, 'make');
  }
  if (!candidates.length) return [];
  // Pick the deepest target first; for equal-depth wrappers/inner targets,
  // the later log line is the most recently reported failure.  This keeps an
  // inner package target authoritative even when an explicit wrapper line
  // and a generic make line coexist in the same bounded command output.
  candidates.sort((left, right) => left.depth - right.depth || left.index - right.index);
  return [candidates[candidates.length - 1].target];
}

function classifyPackageBuildFailure(result, rootTargets, attempt, reasons, options = {}) {
  if (failedMakeIsInfrastructure(result)) return { result: 'inconclusive', reason: reasons.infrastructure };
  const failedTargets = failedPackageBuildTargets(result);
  attempt.failedBuildTargets = failedTargets;
  const roots = new Set((rootTargets || []).map(normalizePackageBuildTarget));
  if (failedTargets.some((target) => roots.has(target))) {
    attempt.packageCauseKind = 'direct';
    return { result: 'incompatible', reason: reasons.root };
  }
  const dependencies = new Set((options.dependencyTargets || attempt.newDependencyTargets || []).map(normalizePackageBuildTarget));
  if (failedTargets.some((target) => dependencies.has(target)) && reasons.dependency) {
    attempt.packageCauseKind = 'dependency';
    return { result: 'incompatible', reason: reasons.dependency };
  }
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

function classifyRootfsInstallFailure(result, attempt, roots = ROOTS, dependencyPackages = []) {
  if (failedMakeIsInfrastructure(result)) return { result: 'inconclusive', reason: 'rootfs-install-infrastructure' };
  const conflictPackages = rootfsConflictPackages(result);
  attempt.rootfsConflictPackages = conflictPackages;
  if (conflictPackages.some((packageName) => roots.includes(packageName))) {
    attempt.packageCauseKind = 'direct';
    return { result: 'incompatible', reason: 'rootfs-conflict' };
  }
  if (conflictPackages.some((packageName) => dependencyPackages.includes(packageName))) {
    attempt.packageCauseKind = 'dependency';
    return { result: 'incompatible', reason: 'rootfs-conflict' };
  }
  return { result: 'inconclusive', reason: conflictPackages.length ? 'rootfs-install-prerequisite-failure' : 'rootfs-install-unattributed-failure' };
}

function safeSlug(value) {
  return String(value || 'default').replace(/[^A-Za-z0-9_.-]/g, '-').replace(/-+/g, '-').slice(0, 120) || 'default';
}

function sha256Text(value) {
  return createHash('sha256').update(String(value || '')).digest('hex');
}

function enabledPackageNames(states) {
  return new Set(Object.entries(states || {}).filter(([, state]) => ['m', 'y'].includes(state)).map(([name]) => name));
}

function resolvedConfigDiff(baselineStates, finalStates, directRoots = ROOTS) {
  const baseline = enabledPackageNames(baselineStates);
  const final = enabledPackageNames(finalStates);
  const direct = new Set(directRoots);
  const added = [...final].filter((name) => !baseline.has(name)).sort();
  const removed = [...baseline].filter((name) => !final.has(name)).sort();
  const shared = [...final].filter((name) => baseline.has(name)).sort();
  return {
    added, removed, shared,
    addedDependencies: added.filter((name) => !direct.has(name)),
  };
}

function mappedBuildTargets(packageInfo, packages) {
  const mapping = parseUpstreamPackageInfo(packageInfo);
  const targets = [];
  for (const packageName of packages || []) {
    const sources = [...(mapping.get(packageName) || [])].map(safeSourceMakefile).sort();
    if (sources.length === 1) targets.push(`${posix.dirname(sources[0])}/compile`);
  }
  return [...new Set(targets)];
}

async function sha256File(file) {
  const hash = createHash('sha256');
  await new Promise((resolvePromise, rejectPromise) => {
    const stream = createReadStream(file);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', rejectPromise);
    stream.on('end', resolvePromise);
  });
  return hash.digest('hex');
}

async function firmwareSnapshot() {
  const directory = join(WORKDIR, 'bin', 'targets', TARGET_SYSTEM, SUBTARGET);
  if (!existsSync(directory)) return { directory, artifacts: [], manifestHash: '' };
  const artifacts = [];
  for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isFile()) continue;
    const file = join(directory, entry.name);
    const stats = statSync(file);
    artifacts.push({ name: entry.name, size: stats.size, sha256: await sha256File(file) });
  }
  return { directory, artifacts, manifestHash: sha256Text(JSON.stringify(artifacts)) };
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

async function resolveProbeConfig({ targetConfig, requestedStates, file, resolveConfig, roots, attempt, label, snapshotFile = '' }) {
  writeFileSync(file, probeConfigText(targetConfig, requestedStates));
  const result = await resolveConfig(file);
  if (!result.ok) return { ok: false, states: {}, config: file, reason: `${label}-defconfig-failure`, rejectedRoots: [] };
  const resolvedText = readFileSync(file, 'utf8');
  const resolvedStates = packageStatesFromText(resolvedText);
  const actual = Object.fromEntries(roots.map((root) => [root, resolvedStates.get(root) || 'n']));
  const directActual = Object.fromEntries([...requestedStates].map(([packageName]) => [packageName, resolvedStates.get(packageName) || 'n']));
  const rejected = [...requestedStates].filter(([packageName, state]) => directActual[packageName] !== state)
    .map(([packageName]) => packageName);
  if (attempt) {
    if (snapshotFile) {
      mkdirSync(dirname(snapshotFile), { recursive: true });
      copyFileSync(file, snapshotFile);
    }
    attempt.configPath = snapshotFile || file;
    attempt.configHash = sha256Text(resolvedText);
    attempt.resolvedPackageCount = resolvedStates.size;
    attempt.resolvedPackageStates = Object.fromEntries(resolvedStates);
  }
  if (rejected.length) {
    return { ok: false, states: actual, config: file, reason: 'root-kconfig-rejected', rejectedRoots: rejected };
  }
  return {
    ok: true, states: actual, config: file, resolvedPackageCount: resolvedStates.size,
    resolvedPackageStates: Object.fromEntries(resolvedStates), configHash: sha256Text(resolvedText), rejectedRoots: [],
  };
}

async function solveL1Config(environment, roots, suffix, attempt) {
  const directory = join(WORKDIR, '.probe-configs');
  mkdirSync(directory, { recursive: true });
  const file = join(directory, `${safeSlug(environment.target)}--${safeSlug(environment.profile)}--${safeSlug(suffix)}.config`);
  const resolver = join(WORKDIR, 'scripts', 'config', 'conf');
  const resolverShim = `${resolver}.mjs`;
  return resolveProbeConfig({
    targetConfig: environment.targetConfig, requestedStates: roots, file, roots: [...roots.keys()], attempt,
    label: 'l1', resolveConfig: (configFile) => existsSync(resolverShim)
      ? command(process.execPath, [resolverShim, `--defconfig=${configFile}`, '-w', configFile, 'Config.in'])
      : command(resolver, [`--defconfig=${configFile}`, '-w', configFile, 'Config.in']),
  });
}

async function prepareConfig(attempt, label = 'final', options = {}) {
  const roots = options.roots || ROOTS;
  const requestedStates = options.requestedStates || DIRECT_STATES;
  const file = options.file || join(WORKDIR, '.config');
  return resolveProbeConfig({
    targetConfig: TARGET_CONFIG, requestedStates, file, roots, attempt, label,
    snapshotFile: join(WORKDIR, '.probe-configs', `${safeSlug(label)}.config`),
    resolveConfig: () => make(['defconfig'], false),
  });
}

function packageNamesFromInfo(text) {
  return new Set([...String(text || '').matchAll(/^Package:\s*(\S+)$/gm)].map((match) => match[1]));
}

function newL1Attempt(environment, phase = 'final') {
  return {
    source: SOURCE, branch: BRANCH,
    targetSystem: environment.targetSystem, subtarget: environment.subtarget,
    target: environment.target, profile: environment.profile, profileLabel: environment.profileLabel,
    phase, stages: {}, rootStates: {}, unavailableRoots: [], rejectedRoots: [], serialRetries: [],
  };
}

async function configResolve(options = {}) {
  const roots = options.roots || ROOTS;
  const requested = options.requestedStates || DIRECT_STATES;
  const phase = options.phase || 'final';
  const requireEnabled = options.requireEnabled !== false;
  const environments = options.environments || TARGET_BATCH;
  log(`L1 environment batch / L1 环境批次: ${environments.length}`);
  const metadata = await command('bash', [join(ROOT, 'scripts', 'prepare-metadata.sh'), 'metadata-only']);
  if (!metadata.ok) {
    return environments.map((environment) => ({ ...newL1Attempt(environment, phase), result: 'inconclusive', reason: 'metadata-failure',
      stages: { metadata: 'failure' } }));
  }
  const resolver = await make(['scripts/config/conf'], false);
  if (!resolver.ok) {
    return environments.map((environment) => ({ ...newL1Attempt(environment, phase), result: 'inconclusive', reason: 'kconfig-resolver-failure',
      stages: { metadata: 'success', resolver: 'failure' } }));
  }
  const packageInfoPath = join(WORKDIR, 'tmp', '.packageinfo');
  if (!existsSync(packageInfoPath)) {
    return environments.map((environment) => ({ ...newL1Attempt(environment, phase), result: 'inconclusive', reason: 'metadata-unresolved',
      stages: { metadata: 'success', resolver: 'success' } }));
  }
  const packageNames = packageNamesFromInfo(readFileSync(packageInfoPath, 'utf8'));
  if (!packageNames.size) {
    return environments.map((environment) => ({ ...newL1Attempt(environment, phase), result: 'inconclusive', reason: 'metadata-unresolved',
      stages: { metadata: 'success', resolver: 'success' } }));
  }
  const globallyAbsent = roots.filter((root) => !packageNames.has(root));
  const attempts = [];
  for (const environment of environments) {
    const attempt = newL1Attempt(environment, phase);
    attempt.phaseLog = ACTIVE_PHASE_LOG;
    attempt.stages = { metadata: 'success', resolver: 'success' };
    if (globallyAbsent.length) {
      attempt.result = 'skipped'; attempt.reason = 'root-absent-source'; attempt.unavailableRoots = [...globallyAbsent];
      attempt.rootStates = Object.fromEntries(roots.map((root) => [root, globallyAbsent.includes(root) ? 'missing' : 'unknown']));
      attempts.push(attempt); continue;
    }
    log(`\nL1 Profile / 配置环境: ${SOURCE}/${BRANCH}/${environment.targetSystem}/${environment.subtarget}/${environment.profile}`);
    const combined = await solveL1Config(environment, requested, `${phase}-combined`, attempt);
    attempt.stages.kconfig = combined.ok ? 'success' : 'failure';
    if (!combined.ok) {
      attempt.result = 'inconclusive'; attempt.reason = 'defconfig-failure'; attempts.push(attempt); continue;
    }
    attempt.rootStates = combined.states;
    if (!requireEnabled) {
      attempt.result = 'compatible'; attempt.reason = ''; attempts.push(attempt); continue;
    }
    const rejected = roots.filter((root) => !['m', 'y'].includes(combined.states[root]));
    attempt.rejectedRoots = [...rejected];
    if (!rejected.length) {
      attempt.result = 'compatible'; attempt.reason = ''; attempts.push(attempt); continue;
    }
    const unavailable = [];
    for (const root of rejected) {
      const single = await solveL1Config(environment, new Map([[root, requested.get(root) || 'y']]), `${phase}-single-${root}`);
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

function phaseIdentity(row) {
  return [SOURCE, BRANCH, row?.targetSystem, row?.subtarget, row?.target, row?.profile].map((value) => String(value || '')).join('\0');
}

function pairIdFor(row) {
  return `pair:${sha256Text(phaseIdentity(row)).slice(0, 20)}`;
}

function phaseFailureFingerprint(phase) {
  return sha256Text(JSON.stringify({
    phase: phase?.phase || '', result: phase?.result || '', reason: phase?.reason || '',
    failedBuildTargets: phase?.failedBuildTargets || [], rootStates: phase?.rootStates || {},
  }));
}

function completedPhaseAttempt(attempt, result, startedAt, started) {
  attempt.result = result?.result || 'inconclusive';
  attempt.reason = result?.reason || '';
  attempt.selectedLevel = MODE_LEVELS[MODE];
  attempt.deepestPassedLevel = deepestPassedLevel(attempt);
  attempt.finishedAt = new Date().toISOString();
  attempt.durationMs = Math.max(0, Date.now() - started);
  attempt.failureFingerprint = phaseFailureFingerprint(attempt);
  return attempt;
}

function pairAttempt(baseline, final = null) {
  const selected = final || baseline || {};
  const pair = {
    ...selected,
    phase: 'paired',
    pairId: pairIdFor(selected),
    pairConclusion: final ? (final.result === 'incompatible'
      ? `incompatible-${final.packageCauseKind || 'unattributed'}`
      : final.result === 'inconclusive' ? 'inconclusive' : final.result || 'inconclusive')
      : 'baseline-failure',
    baseline,
    final: final || { phase: 'final', result: 'not-run', reason: 'baseline-failure', stages: {} },
  };
  if (final) Object.assign(pair, final);
  pair.phase = 'paired';
  pair.pairId = pairIdFor(selected);
  pair.baseline = baseline;
  pair.final = final || { phase: 'final', result: 'not-run', reason: 'baseline-failure', stages: {} };
  // A non-compatible B is an incomplete paired experiment, never a package
  // incompatibility.  Preserve B's native result only inside `baseline`.
  pair.result = final ? final.result : 'inconclusive';
  pair.reason = final ? final.reason : 'baseline-failure';
  pair.stages = final ? final.stages : (baseline?.stages || {});
  pair.packageCauseKind = final?.packageCauseKind || '';
  pair.baselineConfigHash = baseline?.configHash || '';
  pair.finalConfigHash = final?.configHash || '';
  pair.configHash = final?.configHash || baseline?.configHash || '';
  pair.resolvedConfigDiff = final?.configDiff || {};
  pair.configDiff = final?.configDiff || {};
  pair.addedDependencies = final?.newDependencyPackages || final?.configDiff?.addedDependencies || [];
  pair.newDependencyTargets = final?.newDependencyTargets || [];
  pair.failureFingerprint = final?.failureFingerprint || baseline?.failureFingerprint || phaseFailureFingerprint(pair);
  pair.finishedAt = final?.finishedAt || baseline?.finishedAt || new Date().toISOString();
  pair.durationMs = Math.max(0, Number(baseline?.durationMs || 0) + Number(final?.durationMs || 0));
  return pair;
}

function decorateL1Pair(baseline, final) {
  if (final && baseline?.resolvedPackageStates && final.resolvedPackageStates) {
    final.configDiff = resolvedConfigDiff(baseline.resolvedPackageStates, final.resolvedPackageStates, ROOTS);
    final.resolvedConfigDiff = final.configDiff;
    final.newDependencyPackages = final.configDiff.addedDependencies;
    try { final.newDependencyTargets = mappedBuildTargets(readPackageInfo(), final.newDependencyPackages); }
    catch { final.newDependencyTargets = []; }
  }
  return pairAttempt(baseline, final);
}

async function configResolvePaired() {
  const baseline = await withPhaseLog('baseline', () => configResolve({
    roots: BASELINE_ROOTS, requestedStates: BASELINE_DIRECT_STATES, phase: 'baseline', requireEnabled: true,
  }));
  const runnable = TARGET_BATCH.filter((environment, index) => baseline[index]?.result === 'compatible');
  const finalRows = runnable.length ? await withPhaseLog('final', () => configResolve({
    roots: ROOTS, requestedStates: FINAL_DIRECT_STATES, phase: 'final', requireEnabled: true, environments: runnable,
  })) : [];
  const finalByIdentity = new Map(finalRows.map((row) => [phaseIdentity(row), row]));
  return TARGET_BATCH.map((environment, index) => {
    const baselineAttempt = baseline[index];
    const finalAttempt = baselineAttempt?.result === 'compatible' ? finalByIdentity.get(phaseIdentity(environment)) || null : null;
    return decorateL1Pair(baselineAttempt, finalAttempt);
  });
}

async function runDepthPhase({ phase, roots, requestedStates, finalStates, baselineResolvedStates }) {
  const attempt = {
    source: SOURCE, branch: BRANCH, targetSystem: TARGET_SYSTEM, subtarget: SUBTARGET,
    target: TARGET, profile: PROFILE, phase,
    stages: {}, rootStates: {}, rootMappings: [], sourceMakefiles: [], rootTargets: [],
    unavailableRoots: [], rejectedRoots: [], serialRetries: [],
  };
  const started = Date.now();
  const startedAt = new Date(started).toISOString();
  attempt.startedAt = startedAt;
  let result;
  await withPhaseLog(phase, async (phaseLog) => {
    attempt.phaseLog = phaseLog;
    try {
      const options = { phase, roots, requestedStates, finalStates, baselineResolvedStates };
      if (MODE === 'package-compile') result = await packageCompile(attempt, options);
      else if (MODE === 'rootfs-integration') result = await rootfsIntegration(attempt, options);
      else result = await firmwareIntegration(attempt, options);
    } catch (error) {
      attempt.error = String(error?.message || error);
      result = { result: 'inconclusive', reason: 'runner-infrastructure' };
    }
  });
  return completedPhaseAttempt(attempt, result, startedAt, started);
}

async function runDepthPaired() {
  const baseline = await runDepthPhase({
    phase: 'baseline', roots: BASELINE_ROOTS, requestedStates: BASELINE_DIRECT_STATES,
    finalStates: BASELINE_STATES,
  });
  if (baseline.result !== 'compatible') return [pairAttempt(baseline)];
  const final = await runDepthPhase({
    phase: 'final', roots: ROOTS, requestedStates: FINAL_DIRECT_STATES,
    finalStates: FINAL_STATES, baselineResolvedStates: baseline.resolvedPackageStates || {},
  });
  return [pairAttempt(baseline, final)];
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

function classifyConfigFailure(config, attempt, roots = ROOTS) {
  if (config.reason !== 'root-kconfig-rejected') return { result: 'inconclusive', reason: config.reason };
  attempt.rejectedRoots = config.rejectedRoots || [];
  let packageInfo;
  try { packageInfo = readPackageInfo(); }
  catch (error) {
    log(`ERROR: ${error.message}`);
    return { result: 'inconclusive', reason: error.code || 'metadata-unresolved' };
  }
  const mapping = parseUpstreamPackageInfo(packageInfo);
  const unavailableRoots = roots.filter((root) => !(mapping.get(root)?.size));
  if (unavailableRoots.length) {
    attempt.unavailableRoots = unavailableRoots;
    log(`SKIP: Probe root package unavailable in Source/Branch: ${unavailableRoots.join(', ')}`);
    return { result: 'skipped', reason: 'root-absent-source' };
  }
  log(`FAIL: Probe root package rejected by upstream Kconfig: ${attempt.rejectedRoots.join(', ')}`);
  if (attempt.phase === 'final') attempt.packageCauseKind = 'direct';
  return { result: 'incompatible', reason: 'kconfig-unsatisfied' };
}

async function packageCompile(attempt, options = {}) {
  const roots = options.roots || ROOTS;
  const requestedStates = options.requestedStates || DIRECT_STATES;
  const phase = options.phase || 'final';
  const config = await runStage(attempt, 'config', () => prepareConfig(attempt, phase, {
    roots, requestedStates, file: options.configFile || join(WORKDIR, '.config'),
  }));
  attempt.rootStates = config.states;
  if (!config.ok) {
    const classified = classifyConfigFailure(config, attempt, roots);
    if (classified.result === 'skipped') attempt.stages.config.status = 'skipped';
    return classified;
  }
  if (options.baselineResolvedStates) {
    attempt.configDiff = resolvedConfigDiff(options.baselineResolvedStates, config.resolvedPackageStates, roots);
    attempt.resolvedConfigDiff = attempt.configDiff;
    attempt.newDependencyPackages = attempt.configDiff.addedDependencies;
    try {
      attempt.newDependencyTargets = mappedBuildTargets(readPackageInfo(), attempt.newDependencyPackages);
    } catch {
      attempt.newDependencyTargets = [];
    }
  }
  let resolved;
  try { resolved = await runStage(attempt, 'metadata', async () => resolveRootBuildTargets(readPackageInfo(), roots)); }
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
  if (!target.ok) {
    const classified = classifyTargetPrerequisiteFailure(target.output);
    if (classified.cause) attempt.targetPrerequisiteCause = classified.cause;
    return classified;
  }
  if (!resolved.targets.length) {
    attempt.stages.packageCompile = {
      status: 'skipped', startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(), durationMs: 0,
    };
    log(`SKIP: ${phase} has no direct package Root targets after defconfig`);
    return { result: 'compatible', reason: 'no-direct-roots' };
  }
  const compiled = await runStage(attempt, 'packageCompile', () =>
    makeWithSerialRetry(resolved.targets, `${phase} probe roots: ${roots.join(',')}`, attempt));
  if (!compiled.ok) {
    log(`ERROR: package compile target stage failed after resolved Roots: ${roots.join(', ')}`);
    return classifyPackageBuildFailure(compiled, resolved.targets, attempt, {
      root: 'package-compile-failure', infrastructure: 'package-compile-infrastructure',
      prerequisite: 'package-compile-prerequisite-failure', unattributed: 'package-compile-unattributed-failure',
      dependency: 'package-compile-dependency-failure',
    }, { dependencyTargets: options.dependencyTargets || attempt.newDependencyTargets });
  }
  return { result: 'compatible', reason: '' };
}

async function rootfsIntegration(attempt, options = {}) {
  const compiled = await packageCompile(attempt, options);
  if (compiled.result !== 'compatible') return compiled;
  const packages = await runStage(attempt, 'rootfsPackages', () =>
    makeWithSerialRetry(['package/compile'], 'RootFS selected packages', attempt));
  if (!packages.ok) return classifyPackageBuildFailure(packages, attempt.rootTargets, attempt, {
    root: 'rootfs-package-compile-failure', infrastructure: 'rootfs-package-infrastructure',
    prerequisite: 'rootfs-package-prerequisite-failure', unattributed: 'rootfs-package-unattributed-failure',
    dependency: 'rootfs-package-compile-dependency-failure',
  }, { dependencyTargets: options.dependencyTargets || attempt.newDependencyTargets });
  const installed = await runStage(attempt, 'rootfsInstall', () =>
    makeWithSerialRetry(['package/install'], 'rootfs install', attempt));
  if (!installed.ok) {
    log('FAIL: RootFS integration failed after Probe-root compilation');
    return classifyRootfsInstallFailure(installed, attempt, options.roots || ROOTS, options.dependencyPackages || attempt.newDependencyPackages || []);
  }
  return { result: 'compatible', reason: '' };
}

async function firmwareIntegration(attempt, options = {}) {
  const rootfs = await rootfsIntegration(attempt, options);
  if (rootfs.result !== 'compatible') return rootfs;
  const firmware = await runStage(attempt, 'firmwareBuild', () =>
    makeWithSerialRetry(['target/install'], 'final package firmware', attempt));
  if (!firmware.ok) {
    log('FAIL: Final package-enabled firmware failed');
    return classifyPackageBuildFailure(firmware, attempt.rootTargets, attempt, {
      root: 'final-firmware-failure', infrastructure: 'firmware-build-infrastructure',
      prerequisite: 'firmware-prerequisite-failure', unattributed: 'firmware-unattributed-failure',
      dependency: 'firmware-dependency-failure',
    }, { dependencyTargets: options.dependencyTargets || attempt.newDependencyTargets });
  }
  attempt.firmware = await firmwareSnapshot();
  if (MODE === 'firmware-integration') return { result: 'compatible', reason: '' };
  const virtual = await runVirtualProbe({
    mode: MODE,
    workdir: WORKDIR,
    targetSystem: TARGET_SYSTEM,
    subtarget: SUBTARGET,
    installedRoots: (options.roots || ROOTS).filter((root) => (options.finalStates || FINAL_STATES).get(root) === 'y'),
    logFile: join(dirname(LOG_FILE), `probe-virtual-${safeSlug(options.phase || 'final')}.log`),
    bootTimeoutMs: Number(process.env.PROBE_BOOT_TIMEOUT_SECONDS || 180) * 1000,
    controlTimeoutMs: Number(process.env.PROBE_CONTROL_TIMEOUT_SECONDS || 30) * 1000,
    observationMs: Number(process.env.PROBE_RUNTIME_OBSERVATION_SECONDS || 15) * 1000,
    onOutput: (text) => { process.stdout.write(text); appendFileSync(LOG_FILE, text); },
  });
  Object.assign(attempt.stages, virtual.stages);
  attempt.virtualCapabilities = virtual.capabilities;
  attempt.virtualLog = virtual.logFile;
  if (virtual.result === 'incompatible') attempt.packageCauseKind = 'direct';
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
  attempts = PAIRED_COMPARISON ? await configResolvePaired() : await configResolve();
  const results = attempts.map((row) => row.result);
  if (results.includes('inconclusive')) overallResult = 'inconclusive';
  else if (results.includes('incompatible')) overallResult = 'incompatible';
  else if (results.includes('compatible')) overallResult = 'compatible';
  else overallResult = 'skipped';
  overallReason = attempts.find((row) => row.result === overallResult)?.reason || '';
} else {
  if (PAIRED_COMPARISON) {
    attempts = await runDepthPaired();
    overallResult = attempts[0]?.result || 'inconclusive';
    overallReason = attempts[0]?.reason || '';
  } else {
    const attempt = {
      source: SOURCE, branch: BRANCH,
      targetSystem: TARGET_SYSTEM, subtarget: SUBTARGET, target: TARGET, profile: PROFILE,
      phase: 'final', stages: {}, rootStates: {}, rootMappings: [], sourceMakefiles: [], rootTargets: [], unavailableRoots: [], rejectedRoots: [], serialRetries: [],
    };
    const attemptStarted = Date.now();
    attempt.startedAt = new Date(attemptStarted).toISOString();
    let result;
    try {
      if (MODE === 'package-compile') result = await packageCompile(attempt);
      else if (MODE === 'rootfs-integration') result = await rootfsIntegration(attempt);
      else result = await firmwareIntegration(attempt);
    } catch (error) {
      attempt.error = String(error?.message || error);
      result = { result: 'inconclusive', reason: 'runner-infrastructure' };
    }
    attempt.result = result.result; attempt.reason = result.reason;
    attempt.selectedLevel = MODE_LEVELS[MODE];
    attempt.deepestPassedLevel = deepestPassedLevel(attempt);
    attempt.finishedAt = new Date().toISOString();
    attempt.durationMs = Math.max(0, Date.now() - attemptStarted);
    attempt.failureFingerprint = phaseFailureFingerprint(attempt);
    attempts = [attempt]; overallResult = result.result; overallReason = result.reason;
  }
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
  comparison: PAIRED_COMPARISON ? { mode: 'paired-exclusion', executionOrder: ['baseline', 'final'] } : null,
  pairedComparison: PAIRED_COMPARISON,
  environment: { source: SOURCE, branch: BRANCH, targetSystem: TARGET_SYSTEM, subtarget: SUBTARGET, target: TARGET, profile: PROFILE },
  attempts,
  conclusion: overallResult,
  reason: overallReason,
  durationMs: Math.max(0, Date.now() - runtimeStarted),
};
writeFileSync(RUNTIME_FILE, JSON.stringify(runtime, null, 2) + '\n');
if (runtime.reason) log(`Probe reason / 探针原因: ${runtime.reason}`);
log(`Probe conclusion / 探针结论: ${runtime.conclusion}`);
process.exitCode = probeResultExitCode(attempts);

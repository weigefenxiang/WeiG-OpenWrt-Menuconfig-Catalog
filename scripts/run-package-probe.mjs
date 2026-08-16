#!/usr/bin/env node
// SPDX-FileCopyrightText: 2026 weigefenxiang <weigefenxiang@gmail.com>
// SPDX-License-Identifier: GPL-3.0-or-later
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { availableParallelism } from 'node:os';
import { dirname, join, posix, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PACKAGE_RE = /^[A-Za-z0-9][A-Za-z0-9+_.@-]{0,95}$/;
const WORKDIR = resolve(process.env.PROBE_WORKDIR || join(ROOT, 'work', 'upstream'));
const LOG_FILE = resolve(process.env.PROBE_LOG || join(ROOT, 'probe.log'));
const RUNTIME_FILE = resolve(process.env.PROBE_RUNTIME || join(ROOT, 'probe-runtime.json'));
const MODE = String(process.env.PROBE_MODE || 'package-compile');
const USE_DEFCONFIG = String(process.env.PROBE_USE_DEFCONFIG || 'true') !== 'false';
const TARGET = String(process.env.PROBE_TARGET || '');
const PROFILE = String(process.env.PROBE_PROFILE || '');
const TARGET_SYSTEM = String(process.env.PROBE_TARGET_SYSTEM || '');
const SUBTARGET = String(process.env.PROBE_SUBTARGET || '');
const TARGET_CONFIG = String(process.env.PROBE_TARGET_CONFIG || '');
const FINAL_PACKAGE_CONFIG = Buffer.from(String(process.env.PROBE_PACKAGE_CONFIG || ''), 'base64url').toString('utf8');
const BASELINE_PACKAGE_CONFIG = Buffer.from(String(process.env.PROBE_BASELINE_PACKAGE_CONFIG || ''), 'base64url').toString('utf8');
const INTENT_JSON = Buffer.from(String(process.env.PROBE_PACKAGE_INTENT || 'W10'), 'base64url').toString('utf8');
const FINAL_STATES = parsePackageConfig(FINAL_PACKAGE_CONFIG);
const BASELINE_STATES = parsePackageConfig(BASELINE_PACKAGE_CONFIG, true);
const INTENT = parseIntent(INTENT_JSON);
const ROOTS = String(process.env.PROBE_ROOTS || '').split(',').map((row) => row.trim()).filter(Boolean);
const requestedJobs = Number(process.env.PROBE_JOBS || 0);
const JOBS = Number.isSafeInteger(requestedJobs) && requestedJobs > 0 ? requestedJobs : Math.max(1, availableParallelism() + 1);

if (!['package-compile', 'rootfs-integration', 'firmware-integration', 'boot-smoke'].includes(MODE)) {
  throw new Error(`unsupported probe mode: ${MODE}`);
}
if (!TARGET || !TARGET_CONFIG) throw new Error('Probe Target config is required');
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

function log(line = '') {
  const text = `${line}\n`;
  process.stdout.write(text);
  appendFileSync(LOG_FILE, text);
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
  return command('make', parallel ? [`-j${JOBS}`, ...args] : ['-j1', ...args]);
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
      log(`ERROR: directly selected Probe roots did not survive ${USE_DEFCONFIG ? 'make defconfig' : 'submitted config'}: ${JSON.stringify(actual)}`);
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

async function packageCompile(attempt) {
  const stages = {};
  const config = await prepareConfig(FINAL_STATES, attempt, { roots: true, metadata: true, label: 'final' });
  stages.kconfig = config.ok ? 'success' : 'failure';
  attempt.rootStates = config.states;
  if (!config.ok) return { result: 'incompatible', stages, reason: config.reason };
  let resolved;
  try { resolved = resolveRootBuildTargets(readPackageInfo()); }
  catch (error) {
    log(`ERROR: ${error.message}`);
    stages.metadata = 'failure';
    return { result: 'inconclusive', stages, reason: error.code || 'metadata-unresolved' };
  }
  stages.metadata = 'success';
  attempt.rootMappings = resolved.rootMappings;
  attempt.sourceMakefiles = resolved.sourceMakefiles;
  attempt.rootTargets = resolved.targets;
  log(`Upstream root build targets / 上游入口目标: ${resolved.targets.join(' ')}`);
  const environment = await makeWithSerialRetry(['tools/install', 'toolchain/install'], 'build environment', attempt);
  stages.environment = environment.ok ? 'success' : 'failure';
  if (!environment.ok) return { result: 'inconclusive', stages, reason: 'build-environment-failure' };
  const compiled = await makeWithSerialRetry(resolved.targets, `probe roots: ${ROOTS.join(',')}`, attempt);
  stages.packageCompile = compiled.ok ? 'success' : 'failure';
  if (!compiled.ok) log(`ERROR: package compile failed for Probe roots: ${ROOTS.join(', ')}`);
  return { result: compiled.ok ? 'compatible' : 'incompatible', stages, reason: compiled.ok ? '' : 'package-compile-failure' };
}

async function rootfsIntegration(attempt) {
  const compiled = await packageCompile(attempt);
  if (compiled.result !== 'compatible') return compiled;
  const installed = await makeWithSerialRetry(['package/install'], 'rootfs install', attempt);
  compiled.stages.rootfsInstall = installed.ok ? 'success' : 'failure';
  if (!installed.ok) log('ERROR: RootFS integration failed after Probe-root compilation');
  return { result: installed.ok ? 'compatible' : 'incompatible', stages: compiled.stages,
    reason: installed.ok ? '' : 'rootfs-install-failure' };
}

async function firmwareIntegration(attempt, boot) {
  const stages = {};
  const baselineConfig = await prepareConfig(BASELINE_STATES, attempt, { roots: false, metadata: false, label: 'baseline' });
  stages.baselineKconfig = baselineConfig.ok ? 'success' : 'failure';
  if (!baselineConfig.ok) return { result: 'inconclusive', stages, reason: 'baseline-kconfig-failure' };
  const baseline = await makeWithSerialRetry([], 'baseline firmware', attempt);
  stages.baselineFirmware = baseline.ok ? 'success' : 'failure';
  if (!baseline.ok) {
    log('ERROR: baseline firmware failed; package compatibility cannot be attributed');
    return { result: 'inconclusive', stages, reason: 'baseline-firmware-failure' };
  }
  const finalConfig = await prepareConfig(FINAL_STATES, attempt, { roots: true, metadata: false, label: 'final' });
  attempt.rootStates = finalConfig.states;
  stages.kconfig = finalConfig.ok ? 'success' : 'failure';
  if (!finalConfig.ok) return { result: 'incompatible', stages, reason: finalConfig.reason };
  const firmware = await makeWithSerialRetry([], 'final package firmware', attempt);
  stages.packageFirmware = firmware.ok ? 'success' : 'failure';
  if (!firmware.ok) {
    log('ERROR: Final package-enabled firmware failed after Baseline success');
    return { result: 'incompatible', stages, reason: 'final-firmware-failure' };
  }
  if (boot) {
    const smoke = await command('bash', [join(ROOT, 'scripts', 'run-boot-smoke.sh'), WORKDIR], { cwd: ROOT });
    stages.bootSmoke = smoke.ok ? 'success' : 'failure';
    return { result: smoke.ok ? 'compatible' : 'incompatible', stages, reason: smoke.ok ? '' : 'boot-smoke-failure' };
  }
  return { result: 'compatible', stages, reason: '' };
}

const attempt = {
  source: String(process.env.PROBE_SOURCE || ''), branch: String(process.env.PROBE_BRANCH || ''),
  targetSystem: TARGET_SYSTEM, subtarget: SUBTARGET, target: TARGET, profile: PROFILE,
  stages: {}, rootStates: {}, rootMappings: [], sourceMakefiles: [], rootTargets: [], serialRetries: [],
};
let result;
if (MODE === 'package-compile') result = await packageCompile(attempt);
else if (MODE === 'rootfs-integration') result = await rootfsIntegration(attempt);
else result = await firmwareIntegration(attempt, MODE === 'boot-smoke');
attempt.result = result.result;
attempt.reason = result.reason;
attempt.stages = result.stages;

const runtime = {
  schema: 2,
  generatedAt: new Date().toISOString(),
  mode: MODE,
  useDefconfig: USE_DEFCONFIG,
  roots: ROOTS,
  packageIntent: INTENT,
  baselinePackageCount: BASELINE_STATES.size,
  finalPackageCount: FINAL_STATES.size,
  environment: { source: attempt.source, branch: attempt.branch, targetSystem: TARGET_SYSTEM, subtarget: SUBTARGET, target: TARGET, profile: PROFILE },
  attempts: [attempt],
  conclusion: result.result,
  reason: result.reason,
};
writeFileSync(RUNTIME_FILE, JSON.stringify(runtime, null, 2) + '\n');
log(`Probe conclusion / 探针结论: ${runtime.conclusion}`);
process.exitCode = runtime.conclusion === 'compatible' ? 0 : 1;

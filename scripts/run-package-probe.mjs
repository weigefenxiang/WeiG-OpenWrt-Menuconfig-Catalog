#!/usr/bin/env node
// SPDX-FileCopyrightText: 2026 weigefenxiang <weigefenxiang@gmail.com>
// SPDX-License-Identifier: GPL-3.0-or-later
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PACKAGE_RE = /^[A-Za-z0-9][A-Za-z0-9+_.@-]{0,95}$/;
const WORKDIR = resolve(process.env.PROBE_WORKDIR || join(ROOT, 'work', 'upstream'));
const LOG_FILE = resolve(process.env.PROBE_LOG || join(ROOT, 'probe.log'));
const RUNTIME_FILE = resolve(process.env.PROBE_RUNTIME || join(ROOT, 'probe-runtime.json'));
const MODE = String(process.env.PROBE_MODE || 'package-compile');
const PACKAGES = String(process.env.PROBE_PACKAGES || '').split(',').map((row) => row.trim()).filter(Boolean);
let activePackages = PACKAGES;
const JOBS = Math.max(1, Number(process.env.PROBE_JOBS || process.env.RUNNER_CPU_COUNT || 2));

if (!['package-compile', 'rootfs-integration', 'firmware-integration', 'boot-smoke'].includes(MODE)) {
  throw new Error(`unsupported probe mode: ${MODE}`);
}
if (!PACKAGES.length || PACKAGES.some((name) => !PACKAGE_RE.test(name))) throw new Error('invalid PROBE_PACKAGES');

mkdirSync(dirname(LOG_FILE), { recursive: true });
if (!existsSync(LOG_FILE)) writeFileSync(LOG_FILE, '');

function log(line = '') {
  const text = `${line}\n`;
  process.stdout.write(text);
  appendFileSync(LOG_FILE, text);
}

async function command(file, args, options = {}) {
  log(`\n$ ${file} ${args.join(' ')}`);
  return new Promise((resolvePromise) => {
    const child = spawn(file, args, { cwd: options.cwd || WORKDIR, env: { ...process.env, ...(options.env || {}) },
      stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.on('data', (chunk) => { process.stdout.write(chunk); appendFileSync(LOG_FILE, chunk); });
    child.stderr.on('data', (chunk) => { process.stderr.write(chunk); appendFileSync(LOG_FILE, chunk); });
    child.on('error', (error) => { log(`ERROR: ${error.message}`); resolvePromise({ ok: false, code: -1 }); });
    child.on('close', (code) => resolvePromise({ ok: code === 0, code }));
  });
}

function candidateList() {
  const first = { target: process.env.PROBE_TARGET || '', profile: process.env.PROBE_PROFILE || '',
    config: process.env.PROBE_TARGET_CONFIG || '' };
  const rows = [first];
  if (process.env.PROBE_FALLBACK_TARGETS) {
    try { rows.push(...JSON.parse(Buffer.from(process.env.PROBE_FALLBACK_TARGETS, 'base64url').toString('utf8'))); }
    catch { throw new Error('PROBE_FALLBACK_TARGETS is invalid'); }
  }
  return rows.filter((row) => row.target && row.config);
}

function writeConfig(candidate, packageState = '') {
  const lines = [candidate.config];
  if (packageState) for (const packageName of activePackages) lines.push(`CONFIG_PACKAGE_${packageName}=${packageState}`);
  writeFileSync(join(WORKDIR, '.config'), `${lines.join('\n')}\n`);
}

function requestedStates() {
  const text = readFileSync(join(WORKDIR, '.config'), 'utf8');
  return Object.fromEntries(activePackages.map((name) => {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const match = text.match(new RegExp(`^CONFIG_PACKAGE_${escaped}=([my])$`, 'm'));
    return [name, match?.[1] || 'missing'];
  }));
}

async function make(args, parallel = true) {
  return command('make', parallel ? [`-j${JOBS}`, ...args] : ['-j1', ...args]);
}

async function prepareConfig(candidate, state) {
  writeConfig(candidate, state);
  const defconfig = await make(['defconfig'], false);
  const states = defconfig.ok ? requestedStates() : {};
  const expected = state === 'm' ? new Set(['m', 'y']) : new Set(['y']);
  const valid = defconfig.ok && Object.values(states).every((value) => expected.has(value));
  if (!valid) log(`ERROR: requested package states did not survive make defconfig: ${JSON.stringify(states)}`);
  return { ok: valid, states };
}

async function packageCompile(candidate, state, attempt) {
  const stages = {};
  const config = await prepareConfig(candidate, state);
  stages.kconfig = config.ok ? 'success' : 'failure';
  attempt.packageStates = config.states;
  if (!config.ok) return { ok: false, stages };
  const environment = await make(['tools/install', 'toolchain/install']);
  stages.environment = environment.ok ? 'success' : 'failure';
  if (!environment.ok) return { ok: false, stages };
  for (const packageName of activePackages) {
    let result = await make([`package/${packageName}/compile`, 'V=s']);
    if (!result.ok) {
      log(`Retry serial verbose / 串行详细复核: ${packageName}`);
      result = await make([`package/${packageName}/compile`, 'V=s'], false);
    }
    if (!result.ok) {
      log(`ERROR: package compile failed: ${packageName}`);
      stages.packageCompile = 'failure'; return { ok: false, stages };
    }
  }
  stages.packageCompile = 'success';
  return { ok: true, stages };
}

async function rootfsIntegration(candidate, attempt) {
  const compiled = await packageCompile(candidate, 'y', attempt);
  if (!compiled.ok) return compiled;
  const installed = await make(['package/install', 'V=s'], false);
  compiled.stages.rootfsInstall = installed.ok ? 'success' : 'failure';
  if (!installed.ok) log('ERROR: RootFS integration failed after package compilation');
  return { ok: installed.ok, stages: compiled.stages };
}

async function firmwareIntegration(candidate, attempt, boot) {
  const stages = {};
  writeConfig(candidate);
  const baseConfig = await make(['defconfig'], false);
  stages.baselineKconfig = baseConfig.ok ? 'success' : 'failure';
  if (!baseConfig.ok) return { ok: false, stages };
  const baseline = await make(['V=s']);
  stages.baselineFirmware = baseline.ok ? 'success' : 'failure';
  if (!baseline.ok) return { ok: false, stages };
  const packageConfig = await prepareConfig(candidate, 'y');
  attempt.packageStates = packageConfig.states;
  stages.kconfig = packageConfig.ok ? 'success' : 'failure';
  if (!packageConfig.ok) return { ok: false, stages };
  let firmware = await make(['V=s']);
  if (!firmware.ok) {
    log('Retry serial verbose / 串行详细复核: firmware');
    firmware = await make(['V=s'], false);
  }
  stages.packageFirmware = firmware.ok ? 'success' : 'failure';
  if (!firmware.ok) { log('ERROR: package-enabled firmware failed after baseline success'); return { ok: false, stages }; }
  if (boot) {
    const smoke = await command('bash', [join(ROOT, 'scripts', 'run-boot-smoke.sh'), WORKDIR], { cwd: ROOT });
    stages.bootSmoke = smoke.ok ? 'success' : 'failure';
    return { ok: smoke.ok, stages };
  }
  return { ok: true, stages };
}

async function runCandidate(candidate, index) {
  const attempt = { target: candidate.target, profile: candidate.profile || '', stages: {}, packageStates: {} };
  if (index > 0) {
    log(`Target fallback / 目标回退: ${candidate.target}/${candidate.profile || '-'}`);
    const clean = await make(['dirclean'], false);
    if (!clean.ok) return { ...attempt, result: 'failure', stages: { environmentReset: 'failure' } };
  }
  let result;
  if (MODE === 'package-compile') result = await packageCompile(candidate, 'm', attempt);
  else if (MODE === 'rootfs-integration') result = await rootfsIntegration(candidate, attempt);
  else result = await firmwareIntegration(candidate, attempt, MODE === 'boot-smoke');
  return { ...attempt, result: result.ok ? 'success' : 'failure', stages: result.stages };
}

const runtime = { schema: 1, generatedAt: new Date().toISOString(), mode: MODE, packages: PACKAGES,
  requestedCoverage: Number(process.env.PROBE_COVERAGE_TOTAL || 1), plannedCoverage: Number(process.env.PROBE_COVERAGE_PLANNED || 1),
  attempts: [] };
for (const [index, candidate] of candidateList().entries()) {
  const attempt = await runCandidate(candidate, index);
  runtime.attempts.push(attempt);
  if (attempt.result === 'success') break;
}
function packageFailureAttempt(attempt) {
  const stages = attempt?.stages || {};
  return attempt?.result === 'failure' && stages.baselineFirmware !== 'failure' &&
    stages.environment !== 'failure' && stages.environmentReset !== 'failure' &&
    (stages.kconfig === 'failure' ||
      ['packageCompile', 'rootfsInstall', 'packageFirmware'].some((stage) => stages[stage] === 'failure'));
}
async function reduceFailureSet(candidate, maximum) {
  let current = [...PACKAGES];
  let granularity = 2;
  const attempts = [];
  const tested = new Set();
  const test = async (subset) => {
    const key = subset.join('\0');
    if (!subset.length || tested.has(key) || attempts.length >= maximum) return false;
    tested.add(key);
    activePackages = subset;
    log(`Reduction candidate / 缩减候选: ${subset.join(',')}`);
    const clean = await make(['clean'], false);
    if (!clean.ok) {
      attempts.push({ packages: subset, result: 'inconclusive', stages: { environmentReset: 'failure' } });
      return false;
    }
    const attempt = await runCandidate(candidate, 0);
    const packageFailure = packageFailureAttempt(attempt);
    attempts.push({ packages: subset, result: packageFailure ? 'package-failure' : attempt.result, stages: attempt.stages,
      packageStates: attempt.packageStates });
    return packageFailure;
  };
  while (current.length > 1 && attempts.length < maximum) {
    const size = Math.ceil(current.length / granularity);
    const chunks = Array.from({ length: granularity }, (_, index) => current.slice(index * size, (index + 1) * size)).filter((row) => row.length);
    let reduced = false;
    for (const chunk of chunks) {
      const excluded = new Set(chunk);
      const complement = current.filter((name) => !excluded.has(name));
      if (await test(complement)) { current = complement; granularity = Math.max(2, granularity - 1); reduced = true; break; }
    }
    if (reduced) continue;
    for (const chunk of chunks) {
      if (await test(chunk)) { current = chunk; granularity = 2; reduced = true; break; }
    }
    if (reduced) continue;
    if (granularity >= current.length) break;
    granularity = Math.min(current.length, granularity * 2);
  }
  activePackages = PACKAGES;
  return { budget: maximum, attempts, candidateMinimalFailureSet: current };
}
const reductionBudget = Math.max(0, Math.min(16, Number(process.env.PROBE_REDUCTION_BUDGET || 0)));
if (runtime.attempts.length && PACKAGES.length > 1 && reductionBudget > 0 &&
    runtime.attempts.every(packageFailureAttempt)) {
  runtime.reduction = await reduceFailureSet(candidateList()[0], reductionBudget);
}
runtime.successes = runtime.attempts.filter((row) => row.result === 'success').length;
runtime.failures = runtime.attempts.filter((row) => row.result === 'failure').length;
runtime.coverageComplete = runtime.attempts.length >= runtime.requestedCoverage;
runtime.conclusion = runtime.successes > 0
  ? (runtime.failures > 0 ? 'partially-compatible' : runtime.coverageComplete ? 'fully-compatible' : 'sampled-compatible')
  : runtime.coverageComplete ? 'fully-incompatible' : 'inconclusive';
writeFileSync(RUNTIME_FILE, JSON.stringify(runtime, null, 2) + '\n');
log(`Probe conclusion / 探针结论: ${runtime.conclusion}`);
process.exitCode = runtime.successes > 0 ? 0 : 1;

// SPDX-License-Identifier: GPL-3.0-or-later
//
// Finalize a single Probe environment. Product conclusions are produced by
// the runner and normalized into evidence; this boundary accepts only a
// successful runner transport with a structurally reportable conclusion.
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isReportedInconclusive, probeResultExitCode } from './package-probe-failure-classification.mjs';

const REQUIRED_STEPS = Object.freeze([
  ['PROBE_BOOTSTRAP_OUTCOME', 'bootstrap'],
  ['PROBE_CLONE_OUTCOME', 'source clone'],
  ['PROBE_REQUIREMENTS_OUTCOME', 'runtime requirements'],
  ['PROBE_PYTHON_SETUP_OUTCOME', 'Python setup', true],
  ['PROBE_RUNTIME_SETUP_OUTCOME', 'runtime setup'],
  ['PROBE_FEEDS_OUTCOME', 'feeds'],
  ['PROBE_EVIDENCE_OUTCOME', 'evidence generation'],
  ['PROBE_EVIDENCE_UPLOAD_OUTCOME', 'evidence upload'],
  ['PROBE_LOG_UPLOAD_OUTCOME', 'log upload'],
]);

function normalizedOutcome(value) {
  return String(value || '').trim().toLowerCase();
}

function evidenceFiles(directory) {
  if (!existsSync(directory) || !statSync(directory).isDirectory()) return [];
  const files = [];
  for (const name of readdirSync(directory)) {
    const file = join(directory, name);
    const stat = statSync(file);
    if (stat.isDirectory()) files.push(...evidenceFiles(file));
    else if (name === 'evidence.json') files.push(file);
  }
  return files;
}

function readJson(file) {
  return JSON.parse(readFileSync(file, 'utf8'));
}

export function probeEnvironmentIdentity(row = {}) {
  return JSON.stringify([
    row.source || '', row.branch || '', row.targetSystem || '', row.subtarget || '',
    row.target || '', row.profile || '', row.phase || (row.pairConclusion ? 'paired' : 'final'), row.pairId || '',
  ].map((value) => String(value)));
}

export function runtimeEvidenceMatch(runtime, evidence) {
  const attempts = Array.isArray(runtime?.attempts) ? runtime.attempts : [];
  if (attempts.length !== evidence.length) return false;
  const counts = new Map();
  for (const attempt of attempts) {
    const key = probeEnvironmentIdentity(attempt);
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  for (const row of evidence) {
    const key = probeEnvironmentIdentity(row);
    const remaining = counts.get(key) || 0;
    if (!remaining) return false;
    if (remaining === 1) counts.delete(key);
    else counts.set(key, remaining - 1);
  }
  return counts.size === 0;
}

function report(lines, message) {
  lines.push(message);
  process.stdout.write(`${message}\n`);
}

export function evaluateFinalize({ env = process.env, runtime = null, evidence = [] } = {}) {
  const errors = [];
  const messages = [];
  for (const [key, label, allowSkipped = false] of REQUIRED_STEPS) {
    const outcome = normalizedOutcome(env[key]);
    if (outcome !== 'success' && !(allowSkipped && outcome === 'skipped')) {
      errors.push(`${label} step outcome is ${outcome || 'unknown'}`);
    }
  }

  const attempts = Array.isArray(runtime?.attempts) ? runtime.attempts : [];
  const buildOutcome = normalizedOutcome(env.PROBE_BUILD_OUTCOME);
  // Domain conclusions are valid only when the Runner completed normally. A
  // non-success build outcome is an execution failure, even if stale or
  // hand-written evidence happens to contain a conclusive result.
  if (buildOutcome !== 'success') errors.push(`build step outcome is ${buildOutcome || 'unknown'}`);
  if (!attempts.length) errors.push('probe runtime is missing or contains no attempts');
  else if (probeResultExitCode(attempts) !== 0) errors.push('probe runtime contains an unreported/infrastructure conclusion');

  if (!evidence.length) errors.push('normalized evidence is missing');
  if (attempts.length !== evidence.length) {
    errors.push(`runtime/evidence count mismatch (${attempts.length}/${evidence.length})`);
  } else if (!runtimeEvidenceMatch(runtime, evidence)) {
    errors.push('runtime/evidence environment identity mismatch');
  }
  for (const [index, row] of evidence.entries()) {
    const conclusion = String(row?.conclusion || '');
    if (!['compatible', 'incompatible', 'blocked', 'skipped', 'inconclusive'].includes(conclusion)) {
      errors.push(`evidence ${index + 1} has invalid conclusion ${conclusion || 'unknown'}`);
    } else if (conclusion === 'blocked' && (!String(row?.reason || '').trim() || !Array.isArray(row?.issues) ||
      !row.issues.some((issue) => issue?.type === 'base-profile-failure'))) {
      errors.push(`evidence ${index + 1} has an incomplete blocked Base Profile record`);
    } else if (conclusion === 'inconclusive' && !isReportedInconclusive({
      ...row,
      result: conclusion,
      baseline: row?.baseline,
      final: row?.final,
    })) {
      errors.push(`evidence ${index + 1} has an unreported/infrastructure inconclusive reason ${row.reason || 'unknown'}`);
    }
  }

  if (errors.length) {
    report(messages, `Finalize rejected Probe environment: ${errors.join('; ')}`);
    return { ok: false, errors, messages, buildOutcome };
  }
  report(messages, 'Probe environment finalized with successful runner transport and structured product conclusion.');
  return { ok: true, errors, messages, buildOutcome };
}

export function main(env = process.env) {
  const runtimePath = resolve(env.PROBE_RUNTIME_FILE || 'probe-runtime.json');
  const evidenceDirectory = resolve(env.PROBE_EVIDENCE_DIR || 'probe-evidence');
  let runtime = null;
  const evidence = [];
  const errors = [];
  try {
    if (existsSync(runtimePath)) runtime = readJson(runtimePath);
    else errors.push(`runtime file is missing: ${runtimePath}`);
  } catch (error) {
    errors.push(`runtime file is invalid: ${error.message}`);
  }
  const files = evidenceFiles(evidenceDirectory);
  if (!files.length) errors.push(`evidence directory contains no evidence.json: ${evidenceDirectory}`);
  for (const file of files) {
    try { evidence.push(readJson(file)); }
    catch (error) { errors.push(`evidence file is invalid (${file}): ${error.message}`); }
  }
  const result = evaluateFinalize({ env, runtime, evidence });
  if (errors.length) {
    process.stdout.write(`Finalize rejected Probe environment: ${errors.join('; ')}\n`);
    return 1;
  }
  return result.ok ? 0 : 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main();
}

#!/usr/bin/env node
// SPDX-FileCopyrightText: 2026 weigefenxiang <weigefenxiang@gmail.com>
// SPDX-License-Identifier: GPL-3.0-or-later
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { matchPattern } from './source-policy.mjs';
import { parseProbeStateToken } from './package-probe-state.mjs';
import { runtimeDataBranchForChannel } from './catalog-channels.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PACKAGE_RE = /^[A-Za-z0-9][A-Za-z0-9+_.@-]{0,95}$/;
const MODES = new Set(['config-resolve', 'package-compile', 'rootfs-integration', 'firmware-integration', 'boot-smoke',
  'runtime-health', 'reboot-validation']);
const MODE_ALIASES = { compile: 'package-compile', 'co-install': 'rootfs-integration' };
const MODES_LIST = ['config-resolve', 'package-compile', 'rootfs-integration', 'firmware-integration', 'boot-smoke',
  'runtime-health', 'reboot-validation'];
const VIRTUAL_MODES = new Set(['boot-smoke', 'runtime-health', 'reboot-validation']);
const REQUEST_KEYS = new Set([
  'schema', 'channel', 'mode', 'useDefconfig', 'baselinePackageConfig', 'packageConfig', 'packageIntent',
  'environmentScope', 'coverage', 'maxParallel', 'execute',
]);
const INTENT_KEYS = new Set(['package', 'before', 'after']);
const ENVIRONMENT_SCOPE_KEYS = new Set(['sources', 'branches', 'targetSystems', 'subtargets', 'profiles']);
const COVERAGE_KEYS = new Set(['mode', 'limit']);
const WRITE_PERMISSIONS = new Set(['admin', 'maintain', 'write']);
const DIMENSION_FIELDS = [
  ['sources', 'source'], ['branches', 'branch'], ['targetSystems', 'targetSystem'],
  ['subtargets', 'subtarget'], ['profiles', 'profile'],
];
const SOURCE_RUN_PRIORITY = Object.freeze(['immortalwrt', 'lede', 'openwrt']);
const PROBE_POLICY = JSON.parse(readFileSync(join(ROOT, '.github', 'automation-policy.json'), 'utf8')).probe || {};
const PROBE_COVERAGE_DEFAULT_LIMIT = Number(PROBE_POLICY.coverage?.defaultLimit);
const PROBE_COVERAGE_MAX_LIMIT = Number(PROBE_POLICY.coverage?.maxLimit);
if (!Number.isInteger(PROBE_COVERAGE_DEFAULT_LIMIT) || !Number.isInteger(PROBE_COVERAGE_MAX_LIMIT) ||
    PROBE_COVERAGE_DEFAULT_LIMIT < 1 || PROBE_COVERAGE_DEFAULT_LIMIT > PROBE_COVERAGE_MAX_LIMIT) {
  throw new Error('automation-policy.json requires probe.coverage defaultLimit/maxLimit');
}
export const PROBE_COVERAGE_LIMITS = Object.freeze({
  defaultLimit: PROBE_COVERAGE_DEFAULT_LIMIT, maxLimit: PROBE_COVERAGE_MAX_LIMIT,
});

const plainObject = (value) => Boolean(value && typeof value === 'object' && !Array.isArray(value));
const stableUnique = (values) => [...new Set(values)];
const safeKey = (value) => String(value || '').replace(/[^A-Za-z0-9_.-]/g, '-').replace(/-+/g, '-');

function rejectUnknownKeys(value, allowed, label) {
  const unknown = Object.keys(value || {}).filter((key) => !allowed.has(key));
  if (unknown.length) throw new Error(`${label} contains unknown keys: ${unknown.join(', ')}`);
}

export function normalizeProbeMode(value) {
  const mode = MODE_ALIASES[String(value || '')] || String(value || 'config-resolve');
  if (!MODES.has(mode)) throw new Error(`unsupported probe mode: ${value}`);
  return mode;
}

export function normalizePackageConfig(value, maximumBytes = 131072, options = {}) {
  const text = String(value || '').replace(/\r\n/g, '\n').trim();
  const allowEmpty = options.allowEmpty === true;
  if ((!text && !allowEmpty) || Buffer.byteLength(text, 'utf8') > maximumBytes) {
    throw new Error(`${options.label || 'packageConfig'} is ${text ? 'too large' : 'empty'}`);
  }
  const states = new Map();
  if (text) {
    for (const line of text.split('\n')) {
      const match = line.match(/^CONFIG_PACKAGE_([A-Za-z0-9][A-Za-z0-9+_.@-]{0,95})=([my])$/);
      if (!match) throw new Error(`invalid ${options.label || 'packageConfig'} line: ${line}`);
      const previous = states.get(match[1]);
      if (previous && previous !== match[2]) throw new Error(`conflicting package state: ${match[1]}`);
      states.set(match[1], match[2]);
    }
  }
  const packageConfig = states.size
    ? [...states].map(([name, state]) => `CONFIG_PACKAGE_${name}=${state}`).join('\n') + '\n'
    : '';
  return { packageConfig, packages: [...states.keys()], states };
}

function normalizedState(states, packageName) {
  return states.get(packageName) || 'n';
}

function normalizePackageIntent(value, baselineStates, finalStates) {
  if (!Array.isArray(value) || !value.length) throw new Error('packageIntent must contain at least one direct change');
  if (value.length > 1024) throw new Error('packageIntent is too large');
  const seen = new Set();
  const rows = value.map((raw) => {
    if (!plainObject(raw)) throw new Error('packageIntent row must be an object');
    rejectUnknownKeys(raw, INTENT_KEYS, 'packageIntent row');
    const packageName = String(raw.package || '');
    if (!PACKAGE_RE.test(packageName) || seen.has(packageName)) throw new Error(`invalid or duplicate packageIntent package: ${packageName}`);
    seen.add(packageName);
    const before = String(raw.before || 'n');
    const after = String(raw.after || 'n');
    if (!['n', 'm', 'y'].includes(before) || !['n', 'm', 'y'].includes(after) || before === after) {
      throw new Error(`invalid packageIntent state transition: ${packageName}`);
    }
    if (before !== normalizedState(baselineStates, packageName)) {
      throw new Error(`packageIntent baseline mismatch: ${packageName}`);
    }
    if (after !== normalizedState(finalStates, packageName)) {
      throw new Error(`packageIntent final-state mismatch: ${packageName}`);
    }
    return { package: packageName, before, after };
  });
  if (!rows.some((row) => row.after === 'm' || row.after === 'y')) {
    throw new Error('packageIntent must directly enable at least one package');
  }
  return rows.sort((a, b) => a.package.localeCompare(b.package));
}

function packageConfigFromIntent(rows, stateKey) {
  const selected = rows.filter((row) => row && ['m', 'y'].includes(row[stateKey]));
  return selected.length
    ? selected.map((row) => `CONFIG_PACKAGE_${row.package}=${row[stateKey]}`).join('\n') + '\n'
    : '';
}

function normalizeScopeValues(value, label, options = {}) {
  if (!Array.isArray(value) || !value.length || value.length > 256) {
    throw new Error(`${label} must contain 1-256 values`);
  }
  const rows = stableUnique(value.map((item) => String(item ?? '').trim()));
  if (rows.includes('*')) {
    if (rows.length !== 1) throw new Error(`${label} wildcard cannot be mixed with exact values`);
    return ['*'];
  }
  if (rows.some((item) => (!item && !options.allowEmpty) || /[\0\r\n]/.test(item) || item.length > 180)) {
    throw new Error(`${label} contains an invalid value`);
  }
  return rows.sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
}

export function normalizeEnvironmentScope(value) {
  if (!plainObject(value)) throw new Error('environmentScope is required');
  rejectUnknownKeys(value, ENVIRONMENT_SCOPE_KEYS, 'environmentScope');
  return {
    sources: normalizeScopeValues(value.sources, 'environmentScope.sources'),
    branches: normalizeScopeValues(value.branches, 'environmentScope.branches'),
    targetSystems: normalizeScopeValues(value.targetSystems, 'environmentScope.targetSystems'),
    subtargets: normalizeScopeValues(value.subtargets, 'environmentScope.subtargets'),
    profiles: normalizeScopeValues(value.profiles, 'environmentScope.profiles', { allowEmpty: true }),
  };
}

export function normalizeProbeCoverage(value) {
  if (!plainObject(value)) throw new Error('coverage is required');
  rejectUnknownKeys(value, COVERAGE_KEYS, 'coverage');
  const mode = String(value.mode || 'auto');
  if (!['auto', 'all'].includes(mode)) throw new Error(`unsupported coverage mode: ${mode}`);
  if (mode === 'all') return { mode: 'all' };
  const limit = Number(value.limit);
  if (!Number.isInteger(limit) || limit < 1 || limit > PROBE_COVERAGE_MAX_LIMIT) {
    throw new Error(`coverage.limit must be an integer from 1 to ${PROBE_COVERAGE_MAX_LIMIT}`);
  }
  return { mode: 'auto', limit };
}

export function normalizeProbeRequest(raw, maximumBytes = 131072) {
  if (!plainObject(raw)) throw new Error('probe request must be an object');
  rejectUnknownKeys(raw, REQUEST_KEYS, 'probe request');
  if (Number(raw.schema) !== 3) throw new Error('probe request requires schema 3');
  const channel = String(raw.channel || 'main');
  if (!runtimeDataBranchForChannel(channel)) throw new Error(`unsupported probe channel: ${channel}`);
  const baselineState = normalizePackageConfig(raw.baselinePackageConfig, maximumBytes,
    { allowEmpty: true, label: 'baselinePackageConfig' });
  const finalState = normalizePackageConfig(raw.packageConfig, maximumBytes, { label: 'packageConfig' });
  const packageIntent = normalizePackageIntent(raw.packageIntent, baselineState.states, finalState.states);
  const roots = packageIntent.filter((row) => row.after === 'm' || row.after === 'y').map((row) => row.package);
  const mode = normalizeProbeMode(raw.mode);
  if (raw.useDefconfig === false) {
    throw new Error('Package Probe requires upstream defconfig for every depth');
  }
  return {
    schema: 3,
    channel,
    mode,
    useDefconfig: true,
    baselinePackageConfig: packageConfigFromIntent(packageIntent, 'before'),
    packageConfig: packageConfigFromIntent(packageIntent, 'after'),
    packageIntent,
    roots,
    packages: [...roots],
    environmentScope: normalizeEnvironmentScope(raw.environmentScope),
    coverage: normalizeProbeCoverage(raw.coverage),
    maxParallel: raw.maxParallel === undefined ? 0 : Number(raw.maxParallel),
    execute: raw.execute !== false,
  };
}

function requireNormalizedProbeRequest(value) {
  if (!plainObject(value) || Number(value.schema) !== 3 || !Array.isArray(value.packages) || !Array.isArray(value.roots) ||
      !Array.isArray(value.packageIntent) || !plainObject(value.environmentScope) || !plainObject(value.coverage) ||
      typeof value.packageConfig !== 'string' || typeof value.baselinePackageConfig !== 'string') {
    throw new Error('createProbePlan requires a normalized Probe V3 request');
  }
  return value;
}

function targetConfig(target, profile) {
  const selectors = stableUnique([
    profile?.boardSelector || target.contract?.boardSelector,
    profile?.targetSelector || target.targetSelector || target.contract?.targetSelector,
    profile?.selector,
  ].map((value) => String(value || '').trim()).filter(Boolean));
  if (!selectors.length) return null;
  return {
    target: String(target.id || ''),
    targetSystem: String(target.board || ''),
    targetSystemLabel: String(target.systemName || target.board || ''),
    subtarget: String(target.subtarget || ''),
    subtargetLabel: String(target.subtargetLabel || target.subtargetName || target.subtarget || 'Default'),
    profile: String(profile?.id || ''),
    profileLabel: String(profile?.name || profile?.id || 'Default profile'),
    config: selectors.map((selector) => `CONFIG_${selector}=y`).join('\n'),
  };
}

function preferredProfile(profiles) {
  return profiles.find((row) => row.id === 'DEVICE_generic') || profiles.find((row) => row.id === 'generic') ||
    profiles.find((row) => row.id === 'Default') || profiles[0];
}

function targetRows(core, selections = []) {
  if (Number(core?.schema) !== 6 || !Array.isArray(core?.targets)) throw new Error('Catalog core schema 6 with targets is required');
  const rows = [];
  const mappings = [];
  const skipped = [];
  const append = (target, profile) => {
    const config = targetConfig(target, profile);
    if (!config) return false;
    const key = `${config.target}\0${config.profile}`;
    if (!rows.some((row) => `${row.target}\0${row.profile}` === key)) rows.push(config);
    return true;
  };
  const targets = core.targets.map((target) => ({
    target,
    profiles: (target.profiles || []).filter((profile) => profile?.selectable !== false && profile?.selector),
  }));
  if (Array.isArray(selections) && selections.length) {
    for (const selection of selections) {
      const targetId = String(selection?.target || '');
      const requestedProfile = String(selection?.profile || '');
      const entry = targets.find((row) => String(row.target?.id || '') === targetId);
      if (!entry) { skipped.push({ target: targetId, requestedProfile, reason: 'target-not-found' }); continue; }
      const { target, profiles } = entry;
      let profile = requestedProfile ? profiles.find((candidate) => String(candidate.id || '') === requestedProfile) : preferredProfile(profiles);
      if (requestedProfile && !profile && profiles.length === 1) {
        profile = profiles[0];
        mappings.push({ target: targetId, requestedProfile, resolvedProfile: String(profile.id || ''), reason: 'unique-selectable-profile' });
      } else if (requestedProfile && !profile) {
        skipped.push({ target: targetId, requestedProfile, candidates: profiles.map((candidate) => String(candidate.id || '')),
          reason: profiles.length ? 'profile-not-found-ambiguous' : 'profile-not-found' });
        continue;
      }
      if (!append(target, profile)) skipped.push({ target: targetId, requestedProfile, reason: 'selector-contract-missing' });
    }
    return { rows, mappings, skipped };
  }
  for (const { target, profiles } of targets) {
    const selectable = target?.contract?.selectable === true || target?.selectable === true || profiles.length > 0;
    if (!selectable) continue;
    if (profiles.length) {
      for (const profile of profiles) append(target, profile);
    } else if (!append(target, null)) {
      skipped.push({ target: String(target?.id || ''), requestedProfile: '', reason: 'selector-contract-missing' });
    }
  }
  if (!rows.length) skipped.push({ target: '', requestedProfile: '', reason: 'no-selectable-target' });
  return { rows, mappings, skipped };
}

function preferredTargets(rows, patterns = ['x86/64', '*']) {
  return [...rows].sort((left, right) => {
    const rank = (row) => {
      const index = patterns.findIndex((pattern) => matchPattern(row.target, pattern));
      return index < 0 ? patterns.length : index;
    };
    return rank(left) - rank(right) || left.target.localeCompare(right.target) || left.profile.localeCompare(right.profile);
  });
}

function scopeIncludes(values, value) {
  return values?.includes('*') || values?.includes(String(value ?? ''));
}

export function resolveProbeTargetConfigs(core, options = {}) {
  const resolved = targetRows(core, options.selections);
  let rows = preferredTargets(resolved.rows, options.preferredTargetPatterns || ['x86/64', '*']);
  const scope = options.environmentScope;
  if (scope) {
    rows = rows.filter((row) => scopeIncludes(scope.targetSystems, row.targetSystem) &&
      scopeIncludes(scope.subtargets, row.subtarget) && scopeIncludes(scope.profiles, row.profile));
  }
  if (VIRTUAL_MODES.has(options.mode)) {
    const bootPatterns = options.bootTargetPatterns || [];
    rows = rows.filter((row) => bootPatterns.some((pattern) => matchPattern(row.target, pattern)));
    if (!rows.length) resolved.skipped.push({ target: '', requestedProfile: '', reason: 'boot-target-not-supported' });
  }
  return { ...resolved, rows };
}

export function probeTargetConfigs(core, options = {}) {
  const resolved = resolveProbeTargetConfigs(core, options);
  if (!resolved.rows.length) {
    const reasons = stableUnique(resolved.skipped.map((row) => row.reason)).join(', ') || 'no-scope-match';
    throw new Error(`Catalog core contains no selectable Target for this probe mode (${reasons})`);
  }
  return resolved.rows;
}

export function probeTargetConfig(core) {
  const rows = targetRows(core).rows;
  const profileRows = rows.filter((row) => row.profile === 'DEVICE_generic' || row.profile === 'generic' || row.profile === 'Default');
  return preferredTargets(profileRows.length ? profileRows : rows)[0];
}

function branchScopeMatches(scope, source, branch) {
  return scopeIncludes(scope.sources, source) && scopeIncludes(scope.branches, branch);
}

function timeoutForMode(policy, mode) {
  const configured = Number(policy?.probe?.modeTimeoutMinutes?.[mode] || policy?.probe?.timeoutMinutes || 360);
  return Math.max(1, Math.min(360, configured));
}

function virtualTimingPolicy(policy) {
  const probe = policy?.probe || {};
  const seconds = (value, fallback, maximum) => {
    const number = Number(value || fallback);
    return Math.max(1, Math.min(maximum, Number.isFinite(number) ? Math.floor(number) : fallback));
  };
  return {
    bootTimeoutSeconds: seconds(probe.bootTimeoutSeconds, 180, 600),
    controlTimeoutSeconds: seconds(probe.controlTimeoutSeconds, 30, 120),
    runtimeObservationSeconds: seconds(probe.runtimeObservationSeconds, 15, 120),
  };
}

export function normalizeProbeAuthorization({ requester = '', repositoryOwner = '', permission = '' } = {}) {
  const actor = String(requester || '').trim();
  const repositoryOwnerName = String(repositoryOwner || '').trim();
  const owner = Boolean(repositoryOwnerName && actor.toLowerCase() === repositoryOwnerName.toLowerCase());
  const authorization = String(permission || (owner ? 'admin' : 'read')).trim().toLowerCase();
  return { actor, owner, authorization, elevatedParallel: owner || authorization === 'admin' };
}

function normalizedBatchIndex(value) {
  const index = Number(value || 0);
  if (!Number.isInteger(index) || index < 0 || index > 100000) throw new Error('probe batch index is invalid');
  return index;
}

export function createProbePlan({ index, env = {}, policy, request: normalizedRequest }) {
  if (Number(index?.schema) !== 2 || !Array.isArray(index?.sources)) throw new Error('Catalog index schema 2 is required');
  const probePolicy = policy?.probe || {};
  const maximumBytes = Number(probePolicy.maxPackageConfigBytes || 131072);
  if (!normalizedRequest) throw new Error('createProbePlan requires a normalized Probe V3 request');
  const request = requireNormalizedProbeRequest(normalizedRequest);
  const include = index.sources.filter((source) => String(source?.id || '').toLowerCase() !== 'hanwckf')
    .flatMap((source) => (source.branches || [])
    .filter((branch) => branch.state !== 'unavailable' &&
      branchScopeMatches(request.environmentScope, String(source.id || ''), String(branch.branch || '')))
    .map((branch) => ({
      key: safeKey(`${source.id}-${branch.branch}`), source: source.id, label: source.label || source.id,
      repo: source.repo, branch: branch.branch, upstreamCommit: branch.commit || '',
      coreAsset: branch.assets?.core?.asset || '', coreHash: branch.assets?.core?.hash || '',
    })));
  if (!include.length) throw new Error('Probe environment scope matched no available Catalog Source/Branch');
  const authorization = normalizeProbeAuthorization({
    requester: env.PROBE_REQUESTER || env.GITHUB_ACTOR || '', repositoryOwner: env.REPOSITORY_OWNER || '',
    permission: env.PROBE_AUTHORIZATION || '',
  });
  const maxMatrixJobs = Number(probePolicy.maxMatrixJobs || 256);
  const collaboratorCap = Number(probePolicy.collaboratorMaxParallel || 3);
  const requestedParallel = request.maxParallel === 0 ? maxMatrixJobs : request.maxParallel;
  if (!Number.isInteger(requestedParallel) || requestedParallel < 1 || requestedParallel > maxMatrixJobs) {
    throw new Error(`maxParallel must resolve to an integer from 1 to ${maxMatrixJobs}`);
  }
  return {
    schema: 3, generatedAt: new Date().toISOString(), actor: authorization.actor, owner: authorization.owner,
    authorized: env.PROBE_AUTHORIZED !== 'false', authorization: authorization.authorization,
    codeRef: request.channel, dataBranch: runtimeDataBranchForChannel(request.channel), dataCommit: String(env.PROBE_DATA_COMMIT || ''),
    stateSha256: String(env.PROBE_STATE_SHA256 || ''), samplingSeed: String(env.PROBE_SAMPLING_SEED || ''),
    batchIndex: normalizedBatchIndex(env.PROBE_BATCH_INDEX), mode: request.mode, evidenceLevel: MODES_LIST.indexOf(request.mode) + 1,
    execute: request.execute, useDefconfig: request.useDefconfig, requested: request.roots, directPackages: request.packages,
    packageIntent: request.packageIntent, baselinePackageConfig: request.baselinePackageConfig, packageConfig: request.packageConfig,
    environmentScope: request.environmentScope, coverageRequest: request.coverage, requestedMaxParallel: request.maxParallel,
    authorizationElevatedParallel: authorization.elevatedParallel, collaboratorCap,
    maxParallel: Math.max(1, Math.min(maxMatrixJobs, authorization.elevatedParallel ? requestedParallel : Math.min(collaboratorCap, requestedParallel))),
    timeoutMinutes: timeoutForMode(policy, request.mode), virtualTiming: virtualTimingPolicy(policy),
    matrix: { include }, mappings: [], skipped: [],
  };
}

async function fetchBuffer(url, token = '') {
  const response = await fetch(url, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  return Buffer.from(await response.arrayBuffer());
}

async function fetchJson(url, token = '') {
  return JSON.parse((await fetchBuffer(url, token)).toString('utf8'));
}

async function fetchVerifiedGzipJson(url, expectedHash, token = '') {
  const compressed = await fetchBuffer(url, token);
  const actualHash = createHash('sha256').update(compressed).digest('hex');
  if (!expectedHash || actualHash !== expectedHash) throw new Error(`${url}: compressed SHA-256 mismatch`);
  return JSON.parse(gunzipSync(compressed).toString('utf8'));
}

function rowIdentity(row) {
  return [row.source, row.branch, row.targetSystem, row.subtarget, row.profile, row.target].join('\0');
}

function sourceRunRank(source) {
  const rank = SOURCE_RUN_PRIORITY.indexOf(String(source || '').toLowerCase());
  return rank < 0 ? SOURCE_RUN_PRIORITY.length : rank;
}

function compareProbeRows(left, right) {
  const sourceRank = sourceRunRank(left.source) - sourceRunRank(right.source);
  if (sourceRank) return sourceRank;
  return rowIdentity(left).localeCompare(rowIdentity(right), undefined, { numeric: true });
}

function seededRank(seed, value) {
  return createHash('sha256').update(`${seed}\0${value}`).digest('hex');
}

function allocateGroupBudgets(groups, budget, seed, path) {
  const entries = [...groups.entries()].map(([key, rows]) => ({ key, rows, size: rows.length, allocation: 0, remainder: 0 }));
  if (budget >= entries.reduce((sum, row) => sum + row.size, 0)) {
    for (const entry of entries) entry.allocation = entry.size;
    return entries;
  }
  if (budget < entries.length) {
    entries.sort((a, b) => seededRank(seed, `${path}\0${a.key}`).localeCompare(seededRank(seed, `${path}\0${b.key}`)));
    for (let index = 0; index < budget; index++) entries[index].allocation = 1;
    return entries;
  }
  for (const entry of entries) entry.allocation = 1;
  let remaining = budget - entries.length;
  const capacities = entries.map((entry) => Math.max(0, entry.size - 1));
  const totalCapacity = capacities.reduce((sum, value) => sum + value, 0);
  if (remaining && totalCapacity) {
    entries.forEach((entry, index) => {
      const desired = remaining * capacities[index] / totalCapacity;
      const extra = Math.min(capacities[index], Math.floor(desired));
      entry.allocation += extra;
      entry.remainder = desired - extra;
    });
    let assigned = entries.reduce((sum, entry) => sum + entry.allocation, 0);
    const ordered = [...entries].sort((a, b) => b.remainder - a.remainder ||
      seededRank(seed, `${path}\0${a.key}`).localeCompare(seededRank(seed, `${path}\0${b.key}`)));
    while (assigned < budget) {
      let changed = false;
      for (const entry of ordered) {
        if (assigned >= budget) break;
        if (entry.allocation < entry.size) { entry.allocation += 1; assigned += 1; changed = true; }
      }
      if (!changed) break;
    }
  }
  return entries;
}

function stratifiedSample(rows, limit, dimensions, seed, depth = 0, path = '') {
  if (rows.length <= limit) return [...rows];
  if (!dimensions.length) {
    return [...rows].sort((a, b) => seededRank(seed, rowIdentity(a)).localeCompare(seededRank(seed, rowIdentity(b)))).slice(0, limit);
  }
  const [dimension, ...rest] = dimensions;
  const groups = new Map();
  for (const row of rows) {
    const key = String(row[dimension] ?? '');
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  const allocations = allocateGroupBudgets(groups, limit, seed, `${path}/${dimension}/${depth}`);
  const selected = [];
  for (const entry of allocations) {
    if (!entry.allocation) continue;
    selected.push(...stratifiedSample(entry.rows, entry.allocation, rest, seed, depth + 1, `${path}/${entry.key}`));
  }
  return selected;
}

export function selectProbeCoverage(rows, { coverage, environmentScope, samplingSeed }) {
  const ordered = [...rows].sort(compareProbeRows);
  if (coverage.mode === 'all') {
    if (ordered.length > PROBE_COVERAGE_MAX_LIMIT) {
      throw new Error(`Exhaustive coverage matched ${ordered.length} environments; narrow the scope to at most ${PROBE_COVERAGE_MAX_LIMIT}`);
    }
    return ordered;
  }
  if (ordered.length <= coverage.limit) return ordered;
  const wildcardDimensions = DIMENSION_FIELDS.filter(([scopeKey]) => environmentScope[scopeKey].includes('*')).map(([, field]) => field);
  return stratifiedSample(ordered, Math.min(coverage.limit, ordered.length), wildcardDimensions, samplingSeed).sort(compareProbeRows);
}

export async function attachProbeTargets(plan, { repository, dataRef, token, policy, loadCore, runId = '' } = {}) {
  const probePolicy = policy?.probe || {};
  const expand = async (sourceBranch) => {
    try {
      if (!loadCore && (!sourceBranch.coreAsset || !sourceBranch.coreHash)) throw new Error('Catalog core asset contract is missing');
      const core = loadCore ? await loadCore(sourceBranch) : await fetchVerifiedGzipJson(
        `https://raw.githubusercontent.com/${repository}/${dataRef}/${sourceBranch.coreAsset}`, sourceBranch.coreHash, token);
      const resolved = resolveProbeTargetConfigs(core, {
        mode: plan.mode, environmentScope: plan.environmentScope,
        preferredTargetPatterns: probePolicy.preferredTargetPatterns, bootTargetPatterns: probePolicy.bootTargetPatterns,
      });
      const annotate = (row) => ({ source: sourceBranch.source, branch: sourceBranch.branch, ...row });
      const rows = resolved.rows.map((selected) => ({
        ...sourceBranch, key: safeKey(`${sourceBranch.key}-${selected.target}-${selected.profile}`),
        targetSystem: selected.targetSystem, targetSystemLabel: selected.targetSystemLabel,
        subtarget: selected.subtarget, subtargetLabel: selected.subtargetLabel,
        target: selected.target, profile: selected.profile, profileLabel: selected.profileLabel, targetConfig: selected.config,
      }));
      return { rows, mappings: resolved.mappings.map(annotate), skipped: resolved.skipped.map(annotate) };
    } catch (error) {
      throw new Error(`${sourceBranch.source}/${sourceBranch.branch}: ${error.message}`, { cause: error });
    }
  };
  const input = plan.matrix.include;
  const expanded = new Array(input.length);
  let cursor = 0;
  const concurrency = Math.max(1, Math.min(8, Number(probePolicy.planFetchConcurrency || 4), input.length));
  await Promise.all(Array.from({ length: concurrency }, async () => {
    while (cursor < input.length) { const index = cursor++; expanded[index] = await expand(input[index]); }
  }));
  const candidates = expanded.flatMap((result) => result.rows);
  const mappings = expanded.flatMap((result) => result.mappings);
  const skipped = expanded.flatMap((result) => result.skipped);
  if (!candidates.length) {
    const failedPlan = { ...plan, maxParallel: 1, mappings: [...(plan.mappings || []), ...mappings], skipped, matrix: { include: [] } };
    const error = new Error('Probe environment scope resolved no buildable Source/Branch/Target/Profile environment');
    error.probePlan = failedPlan; throw error;
  }
  const samplingSeed = plan.samplingSeed || createHash('sha256')
    .update(`${plan.stateSha256 || createHash('sha256').update(plan.packageConfig).digest('hex')}\0${dataRef}\0${runId || Date.now()}`)
    .digest('hex').slice(0, 24);
  const planned = selectProbeCoverage(candidates, {
    coverage: plan.coverageRequest, environmentScope: plan.environmentScope, samplingSeed,
  });
  const batchSize = Math.max(1, Math.min(256, Number(probePolicy.maxMatrixJobs || 256)));
  const batchCount = Math.max(1, Math.ceil(planned.length / batchSize));
  if (plan.batchIndex >= batchCount) throw new Error(`Probe batch ${plan.batchIndex} is outside 0-${batchCount - 1}`);
  const selectedRows = planned.slice(plan.batchIndex * batchSize, (plan.batchIndex + 1) * batchSize).map((row) => ({
    ...row, coverageTotal: candidates.length, coveragePlanned: planned.length,
  }));
  let batchRows = selectedRows;
  if (plan.mode === 'config-resolve') {
    const groups = new Map();
    for (const row of selectedRows) {
      const groupKey = `${row.source}\0${row.branch}`;
      let group = groups.get(groupKey);
      if (!group) {
        group = { ...row, key: safeKey(`${row.source}-${row.branch}-l1-${plan.batchIndex}`), environments: [] };
        delete group.targetSystem; delete group.targetSystemLabel; delete group.subtarget; delete group.subtargetLabel;
        delete group.target; delete group.profile; delete group.profileLabel; delete group.targetConfig;
        groups.set(groupKey, group);
      }
      group.environments.push({
        targetSystem: row.targetSystem, targetSystemLabel: row.targetSystemLabel,
        subtarget: row.subtarget, subtargetLabel: row.subtargetLabel,
        target: row.target, profile: row.profile, profileLabel: row.profileLabel, targetConfig: row.targetConfig,
      });
    }
    batchRows = [...groups.values()].map((row) => ({ ...row, environmentCount: row.environments.length }));
  }
  const requestedParallel = plan.requestedMaxParallel === 0 ? batchRows.length : plan.requestedMaxParallel;
  const maxParallel = Math.max(1, Math.min(batchRows.length,
    plan.authorizationElevatedParallel ? requestedParallel : Math.min(plan.collaboratorCap, requestedParallel)));
  return {
    ...plan, dataCommit: String(dataRef), samplingSeed, mappings: [...(plan.mappings || []), ...mappings], skipped,
    coverage: { mode: plan.coverageRequest.mode, total: candidates.length, planned: planned.length,
      sampled: plan.coverageRequest.mode === 'auto' && planned.length < candidates.length },
    batchCount, hasNextBatch: plan.batchIndex + 1 < batchCount, nextBatchIndex: plan.batchIndex + 1,
    maxParallel, matrix: { include: batchRows },
  };
}

function writeOutputs(plan, extra = {}) {
  const output = process.env.GITHUB_OUTPUT;
  if (!output) return;
  const rows = {
    matrix: JSON.stringify(plan.matrix), max_parallel: String(plan.maxParallel), execute: String(plan.execute),
    relevant: String(plan.relevant !== false), authorized: String(plan.authorized), plan_count: String(plan.matrix.include.length),
    roots: plan.requested.join(','), packages: plan.directPackages.join(','),
    package_config: Buffer.from(plan.packageConfig || '').toString('base64url'),
    baseline_package_config: Buffer.from(plan.baselinePackageConfig || '').toString('base64url'),
    package_intent: Buffer.from(JSON.stringify(plan.packageIntent || [])).toString('base64url'),
    use_defconfig: String(plan.useDefconfig), data_branch: plan.dataBranch, data_commit: String(plan.dataCommit || ''),
    sampling_seed: String(plan.samplingSeed || ''), batch_index: String(plan.batchIndex || 0), batch_count: String(plan.batchCount || 1),
    has_next_batch: String(Boolean(plan.hasNextBatch)), next_batch_index: String(plan.nextBatchIndex || 0),
    coverage_total: String(plan.coverage?.total || 0), coverage_planned: String(plan.coverage?.planned || 0),
    coverage_mode: String(plan.coverage?.mode || plan.coverageRequest?.mode || 'auto'),
    coverage_sampled: String(Boolean(plan.coverage?.sampled)),
    mode: plan.mode, evidence_level: String(plan.evidenceLevel), timeout_minutes: String(plan.timeoutMinutes),
    boot_timeout_seconds: String(plan.virtualTiming?.bootTimeoutSeconds || 180),
    control_timeout_seconds: String(plan.virtualTiming?.controlTimeoutSeconds || 30),
    runtime_observation_seconds: String(plan.virtualTiming?.runtimeObservationSeconds || 15),
    issue_number: String(extra.issueNumber || ''),
  };
  appendFileSync(output, Object.entries(rows).map(([key, value]) => `${key}=${value}`).join('\n') + '\n');
}

const markdownCell = (value) => String(value ?? '').replace(/\|/g, '\\|');

export function probePlanSummary(plan) {
  const rows = [
    '## Package compatibility probe plan / 软件包兼容探针计划', '',
    `- Actor / 提交者: \`${plan.actor}\`${plan.owner ? ' (repository owner / 仓库所有者)' : ''}`,
    `- Authorization / 权限: \`${plan.authorization}\``,
    `- Catalog channel / Catalog 通道: \`${plan.dataBranch}\``,
    `- Catalog data commit / 数据提交: \`${plan.dataCommit || 'unresolved'}\``,
    `- Mode / 探测方式: \`${plan.mode}\``,
    `- Defconfig: \`${plan.useDefconfig ? 'on' : 'off'}\``,
    `- Probe roots / 测试入口: ${plan.requested.map((row) => `\`${row}\``).join(', ') || '-'}`,
    `- Direct Probe config / 直接探针配置: ${plan.directPackages.length}`,
    `- Coverage / 覆盖: \`${plan.coverage?.mode || plan.coverageRequest?.mode}\` ${plan.coverage ? `${plan.coverage.planned}/${plan.coverage.total}` : '-'}`,
    `- Batch / 批次: ${(plan.batchIndex || 0) + 1}/${plan.batchCount || 1}`,
    `- Maximum parallel jobs / 最大并发任务: ${plan.maxParallel}`,
    `- Execute / 执行: ${plan.execute ? (plan.mode === 'config-resolve' ? 'official Kconfig resolve' : 'build probe') : 'plan only'}`, '',
  ];
  if (!plan.authorized) rows.push('> Permission denied; no probe Matrix will be created. / 权限不足；不会创建探针 Matrix。', '');
  else if (!plan.execute) rows.push('> Plan only; no compilation was executed. / 仅生成计划；未执行编译。', '');
  if (plan.matrix.include.length) {
    if (plan.mode === 'config-resolve') rows.push(
      '| Source | Branch | L1 environments | Upstream commit |', '|---|---|---:|---|',
      ...plan.matrix.include.map((row) => `| ${markdownCell(row.source)} | ${markdownCell(row.branch)} | ${Number(row.environmentCount || 0)} | \`${row.upstreamCommit || 'unknown'}\` |`), '');
    else rows.push(
      '| Source | Branch | Target System | Subtarget | Profile | Upstream commit |',
      '|---|---|---|---|---|---|',
      ...plan.matrix.include.map((row) => `| ${markdownCell(row.source)} | ${markdownCell(row.branch)} | ${markdownCell(row.targetSystem || '-')} | ${markdownCell(row.subtarget || '-')} | ${markdownCell(row.profile || '-')} | \`${row.upstreamCommit || 'unknown'}\` |`), '');
  }
  if (plan.skipped?.length) rows.push(`- Skipped environment records / 跳过环境记录: ${plan.skipped.length}`, '');
  return rows.join('\n');
}

function writeSummary(plan) {
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, probePlanSummary(plan));
}

async function actorPermission(repository, actor, owner, token) {
  if (actor.toLowerCase() === owner.toLowerCase()) return 'admin';
  const response = await fetch(`https://api.github.com/repos/${repository}/collaborators/${encodeURIComponent(actor)}/permission`, {
    headers: { Accept: 'application/vnd.github+json', Authorization: `Bearer ${token}` },
  });
  if (response.status === 404) return 'read';
  if (!response.ok) throw new Error(`cannot resolve repository permission: HTTP ${response.status}`);
  return String((await response.json()).permission || 'read');
}

function manualRequest(env, maximumBytes, policy) {
  const final = normalizePackageConfig(env.PROBE_PACKAGE_CONFIG, maximumBytes);
  const baseline = normalizePackageConfig(env.PROBE_BASELINE_PACKAGE_CONFIG || '', maximumBytes, { allowEmpty: true });
  const requestedRoots = String(env.PROBE_ROOTS || '').split(',').map((row) => row.trim()).filter(Boolean);
  const roots = requestedRoots.length ? requestedRoots : final.packages;
  const intent = roots.map((packageName) => ({ package: packageName,
    before: normalizedState(baseline.states, packageName), after: normalizedState(final.states, packageName) }));
  const mode = env.PROBE_MODE || 'config-resolve';
  const coverageMode = env.COVERAGE_MODE || 'auto';
  const explicitLimit = String(env.COVERAGE_LIMIT || '').trim();
  return normalizeProbeRequest({
    schema: 3, channel: env.CODE_REF || env.GITHUB_REF_NAME || 'main', mode,
    useDefconfig: true, baselinePackageConfig: baseline.packageConfig,
    packageConfig: final.packageConfig, packageIntent: intent,
    environmentScope: {
      sources: [env.SOURCE_PATTERN || '*'], branches: [env.BRANCH_PATTERN || '*'],
      targetSystems: [env.TARGET_SYSTEM || '*'], subtargets: [env.SUBTARGET || '*'], profiles: [env.TARGET_PROFILE || '*'],
    },
    coverage: { mode: coverageMode, ...(coverageMode === 'all' ? {} : {
      limit: Number(explicitLimit || PROBE_COVERAGE_DEFAULT_LIMIT),
    }) },
    maxParallel: Number(env.MAX_PARALLEL || 0), execute: String(env.DRY_RUN || 'false') !== 'true',
  }, maximumBytes);
}

export async function main(env = process.env) {
  const policy = JSON.parse(readFileSync(join(ROOT, '.github', 'automation-policy.json'), 'utf8'));
  const maximumBytes = Number(policy.probe?.maxPackageConfigBytes || 131072);
  const repository = env.GITHUB_REPOSITORY || '';
  const owner = env.REPOSITORY_OWNER || repository.split('/')[0] || '';
  if (!repository || !owner) throw new Error('GITHUB_REPOSITORY is invalid');
  let actor = env.GITHUB_ACTOR || '';
  const issueNumber = String(env.PROBE_ISSUE_NUMBER || '');
  let request;
  let permission = 'read';
  if (issueNumber) {
    if (!/^\d+$/.test(issueNumber) || !env.PROBE_STATE_SHA256 || !env.PROBE_ISSUE_CREATED_AT) throw new Error('Issue probe dispatch identity is incomplete');
    const issue = await fetchJson(`https://api.github.com/repos/${repository}/issues/${issueNumber}`, env.GITHUB_TOKEN || '');
    if (issue.pull_request || !/^\[probe\](?:\s|$)/i.test(String(issue.title || ''))) throw new Error(`Issue #${issueNumber} is not a package probe request`);
    if (String(issue.created_at || '') !== String(env.PROBE_ISSUE_CREATED_AT)) throw new Error(`Issue #${issueNumber} creation identity changed`);
    const parsedState = parseProbeStateToken(issue.body || '');
    if (parsedState.sha256 !== String(env.PROBE_STATE_SHA256).toLowerCase()) throw new Error(`Issue #${issueNumber} generated Probe state changed after dispatch`);
    request = normalizeProbeRequest(parsedState.raw, maximumBytes);
    if (String(env.GITHUB_REF_NAME || '') !== request.channel) throw new Error(`probe worker ref ${env.GITHUB_REF_NAME} does not match request channel ${request.channel}`);
    actor = String(issue.user?.login || '');
    permission = await actorPermission(repository, actor, owner, env.GITHUB_TOKEN || '');
  } else {
    request = manualRequest(env, maximumBytes, policy);
    permission = await actorPermission(repository, actor, owner, env.GITHUB_TOKEN || '');
  }
  const authorized = WRITE_PERMISSIONS.has(permission);
  const dataBranch = runtimeDataBranchForChannel(request.channel);
  if (!dataBranch) throw new Error(`unsupported probe channel: ${request.channel}`);
  let plan;
  if (!authorized) {
    plan = {
      schema: 3, generatedAt: new Date().toISOString(), actor, owner: Boolean(owner && actor.toLowerCase() === owner.toLowerCase()),
      relevant: true, authorized: false, authorization: permission, codeRef: request.channel, dataBranch, dataCommit: '',
      mode: request.mode, evidenceLevel: 0, execute: false, useDefconfig: request.useDefconfig,
      requested: request.roots, directPackages: request.packages, packageIntent: request.packageIntent,
      baselinePackageConfig: request.baselinePackageConfig, packageConfig: request.packageConfig,
      environmentScope: request.environmentScope, coverageRequest: request.coverage, coverage: null,
      batchIndex: normalizedBatchIndex(env.PROBE_BATCH_INDEX), batchCount: 1, hasNextBatch: false, nextBatchIndex: 0,
      maxParallel: 1, timeoutMinutes: timeoutForMode(policy, request.mode), virtualTiming: virtualTimingPolicy(policy),
      mappings: [], skipped: [], matrix: { include: [] },
    };
  } else {
    const requestedDataRef = String(env.PROBE_DATA_COMMIT || dataBranch);
    const index = await fetchJson(`https://raw.githubusercontent.com/${repository}/${requestedDataRef}/index.json`, env.GITHUB_TOKEN || '');
    const dataCommit = String(env.PROBE_DATA_COMMIT || index.assetRef || dataBranch);
    if (env.PROBE_DATA_COMMIT && index.assetRef && String(index.assetRef) !== String(env.PROBE_DATA_COMMIT)) {
      throw new Error(`pinned Catalog data commit mismatch: ${index.assetRef} != ${env.PROBE_DATA_COMMIT}`);
    }
    const preliminary = createProbePlan({ index, request, policy, env: {
      ...env, CODE_REF: request.channel, PROBE_REQUESTER: actor, PROBE_AUTHORIZED: 'true', PROBE_AUTHORIZATION: permission,
      PROBE_DATA_COMMIT: dataCommit,
    } });
    try {
      plan = { ...(await attachProbeTargets(preliminary, {
        repository, dataRef: dataCommit, token: env.GITHUB_TOKEN || '', policy, runId: env.GITHUB_RUN_ID || '',
      })), relevant: true };
    } catch (error) {
      if (error.probePlan) {
        mkdirSync(join(ROOT, 'probe-diagnostics'), { recursive: true });
        writeFileSync(join(ROOT, 'probe-diagnostics', 'plan.json'), JSON.stringify(error.probePlan, null, 2) + '\n');
        writeOutputs(error.probePlan, { issueNumber }); writeSummary(error.probePlan);
      }
      throw error;
    }
  }
  mkdirSync(join(ROOT, 'probe-diagnostics'), { recursive: true });
  writeFileSync(join(ROOT, 'probe-diagnostics', 'plan.json'), JSON.stringify(plan, null, 2) + '\n');
  writeOutputs(plan, { issueNumber }); writeSummary(plan);
  console.log(`Probe plan / 探针计划: ${plan.matrix.include.length} jobs, max-parallel=${plan.maxParallel}, batch=${(plan.batchIndex || 0) + 1}/${plan.batchCount || 1}, authorized=${plan.authorized}`);
  return plan;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();

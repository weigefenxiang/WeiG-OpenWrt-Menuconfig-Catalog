#!/usr/bin/env node
// SPDX-FileCopyrightText: 2026 weigefenxiang <weigefenxiang@gmail.com>
// SPDX-License-Identifier: GPL-3.0-or-later
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { matchPattern } from './source-policy.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PACKAGE_RE = /^[A-Za-z0-9][A-Za-z0-9+_.@-]{0,95}$/;
const CHANNELS = { main: 'catalog-data', dev: 'catalog-dev', staging: 'catalog-staging' };
const MODES = new Set(['package-compile', 'rootfs-integration', 'firmware-integration', 'boot-smoke']);
const MODE_ALIASES = { compile: 'package-compile', 'co-install': 'rootfs-integration' };
const REQUEST_KEYS = new Set(['schema', 'channel', 'mode', 'packages', 'scope', 'targetPolicy', 'maxParallel', 'execute']);
const WRITE_PERMISSIONS = new Set(['admin', 'maintain', 'write']);

const plainObject = (value) => Boolean(value && typeof value === 'object' && !Array.isArray(value));
const stableUnique = (values) => [...new Set(values)];
const safeKey = (value) => String(value || '').replace(/[^A-Za-z0-9_.-]/g, '-').replace(/-+/g, '-');

function rejectUnknownKeys(value, allowed, label) {
  const unknown = Object.keys(value || {}).filter((key) => !allowed.has(key));
  if (unknown.length) throw new Error(`${label} contains unknown keys: ${unknown.join(', ')}`);
}

export function dataBranchForCodeRef(codeRef) {
  const ref = String(codeRef || '');
  return ref.startsWith('fix/') ? 'catalog-fix' : CHANNELS[ref] || '';
}

export function normalizeProbeMode(value) {
  const mode = MODE_ALIASES[String(value || '')] || String(value || 'package-compile');
  if (!MODES.has(mode)) throw new Error(`unsupported probe mode: ${value}`);
  return mode;
}

export function normalizePackageIds(value, maximum = 8) {
  const input = Array.isArray(value) ? value : String(value || '').split(/[\s,]+/);
  const packages = stableUnique(input.map((row) => String(row || '').trim()).filter(Boolean));
  if (!packages.length || packages.length > maximum || packages.some((name) => !PACKAGE_RE.test(name))) {
    throw new Error(`packages must contain 1-${maximum} valid Catalog application or package IDs`);
  }
  return packages;
}

export function resolveProbePackages(requested, applications) {
  const rows = Array.isArray(applications?.items) ? applications.items : [];
  const byId = new Map(rows.map((item) => [String(item.id || ''), item]));
  const resolved = [];
  const mappings = [];
  for (const id of requested) {
    const application = byId.get(id);
    const candidates = application
      ? [...(Array.isArray(application.packages) ? application.packages : []), application.package]
      : [id];
    const packages = stableUnique(candidates.map((row) => String(row || '').trim()).filter(Boolean));
    if (!packages.length || packages.some((name) => !PACKAGE_RE.test(name))) {
      throw new Error(`Catalog application ${id} has no valid package mapping`);
    }
    resolved.push(...packages);
    mappings.push({ id, packages, catalogApplication: Boolean(application) });
  }
  return { packages: stableUnique(resolved), mappings };
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
    profile: String(profile?.id || ''),
    config: selectors.map((selector) => `CONFIG_${selector}=y`).join('\n'),
  };
}

function targetRows(core, selections = []) {
  if (Number(core?.schema) !== 6 || !Array.isArray(core?.targets)) {
    throw new Error('Catalog core schema 6 with targets is required');
  }
  const rows = [];
  const selected = Array.isArray(selections) ? selections : [];
  for (const target of core.targets) {
    const profiles = (target.profiles || []).filter((profile) => profile?.selectable !== false && profile?.selector);
    const selectable = target?.contract?.selectable === true || target?.selectable === true || profiles.length > 0;
    if (!selectable) continue;
    const matching = selected.filter((row) => row.target === String(target.id || ''));
    if (selected.length && !matching.length) continue;
    const preferredProfile = profiles.find((row) => row.id === 'DEVICE_generic') ||
      profiles.find((row) => row.id === 'generic') || profiles.find((row) => row.id === 'Default') || profiles[0];
    const requestedProfiles = matching.length
      ? matching.map((row) => row.profile
        ? profiles.find((profile) => profile.id === row.profile)
        : preferredProfile).filter(Boolean)
      : [preferredProfile];
    for (const profile of requestedProfiles) {
      const config = targetConfig(target, profile);
      if (config && !rows.some((row) => row.target === config.target && row.profile === config.profile)) rows.push(config);
    }
  }
  return rows;
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

export function probeTargetConfigs(core, options = {}) {
  const patterns = options.preferredTargetPatterns || ['x86/64', '*'];
  let rows = preferredTargets(targetRows(core, options.selections), patterns);
  if (options.mode === 'boot-smoke') {
    const bootPatterns = options.bootTargetPatterns || [];
    rows = rows.filter((row) => bootPatterns.some((pattern) => matchPattern(row.target, pattern)));
  }
  if (!rows.length) throw new Error('Catalog core contains no selectable Target for this probe mode');
  return rows;
}

export function probeTargetConfig(core) {
  return probeTargetConfigs(core)[0];
}

function normalizeScope(value) {
  if (!plainObject(value)) return { mode: 'patterns', source: '*', branch: '*' };
  if (value.mode === 'all') return { mode: 'patterns', source: '*', branch: '*' };
  if (value.mode === 'patterns') {
    const source = String(value.source || '*');
    const branch = String(value.branch || '*');
    if (!matchPattern('OpenWrt', source) && !source.includes('*') && !/^[A-Za-z0-9._/-]+$/.test(source)) {
      throw new Error('probe scope contains an invalid Source pattern');
    }
    if (!branch.includes('*') && !/^[A-Za-z0-9._/-]+$/.test(branch)) {
      throw new Error('probe scope contains an invalid Branch pattern');
    }
    return { mode: 'patterns', source, branch };
  }
  if (value.mode === 'pairs' && Array.isArray(value.pairs)) {
    const pairs = value.pairs.map((row) => {
      if (!Array.isArray(row) || row.length !== 2 || !/^[A-Za-z0-9._/-]+$/.test(String(row[0])) ||
          !/^[A-Za-z0-9._/-]+$/.test(String(row[1]))) throw new Error('probe scope contains an invalid Source/Branch pair');
      return [String(row[0]), String(row[1])];
    });
    const unique = [...new Map(pairs.map((row) => [row.join('\0'), row])).values()];
    if (!unique.length || unique.length > 256) throw new Error('probe scope must contain 1-256 Source/Branch pairs');
    return { mode: 'pairs', pairs: unique };
  }
  throw new Error('probe scope must use all, patterns, or pairs mode');
}

function normalizeTargetPolicy(value) {
  if (typeof value === 'string') value = { mode: value };
  const row = plainObject(value) ? value : { mode: 'auto' };
  const mode = String(row.mode || 'auto');
  if (!['auto', 'all', 'selected'].includes(mode)) throw new Error(`unsupported Target policy: ${mode}`);
  if (mode !== 'selected') return { mode };
  const selections = (row.selections || []).map((selection) => ({
    target: String(selection?.target || ''), profile: String(selection?.profile || ''),
  })).filter((selection) => selection.target);
  if (!selections.length || selections.length > 64) throw new Error('selected Target policy requires 1-64 selections');
  return { mode, selections };
}

export function normalizeProbeRequest(raw, maximum = 8) {
  if (!plainObject(raw)) throw new Error('probe request must be an object');
  rejectUnknownKeys(raw, REQUEST_KEYS, 'probe request');
  if (Number(raw.schema) !== 1) throw new Error('probe request requires schema 1');
  const channel = String(raw.channel || 'main');
  if (!dataBranchForCodeRef(channel)) throw new Error(`unsupported probe channel: ${channel}`);
  return {
    schema: 1,
    channel,
    mode: normalizeProbeMode(raw.mode),
    packages: normalizePackageIds(raw.packages, maximum),
    scope: normalizeScope(raw.scope),
    targetPolicy: normalizeTargetPolicy(raw.targetPolicy),
    maxParallel: raw.maxParallel === undefined ? 0 : Number(raw.maxParallel),
    execute: raw.execute !== false,
  };
}

export function encodeProbeRequest(raw, maximum = 8) {
  const request = normalizeProbeRequest(raw, maximum);
  return `WEIG_PACKAGE_PROBE_V1:${Buffer.from(JSON.stringify(request)).toString('base64url')}`;
}

export function decodeProbeRequest(token, maximum = 8) {
  const match = String(token || '').trim().match(/^WEIG_PACKAGE_PROBE_V1:([A-Za-z0-9_-]{16,12000})$/);
  if (!match) throw new Error('probe request token is invalid');
  let raw;
  try { raw = JSON.parse(Buffer.from(match[1], 'base64url').toString('utf8')); }
  catch { throw new Error('probe request token is not valid JSON'); }
  return normalizeProbeRequest(raw, maximum);
}

export function probeRequestFromIssueBody(body, maximum = 8) {
  const match = String(body || '').match(/<!--\s*WEIG_PACKAGE_PROBE_REQUEST_V1\s*\n([A-Za-z0-9:_-]+)\s*\n-->/);
  if (!match) throw new Error('Issue does not contain a package probe request');
  return decodeProbeRequest(match[1], maximum);
}

function scopeMatches(scope, source, branch) {
  if (scope.mode === 'pairs') return scope.pairs.some(([sourceId, branchId]) => sourceId === source && branchId === branch);
  return matchPattern(source, scope.source) && matchPattern(branch, scope.branch);
}

function timeoutForMode(policy, mode) {
  const configured = Number(policy?.probe?.modeTimeoutMinutes?.[mode] || policy?.probe?.timeoutMinutes || 360);
  return Math.max(1, Math.min(360, configured));
}

export function createProbePlan({ index, applications, env = {}, policy, request: rawRequest }) {
  if (Number(index?.schema) !== 2 || !Array.isArray(index?.sources)) throw new Error('Catalog index schema 2 is required');
  const probePolicy = policy?.probe || {};
  const request = rawRequest ? normalizeProbeRequest(rawRequest, Number(probePolicy.maxPackages || 8)) : normalizeProbeRequest({
    schema: 1,
    channel: env.CODE_REF || 'main',
    mode: env.PROBE_MODE || 'package-compile',
    packages: env.PROBE_PACKAGES,
    scope: { mode: 'patterns', source: env.SOURCE_PATTERN || '*', branch: env.BRANCH_PATTERN || '*' },
    targetPolicy: { mode: env.TARGET_POLICY || 'auto' },
    maxParallel: env.MAX_PARALLEL === undefined || env.MAX_PARALLEL === '' ? 0 : Number(env.MAX_PARALLEL),
    execute: String(env.DRY_RUN || 'false') !== 'true',
  }, Number(probePolicy.maxPackages || 8));
  const resolved = resolveProbePackages(request.packages, applications);
  const include = index.sources.flatMap((source) => (source.branches || [])
    .filter((branch) => branch.state !== 'unavailable' && scopeMatches(request.scope, String(source.id || ''), String(branch.branch || '')))
    .map((branch) => ({
      key: safeKey(`${source.id}-${branch.branch}`), source: source.id, label: source.label || source.id,
      repo: source.repo, branch: branch.branch, upstreamCommit: branch.commit || '',
      coreAsset: branch.assets?.core?.asset || '', coreHash: branch.assets?.core?.hash || '',
      packages: resolved.packages.join(','),
    })));
  if (!include.length) throw new Error('probe scope matched no available Catalog Source/Branch');
  const owner = String(env.REPOSITORY_OWNER || '').toLowerCase();
  const actor = String(env.GITHUB_ACTOR || '').toLowerCase();
  const isOwner = Boolean(owner && actor === owner);
  const maxMatrixJobs = Number(probePolicy.maxMatrixJobs || 256);
  const collaboratorCap = Number(probePolicy.collaboratorMaxParallel || 3);
  const requestedParallel = request.maxParallel === 0 ? include.length : request.maxParallel;
  if (!Number.isInteger(requestedParallel) || requestedParallel < 1 || requestedParallel > maxMatrixJobs) {
    throw new Error(`maxParallel must resolve to an integer from 1 to ${maxMatrixJobs}`);
  }
  return {
    schema: 3,
    generatedAt: new Date().toISOString(),
    actor: env.GITHUB_ACTOR || '', owner: isOwner, authorized: env.PROBE_AUTHORIZED !== 'false',
    authorization: env.PROBE_AUTHORIZATION || (isOwner ? 'admin' : 'write'),
    codeRef: request.channel, dataBranch: dataBranchForCodeRef(request.channel),
    mode: request.mode, evidenceLevel: MODES_LIST.indexOf(request.mode) + 1,
    execute: request.execute, requested: request.packages, resolvedPackages: resolved.packages,
    mappings: resolved.mappings, scope: request.scope, targetPolicy: request.targetPolicy,
    requestedMaxParallel: request.maxParallel,
    maxParallel: Math.max(1, Math.min(include.length, isOwner ? requestedParallel : Math.min(collaboratorCap, requestedParallel))),
    timeoutMinutes: timeoutForMode(policy, request.mode), matrix: { include },
  };
}

const MODES_LIST = ['package-compile', 'rootfs-integration', 'firmware-integration', 'boot-smoke'];

async function fetchBuffer(url, token = '') {
  const headers = token ? { Authorization: `Bearer ${token}` } : {};
  let failure;
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const response = await fetch(url, { headers });
      if (response.ok) return Buffer.from(await response.arrayBuffer());
      failure = new Error(`HTTP ${response.status}`);
      if (response.status !== 429 && response.status < 500) break;
    } catch (error) {
      failure = error;
    }
    if (attempt < 3) await new Promise((resolveDelay) => setTimeout(resolveDelay, 300 * (2 ** attempt)));
  }
  throw new Error(`${url}: ${failure?.message || 'download failed'}`);
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

function selectionMatches(selection, row) {
  return selection.target === row.target && (!selection.profile || selection.profile === row.profile);
}

async function attachProbeTargets(plan, { repository, dataRef, token, policy }) {
  const probePolicy = policy?.probe || {};
  const expand = async (sourceBranch) => {
    if (!sourceBranch.coreAsset || !sourceBranch.coreHash) throw new Error(`${sourceBranch.source}/${sourceBranch.branch}: Catalog core asset contract is missing`);
    const core = await fetchVerifiedGzipJson(
      `https://raw.githubusercontent.com/${repository}/${dataRef}/${sourceBranch.coreAsset}`,
      sourceBranch.coreHash, token);
    let candidates = probeTargetConfigs(core, {
      mode: plan.mode,
      preferredTargetPatterns: probePolicy.preferredTargetPatterns,
      bootTargetPatterns: probePolicy.bootTargetPatterns,
      selections: plan.targetPolicy.mode === 'selected' ? plan.targetPolicy.selections : [],
    });
    if (plan.targetPolicy.mode === 'selected') candidates = candidates.filter((row) =>
      plan.targetPolicy.selections.some((selection) => selectionMatches(selection, row)));
    if (!candidates.length) throw new Error(`${sourceBranch.source}/${sourceBranch.branch}: selected Target policy matched no buildable environment`);
    const expanded = [];
    if (plan.targetPolicy.mode === 'auto') {
      const maximum = Number(probePolicy.maxAutoTargetAttempts || 8);
      const selected = candidates[0];
      const fallback = candidates.slice(1, maximum);
      expanded.push({ ...sourceBranch, key: safeKey(`${sourceBranch.key}-${selected.target}-${selected.profile}`),
        target: selected.target, profile: selected.profile, targetConfig: selected.config,
        fallbackTargets: Buffer.from(JSON.stringify(fallback)).toString('base64url'),
        coverageTotal: candidates.length, coveragePlanned: 1 + fallback.length,
        reductionBudget: Number(probePolicy.reductionMaxAttempts?.[plan.mode] || 0) });
    } else {
      for (const selected of candidates) expanded.push({ ...sourceBranch,
        key: safeKey(`${sourceBranch.key}-${selected.target}-${selected.profile}`),
        target: selected.target, profile: selected.profile, targetConfig: selected.config,
        fallbackTargets: '', coverageTotal: candidates.length, coveragePlanned: candidates.length,
        reductionBudget: Number(probePolicy.reductionMaxAttempts?.[plan.mode] || 0) });
    }
    return expanded;
  };
  const input = plan.matrix.include;
  const expanded = new Array(input.length);
  let cursor = 0;
  const concurrency = Math.max(1, Math.min(8, Number(probePolicy.planFetchConcurrency || 4), input.length));
  await Promise.all(Array.from({ length: concurrency }, async () => {
    while (cursor < input.length) {
      const index = cursor++;
      expanded[index] = await expand(input[index]);
    }
  }));
  const rows = expanded.flat();
  const limit = Number(probePolicy.maxMatrixJobs || 256);
  if (rows.length > limit) throw new Error(`probe plan has ${rows.length} jobs; the configured limit is ${limit}`);
  const maxParallel = plan.owner && plan.requestedMaxParallel === 0
    ? rows.length : Math.min(plan.maxParallel, rows.length);
  return { ...plan, maxParallel, matrix: { include: rows } };
}

function writeOutputs(plan, extra = {}) {
  const output = process.env.GITHUB_OUTPUT;
  if (!output) return;
  const rows = {
    matrix: JSON.stringify(plan.matrix), max_parallel: String(plan.maxParallel), execute: String(plan.execute),
    relevant: String(plan.relevant !== false), authorized: String(plan.authorized), plan_count: String(plan.matrix.include.length),
    packages: plan.resolvedPackages.join(','), data_branch: plan.dataBranch, mode: plan.mode,
    evidence_level: String(plan.evidenceLevel), timeout_minutes: String(plan.timeoutMinutes),
    issue_number: String(extra.issueNumber || ''),
  };
  appendFileSync(output, Object.entries(rows).map(([key, value]) => `${key}=${value}`).join('\n') + '\n');
}

function writeSummary(plan) {
  const rows = [
    '## Package compatibility probe plan / 软件包兼容探针计划', '',
    `- Actor / 提交者: \`${plan.actor}\`${plan.owner ? ' (repository owner / 仓库所有者)' : ''}`,
    `- Authorization / 权限: \`${plan.authorization}\``,
    `- Catalog channel / Catalog 通道: \`${plan.dataBranch}\``,
    `- Mode / 探测方式: \`${plan.mode}\``,
    `- Requested / 请求: ${plan.requested.map((row) => `\`${row}\``).join(', ') || '-'}`,
    `- Resolved packages / 实际软件包: ${plan.resolvedPackages.map((row) => `\`${row}\``).join(', ') || '-'}`,
    `- Source/Branch/Target jobs / 源码分支目标任务: ${plan.matrix.include.length}`,
    `- Maximum parallel jobs / 最大并发任务: ${plan.maxParallel}`,
    `- Execute compilation / 执行编译: ${plan.execute}`,
    '',
  ];
  if (!plan.authorized) rows.push('> Permission denied; no probe Matrix will be created. / 权限不足；不会创建探针 Matrix。', '');
  else if (!plan.execute) rows.push('> Plan only; no compilation was executed, so no compatibility conclusion or build log is available. / 仅生成计划；未执行编译，因此没有兼容性结论或构建日志。', '');
  if (plan.matrix.include.length) rows.push(
    '| Source | Branch | Target/Profile | Coverage / 覆盖 | Upstream commit / 上游提交 |',
    '|---|---|---|---:|---|',
    ...plan.matrix.include.map((row) => `| ${row.source} | ${row.branch} | ${row.target || '-'}/${row.profile || '-'} | ${row.coveragePlanned || 1}/${row.coverageTotal || 1} | \`${row.upstreamCommit || 'unknown'}\` |`), '');
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, rows.join('\n'));
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

function manualRequest(env, maximum) {
  if (env.PROBE_REQUEST) return decodeProbeRequest(env.PROBE_REQUEST, maximum);
  return normalizeProbeRequest({ schema: 1, channel: env.CODE_REF || env.GITHUB_REF_NAME || 'main',
    mode: env.PROBE_MODE || 'package-compile', packages: env.PROBE_PACKAGES,
    scope: { mode: 'patterns', source: env.SOURCE_PATTERN || '*', branch: env.BRANCH_PATTERN || '*' },
    targetPolicy: { mode: env.TARGET_POLICY || 'auto' }, maxParallel: Number(env.MAX_PARALLEL || 0),
    execute: String(env.DRY_RUN || 'false') !== 'true' }, maximum);
}

export async function main(env = process.env) {
  const policy = JSON.parse(readFileSync(join(ROOT, '.github', 'automation-policy.json'), 'utf8'));
  const maximum = Number(policy.probe?.maxPackages || 8);
  const repository = env.GITHUB_REPOSITORY || '';
  const owner = env.REPOSITORY_OWNER || repository.split('/')[0] || '';
  const actor = env.GITHUB_ACTOR || '';
  const issueEvent = env.GITHUB_EVENT_NAME === 'issues';
  let issueNumber = '';
  let request;
  let permission = owner && actor.toLowerCase() === owner.toLowerCase() ? 'admin' : 'write';
  if (issueEvent) {
    const event = JSON.parse(readFileSync(env.GITHUB_EVENT_PATH, 'utf8'));
    issueNumber = event.issue?.number || '';
    const issueBody = String(event.issue?.body || '');
    if (!issueBody.includes('WEIG_PACKAGE_PROBE_REQUEST_V1')) {
      const irrelevant = { schema: 3, generatedAt: new Date().toISOString(), actor, owner: false, relevant: false,
        authorized: false, authorization: 'not-a-probe-request', codeRef: 'main', dataBranch: 'catalog-data',
        mode: 'package-compile', evidenceLevel: 0, execute: false, requested: [], resolvedPackages: [], mappings: [],
        scope: { mode: 'patterns', source: '*', branch: '*' }, targetPolicy: { mode: 'auto' }, maxParallel: 1,
        timeoutMinutes: timeoutForMode(policy, 'package-compile'), matrix: { include: [] } };
      writeOutputs(irrelevant, { issueNumber });
      console.log('Issue is not a package probe request / Issue 不是软件包探针请求');
      return irrelevant;
    }
    request = probeRequestFromIssueBody(issueBody, maximum);
    permission = await actorPermission(repository, actor, owner, env.GITHUB_TOKEN || '');
  } else request = manualRequest(env, maximum);
  const authorized = WRITE_PERMISSIONS.has(permission);
  const dataBranch = dataBranchForCodeRef(request.channel);
  if (!repository || !dataBranch) throw new Error(`unsupported probe channel: ${request.channel}`);
  let plan;
  if (!authorized) {
    plan = { schema: 3, generatedAt: new Date().toISOString(), actor, owner: false, relevant: true, authorized: false,
      authorization: permission, codeRef: request.channel, dataBranch, mode: request.mode, evidenceLevel: 0,
      execute: false, requested: request.packages, resolvedPackages: [], mappings: [], scope: request.scope,
      targetPolicy: request.targetPolicy, maxParallel: 1, timeoutMinutes: timeoutForMode(policy, request.mode),
      matrix: { include: [] } };
  } else {
    const base = `https://raw.githubusercontent.com/${repository}/${dataBranch}`;
    const index = await fetchJson(`${base}/index.json`, env.GITHUB_TOKEN || '');
    const appContract = index.assets?.applications;
    if (!appContract?.asset || !appContract?.hash) throw new Error('Catalog index lacks an applications asset contract');
    const applications = await fetchVerifiedGzipJson(
      `https://raw.githubusercontent.com/${repository}/${index.assetRef || dataBranch}/${appContract.asset}`,
      appContract.hash, env.GITHUB_TOKEN || '');
    const preliminary = createProbePlan({ index, applications, request, policy,
      env: { ...env, CODE_REF: request.channel, DATA_BRANCH: dataBranch, PROBE_AUTHORIZED: 'true', PROBE_AUTHORIZATION: permission } });
    plan = { ...(await attachProbeTargets(preliminary, { repository, dataRef: String(index.assetRef || dataBranch), token: env.GITHUB_TOKEN || '', policy })), relevant: true };
  }
  mkdirSync(join(ROOT, 'probe-diagnostics'), { recursive: true });
  writeFileSync(join(ROOT, 'probe-diagnostics', 'plan.json'), JSON.stringify(plan, null, 2) + '\n');
  writeOutputs(plan, { issueNumber });
  writeSummary(plan);
  console.log(`Probe plan / 探针计划: ${plan.matrix.include.length} jobs, max-parallel=${plan.maxParallel}, authorized=${plan.authorized}`);
  return plan;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();

#!/usr/bin/env node
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { matchPattern } from './source-policy.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PACKAGE_RE = /^[A-Za-z0-9][A-Za-z0-9+_.@-]{0,95}$/;
const CHANNELS = { main: 'catalog-data', dev: 'catalog-dev', staging: 'catalog-staging' };

export function dataBranchForCodeRef(codeRef) {
  const ref = String(codeRef || '');
  return ref.startsWith('fix/') ? 'catalog-fix' : CHANNELS[ref] || '';
}

export function normalizePackageIds(value, maximum = 8) {
  const packages = [...new Set(String(value || '').split(/[\s,]+/).map((row) => row.trim()).filter(Boolean))];
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
    const packages = [...new Set(candidates.map((row) => String(row || '').trim()).filter(Boolean))];
    if (!packages.length || packages.some((name) => !PACKAGE_RE.test(name))) {
      throw new Error(`Catalog application ${id} has no valid package mapping`);
    }
    resolved.push(...packages);
    mappings.push({ id, packages, catalogApplication: Boolean(application) });
  }
  return { packages: [...new Set(resolved)], mappings };
}

export function probeTargetConfig(core) {
  if (Number(core?.schema) !== 6 || !Array.isArray(core?.targets)) {
    throw new Error('Catalog core schema 6 with targets is required');
  }
  const targets = core.targets.filter((target) => target?.contract?.selectable === true ||
    target?.selectable === true || (target?.profiles || []).some((profile) => profile?.selectable === true));
  const target = targets.find((row) => row.id === 'x86/64') || targets[0];
  if (!target) throw new Error('Catalog core contains no selectable Target');
  const profiles = (target.profiles || []).filter((profile) => profile?.selectable !== false && profile?.selector);
  const profile = profiles.find((row) => row.id === 'DEVICE_generic') ||
    profiles.find((row) => row.id === 'generic') || profiles.find((row) => row.id === 'Default') || profiles[0];
  const selectors = [...new Set([
    profile?.boardSelector || target.contract?.boardSelector,
    profile?.targetSelector || target.targetSelector || target.contract?.targetSelector,
    profile?.selector,
  ].map((value) => String(value || '').trim()).filter(Boolean))];
  if (!selectors.length) throw new Error(`Catalog Target ${target.id || '(unknown)'} has no selector contract`);
  return {
    target: String(target.id || ''),
    profile: String(profile?.id || ''),
    config: selectors.map((selector) => `CONFIG_${selector}=y`).join('\n'),
  };
}

export function createProbePlan({ index, applications, env = {}, policy }) {
  if (Number(index?.schema) !== 2 || !Array.isArray(index?.sources)) {
    throw new Error('Catalog index schema 2 is required');
  }
  const probePolicy = policy?.probe || {};
  const maxPackages = Number(probePolicy.maxPackages || 8);
  const requested = normalizePackageIds(env.PROBE_PACKAGES, maxPackages);
  const resolved = resolveProbePackages(requested, applications);
  const sourcePattern = String(env.SOURCE_PATTERN || '*');
  const branchPattern = String(env.BRANCH_PATTERN || '*');
  const include = index.sources.flatMap((source) => (source.branches || [])
    .filter((branch) => branch.state !== 'unavailable' &&
      matchPattern(String(source.id || ''), sourcePattern) &&
      matchPattern(String(branch.branch || ''), branchPattern))
    .map((branch) => ({
      key: `${source.id}-${branch.branch}`.replace(/[^A-Za-z0-9_.-]/g, '-'),
      source: source.id,
      label: source.label || source.id,
      repo: source.repo,
      branch: branch.branch,
      upstreamCommit: branch.commit || '',
      coreAsset: branch.assets?.core?.asset || '',
      coreHash: branch.assets?.core?.hash || '',
      packages: resolved.packages.join(','),
    })));
  if (!include.length) throw new Error('probe filters matched no available Catalog Source/Branch');
  const maxMatrixJobs = Number(probePolicy.maxMatrixJobs || 256);
  if (include.length > maxMatrixJobs) {
    throw new Error(`probe plan has ${include.length} jobs; the configured limit is ${maxMatrixJobs}`);
  }
  const owner = String(env.REPOSITORY_OWNER || '').toLowerCase();
  const actor = String(env.GITHUB_ACTOR || '').toLowerCase();
  const isOwner = Boolean(owner && actor === owner);
  const collaboratorCap = Number(probePolicy.collaboratorMaxParallel || 3);
  const ownerDefault = Number(probePolicy.ownerDefaultParallel || 0);
  const rawParallel = String(env.MAX_PARALLEL ?? '').trim();
  const parsedParallel = rawParallel === '' ? (isOwner ? ownerDefault : collaboratorCap) : Number(rawParallel);
  if (!Number.isInteger(parsedParallel) || parsedParallel < 0 || parsedParallel > maxMatrixJobs) {
    throw new Error(`max_parallel must be an integer from 0 to ${maxMatrixJobs}`);
  }
  const requestedParallel = parsedParallel === 0 ? include.length : parsedParallel;
  const maxParallel = Math.max(1, Math.min(
    include.length,
    isOwner ? requestedParallel : Math.min(collaboratorCap, requestedParallel),
  ));
  const mode = env.PROBE_MODE === 'co-install' ? 'co-install' : 'compile';
  return {
    schema: 2,
    generatedAt: new Date().toISOString(),
    actor: env.GITHUB_ACTOR || '',
    owner: isOwner,
    codeRef: env.CODE_REF || env.GITHUB_REF_NAME || 'main',
    dataBranch: env.DATA_BRANCH || '',
    mode,
    dryRun: String(env.DRY_RUN || 'false') === 'true',
    requested,
    resolvedPackages: resolved.packages,
    mappings: resolved.mappings,
    sourcePattern,
    branchPattern,
    maxParallel,
    matrix: { include },
  };
}

async function fetchJson(url, token = '') {
  const headers = token ? { Authorization: `Bearer ${token}` } : {};
  const response = await fetch(url, { headers });
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  return response.json();
}

async function fetchGzipJson(url, token = '') {
  const headers = token ? { Authorization: `Bearer ${token}` } : {};
  const response = await fetch(url, { headers });
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  return JSON.parse(gunzipSync(Buffer.from(await response.arrayBuffer())).toString('utf8'));
}

async function fetchVerifiedGzipJson(url, expectedHash, token = '') {
  const headers = token ? { Authorization: `Bearer ${token}` } : {};
  const response = await fetch(url, { headers });
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  const compressed = Buffer.from(await response.arrayBuffer());
  const actualHash = createHash('sha256').update(compressed).digest('hex');
  if (!expectedHash || actualHash !== expectedHash) throw new Error(`${url}: compressed SHA-256 mismatch`);
  return JSON.parse(gunzipSync(compressed).toString('utf8'));
}

async function attachProbeTargets(plan, { repository, dataRef, token }) {
  const include = await Promise.all(plan.matrix.include.map(async (row) => {
    if (!row.coreAsset || !row.coreHash) {
      throw new Error(`${row.source}/${row.branch}: Catalog core asset contract is missing`);
    }
    const core = await fetchVerifiedGzipJson(
      `https://raw.githubusercontent.com/${repository}/${dataRef}/${row.coreAsset}`,
      row.coreHash,
      token,
    );
    const selected = probeTargetConfig(core);
    return { ...row, target: selected.target, profile: selected.profile, targetConfig: selected.config };
  }));
  return { ...plan, matrix: { include } };
}

function writeOutputs(plan) {
  const output = process.env.GITHUB_OUTPUT;
  if (!output) return;
  const rows = {
    matrix: JSON.stringify(plan.matrix),
    max_parallel: String(plan.maxParallel),
    dry_run: String(plan.dryRun),
    plan_count: String(plan.matrix.include.length),
    packages: plan.resolvedPackages.join(','),
    data_branch: plan.dataBranch,
    mode: plan.mode,
  };
  appendFileSync(output, Object.entries(rows).map(([key, value]) => `${key}=${value}`).join('\n') + '\n');
}

function writeSummary(plan) {
  const rows = [
    '## Package compatibility probe plan',
    '',
    `- Actor: \`${plan.actor}\`${plan.owner ? ' (repository owner)' : ' (write collaborator)'}`,
    `- Catalog channel: \`${plan.dataBranch}\``,
    `- Mode: \`${plan.mode}\``,
    `- Requested: ${plan.requested.map((row) => `\`${row}\``).join(', ')}`,
    `- Resolved packages: ${plan.resolvedPackages.map((row) => `\`${row}\``).join(', ')}`,
    `- Source/Branch jobs: ${plan.matrix.include.length}`,
    `- Maximum parallel jobs: ${plan.maxParallel}`,
    `- Dry run: ${plan.dryRun}`,
    '',
    '| Source | Branch | Probe Target/Profile | Upstream commit |',
    '|---|---|---|---|',
    ...plan.matrix.include.map((row) => `| ${row.source} | ${row.branch} | ${row.target}/${row.profile || '-'} | \`${row.upstreamCommit || 'unknown'}\` |`),
    '',
  ];
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, rows.join('\n'));
}

export async function main(env = process.env) {
  const codeRef = env.CODE_REF || env.GITHUB_REF_NAME || 'main';
  const dataBranch = dataBranchForCodeRef(codeRef);
  const repository = env.GITHUB_REPOSITORY || '';
  if (!repository || !dataBranch) throw new Error(`unsupported probe channel: ${codeRef}`);
  const base = `https://raw.githubusercontent.com/${repository}/${dataBranch}`;
  const token = env.GITHUB_TOKEN || '';
  const [index, applications] = await Promise.all([
    fetchJson(`${base}/index.json`, token),
    fetchGzipJson(`${base}/applications.json.gz`, token),
  ]);
  const policy = JSON.parse(readFileSync(join(ROOT, '.github', 'automation-policy.json'), 'utf8'));
  const preliminary = createProbePlan({ index, applications, env: { ...env, CODE_REF: codeRef, DATA_BRANCH: dataBranch }, policy });
  const plan = await attachProbeTargets(preliminary, {
    repository,
    dataRef: String(index.assetRef || dataBranch),
    token,
  });
  mkdirSync(join(ROOT, 'probe-diagnostics'), { recursive: true });
  writeFileSync(join(ROOT, 'probe-diagnostics', 'plan.json'), JSON.stringify(plan, null, 2) + '\n');
  writeOutputs(plan);
  writeSummary(plan);
  console.log(`Probe plan: ${plan.matrix.include.length} Source/Branch jobs, max-parallel=${plan.maxParallel}`);
  return plan;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}

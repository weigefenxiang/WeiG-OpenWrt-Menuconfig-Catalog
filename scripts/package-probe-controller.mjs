#!/usr/bin/env node
import { mkdirSync, writeFileSync } from 'node:fs';
import { matchPattern } from './source-policy.mjs';

const env = process.env;
const repository = env.GITHUB_REPOSITORY || '';
const token = env.GITHUB_TOKEN || '';
const codeRef = env.CODE_REF || env.GITHUB_REF_NAME || 'main';
const branchMap = { main: 'catalog-data', dev: 'catalog-dev', staging: 'catalog-staging' };
const dataBranch = codeRef.startsWith('fix/') ? 'catalog-fix' : branchMap[codeRef];
if (!repository || !token || !dataBranch) throw new Error(`unsupported probe channel: ${codeRef}`);
const packages = [...new Set(String(env.PROBE_PACKAGES || '').split(/[\s,]+/).filter(Boolean))];
if (!packages.length || packages.length > 8 || packages.some((name) =>
  !/^[A-Za-z0-9][A-Za-z0-9+_.@-]{0,95}$/.test(name))) {
  throw new Error('packages must contain 1-8 valid package IDs');
}
const mode = env.PROBE_MODE === 'co-install' ? 'co-install' : 'compile';
const owner = String(env.REPOSITORY_OWNER || '').toLowerCase();
const actor = String(env.GITHUB_ACTOR || '').toLowerCase();
const requested = Math.max(1, Math.min(20, Number(env.MAX_PARALLEL || 3)));
const maxParallel = actor === owner ? requested : Math.min(3, requested);
const sourcePattern = env.SOURCE_PATTERN || '*';
const branchPattern = env.BRANCH_PATTERN || '*';
const dryRun = String(env.DRY_RUN || 'false') === 'true';
const probeId = `probe-${Date.now()}-${env.GITHUB_RUN_ID || 'local'}`;
const headers = {
  Accept: 'application/vnd.github+json', Authorization: `Bearer ${token}`,
  'User-Agent': 'WeiG-OpenWrt-Menuconfig-Catalog', 'X-GitHub-Api-Version': '2022-11-28',
};

async function json(url, options = {}) {
  const response = await fetch(url, { ...options, headers: { ...headers, ...(options.headers || {}) } });
  if (!response.ok) throw new Error(`${options.method || 'GET'} ${url}: HTTP ${response.status}`);
  if (response.status === 204) return null;
  return response.json();
}

const indexUrl = `https://raw.githubusercontent.com/${repository}/${dataBranch}/index.json`;
const indexResponse = await fetch(indexUrl, { headers });
if (!indexResponse.ok) throw new Error(`Catalog index unavailable: HTTP ${indexResponse.status}`);
const index = await indexResponse.json();
if (index.schema !== 2 || !Array.isArray(index.sources)) throw new Error('Catalog index schema 2 is required');
const plan = index.sources.flatMap((source) => (source.branches || []).filter((branch) =>
  branch.state !== 'unavailable' && matchPattern(source.id, sourcePattern) &&
  matchPattern(branch.branch, branchPattern)).map((branch) => ({
    source: source.id, repo: source.repo, branch: branch.branch,
  })));
if (!plan.length) throw new Error('probe filters matched no Catalog Source/Branch');
mkdirSync('probe-diagnostics', { recursive: true });
const result = {
  schema: 1, probeId, generatedAt: new Date().toISOString(), codeRef, dataBranch,
  actor: env.GITHUB_ACTOR || '', owner: actor === owner, maxParallel, packages, mode, dryRun,
  plan, runs: [],
};
writeFileSync('probe-diagnostics/plan.json', JSON.stringify(result, null, 2) + '\n');
if (dryRun) {
  console.log(`Dry-run probe plan: ${plan.length} Source/Branch, max-parallel=${maxParallel}`);
  process.exit(0);
}

async function dispatch(item) {
  const tokenId = `${probeId}-${item.source}-${item.branch}`.replace(/[^A-Za-z0-9_.-]/g, '-');
  await json(`https://api.github.com/repos/${repository}/actions/workflows/package-probe-child.yml/dispatches`, {
    method: 'POST', body: JSON.stringify({
      ref: codeRef,
      inputs: {
        probe_id: tokenId, source: item.source, repo: item.repo, branch: item.branch,
        packages: packages.join(','), mode,
      },
    }),
  });
  return { ...item, tokenId, dispatchedAt: new Date().toISOString(), status: 'queued' };
}

async function locate(run) {
  const body = await json(`https://api.github.com/repos/${repository}/actions/workflows/package-probe-child.yml/runs?event=workflow_dispatch&per_page=100`);
  return (body.workflow_runs || []).find((item) => String(item.display_title || '').includes(run.tokenId));
}

const pending = [...plan];
const active = [];
const complete = [];
while (pending.length || active.length) {
  while (pending.length && active.length < maxParallel) active.push(await dispatch(pending.shift()));
  await new Promise((resolve) => setTimeout(resolve, 20000));
  for (let index = active.length - 1; index >= 0; index--) {
    const tracked = await locate(active[index]);
    if (!tracked || tracked.status !== 'completed') continue;
    complete.push({ ...active[index], runId: tracked.id, url: tracked.html_url, conclusion: tracked.conclusion });
    active.splice(index, 1);
  }
  writeFileSync('probe-diagnostics/result.json', JSON.stringify({ ...result, runs: complete }, null, 2) + '\n');
}
const failed = complete.filter((run) => run.conclusion !== 'success');
console.log(`Probe complete: ${complete.length} runs, failed=${failed.length}`);
if (failed.length) process.exitCode = 1;

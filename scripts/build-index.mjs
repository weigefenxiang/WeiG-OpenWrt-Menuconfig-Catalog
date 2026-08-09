#!/usr/bin/env node
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { normalizeCompatibilityDocument } from './compatibility-rules.mjs';
import { fileContract, stampIndex } from './index-contract.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

function legacyContract(value) {
  const row = value && typeof value === 'object' ? value : {};
  const explicit = row.legacy && typeof row.legacy === 'object' ? row.legacy : null;
  const source = explicit || row;
  const asset = String(source.asset || '');
  const hash = String(source.hash || source.compressedSha256 || '');
  const bytes = Number(source.bytes || source.compressedBytes || 0);
  if (!asset) return null;
  return {
    asset,
    hash,
    bytes,
    catalogSchema: Number(source.catalogSchema || (explicit ? 0 : 5) || 0),
    relationsSchema: Number(source.relationsSchema || (explicit ? 0 : 2) || 0),
  };
}

function normalizeLegacyMirror(branch) {
  const legacy = legacyContract(branch);
  if (!legacy) return branch;
  return {
    ...branch,
    // Keep the root fields until every schema-5 consumer has migrated.
    asset: legacy.asset,
    hash: legacy.hash,
    bytes: legacy.bytes,
    legacy,
  };
}
const dir = resolve(process.argv[2] || join(ROOT, 'dist'));
const out = resolve(process.argv[3] || join(dir, 'index.json'));
const previousFile = process.argv[4] ? resolve(process.argv[4]) : '';
const attemptsDir = process.argv[5] ? resolve(process.argv[5]) : '';
const rows = readdirSync(dir).filter((name) => name.endsWith('.meta.json')).sort()
  .map((name) => JSON.parse(readFileSync(join(dir, name), 'utf8')));
const previous = previousFile && existsSync(previousFile)
  ? JSON.parse(readFileSync(previousFile, 'utf8')) : { sources: [] };
const attempts = attemptsDir && existsSync(attemptsDir)
  ? readdirSync(attemptsDir).filter((name) => name.endsWith('.attempt.json')).sort()
    .map((name) => JSON.parse(readFileSync(join(attemptsDir, name), 'utf8')))
  : [];
const currentKeys = new Set(rows.map((row) => `${row.source.id}\0${row.source.branch}`));
if (!rows.length && !(previous.sources || []).length && !attempts.length) {
  throw new Error('没有当前、历史或失败状态数据');
}
const policy = JSON.parse(readFileSync(join(ROOT, 'catalog.config.json'), 'utf8'));
const compatibility = normalizeCompatibilityDocument(
  JSON.parse(readFileSync(join(ROOT, 'compatibility.json'), 'utf8')),
  policy,
);
const compatibilityAsset = 'compatibility.json.gz';
const compatibilityJson = JSON.stringify(compatibility);
writeFileSync(join(dir, compatibilityAsset), gzipSync(Buffer.from(compatibilityJson), { level: 9 }));
const compatibilityContract = {
  asset: compatibilityAsset,
  ...fileContract(join(dir, compatibilityAsset)),
  schema: compatibility.schema,
  rules: compatibility.rules.length,
  jsonBytes: Buffer.byteLength(compatibilityJson),
};
const sources = (previous.sources || []).filter((source) => policy.sources.some((item) => item.id === source.id))
  .map((source) => {
    const rule = policy.sources.find((item) => item.id === source.id);
    return {
      ...source,
      branches: (source.branches || []).filter((branch) =>
        !rule.exclude.includes(branch.branch) &&
        (rule.branches === 'all' || rule.branches.includes(branch.branch)))
        .map((branch) => normalizeLegacyMirror({ ...branch })),
    };
  });
for (const row of rows) {
  let source = sources.find((item) => item.id === row.source.id);
  if (!source) {
    source = {
      id: row.source.id, label: row.source.label || row.source.id,
      repo: row.source.repo, legacy: row.source.legacy, branches: [],
    };
    sources.push(source);
  }
  source.label = row.source.label || source.label || row.source.id;
  const legacy = legacyContract(row);
  if (!legacy || legacy.catalogSchema < 5 || legacy.relationsSchema < 2) {
    throw new Error(`meta lacks an explicit legacy build contract: ${row.source.id}/${row.source.branch}`);
  }
  const branch = normalizeLegacyMirror({
    id: row.source.branch.startsWith('openwrt-') ? row.source.branch.slice(8) : row.source.branch,
    version: row.source.branch.startsWith('openwrt-') ? row.source.branch.slice(8) : row.source.branch,
    branch: row.source.branch, counts: row.counts,
    commit: row.commit || row.source.commit || '',
    legacy,
    assets: row.assets || {},
    schema: Number(row.schema || 5),
    sizeReport: row.sizeReport || {},
    state: 'fresh',
    lastSuccessAt: row.generatedAt || new Date().toISOString(),
  });
  const oldAt = source.branches.findIndex((item) => item.branch === branch.branch);
  if (oldAt >= 0) source.branches[oldAt] = branch;
  else source.branches.push(branch);
}
for (const attempt of attempts) {
  let source = sources.find((item) => item.id === attempt.source.id);
  if (!source) {
    source = { ...attempt.source, branches: [] };
    sources.push(source);
  }
  let branch = source.branches.find((item) => item.branch === attempt.branch);
  if (!branch) {
    branch = {
      id: attempt.branch.startsWith('openwrt-') ? attempt.branch.slice(8) : attempt.branch,
      branch: attempt.branch,
    };
    source.branches.push(branch);
  }
  branch.lastAttemptAt = attempt.attemptedAt;
  branch.runUrl = attempt.runUrl;
  branch.version = attempt.version || branch.version || branch.id;
  branch.lastAttemptCommit = attempt.upstreamCommit || '';
  branch.compatibilityMode = attempt.compatibilityMode || 'native';
  branch.artifactName = attempt.artifactName || '';
  branch.order = attempt.order || 0;
  branch.orderText = attempt.orderText || '';
  branch.jobName = attempt.jobName || '';
  branch.failureLog = attempt.failureLog || '';
  if (attempt.status === 'success' && currentKeys.has(`${attempt.source.id}\0${attempt.branch}`)) {
    branch.state = 'fresh';
    branch.errorStage = '';
  } else if (attempt.status === 'success') {
    branch.state = branch.asset ? 'stale' : 'unavailable';
    branch.errorStage = 'publish-download';
  } else if (attempt.status === 'failure') {
    branch.state = branch.asset ? 'stale' : 'unavailable';
    branch.errorStage = attempt.stage || 'unknown';
  }
}
for (const source of sources) source.branches.sort((a, b) => a.branch.localeCompare(b.branch));
const branchRows = sources.flatMap((source) => source.branches);
const generatedAt = new Date().toISOString();
const body = {
  schema: 2,
  generatedAt,
  commit: process.env.CATALOG_COMMIT || '',
  completeReleaseTag: 'menuconfig-catalog-complete',
  health: {
    fresh: branchRows.filter((item) => item.state === 'fresh').length,
    stale: branchRows.filter((item) => item.state === 'stale').length,
    unavailable: branchRows.filter((item) => item.state === 'unavailable').length,
  },
  assets: { compatibility: compatibilityContract },
  sources,
};
writeFileSync(
  out,
  JSON.stringify(stampIndex(body), null, 2) + '\n',
);
console.log(`index.json: ${sources.length} sources / ${branchRows.length} branches` +
  ` (fresh=${branchRows.filter((item) => item.state === 'fresh').length}` +
  ` stale=${branchRows.filter((item) => item.state === 'stale').length}` +
  ` unavailable=${branchRows.filter((item) => item.state === 'unavailable').length})` +
  ` / compatibility=${compatibility.rules.length} rules, ${compatibilityContract.bytes} bytes`);

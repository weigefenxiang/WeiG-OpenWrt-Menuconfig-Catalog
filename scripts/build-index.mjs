#!/usr/bin/env node
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const dir = resolve(process.argv[2] || join(ROOT, 'dist'));
const out = resolve(process.argv[3] || join(dir, 'index.json'));
const previousFile = process.argv[4] ? resolve(process.argv[4]) : '';
const rows = readdirSync(dir).filter((name) => name.endsWith('.meta.json')).sort()
  .map((name) => JSON.parse(readFileSync(join(dir, name), 'utf8')));
if (!rows.length) throw new Error('没有 catalog meta 文件');
const previous = previousFile && existsSync(previousFile)
  ? JSON.parse(readFileSync(previousFile, 'utf8')) : { sources: [] };
const policy = JSON.parse(readFileSync(join(ROOT, 'catalog.config.json'), 'utf8'));
const sources = (previous.sources || []).filter((source) => policy.sources.some((item) => item.id === source.id))
  .map((source) => {
    const rule = policy.sources.find((item) => item.id === source.id);
    return {
      ...source,
      branches: (source.branches || []).filter((branch) =>
        !rule.exclude.includes(branch.branch) &&
        (rule.branches === 'all' || rule.branches.includes(branch.branch))).map((branch) => ({ ...branch })),
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
  const branch = {
    id: row.source.branch.startsWith('openwrt-') ? row.source.branch.slice(8) : row.source.branch,
    branch: row.source.branch, commit: row.source.commit, asset: row.asset, counts: row.counts,
  };
  const oldAt = source.branches.findIndex((item) => item.branch === branch.branch);
  if (oldAt >= 0) source.branches[oldAt] = branch;
  else source.branches.push(branch);
}
for (const source of sources) source.branches.sort((a, b) => a.branch.localeCompare(b.branch));
writeFileSync(out, JSON.stringify({
  schema: 1,
  generatedAt: new Date().toISOString(),
  releaseTag: 'menuconfig-catalog',
  sources,
}, null, 2) + '\n');
console.log(`index.json: ${sources.length} sources / ${rows.length} branches`);

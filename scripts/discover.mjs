#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const config = JSON.parse(readFileSync(join(ROOT, 'catalog.config.json'), 'utf8'));
const token = process.env.GITHUB_TOKEN || '';
const headers = { 'User-Agent': 'WeiG-OpenWrt-Menuconfig-Catalog' };
if (token) headers.Authorization = `Bearer ${token}`;

async function remoteBranches(repo) {
  const rows = [];
  for (let page = 1; ; page++) {
    const response = await fetch(`https://api.github.com/repos/${repo}/branches?per_page=100&page=${page}`, { headers });
    if (!response.ok) throw new Error(`${repo} branches: HTTP ${response.status}`);
    const part = await response.json();
    rows.push(...part.map((item) => item.name));
    if (part.length < 100) break;
  }
  return rows;
}

const include = [];
for (const source of config.sources) {
  const branches = source.branches === 'all' ? await remoteBranches(source.repo) : source.branches;
  for (const branch of [...new Set(branches)].filter((item) => !source.exclude.includes(item)).sort()) {
    if (!/^[A-Za-z0-9._/-]{1,96}$/.test(branch)) throw new Error(`非法分支名:${source.repo}/${branch}`);
    include.push({
      source: source.id,
      label: source.label,
      repo: source.repo,
      branch,
      diy: source.diy,
      legacy: Boolean(source.legacy),
    });
  }
}
if (!include.length) throw new Error('未发现任何源码分支');
const matrix = JSON.stringify({ include });
if (process.env.GITHUB_OUTPUT) console.log(`matrix=${matrix}`);
else console.log(JSON.stringify({ schema: 1, generatedAt: new Date().toISOString(), include }, null, 2));

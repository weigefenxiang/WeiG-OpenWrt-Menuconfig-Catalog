#!/usr/bin/env node
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { indexContract, stampIndex } from './index-contract.mjs';
import { stampCatalogSnapshot } from './stamp-catalog-snapshot.mjs';

const ref = '0123456789abcdef0123456789abcdef01234567';
const input = stampIndex({
  schema: 2,
  generatedAt: '2026-08-06T00:00:00Z',
  sources: [{
    id: 'demo',
    branches: [{
      id: 'main',
      branch: 'main',
      asset: 'demo--main.json.gz',
      hash: 'a'.repeat(64),
      bytes: 123,
    }],
  }],
});

const stamped = stampCatalogSnapshot(input, ref.toUpperCase());
if (stamped.assetRef !== ref || stamped.assetRefType !== 'git-commit') {
  throw new Error('snapshot stamp did not normalize the Git commit contract');
}
if (stamped.sources[0].branches[0].asset !== 'demo--main.json.gz') {
  throw new Error('snapshot stamp changed the logical branch asset name');
}
const contract = indexContract(stamped);
if (stamped.hash !== contract.hash || stamped.bytes !== contract.bytes) {
  throw new Error('snapshot stamp did not refresh the index root contract');
}
let rejected = false;
try {
  stampCatalogSnapshot(input, 'catalog-data');
} catch {
  rejected = true;
}
if (!rejected) throw new Error('snapshot stamp accepted a mutable branch name');

const temp = mkdtempSync(join(tmpdir(), 'catalog-snapshot-'));
try {
  const file = join(temp, 'index.json');
  writeFileSync(file, JSON.stringify(input, null, 2) + '\n');
  const result = spawnSync(process.execPath, [
    fileURLToPath(new URL('./stamp-catalog-snapshot.mjs', import.meta.url)),
    file,
    ref,
  ], { encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(`snapshot CLI failed: ${result.stderr || result.stdout}`);
  }
  const cli = JSON.parse(readFileSync(file, 'utf8'));
  if (cli.assetRef !== ref || cli.hash !== indexContract(cli).hash) {
    throw new Error('snapshot CLI wrote an invalid index contract');
  }
} finally {
  rmSync(temp, { recursive: true, force: true });
}

console.log('catalog snapshot checks passed');

#!/usr/bin/env node
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { indexContract, stampIndex } from './index-contract.mjs';
import { stampCatalogSnapshot, verifyReusableCatalogSnapshot } from './stamp-catalog-snapshot.mjs';

const ref = '0123456789abcdef0123456789abcdef01234567';
const codeSha = '89abcdef0123456789abcdef0123456789abcdef';
const previousCodeSha = '76543210fedcba9876543210fedcba9876543210';
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

const stamped = stampCatalogSnapshot(input, ref.toUpperCase(), {
  codeRef: 'main', codeSha: codeSha.toUpperCase(), complete: true,
});
if (stamped.assetRef !== ref || stamped.assetRefType !== 'git-commit') {
  throw new Error('snapshot stamp did not normalize the Git commit contract');
}
if (stamped.provenance?.codeRef !== 'main' || stamped.provenance?.codeSha !== codeSha ||
    stamped.provenance?.complete !== true) {
  throw new Error('snapshot stamp did not preserve code provenance');
}
if (stamped.sources[0].branches[0].asset !== 'demo--main.json.gz') {
  throw new Error('snapshot stamp changed the logical branch asset name');
}
const contract = indexContract(stamped);
if (stamped.hash !== contract.hash || stamped.bytes !== contract.bytes) {
  throw new Error('snapshot stamp did not refresh the index root contract');
}
const restamped = stampCatalogSnapshot(stamped, ref, { codeRef: 'main', codeSha, complete: true });
if (JSON.stringify(restamped) !== JSON.stringify(stamped)) throw new Error('identical snapshot stamp was not deterministic');
const fStamped = stampCatalogSnapshot(input, ref, { codeRef: 'fix-F', codeSha, complete: true });
if (fStamped.provenance?.codeRef !== 'fix-F' || fStamped.provenance?.complete !== true) {
  throw new Error('generic fix snapshot provenance was not accepted');
}
for (const invalid of [
  () => stampCatalogSnapshot(input, 'catalog-data'),
  () => stampCatalogSnapshot(input, ref, { codeRef: 'main', codeSha: 'bad', complete: true }),
  () => stampCatalogSnapshot(input, ref, { codeRef: 'feature/x', codeSha, complete: true }),
]) {
  let rejected = false;
  try { invalid(); } catch { rejected = true; }
  if (!rejected) throw new Error('snapshot stamp accepted an invalid immutable identity');
}

const reusable = stampCatalogSnapshot(input, ref, {
  codeRef: 'dev', codeSha: previousCodeSha, complete: true,
});
const reuse = verifyReusableCatalogSnapshot(reusable, {
  repository: 'weigefenxiang/WeiG-OpenWrt-Menuconfig-Catalog',
  codeRef: 'dev',
  previousCodeSha,
});
if (reuse.assetRef !== ref || reuse.complete !== true) {
  throw new Error('reusable snapshot verification changed immutable identity');
}
const reusableF = stampCatalogSnapshot(input, ref, {
  codeRef: 'fix-F', codeSha: previousCodeSha, complete: true,
});
const reuseF = verifyReusableCatalogSnapshot(reusableF, {
  repository: 'weigefenxiang/WeiG-OpenWrt-Menuconfig-Catalog',
  codeRef: 'fix-F',
  previousCodeSha,
});
if (reuseF.assetRef !== ref || reuseF.complete !== true) {
  throw new Error('generic fix reusable snapshot verification changed immutable identity');
}
for (const invalidReuse of [
  () => verifyReusableCatalogSnapshot(reusable, { repository: 'other/repo', codeRef: 'dev', previousCodeSha }),
  () => verifyReusableCatalogSnapshot(reusable, { repository: 'weigefenxiang/WeiG-OpenWrt-Menuconfig-Catalog', codeRef: 'staging', previousCodeSha }),
  () => verifyReusableCatalogSnapshot(reusable, { repository: 'weigefenxiang/WeiG-OpenWrt-Menuconfig-Catalog', codeRef: 'dev', previousCodeSha: codeSha }),
]) {
  let rejected = false;
  try { invalidReuse(); } catch { rejected = true; }
  if (!rejected) throw new Error('reusable snapshot verification accepted mismatched provenance');
}

const temp = mkdtempSync(join(tmpdir(), 'catalog-snapshot-'));
try {
  const file = join(temp, 'index.json');
  writeFileSync(file, JSON.stringify(input, null, 2) + '\n');
  const result = spawnSync(process.execPath, [
    fileURLToPath(new URL('./stamp-catalog-snapshot.mjs', import.meta.url)),
    file,
    ref,
    'fix-F',
    codeSha,
    'true',
  ], { encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(`snapshot CLI failed: ${result.stderr || result.stdout}`);
  }
  const cli = JSON.parse(readFileSync(file, 'utf8'));
  if (cli.assetRef !== ref || cli.hash !== indexContract(cli).hash || cli.provenance?.codeRef !== 'fix-F' ||
      cli.provenance?.codeSha !== codeSha) {
    throw new Error('snapshot CLI wrote an invalid generic fix index contract');
  }

  writeFileSync(file, JSON.stringify(reusableF, null, 2) + '\n');
  const reuseResult = spawnSync(process.execPath, [
    fileURLToPath(new URL('./stamp-catalog-snapshot.mjs', import.meta.url)),
    file,
    ref,
    'fix-F',
    codeSha,
    '',
    previousCodeSha,
  ], {
    encoding: 'utf8',
    env: { ...process.env, GITHUB_REPOSITORY: 'weigefenxiang/WeiG-OpenWrt-Menuconfig-Catalog' },
  });
  if (reuseResult.status !== 0) {
    throw new Error(`snapshot reuse CLI failed: ${reuseResult.stderr || reuseResult.stdout}`);
  }
  const promoted = JSON.parse(readFileSync(file, 'utf8'));
  if (promoted.assetRef !== ref || promoted.provenance?.codeRef !== 'fix-F' ||
      promoted.provenance?.codeSha !== codeSha || promoted.provenance?.complete !== true) {
    throw new Error('snapshot reuse CLI did not preserve generic fix assets while advancing provenance');
  }
} finally {
  rmSync(temp, { recursive: true, force: true });
}

console.log('catalog snapshot checks passed');

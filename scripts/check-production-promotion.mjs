#!/usr/bin/env node
import { gzipSync } from 'node:zlib';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileContract, stampIndex } from './index-contract.mjs';
import { stampCatalogSnapshot } from './stamp-catalog-snapshot.mjs';
import { verifyProductionCandidate } from './verify-production-candidate.mjs';

const temp = mkdtempSync(join(tmpdir(), 'catalog-production-'));
try {
  const asset = 'applications.json.gz';
  writeFileSync(join(temp, asset), gzipSync(Buffer.from(JSON.stringify({ schema: 1, items: [] }))));
  const contract = fileContract(join(temp, asset));
  const codeSha = '1'.repeat(40);
  const assetRef = '2'.repeat(40);
  const base = stampIndex({
    schema: 2,
    generatedAt: '2026-08-11T00:00:00Z',
    sources: [],
    assets: { applications: { asset, hash: contract.hash, bytes: contract.bytes, schema: 1 } },
  });
  const valid = stampCatalogSnapshot(base, assetRef, {
    codeRef: 'main', codeSha, complete: true,
  });
  valid.provenance.repository = 'example/catalog';
  const restamped = stampIndex(valid);
  writeFileSync(join(temp, 'index.json'), JSON.stringify(restamped, null, 2) + '\n');
  const verified = verifyProductionCandidate(temp, { repository: 'example/catalog', codeSha });
  if (verified.assetRef !== assetRef || verified.codeSha !== codeSha) throw new Error('valid candidate identity changed');

  const reject = (mutate) => {
    const changed = structuredClone(restamped);
    mutate(changed);
    const file = join(temp, 'index.json');
    writeFileSync(file, JSON.stringify(changed, null, 2) + '\n');
    let failed = false;
    try { verifyProductionCandidate(temp, { repository: 'example/catalog', codeSha }); } catch { failed = true; }
    if (!failed) throw new Error('invalid production candidate was accepted');
    writeFileSync(file, JSON.stringify(restamped, null, 2) + '\n');
  };
  reject((index) => { index.provenance.complete = false; });
  reject((index) => { index.provenance.codeSha = '3'.repeat(40); });
  reject((index) => { index.provenance.repository = 'other/repo'; });
  reject((index) => { index.hash = '0'.repeat(64); });
  writeFileSync(join(temp, asset), Buffer.from('tampered'));
  let tamperedRejected = false;
  try { verifyProductionCandidate(temp, { repository: 'example/catalog', codeSha }); } catch { tamperedRejected = true; }
  if (!tamperedRejected) throw new Error('tampered candidate asset was accepted');
  console.log('production candidate checks passed');
} finally {
  rmSync(temp, { recursive: true, force: true });
}

#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { synchronizeIndexAssets } from './index-contract.mjs';
import { GIT_COMMIT_RE } from './stamp-catalog-snapshot.mjs';

export function verifyProductionCandidate(directory, { repository = '', codeSha = '' } = {}) {
  const root = resolve(directory);
  const index = JSON.parse(readFileSync(resolve(root, 'index.json'), 'utf8'));
  const expectedRepository = String(repository || '').trim();
  const expectedCodeSha = String(codeSha || '').trim().toLowerCase();
  if (Number(index.schema) !== 2) throw new Error('production candidate requires Catalog index schema 2');
  if (index.assetRefType !== 'git-commit' || !GIT_COMMIT_RE.test(String(index.assetRef || ''))) {
    throw new Error('production candidate requires an immutable Git assetRef');
  }
  const provenance = index.provenance || {};
  if (provenance.codeRef !== 'main') throw new Error('production candidate must be generated from main code');
  if (!GIT_COMMIT_RE.test(String(provenance.codeSha || ''))) {
    throw new Error('production candidate provenance requires a full code SHA');
  }
  if (expectedCodeSha && String(provenance.codeSha).toLowerCase() !== expectedCodeSha) {
    throw new Error(`production candidate code SHA mismatch: ${provenance.codeSha} != ${expectedCodeSha}`);
  }
  if (expectedRepository && String(provenance.repository || '') !== expectedRepository) {
    throw new Error(`production candidate repository mismatch: ${provenance.repository || '(missing)'} != ${expectedRepository}`);
  }
  if (provenance.complete !== true) throw new Error('production candidate is incomplete');
  const contract = synchronizeIndexAssets(index, root, { check: true });
  if (contract.mismatches.length || contract.indexMismatch) {
    throw new Error('production candidate index or asset contract is inconsistent');
  }
  return {
    assetRef: String(index.assetRef),
    codeSha: String(provenance.codeSha).toLowerCase(),
    repository: String(provenance.repository || ''),
  };
}

const invokedDirectly = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  const [directory = 'candidate', repository = process.env.GITHUB_REPOSITORY || '', codeSha = process.env.GITHUB_SHA || ''] = process.argv.slice(2);
  const result = verifyProductionCandidate(directory, { repository, codeSha });
  process.stdout.write(`asset_ref=${result.assetRef}\ncode_sha=${result.codeSha}\n`);
}

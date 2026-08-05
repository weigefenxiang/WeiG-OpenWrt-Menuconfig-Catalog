#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { indexBody, stampIndex } from './index-contract.mjs';

export const GIT_COMMIT_RE = /^[0-9a-f]{40}$/;

export function stampCatalogSnapshot(index, assetRef) {
  const normalizedRef = String(assetRef || '').trim().toLowerCase();
  if (!GIT_COMMIT_RE.test(normalizedRef)) {
    throw new Error('catalog assetRef must be a full 40-character Git commit SHA');
  }

  return stampIndex({
    ...indexBody(index),
    assetRef: normalizedRef,
    assetRefType: 'git-commit',
  });
}

const invokedDirectly = process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  const [indexArg = 'dist/index.json', assetRef = ''] = process.argv.slice(2);
  const indexFile = resolve(indexArg);
  const index = JSON.parse(readFileSync(indexFile, 'utf8'));
  const stamped = stampCatalogSnapshot(index, assetRef);
  writeFileSync(indexFile, JSON.stringify(stamped, null, 2) + '\n');
  console.log(`catalog snapshot pinned: ${stamped.assetRef}`);
}

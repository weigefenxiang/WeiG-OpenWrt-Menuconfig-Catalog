#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { indexBody, stampIndex } from './index-contract.mjs';

export const GIT_COMMIT_RE = /^[0-9a-f]{40}$/;
const CODE_REF_RE = /^(?:main|dev|staging|fix\/[A-Za-z0-9._/-]+)$/;

function normalizeComplete(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  if (value === true || value === 'true') return true;
  if (value === false || value === 'false') return false;
  throw new Error('catalog provenance complete must be true or false');
}

export function catalogProvenance(existing = {}, { codeRef = '', codeSha = '', complete } = {}) {
  const current = existing && typeof existing === 'object' && !Array.isArray(existing) ? existing : {};
  const normalizedRef = String(codeRef || current.codeRef || '').trim();
  const normalizedSha = String(codeSha || current.codeSha || '').trim().toLowerCase();
  if (!normalizedRef && !normalizedSha && complete === undefined) return current;
  if (!CODE_REF_RE.test(normalizedRef)) throw new Error(`invalid catalog provenance codeRef: ${normalizedRef}`);
  if (!GIT_COMMIT_RE.test(normalizedSha)) throw new Error('catalog provenance codeSha must be a full 40-character Git commit SHA');
  return {
    repository: String(process.env.GITHUB_REPOSITORY || current.repository || '').trim(),
    codeRef: normalizedRef,
    codeSha: normalizedSha,
    complete: normalizeComplete(complete, current.complete === true),
  };
}

export function stampCatalogSnapshot(index, assetRef, provenance = {}) {
  const normalizedRef = String(assetRef || '').trim().toLowerCase();
  if (!GIT_COMMIT_RE.test(normalizedRef)) {
    throw new Error('catalog assetRef must be a full 40-character Git commit SHA');
  }
  const body = {
    ...indexBody(index),
    assetRef: normalizedRef,
    assetRefType: 'git-commit',
  };
  const normalizedProvenance = catalogProvenance(body.provenance, provenance);
  if (Object.keys(normalizedProvenance).length) body.provenance = normalizedProvenance;
  return stampIndex(body);
}

const invokedDirectly = process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  const [indexArg = 'dist/index.json', assetRef = '', codeRef = '', codeSha = '', complete = ''] = process.argv.slice(2);
  const indexFile = resolve(indexArg);
  const index = JSON.parse(readFileSync(indexFile, 'utf8'));
  const stamped = stampCatalogSnapshot(index, assetRef, {
    ...(codeRef ? { codeRef } : {}),
    ...(codeSha ? { codeSha } : {}),
    ...(complete !== '' ? { complete } : {}),
  });
  writeFileSync(indexFile, JSON.stringify(stamped, null, 2) + '\n');
  console.log(`catalog snapshot pinned: ${stamped.assetRef}`);
}

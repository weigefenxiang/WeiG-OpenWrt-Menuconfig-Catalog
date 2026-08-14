#!/usr/bin/env node
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

export const PRODUCTION_CANDIDATE_BRANCH = 'catalog-candidate';
export const PRODUCTION_DATA_BRANCH = 'catalog-data';

const BUILD_DATA_BRANCHES = Object.freeze({
  dev: 'catalog-dev',
  staging: 'catalog-staging',
  main: PRODUCTION_CANDIDATE_BRANCH,
});

const RUNTIME_DATA_BRANCHES = Object.freeze({
  dev: 'catalog-dev',
  staging: 'catalog-staging',
  main: PRODUCTION_DATA_BRANCH,
});

export function fixDataBranchForCodeRef(codeRef) {
  const ref = String(codeRef || '').trim();
  if (!ref.startsWith('fix/')) return '';
  const lane = /-([ABC])$/i.exec(ref)?.[1]?.toUpperCase() || '';
  return lane ? `catalog-fix-${lane}` : 'catalog-fix';
}

export function buildDataBranchForCodeRef(codeRef) {
  const ref = String(codeRef || '').trim();
  if (ref.startsWith('fix/')) return fixDataBranchForCodeRef(ref);
  return BUILD_DATA_BRANCHES[ref] || '';
}

export function runtimeDataBranchForChannel(channel) {
  const ref = String(channel || '').trim();
  if (ref.startsWith('fix/')) return fixDataBranchForCodeRef(ref);
  return RUNTIME_DATA_BRANCHES[ref] || '';
}

export function translationChannel(channel) {
  const value = String(channel || '').trim();
  if (value === 'candidate') return { codeRef: 'main', dataBranch: PRODUCTION_CANDIDATE_BRANCH };
  if (value === 'dev') return { codeRef: 'dev', dataBranch: 'catalog-dev' };
  if (value === 'staging') return { codeRef: 'staging', dataBranch: 'catalog-staging' };
  if (value.startsWith('fix/')) return { codeRef: value, dataBranch: fixDataBranchForCodeRef(value) };
  return null;
}

function printResult(mode, value) {
  if (mode === 'build') {
    const branch = buildDataBranchForCodeRef(value);
    if (!branch) throw new Error(`unsupported Catalog code ref: ${value}`);
    process.stdout.write(`${branch}\n`);
    return;
  }
  if (mode === 'runtime') {
    const branch = runtimeDataBranchForChannel(value);
    if (!branch) throw new Error(`unsupported Catalog runtime channel: ${value}`);
    process.stdout.write(`${branch}\n`);
    return;
  }
  if (mode === 'translation') {
    const resolved = translationChannel(value);
    if (!resolved) throw new Error(`unsupported Catalog translation channel: ${value}`);
    process.stdout.write(`code_ref=${resolved.codeRef}\ndata_branch=${resolved.dataBranch}\n`);
    return;
  }
  throw new Error(`unsupported Catalog channel mode: ${mode}`);
}

const invokedDirectly = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) printResult(process.argv[2] || '', process.argv[3] || '');

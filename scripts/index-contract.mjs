import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export const sha256 = (value) =>
  createHash('sha256').update(value).digest('hex');

export function fileContract(file) {
  const data = readFileSync(file);

  return {
    hash: sha256(data),
    bytes: data.byteLength,
  };
}

export function indexBody(index) {
  const {
    hash: _hash,
    bytes: _bytes,
    ...body
  } = index;

  return body;
}

export function indexContract(index) {
  const bodyText = JSON.stringify(indexBody(index));

  return {
    hash: sha256(Buffer.from(bodyText)),
    bytes: Buffer.byteLength(bodyText),
  };
}

export function stampIndex(index) {
  return {
    ...indexBody(index),
    ...indexContract(index),
  };
}

export function synchronizeIndexAssets(
  index,
  directory,
  {
    check = false,
    now = () => new Date().toISOString(),
  } = {},
) {
  if (!index || typeof index !== 'object' || !Array.isArray(index.sources)) {
    throw new Error('index.json must contain a sources array');
  }

  const mismatches = [];
  const missing = [];
  const seenAssets = new Set();

  for (const source of index.sources) {
    for (const branch of source.branches || []) {
      const contracts = [];
      if (branch.asset) contracts.push(['legacy', branch]);
      for (const [logical, contract] of Object.entries(branch.assets || {})) {
        if (contract?.asset) contracts.push([logical, contract]);
      }
      for (const [logical, contract] of contracts) {
        if (seenAssets.has(contract.asset)) throw new Error(`duplicate indexed asset: ${contract.asset}`);
        seenAssets.add(contract.asset);
        const file = join(directory, contract.asset);
        if (!existsSync(file)) {
          missing.push({ source: source.id, branch: branch.branch, logical, asset: contract.asset });
          continue;
        }
        const actual = fileContract(file);
        const expected = { hash: String(contract.hash || ''), bytes: Number(contract.bytes || 0) };
        if (expected.hash !== actual.hash || expected.bytes !== actual.bytes) {
          mismatches.push({ source: source.id, branch: branch.branch, logical, asset: contract.asset, expected, actual });
          if (!check) {
            contract.hash = actual.hash;
            contract.bytes = actual.bytes;
          }
        }
      }
    }
  }

  if (missing.length) {
    const details = missing.map((item) =>
      `${item.source}/${item.branch}[${item.logical}]: ${item.asset}`).join('\n');
    throw new Error(`indexed catalog asset missing:\n${details}`);
  }

  if (!check && mismatches.length) index.generatedAt = now();
  const expectedIndexContract = indexContract(index);
  const currentIndexContract = { hash: String(index.hash || ''), bytes: Number(index.bytes || 0) };
  const indexMismatch = currentIndexContract.hash !== expectedIndexContract.hash ||
    currentIndexContract.bytes !== expectedIndexContract.bytes;
  if (!check) {
    index.hash = expectedIndexContract.hash;
    index.bytes = expectedIndexContract.bytes;
  }
  return {
    checkedAssets: seenAssets.size,
    mismatches,
    indexMismatch,
    indexContract: expectedIndexContract,
    changed: mismatches.length > 0 || indexMismatch,
  };
}

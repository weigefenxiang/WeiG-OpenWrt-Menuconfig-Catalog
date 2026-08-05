#!/usr/bin/env node
import {
  readFileSync,
  writeFileSync,
} from 'node:fs';
import {
  join,
  resolve,
} from 'node:path';
import {
  synchronizeIndexAssets,
} from './index-contract.mjs';

const args = process.argv.slice(2);
const allowedOptions = new Set(['--check']);

const unknownOptions = args.filter(
  (arg) =>
    arg.startsWith('--') &&
    !allowedOptions.has(arg),
);

if (unknownOptions.length) {
  throw new Error(
    `unknown option(s): ${unknownOptions.join(', ')}`,
  );
}

const check = args.includes('--check');

const positionals = args.filter(
  (arg) => !arg.startsWith('--'),
);

if (positionals.length > 1) {
  throw new Error(
    'usage: node scripts/sync-index-assets.mjs ' +
    '[catalog-data-dir] [--check]',
  );
}

const directory = resolve(
  positionals[0] || 'dist',
);

const indexFile = join(
  directory,
  'index.json',
);

const index = JSON.parse(
  readFileSync(indexFile, 'utf8'),
);

const result = synchronizeIndexAssets(
  index,
  directory,
  { check },
);

if (check) {
  for (const item of result.mismatches) {
    console.error(
      `${item.source}/${item.branch}: ${item.asset}`,
    );

    console.error(
      `  hash:  ` +
      `${item.expected.hash || '(missing)'}` +
      ` -> ${item.actual.hash}`,
    );

    console.error(
      `  bytes: ${item.expected.bytes}` +
      ` -> ${item.actual.bytes}`,
    );
  }

  if (result.indexMismatch) {
    console.error(
      'index.json root hash/bytes ' +
      'do not match its body',
    );
  }

  if (result.changed) {
    console.error(
      'catalog-data contract check failed: ' +
      `${result.mismatches.length} ` +
      'asset mismatch(es)',
    );

    process.exitCode = 1;
  } else {
    console.log(
      'catalog-data contract check passed: ' +
      `${result.checkedAssets} indexed asset(s)`,
    );
  }
} else {
  if (result.changed) {
    writeFileSync(
      indexFile,
      JSON.stringify(index, null, 2) + '\n',
    );
  }

  console.log(
    'catalog-data index synchronized: ' +
    `${result.checkedAssets} asset(s), ` +
    `${result.mismatches.length} ` +
    'asset metadata update(s), ' +
    `root=${
      result.indexMismatch
        ? 'updated'
        : 'unchanged'
    }`,
  );
}
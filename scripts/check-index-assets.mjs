#!/usr/bin/env node
import {
  execFileSync,
  spawnSync,
} from 'node:child_process';
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import {
  dirname,
  join,
} from 'node:path';
import {
  fileURLToPath,
} from 'node:url';
import {
  fileContract,
  indexContract,
  stampIndex,
} from './index-contract.mjs';

const ROOT = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
);

const script = join(
  ROOT,
  'scripts',
  'sync-index-assets.mjs',
);

const temp = mkdtempSync(
  join(
    tmpdir(),
    'weig-catalog-assets-',
  ),
);

const dist = join(temp, 'dist');
mkdirSync(dist);

try {
  const asset = 'demo--main.json.gz';
  const assetFile = join(dist, asset);
  const coreAsset = 'demo--main.core.json.gz';
  const graphAsset = 'demo--main.graph.json.gz';
  const coreFile = join(dist, coreAsset);
  const graphFile = join(dist, graphAsset);

  writeFileSync(assetFile, Buffer.from('catalog-v1'));
  writeFileSync(coreFile, Buffer.from('core-v1'));
  writeFileSync(graphFile, Buffer.from('graph-v1'));

  const staleIndex = stampIndex({
    schema: 2,
    generatedAt:
      '2026-01-01T00:00:00.000Z',
    commit: 'demo',
    completeReleaseTag:
      'menuconfig-catalog-complete',
    health: {
      fresh: 1,
      stale: 0,
      unavailable: 0,
    },
    sources: [
      {
        id: 'Demo',
        label: 'Demo',
        repo: 'example/demo',
        branches: [
          {
            id: 'main',
            version: 'main',
            branch: 'main',
            asset,
            hash: 'stale-hash',
            bytes: 1,
            assets: {
              core: { asset: coreAsset, hash: 'stale-core', bytes: 1 },
              graph: { asset: graphAsset, hash: 'stale-graph', bytes: 1 },
            },
            state: 'fresh',
          },
        ],
      },
    ],
  });

  const indexFile = join(
    dist,
    'index.json',
  );

  writeFileSync(
    indexFile,
    JSON.stringify(
      staleIndex,
      null,
      2,
    ) + '\n',
  );

  execFileSync(
    process.execPath,
    [script, dist],
    { stdio: 'pipe' },
  );

  const fixed = JSON.parse(
    readFileSync(indexFile, 'utf8'),
  );

  const branch =
    fixed.sources[0].branches[0];

  const actual =
    fileContract(assetFile);

  const actualCore = fileContract(coreFile);
  const actualGraph = fileContract(graphFile);
  if (branch.hash !== actual.hash || branch.bytes !== actual.bytes ||
      branch.assets.core.hash !== actualCore.hash || branch.assets.core.bytes !== actualCore.bytes ||
      branch.assets.graph.hash !== actualGraph.hash || branch.assets.graph.bytes !== actualGraph.bytes) {
    throw new Error('legacy/split asset metadata synchronization failed');
  }

  const root = indexContract(fixed);

  if (
    fixed.hash !== root.hash ||
    fixed.bytes !== root.bytes
  ) {
    throw new Error(
      'index root contract ' +
      'synchronization failed',
    );
  }

  const once =
    readFileSync(indexFile);

  execFileSync(
    process.execPath,
    [script, dist],
    { stdio: 'pipe' },
  );

  const twice =
    readFileSync(indexFile);

  if (!once.equals(twice)) {
    throw new Error(
      'asset synchronization ' +
      'is not idempotent',
    );
  }

  execFileSync(
    process.execPath,
    [script, dist, '--check'],
    { stdio: 'pipe' },
  );

  writeFileSync(graphFile, Buffer.from('graph-v2'));

  const failed = spawnSync(
    process.execPath,
    [script, dist, '--check'],
    { encoding: 'utf8' },
  );

  if (
    failed.status === 0 ||
    !failed.stderr.includes(
      'asset mismatch',
    )
  ) {
    throw new Error(
      'check mode did not reject ' +
      'a modified asset',
    );
  }

  console.log(
    'catalog asset index checks passed: ' +
    'legacy/split update, root contract, ' +
    'idempotence, shard tamper rejection',
  );
} finally {
  rmSync(
    temp,
    {
      recursive: true,
      force: true,
    },
  );
}

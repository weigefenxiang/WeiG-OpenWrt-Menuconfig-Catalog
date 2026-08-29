#!/usr/bin/env node
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const output = mkdtempSync(join(tmpdir(), 'weig-branch-assets-'));
const fixture = join(ROOT, 'tests', 'fixture');
const tree = join(output, 'tree');

try {
  mkdirSync(join(tree, 'tmp'), { recursive: true });
  copyFileSync(join(fixture, 'Config.in'), join(tree, 'Config.in'));
  copyFileSync(join(fixture, 'targetinfo'), join(tree, 'tmp', '.targetinfo'));
  copyFileSync(join(fixture, 'packageinfo'), join(tree, 'tmp', '.packageinfo'));
  execFileSync(process.execPath, [
    join(ROOT, 'scripts', 'generate-catalog.mjs'),
    '--source-id', 'Fixture',
    '--label', 'Fixture',
    '--repo', 'example/fixture',
    '--branch', 'test',
    '--legacy', 'false',
    '--tree', tree,
    '--size-sample', join(fixture, 'package-size-sample.json'),
    '--out', output,
  ], { stdio: ['ignore', 'pipe', 'pipe'] });

  const readGzipJson = (name) => JSON.parse(gunzipSync(readFileSync(join(output, name))).toString('utf8'));
  const core = readGzipJson('fixture--test.core.json.gz');
  const sizes = readGzipJson('fixture--test.package-sizes.json.gz');
  const meta = JSON.parse(readFileSync(join(output, 'fixture--test.meta.json'), 'utf8'));

  assert.deepEqual(core.applications.fields, ['symbol', 'package', 'group', 'hot']);
  assert(core.applications.rows.some((row) => row[0] === 'PACKAGE_luci-app-demo' && row[1] === 'luci-app-demo'));
  assert.equal(core.applications.rows.some((row) => row[1] === 'luci-app-packageinfo-only'), false,
    'packageinfo-only metadata must not become a selectable branch application');
  assert.deepEqual(sizes.fields, ['package', 'archiveBytes', 'installedBytes']);
  assert.deepEqual(sizes.rows.find((row) => row[0] === 'luci-app-demo'), ['luci-app-demo', 100, 240]);
  assert.equal(sizes.observation.match, 'exact-source-branch');
  assert.equal(sizes.coverage.total >= sizes.coverage.known, true);
  assert.equal(meta.assets.packageSizes.asset, 'fixture--test.package-sizes.json.gz');
  assert.equal(meta.assets.packageSizes.items, sizes.rows.length);
  assert.equal(meta.assets.packageSizes.totalPackages, sizes.coverage.total);
  console.log(`Branch application/size assets passed: applications=${core.applications.rows.length} sizes=${sizes.rows.length}/${sizes.coverage.total}`);
} finally {
  rmSync(output, { recursive: true, force: true });
}

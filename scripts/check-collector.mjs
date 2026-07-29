#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const script = join(ROOT, 'scripts', 'collect-results.mjs');
const temp = mkdtempSync(join(tmpdir(), 'weig-catalog-collector-'));

function fixture(name, { translation = true, collision = false } = {}) {
  const root = join(temp, name);
  const branch = join(root, 'current', '02-catalog-example', 'dist');
  const attempts = join(root, 'current', '02-catalog-example', 'attempts');
  const previous = join(root, 'previous');
  mkdirSync(branch, { recursive: true });
  mkdirSync(attempts, { recursive: true });
  mkdirSync(previous, { recursive: true });
  const json = JSON.stringify({ source: 'OpenWrt', branch: 'main' });
  const asset = 'openwrt--main.json.gz';
  writeFileSync(join(branch, asset), gzipSync(Buffer.from(json)));
  writeFileSync(join(branch, 'openwrt--main.meta.json'), JSON.stringify({
    source: { id: 'OpenWrt', label: 'OpenWrt', repo: 'openwrt/openwrt', branch: 'main' },
    asset, sha256: createHash('sha256').update(json).digest('hex'),
  }));
  if (translation) writeFileSync(join(branch, 'openwrt--main.translations.json'), '{}\n');
  const artifactName = '02-catalog-openwrt-main-12345678-run-1-attempt-1';
  writeFileSync(join(attempts, '02-openwrt-main-12345678.attempt.json'), JSON.stringify({
    schema: 2, order: 2, orderText: '02', jobName: '02 · OpenWrt · main · openwrt/openwrt',
    source: { id: 'OpenWrt', label: 'OpenWrt', repo: 'openwrt/openwrt' },
    branch: 'main', version: 'main', status: 'success', stage: 'complete',
    artifactName, failureLog: '',
  }));
  writeFileSync(join(attempts, '02-openwrt-main-12345678--SUMMARY.txt'),
    'Source ID: OpenWrt\nBranch: main\nFinal status: success\n');
  writeFileSync(join(previous, 'old.json.gz'), gzipSync(Buffer.from('{}')));
  if (collision) {
    const duplicate = join(root, 'current', 'duplicate', 'dist');
    mkdirSync(duplicate, { recursive: true });
    writeFileSync(join(duplicate, asset), 'different');
  }
  return root;
}

function run(root, shouldPass) {
  const args = [
    script, join(root, 'current'), join(root, 'previous'), join(root, 'dist'),
    join(root, 'attempts'), join(root, 'diagnostics'),
  ];
  if (shouldPass) {
    execFileSync(process.execPath, args, { stdio: 'pipe' });
    if (!existsSync(join(root, 'dist', 'openwrt--main.json.gz')) ||
        !existsSync(join(root, 'dist', 'old.json.gz')) ||
        !existsSync(join(root, 'attempts', '02-openwrt-main-12345678.attempt.json'))) {
      throw new Error('nested Artifact collection failed');
    }
  } else {
    const result = spawnSync(process.execPath, args, { encoding: 'utf8' });
    if (result.status === 0) throw new Error('invalid Artifact fixture unexpectedly passed');
    if (!existsSync(join(root, 'diagnostics', 'publish-inputs.json'))) {
      throw new Error('failed collection did not preserve publish-inputs.json');
    }
  }
}

try {
  run(fixture('valid'), true);
  run(fixture('missing-translation', { translation: false }), false);
  run(fixture('collision', { collision: true }), false);
  const validManifest = JSON.parse(readFileSync(
    join(temp, 'valid', 'diagnostics', 'publish-inputs.json'), 'utf8'));
  if (validManifest.attempts[0].orderText !== '02' || validManifest.errors.length) {
    throw new Error('numbered publish manifest failed');
  }
  console.log('catalog collector checks passed: nested, missing translation, collision, numbering');
} finally {
  rmSync(temp, { recursive: true, force: true });
}

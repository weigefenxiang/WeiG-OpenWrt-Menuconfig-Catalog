#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync, gzipSync } from 'node:zlib';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const script = join(ROOT, 'scripts', 'collect-results.mjs');
const temp = mkdtempSync(join(tmpdir(), 'weig-catalog-collector-'));

function addArtifact(root, order, branchName, status = 'success', {
  translation = true, contract = true,
} = {}) {
  const orderText = String(order).padStart(2, '0');
  const artifact = `${orderText}-catalog-openwrt-${branchName}-run-1-attempt-1`;
  const base = join(root, 'current', artifact);
  const dist = join(base, 'dist');
  const attempts = join(base, 'attempts');
  const logs = join(base, 'failure-logs');
  mkdirSync(dist, { recursive: true });
  mkdirSync(attempts, { recursive: true });
  mkdirSync(logs, { recursive: true });
  const asset = `openwrt--${branchName}.json.gz`;
  if (status === 'success') {
    const json = JSON.stringify({ source: 'OpenWrt', branch: branchName, generation: 'current' });
    writeFileSync(join(dist, asset), gzipSync(Buffer.from(json)));
    writeFileSync(join(dist, `openwrt--${branchName}.meta.json`), JSON.stringify({
      source: { id: 'OpenWrt', label: 'OpenWrt', repo: 'openwrt/openwrt', branch: branchName },
      asset, sha256: createHash('sha256').update(json).digest('hex'),
    }));
    if (contract) {
      writeFileSync(join(dist, `openwrt--${branchName}.contract.json`), JSON.stringify({
        schema: 1,
        source: { id: 'OpenWrt', label: 'OpenWrt', repo: 'openwrt/openwrt', branch: branchName },
        summary: { selectableTargets: 1 }, unavailable: [],
      }));
    }
    if (translation) writeFileSync(join(dist, `openwrt--${branchName}.translations.json`), '{}\n');
  }
  const failureLog = status === 'failure' ? `${orderText}-openwrt-${branchName}--clone.log` : '';
  writeFileSync(join(attempts, `${orderText}-openwrt-${branchName}.attempt.json`), JSON.stringify({
    schema: 2, order, orderText,
    jobName: `${orderText} · OpenWrt · ${branchName} · openwrt/openwrt`,
    source: { id: 'OpenWrt', label: 'OpenWrt', repo: 'openwrt/openwrt' },
    branch: branchName, version: branchName, status,
    stage: status === 'success' ? 'complete' : 'clone', artifactName: artifact, failureLog,
  }));
  writeFileSync(join(attempts, `${orderText}-openwrt-${branchName}--SUMMARY.txt`),
    `Source ID: OpenWrt\nBranch: ${branchName}\nFinal status: ${status}\n`);
  if (failureLog) writeFileSync(join(logs, failureLog), 'clone failed\n');
}

function fixture(name, setup) {
  const root = join(temp, name);
  const previous = join(root, 'previous');
  mkdirSync(previous, { recursive: true });
  setup(root, previous);
  return root;
}

function addPrevious(previous, branchName) {
  const json = JSON.stringify({ source: 'OpenWrt', branch: branchName, generation: 'previous' });
  writeFileSync(join(previous, `openwrt--${branchName}.json.gz`), gzipSync(Buffer.from(json)));
  writeFileSync(join(previous, `openwrt--${branchName}.translations.json`), '{"old":true}\n');
}

function run(root, shouldPass = true) {
  const args = [
    script, join(root, 'current'), join(root, 'previous'), join(root, 'dist'),
    join(root, 'attempts'), join(root, 'diagnostics'),
  ];
  const result = spawnSync(process.execPath, args, { encoding: 'utf8' });
  if (shouldPass && result.status !== 0) throw new Error(result.stderr || result.stdout);
  if (!shouldPass && result.status === 0) throw new Error('fatal Artifact fixture unexpectedly passed');
  if (!existsSync(join(root, 'diagnostics', 'publish-inputs.json'))) {
    throw new Error('collection did not preserve publish-inputs.json');
  }
  return JSON.parse(readFileSync(join(root, 'diagnostics', 'publish-inputs.json'), 'utf8'));
}

try {
  const valid = fixture('valid', (root, previous) => {
    addPrevious(previous, 'main');
    addArtifact(root, 2, 'main');
  });
  const validManifest = run(valid);
  const validJson = JSON.parse(gunzipSync(readFileSync(
    join(valid, 'dist', 'openwrt--main.json.gz'))));
  if (!validManifest.complete || validManifest.fresh !== 1 ||
      validJson.generation !== 'current') throw new Error('valid current result was not published');

  const mixed = fixture('mixed', (root, previous) => {
    addPrevious(previous, 'main');
    addPrevious(previous, 'openwrt-24.10');
    addArtifact(root, 2, 'main');
    addArtifact(root, 3, 'openwrt-24.10', 'failure');
    addArtifact(root, 4, 'openwrt-25.12', 'failure');
  });
  const mixedManifest = run(mixed);
  const unavailable = mixedManifest.branches.find((item) => item.branch === 'openwrt-25.12');
  if (mixedManifest.complete || mixedManifest.fresh !== 1 || mixedManifest.lastGood !== 1 ||
      unavailable?.publishState !== 'unavailable') {
    throw new Error('partial success did not publish fresh plus last-good');
  }

  const quarantined = fixture('quarantined', (root, previous) => {
    addPrevious(previous, 'main');
    addArtifact(root, 2, 'main', 'success', { translation: false });
  });
  const quarantineManifest = run(quarantined);
  const quarantineJson = JSON.parse(gunzipSync(readFileSync(
    join(quarantined, 'dist', 'openwrt--main.json.gz'))));
  if (quarantineManifest.complete || quarantineManifest.fresh !== 0 ||
       quarantineJson.generation !== 'previous') throw new Error('invalid current result overwrote last-good');

  const contractless = fixture('contractless', (root, previous) => {
    addPrevious(previous, 'main');
    addArtifact(root, 2, 'main', 'success', { contract: false });
  });
  const contractlessManifest = run(contractless);
  if (contractlessManifest.complete || contractlessManifest.fresh !== 0 ||
      contractlessManifest.branches[0]?.issues.join(',') !== '缺 target contract') {
    throw new Error('missing target contract was not quarantined');
  }

  const fatal = fixture('fatal', (root) => {
    mkdirSync(join(root, 'current'), { recursive: true });
  });
  run(fatal, false);
  console.log('catalog collector checks passed: fresh, partial, quarantine, contract, last-good, fatal');
} finally {
  rmSync(temp, { recursive: true, force: true });
}

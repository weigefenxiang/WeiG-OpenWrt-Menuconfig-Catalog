#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { parseApkDump, parseOpkgPackages } from './curated-sizes.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const cli = new Map();
const positional = [];
for (let index = 2; index < process.argv.length; index++) {
  const token = process.argv[index];
  if (token.startsWith('--')) {
    const next = process.argv[index + 1];
    if (!next || next.startsWith('--')) throw new Error(`${token} requires a value`);
    cli.set(token.slice(2), next);
    index++;
  } else positional.push(token);
}
const output = resolve(positional[0] || join(ROOT, 'size-samples'));
const outputFile = cli.get('output-file') ? resolve(cli.get('output-file')) : '';
const selectedSource = String(cli.get('source') || '');
const selectedBranch = String(cli.get('branch') || '');
const config = JSON.parse(readFileSync(join(ROOT, 'catalog.config.json'), 'utf8'));
mkdirSync(output, { recursive: true });
if (outputFile) mkdirSync(dirname(outputFile), { recursive: true });
const temp = mkdtempSync(join(tmpdir(), 'weig-curated-size-'));

async function fetchBytes(url) {
  const response = await fetch(url, { headers: { 'User-Agent': 'WeiG-OpenWrt-Menuconfig-Catalog' } });
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  return Buffer.from(await response.arrayBuffer());
}

try {
  const configured = (config.curatedSizeSources || []).filter((source) =>
    (!selectedSource || source.id === selectedSource) && (!selectedBranch || source.branch === selectedBranch));
  if (selectedSource && selectedBranch && configured.length === 0 && outputFile) {
    writeFileSync(outputFile, JSON.stringify({
      schema: 2,
      generatedAt: new Date().toISOString(),
      source: selectedSource,
      branch: selectedBranch,
      available: false,
      reason: 'no-exact-official-index-source',
      packages: [],
      failures: [],
    }) + '\n');
    console.log(`${selectedSource}/${selectedBranch}: no exact official package-index source`);
  }
  for (const source of configured) {
    const packages = new Map();
    const failures = [];
    for (const feed of source.feeds || []) {
      const extension = source.format === 'apk' ? 'packages.adb' : 'Packages.gz';
      const url = `${source.baseUrl.replace(/\/$/, '')}/${feed}/${extension}`;
      try {
        const data = await fetchBytes(url);
        let rows;
        if (source.format === 'apk') {
          const file = join(temp, `${source.id}-${feed}.adb`.replace(/[^A-Za-z0-9_.-]/g, '-'));
          writeFileSync(file, data);
          const mount = temp.replace(/\\/g, '/');
          const json = execFileSync('docker', [
            'run', '--rm', '-v', `${mount}:/work`, 'alpine:edge',
            'apk', 'adbdump', '--format', 'json', `/work/${file.split(/[\\/]/).pop()}`,
          ], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
          rows = parseApkDump(json);
        } else {
          rows = parseOpkgPackages(gunzipSync(data).toString('utf8'));
        }
        for (const row of rows) packages.set(row.name, row);
      } catch (error) {
        failures.push({ feed, url, error: String(error.message || error) });
      }
    }
    if (!packages.size) {
      if (!outputFile) throw new Error(`${source.id}/${source.branch}: every size index failed`);
      writeFileSync(outputFile, JSON.stringify({
        schema: 2,
        generatedAt: new Date().toISOString(),
        source: source.id,
        branch: source.branch,
        architecture: source.architecture,
        format: source.format,
        baseUrl: source.baseUrl,
        available: false,
        reason: 'official-package-index-unavailable',
        packages: [],
        failures,
      }) + '\n');
      console.warn(`${source.id}/${source.branch}: every size index failed; publish unknown sizes`);
      continue;
    }
    const sample = {
      schema: 2,
      generatedAt: new Date().toISOString(),
      source: source.id,
      branch: source.branch,
      architecture: source.architecture,
      format: source.format,
      baseUrl: source.baseUrl,
      available: true,
      packages: [...packages.values()].sort((a, b) => a.name.localeCompare(b.name)),
      failures,
    };
    const destination = outputFile || join(output,
      `${source.id}--${source.branch}.json`.replace(/[^A-Za-z0-9_.-]/g, '-'));
    writeFileSync(destination, JSON.stringify(sample) + '\n');
    console.log(`${source.id}/${source.branch}: packages=${packages.size} failed-feeds=${failures.length}`);
  }
} finally {
  rmSync(temp, { recursive: true, force: true });
}

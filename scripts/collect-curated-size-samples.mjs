#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { parseApkDump, parseOpkgPackages } from './curated-sizes.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const output = resolve(process.argv[2] || join(ROOT, 'size-samples'));
const config = JSON.parse(readFileSync(join(ROOT, 'catalog.config.json'), 'utf8'));
mkdirSync(output, { recursive: true });
const temp = mkdtempSync(join(tmpdir(), 'weig-curated-size-'));

async function fetchBytes(url) {
  const response = await fetch(url, { headers: { 'User-Agent': 'WeiG-OpenWrt-Menuconfig-Catalog' } });
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  return Buffer.from(await response.arrayBuffer());
}

try {
  for (const source of config.curatedSizeSources || []) {
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
    if (!packages.size) throw new Error(`${source.id}/${source.branch}: every size index failed`);
    const sample = {
      schema: 1,
      generatedAt: new Date().toISOString(),
      source: source.id,
      branch: source.branch,
      architecture: source.architecture,
      packages: [...packages.values()].sort((a, b) => a.name.localeCompare(b.name)),
      failures,
    };
    writeFileSync(join(output, `${source.id}--${source.branch}.json`.replace(/[^A-Za-z0-9_.-]/g, '-')),
      JSON.stringify(sample) + '\n');
    console.log(`${source.id}/${source.branch}: packages=${packages.size} failed-feeds=${failures.length}`);
  }
} finally {
  rmSync(temp, { recursive: true, force: true });
}

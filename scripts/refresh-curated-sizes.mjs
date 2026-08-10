#!/usr/bin/env node
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { aggregateCuratedSizes } from './curated-sizes.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = new Map();
for (let index = 2; index < process.argv.length; index++) {
  const key = process.argv[index];
  const next = process.argv[index + 1];
  if (key.startsWith('--') && next && !next.startsWith('--')) {
    args.set(key.slice(2), next);
    index++;
  } else if (key.startsWith('--')) args.set(key.slice(2), true);
}
const config = JSON.parse(readFileSync(join(ROOT, 'catalog.config.json'), 'utf8'));
const packageNames = (config.curatedApplications || []).map((row) => row.packages[0]);
let bytes = {};
let coverage = {};
let provenance = [];

if (args.get('samples')) {
  const directory = resolve(String(args.get('samples')));
  const samples = readdirSync(directory).filter((name) => name.endsWith('.json')).sort()
    .map((name) => JSON.parse(readFileSync(join(directory, name), 'utf8')));
  ({ bytes, coverage } = aggregateCuratedSizes(packageNames, samples));
  provenance = samples.map(({ packages, ...sample }) => ({ ...sample, packages: packages.length }));
} else if (args.get('import-legacy')) {
  const legacy = JSON.parse(readFileSync(resolve(String(args.get('import-legacy'))), 'utf8'));
  const known = legacy.plugins || {};
  for (const packageName of packageNames) {
    const id = packageName.slice('luci-app-'.length);
    const kib = Number(known[id]);
    if (Number.isFinite(kib) && kib >= 0) bytes[packageName] = Math.round(kib * 1024);
  }
  provenance = [{
    source: 'migrated-official-index-observations',
    architecture: legacy.arch || '',
    generatedAt: legacy.generatedAt || '',
    metric: legacy.metric || '',
  }];
} else if (existsSync(join(ROOT, 'curated-sizes.json'))) {
  ({ bytes = {}, coverage = {}, provenance = [] } = JSON.parse(readFileSync(join(ROOT, 'curated-sizes.json'), 'utf8')));
}

const result = {
  schema: 1,
  generatedAt: new Date().toISOString(),
  metric: 'maximum compressed bytes of package plus recursive strong dependency closure across successful samples',
  bytes: Object.fromEntries(Object.entries(bytes).sort(([a], [b]) => a.localeCompare(b))),
  coverage,
  provenance,
};
if (args.get('write')) writeFileSync(join(ROOT, 'curated-sizes.json'), JSON.stringify(result, null, 2) + '\n');
console.log(`Curated sizes: ${Object.keys(result.bytes).length}/${packageNames.length}` +
  `${args.get('write') ? ' (written)' : ' (report only)'}`);

#!/usr/bin/env node
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { readFileSync } from 'node:fs';
import { gunzipSync, gzipSync } from 'node:zlib';

const args = new Map();
for (let index = 2; index < process.argv.length; index += 2) {
  args.set(String(process.argv[index] || '').replace(/^--/, ''), process.argv[index + 1] || '');
}
const decode = (path) => {
  const bytes = readFileSync(path);
  const json = bytes[0] === 0x1f && bytes[1] === 0x8b ? gunzipSync(bytes) : bytes;
  return { document: JSON.parse(json), json };
};
const median = (values) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
const parseMedian = (json, rounds = 21) => median(Array.from({ length: rounds }, () => {
  const start = performance.now();
  JSON.parse(json);
  return performance.now() - start;
}));
const bytes = (value) => {
  const json = Buffer.from(JSON.stringify(value));
  const gzip = gzipSync(json, { level: 9 });
  const decodeMedianMs = median(Array.from({ length: 21 }, () => {
    const start = performance.now();
    JSON.parse(gunzipSync(gzip));
    return performance.now() - start;
  }));
  return { raw: json.byteLength, gzip9: gzip.byteLength, parseMedianMs: parseMedian(json), decodeMedianMs };
};
const retainedHeap = (value) => {
  global.gc?.();
  const before = process.memoryUsage().heapUsed;
  const retained = JSON.parse(JSON.stringify(value));
  global.gc?.();
  const after = process.memoryUsage().heapUsed;
  assert.deepEqual(retained, value);
  return Math.max(0, after - before);
};

const graphPath = args.get('graph');
const sizesPath = args.get('sizes');
if (!graphPath || !sizesPath) throw new Error('Usage: node --expose-gc scripts/benchmark-package-size-assets.mjs --graph FILE --sizes FILE');
const graph = decode(graphPath).document;
let sizes = decode(sizesPath).document;
if (sizes.kind !== 'package-sizes' && Array.isArray(sizes.packages)) {
  const sample = sizes;
  sizes = {
    schema: 1,
    kind: 'package-sizes',
    encoding: 'positional-rows-v1',
    fields: ['package', 'archiveBytes', 'installedBytes'],
    source: { id: sample.source || '', branch: sample.branch || '' },
    observation: { architecture: sample.architecture || '', match: 'exact-source-branch' },
    coverage: { known: sample.packages.length, total: sample.packages.length, unknown: 0 },
    rows: sample.packages.map((row) => [row.name, row.size, row.installedSize > 0 ? row.installedSize : null]),
  };
}
if (sizes.kind !== 'package-sizes' && sizes.bytes && typeof sizes.bytes === 'object') {
  const legacy = sizes;
  const rows = Object.entries(legacy.bytes).map(([name, archiveBytes]) => [name, archiveBytes, null]);
  sizes = {
    schema: 1,
    kind: 'package-sizes',
    encoding: 'positional-rows-v1',
    fields: ['package', 'archiveBytes', 'installedBytes'],
    source: { id: 'representative-observations', branch: 'mixed' },
    observation: { architecture: 'aarch64_cortex-a53', match: 'benchmark-only' },
    coverage: { known: rows.length, total: rows.length, unknown: 0 },
    rows,
  };
}
assert.equal(sizes.kind, 'package-sizes');
assert.deepEqual(sizes.fields, ['package', 'archiveBytes', 'installedBytes']);
const readableSizes = {
  ...sizes,
  encoding: 'object-rows-v1',
  rows: sizes.rows.map(([packageName, archiveBytes, installedBytes]) => ({ package: packageName, archiveBytes, installedBytes })),
};
const positional = bytes(sizes);
const readable = bytes(readableSizes);
const graphOnly = bytes(graph);
const embedded = bytes({ ...graph, packageSizes: sizes });
const result = {
  schema: 1,
  rows: sizes.rows.length,
  positional: { ...positional, retainedHeapBytes: retainedHeap(sizes) },
  readable: { ...readable, retainedHeapBytes: retainedHeap(readableSizes) },
  separate: {
    raw: graphOnly.raw + positional.raw,
    gzip9: graphOnly.gzip9 + positional.gzip9,
    parseMedianMs: graphOnly.parseMedianMs + positional.parseMedianMs,
    decodeMedianMs: graphOnly.decodeMedianMs + positional.decodeMedianMs,
  },
  embedded,
  semanticEquivalent: true,
};
assert.deepEqual(JSON.parse(JSON.stringify({ ...graph, packageSizes: sizes })).packageSizes, sizes);
assert(positional.raw <= readable.raw && positional.gzip9 <= readable.gzip9,
  'positional rows must not exceed readable object rows');
console.log(JSON.stringify(result, null, 2));

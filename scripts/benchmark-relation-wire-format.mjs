import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync, gunzipSync } from 'node:zlib';
import { performance } from 'node:perf_hooks';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { measureJson } from './benchmark-profile-wire-format.mjs';
import { encodeRelationTables, decodeRelationTables, encodeCompactRelationTables, decodeCompactRelationTables } from './relation-table-codec.mjs';

const decode = (candidate) => candidate.encoding === 'interned-relations-v1' ? decodeRelationTables(candidate)
  : candidate.encoding === 'interned-definitions-edge-rows-v1' ? decodeCompactRelationTables(candidate) : candidate;
if (process.argv[2] === '--measure-decode') {
  global.gc?.();
  const initialHeap = process.memoryUsage().heapUsed;
  let wire = JSON.parse(readFileSync(process.argv[3], 'utf8'));
  global.gc?.();
  const start = performance.now();
  const decoded = decode(wire);
  const decodeMs = performance.now() - start;
  globalThis.retainedRelationBenchmark = { wire, decoded };
  global.gc?.();
  const combinedHeapBytes = Math.max(0, process.memoryUsage().heapUsed - initialHeap);
  wire = null;
  globalThis.retainedRelationBenchmark = decoded;
  global.gc?.();
  console.log(JSON.stringify({ decodeMs: Number(decodeMs.toFixed(2)), combinedHeapBytes,
    decodedHeapBytes: Math.max(0, process.memoryUsage().heapUsed - initialHeap) }));
  process.exit(0);
}

const input = process.argv[2];
if (!input) throw new Error('Usage: node --expose-gc scripts/benchmark-relation-wire-format.mjs <graph.json.gz>');
const asset = JSON.parse(gunzipSync(readFileSync(input)));
const source = asset.relations || asset;
const encoded = encodeRelationTables(source);
const targeted = encodeCompactRelationTables(source);
const root = mkdtempSync(join(tmpdir(), 'catalog-relation-benchmark-'));
try {
  const report = [];
  for (const [name, candidate] of [['schema4', source], ['interned', encoded], ['targeted', targeted]]) {
    const json = JSON.stringify(candidate);
    const path = join(root, `${name}.json`);
    writeFileSync(path, json);
    const parse = measureJson(path, 3);
    const measured = spawnSync(process.execPath, ['--expose-gc', fileURLToPath(import.meta.url), '--measure-decode', path],
      { encoding: 'utf8', windowsHide: true });
    if (measured.status !== 0) throw new Error(measured.stderr || 'Decode benchmark failed');
    const decoded = decode(candidate);
    assert.deepEqual(decoded, source);
    report.push({ name, rawBytes: Buffer.byteLength(json), gzip9Bytes: gzipSync(json, { level: 9 }).length,
      ...parse, ...JSON.parse(measured.stdout), semanticEqual: true });
  }
  console.log(JSON.stringify({ input, rows: report }, null, 2));
} finally {
  // A unique benchmark output directory, never caller-owned files.
  rmSync(root, { recursive: true, force: true });
}

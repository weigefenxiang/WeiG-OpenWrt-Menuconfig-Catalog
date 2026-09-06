import assert from 'node:assert/strict';
import { constants } from 'node:buffer';
import { existsSync, readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { measureJsonBytes } from '../scripts/catalog-size-report.mjs';

const leaf = { text: 'Path\\name "quoted"\n中文 😀 \ud800', empty: {}, values: [true, false, null, 0, -0, 1e24] };
const cases = [null, undefined, '', '中文', '😀', '\ud800', '\udc00', 0, -0, NaN, Infinity,
  true, [], {}, [undefined, , null], { omitted: undefined, retained: null },
  { one: leaf, repeated: leaf, deeper: { leaf }, array: [leaf, leaf] }, Object.create(null)];
for (const value of cases) {
  for (const indent of [0, 1, 2, 4, 10, 14, -2, 1.8]) {
    const json = JSON.stringify(value, null, indent);
    assert.equal(measureJsonBytes(value, indent), json === undefined ? undefined : Buffer.byteLength(json));
  }
}
let seed = 91;
const next = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0);
function randomJson(depth) {
  if (!depth || next() % 3 === 0) return cases[next() % 15];
  const values = Array.from({ length: next() % 5 }, () => randomJson(depth - 1));
  return next() % 2 ? values : Object.fromEntries(values.map((value, index) => [`key-${index}-中文`, value]));
}
for (let index = 0; index < 200; index++) {
  const value = randomJson(5);
  for (const indent of [0, 2]) {
    const json = JSON.stringify(value, null, indent);
    assert.equal(measureJsonBytes(value, indent), json === undefined ? undefined : Buffer.byteLength(json));
  }
}
const cycle = {}; cycle.self = cycle;
assert.throws(() => measureJsonBytes(cycle), /Circular/);
assert.throws(() => measureJsonBytes(1n), TypeError);
assert.throws(() => measureJsonBytes(new Date()), /plain JSON/);
assert.throws(() => measureJsonBytes({ toJSON() { return 1; } }), /plain JSON/);

// Exercise the real limit without constructing a >512 MiB string or requiring
// a large CI heap: a shared deep AST is logically repeated just as it is in
// definitions, variants and relation edges. The independent oracle serializes
// ONE element inside its array context, then applies exact comma arithmetic.
let ast = { type: 'symbol', name: 'ROOT' };
for (let index = 0; index < 100; index++) ast = { type: 'and', left: ast, right: { type: 'symbol', name: `S${index}` } };
const one = Buffer.byteLength(JSON.stringify([ast], null, 2));
const members = Math.ceil(constants.MAX_STRING_LENGTH / (one - 3)) + 20;
const graph = Array(members).fill(ast);
const expected = 3 + members * (one - 3) + (members - 1);
assert(expected > constants.MAX_STRING_LENGTH);
assert.equal(measureJsonBytes(graph, 2), expected);
assert.equal(measureJsonBytes(graph), 2 + members * Buffer.byteLength(JSON.stringify(ast)) + members - 1);

const generator = readFileSync(new URL('../scripts/generate-catalog.mjs', import.meta.url), 'utf8');
assert(generator.includes('readableRelationsJsonBytes: measureJsonBytes(relations, 2) + 1'));
assert(!/JSON\.stringify\(relations\s*,\s*null\s*,\s*2\)/.test(generator));
console.log(`Catalog JSON measurement passed: native parity and ${expected} logical bytes above string limit`);

// Optional replay of an exact run artifact; run once per branch in a separate
// process so the parsed multi-megabyte graphs do not accumulate between cases.
const asset = process.argv[2];
if (asset) {
  const payload = JSON.parse(gunzipSync(readFileSync(asset)));
  const readable = measureJsonBytes(payload.relations, 2) + 1;
  const compactPath = asset.replace(/\.json\.gz$/, '.relations.json.gz');
  const compact = JSON.parse(gunzipSync(readFileSync(compactPath))).relations;
  const compactBytes = measureJsonBytes(compact);
  assert.equal(compactBytes, Buffer.byteLength(JSON.stringify(compact)));
  // The debug path must also work on the real graph, without pretty inflation.
  const debug = JSON.stringify({ schema: payload.relations.schema, source: payload.source,
    generatedAt: payload.generatedAt, summary: payload.relations.summary,
    validation: payload.relations.validation, indexes: payload.relations.indexes,
    records: payload.relations.records }) + '\n';
  assert(debug.length > 0);
  const metaPath = asset.replace(/\.json\.gz$/, '.meta.json');
  if (existsSync(metaPath)) {
    const meta = JSON.parse(readFileSync(metaPath, 'utf8'));
    assert.equal(readable, meta.sizeReport.readableRelationsJsonBytes, 'successful old measurement must stay identical');
    assert.equal(compactBytes, meta.sizeReport.compactRelationsJsonBytes);
  }
  console.log(JSON.stringify({ source: payload.source.id, branch: payload.source.branch,
    readable, compactBytes, previousMeta: existsSync(metaPath), debugBytes: Buffer.byteLength(debug), result: 'PASS' }));
}

#!/usr/bin/env node
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildKconfigRelations,
} from '../scripts/kconfig-relations.mjs';
import { parseKconfigTree } from '../scripts/lib.mjs';
import {
  compactRelations,
  compareRelationSemantics,
  expandCompactRelations,
  validateCompactRoundTrip,
} from '../scripts/compact-relations.mjs';

const ROOT = join(fileURLToPath(new URL('..', import.meta.url)));
const tree = join(ROOT, 'tests', 'kconfig-compact-roundtrip');
const menu = parseKconfigTree(tree);
assert.equal(menu.validation.relationsComplete, true);
assert.equal(menu.validation.structuralErrors.length, 0);

const duplicate = menu.allOptions.find((row) => row.symbol === 'ROUNDTRIP_DUP');
assert.equal(duplicate?.nodes.length, 2, 'parser must retain duplicate definitions');
const typed = menu.allOptions.find((row) => row.symbol === 'ROUNDTRIP_TYPED');
assert.deepEqual(typed?.defaults, [
  '"first"   if ROUNDTRIP_GATE',
  '"second"\tif ROUNDTRIP_RESET',
]);
assert.equal(typed?.defaultsTyped[0]?.condition, 'ROUNDTRIP_GATE');
assert.equal(menu.choices[0]?.resetIf?.[0], 'ROUNDTRIP_RESET');
assert.equal(menu.choices[0]?.resetIfAst?.[0]?.complete, true);

const relations = buildKconfigRelations(menu.allOptions, [], menu.choices, {
  parserValidation: menu.validation,
});
const relationDuplicate = relations.records.find((row) => row.configSymbol === 'ROUNDTRIP_DUP');
assert.equal(relationDuplicate?.nodes.length, 2);
assert.equal(relations.records.find((row) => row.configSymbol === 'ROUNDTRIP_TYPED')?.defaults[0],
  '"first"   if ROUNDTRIP_GATE');
assert.equal(relations.choices[0]?.resetIf?.[0], 'ROUNDTRIP_RESET');

const compact = compactRelations(relations);
const expanded = expandCompactRelations(compact);
assert.equal(compact.roundTripValidated, true);
assert.deepEqual(compact.defaultsFields, ['valueId', 'conditionId', 'rawId']);
assert.equal(compareRelationSemantics(relations, expanded).equal, true);
assert.deepEqual(expanded.indexes.forwardEdges, relations.indexes.forwardEdges);
assert.deepEqual(expanded.indexes.reverseEdges, relations.indexes.reverseEdges);
assert.equal(expanded.records.find((row) => row.configSymbol === 'ROUNDTRIP_DUP')?.nodes.length, 2);
assert.deepEqual(expanded.records.find((row) => row.configSymbol === 'ROUNDTRIP_TYPED')?.defaults, typed.defaults);
assert.deepEqual(expanded.choices[0]?.resetIf, ['ROUNDTRIP_RESET']);

// Edge rows are source-indexed.  Preserve the invariant even if two source
// rows normalize to the same wire edge, as can happen with feed-merged data.
const duplicatedEdgeRelations = structuredClone(relations);
duplicatedEdgeRelations.edges.push(structuredClone(duplicatedEdgeRelations.edges[0]));
const sourceEdgeId = duplicatedEdgeRelations.edges.length - 1;
const sourceFrom = duplicatedEdgeRelations.edges[0].from;
duplicatedEdgeRelations.indexes.forwardEdges[sourceFrom].push(sourceEdgeId);
const duplicatedCompact = compactRelations(duplicatedEdgeRelations);
const duplicatedExpanded = expandCompactRelations(duplicatedCompact);
assert.equal(compareRelationSemantics(duplicatedEdgeRelations, duplicatedExpanded).equal, true);

// Diagnostics must identify a small structural mismatch rather than dumping
// the multi-megabyte canonical JSON strings into a CI failure.
const corrupted = JSON.parse(JSON.stringify(compact));
corrupted.records[0][0] = -1;
const diagnostic = validateCompactRoundTrip(relations, corrupted);
assert.equal(diagnostic.valid, false);
assert.equal(diagnostic.reasons[0]?.reason, 'compact-expand-semantic-mismatch');
assert(diagnostic.reasons[0]?.differences?.some((row) => row.path.endsWith('.configSymbol')));
assert((diagnostic.reasons[0]?.differences || []).every((row) =>
  String(row.expected).length <= 321 && String(row.actual).length <= 321));

console.log('compact relation parser roundtrip checks passed');

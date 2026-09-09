#!/usr/bin/env node
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
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
const choiceMenu = parseKconfigTree(join(ROOT, 'tests', 'kconfig-choice-defaults'));
const choiceRelations = buildKconfigRelations(choiceMenu.allOptions, [], choiceMenu.choices,
  { parserValidation: choiceMenu.validation });
assert.deepEqual(choiceRelations.choices[0].members,
  ['BACKEND_PREFERRED', 'BACKEND_ZETA', 'BACKEND_ALPHA'],
  'native declaration/source order must survive the sorted symbol table');
assert.equal(choiceRelations.choices[0].memberOrder, 'native-declaration-v1');
assert.deepEqual(expandCompactRelations(compactRelations(choiceRelations)).choices, choiceRelations.choices);
const projectedChoices = buildKconfigRelations(choiceMenu.allOptions.filter(option =>
  option.symbol !== 'BACKEND_PREFERRED'), [], choiceMenu.choices, {
  parserValidation: choiceMenu.validation, choiceOptions: choiceMenu.allOptions,
  externalSymbolSources: { BACKEND_PREFERRED: ['parsed-target-filter'] },
});
assert.deepEqual(projectedChoices.choices[0].members, choiceRelations.choices[0].members,
  'Target/Profile projection must preserve members supplied by native baseline context');
assert.deepEqual(expandCompactRelations(compactRelations(projectedChoices)).choices, projectedChoices.choices);
const identityRelations = buildKconfigRelations([
  { symbol: 'PACKAGE_real', type: 'tristate', prompt: 'Package', visible: true },
  { symbol: 'PACKAGE_real_FEATURE', type: 'bool', prompt: 'Package option', visible: true },
], [{ name: 'real', depends: [], provides: [], conflicts: [] }], []);
for (const projection of [identityRelations, expandCompactRelations(compactRelations(identityRelations))]) {
  const flag = projection.records.find((row) => row.configSymbol === 'PACKAGE_real_FEATURE');
  assert.equal(flag.kind, 'config', 'package prefix is not concrete package identity');
  assert.equal(flag.package, '');
  assert.equal(projection.records.find((row) => row.configSymbol === 'PACKAGE_real').package, 'real');
}
if (process.env.KCONFIG_NATIVE_TEST_TREE) {
  const nativeDirectory = join(process.env.KCONFIG_NATIVE_TEST_TREE, 'scripts', 'config');
  execFileSync('make', ['-C', nativeDirectory, 'conf'], { stdio: 'pipe' });
  const oracle = mkdtempSync(join(tmpdir(), 'catalog-choice-oracle-'));
  try {
    cpSync(join(ROOT, 'tests', 'kconfig-choice-defaults'), oracle, { recursive: true });
    for (const test of JSON.parse(readFileSync(join(oracle, 'cases.json')))) {
      const output = join(oracle, '.config');
      writeFileSync(join(oracle, 'input.config'), test.input);
      execFileSync(join(nativeDirectory, 'conf'), ['--defconfig=input.config', 'Config.in'], {
        cwd: oracle, env: { ...process.env, KCONFIG_CONFIG: output }, stdio: 'pipe',
      });
      const values = new Map();
      for (const line of readFileSync(output, 'utf8').split(/\r?\n/)) {
        const match = line.match(/^CONFIG_([^=]+)=(.*)$/);
        if (match) values.set(match[1], match[2].startsWith('"') ? JSON.parse(match[2]) : match[2]);
      }
      for (const [symbol, expected] of Object.entries(test.expected)) {
        assert.equal(values.get(symbol) ?? 'n', expected, `native ${test.name}: ${symbol}`);
      }
      console.log(`Native conf choice/scalar parity: ${test.name}`);
    }
  } finally { rmSync(oracle, { recursive: true, force: true }); }
}
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
for (const symbol of ['LATE_BOOL', 'LATE_TRI', 'LATE_STRING', 'LATE_INT', 'LATE_HEX']) {
  const option = menu.allOptions.find((row) => row.symbol === symbol);
  assert(option.type, 'merged symbol has its later declared type');
  assert.equal(option.defaultsTyped[0].type, '', 'first untyped definition stays explicit');
}
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

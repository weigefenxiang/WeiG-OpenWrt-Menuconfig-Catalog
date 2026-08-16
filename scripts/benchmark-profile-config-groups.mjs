#!/usr/bin/env node
// SPDX-FileCopyrightText: 2026 weigefenxiang <weigefenxiang@gmail.com>
// SPDX-License-Identifier: GPL-3.0-or-later

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync, gzipSync } from 'node:zlib';

const FIXED_IDENTITY_SYMBOLS = Object.freeze(['TARGET_BOARD', 'TARGET_SUBTARGET', 'TARGET_PROFILE']);
const GROUPED_ENCODING = 'profile-rows-grouped-state-all-v1';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function sortedIndexPairs(values) {
  return [...values].sort(([left], [right]) => left - right);
}

function pairsEqual(left, right) {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    if (left[index][0] !== right[index][0] || left[index][1] !== right[index][1]) return false;
  }
  return true;
}

function pairsHash(pairs) {
  const hash = createHash('sha256');
  for (const [index, value] of pairs) hash.update(`${index}=${value}\n`);
  return hash.digest('hex');
}

function groupPairs(pairs) {
  const grouped = [[], [], [], []];
  for (const [index, value] of pairs || []) {
    if (value === 'n') grouped[0].push(index);
    else if (value === 'm') grouped[1].push(index);
    else if (value === 'y') grouped[2].push(index);
    else grouped[3].push(index, value);
  }
  return grouped;
}

function ungroupPairs(grouped) {
  const pairs = [];
  const rows = grouped || [];
  for (const index of rows[0] || []) pairs.push([index, 'n']);
  for (const index of rows[1] || []) pairs.push([index, 'm']);
  for (const index of rows[2] || []) pairs.push([index, 'y']);
  for (let offset = 0; offset < (rows[3] || []).length; offset += 2) {
    pairs.push([rows[3][offset], rows[3][offset + 1]]);
  }
  return pairs;
}

function profileMetaFromRow(row, fields) {
  const at = (name) => row[fields.indexOf(name)];
  return {
    target: at('target') || '',
    board: at('board') || '',
    subtarget: at('subtarget') || '',
    profile: at('profile') || '',
    name: at('name') || '',
    selector: at('selector') || '',
    targetSelector: at('targetSelector') || '',
    semanticHash: at('semanticHash') || '',
    symbols: Number(at('symbolCount') || 0),
    delta: ungroupPairs(at('delta') || []),
  };
}

export function profileAssetView(payload) {
  assert(payload && payload.kind === 'profile-baselines', 'input must be a Catalog profile-baselines asset');
  assert(Array.isArray(payload.symbols) && Array.isArray(payload.profiles), 'profile asset must include symbols and profiles');
  if (payload.encoding === GROUPED_ENCODING && Array.isArray(payload.profileFields)) {
    return {
      symbols: payload.symbols,
      common: ungroupPairs(payload.common || []),
      profiles: payload.profiles.map((row) => profileMetaFromRow(row, payload.profileFields)),
      source: payload.source || {},
    };
  }
  assert(Array.isArray(payload.common), 'profile asset common state must be an array');
  assert(payload.profiles.every((profile) => profile && !Array.isArray(profile)), `unsupported profile asset encoding: ${payload.encoding || '(none)'}`);
  return {
    symbols: payload.symbols,
    common: payload.common,
    profiles: payload.profiles.map((profile) => ({
      target: profile.target || '', board: profile.board || '', subtarget: profile.subtarget || '',
      profile: profile.profile || '', name: profile.name || '', selector: profile.selector || '',
      targetSelector: profile.targetSelector || '', semanticHash: profile.semanticHash || '',
      symbols: Number(profile.symbols || profile.symbolCount || 0), delta: profile.delta || [],
    })),
    source: payload.source || {},
  };
}

function fullProfileState(view, profile) {
  const values = new Map();
  for (const [index, value] of view.common) {
    assert(view.symbols[index], `invalid common symbol index: ${index}`);
    values.set(index, value);
  }
  for (const [index, value] of profile.delta || []) {
    assert(view.symbols[index], `invalid profile symbol index: ${index}`);
    values.set(index, value);
  }
  return values;
}

export function exactIdentitySymbols(view) {
  const indexes = new Map(view.symbols.map((symbol, index) => [symbol, index]));
  const identity = new Set();
  for (const symbol of FIXED_IDENTITY_SYMBOLS) if (indexes.has(symbol)) identity.add(indexes.get(symbol));
  for (const profile of view.profiles) {
    const candidates = [profile.board ? `TARGET_${profile.board}` : '', profile.targetSelector, profile.selector];
    for (const symbol of candidates) if (symbol && indexes.has(symbol)) identity.add(indexes.get(symbol));
  }
  return identity;
}

function distribution(groups) {
  const counts = new Map();
  for (const group of groups) counts.set(group.members.length, (counts.get(group.members.length) || 0) + 1);
  return [...counts].sort(([left], [right]) => left - right).map(([size, count]) => ({ size, groups: count }));
}

function candidatePayload(view, groups, profiles, identitySymbols, includeIdentity) {
  const commonMap = new Map(view.common.filter(([index]) => !identitySymbols.has(index)));
  for (const group of groups) {
    for (const [index, value] of commonMap) {
      assert(group.semantic.get(index) === value, `semantic common mismatch in group ${group.id}: ${view.symbols[index]}`);
    }
  }
  const groupRows = groups.map((group) => groupPairs(sortedIndexPairs(
    new Map([...group.semantic].filter(([index, value]) => commonMap.get(index) !== value)),
  )));
  const profileRows = profiles.map((entry) => {
    const profile = entry.profile;
    const row = [
      profile.target, profile.board, profile.subtarget, profile.profile, profile.name,
      profile.selector, profile.targetSelector, profile.semanticHash, profile.symbols, entry.groupId,
    ];
    if (includeIdentity) row.push(groupPairs(sortedIndexPairs(entry.identity)));
    return row;
  });
  return {
    schema: 0,
    kind: 'profile-config-groups-benchmark',
    encoding: includeIdentity ? 'common-plus-exact-config-group-delta-with-identity-v0' : 'common-plus-exact-config-group-delta-derived-identity-v0',
    source: view.source,
    profileFields: [
      'target', 'board', 'subtarget', 'profile', 'name', 'selector', 'targetSelector',
      'semanticHash', 'symbolCount', 'groupId', ...(includeIdentity ? ['identity'] : []),
    ],
    stateGroups: ['n', 'm', 'y', 'otherIndexValue'],
    symbols: view.symbols,
    common: groupPairs(sortedIndexPairs(commonMap)),
    groups: groupRows,
    profiles: profileRows,
  };
}

function verifySelfContainedCandidate(payload, view) {
  const fields = payload.profileFields;
  const common = new Map(ungroupPairs(payload.common));
  let mismatches = 0;
  for (let index = 0; index < payload.profiles.length; index += 1) {
    const row = payload.profiles[index];
    const groupId = Number(row[fields.indexOf('groupId')]);
    const values = new Map(common);
    for (const [symbolIndex, value] of ungroupPairs(payload.groups[groupId])) values.set(symbolIndex, value);
    const identity = row[fields.indexOf('identity')];
    for (const [symbolIndex, value] of ungroupPairs(identity || [])) values.set(symbolIndex, value);
    if (!pairsEqual(sortedIndexPairs(values), sortedIndexPairs(fullProfileState(view, view.profiles[index])))) mismatches += 1;
  }
  return mismatches;
}

export function analyzeExactConfigGroups(payload) {
  const view = profileAssetView(payload);
  const identitySymbols = exactIdentitySymbols(view);
  const hashBuckets = new Map();
  const groups = [];
  const profiles = [];
  let sourceStatePairs = 0;
  let semanticStatePairs = 0;
  let identityPairs = 0;

  for (const profile of view.profiles) {
    const full = fullProfileState(view, profile);
    sourceStatePairs += full.size;
    const semantic = new Map();
    const identity = new Map();
    for (const [index, value] of full) {
      if (identitySymbols.has(index)) identity.set(index, value);
      else semantic.set(index, value);
    }
    semanticStatePairs += semantic.size;
    identityPairs += identity.size;
    const semanticPairs = sortedIndexPairs(semantic);
    const hash = pairsHash(semanticPairs);
    const bucket = hashBuckets.get(hash) || [];
    let groupId = bucket.find((id) => pairsEqual(groups[id].pairs, semanticPairs));
    if (groupId === undefined) {
      groupId = groups.length;
      groups.push({ id: groupId, hash, pairs: semanticPairs, semantic, members: [] });
      bucket.push(groupId);
      hashBuckets.set(hash, bucket);
    }
    groups[groupId].members.push({ target: profile.target, subtarget: profile.subtarget, profile: profile.profile });
    profiles.push({ profile, groupId, identity });
  }

  const selfContained = candidatePayload(view, groups, profiles, identitySymbols, true);
  const derivedIdentity = candidatePayload(view, groups, profiles, identitySymbols, false);
  const selfContainedJson = Buffer.from(JSON.stringify(selfContained));
  const derivedIdentityJson = Buffer.from(JSON.stringify(derivedIdentity));
  const reconstructionMismatches = verifySelfContainedCandidate(selfContained, view);
  assert(reconstructionMismatches === 0, `self-contained Config Group reconstruction mismatches: ${reconstructionMismatches}`);

  const sizes = groups.map((group) => group.members.length);
  const singletonGroups = sizes.filter((size) => size === 1).length;
  const multiProfileGroups = sizes.filter((size) => size > 1).length;
  const profilesInMultiGroups = sizes.filter((size) => size > 1).reduce((sum, size) => sum + size, 0);
  const semanticCommon = new Map(view.common.filter(([index]) => !identitySymbols.has(index)));
  return {
    schema: 1,
    source: view.source,
    profiles: view.profiles.length,
    symbols: view.symbols.length,
    identitySymbols: identitySymbols.size,
    identityPairs,
    sourceStatePairs,
    semanticStatePairs,
    uniqueConfigGroups: groups.length,
    singletonGroups,
    multiProfileGroups,
    profilesInMultiGroups,
    largestGroup: Math.max(0, ...sizes),
    groupSizeDistribution: distribution(groups),
    exactGroupStatePairs: groups.reduce((sum, group) => sum + group.semantic.size, 0),
    semanticCommonSymbols: semanticCommon.size,
    groupDeltaPairs: groups.reduce((sum, group) => sum + [...group.semantic]
      .filter(([index, value]) => semanticCommon.get(index) !== value).length, 0),
    reconstructionMismatches,
    selfContained: {
      rawJsonBytes: selfContainedJson.byteLength,
      gzipBytes: gzipSync(selfContainedJson, { level: 9 }).byteLength,
      semanticParity: true,
    },
    derivedIdentityEstimate: {
      rawJsonBytes: derivedIdentityJson.byteLength,
      gzipBytes: gzipSync(derivedIdentityJson, { level: 9 }).byteLength,
      semanticProjectionParity: true,
      nativeDefconfigParityRequired: true,
    },
  };
}

function percentReduction(value, baseline) {
  return baseline > 0 ? Number(((1 - value / baseline) * 100).toFixed(2)) : 0;
}

function formatReport(report) {
  const data = report.analysis;
  return [
    `Profile Config Group benchmark: ${report.input}`,
    `Profiles: ${data.profiles} | Unique groups: ${data.uniqueConfigGroups} | Multi-profile groups: ${data.multiProfileGroups} | Profiles in shared groups: ${data.profilesInMultiGroups} | Largest group: ${data.largestGroup}`,
    `Identity symbols: ${data.identitySymbols} | Identity state pairs: ${data.identityPairs} | Reconstruction mismatches: ${data.reconstructionMismatches}`,
    `Semantic state pairs: ${data.semanticStatePairs} -> exact group state pairs: ${data.exactGroupStatePairs} | group delta pairs: ${data.groupDeltaPairs}`,
    `Current: ${report.inputJsonBytes} raw / ${report.inputGzipBytes} gzip bytes`,
    `Self-contained exact groups: ${data.selfContained.rawJsonBytes} raw (${data.selfContained.rawReductionPercent}% reduction) / ${data.selfContained.gzipBytes} gzip (${data.selfContained.gzipReductionPercent}% reduction)`,
    `Derived-identity estimate: ${data.derivedIdentityEstimate.rawJsonBytes} raw (${data.derivedIdentityEstimate.rawReductionPercent}% reduction) / ${data.derivedIdentityEstimate.gzipBytes} gzip (${data.derivedIdentityEstimate.gzipReductionPercent}% reduction); requires Native make defconfig parity before adoption`,
  ].join('\n');
}

function fixture() {
  const symbols = [
    'A', 'TARGET_BOARD', 'TARGET_SUBTARGET', 'TARGET_PROFILE', 'TARGET_x86', 'TARGET_x86_64',
    'TARGET_x86_64_DEVICE_a', 'TARGET_x86_64_DEVICE_b',
  ];
  const indexes = new Map(symbols.map((symbol, index) => [symbol, index]));
  const common = [[indexes.get('A'), 'y']];
  const makeProfile = (id) => ({
    target: 'x86/64', board: 'x86', subtarget: '64', profile: `DEVICE_${id}`, name: id,
    selector: `TARGET_x86_64_DEVICE_${id}`, targetSelector: 'TARGET_x86_64', semanticHash: '', symbols: 8,
    delta: [
      [indexes.get('TARGET_BOARD'), '"x86"'], [indexes.get('TARGET_SUBTARGET'), '"64"'],
      [indexes.get('TARGET_PROFILE'), `"DEVICE_${id}"`], [indexes.get('TARGET_x86'), 'y'],
      [indexes.get('TARGET_x86_64'), 'y'], [indexes.get('TARGET_x86_64_DEVICE_a'), id === 'a' ? 'y' : 'n'],
      [indexes.get('TARGET_x86_64_DEVICE_b'), id === 'b' ? 'y' : 'n'],
    ],
  });
  return {
    schema: 1, kind: 'profile-baselines', encoding: 'branch-common-plus-profile-delta-v1',
    source: { id: 'Fixture', branch: 'test', commit: 'fixture' }, symbols, common,
    profiles: [makeProfile('a'), makeProfile('b')],
  };
}

function selfTest() {
  const report = analyzeExactConfigGroups(fixture());
  assert(report.profiles === 2, 'fixture profile count');
  assert(report.uniqueConfigGroups === 1, 'identity-only differences must collapse into one exact Config Group');
  assert(report.profilesInMultiGroups === 2, 'fixture profiles must share the group');
  assert(report.reconstructionMismatches === 0, 'fixture reconstruction parity');
  console.log('Profile Config Group benchmark self-test: PASS');
}

function main() {
  const args = process.argv.slice(2);
  if (args.includes('--self-test')) return selfTest();
  const jsonOutput = args.includes('--json');
  const inputArg = args.find((arg) => !arg.startsWith('-'));
  if (!inputArg) {
    console.error('Usage: node scripts/benchmark-profile-config-groups.mjs <profiles.json.gz> [--json]\n       node scripts/benchmark-profile-config-groups.mjs --self-test');
    process.exitCode = 2;
    return;
  }
  const input = resolve(inputArg);
  const inputGzip = readFileSync(input);
  const sourceJson = gunzipSync(inputGzip).toString('utf8');
  const analysis = analyzeExactConfigGroups(JSON.parse(sourceJson));
  analysis.selfContained.rawReductionPercent = percentReduction(analysis.selfContained.rawJsonBytes, Buffer.byteLength(sourceJson));
  analysis.selfContained.gzipReductionPercent = percentReduction(analysis.selfContained.gzipBytes, inputGzip.byteLength);
  analysis.derivedIdentityEstimate.rawReductionPercent = percentReduction(analysis.derivedIdentityEstimate.rawJsonBytes, Buffer.byteLength(sourceJson));
  analysis.derivedIdentityEstimate.gzipReductionPercent = percentReduction(analysis.derivedIdentityEstimate.gzipBytes, inputGzip.byteLength);
  const report = {
    schema: 1, input: basename(input), inputJsonBytes: Buffer.byteLength(sourceJson), inputGzipBytes: inputGzip.byteLength, analysis,
  };
  console.log(jsonOutput ? JSON.stringify(report, null, 2) : formatReport(report));
}

const invokedDirectly = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) {
  try { main(); } catch (error) { console.error(error.stack || error.message); process.exitCode = 1; }
}

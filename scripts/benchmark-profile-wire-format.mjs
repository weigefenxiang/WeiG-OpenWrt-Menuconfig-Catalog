#!/usr/bin/env node
// SPDX-FileCopyrightText: 2026 weigefenxiang <weigefenxiang@gmail.com>
// SPDX-License-Identifier: GPL-3.0-or-later

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { gunzipSync, gzipSync } from 'node:zlib';
import { performance } from 'node:perf_hooks';
import { configSemanticHash } from './profile-config-contract.mjs';

const PROFILE_FIELDS = Object.freeze([
  'target', 'board', 'subtarget', 'profile', 'name', 'selector', 'targetSelector',
  'semanticHash', 'symbolCount', 'delta',
]);
const META_KEYS = Object.freeze([
  'target', 'board', 'subtarget', 'profile', 'name', 'selector', 'targetSelector', 'semanticHash', 'symbols',
]);
const STATE_TO_CODE = Object.freeze({ n: 0, m: 1, y: 2 });
const CODE_TO_STATE = Object.freeze(['n', 'm', 'y']);

function median(values) {
  const rows = [...values].sort((a, b) => a - b);
  if (!rows.length) return 0;
  const middle = Math.floor(rows.length / 2);
  return rows.length % 2 ? rows[middle] : (rows[middle - 1] + rows[middle]) / 2;
}

function percentReduction(value, baseline) {
  return baseline > 0 ? Number(((1 - value / baseline) * 100).toFixed(2)) : 0;
}

function formatBytes(value) {
  const bytes = Number(value || 0);
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / 1024 ** 2).toFixed(2)} MiB`;
}

function profileRow(profile, delta = profile.delta) {
  return [
    profile.target || '', profile.board || '', profile.subtarget || '', profile.profile || '', profile.name || '',
    profile.selector || '', profile.targetSelector || '', profile.semanticHash || '', Number(profile.symbols || 0), delta,
  ];
}

function profileMetaFromRow(row) {
  return {
    target: row[0] || '', board: row[1] || '', subtarget: row[2] || '', profile: row[3] || '', name: row[4] || '',
    selector: row[5] || '', targetSelector: row[6] || '', semanticHash: row[7] || '', symbols: Number(row[8] || 0),
  };
}

function flattenPairs(pairs, encodeState = false) {
  const flat = [];
  for (const [index, value] of pairs || []) {
    flat.push(index, encodeState && Object.hasOwn(STATE_TO_CODE, value) ? STATE_TO_CODE[value] : value);
  }
  return flat;
}

function unflattenPairs(flat, decodeState = false) {
  const pairs = [];
  for (let offset = 0; offset < (flat || []).length; offset += 2) {
    let value = flat[offset + 1];
    if (decodeState && Number.isInteger(value) && value >= 0 && value < CODE_TO_STATE.length) value = CODE_TO_STATE[value];
    pairs.push([flat[offset], value]);
  }
  return pairs;
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
  for (let offset = 0; offset < (rows[3] || []).length; offset += 2) pairs.push([rows[3][offset], rows[3][offset + 1]]);
  return pairs;
}

function createStringPool() {
  const strings = [];
  const indexes = new Map();
  return {
    strings,
    id(value) {
      const text = String(value ?? '');
      if (!indexes.has(text)) {
        indexes.set(text, strings.length);
        strings.push(text);
      }
      return indexes.get(text);
    },
  };
}

function readableHeader(source, encoding, extra = {}) {
  return {
    schema: 2,
    kind: 'profile-baselines',
    encoding,
    generatedAt: source.generatedAt || '',
    source: source.source || {},
    ...extra,
  };
}

function rowView(payload, deltaDecoder = (value) => value, commonDecoder = (value) => value) {
  return {
    symbols: payload.symbols || [],
    common: () => commonDecoder(payload.common || []),
    count: () => (payload.profiles || []).length,
    profile(index) {
      const row = payload.profiles[index] || [];
      return { ...profileMetaFromRow(row), delta: deltaDecoder(row[9] || []) };
    },
  };
}

export const CANDIDATES = [
  {
    id: 'current', label: 'Current schema',
    encode: (source) => source,
    view: (payload) => ({ symbols: payload.symbols || [], common: () => payload.common || [], count: () => payload.profiles.length, profile: (index) => payload.profiles[index] }),
  },
  {
    id: 'short-keys', label: 'Two-letter-ish keys',
    encode(source) {
      return {
        sc: source.schema, kd: source.kind, en: source.encoding, ga: source.generatedAt,
        so: { i: source.source?.id || '', b: source.source?.branch || '', c: source.source?.commit || '' },
        sy: source.symbols || [], cm: source.common || [],
        pf: (source.profiles || []).map((profile) => ({
          t: profile.target || '', b: profile.board || '', s: profile.subtarget || '', p: profile.profile || '', n: profile.name || '',
          ps: profile.selector || '', ts: profile.targetSelector || '', h: profile.semanticHash || '', z: Number(profile.symbols || 0), d: profile.delta || [],
        })), mt: source.metrics || {},
      };
    },
    view(payload) {
      return {
        symbols: payload.sy || [], common: () => payload.cm || [], count: () => (payload.pf || []).length,
        profile(index) {
          const row = payload.pf[index] || {};
          return {
            target: row.t || '', board: row.b || '', subtarget: row.s || '', profile: row.p || '', name: row.n || '',
            selector: row.ps || '', targetSelector: row.ts || '', semanticHash: row.h || '', symbols: Number(row.z || 0), delta: row.d || [],
          };
        },
      };
    },
  },
  {
    id: 'rows', label: 'Fields + rows',
    encode(source) {
      return {
        ...readableHeader(source, 'profile-rows-v1', { profileFields: PROFILE_FIELDS }),
        symbols: source.symbols || [], common: source.common || [], profiles: source.profiles.map((profile) => profileRow(profile)), metrics: source.metrics || {},
      };
    },
    view: (payload) => rowView(payload),
  },
  {
    id: 'flat-delta', label: 'Rows + flat delta',
    encode(source) {
      return {
        ...readableHeader(source, 'profile-rows-flat-delta-v1', { profileFields: PROFILE_FIELDS, deltaFields: ['symbolIndex', 'value'] }),
        symbols: source.symbols || [], common: source.common || [],
        profiles: source.profiles.map((profile) => profileRow(profile, flattenPairs(profile.delta))), metrics: source.metrics || {},
      };
    },
    view: (payload) => rowView(payload, (value) => unflattenPairs(value)),
  },
  {
    id: 'integer-states', label: 'Flat delta + state codes',
    encode(source) {
      return {
        ...readableHeader(source, 'profile-rows-flat-state-code-v1', {
          profileFields: PROFILE_FIELDS, deltaFields: ['symbolIndex', 'valueOrStateCode'], stateCodes: ['n', 'm', 'y'],
        }), symbols: source.symbols || [], common: source.common || [],
        profiles: source.profiles.map((profile) => profileRow(profile, flattenPairs(profile.delta, true))), metrics: source.metrics || {},
      };
    },
    view: (payload) => rowView(payload, (value) => unflattenPairs(value, true)),
  },
  {
    id: 'grouped-delta', label: 'Grouped n/m/y delta',
    encode(source) {
      return {
        ...readableHeader(source, 'profile-rows-grouped-state-delta-v1', { profileFields: PROFILE_FIELDS, deltaFields: ['n', 'm', 'y', 'otherIndexValue'] }),
        symbols: source.symbols || [], common: source.common || [],
        profiles: source.profiles.map((profile) => profileRow(profile, groupPairs(profile.delta))), metrics: source.metrics || {},
      };
    },
    view: (payload) => rowView(payload, ungroupPairs),
  },
  {
    id: 'grouped-all', label: 'Grouped common + delta',
    encode(source) {
      return {
        ...readableHeader(source, 'profile-rows-grouped-state-all-v1', { profileFields: PROFILE_FIELDS, stateGroups: ['n', 'm', 'y', 'otherIndexValue'] }),
        symbols: source.symbols || [], common: groupPairs(source.common || []),
        profiles: source.profiles.map((profile) => profileRow(profile, groupPairs(profile.delta))), metrics: source.metrics || {},
      };
    },
    view: (payload) => rowView(payload, ungroupPairs, ungroupPairs),
  },
  {
    id: 'grouped-pool', label: 'Grouped states + profile string pool',
    encode(source) {
      const pool = createStringPool();
      const profiles = source.profiles.map((profile) => [
        pool.id(profile.target), pool.id(profile.board), pool.id(profile.subtarget), pool.id(profile.profile), pool.id(profile.name),
        pool.id(profile.selector), pool.id(profile.targetSelector), profile.semanticHash || '', Number(profile.symbols || 0), groupPairs(profile.delta),
      ]);
      return {
        ...readableHeader(source, 'profile-rows-grouped-state-pool-v1', {
          profileFields: PROFILE_FIELDS, profileStringFields: PROFILE_FIELDS.slice(0, 7), stateGroups: ['n', 'm', 'y', 'otherIndexValue'],
        }), symbols: source.symbols || [], profileStrings: pool.strings, common: groupPairs(source.common || []), profiles, metrics: source.metrics || {},
      };
    },
    view(payload) {
      const strings = payload.profileStrings || [];
      return {
        symbols: payload.symbols || [], common: () => ungroupPairs(payload.common || []), count: () => payload.profiles.length,
        profile(index) {
          const row = payload.profiles[index] || [];
          return {
            target: strings[row[0]] || '', board: strings[row[1]] || '', subtarget: strings[row[2]] || '', profile: strings[row[3]] || '',
            name: strings[row[4]] || '', selector: strings[row[5]] || '', targetSelector: strings[row[6]] || '', semanticHash: row[7] || '',
            symbols: Number(row[8] || 0), delta: ungroupPairs(row[9]),
          };
        },
      };
    },
  },
];

function assertEqual(left, right, message) {
  if (left !== right) throw new Error(`${message}: ${JSON.stringify(left)} != ${JSON.stringify(right)}`);
}

function comparePairs(expected, actual, label) {
  assertEqual(actual.length, expected.length, `${label} pair count`);
  const actualMap = new Map(actual);
  assertEqual(actualMap.size, expected.length, `${label} unique symbol indexes`);
  for (const [index, value] of expected) assertEqual(actualMap.get(index), value, `${label} symbol ${index}`);
}

export function validateView(source, view) {
  assertEqual(view.symbols.length, source.symbols.length, 'symbol count');
  for (let index = 0; index < source.symbols.length; index += 1) assertEqual(view.symbols[index], source.symbols[index], `symbol ${index}`);
  comparePairs(source.common || [], view.common(), 'common');
  assertEqual(view.count(), source.profiles.length, 'profile count');
  for (let index = 0; index < source.profiles.length; index += 1) {
    const expected = source.profiles[index];
    const actual = view.profile(index);
    for (const key of META_KEYS) assertEqual(actual[key], expected[key], `profile ${index} ${key}`);
    comparePairs(expected.delta || [], actual.delta || [], `profile ${index} delta`);
  }
}

function sampleIndexes(count) {
  if (!count) return [];
  return [...new Set([0, Math.floor((count - 1) / 4), Math.floor((count - 1) / 2), Math.floor(((count - 1) * 3) / 4), count - 1])];
}

export function verifySampleSemanticHashes(view) {
  const commonPairs = view.common();
  for (const profileIndex of sampleIndexes(view.count())) {
    const profile = view.profile(profileIndex);
    const values = new Map();
    for (const [index, value] of commonPairs) {
      const symbol = view.symbols[index];
      if (!symbol) throw new Error(`invalid common symbol index: ${index}`);
      values.set(symbol, value);
    }
    for (const [index, value] of profile.delta || []) {
      const symbol = view.symbols[index];
      if (!symbol) throw new Error(`invalid profile symbol index: ${index}`);
      values.set(symbol, value);
    }
    assertEqual(configSemanticHash(values), profile.semanticHash, `profile ${profileIndex} semantic hash`);
  }
}

function parseArgs(argv) {
  const args = { input: '', iterations: 3, json: false, help: false, measureJson: '', candidate: '' };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === '--json') args.json = true;
    else if (value === '--help' || value === '-h') args.help = true;
    else if (value === '--iterations') args.iterations = Math.max(1, Number.parseInt(argv[++index] || '3', 10) || 3);
    else if (value === '--candidate') args.candidate = argv[++index] || '';
    else if (value === '--measure-json') args.measureJson = argv[++index] || '';
    else if (!value.startsWith('-') && !args.input) args.input = value;
    else throw new Error(`unknown argument: ${value}`);
  }
  return args;
}

function runMeasureWorker(args) {
  const text = readFileSync(resolve(args.measureJson), 'utf8');
  const times = [];
  const postParse = [];
  const retained = [];
  const gc = typeof global.gc === 'function' ? global.gc : null;
  for (let run = 0; run < args.iterations; run += 1) {
    if (gc) gc();
    const before = process.memoryUsage().heapUsed;
    const started = performance.now();
    let parsed = JSON.parse(text);
    times.push(performance.now() - started);
    postParse.push(Math.max(0, process.memoryUsage().heapUsed - before));
    if (gc) gc();
    retained.push(Math.max(0, process.memoryUsage().heapUsed - before));
    if (!parsed || typeof parsed !== 'object') throw new Error('parsed payload must be an object');
    parsed = null;
    if (gc) gc();
  }
  process.stdout.write(JSON.stringify({
    parseMsMedian: Number(median(times).toFixed(2)), postParseHeapBytesMedian: Math.round(median(postParse)),
    retainedHeapBytesMedian: Math.round(median(retained)), gcAvailable: Boolean(gc),
  }));
}

function measureJson(jsonPath, iterations) {
  const result = spawnSync(process.execPath, ['--expose-gc', fileURLToPath(import.meta.url), '--measure-json', jsonPath, '--iterations', String(iterations)], {
    encoding: 'utf8', maxBuffer: 4 * 1024 * 1024,
  });
  if (result.status !== 0) throw new Error(`parse worker failed: ${result.stderr || result.stdout}`);
  return JSON.parse(result.stdout);
}

function help() {
  return [
    'Usage:',
    '  node --expose-gc scripts/benchmark-profile-wire-format.mjs <profiles.json.gz> [--iterations 3] [--candidate <id>] [--json]',
    '',
    'Benchmarks current, short-key, table/row, flat-delta, state-code, grouped-state, and profile-string-pool candidates.',
    'The input asset is read-only and is never rewritten.',
  ].join('\n');
}

function formatReport(report) {
  const lines = [
    `Profile wire-format benchmark: ${report.input}`,
    `Profiles: ${report.profiles} | Symbols: ${report.symbols} | Delta pairs: ${report.deltaPairs} | Iterations: ${report.iterations}`,
    '',
    'Candidate | Raw JSON | Raw reduction | gzip-9 | gzip reduction | JSON.parse median | Retained heap | Post-parse heap | Parity',
    '--- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---',
  ];
  for (const row of report.candidates) {
    lines.push([
      row.label, formatBytes(row.rawJsonBytes), `${row.rawReductionPercent.toFixed(2)}%`, formatBytes(row.gzipBytes),
      `${row.gzipReductionPercent.toFixed(2)}%`, `${row.parseMsMedian.toFixed(2)} ms`, formatBytes(row.retainedHeapBytesMedian),
      formatBytes(row.postParseHeapBytesMedian), row.semanticParity ? 'PASS' : 'FAIL',
    ].join(' | '));
  }
  return lines.join('\n');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.measureJson) return runMeasureWorker(args);
  if (args.help || !args.input) {
    console.log(help());
    if (!args.help && !args.input) process.exitCode = 2;
    return;
  }
  const input = resolve(args.input);
  const inputGzip = readFileSync(input);
  const sourceJson = gunzipSync(inputGzip).toString('utf8');
  const source = JSON.parse(sourceJson);
  if (source.kind !== 'profile-baselines' || !Array.isArray(source.symbols) || !Array.isArray(source.profiles)) {
    throw new Error('input must be a Catalog profile-baselines JSON gzip asset');
  }

  const temp = mkdtempSync(join(tmpdir(), 'weig-profile-wire-'));
  const results = [];
  try {
    const selectedCandidates = args.candidate ? CANDIDATES.filter((candidate) => candidate.id === args.candidate) : CANDIDATES;
    if (!selectedCandidates.length) throw new Error(`unknown candidate: ${args.candidate}`);
    for (const candidate of selectedCandidates) {
      const encodeStarted = performance.now();
      let payload = candidate.encode(source);
      const json = JSON.stringify(payload);
      const encodeMs = performance.now() - encodeStarted;
      const gzipBytes = gzipSync(Buffer.from(json), { level: 9 }).byteLength;
      const verifyStarted = performance.now();
      const view = candidate.view(payload);
      validateView(source, view);
      verifySampleSemanticHashes(view);
      const decodeVerifyMs = performance.now() - verifyStarted;
      const jsonPath = join(temp, `${candidate.id}.json`);
      writeFileSync(jsonPath, json);
      const parse = measureJson(jsonPath, args.iterations);
      results.push({
        id: candidate.id, label: candidate.label, rawJsonBytes: Buffer.byteLength(json), gzipBytes,
        encodeMs: Number(encodeMs.toFixed(2)), decodeVerifyMs: Number(decodeVerifyMs.toFixed(2)), semanticParity: true, ...parse,
      });
      payload = null;
      if (typeof global.gc === 'function') global.gc();
    }
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }

  const currentRawBytes = Buffer.byteLength(sourceJson);
  const currentGzipBytes = gzipSync(Buffer.from(sourceJson), { level: 9 }).byteLength;
  for (const row of results) {
    row.rawReductionPercent = percentReduction(row.rawJsonBytes, currentRawBytes);
    row.gzipReductionPercent = percentReduction(row.gzipBytes, currentGzipBytes);
  }
  const report = {
    schema: 1, input: basename(input), inputGzipBytes: inputGzip.byteLength, inputJsonBytes: Buffer.byteLength(sourceJson),
    profiles: source.profiles.length, symbols: source.symbols.length,
    deltaPairs: Number(source.metrics?.deltaPairs || source.profiles.reduce((sum, profile) => sum + (profile.delta?.length || 0), 0)),
    iterations: args.iterations, candidates: results,
  };
  console.log(args.json ? JSON.stringify(report, null, 2) : formatReport(report));
}

const invokedDirectly = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});

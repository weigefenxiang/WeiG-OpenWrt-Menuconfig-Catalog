#!/usr/bin/env node
// SPDX-FileCopyrightText: 2026 weigefenxiang <weigefenxiang@gmail.com>
// SPDX-License-Identifier: GPL-3.0-or-later

import { CANDIDATES, validateView, verifySampleSemanticHashes } from './benchmark-profile-wire-format.mjs';
import { configSemanticHash } from './profile-config-contract.mjs';

const symbols = ['A', 'B', 'C', 'TEXT', 'NUMBER'];
const common = [[0, 'y'], [1, 'n']];
function profile(id, delta) {
  const values = new Map(common.map(([index, value]) => [symbols[index], value]));
  for (const [index, value] of delta) values.set(symbols[index], value);
  return {
    target: 'x86/64', board: 'x86', subtarget: '64', profile: id, name: id,
    selector: `TARGET_x86_64_DEVICE_${id}`, targetSelector: 'TARGET_x86_64',
    semanticHash: configSemanticHash(values), symbols: values.size, delta,
  };
}
const source = {
  schema: 1,
  kind: 'profile-baselines',
  encoding: 'branch-common-plus-profile-delta-v1',
  generatedAt: '2026-08-15T00:00:00.000Z',
  source: { id: 'Fixture', branch: 'test', commit: 'fixture' },
  symbols,
  common,
  profiles: [
    profile('generic', [[2, 'y'], [3, '"hello"'], [4, '123']]),
    profile('minimal', [[2, 'm'], [3, '""'], [4, '0']]),
  ],
  metrics: { profiles: 2, dictionarySymbols: symbols.length, commonSymbols: common.length, deltaPairs: 6 },
};

for (const candidate of CANDIDATES) {
  const payload = candidate.encode(source);
  const view = candidate.view(payload);
  validateView(source, view);
  verifySampleSemanticHashes(view);
  const json = JSON.stringify(payload);
  if (!json.length) throw new Error(`${candidate.id}: empty JSON`);
}

console.log(`Profile wire-format benchmark candidates: ${CANDIDATES.length} PASS`);

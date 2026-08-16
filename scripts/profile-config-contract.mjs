#!/usr/bin/env node
// SPDX-FileCopyrightText: 2026 weigefenxiang <weigefenxiang@gmail.com>
// SPDX-License-Identifier: GPL-3.0-or-later
import { createHash } from 'node:crypto';
import { resolveTargetSelectors } from './lib.mjs';

export function buildProfileSeed(target, profile, selectors = resolveTargetSelectors(target, profile)) {
  const targetSelector = selectors.target || `TARGET_${target.board}${target.subtarget ? `_${target.subtarget}` : ''}`;
  const profileSelector = selectors.profile || `${targetSelector}_${profile.id}`;
  const boardSelector = selectors.board || `TARGET_${target.board}`;
  const parent = boardSelector && boardSelector !== targetSelector ? [`CONFIG_${boardSelector}=y`] : [];
  return [
    'CONFIG_HAVE_DOT_CONFIG=y',
    ...parent,
    `CONFIG_${targetSelector}=y`,
    `CONFIG_${profileSelector}=y`,
    '',
  ].join('\n');
}

export function parseConfigSymbols(text) {
  const values = new Map();
  for (const line of String(text || '').replace(/\r\n/g, '\n').split('\n')) {
    const enabled = line.match(/^CONFIG_([A-Za-z0-9_.+-]+)=(.*)$/);
    const disabled = line.match(/^# CONFIG_([A-Za-z0-9_.+-]+) is not set$/);
    const symbol = enabled?.[1] || disabled?.[1] || '';
    if (!symbol) continue;
    const value = enabled ? enabled[2] : 'n';
    if (values.has(symbol) && values.get(symbol) !== value) {
      throw new Error(`conflicting Kconfig value for ${symbol}: ${values.get(symbol)} != ${value}`);
    }
    values.set(symbol, value);
  }
  return values;
}

function configMap(input) {
  return input instanceof Map ? new Map(input) : parseConfigSymbols(input);
}

export function normalizeConfigSemantics(input) {
  const values = configMap(input);
  const lines = [...values]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([symbol, value]) => `CONFIG_${symbol}=${value}`);
  return lines.length ? `${lines.join('\n')}\n` : '';
}

export function configSemanticHash(input) {
  return createHash('sha256').update(normalizeConfigSemantics(input)).digest('hex');
}

export function compareConfigSemantics(leftInput, rightInput) {
  const left = configMap(leftInput);
  const right = configMap(rightInput);
  const symbols = [...new Set([...left.keys(), ...right.keys()])].sort();
  const differences = symbols.flatMap((symbol) => {
    const leftValue = left.has(symbol) ? left.get(symbol) : null;
    const rightValue = right.has(symbol) ? right.get(symbol) : null;
    return leftValue === rightValue ? [] : [{ symbol, left: leftValue, right: rightValue }];
  });
  return {
    equal: differences.length === 0,
    differences,
    leftSymbols: left.size,
    rightSymbols: right.size,
    leftHash: configSemanticHash(left),
    rightHash: configSemanticHash(right),
  };
}

export function validateProfileBaselineDocument(document, {
  sourceId = '', branch = '', commit = '', contract = null,
} = {}) {
  if (!document || typeof document !== 'object' || Array.isArray(document) ||
      document.kind !== 'profile-baselines' || Number(document.schema || 0) < 3 ||
      !String(document.encoding || '').trim() || !Array.isArray(document.symbols) ||
      !Array.isArray(document.common) || !Array.isArray(document.groups) ||
      !Array.isArray(document.profiles) || !document.identity || typeof document.identity !== 'object') {
    throw new Error('invalid Native Profile baseline document');
  }
  const source = document.source && typeof document.source === 'object' ? document.source : {};
  if (sourceId && String(source.id || '') !== String(sourceId)) {
    throw new Error(`Profile baseline source mismatch: ${source.id || '(missing)'} != ${sourceId}`);
  }
  if (branch && String(source.branch || '') !== String(branch)) {
    throw new Error(`Profile baseline branch mismatch: ${source.branch || '(missing)'} != ${branch}`);
  }
  if (commit && String(source.commit || '').toLowerCase() !== String(commit).toLowerCase()) {
    throw new Error(`Profile baseline commit mismatch: ${source.commit || '(missing)'} != ${commit}`);
  }
  if (!document.profiles.length || !document.groups.length) {
    throw new Error('Native Profile baseline has no Profile or Config Group rows');
  }
  if (Number(document.metrics?.reconstructionMismatches ?? -1) !== 0) {
    throw new Error('Native Profile baseline reconstruction parity is not clean');
  }
  if (contract && typeof contract === 'object') {
    if (Number(contract.schema || 0) !== Number(document.schema) ||
        String(contract.encoding || '') !== String(document.encoding || '') ||
        Number(contract.profiles || 0) !== document.profiles.length ||
        Number(contract.configGroups || 0) !== document.groups.length) {
      throw new Error('Native Profile baseline does not match its Catalog asset contract');
    }
  }
  return document;
}

#!/usr/bin/env node

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Exact UTF-8 JSON byte count for plain Catalog data, without a document-sized
 * string. Space has JSON.stringify's numeric indentation semantics. Shared
 * AST nodes may appear at different depths; cache by identity AND depth.
 * Undefined object fields are omitted and undefined array entries are null.
 */
export function measureJsonBytes(value, space = 0) {
  const gap = Math.min(10, Math.max(0, Math.trunc(Number(space) || 0)));
  // Bounded caches: a parsed artifact is mostly a tree, whereas in-memory
  // producer data can share ASTs. Never allocate a Map for every unique node.
  const cache = new Map();
  const strings = new Map();
  const scalarBytes = (node) => {
    if (typeof node === 'string' && strings.has(node)) return strings.get(node);
    const json = JSON.stringify(node);
    const bytes = json === undefined ? undefined : Buffer.byteLength(json);
    if (typeof node === 'string' && node.length <= 256 && strings.size < 8192) strings.set(node, bytes);
    return bytes;
  };
  const active = new Set();
  function count(node, depth) {
    if (node === null || typeof node !== 'object') {
      return scalarBytes(node);
    }
    if (active.has(node)) throw new TypeError('Circular Catalog JSON data');
    const cached = cache.get(node);
    if (cached?.depth === depth) return cached.bytes;
    const isArray = Array.isArray(node);
    const prototype = Object.getPrototypeOf(node);
    if (typeof node.toJSON === 'function' || (!isArray && prototype !== Object.prototype && prototype !== null)) {
      throw new TypeError('Catalog byte measurement requires plain JSON data');
    }
    active.add(node);
    let members = 0;
    let bytes = 2; // [] or {}
    const add = (childBytes, key) => {
      if (members++) bytes += 1; // comma
      if (gap) bytes += 1 + gap * (depth + 1); // newline + child indentation
      if (!isArray) bytes += scalarBytes(key) + 1 + (gap ? 1 : 0);
      bytes += childBytes;
    };
    if (isArray) {
      for (let index = 0; index < node.length; index++) add(count(node[index], depth + 1) ?? 4);
    } else {
      for (const key of Object.keys(node)) {
        const size = count(node[key], depth + 1);
        if (size !== undefined) add(size, key);
      }
    }
    if (gap && members) bytes += 1 + gap * depth; // closing newline + indentation
    active.delete(node);
    if (cache.size >= 8192) cache.delete(cache.keys().next().value);
    cache.set(node, { depth, bytes });
    return bytes;
  }
  return count(value, 0);
}

function percent(smaller, larger) {
  if (!Number.isFinite(smaller) || !Number.isFinite(larger) || larger <= 0) return null;
  return Number(((1 - smaller / larger) * 100).toFixed(1));
}

export function buildCatalogSizeReport(metaRows = []) {
  return metaRows.map((meta) => {
    const report = meta.sizeReport || {};
    const legacy = report.legacy || {};
    const split = report.split || {};
    return {
      source: meta.source?.id || '',
      branch: meta.source?.branch || '',
      commit: meta.source?.commit || meta.commit || '',
      legacyGzipBytes: Number(legacy.bytes || meta.bytes || 0),
      initialGzipBytes: Number(split.initialBytes || 0),
      allSplitGzipBytes: Number(split.bytes || 0),
      readableRelationsJsonBytes: Number(report.readableRelationsJsonBytes || 0),
      compactRelationsJsonBytes: Number(report.compactRelationsJsonBytes || 0),
      initialReductionPercent: percent(Number(split.initialBytes || 0), Number(legacy.bytes || meta.bytes || 0)),
      relationsReductionPercent: percent(
        Number(report.compactRelationsJsonBytes || 0),
        Number(report.readableRelationsJsonBytes || 0),
      ),
    };
  });
}

function formatBytes(value) {
  const bytes = Number(value || 0);
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / 1024 ** 2).toFixed(2)} MiB`;
}

export function formatCatalogSizeReport(rows) {
  const lines = [
    'Source/Branch | Legacy gzip | Initial core+graph | All split gzip | Readable relations | Compact relations | Initial reduction | Relations reduction',
    '--- | ---: | ---: | ---: | ---: | ---: | ---: | ---:',
  ];
  for (const row of rows) {
    lines.push([
      `${row.source}/${row.branch}`,
      formatBytes(row.legacyGzipBytes),
      formatBytes(row.initialGzipBytes),
      formatBytes(row.allSplitGzipBytes),
      formatBytes(row.readableRelationsJsonBytes),
      formatBytes(row.compactRelationsJsonBytes),
      row.initialReductionPercent === null ? '-' : `${row.initialReductionPercent}%`,
      row.relationsReductionPercent === null ? '-' : `${row.relationsReductionPercent}%`,
    ].join(' | '));
  }
  return lines.join('\n');
}

function loadMetaRows(directory) {
  if (!existsSync(directory)) throw new Error(`Catalog output directory does not exist: ${directory}`);
  const files = readdirSync(directory).filter((name) => name.endsWith('.meta.json')).sort();
  if (!files.length) throw new Error(`No *.meta.json files found in ${directory}`);
  return files.map((name) => JSON.parse(readFileSync(resolve(directory, name), 'utf8')));
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  const directory = resolve(process.argv[2] || 'dist');
  const rows = buildCatalogSizeReport(loadMetaRows(directory));
  if (process.argv.includes('--json')) console.log(JSON.stringify(rows, null, 2));
  else console.log(formatCatalogSizeReport(rows));
}

#!/usr/bin/env node

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

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

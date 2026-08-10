#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { synchronizeTranslationIndex } from './translation-index-assets.mjs';

const args = process.argv.slice(2);
const check = args.includes('--check');
const positionals = args.filter((value) => value !== '--check');
if (positionals.length > 1) throw new Error('usage: sync-translation-assets.mjs [index.json] [--check]');
const indexFile = resolve(positionals[0] || 'dist/index.json');
const index = JSON.parse(readFileSync(indexFile, 'utf8'));
const result = synchronizeTranslationIndex(index, dirname(indexFile), { check });
if (check && result.changed) {
  throw new Error(`translation asset contract check failed: ${result.mismatches.length} asset mismatch(es)`);
}
if (!check && result.changed) writeFileSync(indexFile, JSON.stringify(index, null, 2) + '\n');
console.log(`translation asset contract ${check ? 'checked' : 'synchronized'}: ${result.mismatches.length} update(s)`);

#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { translationSparsePaths } from './translation-index-assets.mjs';

const indexFile = resolve(process.argv[2] || 'dist/index.json');
const index = JSON.parse(readFileSync(indexFile, 'utf8'));
process.stdout.write(translationSparsePaths(index).join('\n') + '\n');

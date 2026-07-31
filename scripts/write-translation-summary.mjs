#!/usr/bin/env node
import { readFileSync } from 'node:fs';

const summary = JSON.parse(readFileSync(process.argv[2] || 'dist/translation-summary.json', 'utf8'));
console.log('## Translation progress');
console.log(`- Engine: \`${summary.provider}\` / model: \`${summary.model || '-'}\``);
console.log(`- Language: \`${summary.activeLanguage}\``);
console.log(`- Batch: \`${summary.batchNumber || 1}/${summary.batchCount || 1}\``);
console.log(`- This batch: \`${summary.translatedThisRun} / ${summary.queuedThisRun}\``);
console.log(`- Remaining descriptions: \`${summary.targetPendingAfter}\``);
if (summary.apiError) console.log(`- Warning: \`${summary.apiError.replace(/[`|\r\n]+/g, ' ')}\``);

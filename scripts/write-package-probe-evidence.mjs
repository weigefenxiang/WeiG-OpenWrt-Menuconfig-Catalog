#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';

const log = existsSync('probe.log') ? readFileSync('probe.log', 'utf8') : '';
const packages = String(process.env.PROBE_PACKAGES || '').split(',').filter(Boolean);
const conflicts = [...log.matchAll(/trying to overwrite\s+([^\s,]+).*?owned by\s+([^\s,]+)/gi)]
  .map((match) => ({ path: match[1], owner: match[2] }));
const errors = log.split(/\r?\n/).filter((line) => /(?:error:|failed|no rule to make target)/i.test(line)).slice(-100);
const evidence = {
  schema: 1,
  probeId: process.env.PROBE_ID || '',
  generatedAt: new Date().toISOString(),
  source: process.env.PROBE_SOURCE || '',
  repo: process.env.PROBE_REPO || '',
  branch: process.env.PROBE_BRANCH || '',
  mode: process.env.PROBE_MODE || '',
  packages,
  conclusion: process.env.PROBE_CONCLUSION || 'unknown',
  conflicts,
  errors,
  run: `run:${process.env.GITHUB_RUN_ID || ''}`,
  runUrl: `${process.env.GITHUB_SERVER_URL || ''}/${process.env.GITHUB_REPOSITORY || ''}/actions/runs/${process.env.GITHUB_RUN_ID || ''}`,
};
mkdirSync('probe-evidence', { recursive: true });
writeFileSync('probe-evidence/evidence.json', JSON.stringify(evidence, null, 2) + '\n');
writeFileSync('probe-evidence/SUMMARY.txt', [
  `Package probe ${evidence.probeId}`,
  `Source/Branch: ${evidence.source}/${evidence.branch}`,
  `Mode: ${evidence.mode}`,
  `Packages: ${packages.join(', ')}`,
  `Conclusion: ${evidence.conclusion}`,
  `Conflicts: ${conflicts.length}`,
  `Run: ${evidence.runUrl}`,
].join('\n') + '\n');

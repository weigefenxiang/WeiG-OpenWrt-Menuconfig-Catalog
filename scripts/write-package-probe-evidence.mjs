#!/usr/bin/env node
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const packageName = (value) => String(value || '').replace(/-[0-9][A-Za-z0-9.+:~_-]*$/, '');

export function parseProbeLog(log) {
  const text = String(log || '');
  const issues = [];
  for (const match of text.matchAll(/(?:ERROR:\s+)?([^\s:]+?)(?:-[0-9][^:\s]*)?:\s+trying to overwrite\s+([^\s,]+)\s+owned by\s+([^\s,.]+)/gi)) {
    issues.push({
      type: 'file-ownership',
      package: packageName(match[1]),
      path: `/${String(match[2]).replace(/^\/+/, '')}`,
      owner: packageName(match[3]),
      manager: 'apk',
    });
  }
  for (const match of text.matchAll(/Package\s+([^\s]+)\s+wants to install file\s+([^\s]+).*?already provided by package\s+([^\s.]+)/gis)) {
    issues.push({
      type: 'file-ownership', package: packageName(match[1]), path: match[2],
      owner: packageName(match[3]), manager: 'opkg',
    });
  }
  for (const match of text.matchAll(/ERROR:\s+(package\/[A-Za-z0-9_./+@-]+)\s+failed to build/gi)) {
    issues.push({ type: 'build-failure', target: match[1] });
  }
  for (const match of text.matchAll(/(?:WARNING|ERROR):\s+Makefile ['"]?([^'"\s]+)['"]? has a dependency on ['"]?([^'"\s,]+)[,'"]? which does not exist/gi)) {
    issues.push({ type: 'missing-dependency', makefile: match[1], dependency: match[2] });
  }
  if (/No rule to make target/i.test(text)) issues.push({ type: 'missing-target' });
  if (/requested package states did not survive make defconfig/i.test(text)) issues.push({ type: 'kconfig-unresolved' });
  const unique = new Map(issues.map((row) => [JSON.stringify(row), row]));
  return [...unique.values()];
}

export function requestedPackageStates(config, packages) {
  const text = String(config || '');
  return Object.fromEntries(packages.map((name) => {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const enabled = text.match(new RegExp(`^CONFIG_PACKAGE_${escaped}=([my])$`, 'm'))?.[1];
    const disabled = new RegExp(`^# CONFIG_PACKAGE_${escaped} is not set$`, 'm').test(text);
    return [name, enabled || (disabled ? 'n' : 'missing')];
  }));
}

export function createEvidence({ log, config = '', env = {} }) {
  const packages = String(env.PROBE_PACKAGES || '').split(',').map((row) => row.trim()).filter(Boolean);
  const errors = String(log || '').split(/\r?\n/)
    .filter((line) => /(?:error:|failed|no rule to make target|does not exist)/i.test(line)).slice(-100);
  return {
    schema: 2,
    generatedAt: new Date().toISOString(),
    source: env.PROBE_SOURCE || '',
    repo: env.PROBE_REPO || '',
    branch: env.PROBE_BRANCH || '',
    upstreamCommit: env.PROBE_UPSTREAM_COMMIT || '',
    target: env.PROBE_TARGET || '',
    profile: env.PROBE_PROFILE || '',
    mode: env.PROBE_MODE || '',
    packages,
    packageStates: requestedPackageStates(config, packages),
    conclusion: env.PROBE_CONCLUSION || 'unknown',
    issues: parseProbeLog(log),
    errors,
    run: `run:${env.GITHUB_RUN_ID || ''}`,
    runUrl: `${env.GITHUB_SERVER_URL || ''}/${env.GITHUB_REPOSITORY || ''}/actions/runs/${env.GITHUB_RUN_ID || ''}`,
  };
}

function summaryLines(evidence) {
  const issueRows = evidence.issues.length
    ? evidence.issues.map((row) => `- \`${row.type}\`: ${row.path || row.target || row.dependency || 'detected'}`)
    : ['- No normalized compatibility issue was detected.'];
  return [
    '## Package compatibility probe evidence',
    '',
    `- Source/Branch: \`${evidence.source}/${evidence.branch}\``,
    `- Upstream commit: \`${evidence.upstreamCommit || 'unknown'}\``,
    `- Probe Target/Profile: \`${evidence.target}/${evidence.profile || '-'}\``,
    `- Mode: \`${evidence.mode}\``,
    `- Packages: ${evidence.packages.map((row) => `\`${row}\``).join(', ')}`,
    `- Final states: ${Object.entries(evidence.packageStates).map(([name, state]) => `\`${name}=${state}\``).join(', ')}`,
    `- Conclusion: **${evidence.conclusion}**`,
    `- Run: ${evidence.runUrl}`,
    '',
    '### Normalized issues',
    '',
    ...issueRows,
    '',
  ];
}

export function main(env = process.env) {
  const log = existsSync('probe.log') ? readFileSync('probe.log', 'utf8') : '';
  const configPath = env.PROBE_CONFIG || 'work/upstream/.config';
  const config = existsSync(configPath) ? readFileSync(configPath, 'utf8') : '';
  const evidence = createEvidence({ log, config, env });
  mkdirSync('probe-evidence', { recursive: true });
  writeFileSync('probe-evidence/evidence.json', JSON.stringify(evidence, null, 2) + '\n');
  writeFileSync('probe-evidence/SUMMARY.md', summaryLines(evidence).join('\n'));
  if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, summaryLines(evidence).join('\n'));
  return evidence;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();

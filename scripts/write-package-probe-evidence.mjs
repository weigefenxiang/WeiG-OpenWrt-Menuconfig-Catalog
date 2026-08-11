#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, resolve } from 'node:path';

const packageName = (value) => String(value || '').replace(/-[0-9][A-Za-z0-9.+:~_-]*$/, '');

export function parseProbeLog(log) {
  const text = String(log || '');
  const issues = [];
  for (const match of text.matchAll(/(?:ERROR:\s+)?([^\s:]+?)(?:-[0-9][^:\s]*)?:\s+trying to overwrite\s+([^\s,]+)\s+owned by\s+([^\s,.]+)/gi)) {
    issues.push({ type: 'rootfs-conflict', package: packageName(match[1]),
      path: `/${String(match[2]).replace(/^\/+/, '')}`, owner: packageName(match[3]), manager: 'apk' });
  }
  for (const match of text.matchAll(/Package\s+([^\s]+)\s+wants to install file\s+([^\s]+).*?already provided by package\s+([^\s.]+)/gis)) {
    issues.push({ type: 'rootfs-conflict', package: packageName(match[1]), path: match[2],
      owner: packageName(match[3]), manager: 'opkg' });
  }
  for (const match of text.matchAll(/ERROR:\s+(package\/[A-Za-z0-9_./+@-]+)\s+failed to build/gi)) {
    issues.push({ type: 'package-build-failure', target: match[1] });
  }
  for (const match of text.matchAll(/ERROR:\s+package compile failed:\s+([A-Za-z0-9_.+@-]+)/gi)) {
    issues.push({ type: 'package-build-failure', target: match[1] });
  }
  if (/ERROR:\s+RootFS integration failed after package compilation/i.test(text)) {
    issues.push({ type: 'rootfs-integration-failure' });
  }
  if (/ERROR:\s+package-enabled firmware failed after baseline success/i.test(text)) {
    issues.push({ type: 'package-firmware-failure' });
  }
  for (const match of text.matchAll(/(?:WARNING|ERROR):\s+Makefile ['"]?([^'"\s]+)['"]? has a dependency on ['"]?([^'"\s,]+)[,'"]? which does not exist/gi)) {
    issues.push({ type: 'missing-dependency', makefile: match[1], dependency: match[2] });
  }
  if (/No rule to make target/i.test(text)) issues.push({ type: 'missing-target' });
  if (/requested package states did not survive make defconfig/i.test(text)) issues.push({ type: 'kconfig-unsatisfied' });
  if (/No space left on device/i.test(text)) issues.push({ type: 'infrastructure-failure', reason: 'disk-full' });
  if (/timed?\s*out|timeout:/i.test(text)) issues.push({ type: 'timeout' });
  if (/Hash check failed|download failed|Connection timed out|Could not resolve host/i.test(text)) {
    issues.push({ type: 'package-download-failure' });
  }
  if (/not enough space|image is too big|filesystem.*too large/i.test(text)) issues.push({ type: 'image-too-large' });
  if (/Boot smoke did not reach/i.test(text)) issues.push({ type: 'boot-failure' });
  return [...new Map(issues.map((row) => [JSON.stringify(row), row])).values()];
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

function normalizedErrors(log) {
  return String(log || '').split(/\r?\n/)
    .filter((line) => /(?:error:|failed|no rule to make target|does not exist|no space left|timed?\s*out)/i.test(line))
    .map((line) => line.replace(/\b[0-9a-f]{40}\b/gi, '<commit>').replace(/\b\d+(?:\.\d+){1,3}\b/g, '<version>').trim())
    .filter(Boolean).slice(-100);
}

function evidenceFingerprint(issues, errors) {
  const canonical = JSON.stringify({ issues, errors: errors.slice(-20) });
  return createHash('sha256').update(canonical).digest('hex');
}

function inferConclusion(runtime, issues, fallback) {
  if (runtime?.conclusion) {
    if (issues.some((row) => row.type === 'timeout')) return 'inconclusive';
    if (issues.some((row) => row.type === 'infrastructure-failure' || row.type === 'package-download-failure')) {
      return 'infrastructure-failure';
    }
    if (runtime.conclusion === 'fully-incompatible' && runtime.attempts?.some((row) =>
      ['environment', 'environmentReset', 'baselineKconfig', 'baselineFirmware']
        .some((stage) => row.stages?.[stage] === 'failure'))) {
      return 'inconclusive';
    }
    return runtime.conclusion;
  }
  return fallback === 'success' ? 'sampled-compatible' : 'inconclusive';
}

export function createEvidence({ log, config = '', runtime = null, env = {} }) {
  const packages = String(env.PROBE_PACKAGES || '').split(',').map((row) => row.trim()).filter(Boolean);
  const errors = normalizedErrors(log);
  const issues = parseProbeLog(log);
  const conclusion = inferConclusion(runtime, issues, env.PROBE_CONCLUSION || 'unknown');
  return {
    schema: 3,
    generatedAt: new Date().toISOString(), source: env.PROBE_SOURCE || '', repo: env.PROBE_REPO || '',
    branch: env.PROBE_BRANCH || '', upstreamCommit: env.PROBE_UPSTREAM_COMMIT || '',
    target: env.PROBE_TARGET || '', profile: env.PROBE_PROFILE || '', mode: env.PROBE_MODE || '',
    evidenceLevel: Number(env.PROBE_EVIDENCE_LEVEL || 0), packages,
    packageStates: runtime?.attempts?.find((attempt) => Object.keys(attempt.packageStates || {}).length)?.packageStates ||
      requestedPackageStates(config, packages), conclusion,
    coverage: runtime ? { requested: runtime.requestedCoverage, planned: runtime.plannedCoverage,
      attempted: runtime.attempts?.length || 0, complete: Boolean(runtime.coverageComplete) } : null,
    attempts: runtime?.attempts || [], reduction: runtime?.reduction || null,
    issues, errors, fingerprint: evidenceFingerprint(issues, errors),
    run: `run:${env.GITHUB_RUN_ID || ''}`,
    runUrl: `${env.GITHUB_SERVER_URL || ''}/${env.GITHUB_REPOSITORY || ''}/actions/runs/${env.GITHUB_RUN_ID || ''}`,
  };
}

function issueText(issue) {
  return issue.path || issue.target || issue.dependency || issue.reason || issue.type;
}

export function evidenceSummaryLines(evidence) {
  const serialRecoveries = (evidence.attempts || []).flatMap((attempt) =>
    (attempt.serialRetries || []).filter((retry) => retry.result === 'recovered').map((retry) => retry.label));
  const issueRows = evidence.issues.length
    ? evidence.issues.map((row) => `- \`${row.type}\`: ${issueText(row)}`)
    : ['- No normalized issue detected / 未检测到规范化问题'];
  return [
    '## Package compatibility probe evidence / 软件包兼容探针证据', '',
    `- Source/Branch / 源码分支: \`${evidence.source}/${evidence.branch}\``,
    `- Upstream commit / 上游提交: \`${evidence.upstreamCommit || 'unknown'}\``,
    `- Target/Profile: \`${evidence.target}/${evidence.profile || '-'}\``,
    `- Mode / 探测方式: \`${evidence.mode}\``,
    `- Evidence level / 证据等级: L${evidence.evidenceLevel}`,
    `- Packages / 软件包: ${evidence.packages.map((row) => `\`${row}\``).join(', ')}`,
    `- Final states / 最终状态: ${Object.entries(evidence.packageStates).map(([name, state]) => `\`${name}=${state}\``).join(', ')}`,
    `- Conclusion / 结论: **${evidence.conclusion}**`,
    ...(serialRecoveries.length
      ? [`- Serial recovery / 串行复核恢复: ${[...new Set(serialRecoveries)].map((row) => `\`${row}\``).join(', ')}`]
      : []),
    `- Fingerprint / 错误指纹: \`${evidence.fingerprint.slice(0, 16)}\``,
    ...(evidence.reduction?.candidateMinimalFailureSet?.length
      ? [`- Bounded reduction candidate / 有限缩减候选: ${evidence.reduction.candidateMinimalFailureSet.map((row) => `\`${row}\``).join(', ')} (${evidence.reduction.attempts.length}/${evidence.reduction.budget})`]
      : []),
    `- Run / 运行: ${evidence.runUrl}`, '',
    '### Normalized issues / 规范化问题', '', ...issueRows, '',
  ];
}

function evidenceFiles(directory) {
  if (!existsSync(directory)) return [];
  const rows = [];
  for (const name of readdirSync(directory)) {
    const file = join(directory, name);
    if (statSync(file).isDirectory()) rows.push(...evidenceFiles(file));
    else if (name === 'evidence.json') rows.push(file);
  }
  return rows;
}

const PACKAGE_FAILURE_TYPES = new Set([
  'rootfs-conflict', 'package-build-failure', 'missing-dependency', 'missing-target',
  'kconfig-unsatisfied', 'rootfs-integration-failure', 'package-firmware-failure', 'image-too-large',
]);

function packageCausedFailure(row) {
  return (row.attempts || []).length > 0 && (row.attempts || []).every((attempt) => attempt.result === 'failure') &&
    (row.issues || []).some((issue) => PACKAGE_FAILURE_TYPES.has(issue.type)) &&
    !(row.issues || []).some((issue) => ['infrastructure-failure', 'timeout', 'package-download-failure', 'boot-failure'].includes(issue.type)) &&
    !(row.attempts || []).some((attempt) => attempt.stages?.baselineFirmware === 'failure');
}

export function aggregateScopeConclusions(evidence) {
  const scopes = new Map();
  for (const row of evidence) {
    const key = [row.source, row.branch, row.mode, ...(row.packages || [])].join('\0');
    const scope = scopes.get(key) || {
      source: row.source, branch: row.branch, mode: row.mode, packages: row.packages || [],
      expected: 0, attempted: 0, successes: 0, failures: 0, packageFailures: 0, rows: 0,
    };
    scope.rows++;
    scope.expected = Math.max(scope.expected, Number(row.coverage?.requested || 1));
    const attempts = (row.attempts || []).length || Number(row.coverage?.attempted || 0);
    scope.attempted += attempts;
    scope.successes += (row.attempts || []).filter((attempt) => attempt.result === 'success').length;
    scope.failures += (row.attempts || []).filter((attempt) => attempt.result === 'failure').length;
    if (packageCausedFailure(row)) scope.packageFailures += attempts;
    scopes.set(key, scope);
  }
  return [...scopes.values()].map((scope) => {
    const complete = scope.expected > 0 && scope.attempted >= scope.expected;
    let conclusion = 'inconclusive';
    if (scope.successes > 0) conclusion = complete
      ? (scope.failures > 0 ? 'partially-compatible' : 'fully-compatible')
      : 'sampled-compatible';
    else if (complete && scope.failures === scope.attempted && scope.packageFailures === scope.attempted) {
      conclusion = 'fully-incompatible';
    } else if (scope.attempted > 0 && scope.packageFailures === scope.attempted) conclusion = 'sampled-incompatible';
    return { ...scope, complete, conclusion };
  }).sort((left, right) => `${left.source}/${left.branch}`.localeCompare(`${right.source}/${right.branch}`));
}

export function aggregateEvidence(directory, env = {}) {
  const evidence = evidenceFiles(directory).map((file) => JSON.parse(readFileSync(file, 'utf8')))
    .sort((left, right) => `${left.source}/${left.branch}/${left.target}`.localeCompare(`${right.source}/${right.branch}/${right.target}`));
  const grouped = new Map();
  for (const row of evidence) {
    if (!row.issues?.length) continue;
    const group = grouped.get(row.fingerprint) || { fingerprint: row.fingerprint, issues: row.issues, environments: [] };
    group.environments.push(`${row.source}/${row.branch}/${row.target}`);
    grouped.set(row.fingerprint, group);
  }
  const scopes = aggregateScopeConclusions(evidence);
  const lines = ['## Package compatibility probe result / 软件包兼容探针结果', '',
    `- Catalog channel / Catalog 通道: \`${env.DATA_BRANCH || 'unknown'}\``,
    `- Planned jobs / 计划任务: ${env.PLAN_COUNT || evidence.length}`,
    `- Collected evidence / 已收集证据: ${evidence.length}`,
    `- Plan / 计划: \`${env.PLAN_RESULT || 'unknown'}\``,
    `- Matrix / 矩阵: \`${env.PROBE_RESULT || 'unknown'}\``,
    `- Run / 运行: ${env.GITHUB_SERVER_URL || ''}/${env.GITHUB_REPOSITORY || ''}/actions/runs/${env.GITHUB_RUN_ID || ''}`, ''];
  if (!evidence.length) {
    lines.push('> Plan only; no compilation was executed, so no compatibility conclusion or build log is available. / 仅生成计划；未执行编译，因此没有兼容性结论或构建日志。', '');
  } else {
    lines.push('### Source/Branch coverage conclusion / 源码分支覆盖结论', '',
      '| Source/Branch | Packages / 软件包 | Coverage / 覆盖 | Conclusion / 结论 |',
      '|---|---|---:|---|',
      ...scopes.map((scope) => `| ${scope.source}/${scope.branch} | ${scope.packages.map((row) => `\`${row}\``).join(', ')} | ${scope.attempted}/${scope.expected} | **${scope.conclusion}** |`), '');
    lines.push('| Source/Branch | Target/Profile | Mode / 模式 | Conclusion / 结论 | Issues / 问题 |',
      '|---|---|---|---|---|',
      ...evidence.map((row) => `| ${row.source}/${row.branch} | ${row.target}/${row.profile || '-'} | ${row.mode} | **${row.conclusion}** | ${(row.issues || []).map(issueText).join('<br>') || '-'} |`), '');
    if (grouped.size) {
      lines.push('### Grouped issue fingerprints / 同类问题指纹', '');
      for (const group of grouped.values()) lines.push(
        `<details><summary><code>${group.fingerprint.slice(0, 16)}</code> · ${group.environments.length} environment(s) / 个环境</summary>`, '',
        `- Issues / 问题: ${group.issues.map((row) => `\`${row.type}: ${issueText(row)}\``).join(', ')}`,
        `- Environments / 环境: ${group.environments.map((row) => `\`${row}\``).join(', ')}`, '', '</details>', '');
    }
  }
  return { evidence, groups: [...grouped.values()], scopes, lines };
}

export function main(env = process.env) {
  if (process.argv[2] === '--aggregate') {
    const directory = resolve(process.argv[3] || 'collected-evidence');
    const aggregate = aggregateEvidence(directory, env);
    mkdirSync('probe-diagnostics', { recursive: true });
    writeFileSync('probe-diagnostics/FINAL_SUMMARY.md', aggregate.lines.join('\n') + '\n');
    writeFileSync('probe-diagnostics/results.json', JSON.stringify({ schema: 1, generatedAt: new Date().toISOString(),
      evidence: aggregate.evidence, groups: aggregate.groups, scopes: aggregate.scopes }, null, 2) + '\n');
    if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, aggregate.lines.join('\n') + '\n');
    return aggregate;
  }
  const log = existsSync('probe.log') ? readFileSync('probe.log', 'utf8') : '';
  const configPath = env.PROBE_CONFIG || 'work/upstream/.config';
  const config = existsSync(configPath) ? readFileSync(configPath, 'utf8') : '';
  const runtime = existsSync('probe-runtime.json') ? JSON.parse(readFileSync('probe-runtime.json', 'utf8')) : null;
  const evidence = createEvidence({ log, config, runtime, env });
  mkdirSync('probe-evidence', { recursive: true });
  writeFileSync('probe-evidence/evidence.json', JSON.stringify(evidence, null, 2) + '\n');
  writeFileSync('probe-evidence/SUMMARY.md', evidenceSummaryLines(evidence).join('\n'));
  if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, evidenceSummaryLines(evidence).join('\n'));
  return evidence;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();

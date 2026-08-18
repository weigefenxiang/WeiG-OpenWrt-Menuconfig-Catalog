#!/usr/bin/env node
// SPDX-FileCopyrightText: 2026 weigefenxiang <weigefenxiang@gmail.com>
// SPDX-License-Identifier: GPL-3.0-or-later
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, resolve } from 'node:path';

const packageName = (value) => String(value || '').replace(/-[0-9][A-Za-z0-9.+:~_-]*$/, '');

export function parseProbeLog(log) {
  const text = String(log || '');
  const issues = [];
  for (const match of text.matchAll(/(?:ERROR:\s+)?([^\s:]+?)(?:-[0-9][^:\s]*)?:\s+trying to overwrite\s+([^\s,]+)\s+owned by\s+([^\s,.]+)/gi)) {
    issues.push({ type: 'rootfs-conflict', package: packageName(match[1]), path: `/${String(match[2]).replace(/^\/+/, '')}`,
      owner: packageName(match[3]), manager: 'apk' });
  }
  for (const match of text.matchAll(/Package\s+([^\s]+)\s+wants to install file\s+([^\s]+).*?already provided by package\s+([^\s.]+)/gis)) {
    issues.push({ type: 'rootfs-conflict', package: packageName(match[1]), path: match[2], owner: packageName(match[3]), manager: 'opkg' });
  }
  for (const match of text.matchAll(/ERROR:\s+(package\/[A-Za-z0-9_./+@-]+)\s+failed to build/gi)) {
    issues.push({ type: 'package-build-failure', target: match[1] });
  }
  if (/ERROR:\s+package compile failed for Probe roots:/i.test(text)) issues.push({ type: 'package-build-failure' });
  if (/ERROR:\s+RootFS integration failed after Probe-root compilation/i.test(text)) issues.push({ type: 'rootfs-integration-failure' });
  if (/ERROR:\s+Final package-enabled firmware failed after Baseline success/i.test(text)) issues.push({ type: 'package-firmware-failure' });
  for (const match of text.matchAll(/(?:WARNING|ERROR):\s+Makefile ['"]?([^'"\s]+)['"]? has a dependency on ['"]?([^'"\s,]+)[,'"]? which does not exist/gi)) {
    issues.push({ type: 'missing-dependency', makefile: match[1], dependency: match[2] });
  }
  if (/No rule to make target/i.test(text)) issues.push({ type: 'missing-target' });
  if (/directly selected Probe roots did not survive/i.test(text)) issues.push({ type: 'kconfig-unsatisfied' });
  if (/upstream package metadata does not contain Probe root|ambiguous upstream Source-Makefile|tmp\/\.packageinfo is missing/i.test(text)) {
    issues.push({ type: 'metadata-unresolved' });
  }
  if (/baseline firmware failed|baseline-kconfig-failure/i.test(text)) issues.push({ type: 'baseline-failure' });
  if (/No space left on device/i.test(text)) issues.push({ type: 'infrastructure-failure', reason: 'disk-full' });
  if (/(?:^|[\s:])(?:timed?\s*out|timeout:)/i.test(text)) issues.push({ type: 'timeout' });
  if (/Hash check failed|download failed|Connection timed out|Could not resolve host/i.test(text)) issues.push({ type: 'package-download-failure' });
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
  return createHash('sha256').update(JSON.stringify({ issues, errors: errors.slice(-20) })).digest('hex');
}

function normalizedRuntimeConclusion(runtime, issues, fallback) {
  if (issues.some((row) => ['timeout', 'infrastructure-failure', 'package-download-failure', 'metadata-unresolved', 'baseline-failure'].includes(row.type))) {
    return 'inconclusive';
  }
  if (['compatible', 'incompatible', 'inconclusive', 'skipped'].includes(runtime?.conclusion)) return runtime.conclusion;
  return fallback === 'success' ? 'compatible' : 'inconclusive';
}

export function createEvidence({ log, config = '', runtime = null, env = {}, attempt: selectedAttempt = null }) {
  const roots = String(env.PROBE_ROOTS || '').split(',').map((row) => row.trim()).filter(Boolean);
  const attempt = selectedAttempt || runtime?.attempts?.[0] || {};
  const errors = normalizedErrors(log);
  const issues = parseProbeLog(log);
  if (['root-absent-source', 'root-not-applicable'].includes(attempt.reason)) {
    issues.push({ type: 'not-applicable', roots: attempt.unavailableRoots || [] });
  } else if (attempt.reason === 'root-combination-rejected') {
    issues.push({ type: 'kconfig-combination-rejected', roots: attempt.rejectedRoots || [] });
  }
  const runtimeView = selectedAttempt ? { ...runtime, conclusion: attempt.result, reason: attempt.reason, attempts: [attempt] } : runtime;
  const conclusion = normalizedRuntimeConclusion(runtimeView, issues, env.PROBE_CONCLUSION || 'unknown');
  return {
    schema: 5,
    generatedAt: new Date().toISOString(),
    source: attempt.source || env.PROBE_SOURCE || runtime?.environment?.source || '', repo: env.PROBE_REPO || '',
    branch: attempt.branch || env.PROBE_BRANCH || runtime?.environment?.branch || '', upstreamCommit: env.PROBE_UPSTREAM_COMMIT || '',
    targetSystem: attempt.targetSystem || env.PROBE_TARGET_SYSTEM || runtime?.environment?.targetSystem || '',
    subtarget: attempt.subtarget || env.PROBE_SUBTARGET || runtime?.environment?.subtarget || '',
    target: attempt.target || env.PROBE_TARGET || runtime?.environment?.target || '',
    profile: attempt.profile || env.PROBE_PROFILE || runtime?.environment?.profile || '',
    profileLabel: attempt.profileLabel || env.PROBE_PROFILE_LABEL || '', mode: env.PROBE_MODE || runtime?.mode || '',
    evidenceLevel: Number(env.PROBE_EVIDENCE_LEVEL || 0), useDefconfig: runtime?.useDefconfig ?? String(env.PROBE_USE_DEFCONFIG || 'true') !== 'false',
    roots: runtime?.roots || roots, rootMappings: attempt.rootMappings || [], rootTargets: attempt.rootTargets || [],
    baselinePackageCount: Number(runtime?.baselinePackageCount || env.PROBE_BASELINE_PACKAGE_COUNT || 0),
    finalPackageCount: Number(runtime?.finalPackageCount || env.PROBE_FINAL_PACKAGE_COUNT || 0),
    rootStates: attempt.rootStates || requestedPackageStates(config, runtime?.roots || roots),
    unavailableRoots: attempt.unavailableRoots || [], rejectedRoots: attempt.rejectedRoots || [], reason: attempt.reason || runtime?.reason || '',
    conclusion,
    coverage: {
      mode: String(env.PROBE_COVERAGE_MODE || 'auto'), total: Number(env.PROBE_COVERAGE_TOTAL || 1), planned: Number(env.PROBE_COVERAGE_PLANNED || 1),
      sampled: String(env.PROBE_COVERAGE_SAMPLED || 'false') === 'true', batchIndex: Number(env.PROBE_BATCH_INDEX || 0), batchCount: Number(env.PROBE_BATCH_COUNT || 1),
    },
    attempts: [attempt], issues: [...new Map(issues.map((row) => [JSON.stringify(row), row])).values()], errors,
    fingerprint: evidenceFingerprint(issues, errors),
    run: `run:${env.GITHUB_RUN_ID || ''}`,
    runUrl: `${env.GITHUB_SERVER_URL || ''}/${env.GITHUB_REPOSITORY || ''}/actions/runs/${env.GITHUB_RUN_ID || ''}`,
  };
}

function issueText(issue) { return issue.path || issue.target || issue.dependency || issue.reason || (issue.roots || []).join(', ') || issue.type; }

export function evidenceSummaryLines(evidence) {
  const serialRecoveries = evidence.attempts.flatMap((attempt) => (attempt.serialRetries || []).filter((row) => row.result === 'recovered').map((row) => row.label));
  return [
    '## Package compatibility probe evidence / 软件包兼容探针证据', '',
    `- Source/Branch / 源码分支: \`${evidence.source}/${evidence.branch}\``,
    `- Target / 目标: \`${evidence.targetSystem || '-'}/${evidence.subtarget || '-'}/${evidence.profile || '-'}\``,
    `- Upstream commit / 上游提交: \`${evidence.upstreamCommit || 'unknown'}\``,
    `- Mode / 探测方式: \`${evidence.mode}\` (L${evidence.evidenceLevel})`,
    `- Defconfig: \`${evidence.useDefconfig ? 'on' : 'off'}\``,
    `- Probe roots / 测试入口: ${evidence.roots.map((row) => `\`${row}\``).join(', ') || '-'}`,
    ...(evidence.mode === 'config-resolve' ? [] : [`- Baseline / Final packages: ${evidence.baselinePackageCount} / ${evidence.finalPackageCount}`]),
    `- Conclusion / 结论: **${evidence.conclusion}**`,
    ...(serialRecoveries.length ? [`- Serial recovery / 串行复核恢复: ${[...new Set(serialRecoveries)].map((row) => `\`${row}\``).join(', ')}`] : []),
    `- Fingerprint / 错误指纹: \`${evidence.fingerprint.slice(0, 16)}\``,
    `- Run / 运行: ${evidence.runUrl}`, '', '### Normalized issues / 规范化问题', '',
    ...(evidence.issues.length ? evidence.issues.map((row) => `- \`${row.type}\`: ${issueText(row)}`) : ['- No normalized issue detected / 未检测到规范化问题']), '',
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

function environmentKey(row, depth = 5) {
  return [row.source, row.branch, row.targetSystem, row.subtarget, row.profile].slice(0, depth).join('/');
}

function conclusionStats(rows) {
  const compatible = rows.filter((row) => row.conclusion === 'compatible').length;
  const incompatible = rows.filter((row) => row.conclusion === 'incompatible').length;
  const skipped = rows.filter((row) => row.conclusion === 'skipped').length;
  const inconclusive = rows.filter((row) => row.conclusion === 'inconclusive').length;
  const conclusive = compatible + incompatible;
  return { attempted: rows.length, compatible, incompatible, skipped, inconclusive, conclusive,
    compatibilityRate: conclusive ? compatible / conclusive : null };
}

function conclusionForRows(rows, exhaustive) {
  const { compatible, incompatible, inconclusive } = conclusionStats(rows);
  if (!compatible && !incompatible) return 'inconclusive';
  if (compatible && incompatible) return 'partially-compatible';
  if (inconclusive) return 'inconclusive';
  if (compatible) return exhaustive ? 'fully-compatible' : 'sampled-compatible';
  return exhaustive ? 'fully-incompatible' : 'sampled-incompatible';
}

export function aggregateScopeConclusions(evidence, options = {}) {
  const depth = Number(options.depth || 2);
  const groups = new Map();
  for (const row of evidence) {
    const key = environmentKey(row, depth);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  return [...groups.entries()].map(([path, rows]) => ({
    path, source: rows[0]?.source || '', branch: depth >= 2 ? rows[0]?.branch || '' : '',
    ...conclusionStats(rows), conclusion: conclusionForRows(rows, options.exhaustive === true), roots: rows[0]?.roots || [],
  })).sort((a, b) => a.path.localeCompare(b.path, undefined, { numeric: true }));
}

function formatCompatibilityRate(scope) {
  return scope.compatibilityRate === null ? '—' : `${Math.round(scope.compatibilityRate * 100)}%`;
}

function compactScopeConclusions(evidence, exhaustive) {
  const sources = aggregateScopeConclusions(evidence, { depth: 1, exhaustive });
  const branches = aggregateScopeConclusions(evidence, { depth: 2, exhaustive });
  const rows = [];
  for (const source of sources) {
    const sourceBranches = branches.filter((row) => row.source === source.source);
    const uniformConclusive = source.inconclusive === 0 && (
      (source.compatible > 0 && source.incompatible === 0) ||
      (source.incompatible > 0 && source.compatible === 0)
    );
    if (uniformConclusive || source.conclusive === 0) rows.push({ ...source, branch: '' });
    else rows.push(...sourceBranches);
  }
  return rows.sort((a, b) => `${a.source}/${a.branch}`.localeCompare(`${b.source}/${b.branch}`, undefined, { numeric: true }));
}

function optionalBoolean(value) {
  if (value === true || String(value).toLowerCase() === 'true') return true;
  if (value === false || String(value).toLowerCase() === 'false') return false;
  return null;
}

export function aggregateRunStatus(env = {}, evidenceCount = 0) {
  const planResult = String(env.PLAN_RESULT || 'unknown').toLowerCase();
  const probeResult = String(env.PROBE_RESULT || 'unknown').toLowerCase();
  const authorized = optionalBoolean(env.AUTHORIZED);
  const relevant = optionalBoolean(env.RELEVANT);
  const requestedPlanOnly = optionalBoolean(env.REQUESTED_PLAN_ONLY);
  const plannedExecute = optionalBoolean(env.EXECUTE);
  const execute = plannedExecute ?? (requestedPlanOnly === null ? null : !requestedPlanOnly);
  if (planResult !== 'success') return { state: 'plan-failure', planResult, probeResult, execute };
  if (relevant === false) return { state: 'not-relevant', planResult, probeResult, execute: false };
  if (authorized === false) return { state: 'authorization-denied', planResult, probeResult, execute: false };
  if (execute === false) return { state: 'plan-only', planResult, probeResult, execute };
  if (execute === true) {
    if (probeResult === 'success') return { state: evidenceCount ? 'execution-success' : 'execution-evidence-missing', planResult, probeResult, execute };
    if (['failure', 'cancelled'].includes(probeResult)) return { state: evidenceCount ? 'execution-collected-with-failures' : 'execution-failure', planResult, probeResult, execute };
    if (probeResult === 'skipped') return { state: 'execution-skipped', planResult, probeResult, execute };
    return { state: 'execution-incomplete', planResult, probeResult, execute };
  }
  return evidenceCount ? { state: 'execution-incomplete', planResult, probeResult, execute } : { state: 'unresolved', planResult, probeResult, execute };
}

function noEvidenceLines(status) {
  const messages = {
    'plan-failure': 'Probe planning failed before Matrix creation; no compilation was executed. / 探针计划在创建 Matrix 前失败；未执行编译。',
    'plan-only': 'Plan only; no compilation was requested, so no compatibility conclusion is available. / 仅生成计划；未请求编译，因此没有兼容性结论。',
    'authorization-denied': 'Probe authorization was denied; no compilation was executed. / 探针授权未通过；未执行编译。',
    'execution-failure': 'Compilation was requested, but no normalized evidence was collected. / 已请求编译，但没有收集到规范化证据。',
  };
  return [`> ${messages[status.state] || 'No conclusive normalized evidence is available. / 没有可用的明确规范化证据。'}`, ''];
}

export function aggregateEvidence(directory, env = {}) {
  const evidence = evidenceFiles(directory).map((file) => JSON.parse(readFileSync(file, 'utf8')))
    .sort((a, b) => environmentKey(a).localeCompare(environmentKey(b), undefined, { numeric: true }));
  const grouped = new Map();
  for (const row of evidence) {
    if (!row.issues?.length) continue;
    const group = grouped.get(row.fingerprint) || { fingerprint: row.fingerprint, issues: row.issues, environments: [] };
    group.environments.push(environmentKey(row)); grouped.set(row.fingerprint, group);
  }
  const exhaustive = Number(env.BATCH_COUNT || 1) === 1 && String(env.COVERAGE_SAMPLED || 'false') !== 'true' &&
    Number(env.COVERAGE_PLANNED || evidence.length) === Number(env.COVERAGE_TOTAL || evidence.length);
  const scopes = aggregateScopeConclusions(evidence, { depth: 2, exhaustive });
  const summaryScopes = compactScopeConclusions(evidence, exhaustive);
  const overallStats = conclusionStats(evidence);
  const overallConclusion = conclusionForRows(evidence, exhaustive);
  const runStatus = aggregateRunStatus(env, evidence.length);
  const lines = ['## Package compatibility probe result / 软件包兼容探针结果', '',
    `- Observed compatibility / 已测兼容率: **${formatCompatibilityRate(overallStats)}** (${overallStats.compatible}/${overallStats.conclusive} conclusive / 明确结果)`,
    `- Skipped / 跳过: ${overallStats.skipped}`,
    `- Inconclusive / 未定: ${overallStats.inconclusive}`,
    `- Catalog channel / Catalog 通道: \`${env.DATA_BRANCH || 'unknown'}\``,
    `- Coverage / 覆盖: ${env.COVERAGE_PLANNED || evidence.length}/${env.COVERAGE_TOTAL || evidence.length}${exhaustive ? ' (complete)' : ' (sampled)'}`,
    `- Batch / 批次: ${Number(env.BATCH_INDEX || 0) + 1}/${env.BATCH_COUNT || 1}`,
    `- Collected evidence / 已收集证据: ${evidence.length}`,
    `- Conclusion / 结论: **${evidence.length ? overallConclusion : 'inconclusive'}**`,
    `- Run state / 运行状态: **${runStatus.state}**`,
    `- Run / 运行: ${env.GITHUB_SERVER_URL || ''}/${env.GITHUB_REPOSITORY || ''}/actions/runs/${env.GITHUB_RUN_ID || ''}`, ''];
  if (!evidence.length) lines.push(...noEvidenceLines(runStatus));
  else {
    lines.push('### Source/Branch compatibility / 源码分支兼容率', '',
      '| Source | Branch | Observed compatibility / 已测兼容率 | Compatible / Conclusive | Skipped / 跳过 | Inconclusive / 未定 |',
      '|---|---|---:|---:|---:|---:|',
      ...summaryScopes.map((scope) => `| ${scope.source || '-'} | ${scope.branch || '—'} | **${formatCompatibilityRate(scope)}** | ${scope.compatible}/${scope.conclusive} | ${scope.skipped} | ${scope.inconclusive} |`), '',
      '<details>', `<summary>Environment details / 环境明细 (${evidence.length})</summary>`, '',
      '| Source/Branch | Target System/Subtarget/Profile | Conclusion / 结论 | Issues / 问题 |', '|---|---|---|---|',
      ...evidence.map((row) => `| ${row.source}/${row.branch} | ${row.targetSystem || '-'}/${row.subtarget || '-'}/${row.profile || '-'} | **${row.conclusion}** | ${(row.issues || []).map(issueText).join('<br>') || '-'} |`), '',
      '</details>', '');
  }
  return { evidence, groups: [...grouped.values()], scopes, summaryScopes, overallStats,
    overallConclusion: evidence.length ? overallConclusion : 'inconclusive', runStatus, lines };
}

export function main(env = process.env) {
  if (process.argv[2] === '--aggregate') {
    const directory = resolve(process.argv[3] || 'collected-evidence');
    const aggregate = aggregateEvidence(directory, env);
    mkdirSync('probe-diagnostics', { recursive: true });
    writeFileSync('probe-diagnostics/FINAL_SUMMARY.md', aggregate.lines.join('\n') + '\n');
    writeFileSync('probe-diagnostics/results.json', JSON.stringify({ schema: 2, generatedAt: new Date().toISOString(),
      runStatus: aggregate.runStatus, overallConclusion: aggregate.overallConclusion, overallStats: aggregate.overallStats,
      evidence: aggregate.evidence, groups: aggregate.groups, scopes: aggregate.scopes, summaryScopes: aggregate.summaryScopes }, null, 2) + '\n');
    if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, aggregate.lines.join('\n') + '\n');
    return aggregate;
  }
  const log = existsSync('probe.log') ? readFileSync('probe.log', 'utf8') : '';
  const configPath = env.PROBE_CONFIG || 'work/upstream/.config';
  const config = existsSync(configPath) ? readFileSync(configPath, 'utf8') : '';
  const runtime = existsSync('probe-runtime.json') ? JSON.parse(readFileSync('probe-runtime.json', 'utf8')) : null;
  mkdirSync('probe-evidence', { recursive: true });
  if (runtime?.mode === 'config-resolve' && Array.isArray(runtime.attempts)) {
    const evidence = runtime.attempts.map((attempt, index) => createEvidence({ log, config, runtime, env, attempt }));
    evidence.forEach((row, index) => {
      const directory = join('probe-evidence', String(index + 1).padStart(3, '0'));
      mkdirSync(directory, { recursive: true });
      writeFileSync(join(directory, 'evidence.json'), JSON.stringify(row, null, 2) + '\n');
    });
    const stats = conclusionStats(evidence);
    const lines = [
      '## Package compatibility probe evidence / 软件包兼容探针证据', '',
      `- Source/Branch / 源码分支: \`${env.PROBE_SOURCE || runtime?.environment?.source || ''}/${env.PROBE_BRANCH || runtime?.environment?.branch || ''}\``,
      `- Mode / 探测方式: \`config-resolve\` (L1)`,
      `- Environments / 环境: ${evidence.length}`,
      `- Compatible / 通过: ${stats.compatible}`,
      `- Skipped / 跳过: ${stats.skipped}`,
      `- Incompatible / 冲突: ${stats.incompatible}`,
      `- Inconclusive / 未定: ${stats.inconclusive}`, '',
    ];
    writeFileSync('probe-evidence/SUMMARY.md', lines.join('\n'));
    if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, lines.join('\n'));
    return evidence;
  }
  const evidence = createEvidence({ log, config, runtime, env });
  writeFileSync('probe-evidence/evidence.json', JSON.stringify(evidence, null, 2) + '\n');
  writeFileSync('probe-evidence/SUMMARY.md', evidenceSummaryLines(evidence).join('\n'));
  if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, evidenceSummaryLines(evidence).join('\n'));
  return evidence;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();

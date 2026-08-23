#!/usr/bin/env node
// SPDX-FileCopyrightText: 2026 weigefenxiang <weigefenxiang@gmail.com>
// SPDX-License-Identifier: GPL-3.0-or-later
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, resolve } from 'node:path';
import { classifyTargetPrerequisiteFailure, isAllowedTargetPrerequisiteCause, isMemoryExhaustion, isReportedInconclusive } from './package-probe-failure-classification.mjs';

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
  if (/(?:FAIL|ERROR):\s+package compile failed for Probe roots:/i.test(text)) issues.push({ type: 'package-build-failure' });
  if (/(?:FAIL|ERROR):\s+RootFS integration failed after Probe-root compilation/i.test(text)) issues.push({ type: 'rootfs-integration-failure' });
  if (/(?:FAIL|ERROR):\s+Final package-enabled firmware failed/i.test(text)) issues.push({ type: 'package-firmware-failure' });
  for (const match of text.matchAll(/(?:WARNING|ERROR):\s+Makefile ['"]?([^'"\s]+)['"]? has a dependency on ['"]?([^'"\s,]+)[,'"]? which does not exist/gi)) {
    issues.push({ type: 'missing-dependency', makefile: match[1], dependency: match[2] });
  }
  if (/No rule to make target/i.test(text)) issues.push({ type: 'missing-target' });
  if (/direct(?:ly selected)? Probe (?:roots|intent) did not survive/i.test(text)) issues.push({ type: 'kconfig-unsatisfied' });
  if (/upstream package metadata does not contain Probe root|ambiguous upstream Source-Makefile|tmp\/\.packageinfo is missing/i.test(text)) {
    issues.push({ type: 'metadata-unresolved' });
  }
  if (/Prerequisite check failed|Build dependency:\s+Please install (?:the GNU C(?:\+\+)? Compiler|Python 2\.x)|Please install Python 2\.x/i.test(text)) {
    issues.push({ type: 'infrastructure-failure', reason: 'host-prerequisite' });
  }
  if (/No space left on device/i.test(text)) issues.push({ type: 'infrastructure-failure', reason: 'disk-full' });
  if (isMemoryExhaustion(text)) issues.push({ type: 'infrastructure-failure', reason: 'memory-exhausted' });
  if (/(?:^|[\s:])(?:timed\s*out|timeout:)/i.test(text)) issues.push({ type: 'timeout' });
  if (/Hash check failed|download failed|Connection timed out|Could not resolve host|RPC failed|HTTP\s+(?:429|5\d\d)|returned error:\s*(?:429|5\d\d)|expected ['"]?packfile|early EOF|Connection reset|TLS.*(?:error|failed)|GnuTLS.*error|SSL.*(?:error|failed)/i.test(text)) issues.push({ type: 'package-download-failure' });
  if (/not enough space|image is too big|filesystem.*too large/i.test(text)) issues.push({ type: 'image-too-large' });
  if (/final-boot-failed|Kernel panic|not syncing/i.test(text)) issues.push({ type: 'boot-failure' });
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
    .filter((line) => /(?:error:|failed|no rule to make target|does not exist|no space left|timed\s*out|timeout:)/i.test(line))
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
  if (['compatible', 'incompatible', 'blocked', 'inconclusive', 'unresolved', 'skipped'].includes(runtime?.conclusion)) {
    return runtime.conclusion === 'unresolved' ? 'inconclusive' : runtime.conclusion;
  }
  return fallback === 'success' ? 'compatible' : 'inconclusive';
}

const STRUCTURED_INFRASTRUCTURE_REASONS = new Set([
  'package-compile-infrastructure', 'rootfs-package-infrastructure',
  'rootfs-install-infrastructure', 'firmware-build-infrastructure',
  'runner-infrastructure', 'target-prerequisite-infrastructure',
]);

const STRUCTURED_PACKAGE_FAILURE_REASONS = new Set([
  'package-compile-prerequisite-failure', 'package-compile-unattributed-failure',
  'rootfs-package-prerequisite-failure', 'rootfs-package-unattributed-failure',
  'rootfs-install-prerequisite-failure', 'rootfs-install-unattributed-failure',
  'firmware-prerequisite-failure', 'firmware-unattributed-failure',
]);

function appendStructuredAttemptIssue(issues, attempt) {
  const reason = String(attempt?.reason || '');
  if (STRUCTURED_INFRASTRUCTURE_REASONS.has(reason)) {
    issues.push({ type: 'infrastructure-failure', reason });
  } else if (reason === 'target-prerequisite-failure') {
    issues.push({ type: 'target-prerequisite-failure', reason,
      ...(attempt?.targetPrerequisiteCause ? { cause: attempt.targetPrerequisiteCause } : {}),
      ...(attempt?.errorSummary ? { errorSummary: attempt.errorSummary } : {}),
      ...(attempt?.failedBuildTargets?.length ? { targets: attempt.failedBuildTargets } : {}) });
  } else if (STRUCTURED_PACKAGE_FAILURE_REASONS.has(reason)) {
    issues.push({ type: 'package-build-failure', reason,
      ...(attempt?.prerequisiteCause ? { cause: attempt.prerequisiteCause } : {}),
      ...(attempt?.errorSummary ? { errorSummary: attempt.errorSummary } : {}),
      ...(attempt?.failedBuildTargets?.length ? { targets: attempt.failedBuildTargets } : {}) });
  }
}

// A blocked result is a complete domain conclusion: the selected plugin was
// not evaluated because the Base Profile or another shared upstream target
// was already known to be broken.  Keep the evidence structured so the
// finalizer can distinguish this from an unresolved/runner failure.
function appendBlockedAttemptIssue(issues, attempt) {
  if (String(attempt?.result || '') !== 'blocked' &&
      !String(attempt?.reason || '').startsWith('base-profile-') &&
      String(attempt?.reason || '') !== 'baseline-failure') return;
  issues.push({ type: 'base-profile-failure', reason: attempt?.reason || 'base-profile-failure', pluginEvaluated: false,
    ...(attempt?.cause ? { cause: attempt.cause } : {}),
    ...(attempt?.targetPrerequisiteCause ? { cause: attempt.targetPrerequisiteCause } : {}),
    ...(attempt?.prerequisiteCause ? { cause: attempt.prerequisiteCause } : {}),
    ...(attempt?.errorSummary ? { errorSummary: attempt.errorSummary } : {}),
    ...(attempt?.failedBuildTargets?.length ? { targets: attempt.failedBuildTargets } : {}) });
}

export function createEvidence({ log, config = '', runtime = null, env = {}, attempt: selectedAttempt = null }) {
  const roots = String(env.PROBE_ROOTS || '').split(',').map((row) => row.trim()).filter(Boolean);
  const attempt = selectedAttempt || runtime?.attempts?.[0] || {};
  const runtimeComparison = runtime?.comparison;
  const pairedComparison = runtime?.pairedComparison === true ||
    runtimeComparison?.mode === 'paired-exclusion' || Boolean(attempt.pairConclusion);
  const attemptResult = attempt.result === 'unresolved' ? 'inconclusive' :
    ['compatible', 'incompatible', 'blocked', 'inconclusive', 'skipped'].includes(attempt.result) ? attempt.result : '';
  // Once the runner emitted a structured attempt result/reason, the shared
  // log is only a transport artifact.  In particular, a later phase's
  // earlyoom/watchdog line must not downgrade an already authoritative A
  // incompatibility.  Logs are consulted only for legacy/no-attempt evidence.
  const structuredAttempt = Boolean(attemptResult || attempt.pairConclusion);
  const sharedLogIsRelevant = !structuredAttempt;
  const errors = sharedLogIsRelevant ? normalizedErrors(log) : [];
  const issues = sharedLogIsRelevant ? parseProbeLog(log) : [];
  let targetPrerequisiteCause = '';
  let prerequisiteCause = String(attempt.prerequisiteCause || '');
  let errorSummary = String(attempt.errorSummary || '');
  let terminalError = String(attempt.terminalError || errorSummary || '');
  const recoverableErrors = Array.isArray(attempt.recoverableErrors) ? [...attempt.recoverableErrors] : [];
  let failedBuildTargets = Array.isArray(attempt.failedBuildTargets) ? attempt.failedBuildTargets : [];
  const bootstrapOutcome = String(env.PROBE_BOOTSTRAP_OUTCOME || '').toLowerCase();
  const cloneOutcome = String(env.PROBE_CLONE_OUTCOME || '').toLowerCase();
  const runtimeRequirementsOutcome = String(env.PROBE_RUNTIME_REQUIREMENTS_OUTCOME || '').toLowerCase();
  const pythonSetupOutcome = String(env.PROBE_PYTHON_SETUP_OUTCOME || '').toLowerCase();
  const runtimeSetupOutcome = String(env.PROBE_RUNTIME_SETUP_OUTCOME || '').toLowerCase();
  const feedsOutcome = String(env.PROBE_FEEDS_OUTCOME || '').toLowerCase();
  if (bootstrapOutcome === 'failure') {
    issues.push({ type: 'infrastructure-failure', reason: 'dependency-bootstrap' });
  }
  if (cloneOutcome === 'failure') {
    issues.push({ type: 'infrastructure-failure', reason: 'source-clone' });
  }
  if (runtimeRequirementsOutcome === 'failure') {
    issues.push({ type: 'infrastructure-failure', reason: 'runtime-detection' });
  }
  if (pythonSetupOutcome === 'failure') {
    issues.push({ type: 'infrastructure-failure', reason: 'python-setup' });
  }
  if (runtimeSetupOutcome === 'failure') {
    issues.push({ type: 'infrastructure-failure', reason: 'runtime-setup', runtime: String(env.PROBE_RUNTIME_KIND || '') });
  }
  if (feedsOutcome === 'failure') {
    const reason = String(env.PROBE_FEEDS_FAILURE_REASON || '').trim() ||
      (/(?:RPC failed|HTTP\s+(?:429|5\d\d)|returned error:\s*(?:429|5\d\d)|expected ['"]?packfile|early EOF|Connection (?:timed out|reset)|Could not resolve host|TLS.*(?:error|failed)|GnuTLS.*error|SSL.*(?:error|failed))/i.test(String(log || ''))
        ? 'feed-network' : 'feed-stage');
    issues.push({ type: 'infrastructure-failure', reason, feed: String(env.PROBE_FEEDS_FAILURE_FEED || '') });
  }
  if (attempt.reason === 'package-unavailable') {
    issues.push({ type: 'package-unavailable', roots: attempt.unavailableRoots || [] });
  } else if (attempt.reason === 'kconfig-unsatisfied') {
    issues.push({ type: 'kconfig-unsatisfied', roots: attempt.rejectedRoots || [] });
  } else if (['root-absent-source', 'root-not-applicable'].includes(attempt.reason)) {
    issues.push({ type: 'not-applicable', roots: attempt.unavailableRoots || [] });
  } else if (attempt.reason === 'root-combination-rejected') {
    issues.push({ type: 'kconfig-combination-rejected', roots: attempt.rejectedRoots || [] });
  } else if (attempt.reason === 'metadata-unresolved' || attempt.preflightReason === 'metadata-unresolved' ||
    attempt.preflight?.reason === 'metadata-unresolved') {
    const errorSummary = String(attempt.errorSummary || attempt.preflight?.errorSummary || '').trim();
    issues.push({ type: 'metadata-unresolved', reason: 'metadata-unresolved', phase: 'preflight',
      ...(errorSummary ? { errorSummary } : {}) });
  } else if (['virtual-boot-unsupported', 'runtime-control-unavailable', 'reboot-control-unavailable'].includes(attempt.reason)) {
    issues.push({ type: 'capability-unavailable', reason: attempt.reason });
  } else if (['virtual-runner-infrastructure', 'runner-infrastructure'].includes(attempt.reason)) {
    issues.push({ type: 'infrastructure-failure', reason: attempt.reason });
  } else if (attempt.reason === 'target-prerequisite-failure') {
    const logClassification = classifyTargetPrerequisiteFailure(log);
    const cause = isAllowedTargetPrerequisiteCause(attempt.targetPrerequisiteCause)
      ? attempt.targetPrerequisiteCause
      : logClassification.reason === 'target-prerequisite-failure' ? logClassification.cause : '';
    targetPrerequisiteCause = cause;
    errorSummary = errorSummary || attempt.errorSummary || logClassification.errorSummary || '';
    terminalError = terminalError || errorSummary;
    failedBuildTargets = failedBuildTargets.length ? failedBuildTargets : logClassification.failedBuildTargets || [];
    issues.push({ type: 'target-prerequisite-failure', reason: attempt.reason,
      ...(cause ? { cause } : {}), ...(errorSummary ? { errorSummary } : {}),
      ...(failedBuildTargets.length ? { targets: failedBuildTargets } : {}) });
  } else if (attempt.reason === 'target-prerequisite-infrastructure') {
    issues.push({ type: 'infrastructure-failure', reason: attempt.reason });
  } else if (attempt.reason === 'runner-infrastructure') {
    issues.push({ type: 'infrastructure-failure', reason: attempt.reason });
  } else if (attempt.pairConclusion === 'baseline-failure') {
    issues.push({ type: 'baseline-failure', reason: attempt.baseline?.reason || attempt.reason || 'baseline-failure' });
    appendBlockedAttemptIssue(issues, attempt.baseline);
    appendStructuredAttemptIssue(issues, attempt.baseline);
    appendStructuredAttemptIssue(issues, attempt.final);
  } else if (['final-boot-failed', 'final-runtime-failed', 'final-reboot-failed', 'final-reboot-health-failed'].includes(attempt.reason)) {
    issues.push({ type: 'virtual-probe-failure', reason: attempt.reason });
  }
  if (['package-compile-failure', 'rootfs-package-compile-failure', 'final-firmware-failure'].includes(attempt.reason)) {
    issues.push({ type: 'package-build-failure', reason: attempt.reason, ...(attempt.packageCauseKind ? { cause: attempt.packageCauseKind } : {}),
      ...(attempt.failedBuildTargets?.length ? { targets: attempt.failedBuildTargets } : {}) });
  }
  if (attempt.reason === 'rootfs-conflict') {
    issues.push({ type: 'rootfs-integration-failure', reason: attempt.reason, ...(attempt.packageCauseKind ? { cause: attempt.packageCauseKind } : {}) });
  }
  appendBlockedAttemptIssue(issues, attempt);
  appendStructuredAttemptIssue(issues, attempt);
  let normalizedIssues = [...new Map(issues.map((row) => [JSON.stringify(row), row])).values()];
  if (attempt.reason === 'package-unavailable') {
    normalizedIssues = normalizedIssues.filter((row) => row.type !== 'kconfig-unsatisfied');
  }
  const runtimeView = selectedAttempt ? { ...runtime, conclusion: attempt.result, reason: attempt.reason, attempts: [attempt] } : runtime;
  const stageFailed = bootstrapOutcome === 'failure' || cloneOutcome === 'failure' || runtimeRequirementsOutcome === 'failure' ||
    pythonSetupOutcome === 'failure' || runtimeSetupOutcome === 'failure' || feedsOutcome === 'failure';
  const conclusion = stageFailed
    ? 'inconclusive'
    : selectedAttempt && attemptResult
      ? attemptResult
      : normalizedRuntimeConclusion(runtimeView, normalizedIssues, env.PROBE_CONCLUSION || 'unknown');
  const selectedLevel = Number(attempt.selectedLevel || runtime?.selectedLevel || env.PROBE_EVIDENCE_LEVEL || 0);
  const deepestPassedLevel = Number(attempt.deepestPassedLevel || (attemptResult === 'compatible' ? selectedLevel : 0));
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
    phase: attempt.phase || (pairedComparison ? 'paired' : 'final'),
    evidenceLevel: Number(env.PROBE_EVIDENCE_LEVEL || 0), useDefconfig: runtime?.useDefconfig ?? String(env.PROBE_USE_DEFCONFIG || 'true') !== 'false',
    roots: runtime?.roots || roots, rootMappings: attempt.rootMappings || [], rootTargets: attempt.rootTargets || [],
    requestedPackageCount: Number(runtime?.requestedPackageCount || roots.length),
    resolvedPackageCount: Number(attempt.resolvedPackageCount || 0),
    hostRuntime: {
      kind: String(env.PROBE_RUNTIME_KIND || ''), version: String(env.PROBE_RUNTIME_VERSION || ''),
      compiler: String(env.PROBE_COMPILER_KIND || ''),
    },
    rootStates: attempt.rootStates || requestedPackageStates(config, runtime?.roots || roots),
    unavailableRoots: attempt.unavailableRoots || [], rejectedRoots: attempt.rejectedRoots || [], reason: attempt.reason || runtime?.reason || '',
    targetPrerequisiteCause,
    prerequisiteCause,
    errorSummary,
    terminalError: terminalError || errorSummary,
    recoverableErrors,
    comparison: pairedComparison ? (runtimeComparison || { mode: 'paired-exclusion', executionOrder: ['baseline', 'final'] }) : null,
    pairedComparison,
    pairId: attempt.pairId || '',
    pairConclusion: attempt.pairConclusion || '',
    packageCauseKind: attempt.packageCauseKind || '',
    preflight: attempt.preflight || null,
    preflightResult: attempt.preflightResult || '',
    preflightReason: attempt.preflightReason || '',
    baseline: attempt.baseline || null,
    final: attempt.final || null,
    baselineConfigHash: attempt.baselineConfigHash || '',
    finalConfigHash: attempt.finalConfigHash || '',
    configHash: attempt.configHash || '',
    resolvedConfigDiff: attempt.resolvedConfigDiff || attempt.configDiff || {},
    addedDependencies: attempt.addedDependencies || attempt.newDependencyPackages || [],
    newDependencyTargets: attempt.newDependencyTargets || [],
    failedBuildTargets,
    failureFingerprint: attempt.failureFingerprint || '',
    selectedLevel,
    deepestPassedLevel,
    runtimeCovered: attempt.runtimeCovered ?? null,
    durationMs: Number(attempt.durationMs || runtime?.durationMs || 0),
    stages: attempt.stages || {},
    conclusion,
    // `conclusion` is the established evidence field; `result` is an
    // additive alias for consumers that use the runner's result vocabulary.
    result: conclusion,
    coverage: {
      mode: String(env.PROBE_COVERAGE_MODE || 'auto'), total: Number(env.PROBE_COVERAGE_TOTAL || 1), planned: Number(env.PROBE_COVERAGE_PLANNED || 1),
      sampled: String(env.PROBE_COVERAGE_SAMPLED || 'false') === 'true', batchIndex: Number(env.PROBE_BATCH_INDEX || 0), batchCount: Number(env.PROBE_BATCH_COUNT || 1),
    },
    attempts: [attempt], issues: normalizedIssues, errors,
    fingerprint: evidenceFingerprint(normalizedIssues, errors),
    run: `run:${env.GITHUB_RUN_ID || ''}`,
    runUrl: `${env.GITHUB_SERVER_URL || ''}/${env.GITHUB_REPOSITORY || ''}/actions/runs/${env.GITHUB_RUN_ID || ''}`,
  };
}

function issueText(issue) {
  const detail = [issue.reason || issue.type, issue.cause ? `(${issue.cause})` : '', issue.errorSummary || '']
    .filter(Boolean).join(' ');
  return detail || issue.path || issue.target || issue.dependency || issue.reason || (issue.roots || []).join(', ') || issue.type;
}

export function evidenceSummaryLines(evidence) {
  const serialRecoveries = evidence.attempts.flatMap((attempt) => (attempt.serialRetries || []).filter((row) => row.result === 'recovered').map((row) => row.label));
  return [
    '## Package compatibility probe evidence / 软件包兼容探针证据', '',
    `- Source/Branch / 源码分支: \`${evidence.source}/${evidence.branch}\``,
    `- Target / 目标: \`${evidence.targetSystem || '-'}/${evidence.subtarget || '-'}/${evidence.profile || '-'}\``,
    `- Upstream commit / 上游提交: \`${evidence.upstreamCommit || 'unknown'}\``,
    `- Mode / 探测方式: \`${evidence.mode}\` (L${evidence.evidenceLevel})`,
    ...(evidence.pairedComparison ? [`- A/B comparison / A/B 对照: \`baseline B → final A\` · pair \`${evidence.pairId || '-'}\``] : []),
    ...(evidence.preflight ? [`- Preflight / 预检: \`${evidence.preflightResult || evidence.preflight.result || '-'}\` · \`${evidence.preflightReason || evidence.preflight.reason || '-'}\``] : []),
    `- Defconfig: \`${evidence.useDefconfig ? 'on' : 'off'}\``,
    `- Probe roots / 测试入口: ${evidence.roots.map((row) => `\`${row}\``).join(', ') || '-'}`,
    `- Direct Probe config / 直接探针配置: ${evidence.requestedPackageCount}`,
    `- Resolved package selections / Defconfig 解析软件包: ${evidence.resolvedPackageCount}`,
    `- Host runtime / 主机运行环境: \`${evidence.hostRuntime.kind || '-'} ${evidence.hostRuntime.version || ''}\` · compiler \`${evidence.hostRuntime.compiler || '-'}\``,
    `- Selected/deepest level / 选择/最深通过: L${evidence.selectedLevel || evidence.evidenceLevel} / ${evidence.deepestPassedLevel ? `L${evidence.deepestPassedLevel}` : '-'}`,
    `- Duration / 用时: ${(Number(evidence.durationMs || 0) / 1000).toFixed(1)}s`,
    `- Conclusion / 结论: **${evidence.conclusion}**`,
    ...(evidence.terminalError ? ['- Terminal error / 终止错误: `' + evidence.terminalError + '`'] : []),
    ...(evidence.recoverableErrors?.length ? ['- Recoverable errors / 可恢复错误: ' + evidence.recoverableErrors.map((row) => `\`${row}\``).join(', ')] : []),
    ...(serialRecoveries.length ? [`- Serial recovery / 串行复核恢复: ${[...new Set(serialRecoveries)].map((row) => `\`${row}\``).join(', ')}`] : []),
    `- Fingerprint / 错误指纹: \`${evidence.fingerprint.slice(0, 16)}\``,
    `- Run / 运行: ${evidence.runUrl}`, '', '### Normalized issues / 规范化问题', '',
    ...(evidence.issues.length ? evidence.issues.map((row) => `- \`${row.type}\`: ${issueText(row)}`) : evidence.reason ? [`- Runtime reason / 运行原因: \`${evidence.reason}\``] : ['- No normalized issue detected / 未检测到规范化问题']), '',
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

const INFRASTRUCTURE_ISSUE_TYPES = new Set(['timeout', 'infrastructure-failure', 'package-download-failure', 'metadata-unresolved']);

function isVirtualUnsupported(row) {
  return String(row?.reason || '') === 'virtual-boot-unsupported' ||
    (row?.runtimeCovered === false && Number(row?.deepestPassedLevel || 0) >= 4 && Number(row?.selectedLevel || row?.evidenceLevel || 0) >= 5) ||
    (row?.issues || []).some((issue) => issue?.type === 'capability-unavailable' &&
      String(issue?.reason || '').includes('virtual-boot-unsupported'));
}

const PACKAGE_PREREQUISITE_REASONS = new Set([
  'package-compile-prerequisite-failure', 'rootfs-package-prerequisite-failure',
  'rootfs-install-prerequisite-failure', 'firmware-prerequisite-failure',
]);

function prerequisiteCandidates(row) {
  return row?.reason === 'baseline-failure' || row?.pairConclusion === 'baseline-failure'
    ? [row.baseline, row.final].filter(Boolean) : [row];
}

function reportedTargetPrerequisiteEntries(row) {
  return prerequisiteCandidates(row).flatMap((candidate) => {
    if ((candidate?.result || candidate?.conclusion) !== 'inconclusive' || candidate?.reason !== 'target-prerequisite-failure') return [];
    const issues = Array.isArray(row?.issues) ? row.issues : candidate.issues;
    const direct = isAllowedTargetPrerequisiteCause(candidate.targetPrerequisiteCause) ? candidate.targetPrerequisiteCause : '';
    const issueCause = (issues || []).find((issue) => issue.type === 'target-prerequisite-failure' &&
      isAllowedTargetPrerequisiteCause(issue.cause))?.cause || '';
    const cause = direct || issueCause;
    const normalized = { ...candidate, ...(Array.isArray(issues) ? { issues } : {}),
      result: candidate.result || candidate.conclusion, targetPrerequisiteCause: cause };
    return isReportedInconclusive(normalized) ? [{ candidate, cause }] : [];
  });
}

function reportedPackagePrerequisiteEntries(row) {
  return prerequisiteCandidates(row).flatMap((candidate) => {
    if ((candidate?.result || candidate?.conclusion) !== 'inconclusive' || !PACKAGE_PREREQUISITE_REASONS.has(String(candidate.reason || ''))) return [];
    const issues = Array.isArray(row?.issues) ? row.issues : candidate.issues;
    const direct = isAllowedTargetPrerequisiteCause(candidate.prerequisiteCause) ? candidate.prerequisiteCause : '';
    const issueCause = (issues || []).find((issue) => issue.type === 'package-build-failure' &&
      isAllowedTargetPrerequisiteCause(issue.cause))?.cause || '';
    const cause = direct || issueCause;
    const normalized = { ...candidate, ...(Array.isArray(issues) ? { issues } : {}),
      result: candidate.result || candidate.conclusion, prerequisiteCause: cause };
    return isReportedInconclusive(normalized) ? [{ candidate, cause }] : [];
  });
}

function reportedTargetPrerequisiteCause(row) {
  return reportedTargetPrerequisiteEntries(row)[0]?.cause || '';
}

function reportedPackagePrerequisiteCause(row) {
  return reportedPackagePrerequisiteEntries(row)[0]?.cause || '';
}

function conclusionStats(rows) {
  const compatible = rows.filter((row) => row.conclusion === 'compatible').length;
  const incompatible = rows.filter((row) => row.conclusion === 'incompatible').length;
  const blocked = rows.filter((row) => row.conclusion === 'blocked').length;
  const skipped = rows.filter((row) => row.conclusion === 'skipped').length;
  const inconclusive = rows.filter((row) => row.conclusion === 'inconclusive').length;
  const preflightSkipped = rows.filter((row) => row.conclusion === 'skipped' && row.pairConclusion === 'preflight-skipped').length;
  const reportedTargetPrerequisite = rows.filter((row) => reportedTargetPrerequisiteCause(row)).length;
  const reportedPackagePrerequisite = rows.filter((row) => reportedPackagePrerequisiteCause(row)).length;
  const baselineFailure = rows.filter((row) => row.conclusion === 'inconclusive' &&
    (row.pairConclusion === 'baseline-failure' || row.reason === 'baseline-failure') &&
    !reportedTargetPrerequisiteCause(row) && !reportedPackagePrerequisiteCause(row)).length;
  const baselineBlocked = rows.filter((row) => row.conclusion === 'blocked' &&
    (row.pairedComparison === true || row.pairConclusion) &&
    (String(row.pairConclusion || '').startsWith('blocked-') || row.final?.reason === 'baseline-blocked' || row.final?.result === 'not-run')).length;
  const metadataUnresolved = rows.filter((row) => row.conclusion === 'inconclusive' &&
    (row.issues || []).some((issue) => issue.type === 'metadata-unresolved')).length;
  const infraInconclusive = rows.filter((row) => row.conclusion === 'inconclusive' && !reportedTargetPrerequisiteCause(row) &&
    !reportedPackagePrerequisiteCause(row) &&
    (row.issues || []).some((issue) => INFRASTRUCTURE_ISSUE_TYPES.has(issue.type))).length;
  const unattributedInconclusive = Math.max(0, inconclusive - baselineFailure - reportedTargetPrerequisite - reportedPackagePrerequisite - infraInconclusive);
  const conclusive = compatible + incompatible;
  const applicable = compatible + incompatible + blocked + inconclusive;
  const successRate = applicable ? compatible / applicable : null;
  const evaluatedCompatibility = conclusive ? compatible / conclusive : null;
  const evaluationCoverage = applicable ? conclusive / applicable : null;
  const virtualUnsupported = rows.filter(isVirtualUnsupported).length;
  return { attempted: rows.length, applicable, compatible, incompatible, blocked, skipped, inconclusive, preflightSkipped, reportedTargetPrerequisite,
    reportedPackagePrerequisite,
    baselineFailure, baselineBlocked, metadataUnresolved, infraInconclusive, unattributedInconclusive, conclusive,
    successRate, evaluatedCompatibility, evaluationCoverage, compatibilityRate: evaluatedCompatibility, virtualUnsupported };
}

const SELECTED_PACKAGE_PRIMARY_CAUSES = new Map([
  ['package-unavailable', 'unavailable'],
  ['kconfig-unsatisfied', 'kconfig'],
  ['root-combination-rejected', 'kconfig'],
  ['package-compile-failure', 'compile/link'],
  ['rootfs-package-compile-failure', 'compile/link'],
  ['rootfs-conflict', 'rootfs'],
  ['final-firmware-failure', 'firmware'],
]);

const LEGACY_PACKAGE_PREREQUISITE_REASONS = new Set([
  'package-compile-prerequisite-failure',
  'rootfs-package-prerequisite-failure',
  'rootfs-install-prerequisite-failure',
  'firmware-prerequisite-failure',
]);

function normalizeBuildTarget(value) {
  return String(value || '').replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/compile$/, '').replace(/\/+$/, '');
}

function legacyDirectPrerequisiteCause(row) {
  if (!LEGACY_PACKAGE_PREREQUISITE_REASONS.has(String(row?.reason || ''))) return false;
  const failed = new Set((row.failedBuildTargets || row.attempts?.[0]?.failedBuildTargets || [])
    .map(normalizeBuildTarget).filter(Boolean));
  if (!failed.size) return false;
  const roots = row.rootTargets || row.attempts?.[0]?.rootTargets || [];
  return roots.some((target) => failed.has(normalizeBuildTarget(target)));
}

function selectedPackagePrimaryCause(row) {
  if (row?.conclusion !== 'incompatible') return '';
  const paired = row.pairedComparison === true || row.pairConclusion;
  if (paired && row.packageCauseKind === 'dependency') return 'A/B dependency';
  if (paired && row.packageCauseKind === 'direct') return 'direct';
  if (paired && (row.packageCauseKind === 'shared' || row.reason === 'plugin-induced-failure')) return 'A/B shared-target';
  if (legacyDirectPrerequisiteCause(row)) return 'compile/link';
  return SELECTED_PACKAGE_PRIMARY_CAUSES.get(String(row.reason || '')) || '';
}

function selectedPackagePrimaryStats(rows) {
  const causes = rows.map(selectedPackagePrimaryCause).filter(Boolean);
  const labels = [...new Set(causes)];
  const count = causes.length;
  const attempted = rows.length;
  const direct = rows.filter((row) => row.conclusion === 'incompatible' &&
    (row.pairedComparison === true || row.pairConclusion) && row.packageCauseKind === 'direct').length;
  const dependency = rows.filter((row) => row.conclusion === 'incompatible' &&
    (row.pairedComparison === true || row.pairConclusion) && row.packageCauseKind === 'dependency').length;
  const shared = rows.filter((row) => row.conclusion === 'incompatible' &&
    (row.pairedComparison === true || row.pairConclusion) &&
    (row.packageCauseKind === 'shared' || row.reason === 'plugin-induced-failure')).length;
  const paired = rows.some((row) => row.pairedComparison === true || row.pairConclusion);
  return {
    selectedPackagePrimaryFailures: count,
    selectedPackagePrimaryDirectFailures: direct,
    selectedPackagePrimaryDependencyFailures: dependency,
    selectedPackagePrimarySharedFailures: shared,
    paired,
    // Plugin primary cause is defined over incompatible observations only;
    // blocked, skipped and unresolved rows were not plugin evaluations.
    selectedPackagePrimaryRate: rows.filter((row) => row.conclusion === 'incompatible').length ?
      count / rows.filter((row) => row.conclusion === 'incompatible').length : null,
    pluginCauseRate: rows.filter((row) => row.conclusion === 'incompatible').length ?
      count / rows.filter((row) => row.conclusion === 'incompatible').length : null,
    selectedPackagePrimaryCause: count ? (labels.length === 1 ? labels[0] : 'mixed') : '—',
  };
}

function conclusionForRows(rows, exhaustive) {
  const { compatible, incompatible, blocked, skipped, inconclusive } = conclusionStats(rows);
  if (inconclusive) return compatible || incompatible || skipped ? 'incomplete' : 'inconclusive';
  if (blocked && !compatible && !incompatible) return 'blocked';
  if (blocked) return 'partially-blocked';
  if (!compatible && !incompatible && skipped) return 'skipped';
  if (!compatible && !incompatible) return 'inconclusive';
  if (compatible && incompatible) return 'partially-compatible';
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
  return [...groups.entries()].map(([path, rows]) => {
    const reportedTargetRows = rows.flatMap((row) => reportedTargetPrerequisiteEntries(row));
    const reportedPackageRows = rows.filter((row) => reportedPackagePrerequisiteCause(row));
    return {
      path, source: rows[0]?.source || '', branch: depth >= 2 ? rows[0]?.branch || '' : '',
      ...conclusionStats(rows), ...selectedPackagePrimaryStats(rows), conclusion: conclusionForRows(rows, options.exhaustive === true), roots: rows[0]?.roots || [],
      reasons: [...new Set(rows.map((row) => row.reason).filter(Boolean))],
      issueTypes: [...new Set(rows.flatMap((row) => (row.issues || []).map((issue) => issue.type)))],
      infrastructureReasons: [...new Set(rows.flatMap((row) => (row.issues || [])
        .filter((issue) => INFRASTRUCTURE_ISSUE_TYPES.has(issue.type)).map((issue) => issue.reason || issue.type)))],
      targetPrerequisiteCauses: [...new Set(reportedTargetRows.map((entry) => entry.cause).filter(Boolean))],
      targetPrerequisiteFailedBuildTargets: [...new Set(reportedTargetRows.flatMap((entry) => entry.candidate.failedBuildTargets || []))],
      targetPrerequisiteErrors: [...new Set(reportedTargetRows.map((entry) => entry.candidate.terminalError || entry.candidate.errorSummary || '').filter(Boolean))],
      prerequisiteCauses: [...new Set(reportedPackageRows.map(reportedPackagePrerequisiteCause).filter(Boolean))],
      failedBuildTargets: [...new Set(reportedPackageRows.flatMap((row) => row.failedBuildTargets || []))],
      prerequisiteErrors: [...new Set(reportedPackageRows.map((row) => row.terminalError || row.errorSummary || '').filter(Boolean))],
      blockedReasons: [...new Set(rows.filter((row) => row.conclusion === 'blocked')
        .flatMap((row) => [row.reason, ...(row.issues || []).filter((issue) => issue.type === 'base-profile-failure').map((issue) => issue.reason)]).filter(Boolean))],
      blockedFailedBuildTargets: [...new Set(rows.filter((row) => row.conclusion === 'blocked')
        .flatMap((row) => [ ...(row.failedBuildTargets || []), ...(row.issues || []).filter((issue) => issue.type === 'base-profile-failure').flatMap((issue) => issue.targets || []) ]).filter(Boolean))],
      blockedErrors: [...new Set(rows.filter((row) => row.conclusion === 'blocked')
        .flatMap((row) => [row.terminalError, row.errorSummary, ...(row.issues || []).filter((issue) => issue.type === 'base-profile-failure').map((issue) => issue.errorSummary)]).filter(Boolean))],
      metadataRefreshErrors: [...new Set(rows.flatMap((row) => (row.issues || [])
        .filter((issue) => issue.type === 'metadata-unresolved').map((issue) => issue.errorSummary || '').filter(Boolean)))],
      unavailableRoots: [...new Set(rows.flatMap((row) => row.unavailableRoots || []))],
    };
  }).sort((a, b) => a.path.localeCompare(b.path, undefined, { numeric: true }));
}

function formatCompatibilityRate(scope) {
  return formatRate(scope.evaluatedCompatibility ?? scope.compatibilityRate);
}

function formatRate(value) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) return '—';
  return `${(Number(value) * 100).toFixed(1).replace(/\.0$/, '')}%`;
}

function formatSuccessRate(scope) {
  // Success rate covers every applicable environment. Skipped roots are not
  // applicable; blocked and unresolved environments remain in the denominator
  // because neither is a successful compatibility result.
  return formatRate(scope.successRate);
}

function formatSelectedPackagePrimaryRate(scope) {
  const incompatible = Number(scope.incompatible || 0);
  if (!incompatible) return '—';
  const count = Number(scope.selectedPackagePrimaryFailures || 0);
  const rate = `${(count / incompatible * 100).toFixed(1).replace(/\.0$/, '')}%`;
  const direct = Number(scope.selectedPackagePrimaryDirectFailures || 0);
  const dependency = Number(scope.selectedPackagePrimaryDependencyFailures || 0);
  const shared = Number(scope.selectedPackagePrimarySharedFailures || 0);
  if (scope.paired && (direct || dependency || shared)) {
    return `${count}/${incompatible} · ${rate} · direct ${direct} · A/B dependency ${dependency}${shared ? ` · A/B shared-target ${shared}` : ''}`;
  }
  return `${count}/${incompatible} · ${rate} · ${scope.selectedPackagePrimaryCause || '—'}`;
}

function scopeResultLabel(scope, exhaustive) {
  if (scope.inconclusive > 0) {
    if (scope.conclusive > 0 || scope.skipped > 0 || scope.baselineFailure > 0 ||
        scope.reportedTargetPrerequisite > 0 || scope.reportedPackagePrerequisite > 0) return 'INCOMPLETE';
    return scope.infraInconclusive === scope.inconclusive ? 'INFRA ERROR' : 'ERROR';
  }
  if (scope.blocked > 0) return scope.conclusive > 0 ? 'MIXED/BLOCKED' : 'BLOCKED';
  if (scope.conclusive === 0 && scope.skipped > 0) return 'SKIP';
  if (scope.compatible > 0 && scope.incompatible > 0) return 'MIXED';
  if (scope.compatible > 0) return exhaustive ? 'PASS' : 'PASS (sampled)';
  if (scope.incompatible > 0) return exhaustive ? 'FAIL' : 'FAIL (sampled)';
  return 'ERROR';
}

function sourceNeedsBranchBreakdown(scope) {
  return scope.blocked > 0 || scope.skipped > 0 || scope.inconclusive > 0 || (scope.compatible > 0 && scope.incompatible > 0);
}

function scopeNote(scope) {
  const notes = [];
  if (scope.preflightSkipped > 0) {
    notes.push(`Preflight skipped before Baseline B / 预检发现插件不可用，未运行基线 B: ${scope.preflightSkipped}`);
  }
  if (scope.inconclusive > 0) {
    if (scope.baselineFailure > 0) {
      notes.push(`Baseline B failed; Final A not run / 基线 B 失败，未执行 Final A: ${scope.baselineFailure}`);
    }
    const reportedTargetPrerequisite = Number(scope.reportedTargetPrerequisite || 0);
    if (reportedTargetPrerequisite > 0) {
      const details = [...new Set([
        ...(scope.targetPrerequisiteCauses || []), ...(scope.targetPrerequisiteFailedBuildTargets || []),
        ...(scope.targetPrerequisiteErrors || []),
      ].filter(Boolean))].join('; ') || 'unattributed';
      notes.push(`Upstream Target/Toolchain prerequisite reported inconclusive / 插件编译前上游 Target/Toolchain 前置失败待定: ${reportedTargetPrerequisite} (${details})`);
    }
    const reportedPackagePrerequisite = Number(scope.reportedPackagePrerequisite || 0);
    if (reportedPackagePrerequisite > 0) {
      const details = [...new Set([
        ...(scope.prerequisiteCauses || []), ...(scope.failedBuildTargets || []), ...(scope.prerequisiteErrors || []),
      ].filter(Boolean))].join('; ') || 'reported prerequisite';
      notes.push(`Package prerequisite reported inconclusive / 插件编译前置失败待定: ${reportedPackagePrerequisite} (${details})`);
    }
    if (scope.metadataUnresolved > 0) {
      const details = [...new Set(['metadata-unresolved', ...(scope.metadataRefreshErrors || [])].filter(Boolean))].join('; ');
      notes.push(`After-Feeds metadata refresh failed / Feeds 后元数据刷新失败: ${scope.metadataUnresolved} (${details})`);
    }
    const otherInfraInconclusive = Math.max(0, Number(scope.infraInconclusive || 0) - Number(scope.metadataUnresolved || 0));
    if (otherInfraInconclusive > 0) {
      const kinds = (scope.infrastructureReasons || []).filter((kind) => kind !== 'metadata-unresolved');
      const kind = kinds.length ? kinds.join(', ') : 'infrastructure';
      notes.push(`Infrastructure incomplete / 基础设施未完成: ${otherInfraInconclusive} (${kind})`);
    }
    if (scope.unattributedInconclusive > 0) {
      notes.push(`Undetermined / 未定: ${scope.unattributedInconclusive}`);
    }
  }
  if (scope.blocked > 0) {
    const details = [...new Set([
      ...(scope.blockedReasons || []), ...(scope.blockedFailedBuildTargets || []), ...(scope.blockedErrors || []),
    ].filter(Boolean))].join('; ');
    notes.push(`${scope.baselineBlocked > 0 ? 'Baseline B blocked; Final A not run; ' : ''}Base Profile blocked; plugin not evaluated / ${scope.baselineBlocked > 0 ? '基线 B 阻断，未执行 Final A；' : ''}基础 Profile 阻断，未评价插件: ${scope.blocked}${details ? ` (${details})` : ''}`);
  }
  if (scope.skipped > 0) {
    const roots = (scope.unavailableRoots || []).map((row) => `\`${row}\``).join(', ');
    const suffix = roots ? ` (${roots})` : '';
    if ((scope.reasons || []).includes('root-absent-source')) {
      notes.push(`Skipped: plugin unavailable in source/branch / 跳过：源码/分支不存在插件${suffix}`);
    } else if ((scope.reasons || []).includes('root-not-applicable')) {
      notes.push(`Skipped: plugin not applicable to target / 跳过：插件不适用于目标${suffix}`);
    } else {
      notes.push(`Skipped / 跳过: ${scope.skipped}`);
    }
  }
  if (scope.virtualUnsupported > 0) {
    notes.push(`Firmware build passed; virtual runtime not covered / 固件构建通过；虚拟运行未覆盖: ${scope.virtualUnsupported}`);
  }
  if (scope.compatible > 0) {
    notes.push(`Passed tests / 通过测试: ${scope.compatible}/${scope.applicable}`);
  }
  if (scope.incompatible > 0) {
    notes.push(`Plugin incompatible / 插件不兼容: ${scope.incompatible}`);
  }
  return notes.join('; ') || 'No applicable probe result / 没有可适用的探针结果';
}

function branchBreakdowns(sourceScopes, branchScopes) {
  return sourceScopes.filter(sourceNeedsBranchBreakdown).map((source) => ({
    source: source.source,
    branches: branchScopes.filter((row) => row.source === source.source),
  }));
}

function optionalBoolean(value) {
  if (value === true || String(value).toLowerCase() === 'true') return true;
  if (value === false || String(value).toLowerCase() === 'false') return false;
  return null;
}

export function aggregateRunStatus(env = {}, evidenceInput = 0) {
  const evidence = Array.isArray(evidenceInput) ? evidenceInput : null;
  const evidenceCount = evidence ? evidence.length : Number(evidenceInput || 0);
  const planResult = String(env.PLAN_RESULT || 'unknown').toLowerCase();
  const probeResult = String(env.PROBE_RESULT || 'unknown').toLowerCase();
  const buildOutcome = String(env.PROBE_BUILD_OUTCOME || '').toLowerCase();
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
    // A failed build is an execution failure even if a stale/partial evidence
    // set contains a domain-looking conclusion.  The per-environment
    // Finalizer enforces the same rule; keeping it here prevents aggregation
    // from turning a failed Runner into a green summary.
    if (buildOutcome && buildOutcome !== 'success') {
      return { state: evidenceCount ? 'execution-collected-with-failures' : 'execution-failure', planResult, probeResult, execute };
    }
    const structured = evidence && evidence.length > 0 && evidence.every((row) =>
      ['compatible', 'incompatible', 'blocked', 'skipped'].includes(String(row?.conclusion || '')));
    if (probeResult === 'success') {
      if (!evidenceCount) return { state: 'execution-evidence-missing', planResult, probeResult, execute };
      if (evidence && !structured) return { state: 'execution-incomplete', planResult, probeResult, execute };
      return { state: 'execution-success', planResult, probeResult, execute };
    }
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
  const summaryScopes = aggregateScopeConclusions(evidence, { depth: 1, exhaustive });
  const breakdowns = branchBreakdowns(summaryScopes, scopes);
  const overallStats = conclusionStats(evidence);
  const overallConclusion = conclusionForRows(evidence, exhaustive);
  const overallResult = scopeResultLabel(overallStats, exhaustive);
  const roots = [...new Set(evidence.flatMap((row) => row.roots || []))];
  const runStatus = aggregateRunStatus(env, evidence);
  const lines = ['## Package compatibility probe result / 软件包兼容探针结果', '',
    `- Probe roots / 测试入口: ${roots.map((row) => `\`${row}\``).join(', ') || '-'}`,
    `- Overall / 总结果: **${evidence.length ? overallResult : 'ERROR'}** · \`${evidence.length ? overallConclusion : 'inconclusive'}\``,
    `- Success rate / 成功率: **${formatSuccessRate(overallStats)}** (${overallStats.compatible}/${overallStats.applicable} applicable / 适用环境；skipped excluded / 排除跳过)`,
    `- Evaluated compatibility / 已评价兼容率: **${formatCompatibilityRate(overallStats)}** (${overallStats.compatible}/${overallStats.conclusive} evaluated / 已评价)`,
    `- Evaluation coverage / 插件评价覆盖率: **${formatRate(overallStats.evaluationCoverage)}** (${overallStats.conclusive}/${overallStats.applicable} applicable / 适用环境)`,
    `- Coverage / 覆盖: ${env.COVERAGE_PLANNED || evidence.length}/${env.COVERAGE_TOTAL || evidence.length}${exhaustive ? ' (complete)' : ' (sampled)'}`,
    `- Blocked / 基础 Profile 阻断（插件未评价）: ${overallStats.blocked}`,
    `- Skipped / 跳过: ${overallStats.skipped}`,
    `- Unresolved / 执行未定: ${overallStats.inconclusive}`,
    `- Catalog channel / Catalog 通道: \`${env.DATA_BRANCH || 'unknown'}\``,
    `- Batch / 批次: ${Number(env.BATCH_INDEX || 0) + 1}/${env.BATCH_COUNT || 1}`,
    `- Collected evidence / 已收集证据: ${evidence.length}`,
    `- Run state / 运行状态: **${runStatus.state}**`,
    `- Run / 运行: ${env.GITHUB_SERVER_URL || ''}/${env.GITHUB_REPOSITORY || ''}/actions/runs/${env.GITHUB_RUN_ID || ''}`, ''];
  if (!evidence.length) lines.push(...noEvidenceLines(runStatus));
  else {
    lines.push('### Source summary / 源码总览', '',
      '| Source<br>源码源 | Compatible<br>兼容 | Success rate<br>成功率 | Incompatible<br>不兼容 | Base Profile blocked<br>基础 Profile 阻断 | Unresolved<br>执行未定 | Package-caused rate<br>插件主因率 | Skipped<br>跳过 | Notes<br>备注 |',
      '|---|---:|---:|---:|---:|---:|---|---:|---|',
      ...summaryScopes.map((scope) => `| ${scope.source || '-'} | ${scope.compatible} | **${formatSuccessRate(scope)}** | ${scope.incompatible} | ${scope.blocked} | ${scope.inconclusive} | **${formatSelectedPackagePrimaryRate(scope)}** | ${scope.skipped} | ${scopeNote(scope)} |`), '');
    for (const breakdown of breakdowns) {
      lines.push('<details>', `<summary>${breakdown.source || '-'} · Branch breakdown / 分支明细</summary>`, '',
        '| Branch<br>分支 | Compatible<br>兼容 | Incompatible<br>不兼容 | Base Profile blocked<br>基础 Profile 阻断 | Unresolved<br>执行未定 | Package-caused rate<br>插件主因率 | Skipped<br>跳过 | Notes<br>备注 |',
        '|---|---:|---:|---:|---:|---|---:|---|',
        ...breakdown.branches.map((scope) => `| ${scope.branch || '—'} | ${scope.compatible} | ${scope.incompatible} | ${scope.blocked} | ${scope.inconclusive} | **${formatSelectedPackagePrimaryRate(scope)}** | ${scope.skipped} | ${scopeNote(scope)} |`), '',
        '</details>', '');
    }
    lines.push('<details>', `<summary>Environment details / 环境明细 (${evidence.length})</summary>`, '',
      '| Source/Branch | Target System/Subtarget/Profile | Conclusion / 结论 | Issues / 问题 |', '|---|---|---|---|',
      ...evidence.map((row) => `| ${row.source}/${row.branch} | ${row.targetSystem || '-'}/${row.subtarget || '-'}/${row.profile || '-'} | **${row.conclusion}** | ${(row.issues || []).map(issueText).join('<br>') || row.reason || '-'} |`), '',
      '</details>', '');
  }
  return { evidence, groups: [...grouped.values()], scopes, summaryScopes, branchBreakdowns: breakdowns, overallStats,
    overallConclusion: evidence.length ? overallConclusion : 'inconclusive', overallResult: evidence.length ? overallResult : 'ERROR', runStatus, lines };
}

export function main(env = process.env) {
  if (process.argv[2] === '--aggregate') {
    const directory = resolve(process.argv[3] || 'collected-evidence');
    const aggregate = aggregateEvidence(directory, env);
    mkdirSync('probe-diagnostics', { recursive: true });
    writeFileSync('probe-diagnostics/FINAL_SUMMARY.md', aggregate.lines.join('\n') + '\n');
    writeFileSync('probe-diagnostics/results.json', JSON.stringify({ schema: 2, generatedAt: new Date().toISOString(),
      runStatus: aggregate.runStatus, overallConclusion: aggregate.overallConclusion, overallStats: aggregate.overallStats,
      evidence: aggregate.evidence, groups: aggregate.groups, scopes: aggregate.scopes, summaryScopes: aggregate.summaryScopes,
      branchBreakdowns: aggregate.branchBreakdowns, overallResult: aggregate.overallResult }, null, 2) + '\n');
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
      `- Base Profile blocked / 基础 Profile 阻断（插件未评价）: ${stats.blocked}`,
      `- Skipped / 跳过: ${stats.skipped}`,
      `- Incompatible / 冲突: ${stats.incompatible}`,
      `- Inconclusive / 未定: ${stats.inconclusive}`, '',
    ];
    writeFileSync('probe-evidence/SUMMARY.md', lines.join('\n'));
    return evidence;
  }
  const evidence = createEvidence({ log, config, runtime, env });
  writeFileSync('probe-evidence/evidence.json', JSON.stringify(evidence, null, 2) + '\n');
  writeFileSync('probe-evidence/SUMMARY.md', evidenceSummaryLines(evidence).join('\n'));
  return evidence;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();

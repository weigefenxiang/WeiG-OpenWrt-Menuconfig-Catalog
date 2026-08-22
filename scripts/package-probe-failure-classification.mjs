// SPDX-FileCopyrightText: 2026 weigefenxiang <weigefenxiang@gmail.com>
// SPDX-License-Identifier: GPL-3.0-or-later

import { createHash } from 'node:crypto';

export const TARGET_PREREQUISITE_CAUSES = Object.freeze([
  'patch-apply',
  'toolchain-kernel-version',
  'kernel-prerequisite',
  // Kconfig is a second (kernel-owned) resolver.  Keep its EOF/syncconfig
  // failure as a generic cause; the concrete symbol is deliberately not
  // part of the classifier contract.
  'kernel-kconfig-sync-eof',
  'package-output-missing',
  'target-build',
]);

export const REPORTED_PREREQUISITE_REASONS = Object.freeze([
  'target-prerequisite-failure',
  'package-compile-prerequisite-failure',
  'rootfs-package-prerequisite-failure',
  'rootfs-install-prerequisite-failure',
  'firmware-prerequisite-failure',
]);

const TARGET_PREREQUISITE_CAUSE_SET = new Set(TARGET_PREREQUISITE_CAUSES);
const REPORTED_PREREQUISITE_REASON_SET = new Set(REPORTED_PREREQUISITE_REASONS);
const INFRASTRUCTURE_ISSUE_TYPES = new Set([
  'timeout', 'infrastructure-failure', 'package-download-failure', 'metadata-unresolved',
]);

export function isAllowedTargetPrerequisiteCause(value) {
  return TARGET_PREREQUISITE_CAUSE_SET.has(String(value || ''));
}

export function isMemoryExhaustion(value) {
  // Keep `earlyoom` (the host watchdog) from matching the standalone OOM
  // marker.  The old unbounded `OOM` alternative turned an otherwise
  // authoritative package failure into infrastructure uncertainty whenever
  // the shared log happened to mention earlyoom.
  return /\bout[\s_-]+of[\s_-]+memory\b|\bOOM\b|\bcannot allocate memory\b|\bcan't allocate memory\b|\bmemory allocation failed\b|\bkilled by signal\s+9\b|\bsignal\s+9\b|(?:^|[\s:])killed(?:$|[\s:])/i.test(String(value || ''));
}

export function isMakeInfrastructureFailure(value) {
  const text = String(value || '');
  if (/No space left on device|Prerequisite check failed|Build dependency:\s+Please install|Please install Python 2\.x/i.test(text)) return true;
  if (/Hash check failed|download failed|Connection timed out|Could not resolve host|RPC failed|HTTP\s+(?:429|5\d\d)|returned error:\s*(?:429|5\d\d)|expected ['"]?packfile|early EOF|Connection reset|TLS.*(?:error|failed)|GnuTLS.*error|SSL.*(?:error|failed)/i.test(text)) return true;
  if (/(?:^|[\s:])(?:timed\s*out|timeout:)/i.test(text)) return true;
  if (isMemoryExhaustion(text)) return true;
  return /No rule to make target[^\n]*build_dir[^\n]*\/linux-[^/\s]+\/linux-[^/\s]+\/\.config/i.test(text);
}

export function isCommandInfrastructureFailure(result) {
  return Number(result?.code) === -1 || isMakeInfrastructureFailure(result?.output);
}

function causeFromLines(lines) {
  const text = lines.join('\n');
  // Linux Kconfig asks an interactive question for a newly introduced
  // symbol and then receives EOF in a non-interactive probe.  Match the
  // protocol/phase, not the symbol name or a particular source tree.
  if (/(?:scripts[\\/]kconfig[\\/](?:conf|mconf)\b[^\n]*--syncconfig|--syncconfig\b[^\n]*\bKconfig\b)/i.test(text) &&
      /(?:\(NEW\)|error\s+in\s+reading|end\s+of\s+file)/i.test(text)) {
    return 'kernel-kconfig-sync-eof';
  }
  if (lines.some((line) => /\b(?:Patch failed|Hunk(?:\s+#?\d+)?\s+FAILED|can't find file to patch)\b/i.test(line))) {
    return 'patch-apply';
  }
  if (lines.some((line) => /(?:available\s+kernel headers are (?:older|too old)|kernel headers?[^\n]*(?:older|too old)\b)/i.test(line))) {
    return 'toolchain-kernel-version';
  }
  if (lines.some((line) =>
    /(?:output|artifact|generated\s+(?:file|module)|image)\b[^\n]*(?:is\s+)?(?:missing|not\s+found|does\s+not\s+exist)\b/i.test(line) ||
    /(?:cannot\s+stat|no\s+such\s+file\s+or\s+directory)[^\n]*(?:\.ko\b|\.ipk\b|\.deb\b|\.img\b|\.bin\b|output|artifact)/i.test(line))) {
    return 'package-output-missing';
  }
  if (lines.some((line) => /\bmodule(?:\s+['"]?[A-Za-z0-9_./+@:-]+['"]?)?\s+is\s+missing\b/i.test(line) ||
    /\bSOURCE_DATE_EPOCH\s*:\s*not found\b/i.test(line))) {
    return 'kernel-prerequisite';
  }
  if (lines.some((line) => /No rule to make target\b/i.test(line))) {
    return 'target-build';
  }
  return '';
}

function stripAnsi(value) {
  return String(value || '').replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '');
}

function normalizeFailedBuildTarget(value) {
  return String(value || '').replace(/\\/g, '/').replace(/^\.\//, '')
    .replace(/\/(?:compile|install|prepare)$/, '').replace(/\/+$/, '');
}

function isGenericBuildWrapper(value) {
  return /^(?:package|tools|toolchain|target)\/(?:compile|install|prepare)$/.test(String(value || '').replace(/\\/g, '/').replace(/^\.\//, ''));
}

// An explicit non-wrapper `ERROR: <target> failed to build` line is
// authoritative.  Make's bracketed target is often only an outer wrapper
// (for example package/feeds/.../oscam around package/kernel/linux).  Generic
// top-level wrappers remain lowest even when an upstream log spells them out;
// among the remaining Make-only candidates, log order is authoritative
// because build nesting is not encoded reliably by path depth.
export function extractFailedBuildTargets(value) {
  const text = stripAnsi(value);
  const candidates = [];
  const add = (target, index, source) => {
    const normalized = normalizeFailedBuildTarget(target);
    if (!normalized) return;
    const rank = source === 'explicit' ? (isGenericBuildWrapper(target) ? 0 : 4)
      : source === 'generic' ? 2 : (isGenericBuildWrapper(target) ? 0 : 1);
    candidates.push({ target: normalized, index, source, rank, depth: normalized.split('/').length });
  };
  for (const match of text.matchAll(/(?:^|\r?\n)\s*ERROR:\s+((?:package|tools|toolchain|target)\/[A-Za-z0-9_./+@-]+)\s+failed to build/gi)) {
    add(match[1], match.index || 0, 'explicit');
  }
  for (const match of text.matchAll(/(?:^|\r?\n)\s*((?:package|tools|toolchain|target)\/[A-Za-z0-9_./+@-]+)\s+failed to build/gi)) {
    add(match[1], match.index || 0, 'generic');
  }
  for (const match of text.matchAll(/make(?:\[\d+\])?:\s+\*{3}\s+\[((?:package|tools|toolchain|target)\/[A-Za-z0-9_./+@-]+\/(?:compile|install|prepare))\]\s+Error\b/gi)) {
    add(match[1], match.index || 0, 'make');
  }
  for (const match of text.matchAll(/\*{3}\s+((?:package|tools|toolchain|target)\/[A-Za-z0-9_./+@-]+\/(?:compile|install|prepare))\s+Error\b/gi)) {
    add(match[1], match.index || 0, 'make');
  }
  if (!candidates.length) return [];
  // At one evidence level the first make failure is the innermost target;
  // later make lines are normally only the outer propagation wrapper.  Do
  // not use path depth here: feed/source layout depth is not build nesting.
  candidates.sort((left, right) => right.rank - left.rank || left.index - right.index);
  return [candidates[0].target];
}

export function deterministicErrorSummary(value) {
  const lines = stripAnsi(value).split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const match = lines.find((line) =>
    /(?:\berror\s*:|\berror\s+in\s+reading\b|\bend\s+of\s+file\b|\bfailed(?:\s+to)?\b|\bis\s+missing\b|\bno rule to make target\b|\bpatch failed\b|\bhunk(?:\s+#?\d+)?\s+failed\b)/i.test(line));
  return String(match || '').replace(/\s+/g, ' ').slice(0, 320);
}

export function classifyPrerequisiteFailure(value) {
  const text = stripAnsi(value);
  const cause = causeFromLines(text.split(/\r?\n/));
  const errorSummary = deterministicErrorSummary(text);
  const failedBuildTargets = extractFailedBuildTargets(text);
  return {
    cause: isAllowedTargetPrerequisiteCause(cause) ? cause : '',
    errorSummary,
    failedBuildTargets,
    failureFingerprint: buildFailureFingerprint({ cause, errorSummary, failedBuildTargets }),
  };
}

/**
 * Stable, source-independent fingerprint for a failed build observation.
 *
 * Only normalized evidence participates.  In particular, this intentionally
 * excludes Source/Branch, package names embedded in arbitrary log text and
 * timestamps, so the same class of failure can be compared by the A/B
 * counterfactual runner.
 */
export function buildFailureFingerprint({ cause = '', errorSummary = '', failedBuildTargets = [], phase = '' } = {}) {
  const payload = {
    phase: String(phase || ''),
    cause: String(cause || ''),
    errorSummary: String(errorSummary || '').replace(/\s+/g, ' ').trim().slice(0, 320),
    failedBuildTargets: [...new Set((failedBuildTargets || []).map((target) => normalizeFailedBuildTarget(target)).filter(Boolean))].sort(),
  };
  return createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}

export function classifyTargetPrerequisiteFailure(value) {
  const text = String(value || '');
  const detail = classifyPrerequisiteFailure(text);
  if (isMakeInfrastructureFailure(text)) {
    return { result: 'inconclusive', reason: 'target-prerequisite-infrastructure', cause: '',
      errorSummary: detail.errorSummary, failedBuildTargets: detail.failedBuildTargets,
      failureFingerprint: detail.failureFingerprint };
  }
  const cause = detail.cause;
  if (isAllowedTargetPrerequisiteCause(cause)) {
    return { result: 'inconclusive', reason: 'target-prerequisite-failure', cause,
      errorSummary: detail.errorSummary, failedBuildTargets: detail.failedBuildTargets,
      failureFingerprint: detail.failureFingerprint };
  }
  return { result: 'inconclusive', reason: 'target-prerequisite-unattributed-failure', cause: '',
    errorSummary: detail.errorSummary, failedBuildTargets: detail.failedBuildTargets,
    failureFingerprint: detail.failureFingerprint };
}

function hasMatchingStructuredIssue(row, reason, cause, failedTargets, errorSummary) {
  // Runtime attempts are intentionally compact and do not carry normalized
  // issues; the evidence writer is the boundary that must materialize them.
  // A row with an evidence conclusion/schema is therefore invalid when its
  // issues array is absent, rather than silently bypassing the gate.
  if (!Array.isArray(row?.issues)) return !('conclusion' in (row || {})) && !('schema' in (row || {}));
  if (row.issues.some((issue) => INFRASTRUCTURE_ISSUE_TYPES.has(String(issue?.type || '')))) return false;
  const type = reason === 'target-prerequisite-failure' ? 'target-prerequisite-failure' : 'package-build-failure';
  return row.issues.some((issue) => issue?.type === type && String(issue.reason || '') === reason &&
    issue.cause === cause && Array.isArray(issue.targets) && failedTargets.every((target) => issue.targets.includes(target)) &&
    String(issue.errorSummary || '').trim() === errorSummary);
}

export function isReportedInconclusive(row) {
  if (row?.result !== 'inconclusive') return false;
  const reason = String(row?.reason || '');
  // A paired run exposes a Baseline-B transport wrapper when B fails before
  // Final-A can start.  The wrapper is reportable only when its inner phase
  // carries one of the explicitly allowed upstream prerequisite causes.
  if (reason === 'baseline-failure' || row?.pairConclusion === 'baseline-failure') {
    if (Array.isArray(row?.issues) && row.issues.some((issue) => INFRASTRUCTURE_ISSUE_TYPES.has(String(issue?.type || '')))) return false;
    const inner = [row?.baseline, row?.final].find((candidate) => isReportedInconclusive(candidate));
    if (!inner) return false;
    // Paired runtime wrappers intentionally omit normalized issues; paired
    // evidence rows, identified by conclusion/schema, must materialize the
    // matching issue instead of bypassing the evidence gate.
    if (!Array.isArray(row?.issues)) return !('conclusion' in (row || {})) && !('schema' in (row || {}));
    const innerReason = String(inner.reason || '');
    const innerCause = inner.targetPrerequisiteCause || inner.prerequisiteCause || inner.cause || '';
    const innerTargets = Array.isArray(inner.failedBuildTargets) ? inner.failedBuildTargets.filter(Boolean) : [];
    const innerSummary = String(inner.errorSummary || '').trim();
    return hasMatchingStructuredIssue(row, innerReason, innerCause, innerTargets, innerSummary);
  }
  const cause = row?.targetPrerequisiteCause || row?.prerequisiteCause || row?.cause || '';
  const failedTargets = Array.isArray(row?.failedBuildTargets) ? row.failedBuildTargets.filter(Boolean) : [];
  const errorSummary = String(row?.errorSummary || '').trim();
  if (!REPORTED_PREREQUISITE_REASON_SET.has(reason) || !isAllowedTargetPrerequisiteCause(cause) ||
      !failedTargets.length || !errorSummary || ['direct', 'dependency'].includes(String(row?.packageCauseKind || ''))) return false;
  return hasMatchingStructuredIssue(row, reason, cause, failedTargets, errorSummary);
}

export function probeResultExitCode(rows) {
  return rows.every((row) => ['compatible', 'incompatible', 'blocked', 'skipped'].includes(row?.result) || isReportedInconclusive(row)) ? 0 : 1;
}

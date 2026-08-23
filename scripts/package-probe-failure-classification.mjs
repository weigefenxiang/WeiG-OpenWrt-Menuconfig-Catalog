// SPDX-FileCopyrightText: 2026 weigefenxiang <weigefenxiang@gmail.com>
// SPDX-License-Identifier: GPL-3.0-or-later

import { createHash } from 'node:crypto';

export const TARGET_PREREQUISITE_CAUSES = Object.freeze([
  'patch-apply',
  'toolchain-kernel-version',
  // Host-side tool/header mismatches are deterministic Base Profile
  // failures, but must remain source-independent.  Do not key these on a
  // particular release, package, or build tool name.
  'host-toolchain-compatibility',
  'legacy-host-headers',
  'kernel-prerequisite',
  // Kconfig is a second (kernel-owned) resolver.  Keep its EOF/syncconfig
  // failure as a generic cause; the concrete symbol is deliberately not
  // part of the classifier contract.
  'kernel-kconfig-sync-eof',
  'package-output-missing',
  'target-artifact-missing',
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
  if (isMemoryExhaustion(text)) return true;
  // Only the terminal error is authoritative for network classification.
  // A fallback sequence may contain an early 404/403 while eventually
  // reaching a deterministic package error; scanning the entire log would
  // incorrectly turn that build failure into infrastructure noise.
  const terminal = extractFailureErrors(text).terminalError || text;
  if (/Hash check failed|download failed|No more (?:mirrors?|fallbacks?)(?:\s+to\s+try)?|Connection timed out|Could not resolve host|RPC failed|HTTP\s+(?:403|404|429|5\d\d)|returned error:\s*(?:403|404|429|5\d\d)|curl:\s*\([^)]*\)\s*(?:HTTP\s+)?(?:403|404|429|5\d\d)|expected ['"]?packfile|early EOF|Connection reset|TLS.*(?:error|failed)|GnuTLS.*error|SSL.*(?:error|failed)/i.test(terminal)) return true;
  if (/(?:^|[\s:])(?:timed\s*out|timeout:)/i.test(terminal)) return true;
  return /No rule to make target[^\n]*build_dir[^\n]*\/linux-[^/\s]+\/linux-[^/\s]+\/\.config/i.test(text);
}

export function isCommandInfrastructureFailure(result) {
  return Number(result?.code) === -1 || isMakeInfrastructureFailure(result?.output);
}

function causeFromLines(lines) {
  const text = lines.join('\n');
  const substantiveLines = lines.filter((line) => !/^(?:ERROR:\s*)?(?:package|tools|toolchain|target)(?:\/[A-Za-z0-9_./+@-]+)?\s+failed to build\s*$/i.test(String(line || '').trim()));
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
  // Keep concrete kernel/module and Target artifact failures ahead of the
  // broad host-toolchain matcher.  Old trees often print a generic compiler
  // or DTC wrapper after the real `.ko`/firmware output is missing; the
  // concrete observation is the attribution boundary.
  if (lines.some((line) => /(?:\bmodule\b|\bkmod[-_A-Za-z0-9./+@:-]*\b)[^\n]*(?:(?:\.ko\b)[^\n]*(?:missing|not found|does not exist)|(?:missing|not found|does not exist)[^\n]*(?:\.ko\b))/i.test(line) ||
      /\.ko\b[^\n]*(?:missing|not found|does not exist)/i.test(line))) {
    return 'kernel-prerequisite';
  }
  if (lines.some((line) => /(?:target|firmware|image|artifact)[^\n]*(?:(?:\.bin\b|\.img\b|\.itb\b|\.dtb\b)[^\n]*(?:missing|not\s+found|does\s+not\s+exist)|(?:missing|not\s+found|does\s+not\s+exist)[^\n]*(?:\.bin\b|\.img\b|\.itb\b|\.dtb\b))/i.test(line))) {
    return 'target-artifact-missing';
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
  // Old upstream trees can fail before their selected package is reached
  // because the host-side libc/toolchain requires newer Linux headers.  The
  // wording varies between build systems; classify the relationship rather
  // than a concrete kernel version or distribution.  These checks come after
  // concrete output/module evidence so a wrapper cannot hide the missing
  // artifact that actually determines the result.
  if (substantiveLines.some((line) => /available\s+kernel headers are (?:older|too old)/i.test(line))) {
    return 'toolchain-kernel-version';
  }
  if (substantiveLines.some((line) => /(?:linux|kernel)\s+headers?[^\n]*(?:older|too old|outdated|minimum|required|unsupported|not supported)/i.test(line) ||
      /(?:minimum|required|supported|unsupported)[^\n]*(?:linux|kernel)\s+headers?/i.test(line))) {
    return 'legacy-host-headers';
  }
  // DTC/yylloc and similar host-side linker failures are deterministic host
  // compatibility failures, but only after concrete output/module checks
  // above have had a chance to identify the real missing artifact.
  if (substantiveLines.some((line) => /(?:\bdtc\b|device\s+tree\s+compiler|\byylloc\b)[^\n]*(?:undefined|incompatible|unsupported|not\s+supported|requires|cannot|can't|failed|version|multiple\s+definition|duplicate\s+symbol)/i.test(line) ||
      /(?:multiple\s+definition|duplicate\s+symbol)[^\n]*\byylloc\b/i.test(line))) {
    return 'host-toolchain-compatibility';
  }
  // A host toolchain incompatibility is deterministic when the build
  // explicitly reports an unsupported host compiler/header/toolchain or a
  // required host capability/version.  Keep the matcher intentionally broad
  // so it applies equally to every Source/Branch and host tool.
  if (substantiveLines.some((line) => /(?:host|build-host|toolchain)[^\n]*(?:incompatible|unsupported|not supported|requires|cannot|can't|failed|version)/i.test(line) ||
      /(?:compiler|standard library|build tool)[^\n]*(?:incompatible|unsupported|not supported|requires|cannot|can't|failed|version)/i.test(line))) {
    return 'host-toolchain-compatibility';
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
  return extractFailureErrors(value).terminalError;
}

function normalizedErrorLine(line) {
  return String(line || '').replace(/\s+/g, ' ').trim().slice(0, 320);
}

function isRecoverableErrorLine(line) {
  const text = String(line || '');
  // Mirror probes commonly emit one or more 403/404/5xx/curl failures before
  // trying the next URL.  These are evidence, not the terminal cause, unless
  // the log also says that no fallback remains.
  if (/no more (?:mirrors?|fallbacks?)(?:\s+to\s+try)?/i.test(text)) return false;
  return /(?:curl:\s*\([^)]*\)[^\n]*(?:403|404|429|5\d\d)|HTTP\/\d(?:\.\d)?\s+(?:403|404|429|5\d\d)|\b(?:403|404|429|5\d\d)\b[^\n]*(?:download|fetch|mirror|url)|(?:download|fetch|mirror)[^\n]*(?:403|404|429|5\d\d))/i.test(text);
}

function isTerminalErrorLine(line) {
  const text = String(line || '');
  if (!text) return false;
  if (/no more (?:mirrors?|fallbacks?)(?:\s+to\s+try)?/i.test(text)) return true;
  if (/^(?:ERROR:\s*)?(?:package|tools|toolchain|target)\/[A-Za-z0-9_./+@-]+\s+failed to build\s*$/i.test(text)) return false;
  if (/^make(?:\[\d+\])?:\s+\*{3}\s+.*\bError\s+\d+/i.test(text)) return false;
  return /(?:\bfatal\s+error\b|\berror\s*:\b|\berror\s+in\s+reading\b|\bend\s+of\s+file\b|\bfailed(?:\s+to)?\b|\bis\s+missing\b|\bnot found\b|\bdoes not exist\b|\bno rule to make target\b|\bpatch failed\b|\bhunk(?:\s+#?\d+)?\s+failed\b|\bundefined reference\b|\breturned non-zero\b|\bcannot\b|\bcan't\b)/i.test(text);
}

/**
 * Separate transient mirror/download observations from the terminal error.
 * The first 404 in a fallback sequence must never become the displayed root
 * cause.  The returned strings are normalized and stable for evidence and
 * fingerprints.
 */
export function extractFailureErrors(value) {
  const lines = stripAnsi(value).split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const recoverableErrors = [];
  const terminalCandidates = [];
  const wrapperCandidates = [];
  for (const line of lines) {
    const normalized = normalizedErrorLine(line);
    if (isRecoverableErrorLine(line)) recoverableErrors.push(normalized);
    if (/^(?:ERROR:\s*)?(?:package|tools|toolchain|target)\/[A-Za-z0-9_./+@-]+\s+failed to build\s*$/i.test(line) ||
        /^make(?:\[\d+\])?:\s+\*{3}\s+.*\bError\s+\d+/i.test(line)) wrapperCandidates.push(normalized);
    if (isTerminalErrorLine(line)) terminalCandidates.push(normalized);
  }
  const uniqueRecoverable = [...new Set(recoverableErrors)];
  // Prefer the last specific terminal line.  Outer Make wrappers are excluded
  // above; if a log has no inner detail, retain the last wrapper/error line.
  const terminalError = terminalCandidates.length
    ? terminalCandidates[terminalCandidates.length - 1]
    : wrapperCandidates.length ? wrapperCandidates[wrapperCandidates.length - 1]
      : (uniqueRecoverable.length ? uniqueRecoverable[uniqueRecoverable.length - 1] : '');
  return { recoverableErrors: uniqueRecoverable, terminalError };
}

export function classifyPrerequisiteFailure(value) {
  const text = stripAnsi(value);
  const cause = causeFromLines(text.split(/\r?\n/));
  const errors = extractFailureErrors(text);
  const errorSummary = errors.terminalError;
  const failedBuildTargets = extractFailedBuildTargets(text);
  return {
    cause: isAllowedTargetPrerequisiteCause(cause) ? cause : '',
    errorSummary,
    terminalError: errors.terminalError,
    recoverableErrors: errors.recoverableErrors,
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
      terminalError: detail.terminalError, recoverableErrors: detail.recoverableErrors,
      failureFingerprint: detail.failureFingerprint };
  }
  const cause = detail.cause;
  if (isAllowedTargetPrerequisiteCause(cause)) {
    return { result: 'inconclusive', reason: 'target-prerequisite-failure', cause,
      errorSummary: detail.errorSummary, failedBuildTargets: detail.failedBuildTargets,
      terminalError: detail.terminalError, recoverableErrors: detail.recoverableErrors,
      failureFingerprint: detail.failureFingerprint };
  }
  return { result: 'inconclusive', reason: 'target-prerequisite-unattributed-failure', cause: '',
    errorSummary: detail.errorSummary, failedBuildTargets: detail.failedBuildTargets,
    terminalError: detail.terminalError, recoverableErrors: detail.recoverableErrors,
    failureFingerprint: detail.failureFingerprint };
}

// A replay can be unable to reproduce the shared target because its isolated
// workspace does not satisfy a known Make-directory contract.  This is a
// complete transport/capability observation (not compatibility evidence),
// but it is safe to report as a green structured result when the stage, target,
// and error are all present.  Unknown failures must continue through the red
// unresolved path.
export function isReportedCounterfactualReplayUnavailable(row) {
  if (row?.result !== 'inconclusive' || row?.reason !== 'counterfactual-replay-unavailable') return false;
  const counterfactual = row?.counterfactual || {};
  const stage = String(counterfactual.stage || '');
  const target = String(counterfactual.target || '').trim();
  const errorSummary = String(counterfactual.errorSummary || counterfactual.error || row?.errorSummary || '').trim();
  if (counterfactual.result !== 'unavailable' || !['bootstrap', 'prepare'].includes(stage) || !target || !errorSummary) return false;
  if (!Array.isArray(row?.issues)) return !('conclusion' in (row || {})) && !('schema' in (row || {}));
  return row.issues.some((issue) => issue?.type === 'counterfactual-replay-unavailable' &&
    String(issue.stage || '') === stage && String(issue.target || '') === target &&
    String(issue.errorSummary || '').trim() === errorSummary);
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
  if (reason === 'counterfactual-replay-unavailable') return isReportedCounterfactualReplayUnavailable(row);
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

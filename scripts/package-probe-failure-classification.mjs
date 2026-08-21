// SPDX-FileCopyrightText: 2026 weigefenxiang <weigefenxiang@gmail.com>
// SPDX-License-Identifier: GPL-3.0-or-later

export const TARGET_PREREQUISITE_CAUSES = Object.freeze([
  'patch-apply',
  'toolchain-kernel-version',
  'kernel-prerequisite',
  'target-build',
]);

const TARGET_PREREQUISITE_CAUSE_SET = new Set(TARGET_PREREQUISITE_CAUSES);

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

function causeFromLines(lines) {
  if (lines.some((line) => /\b(?:Patch failed|Hunk(?:\s+#?\d+)?\s+FAILED|can't find file to patch)\b/i.test(line))) {
    return 'patch-apply';
  }
  if (lines.some((line) => /(?:available\s+kernel headers are (?:older|too old)|kernel headers?[^\n]*(?:older|too old)\b)/i.test(line))) {
    return 'toolchain-kernel-version';
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

export function classifyTargetPrerequisiteFailure(value) {
  const text = String(value || '');
  if (isMakeInfrastructureFailure(text)) {
    return { result: 'inconclusive', reason: 'target-prerequisite-infrastructure', cause: '' };
  }
  const cause = causeFromLines(text.split(/\r?\n/));
  if (isAllowedTargetPrerequisiteCause(cause)) {
    return { result: 'inconclusive', reason: 'target-prerequisite-failure', cause };
  }
  return { result: 'inconclusive', reason: 'target-prerequisite-unattributed-failure', cause: '' };
}

export function isReportedInconclusive(row) {
  return row?.result === 'inconclusive' && row?.reason === 'target-prerequisite-failure' &&
    isAllowedTargetPrerequisiteCause(row?.targetPrerequisiteCause);
}

export function probeResultExitCode(rows) {
  return rows.every((row) => ['compatible', 'incompatible', 'skipped'].includes(row?.result) || isReportedInconclusive(row)) ? 0 : 1;
}

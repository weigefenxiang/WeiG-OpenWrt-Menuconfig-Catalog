#!/usr/bin/env node
// SPDX-FileCopyrightText: 2026 weigefenxiang <weigefenxiang@gmail.com>
// SPDX-License-Identifier: GPL-3.0-or-later
import { appendFileSync, chmodSync, createReadStream, createWriteStream, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createGunzip } from 'node:zlib';
import { basename, dirname, join, relative, resolve } from 'node:path';

const DEPTHS = Object.freeze({ 'boot-smoke': 5, 'runtime-health': 6, 'reboot-validation': 7 });
const PACKAGE_RE = /^[A-Za-z0-9][A-Za-z0-9+_.@-]{0,95}$/;
const READY_RE = /(?:procd:\s+- init complete -|Please press Enter to activate this console|(?:^|\n)[^\n]*\blogin:\s*$|(?:^|\n)root@[^\n]*[#$]\s*$)/im;
const ROOT_PROMPT_RE = /(?:^|\n)root@[^\n]*[#$]\s*$/im;
const PANIC_RE = /Kernel panic|not syncing|Oops:\s|BUG:\s+unable to handle|watchdog:\s+BUG|rebooting in \d+ seconds/i;
const REBOOT_RE = /(?:reboot:\s+Restarting system|Restarting system|machine restart|reboot requested)/i;
const UNSUPPORTED_RE = /unknown (?:target|subtarget)|target .* is not supported|unsupported|no such file or directory.*(?:kernel|rootfs|combined|image)|cannot find.*(?:kernel|rootfs|image)|unable to find image|could not open .*no such file or directory/i;
const HOST_ERROR_RE = /(?:qemu-system-[^:\s]+:\s+command not found|exec:\s+qemu-system|failed to initialize kvm|Could not access KVM|permission denied.*qemu|permission denied.*(?:image|disk)|cannot set up guest memory|No space left on device|failed to create.*(?:tap|bridge)|qemu: could not open)/i;
const IMAGE_RE = /(?:\.img|\.qcow2|\.raw|\.vmdk|\.vdi|\.iso|\.efi|\.elf|\.bin)(?:\.gz)?$/i;
const COMPRESSED_RE = /\.gz$/i;
const UNSAFE_ARTIFACT_RE = /(?:\.sha256(?:sum)?|\.manifest|\.json|\.txt|\.sig)(?:\.gz)?$/i;
const QEMUSTART_OPTION_NAMES = Object.freeze(['--rootfs', '--kernel']);
const DEFAULT_MAX_ARTIFACT_BYTES = 2 * 1024 * 1024 * 1024;

const nowIso = () => new Date().toISOString();

function startStage(stages, name) {
  stages[name] = { status: 'running', startedAt: nowIso(), durationMs: 0 };
  return Date.now();
}

function finishStage(stages, name, started, status) {
  stages[name] = {
    ...(stages[name] || { startedAt: nowIso() }),
    status,
    finishedAt: nowIso(),
    durationMs: Math.max(0, Date.now() - Number(started || Date.now())),
  };
}

function virtualDeepestPassedLevel(stages) {
  if (stages.secondRuntimeHealth?.status === 'success') return 7;
  if (stages.runtimeHealth?.status === 'success') return 6;
  if (stages.secondBoot?.status === 'success') return 5;
  if (stages.boot?.status === 'success') return 5;
  return 4;
}

export function virtualProbeDepth(mode) {
  const depth = DEPTHS[String(mode || '')];
  if (!depth) throw new Error(`unsupported virtual Probe mode: ${mode}`);
  return depth;
}

export function virtualReady(text) {
  return READY_RE.test(String(text || ''));
}

export function virtualPanic(text) {
  return PANIC_RE.test(String(text || ''));
}

function artifactKind(name) {
  const lower = String(name || '').toLowerCase();
  if (lower.includes('combined')) return 'combined';
  if (lower.includes('rootfs')) return 'rootfs';
  if (lower.includes('efi')) return 'efi';
  if (lower.includes('kernel') || lower.includes('initramfs')) return 'kernel';
  // A `.bin` named factory/sysupgrade/firmware is often a router flash
  // image, not a QEMU block image.  Only explicit disk-container extensions
  // establish the generic disk-image capability; vendor-specific names stay
  // opaque and therefore cannot be handed to --rootfs.
  if (/\.(?:img|qcow2|raw|vmdk|vdi|iso)(?:\.gz)?$/.test(lower)) return 'disk-image';
  return 'image';
}

function artifactScore(entry) {
  const name = String(entry.name || '').toLowerCase();
  const kind = entry.kind;
  const score = kind === 'combined' ? 500 : kind === 'efi' ? 400 : kind === 'rootfs' ? 300 : kind === 'kernel' ? 200 : kind === 'disk-image' ? 150 : 0;
  const bootable = /(?:squashfs|ext4|jffs2|combined|efi|rootfs|disk|generic)/.test(name) ? 50 : 0;
  const compressed = COMPRESSED_RE.test(name) ? -2 : 0;
  return score + bootable + compressed;
}

function collectFiles(directory, root = directory) {
  if (!existsSync(directory)) return [];
  const rows = [];
  for (const name of readdirSync(directory)) {
    const file = join(directory, name);
    let stat;
    try { stat = statSync(file); } catch { continue; }
    if (stat.isDirectory()) rows.push(...collectFiles(file, root));
    else if (stat.isFile()) rows.push({ path: file, relativePath: relative(root, file).replace(/\\/g, '/'), name });
  }
  return rows;
}

/**
 * Locate build output by its actual filename.  The old implementation
 * delegated filename selection to qemustart, which assumes an OpenWrt prefix
 * and therefore misses ImmortalWrt/LEDE images.  This function deliberately
 * only inspects the target's bin directory and never manufactures a filename.
 */
export function scanFirmwareArtifacts(workdir, targetSystem, subtarget) {
  const directory = resolve(workdir, 'bin', 'targets', String(targetSystem || ''), String(subtarget || ''));
  const artifacts = collectFiles(directory, directory)
    .filter((entry) => IMAGE_RE.test(entry.name) && !UNSAFE_ARTIFACT_RE.test(entry.name))
    .map((entry) => ({ ...entry, kind: artifactKind(entry.name) }))
    .sort((a, b) => artifactScore(b) - artifactScore(a) || a.relativePath.localeCompare(b.relativePath));
  return { directory, artifacts };
}

function safeArtifactPath(root, name) {
  const destination = resolve(root, name);
  const base = `${resolve(root)}${process.platform === 'win32' ? '\\' : '/'}`;
  if (destination !== resolve(root) && !destination.startsWith(base)) {
    throw new Error(`unsafe virtual firmware artifact path: ${name}`);
  }
  return destination;
}

/**
 * Decompress a selected .gz artifact into the probe-owned temporary folder.
 * The source remains untouched and the destination is guaranteed to stay
 * below the work directory.
 */
function boundedArtifactStream(maxBytes) {
  let total = 0;
  return new Transform({
    transform(chunk, encoding, callback) {
      total += chunk.length;
      if (total > maxBytes) {
        const error = new Error(`virtual firmware artifact exceeds ${maxBytes} bytes`);
        error.code = 'VIRTUAL_ARTIFACT_LIMIT';
        callback(error);
        return;
      }
      callback(null, chunk);
    },
  });
}

export async function materializeFirmwareArtifact(entry, workdir, artifactDirectory = join(workdir, '.probe-artifacts'), maxArtifactBytes = DEFAULT_MAX_ARTIFACT_BYTES) {
  if (!entry?.path) return null;
  const workRoot = resolve(workdir);
  const artifactRoot = resolve(artifactDirectory);
  const workPrefix = `${workRoot}${process.platform === 'win32' ? '\\' : '/'}`;
  if (artifactRoot !== workRoot && !artifactRoot.startsWith(workPrefix)) {
    throw new Error(`virtual firmware artifact directory escapes Probe workdir: ${artifactDirectory}`);
  }
  mkdirSync(artifactRoot, { recursive: true });
  const source = resolve(entry.path);
  const sourceName = basename(source);
  const outputName = sourceName.replace(/\.gz$/i, '');
  const destination = safeArtifactPath(artifactRoot, outputName);
  if (!COMPRESSED_RE.test(sourceName)) return { ...entry, path: source, materialized: false };
  const numericLimit = Number(maxArtifactBytes);
  const byteLimit = Number.isFinite(numericLimit) && numericLimit > 0 ? numericLimit : DEFAULT_MAX_ARTIFACT_BYTES;
  try {
    await pipeline(
      createReadStream(source),
      createGunzip(),
      boundedArtifactStream(byteLimit),
      createWriteStream(destination, { flags: 'w', mode: 0o600 }),
    );
    chmodSync(destination, 0o600);
  } catch (error) {
    rmSync(destination, { force: true });
    throw error;
  }
  return { ...entry, path: destination, materialized: true, sourcePath: source };
}

function stripShellComments(text) {
  return String(text || '').split(/\r?\n/).map((line) => {
    let quote = '';
    let escaped = false;
    for (let index = 0; index < line.length; index += 1) {
      const character = line[index];
      if (escaped) { escaped = false; continue; }
      if (quote === '"' && character === '\\') { escaped = true; continue; }
      if (quote && character === quote) { quote = ''; continue; }
      if (!quote && (character === '"' || character === "'" || character === '`')) { quote = character; continue; }
      if (!quote && character === '#' && (index === 0 || /\s/.test(line[index - 1]))) return line.slice(0, index);
    }
    return line;
  }).join('\n');
}

function parsedCaseOptions(text) {
  const options = new Set();
  // A bare option label is the interface we can invoke as two argv entries:
  // `--rootfs PATH`.  Patterns such as `--rootfs=*` are intentionally not
  // accepted because passing a separate path would not exercise that parser.
  const caseBlockRe = /\bcase\b[^;\n]*\bin\b([\s\S]*?)\besac\b/gi;
  const labelRe = /(?:^|[|\n;])\s*["']?(--rootfs|--kernel)["']?\s*(?=\)|\|)/gi;
  for (const block of text.matchAll(caseBlockRe)) {
    for (const label of String(block[1] || '').matchAll(labelRe)) options.add(label[1].toLowerCase());
  }
  return options;
}

function parsedGetoptOptions(text) {
  const options = new Set();
  // GNU getopt's long-option declaration is also an authoritative parser
  // boundary.  Require an actual getopt command segment, rather than an
  // echo/usage string, and only accept the two options used by qemustart.
  const commandRe = /(?:^|[;&|(`$])\s*(?:command\s+)?(?:gnu-)?getopt\b[^\n]*/g;
  for (const command of text.matchAll(commandRe)) {
    const line = String(command[0] || '');
    if (!/(?:--long(?:=|\s+)|--longoptions(?:=|\s+))/i.test(line)) continue;
    for (const option of QEMUSTART_OPTION_NAMES) {
      const name = option.slice(2);
      if (new RegExp(`(?:^|[\\s,=:])${name}(?::|[\\s,=:]|$)`, 'i').test(line)) options.add(option);
    }
  }
  return options;
}

/**
 * Detect qemustart's supported, documented image options from its parser,
 * not from comments or usage text.  OpenWrt-family qemustart scripts expose
 * --rootfs/--kernel; no speculative --image/--disk alias is accepted.  A
 * script with no verifiable parser is not safe to invoke for non-OpenWrt
 * prefixes, so callers must report virtual-boot-unsupported.
 */
export function detectQemuStartInterface(qemustart) {
  if (!existsSync(qemustart)) return { supported: false, options: [], reason: 'missing-qemustart' };
  let text = '';
  try { text = readFileSync(qemustart, 'utf8'); } catch { return { supported: false, options: [], reason: 'qemustart-unreadable' }; }
  const source = stripShellComments(text);
  const options = [...new Set([...parsedCaseOptions(source), ...parsedGetoptOptions(source)])]
    .filter((option) => QEMUSTART_OPTION_NAMES.includes(option));
  if (!options.length) return { supported: false, options, reason: 'qemustart-no-artifact-option' };
  const rootfs = options.find((option) => option === '--rootfs') || '';
  const kernel = options.find((option) => option === '--kernel') || '';
  return { supported: Boolean(rootfs || kernel), options, rootfsOption: rootfs, kernelOption: kernel };
}

function selectFirmwareArtifacts(workdir, targetSystem, subtarget, qemuInterface) {
  const scanned = scanFirmwareArtifacts(workdir, targetSystem, subtarget);
  // A combined/EFI image is a partitioned disk image, not a raw filesystem.
  // Passing it through qemustart's --rootfs makes the guest mount the whole
  // disk (for example /dev/vda) and creates a false Baseline-B boot blocker.
  // Only an explicitly rootfs-only artifact is safe for --rootfs.  Combined,
  // factory, sysupgrade, and opaque vendor blobs remain inventory evidence;
  // without an upstream option that proves a safe disk/partition consumer the
  // virtual phase is an honest capability skip at L4.
  const rootfs = scanned.artifacts.find((entry) => entry.kind === 'rootfs');
  const kernel = scanned.artifacts.find((entry) => entry.kind === 'kernel');
  const selectedRootfs = qemuInterface.rootfsOption ? (rootfs || null) : null;
  // A kernel is only meaningful to this adapter together with a verified
  // rootfs path.  A kernel-only qemustart may fall back to its own prefix-based
  // disk lookup, which is precisely the unsafe behavior this scanner avoids.
  const selectedKernel = selectedRootfs && qemuInterface.kernelOption ? kernel : null;
  return { ...scanned, selectedRootfs, selectedKernel };
}

async function virtualArtifacts(options, qemustart, targetSystem, subtarget) {
  const qemuInterface = detectQemuStartInterface(qemustart);
  // Keep the artifact inventory even when the current qemustart cannot
  // consume an explicit path.  The caller can then distinguish “firmware was
  // built, but virtual boot is unsupported” from “the firmware output itself
  // is absent” without guessing from a brand prefix.
  const scanned = scanFirmwareArtifacts(options.workdir, targetSystem, subtarget);
  if (!qemuInterface.supported) return { qemuInterface, scanned };
  const selected = selectFirmwareArtifacts(options.workdir, targetSystem, subtarget, qemuInterface);
  // Only pass artifacts through options the actual qemustart script exposes.
  // A script that accepts --kernel but not --rootfs must not silently fall
  // back to its prefix-based default rootfs lookup.
  const selectedRootfs = qemuInterface.rootfsOption ? selected.selectedRootfs : null;
  const selectedKernel = qemuInterface.kernelOption ? selected.selectedKernel : null;
  if (!selectedRootfs && !selectedKernel) return { qemuInterface, scanned, selectedRootfs: null, selectedKernel: null };
  const artifactDirectory = options.artifactDirectory || join(options.workdir, '.probe-artifacts');
  const maxArtifactBytes = options.maxArtifactBytes;
  const materializedRootfs = selectedRootfs ? await materializeFirmwareArtifact(selectedRootfs, options.workdir, artifactDirectory, maxArtifactBytes) : null;
  const materializedKernel = selectedKernel ? await materializeFirmwareArtifact(selectedKernel, options.workdir, artifactDirectory, maxArtifactBytes) : null;
  return { qemuInterface, scanned, selectedRootfs: materializedRootfs, selectedKernel: materializedKernel };
}

function markerLine(text, marker) {
  return String(text || '').split(/\r?\n/).some((line) => line.trim() === marker);
}

export function healthCommand(packages = [], cycle = 1) {
  const roots = [...new Set(packages.map((row) => String(row || '')).filter(Boolean))];
  if (roots.some((root) => !PACKAGE_RE.test(root))) throw new Error('virtual health package list is invalid');
  const begin = `__WEIG_HEALTH_BEGIN_${cycle}__`;
  const pass = `__WEIG_HEALTH_PASS_${cycle}__`;
  const fail = `__WEIG_HEALTH_FAIL_${cycle}__`;
  return [
    `echo ${begin}`,
    '__weig_ok=1',
    'test -d /proc || __weig_ok=0',
    'test -d /sys || __weig_ok=0',
    'test -d /tmp || __weig_ok=0',
    '(pidof procd >/dev/null 2>&1 || pidof init >/dev/null 2>&1) || __weig_ok=0',
    'uptime >/dev/null 2>&1 || __weig_ok=0',
    'if command -v ubus >/dev/null 2>&1; then ubus call system board >/dev/null 2>&1 || __weig_ok=0; fi',
    ...(roots.length ? [
      'if command -v apk >/dev/null 2>&1; then',
      ...roots.map((root) => `apk info -e "${root}" >/dev/null 2>&1 || __weig_ok=0`),
      'elif command -v opkg >/dev/null 2>&1; then',
      ...roots.map((root) => `opkg status "${root}" 2>/dev/null | grep -q '^Status:.* installed' || __weig_ok=0`),
      'fi',
    ] : []),
    `[ "$__weig_ok" = 1 ] && echo ${pass} || echo ${fail}`,
  ].join('\n') + '\n';
}

export function virtualBootOutcome(text, comparisonPhase = 'final') {
  if (UNSUPPORTED_RE.test(text)) return { result: 'skipped', reason: 'virtual-boot-unsupported' };
  if (HOST_ERROR_RE.test(text)) return { result: 'inconclusive', reason: 'virtual-runner-infrastructure' };
  return comparisonPhase === 'baseline'
    ? { result: 'blocked', reason: 'base-profile-boot-failure' }
    : { result: 'incompatible', reason: 'final-boot-failed' };
}

export async function runVirtualProbe(options = {}) {
  const mode = String(options.mode || 'boot-smoke');
  const depth = virtualProbeDepth(mode);
  const workdir = String(options.workdir || '');
  const qemustart = join(workdir, 'scripts', 'qemustart');
  const logFile = String(options.logFile || join(workdir, 'probe-virtual.log'));
  const bootTimeoutMs = Math.max(100, Number(options.bootTimeoutMs || 180_000));
  const controlTimeoutMs = Math.max(100, Number(options.controlTimeoutMs || 30_000));
  const observationMs = Math.max(0, Number(options.observationMs ?? 15_000));
  const controlDelayMs = Math.max(0, Number(options.controlDelayMs ?? 500));
  const spawnProcess = options.spawnProcess || spawn;
  const targetSystem = String(options.targetSystem || '');
  const subtarget = String(options.subtarget || '');
  // The caller must identify which side of an A/B pair is running.  Final-A
  // boot failures are plugin-visible incompatibilities; only a deterministic
  // Baseline-B boot failure is a Base Profile blocker.
  const comparisonPhase = String(options.phase || 'final');
  const installedRoots = options.installedRoots || [];
  const stages = {};
  const capabilities = { qemustart: existsSync(qemustart), serialControl: false, rebootControl: false, firmware: false,
    qemustartOptions: [], artifactDirectory: '' };
  mkdirSync(dirname(logFile), { recursive: true });
  if (!capabilities.qemustart || !targetSystem || !subtarget) {
    return { result: 'skipped', reason: 'virtual-boot-unsupported', deepestPassedLevel: 4, runtimeCovered: false, stages, capabilities, logFile };
  }

  let artifacts;
  try { artifacts = await virtualArtifacts(options, qemustart, targetSystem, subtarget); }
  catch (error) {
    const infrastructure = ['EACCES', 'EPERM', 'ENOSPC', 'EMFILE', 'ENFILE'].includes(String(error?.code || '')) ||
      /(?:permission denied|no space left|too many open files)/i.test(String(error?.message || error));
    return { result: infrastructure ? 'inconclusive' : 'skipped',
      reason: infrastructure ? 'virtual-runner-infrastructure' : 'virtual-boot-unsupported', deepestPassedLevel: 4, runtimeCovered: false, stages, capabilities,
      logFile, errorSummary: String(error?.message || error) };
  }
  capabilities.qemustartOptions = artifacts.qemuInterface.options || [];
  capabilities.artifactDirectory = artifacts.selectedRootfs?.path || artifacts.selectedKernel?.path || '';
  capabilities.firmware = Boolean(artifacts.selectedRootfs || artifacts.selectedKernel);
  if (!artifacts.qemuInterface.supported || !artifacts.selectedRootfs) {
    return { result: 'skipped', reason: 'virtual-boot-unsupported', deepestPassedLevel: 4, runtimeCovered: false, stages, capabilities, logFile,
      firmwareDirectory: artifacts.scanned.directory, firmwareArtifacts: artifacts.scanned.artifacts || [] };
  }

  return await new Promise((resolvePromise) => {
    let child;
    let transcript = '';
    let phase = 'boot';
    let phaseOffset = 0;
    let phaseStarted = startStage(stages, 'boot');
    let timer = null;
    let observationTimer = null;
    let settled = false;
    let resolved = false;
    let pendingOutcome = null;
    let rebootBoundary = false;

    const append = (chunk) => {
      const text = String(chunk || '');
      transcript += text;
      appendFileSync(logFile, text);
      options.onOutput?.(text);
      inspect();
    };

    const clearTimers = () => {
      if (timer) clearTimeout(timer);
      if (observationTimer) clearTimeout(observationTimer);
      timer = null;
      observationTimer = null;
    };

    const writeStdin = (text) => {
      if (!child?.stdin || child.stdin.destroyed || child.stdin.writableEnded) return false;
      try {
        child.stdin.write(text);
        return true;
      } catch {
        return false;
      }
    };

    const stop = () => {
      if (!child || child.killed) return;
      writeStdin('\x01x');
      const killer = setTimeout(() => { try { child.kill('SIGTERM'); } catch { /* process already closed */ } }, 500);
      killer.unref?.();
    };

    const resolveOutcome = () => {
      if (resolved || !pendingOutcome) return;
      resolved = true;
      resolvePromise(pendingOutcome);
    };

    const finish = (result, reason = '') => {
      if (settled) return;
      settled = true;
      clearTimers();
      pendingOutcome = { result, reason, stages, capabilities, logFile, transcript,
        deepestPassedLevel: virtualDeepestPassedLevel(stages), runtimeCovered: result === 'compatible',
        firmwareArtifacts: artifacts.scanned.artifacts || [] };
      stop();
      if (!child || child.exitCode !== null) resolveOutcome();
      else {
        const fallback = setTimeout(() => {
          try { child.kill('SIGKILL'); } catch { /* process already closed */ }
          resolveOutcome();
        }, 1_500);
        fallback.unref?.();
      }
    };

    const failActiveStage = (reason, result = 'incompatible') => {
      const stage = phase === 'health1' || phase === 'console1' ? 'runtimeHealth' : phase === 'reboot' ? 'reboot' :
        phase === 'secondBoot' ? 'secondBoot' : phase === 'health2' || phase === 'console2' ? 'secondRuntimeHealth' : 'boot';
      finishStage(stages, stage, phaseStarted, result === 'skipped' ? 'skipped' : 'failure');
      finish(result, reason);
    };

    const arm = (milliseconds, handler) => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(handler, milliseconds);
    };

    const observeThenFinish = () => {
      if (!observationMs) return finish('compatible');
      observationTimer = setTimeout(() => finish('compatible'), observationMs);
    };

    const sendHealth = (cycle, stageStarted = false) => {
      phase = cycle === 1 ? 'health1' : 'health2';
      phaseOffset = transcript.length;
      const name = cycle === 1 ? 'runtimeHealth' : 'secondRuntimeHealth';
      if (!stageStarted) phaseStarted = startStage(stages, name);
      const sender = setTimeout(() => {
        if (settled) return;
        if (!writeStdin(healthCommand(installedRoots, cycle))) {
          failActiveStage(cycle === 1 ? 'runtime-control-unavailable' : 'final-reboot-health-failed', cycle === 1 ? 'skipped' : 'incompatible');
        }
      }, controlDelayMs);
      sender.unref?.();
      arm(controlDelayMs + controlTimeoutMs, () => failActiveStage(
        cycle === 1 ? 'runtime-control-unavailable' : 'final-reboot-health-failed', cycle === 1 ? 'skipped' : 'incompatible'));
    };

    const acquireConsole = (cycle, current) => {
      phase = cycle === 1 ? 'console1' : 'console2';
      phaseOffset = transcript.length;
      phaseStarted = startStage(stages, cycle === 1 ? 'runtimeHealth' : 'secondRuntimeHealth');
      if (ROOT_PROMPT_RE.test(current)) {
        sendHealth(cycle, true);
        return;
      }
      if (!writeStdin('\n')) {
        failActiveStage(cycle === 1 ? 'runtime-control-unavailable' : 'final-reboot-health-failed', cycle === 1 ? 'skipped' : 'incompatible');
        return;
      }
      arm(controlTimeoutMs, () => failActiveStage(
        cycle === 1 ? 'runtime-control-unavailable' : 'final-reboot-health-failed', cycle === 1 ? 'skipped' : 'incompatible'));
    };

    const requestReboot = () => {
      phase = 'reboot';
      phaseOffset = transcript.length;
      rebootBoundary = false;
      phaseStarted = startStage(stages, 'reboot');
      if (!writeStdin('echo __WEIG_REBOOT_REQUEST__; reboot\n')) {
        failActiveStage('reboot-control-unavailable', 'skipped');
        return;
      }
      arm(controlTimeoutMs, () => failActiveStage(rebootBoundary ? 'final-reboot-failed' : 'reboot-control-unavailable', rebootBoundary ? 'incompatible' : 'skipped'));
    };

    const inspect = () => {
      if (settled) return;
      const current = transcript.slice(phaseOffset);
      if (virtualPanic(current)) {
        failActiveStage(phase === 'boot'
          ? (comparisonPhase === 'baseline' ? 'base-profile-boot-failure' : 'final-boot-failed')
          : phase === 'health1' ? 'final-runtime-failed' : 'final-reboot-failed',
        phase === 'boot' && comparisonPhase === 'baseline' ? 'blocked' : 'incompatible');
        return;
      }
      if (phase === 'boot' && virtualReady(current)) {
        finishStage(stages, 'boot', phaseStarted, 'success');
        if (depth === 5) finish('compatible');
        else acquireConsole(1, current);
        return;
      }
      if (phase === 'console1' || phase === 'console2') {
        if (ROOT_PROMPT_RE.test(current)) {
          clearTimeout(timer); timer = null;
          sendHealth(phase === 'console1' ? 1 : 2, true);
        }
        return;
      }
      if (phase === 'health1') {
        if (markerLine(current, '__WEIG_HEALTH_FAIL_1__')) {
          capabilities.serialControl = true;
          return failActiveStage('final-runtime-failed');
        }
        if (markerLine(current, '__WEIG_HEALTH_PASS_1__')) {
          capabilities.serialControl = true;
          finishStage(stages, 'runtimeHealth', phaseStarted, 'success');
          clearTimeout(timer); timer = null;
          if (depth === 6) observeThenFinish();
          else requestReboot();
        }
        return;
      }
      if (phase === 'reboot') {
        const boundary = current.match(REBOOT_RE);
        if (boundary) {
          rebootBoundary = true;
          capabilities.rebootControl = true;
          finishStage(stages, 'reboot', phaseStarted, 'success');
          phase = 'secondBoot';
          phaseOffset = transcript.length - current.length + Number(boundary.index || 0) + boundary[0].length;
          phaseStarted = startStage(stages, 'secondBoot');
          arm(bootTimeoutMs, () => failActiveStage('final-reboot-failed'));
          queueMicrotask(inspect);
        }
        return;
      }
      if (phase === 'secondBoot' && virtualReady(current)) {
        finishStage(stages, 'secondBoot', phaseStarted, 'success');
        clearTimeout(timer); timer = null;
        acquireConsole(2, current);
        return;
      }
      if (phase === 'health2') {
        if (markerLine(current, '__WEIG_HEALTH_FAIL_2__')) {
          capabilities.serialControl = true;
          return failActiveStage('final-reboot-health-failed');
        }
        if (markerLine(current, '__WEIG_HEALTH_PASS_2__')) {
          capabilities.serialControl = true;
          finishStage(stages, 'secondRuntimeHealth', phaseStarted, 'success');
          clearTimeout(timer); timer = null;
          observeThenFinish();
        }
      }
    };

    try {
      const qemuArgs = [qemustart, targetSystem, subtarget];
      if (artifacts.qemuInterface.rootfsOption && artifacts.selectedRootfs) qemuArgs.push(artifacts.qemuInterface.rootfsOption, artifacts.selectedRootfs.path);
      if (artifacts.qemuInterface.kernelOption && artifacts.selectedKernel) qemuArgs.push(artifacts.qemuInterface.kernelOption, artifacts.selectedKernel.path);
      child = spawnProcess('bash', qemuArgs, {
        cwd: workdir,
        env: { ...process.env, ...(options.env || {}) },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      child.stdin?.on('error', () => {
        // The guest can close its console during shutdown. Active stages remain
        // bounded by their existing response timeout.
      });
      child.stdout?.on('data', append);
      child.stderr?.on('data', append);
      child.on('error', (error) => {
        append(`\nERROR: ${error.message}\n`);
        if (!settled) failActiveStage('virtual-runner-infrastructure', 'inconclusive');
      });
      child.on('close', () => {
        if (settled) { resolveOutcome(); return; }
        if (phase === 'boot') {
          const outcome = virtualBootOutcome(transcript, comparisonPhase);
          failActiveStage(outcome.reason, outcome.result);
        } else if (phase === 'health1') failActiveStage('final-runtime-failed');
        else failActiveStage('final-reboot-failed');
      });
      arm(bootTimeoutMs, () => {
        const outcome = virtualBootOutcome(transcript, comparisonPhase);
        failActiveStage(outcome.reason, outcome.result);
      });
    } catch (error) {
      append(`\nERROR: ${error.message}\n`);
      failActiveStage('virtual-runner-infrastructure', 'inconclusive');
    }
  });
}

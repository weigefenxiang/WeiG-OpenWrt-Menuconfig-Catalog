#!/usr/bin/env node
// SPDX-FileCopyrightText: 2026 weigefenxiang <weigefenxiang@gmail.com>
// SPDX-License-Identifier: GPL-3.0-or-later
import { appendFileSync, existsSync, mkdirSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';

const DEPTHS = Object.freeze({ 'boot-smoke': 5, 'runtime-health': 6, 'reboot-validation': 7 });
const PACKAGE_RE = /^[A-Za-z0-9][A-Za-z0-9+_.@-]{0,95}$/;
const READY_RE = /(?:procd:\s+- init complete -|Please press Enter to activate this console|(?:^|\n)[^\n]*\blogin:\s*$|(?:^|\n)root@[^\n]*[#$]\s*$)/im;
const PANIC_RE = /Kernel panic|not syncing|Oops:\s|BUG:\s+unable to handle|watchdog:\s+BUG|rebooting in \d+ seconds/i;
const REBOOT_RE = /(?:reboot:\s+Restarting system|Restarting system|machine restart|reboot requested)/i;
const UNSUPPORTED_RE = /unknown (?:target|subtarget)|unsupported|no such file or directory.*(?:kernel|rootfs|combined)|cannot find.*(?:kernel|rootfs|image)/i;
const HOST_ERROR_RE = /(?:qemu-system-[^:\s]+:\s+command not found|exec:\s+qemu-system|failed to initialize kvm|Could not access KVM|permission denied.*qemu|No space left on device)/i;

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

function outcomeForBootTranscript(text) {
  if (UNSUPPORTED_RE.test(text)) return { result: 'skipped', reason: 'virtual-boot-unsupported' };
  if (HOST_ERROR_RE.test(text)) return { result: 'inconclusive', reason: 'runner-infrastructure' };
  return { result: 'incompatible', reason: 'final-boot-failed' };
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
  const installedRoots = options.installedRoots || [];
  const stages = {};
  const capabilities = { qemustart: existsSync(qemustart), serialControl: false, rebootControl: false };
  mkdirSync(dirname(logFile), { recursive: true });
  if (!capabilities.qemustart || !targetSystem || !subtarget) {
    return { result: 'skipped', reason: 'virtual-boot-unsupported', stages, capabilities, logFile };
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
      pendingOutcome = { result, reason, stages, capabilities, logFile, transcript };
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
      const stage = phase === 'health1' ? 'runtimeHealth' : phase === 'reboot' ? 'reboot' :
        phase === 'secondBoot' ? 'secondBoot' : phase === 'health2' ? 'secondRuntimeHealth' : 'boot';
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

    const sendHealth = (cycle) => {
      phase = cycle === 1 ? 'health1' : 'health2';
      phaseOffset = transcript.length;
      const name = cycle === 1 ? 'runtimeHealth' : 'secondRuntimeHealth';
      phaseStarted = startStage(stages, name);
      const sender = setTimeout(() => {
        if (settled) return;
        if (!writeStdin(`\n${healthCommand(installedRoots, cycle)}`)) {
          failActiveStage(cycle === 1 ? 'runtime-control-unavailable' : 'final-reboot-health-failed', cycle === 1 ? 'skipped' : 'incompatible');
        }
      }, controlDelayMs);
      sender.unref?.();
      arm(controlDelayMs + controlTimeoutMs, () => failActiveStage(
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
        failActiveStage(phase === 'boot' ? 'final-boot-failed' : phase === 'health1' ? 'final-runtime-failed' : 'final-reboot-failed');
        return;
      }
      if (phase === 'boot' && virtualReady(current)) {
        finishStage(stages, 'boot', phaseStarted, 'success');
        if (depth === 5) finish('compatible');
        else sendHealth(1);
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
        sendHealth(2);
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
      child = spawnProcess('bash', ['scripts/qemustart', targetSystem, subtarget], {
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
        if (!settled) failActiveStage('runner-infrastructure', 'inconclusive');
      });
      child.on('close', () => {
        if (settled) { resolveOutcome(); return; }
        if (phase === 'boot') {
          const outcome = outcomeForBootTranscript(transcript);
          failActiveStage(outcome.reason, outcome.result);
        } else if (phase === 'health1') failActiveStage('final-runtime-failed');
        else failActiveStage('final-reboot-failed');
      });
      arm(bootTimeoutMs, () => {
        const outcome = outcomeForBootTranscript(transcript);
        failActiveStage(outcome.reason, outcome.result);
      });
    } catch (error) {
      append(`\nERROR: ${error.message}\n`);
      failActiveStage('runner-infrastructure', 'inconclusive');
    }
  });
}

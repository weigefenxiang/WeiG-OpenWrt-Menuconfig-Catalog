#!/usr/bin/env node
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { detectQemuStartInterface, healthCommand, materializeFirmwareArtifact, runVirtualProbe, scanFirmwareArtifacts,
  virtualPanic, virtualProbeDepth, virtualReady } from './package-probe-virtual.mjs';

assert.equal(virtualProbeDepth('boot-smoke'), 5);
assert.equal(virtualProbeDepth('runtime-health'), 6);
assert.equal(virtualProbeDepth('reboot-validation'), 7);
assert.throws(() => virtualProbeDepth('plugin-special-case'), /unsupported virtual Probe mode/);
assert(virtualReady('procd: - init complete -\n'));
assert(virtualPanic('Kernel panic - not syncing'));
const health = healthCommand(['alpha', 'beta', 'alpha'], 2);
assert.match(health, /apk info -e/);
assert.match(health, /opkg status/);
assert.equal((health.match(/apk info -e/g) || []).length, 2);
assert.equal((health.match(/opkg status/g) || []).length, 2);
assert.match(health, /__WEIG_HEALTH_PASS_2__/);
assert.throws(() => healthCommand(['bad;reboot'], 1), /package list is invalid/);

const artifactFixture = mkdtempSync(join(tmpdir(), 'probe-virtual-artifacts-'));
try {
  const targetDirectory = join(artifactFixture, 'bin', 'targets', 'x86', '64');
  mkdirSync(targetDirectory, { recursive: true });
  const compressed = join(targetDirectory, 'immortalwrt-x86-64-generic-squashfs-combined.img.gz');
  writeFileSync(compressed, gzipSync(Buffer.from('firmware-fixture')));
  const scan = scanFirmwareArtifacts(artifactFixture, 'x86', '64');
  assert.equal(scan.artifacts.length, 1, 'artifact scanner must find vendor-prefixed compressed images');
  assert.equal(scan.artifacts[0].kind, 'combined');
  const materialized = await materializeFirmwareArtifact(scan.artifacts[0], artifactFixture);
  assert.equal(materialized.materialized, true);
  assert(existsSync(materialized.path), 'compressed firmware must be extracted below probe-owned directory');
  const largeSource = join(artifactFixture, 'large-firmware.img.gz');
  writeFileSync(largeSource, gzipSync(Buffer.alloc(2 * 1024 * 1024, 0x5a)));
  const largeMaterialized = await materializeFirmwareArtifact({ path: largeSource, name: 'large-firmware.img.gz', kind: 'combined' }, artifactFixture,
    join(artifactFixture, 'large-output'), 4 * 1024 * 1024);
  assert.equal(statSync(largeMaterialized.path).size, 2 * 1024 * 1024,
    'firmware extraction must stream a payload larger than the old tiny fixture');
  await assert.rejects(() => materializeFirmwareArtifact({ path: largeSource, name: 'large-firmware.img.gz', kind: 'combined' }, artifactFixture,
    join(artifactFixture, 'bounded-output'), 1024), /exceeds 1024 bytes/,
  'streaming extraction must enforce a bounded output size');
  const parser = join(artifactFixture, 'qemustart-case');
  writeFileSync(parser, '#!/bin/sh\nwhile [ "$#" -gt 0 ]; do\n  case "$1" in\n    --rootfs|--kernel) shift 2 ;;\n    *) shift ;;\n  esac\ndone\n');
  assert.deepEqual(detectQemuStartInterface(parser).options, ['--rootfs', '--kernel'],
    'only real case labels may establish rootfs/kernel support');
  const getoptParser = join(artifactFixture, 'qemustart-getopt');
  writeFileSync(getoptParser, '#!/bin/sh\nopts=$(getopt --long rootfs:,kernel: -- "$@")\n');
  assert.deepEqual(detectQemuStartInterface(getoptParser).options, ['--rootfs', '--kernel'],
    'GNU getopt long-option declarations may establish rootfs/kernel support');
} finally {
  rmSync(artifactFixture, { recursive: true, force: true });
}

function fixtureScript(mode) {
  const behavior = {
    success: `
ready_file="$(mktemp)"
rm -f "$ready_file"
trap 'rm -f "$ready_file"' EXIT
echo 'Please press Enter to activate this console.'
while IFS= read -r line; do
  case "$line" in
    '') (sleep 0.05; touch "$ready_file"; echo 'root@OpenWrt:~#') & ;;
    *__WEIG_HEALTH_BEGIN_1__*) test -f "$ready_file" && echo '__WEIG_HEALTH_PASS_1__' || echo '__WEIG_HEALTH_EARLY_1__' ;;
    *__WEIG_REBOOT_REQUEST__*) rm -f "$ready_file"; echo 'reboot: Restarting system'; sleep 0.05; echo 'Please press Enter to activate this console.' ;;
    *__WEIG_HEALTH_BEGIN_2__*) test -f "$ready_file" && echo '__WEIG_HEALTH_PASS_2__' || echo '__WEIG_HEALTH_EARLY_2__' ;;
  esac
done
`,
    bootFailure: "echo 'Kernel panic - not syncing'; exit 1\n",
    hostFailure: "echo 'qemu-system-x86_64: command not found'; exit 127\n",
    noControl: "echo 'Please press Enter to activate this console.'; while IFS= read -r line; do :; done\n",
    healthFailure: `
echo 'Please press Enter to activate this console.'
while IFS= read -r line; do
  case "$line" in '') echo 'root@OpenWrt:~#';; *__WEIG_HEALTH_BEGIN_1__*) echo '__WEIG_HEALTH_FAIL_1__';; esac
done
`,
    rebootFailure: `
echo 'Please press Enter to activate this console.'
while IFS= read -r line; do
  case "$line" in
    '') echo 'root@OpenWrt:~#' ;;
    *__WEIG_HEALTH_BEGIN_1__*) echo '__WEIG_HEALTH_PASS_1__' ;;
    *__WEIG_REBOOT_REQUEST__*) echo 'reboot: Restarting system'; exit 1 ;;
  esac
done
`,
  }[mode];
  return `#!/usr/bin/env bash
set -eu
if [ -n "\${PROBE_CAPTURE_ARGS_FILE:-}" ]; then printf '%s\\n' "\$@" > "\$PROBE_CAPTURE_ARGS_FILE"; fi
while [ "\$#" -gt 0 ]; do
  case "\$1" in
    --rootfs) shift 2 ;;
    *) shift ;;
  esac
done
${behavior}`;
}

async function scenario(mode, depth, phase = 'final', captureArgs = false) {
  const directory = mkdtempSync(join(tmpdir(), 'probe-virtual-'));
  try {
    mkdirSync(join(directory, 'scripts'));
    mkdirSync(join(directory, 'bin', 'targets', 'x86', '64'), { recursive: true });
    writeFileSync(join(directory, 'bin', 'targets', 'x86', '64', 'lede-x86-64-generic-squashfs-combined.img.gz'), gzipSync(Buffer.from('firmware-fixture')));
    const script = join(directory, 'scripts', 'qemustart');
    writeFileSync(script, fixtureScript(mode));
    chmodSync(script, 0o755);
    const captureFile = join(directory, 'qemustart-args.txt');
    const outcome = await runVirtualProbe({
      mode: depth,
      workdir: directory,
      targetSystem: 'x86',
      subtarget: '64',
      installedRoots: ['alpha'],
      phase,
      env: captureArgs ? { PROBE_CAPTURE_ARGS_FILE: captureFile } : {},
      logFile: join(directory, 'virtual.log'),
      bootTimeoutMs: 1_000,
      controlTimeoutMs: 250,
      controlDelayMs: 0,
      observationMs: 0,
    });
    return { ...outcome, capturedArgs: captureArgs && existsSync(captureFile) ? readFileSync(captureFile, 'utf8').trim().split(/\r?\n/) : [] };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

const missingDirectory = mkdtempSync(join(tmpdir(), 'probe-virtual-missing-'));
try {
  const missing = await runVirtualProbe({ mode: 'boot-smoke', workdir: missingDirectory, targetSystem: 'x86', subtarget: '64' });
  assert.equal(missing.result, 'skipped');
  assert.equal(missing.reason, 'virtual-boot-unsupported');
  assert.equal(missing.deepestPassedLevel, 4);
} finally {
  rmSync(missingDirectory, { recursive: true, force: true });
}

const unsupportedDirectory = mkdtempSync(join(tmpdir(), 'probe-virtual-unsupported-'));
try {
  mkdirSync(join(unsupportedDirectory, 'scripts'));
  mkdirSync(join(unsupportedDirectory, 'bin', 'targets', 'x86', '64'), { recursive: true });
  writeFileSync(join(unsupportedDirectory, 'bin', 'targets', 'x86', '64', 'immortalwrt-x86-64-generic-squashfs-combined.img'), 'firmware-fixture');
  const script = join(unsupportedDirectory, 'scripts', 'qemustart');
  writeFileSync(script, '#!/usr/bin/env bash\n# --rootfs is documented here but is not parsed\necho "Usage: qemustart <target> <subtarget> --rootfs PATH"\n');
  chmodSync(script, 0o755);
  const unsupported = await runVirtualProbe({ mode: 'boot-smoke', workdir: unsupportedDirectory, targetSystem: 'x86', subtarget: '64' });
  assert.equal(unsupported.result, 'skipped');
  assert.equal(unsupported.reason, 'virtual-boot-unsupported');
  assert.equal(unsupported.deepestPassedLevel, 4);
  assert.equal(unsupported.firmwareArtifacts.length, 1, 'unsupported virtual boot must retain the actual firmware inventory');
  assert.equal(detectQemuStartInterface(script).supported, false);
} finally {
  rmSync(unsupportedDirectory, { recursive: true, force: true });
}

const nonFirmwareDirectory = mkdtempSync(join(tmpdir(), 'probe-virtual-nonfirmware-'));
try {
  mkdirSync(join(nonFirmwareDirectory, 'scripts'));
  mkdirSync(join(nonFirmwareDirectory, 'bin', 'targets', 'x86', '64'), { recursive: true });
  const nonFirmwareNames = ['vendor-u-boot.bin', 'vendor-firmware.bin', 'factory.bin', 'sysupgrade.bin'];
  for (const name of nonFirmwareNames) {
    writeFileSync(join(nonFirmwareDirectory, 'bin', 'targets', 'x86', '64', name), 'router-flash-artifact');
  }
  const nonFirmwareScan = scanFirmwareArtifacts(nonFirmwareDirectory, 'x86', '64');
  assert.equal(nonFirmwareScan.artifacts.length, nonFirmwareNames.length);
  assert(nonFirmwareScan.artifacts.every((entry) => entry.kind === 'image'),
    'vendor firmware/factory/sysupgrade .bin files must remain opaque, not disk images');
  const script = join(nonFirmwareDirectory, 'scripts', 'qemustart');
  writeFileSync(script, '#!/usr/bin/env bash\nwhile [ "$#" -gt 0 ]; do\n  case "$1" in\n    --rootfs) shift 2 ;;\n    *) shift ;;\n  esac\ndone\necho "Please press Enter to activate this console."\n');
  chmodSync(script, 0o755);
  const nonFirmware = await runVirtualProbe({ mode: 'boot-smoke', workdir: nonFirmwareDirectory, targetSystem: 'x86', subtarget: '64' });
  assert.equal(nonFirmware.result, 'skipped');
  assert.equal(nonFirmware.reason, 'virtual-boot-unsupported');
  assert.equal(nonFirmware.capabilities.firmware, false, 'vendor firmware/factory/sysupgrade blobs are not firmware for --rootfs');
} finally {
  rmSync(nonFirmwareDirectory, { recursive: true, force: true });
}

const boot = await scenario('success', 'boot-smoke', 'final', true);
assert.equal(boot.result, 'compatible');
assert.equal(boot.stages.boot.status, 'success');
const rootfsArgument = boot.capturedArgs.indexOf('--rootfs');
assert(rootfsArgument >= 0, 'qemustart must receive a parser-verified rootfs option');
assert(boot.capturedArgs[rootfsArgument + 1] && !boot.capturedArgs[rootfsArgument + 1].endsWith('.gz'),
  'qemustart must receive the decompressed firmware path');
assert(boot.capturedArgs[rootfsArgument + 1].includes('.probe-artifacts'),
  'qemustart must receive a path in the Probe-owned artifact directory');

const runtime = await scenario('success', 'runtime-health');
assert.equal(runtime.result, 'compatible');
assert.equal(runtime.stages.runtimeHealth.status, 'success');
assert.equal(runtime.capabilities.serialControl, true);

const reboot = await scenario('success', 'reboot-validation');
assert.equal(reboot.result, 'compatible');
assert.equal(reboot.stages.secondBoot.status, 'success');
assert.equal(reboot.stages.secondRuntimeHealth.status, 'success');
assert.equal(reboot.capabilities.rebootControl, true);

const baselineBootFailure = await scenario('bootFailure', 'boot-smoke', 'baseline');
assert.equal(baselineBootFailure.result, 'blocked');
assert.equal(baselineBootFailure.reason, 'base-profile-boot-failure');

const bootFailure = await scenario('bootFailure', 'boot-smoke', 'final');
assert.equal(bootFailure.result, 'incompatible');
assert.equal(bootFailure.reason, 'final-boot-failed');

const hostFailure = await scenario('hostFailure', 'boot-smoke');
assert.equal(hostFailure.result, 'inconclusive');
assert.equal(hostFailure.reason, 'virtual-runner-infrastructure');

const noControl = await scenario('noControl', 'runtime-health');
assert.equal(noControl.result, 'skipped');
assert.equal(noControl.reason, 'runtime-control-unavailable');
assert.equal(noControl.capabilities.serialControl, false);

const healthFailure = await scenario('healthFailure', 'runtime-health');
assert.equal(healthFailure.result, 'incompatible');
assert.equal(healthFailure.reason, 'final-runtime-failed');

const rebootFailure = await scenario('rebootFailure', 'reboot-validation');
assert.equal(rebootFailure.result, 'incompatible');
assert.equal(rebootFailure.reason, 'final-reboot-failed');

console.log('Package Probe virtual runtime checks passed.');

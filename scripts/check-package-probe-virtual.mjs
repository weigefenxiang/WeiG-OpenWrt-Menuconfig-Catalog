#!/usr/bin/env node
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { healthCommand, runVirtualProbe, virtualPanic, virtualProbeDepth, virtualReady } from './package-probe-virtual.mjs';

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

function fixtureScript(mode) {
  const behavior = {
    success: `
echo 'procd: - init complete -'
while IFS= read -r line; do
  case "$line" in
    *__WEIG_HEALTH_BEGIN_1__*) echo '__WEIG_HEALTH_PASS_1__' ;;
    *__WEIG_REBOOT_REQUEST__*) echo 'reboot: Restarting system'; sleep 0.05; echo 'procd: - init complete -' ;;
    *__WEIG_HEALTH_BEGIN_2__*) echo '__WEIG_HEALTH_PASS_2__' ;;
  esac
done
`,
    bootFailure: "echo 'Kernel panic - not syncing'; exit 1\n",
    noControl: "echo 'procd: - init complete -'; while IFS= read -r line; do :; done\n",
    healthFailure: `
echo 'procd: - init complete -'
while IFS= read -r line; do
  case "$line" in *__WEIG_HEALTH_BEGIN_1__*) echo '__WEIG_HEALTH_FAIL_1__';; esac
done
`,
    rebootFailure: `
echo 'procd: - init complete -'
while IFS= read -r line; do
  case "$line" in
    *__WEIG_HEALTH_BEGIN_1__*) echo '__WEIG_HEALTH_PASS_1__' ;;
    *__WEIG_REBOOT_REQUEST__*) echo 'reboot: Restarting system'; exit 1 ;;
  esac
done
`,
  }[mode];
  return `#!/usr/bin/env bash\nset -eu\n${behavior}`;
}

async function scenario(mode, depth) {
  const directory = mkdtempSync(join(tmpdir(), 'probe-virtual-'));
  try {
    mkdirSync(join(directory, 'scripts'));
    const script = join(directory, 'scripts', 'qemustart');
    writeFileSync(script, fixtureScript(mode));
    chmodSync(script, 0o755);
    return await runVirtualProbe({
      mode: depth,
      workdir: directory,
      targetSystem: 'x86',
      subtarget: '64',
      installedRoots: ['alpha'],
      logFile: join(directory, 'virtual.log'),
      bootTimeoutMs: 1_000,
      controlTimeoutMs: 250,
      controlDelayMs: 0,
      observationMs: 0,
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

const missingDirectory = mkdtempSync(join(tmpdir(), 'probe-virtual-missing-'));
try {
  const missing = await runVirtualProbe({ mode: 'boot-smoke', workdir: missingDirectory, targetSystem: 'x86', subtarget: '64' });
  assert.equal(missing.result, 'skipped');
  assert.equal(missing.reason, 'virtual-boot-unsupported');
} finally {
  rmSync(missingDirectory, { recursive: true, force: true });
}

const boot = await scenario('success', 'boot-smoke');
assert.equal(boot.result, 'compatible');
assert.equal(boot.stages.boot.status, 'success');

const runtime = await scenario('success', 'runtime-health');
assert.equal(runtime.result, 'compatible');
assert.equal(runtime.stages.runtimeHealth.status, 'success');
assert.equal(runtime.capabilities.serialControl, true);

const reboot = await scenario('success', 'reboot-validation');
assert.equal(reboot.result, 'compatible');
assert.equal(reboot.stages.secondBoot.status, 'success');
assert.equal(reboot.stages.secondRuntimeHealth.status, 'success');
assert.equal(reboot.capabilities.rebootControl, true);

const bootFailure = await scenario('bootFailure', 'boot-smoke');
assert.equal(bootFailure.result, 'incompatible');
assert.equal(bootFailure.reason, 'final-boot-failed');

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

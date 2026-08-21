#!/usr/bin/env node
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { isReportedInconclusive, probeResultExitCode } from './package-probe-failure-classification.mjs';

const runner = resolve(import.meta.dirname, 'run-package-probe.mjs');

function fakeMakeSource() {
  return `#!/usr/bin/env node
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const args = process.argv.slice(2);
appendFileSync(process.env.FAKE_MAKE_LOG, JSON.stringify(args) + '\\n');
if (args.includes('defconfig')) {
  const configPath = join(process.cwd(), '.config');
  if (process.env.FAKE_EXPECT_DISABLED === 'true' && !readFileSync(configPath, 'utf8').includes('# CONFIG_PACKAGE_beta is not set')) process.exit(2);
  mkdirSync(join(process.cwd(), 'tmp'), { recursive: true });
  const unavailable = process.env.FAKE_PACKAGE_UNAVAILABLE === 'true';
  writeFileSync(join(process.cwd(), 'tmp', '.packageinfo'), unavailable
    ? 'Source-Makefile: package/network/beta/Makefile\\nPackage: beta\\n'
    : 'Source-Makefile: package/network/alpha/Makefile\\nPackage: alpha\\n');
  if (unavailable || process.env.FAKE_REJECT_ROOT === 'true') {
    const config = readFileSync(configPath, 'utf8').replace(/^CONFIG_PACKAGE_alpha=[my]\\r?\\n?/m, '');
    writeFileSync(configPath, config);
  }
  appendFileSync(configPath, 'CONFIG_PACKAGE_auto-dependency=y\\n');
}
const rootCompile = args.includes('package/network/alpha/compile');
if (process.env.FAKE_FAIL_INFRA === 'true' && rootCompile) {
  console.error('curl: (6) Could not resolve host: downloads.example.invalid');
  process.exit(2);
}
if (process.env.FAKE_FAIL_ROOT === 'true' && rootCompile) {
  console.error('ERROR: package/network/alpha failed to build');
  process.exit(2);
}
if (process.env.FAKE_FAIL_PREREQUISITE === 'true' && rootCompile) {
  console.error('ERROR: package/kernel/linux failed to build');
  process.exit(2);
}
if (process.env.FAKE_FAIL_UNATTRIBUTED === 'true' && rootCompile) {
  console.error('collect2: error: ld returned 1 exit status');
  process.exit(2);
}
if (process.env.FAKE_FAIL_ROOTFS_PREREQUISITE === 'true' && args.includes('package/compile')) {
  console.error('ERROR: package/kernel/linux failed to build');
  process.exit(2);
}
if (process.env.FAKE_ROOTFS_ROOT_CONFLICT === 'true' && args.includes('package/install')) {
  console.error('ERROR: alpha-1.0-r0: trying to overwrite etc/example owned by beta-1.0-r0');
  process.exit(2);
}
if (process.env.FAKE_ROOTFS_UNRELATED_CONFLICT === 'true' && args.includes('package/install')) {
  console.error('ERROR: gamma-1.0-r0: trying to overwrite etc/example owned by beta-1.0-r0');
  process.exit(2);
}
if (process.env.FAKE_FAIL_FIRMWARE_PREREQUISITE === 'true' && args.includes('target/install')) {
  console.error('ERROR: package/kernel/linux failed to build');
  process.exit(2);
}
if (process.env.FAKE_FAIL_PARALLEL === 'true' && rootCompile && args[0] !== '-j1') process.exitCode = 1;
if (process.env.FAKE_FAIL_TARGET_PREREQUISITE === 'true' && args.includes('prepare')) {
  const cause = process.env.FAKE_TARGET_PREREQUISITE_CAUSE || 'patch-apply';
  if (cause === 'patch-apply') {
    console.error('Applying generic upstream patch');
    console.error('Hunk FAILED at 12');
    console.error('Patch failed! Please fix the rejected hunk.');
  } else if (cause === 'toolchain-kernel-version') {
    console.error('toolchain/glibc: available kernel headers are older than requested');
  } else if (cause === 'target-build') {
    console.error("No rule to make target 'target/linux/compile'");
  } else {
    console.error('module crypto/geniv.ko is missing');
  }
  process.exit(2);
}
if (process.env.FAKE_FAIL_TARGET_PREREQUISITE_WRAPPER === 'true' && args.includes('prepare')) {
  console.error('ERROR: target/linux failed to build');
  process.exit(2);
}
if (process.env.FAKE_FAIL_TOOLCHAIN_WRAPPER === 'true' && args.includes('prepare')) {
  console.error('ERROR: toolchain failed to build');
  process.exit(2);
}
if (process.env.FAKE_FAIL_TARGET_PREREQUISITE_OOM === 'true' && args.includes('prepare')) {
  console.error('ERROR: target/linux failed to build');
  console.error('make: *** [prepare] Killed');
  process.exit(2);
}
if (process.env.FAKE_FAIL_TARGET_PREREQUISITE_INFRASTRUCTURE === 'true' && args.includes('prepare')) {
  console.error('curl: (6) Could not resolve host: downloads.example.invalid');
  process.exit(2);
}
if (process.env.FAKE_FAIL_TARGET_PREREQUISITE_UNATTRIBUTED === 'true' && args.includes('prepare')) {
  console.error('collect2: error: ld returned 1 exit status');
  process.exit(2);
}
`;
}

function qemustartSource() {
  return `#!/usr/bin/env bash
set -eu
echo 'Please press Enter to activate this console.'
while IFS= read -r line; do
  case "$line" in
    '') echo 'root@OpenWrt:~#' ;;
    *__WEIG_HEALTH_BEGIN_1__*) echo '__WEIG_HEALTH_PASS_1__' ;;
    *__WEIG_REBOOT_REQUEST__*) echo 'reboot: Restarting system'; sleep 0.05; echo 'Please press Enter to activate this console.' ;;
    *__WEIG_HEALTH_BEGIN_2__*) echo '__WEIG_HEALTH_PASS_2__' ;;
  esac
done
`;
}

function scenario(mode, options = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'probe-runner-'));
  try {
    const workdir = join(directory, 'upstream');
    const bin = join(directory, 'bin');
    mkdirSync(join(workdir, 'scripts'), { recursive: true });
    mkdirSync(bin, { recursive: true });
    const fakeMake = join(directory, 'fake-make.mjs');
    writeFileSync(fakeMake, fakeMakeSource());
    const shellMake = join(bin, 'make');
    writeFileSync(shellMake, `#!/usr/bin/env bash\nexec "${process.execPath.replaceAll('\\', '/')}" "${fakeMake.replaceAll('\\', '/')}" "$@"\n`);
    chmodSync(shellMake, 0o755);
    writeFileSync(join(bin, 'make.cmd'), `@echo off\r\n"${process.execPath}" "${fakeMake}" %*\r\n`);
    const qemustart = join(workdir, 'scripts', 'qemustart');
    writeFileSync(qemustart, qemustartSource());
    chmodSync(qemustart, 0o755);
    const makeLog = join(directory, 'make.jsonl');
    const runtimeFile = join(directory, 'runtime.json');
    const result = spawnSync(process.execPath, [runner], {
      cwd: resolve(import.meta.dirname, '..'),
      encoding: 'utf8',
      timeout: 15_000,
      env: {
        ...process.env,
        PATH: `${bin}${delimiter}${process.env.PATH || ''}`,
        PROBE_MAKE_COMMAND: process.execPath,
        PROBE_MAKE_ARGUMENT: fakeMake,
        FAKE_MAKE_LOG: makeLog,
        FAKE_FAIL_PARALLEL: String(options.failParallel === true),
        FAKE_FAIL_INFRA: String(options.failInfrastructure === true),
        FAKE_EXPECT_DISABLED: String(options.expectDisabled === true),
        FAKE_PACKAGE_UNAVAILABLE: String(options.packageUnavailable === true),
        FAKE_REJECT_ROOT: String(options.rejectRoot === true),
        FAKE_FAIL_ROOT: String(options.failRoot === true),
        FAKE_FAIL_PREREQUISITE: String(options.failPrerequisite === true),
        FAKE_FAIL_UNATTRIBUTED: String(options.failUnattributed === true),
        FAKE_FAIL_ROOTFS_PREREQUISITE: String(options.failRootfsPrerequisite === true),
        FAKE_ROOTFS_ROOT_CONFLICT: String(options.rootfsRootConflict === true),
        FAKE_ROOTFS_UNRELATED_CONFLICT: String(options.rootfsUnrelatedConflict === true),
        FAKE_FAIL_FIRMWARE_PREREQUISITE: String(options.failFirmwarePrerequisite === true),
        FAKE_FAIL_TARGET_PREREQUISITE: String(options.failTargetPrerequisite === true),
        FAKE_TARGET_PREREQUISITE_CAUSE: String(options.targetPrerequisiteCause || ''),
        FAKE_FAIL_TARGET_PREREQUISITE_WRAPPER: String(options.failTargetPrerequisiteWrapper === true),
        FAKE_FAIL_TOOLCHAIN_WRAPPER: String(options.failToolchainWrapper === true),
        FAKE_FAIL_TARGET_PREREQUISITE_OOM: String(options.failTargetPrerequisiteOom === true),
        FAKE_FAIL_TARGET_PREREQUISITE_INFRASTRUCTURE: String(options.failTargetPrerequisiteInfrastructure === true),
        FAKE_FAIL_TARGET_PREREQUISITE_UNATTRIBUTED: String(options.failTargetPrerequisiteUnattributed === true),
        PROBE_WORKDIR: workdir,
        PROBE_LOG: join(directory, 'probe.log'),
        PROBE_RUNTIME: runtimeFile,
        PROBE_MODE: mode,
        PROBE_SOURCE: 'OpenWrt',
        PROBE_BRANCH: 'main',
        PROBE_TARGET_SYSTEM: 'x86',
        PROBE_SUBTARGET: '64',
        PROBE_TARGET: 'x86/64',
        PROBE_PROFILE: 'DEVICE_generic',
        PROBE_TARGET_CONFIG: 'CONFIG_TARGET_x86=y\nCONFIG_TARGET_x86_64=y\nCONFIG_TARGET_x86_64_DEVICE_generic=y',
        PROBE_TARGET_BATCH: 'null',
        PROBE_ROOTS: 'alpha',
        PROBE_PACKAGE_CONFIG: Buffer.from(options.packageConfig || 'CONFIG_PACKAGE_alpha=y\n').toString('base64url'),
        PROBE_PACKAGE_INTENT: Buffer.from(JSON.stringify(options.intent || [{ package: 'alpha', before: 'n', after: 'y' }])).toString('base64url'),
        PROBE_BOOT_TIMEOUT_SECONDS: '2',
        PROBE_CONTROL_TIMEOUT_SECONDS: '1',
        PROBE_RUNTIME_OBSERVATION_SECONDS: '1',
      },
    });
    assert.equal(result.status, options.expectedStatus ?? 0, `${mode} failed:\n${result.stdout}\n${result.stderr}`);
    const calls = readFileSync(makeLog, 'utf8').trim().split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
    const runtime = JSON.parse(readFileSync(runtimeFile, 'utf8'));
    return { calls, runtime, log: readFileSync(join(directory, 'probe.log'), 'utf8') };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

const l2 = scenario('package-compile', { failParallel: true });
assert.equal(l2.calls.filter((args) => args.includes('defconfig')).length, 1);
assert.equal(l2.calls.filter((args) => args.includes('prepare')).length, 1,
  'L2 must let upstream prepare Target/kernel prerequisites before Root compilation');
assert.equal(l2.calls.filter((args) => args.includes('tools/install') && args.includes('toolchain/install')).length, 0,
  'L2 must not bypass the upstream prepare target with a partial build-environment target set');
const l2Targets = l2.calls.filter((args) => args.includes('package/network/alpha/compile'));
assert.equal(l2Targets.length, 2, 'L2 must retry the same Root target set exactly once');
assert(l2Targets[0][0] !== '-j1' && l2Targets[1][0] === '-j1');
assert(l2.calls.findIndex((args) => args.includes('prepare')) < l2.calls.findIndex((args) => args.includes('package/network/alpha/compile')),
  'Target/kernel prerequisites must exist before the Root Source-Makefile target enters the upstream graph');
assert.equal(l2.runtime.attempts[0].serialRetries[0].result, 'recovered');
assert.equal(l2.runtime.attempts[0].deepestPassedLevel, 2);
assert.equal(l2.runtime.requestedPackageCount, 1);
assert.equal(l2.runtime.attempts[0].resolvedPackageCount, 2,
  'automatic dependencies must appear only after the shared upstream resolver');
scenario('package-compile', { expectDisabled: true, intent: [
  { package: 'alpha', before: 'n', after: 'y' },
  { package: 'beta', before: 'y', after: 'n' },
] });

for (const mode of ['package-compile', 'rootfs-integration', 'firmware-integration', 'boot-smoke', 'runtime-health', 'reboot-validation']) {
  const unavailable = scenario(mode, { packageUnavailable: true });
  assert.equal(unavailable.runtime.conclusion, 'skipped', `${mode} missing package must be skipped`);
  assert.equal(unavailable.runtime.reason, 'root-absent-source', `${mode} missing package must use the source-absence reason`);
  assert.equal(unavailable.runtime.attempts[0].result, 'skipped');
  assert.equal(unavailable.runtime.attempts[0].reason, 'root-absent-source');
  assert.deepEqual(unavailable.runtime.attempts[0].unavailableRoots, ['alpha']);
  assert.equal(unavailable.runtime.attempts[0].stages.config.status, 'skipped');
  assert.equal('boot' in unavailable.runtime.attempts[0].stages, false,
    `${mode} missing package must stop before virtual boot`);
  assert.equal('runtimeHealth' in unavailable.runtime.attempts[0].stages, false,
    `${mode} missing package must stop before runtime health`);
  assert.equal('secondRuntimeHealth' in unavailable.runtime.attempts[0].stages, false,
    `${mode} missing package must stop before reboot validation`);
  assert(unavailable.log.includes('SKIP: Probe root package unavailable in Source/Branch: alpha'));
  assert(!unavailable.log.includes('direct Probe intent did not survive'),
    `${mode} missing package must not leave a generic Kconfig failure in the evidence log`);
  assert.equal(unavailable.calls.some((args) => args.includes('prepare')), false,
    `${mode} missing package must stop before Target preparation`);
  assert.equal(unavailable.calls.some((args) => args.includes('package/network/alpha/compile')), false,
    `${mode} missing package must stop before package compilation`);
  assert.equal(unavailable.calls.some((args) => args.includes('package/compile')), false,
    `${mode} missing package must stop before RootFS package compilation`);
  assert.equal(unavailable.calls.some((args) => args.includes('package/install')), false,
    `${mode} missing package must stop before RootFS installation`);
  assert.equal(unavailable.calls.some((args) => args.includes('target/install')), false,
    `${mode} missing package must stop before firmware integration`);
}

const l2Kconfig = scenario('package-compile', { rejectRoot: true });
assert.equal(l2Kconfig.runtime.conclusion, 'incompatible');
assert.equal(l2Kconfig.runtime.reason, 'kconfig-unsatisfied');
assert.deepEqual(l2Kconfig.runtime.attempts[0].rejectedRoots, ['alpha']);
assert.equal(l2Kconfig.runtime.attempts[0].stages.config.status, 'failure');
assert(l2Kconfig.log.includes('FAIL: Probe root package rejected by upstream Kconfig: alpha'));

const l2RootFailure = scenario('package-compile', { failRoot: true });
assert.equal(l2RootFailure.runtime.conclusion, 'incompatible');
assert.equal(l2RootFailure.runtime.reason, 'package-compile-failure');
assert(l2RootFailure.runtime.attempts[0].failedBuildTargets.includes('package/network/alpha'));

const l2Prerequisite = scenario('package-compile', { failPrerequisite: true, expectedStatus: 1 });
assert.equal(l2Prerequisite.runtime.conclusion, 'inconclusive');
assert.equal(l2Prerequisite.runtime.reason, 'package-compile-prerequisite-failure');
assert.deepEqual(l2Prerequisite.runtime.attempts[0].failedBuildTargets, ['package/kernel/linux']);

const l2Unattributed = scenario('package-compile', { failUnattributed: true, expectedStatus: 1 });
assert.equal(l2Unattributed.runtime.conclusion, 'inconclusive');
assert.equal(l2Unattributed.runtime.reason, 'package-compile-unattributed-failure');
assert.deepEqual(l2Unattributed.runtime.attempts[0].failedBuildTargets, []);

const l2Infrastructure = scenario('package-compile', { failInfrastructure: true, expectedStatus: 1 });
assert.equal(l2Infrastructure.runtime.conclusion, 'inconclusive');
assert.equal(l2Infrastructure.runtime.reason, 'package-compile-infrastructure');
assert.equal(l2Infrastructure.runtime.attempts[0].serialRetries[0].result, 'failure');

const targetPrerequisiteModes = [
  ['package-compile', 'patch-apply'],
  ['rootfs-integration', 'toolchain-kernel-version'],
  ['firmware-integration', 'target-build'],
  ['boot-smoke', 'kernel-prerequisite'],
  ['runtime-health', 'patch-apply'],
  ['reboot-validation', 'toolchain-kernel-version'],
];
for (const [mode, cause] of targetPrerequisiteModes) {
  const targetPrerequisite = scenario(mode, { failTargetPrerequisite: true, targetPrerequisiteCause: cause });
  assert.equal(targetPrerequisite.runtime.conclusion, 'inconclusive', `${mode} Target prerequisite failure must remain an inconclusive conclusion`);
  assert.equal(targetPrerequisite.runtime.reason, 'target-prerequisite-failure', `${mode} must use the reported Target prerequisite reason`);
  assert.equal(targetPrerequisite.runtime.attempts[0].targetPrerequisiteCause, cause, `${mode} must preserve the generic prerequisite cause`);
  assert.equal(targetPrerequisite.runtime.attempts[0].stages.targetPrepare.status, 'failure');
  assert.equal(targetPrerequisite.calls.filter((args) => args.includes('prepare')).length, 2, `${mode} must retry prepare once for evidence`);
  assert.equal(targetPrerequisite.calls.some((args) => args.includes('package/network/alpha/compile')), false, `${mode} must stop before Root compilation`);
  assert.equal(targetPrerequisite.calls.some((args) => args.includes('package/compile')), false, `${mode} must stop before RootFS compilation`);
  assert.equal(targetPrerequisite.calls.some((args) => args.includes('package/install')), false, `${mode} must stop before RootFS installation`);
  assert.equal(targetPrerequisite.calls.some((args) => args.includes('target/install')), false, `${mode} must stop before firmware integration`);
  assert.equal(targetPrerequisite.calls.some((args) => args.includes('qemustart')), false, `${mode} must stop before virtual probing`);
  assert.equal('boot' in targetPrerequisite.runtime.attempts[0].stages, false, `${mode} must not enter virtual boot`);
  assert.equal('runtimeHealth' in targetPrerequisite.runtime.attempts[0].stages, false, `${mode} must not enter runtime health`);
  assert.equal('secondRuntimeHealth' in targetPrerequisite.runtime.attempts[0].stages, false, `${mode} must not enter reboot health`);
}

const targetPrerequisiteInfrastructure = scenario('package-compile', { failTargetPrerequisiteInfrastructure: true, expectedStatus: 1 });
assert.equal(targetPrerequisiteInfrastructure.runtime.conclusion, 'inconclusive');
assert.equal(targetPrerequisiteInfrastructure.runtime.reason, 'target-prerequisite-infrastructure');
const targetPrerequisiteUnattributed = scenario('package-compile', { failTargetPrerequisiteUnattributed: true, expectedStatus: 1 });
assert.equal(targetPrerequisiteUnattributed.runtime.conclusion, 'inconclusive');
assert.equal(targetPrerequisiteUnattributed.runtime.reason, 'target-prerequisite-unattributed-failure');

const targetWrapper = scenario('package-compile', { failTargetPrerequisiteWrapper: true, expectedStatus: 1 });
assert.equal(targetWrapper.runtime.reason, 'target-prerequisite-unattributed-failure');
assert.equal(targetWrapper.runtime.attempts[0].targetPrerequisiteCause, undefined);
const toolchainWrapper = scenario('package-compile', { failToolchainWrapper: true, expectedStatus: 1 });
assert.equal(toolchainWrapper.runtime.reason, 'target-prerequisite-unattributed-failure');
assert.equal(toolchainWrapper.runtime.attempts[0].targetPrerequisiteCause, undefined);
const targetOom = scenario('package-compile', { failTargetPrerequisiteOom: true, expectedStatus: 1 });
assert.equal(targetOom.runtime.reason, 'target-prerequisite-infrastructure');
assert.equal(targetOom.runtime.attempts[0].targetPrerequisiteCause, undefined);
assert.equal(probeResultExitCode([{ result: 'inconclusive', reason: 'target-prerequisite-failure' }]), 1,
  'a reported reason without a cause must remain red');
assert.equal(probeResultExitCode([{ result: 'inconclusive', reason: 'target-prerequisite-failure', targetPrerequisiteCause: 'unknown' }]), 1,
  'an unknown reported cause must remain red');
assert.equal(isReportedInconclusive({ result: 'inconclusive', reason: 'target-prerequisite-failure', targetPrerequisiteCause: 'patch-apply' }), true);
assert.equal(isReportedInconclusive({ result: 'inconclusive', reason: 'target-prerequisite-failure', targetPrerequisiteCause: 'unknown' }), false);

const l3 = scenario('rootfs-integration');
assert.equal(l3.calls.filter((args) => args.includes('package/network/alpha/compile')).length, 1,
  'L3 must reuse its single L2 compile rather than repeating it');
assert.equal(l3.calls.filter((args) => args.includes('prepare')).length, 1,
  'L3 must reuse the L2 Target preparation instead of preparing the Target twice');
assert.equal(l3.calls.filter((args) => args.includes('package/compile')).length, 1,
  'L3 must let upstream build the complete selected RootFS package set');
assert.equal(l3.calls.filter((args) => args.includes('package/install')).length, 1);
assert(l3.calls.findIndex((args) => args.includes('prepare')) < l3.calls.findIndex((args) => args.includes('package/network/alpha/compile')));
assert(l3.calls.findIndex((args) => args.includes('package/network/alpha/compile')) < l3.calls.findIndex((args) => args.includes('package/compile')));
assert(l3.calls.findIndex((args) => args.includes('package/compile')) < l3.calls.findIndex((args) => args.includes('package/install')));
assert.equal(l3.runtime.attempts[0].deepestPassedLevel, 3);

const l3Prerequisite = scenario('rootfs-integration', { failRootfsPrerequisite: true, expectedStatus: 1 });
assert.equal(l3Prerequisite.runtime.conclusion, 'inconclusive');
assert.equal(l3Prerequisite.runtime.reason, 'rootfs-package-prerequisite-failure');
assert.deepEqual(l3Prerequisite.runtime.attempts[0].failedBuildTargets, ['package/kernel/linux']);

const l3RootConflict = scenario('rootfs-integration', { rootfsRootConflict: true });
assert.equal(l3RootConflict.runtime.conclusion, 'incompatible');
assert.equal(l3RootConflict.runtime.reason, 'rootfs-conflict');
assert(l3RootConflict.runtime.attempts[0].rootfsConflictPackages.includes('alpha'));

const l3UnrelatedConflict = scenario('rootfs-integration', { rootfsUnrelatedConflict: true, expectedStatus: 1 });
assert.equal(l3UnrelatedConflict.runtime.conclusion, 'inconclusive');
assert.equal(l3UnrelatedConflict.runtime.reason, 'rootfs-install-prerequisite-failure');
assert.equal(l3UnrelatedConflict.runtime.attempts[0].rootfsConflictPackages.includes('alpha'), false);

const l4 = scenario('firmware-integration');
assert.equal(l4.calls.filter((args) => args.includes('defconfig')).length, 1, 'L4 must resolve Final direct intent only once');
assert.equal(l4.calls.filter((args) => args.includes('prepare')).length, 1, 'L4 must reuse one Target preparation');
assert.equal(l4.calls.filter((args) => args.includes('package/network/alpha/compile')).length, 1, 'L4 must reuse one L2 Root compile');
assert.equal(l4.calls.filter((args) => args.includes('package/compile')).length, 1, 'L4 must reuse one L3 package compile');
assert.equal(l4.calls.filter((args) => args.includes('package/install')).length, 1, 'L4 must reuse one L3 package install');
assert.equal(l4.calls.filter((args) => args.includes('target/install')).length, 1, 'L4 must add only the upstream firmware integration target');
assert(l4.calls.findIndex((args) => args.includes('package/install')) < l4.calls.findIndex((args) => args.includes('target/install')));
assert.equal(l4.runtime.attempts[0].deepestPassedLevel, 4);
assert(!('baselinePackageCount' in l4.runtime));

const l4Prerequisite = scenario('firmware-integration', { failFirmwarePrerequisite: true, expectedStatus: 1 });
assert.equal(l4Prerequisite.runtime.conclusion, 'inconclusive');
assert.equal(l4Prerequisite.runtime.reason, 'firmware-prerequisite-failure');
assert.deepEqual(l4Prerequisite.runtime.attempts[0].failedBuildTargets, ['package/kernel/linux']);

const l7InheritedPrerequisite = scenario('reboot-validation', { failFirmwarePrerequisite: true, expectedStatus: 1 });
assert.equal(l7InheritedPrerequisite.runtime.conclusion, 'inconclusive',
  'L5-L7 must inherit the same prerequisite attribution instead of blaming the selected package');
assert.equal(l7InheritedPrerequisite.runtime.reason, 'firmware-prerequisite-failure');

const l7 = scenario('reboot-validation');
assert.equal(l7.calls.filter((args) => args.includes('defconfig')).length, 1, 'L7 must resolve Final direct intent once');
assert.equal(l7.calls.filter((args) => args.includes('prepare')).length, 1, 'L7 must reuse one Target preparation');
assert.equal(l7.calls.filter((args) => args.includes('package/network/alpha/compile')).length, 1, 'L7 must reuse one L2 Root compile');
assert.equal(l7.calls.filter((args) => args.includes('package/compile')).length, 1, 'L7 must reuse one L3 package compile');
assert.equal(l7.calls.filter((args) => args.includes('package/install')).length, 1, 'L7 must reuse one L3 package install');
assert.equal(l7.calls.filter((args) => args.includes('target/install')).length, 1, 'L7 must reuse one L4 firmware integration');
assert.equal(l7.runtime.conclusion, 'compatible');
assert.equal(l7.runtime.attempts[0].deepestPassedLevel, 7);
assert.equal(l7.runtime.attempts[0].stages.secondRuntimeHealth.status, 'success');

console.log('Package Probe Final-only runner checks passed.');

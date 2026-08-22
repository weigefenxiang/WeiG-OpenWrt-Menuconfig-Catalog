#!/usr/bin/env node
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { isReportedInconclusive, probeResultExitCode } from './package-probe-failure-classification.mjs';
import { evaluateFinalize } from './finalize-package-probe.mjs';

const runner = resolve(import.meta.dirname, 'run-package-probe.mjs');

function fakeMakeSource(rootPackage = 'alpha') {
  return `#!/usr/bin/env node
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const args = process.argv.slice(2);
const rootSource = 'package/network/${rootPackage}/Makefile';
appendFileSync(process.env.FAKE_MAKE_LOG, JSON.stringify(args) + '\\n');
if (args.includes('defconfig')) {
  const configPath = join(process.cwd(), '.config');
  if (process.env.FAKE_EXPECT_DISABLED === 'true' && !readFileSync(configPath, 'utf8').includes('# CONFIG_PACKAGE_beta is not set')) process.exit(2);
  mkdirSync(join(process.cwd(), 'tmp'), { recursive: true });
  const unavailable = process.env.FAKE_PACKAGE_UNAVAILABLE === 'true';
  writeFileSync(join(process.cwd(), 'tmp', '.packageinfo'), unavailable
    ? 'Source-Makefile: package/network/beta/Makefile\\nPackage: beta\\n'
    : 'Source-Makefile: ' + rootSource + '\\nPackage: ${rootPackage}\\nSource-Makefile: package/network/auto-dependency/Makefile\\nPackage: auto-dependency\\n');
  if (unavailable || process.env.FAKE_REJECT_ROOT === 'true') {
    const config = readFileSync(configPath, 'utf8').replace(new RegExp('^CONFIG_PACKAGE_${rootPackage}=[my]\\\\r?\\\\n?', 'm'), '');
    writeFileSync(configPath, config);
  }
  if (new RegExp('^CONFIG_PACKAGE_${rootPackage}=[my]$', 'm').test(readFileSync(configPath, 'utf8'))) appendFileSync(configPath, 'CONFIG_PACKAGE_auto-dependency=y\\n');
}
if (args.includes('prepare-tmpinfo')) {
  mkdirSync(join(process.cwd(), 'tmp'), { recursive: true });
  writeFileSync(join(process.cwd(), 'tmp', '.targetinfo'), 'Target: x86/64\\n');
  const unavailable = process.env.FAKE_PACKAGE_UNAVAILABLE === 'true';
  writeFileSync(join(process.cwd(), 'tmp', '.packageinfo'), unavailable
    ? 'Source-Makefile: package/network/beta/Makefile\\nPackage: beta\\n'
    : 'Source-Makefile: ' + rootSource + '\\nPackage: ${rootPackage}\\n');
}
const rootCompile = args.includes(rootSource.replace('/Makefile', '/compile'));
if (process.env.FAKE_FAIL_INFRA === 'true' && rootCompile) {
  console.error('curl: (6) Could not resolve host: downloads.example.invalid');
  process.exit(2);
}
if (process.env.FAKE_FAIL_ROOT === 'true' && rootCompile) {
  console.error('ERROR: package/network/${rootPackage} failed to build');
  process.exit(2);
}
if (process.env.FAKE_FAIL_INNER_WRAPPER === 'true' && rootCompile) {
  console.error('ERROR: package/compile failed to build');
  console.error('make[2]: *** [package/network/${rootPackage}/compile] Error 2');
  process.exit(2);
}
if (process.env.FAKE_FAIL_ROOT_MAKE_ONLY === 'true' && rootCompile) {
  console.error('make[2]: *** [package/network/${rootPackage}/compile] Error 2');
  process.exit(2);
}
if (process.env.FAKE_FAIL_DEPENDENCY === 'true' && rootCompile && readFileSync(join(process.cwd(), '.config'), 'utf8').includes('CONFIG_PACKAGE_${rootPackage}=y')) {
  console.error('ERROR: package/network/auto-dependency failed to build');
  process.exit(2);
}
if (process.env.FAKE_FAIL_PREREQUISITE === 'true' && rootCompile) {
  console.error('ERROR: module crypto/geniv.ko is missing');
  console.error('ERROR: package/kernel/linux failed to build');
  process.exit(2);
}
if (process.env.FAKE_FAIL_INNER_KERNEL_WRAPPER === 'true' && rootCompile) {
  console.error('ERROR: module crypto/geniv.ko is missing');
  console.error('ERROR: package/kernel/linux failed to build');
  console.error('make[2]: *** [package/feeds/packages/oscam/compile] Error 2');
  process.exit(2);
}
if (process.env.FAKE_FAIL_INNER_KERNEL_MAKE_ONLY === 'true' && rootCompile) {
  console.error('module crypto/geniv.ko is missing');
  console.error('make[3]: *** [package/kernel/linux/compile] Error 2');
  console.error('make[2]: *** [package/feeds/packages/oscam/compile] Error 2');
  process.exit(2);
}
if (process.env.FAKE_FAIL_UNATTRIBUTED === 'true' && rootCompile) {
  console.error('collect2: error: ld returned 1 exit status');
  process.exit(2);
}
if (process.env.FAKE_FAIL_ROOTFS_PREREQUISITE === 'true' && args.includes('package/compile')) {
  console.error('ERROR: module crypto/geniv.ko is missing');
  console.error('ERROR: package/kernel/linux failed to build');
  process.exit(2);
}
if (process.env.FAKE_ROOTFS_ROOT_CONFLICT === 'true' && args.includes('package/install')) {
  console.error('ERROR: ${rootPackage}-1.0-r0: trying to overwrite etc/example owned by beta-1.0-r0');
  process.exit(2);
}
if (process.env.FAKE_ROOTFS_DEPENDENCY_CONFLICT === 'true' && args.includes('package/install') && readFileSync(join(process.cwd(), '.config'), 'utf8').includes('CONFIG_PACKAGE_${rootPackage}=y')) {
  console.error('ERROR: auto-dependency-1.0-r0: trying to overwrite etc/example owned by beta-1.0-r0');
  process.exit(2);
}
if (process.env.FAKE_ROOTFS_UNRELATED_CONFLICT === 'true' && args.includes('package/install')) {
  console.error('ERROR: gamma-1.0-r0: trying to overwrite etc/example owned by beta-1.0-r0');
  process.exit(2);
}
if (process.env.FAKE_FAIL_FIRMWARE_PREREQUISITE === 'true' && args.includes('target/install')) {
  console.error('ERROR: module crypto/geniv.ko is missing');
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
  console.error('ERROR: target/linux failed to build');
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
    const rootPackage = options.rootPackage || 'alpha';
    const workdir = join(directory, 'upstream');
    const bin = join(directory, 'bin');
    mkdirSync(join(workdir, 'scripts'), { recursive: true });
    mkdirSync(bin, { recursive: true });
    const fakeMake = join(directory, 'fake-make.mjs');
    writeFileSync(fakeMake, fakeMakeSource(rootPackage));
    const shellMake = join(bin, 'make');
    writeFileSync(shellMake, `#!/usr/bin/env bash\nexec "${process.execPath.replaceAll('\\', '/')}" "${fakeMake.replaceAll('\\', '/')}" "$@"\n`);
    chmodSync(shellMake, 0o755);
  writeFileSync(join(bin, 'make.cmd'), `@echo off\r\n"${process.execPath}" "${fakeMake}" %*\r\n`);
    const qemustart = join(workdir, 'scripts', 'qemustart');
    writeFileSync(qemustart, qemustartSource());
    chmodSync(qemustart, 0o755);
    if (mode === 'config-resolve') {
      const conf = join(workdir, 'scripts', 'config', 'conf.mjs');
      mkdirSync(join(workdir, 'scripts', 'config'), { recursive: true });
      writeFileSync(conf, "if (process.env.FAKE_FAIL_L1_BASELINE === 'true' && process.argv.some((arg) => arg.includes('DEVICE_bad')) && process.argv.some((arg) => arg.includes('baseline'))) process.exit(2);\nprocess.exit(0);\n");
    }
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
         FAKE_FAIL_INNER_WRAPPER: String(options.failInnerWrapper === true),
         FAKE_FAIL_ROOT_MAKE_ONLY: String(options.failRootMakeOnly === true),
         FAKE_FAIL_DEPENDENCY: String(options.failDependency === true),
         FAKE_FAIL_L1_BASELINE: String(options.failL1Baseline === true),
        FAKE_FAIL_PREREQUISITE: String(options.failPrerequisite === true),
        FAKE_FAIL_INNER_KERNEL_WRAPPER: String(options.failInnerKernelWrapper === true),
        FAKE_FAIL_INNER_KERNEL_MAKE_ONLY: String(options.failInnerKernelMakeOnly === true),
        FAKE_FAIL_UNATTRIBUTED: String(options.failUnattributed === true),
        FAKE_FAIL_ROOTFS_PREREQUISITE: String(options.failRootfsPrerequisite === true),
         FAKE_ROOTFS_ROOT_CONFLICT: String(options.rootfsRootConflict === true),
         FAKE_ROOTFS_DEPENDENCY_CONFLICT: String(options.rootfsDependencyConflict === true),
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
         PROBE_TARGET_BATCH: mode === 'config-resolve' ? JSON.stringify(options.l1Multiple ? [
           { targetSystem: 'x86', subtarget: '64', target: 'x86/64', profile: 'DEVICE_bad', targetConfig: 'CONFIG_TARGET_x86=y\\nCONFIG_TARGET_x86_64=y' },
           { targetSystem: 'x86', subtarget: '64', target: 'x86/64', profile: 'DEVICE_generic', targetConfig: 'CONFIG_TARGET_x86=y\\nCONFIG_TARGET_x86_64=y' },
         ] : [{ targetSystem: 'x86', subtarget: '64', target: 'x86/64', profile: 'DEVICE_generic', targetConfig: 'CONFIG_TARGET_x86=y\\nCONFIG_TARGET_x86_64=y' }]) : 'null',
        PROBE_ROOTS: rootPackage,
         PROBE_PACKAGE_CONFIG: Buffer.from(options.packageConfig || `CONFIG_PACKAGE_${rootPackage}=y\n`).toString('base64url'),
         PROBE_BASELINE_PACKAGE_CONFIG: Buffer.from(options.baselinePackageConfig || '').toString('base64url'),
         PROBE_PACKAGE_INTENT: Buffer.from(JSON.stringify(options.intent || [{ package: rootPackage, before: 'n', after: 'y' }])).toString('base64url'),
         PROBE_PAIRED_COMPARISON: String(options.paired === true),
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

const paired = scenario('package-compile', { paired: true });
assert.equal(paired.runtime.pairedComparison, true);
assert.equal(paired.runtime.comparison.mode, 'paired-exclusion');
assert.equal(paired.runtime.attempts.length, 1, 'B and A must remain one environment attempt');
assert.equal(paired.runtime.attempts[0].baseline.result, 'compatible');
assert.equal(paired.runtime.attempts[0].final.result, 'compatible');
assert.equal(paired.runtime.attempts[0].pairConclusion, 'compatible');
assert.equal(paired.calls.filter((args) => args.includes('defconfig')).length, 2, 'paired execution must resolve B then A');
assert.equal(paired.calls.filter((args) => args.includes('prepare')).length, 2, 'paired execution must prepare B and A');
assert.equal(paired.calls.some((args) => args.includes('package/network/alpha/compile')), true, 'A must compile the selected root');
assert.equal(paired.runtime.attempts[0].baseline.rootTargets.length, 0, 'empty B roots must not invoke a make world target');
assert.equal(paired.runtime.attempts[0].final.resolvedConfigDiff.addedDependencies.includes('auto-dependency'), true);
assert.equal(paired.runtime.attempts[0].newDependencyTargets.includes('package/network/auto-dependency/compile'), true);

const pairedShortCircuit = scenario('package-compile', { paired: true, failTargetPrerequisite: true, expectedStatus: 0 });
assert.equal(pairedShortCircuit.runtime.attempts[0].baseline.result, 'inconclusive');
assert.equal(pairedShortCircuit.runtime.attempts[0].final.result, 'not-run');
assert.equal(pairedShortCircuit.runtime.attempts[0].baseline.targetPrerequisiteCause, 'patch-apply');
assert.equal(pairedShortCircuit.calls.some((args) => args.includes('package/network/alpha/compile')), false, 'B failure must short-circuit A');

const pairedUnavailable = scenario('package-compile', { paired: true, packageUnavailable: true });
assert.equal(pairedUnavailable.runtime.conclusion, 'skipped');
assert.equal(pairedUnavailable.runtime.reason, 'root-absent-source');
assert.equal(pairedUnavailable.runtime.attempts[0].pairConclusion, 'preflight-skipped');
assert.equal(pairedUnavailable.runtime.attempts[0].baseline.result, 'not-run');
assert.equal(pairedUnavailable.runtime.attempts[0].final.result, 'not-run');
assert.deepEqual(pairedUnavailable.runtime.attempts[0].unavailableRoots, ['alpha']);
assert.equal(pairedUnavailable.runtime.attempts[0].stages.preflight.status, 'success');
assert.equal(pairedUnavailable.calls.some((args) => args.includes('defconfig')), false, 'absent paired roots must skip B/A defconfig');
assert.equal(pairedUnavailable.calls.some((args) => args.includes('prepare')), false, 'absent paired roots must skip B/A Target preparation');
assert.equal(pairedUnavailable.calls.some((args) => args.includes('package/network/alpha/compile')), false, 'absent paired roots must skip B/A package compilation');
for (const mode of ['config-resolve', 'rootfs-integration', 'firmware-integration', 'boot-smoke', 'runtime-health', 'reboot-validation']) {
  const unavailablePaired = scenario(mode, { paired: true, packageUnavailable: true });
  assert.equal(unavailablePaired.runtime.conclusion, 'skipped', `${mode} paired missing package must be skipped in preflight`);
  assert.equal(unavailablePaired.runtime.reason, 'root-absent-source');
  assert.equal(unavailablePaired.runtime.attempts[0].pairConclusion, 'preflight-skipped');
  assert.equal(unavailablePaired.runtime.attempts[0].baseline.result, 'not-run');
  assert.equal(unavailablePaired.runtime.attempts[0].final.result, 'not-run');
  assert.equal(unavailablePaired.calls.some((args) => args.includes('prepare')), false,
    `${mode} paired missing package must not enter Target preparation`);
  assert.equal(unavailablePaired.calls.some((args) => args.includes('package/compile') || args.includes('target/install') || args.includes('qemustart')), false,
    `${mode} paired missing package must not enter downstream stages`);
}

const pairedDependency = scenario('package-compile', { paired: true, failDependency: true });
assert.equal(pairedDependency.runtime.attempts[0].result, 'incompatible');
assert.equal(pairedDependency.runtime.attempts[0].packageCauseKind, 'dependency');
assert.equal(pairedDependency.runtime.attempts[0].pairConclusion, 'incompatible-dependency');

const pairedRootfsDependency = scenario('rootfs-integration', { paired: true, rootfsDependencyConflict: true });
assert.equal(pairedRootfsDependency.runtime.attempts[0].result, 'incompatible');
assert.equal(pairedRootfsDependency.runtime.attempts[0].packageCauseKind, 'dependency', 'A/B dependency rootfs conflicts must be attributed to the added dependency');

const pairedDirect = scenario('package-compile', { paired: true, failRoot: true });
assert.equal(pairedDirect.runtime.attempts[0].packageCauseKind, 'direct');
assert.equal(pairedDirect.runtime.attempts[0].pairConclusion, 'incompatible-direct');

const l1Paired = scenario('config-resolve', { paired: true });
assert.equal(l1Paired.runtime.attempts.length, 1, 'L1 B/A must keep one environment attempt');
assert.equal(l1Paired.runtime.attempts[0].baseline.result, 'compatible');
assert.equal(l1Paired.runtime.attempts[0].final.result, 'compatible');
assert.equal(l1Paired.runtime.attempts[0].pairConclusion, 'compatible');
assert.equal(l1Paired.calls.filter((args) => args.some((arg) => String(arg).includes('scripts/config/conf'))).length, 2, 'L1 must solve B and A separately');
const l1MixedPairs = scenario('config-resolve', { paired: true, l1Multiple: true, failL1Baseline: true, expectedStatus: 1 });
assert.equal(l1MixedPairs.runtime.attempts.length, 2);
assert.equal(l1MixedPairs.runtime.attempts[0].baseline.result, 'inconclusive');
assert.equal(l1MixedPairs.runtime.attempts[0].final.result, 'not-run');
assert.equal(l1MixedPairs.runtime.attempts[1].baseline.result, 'compatible');
assert.equal(l1MixedPairs.runtime.attempts[1].final.result, 'compatible', 'one environment B failure must not block another environment A');

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
const l2InnerTarget = scenario('package-compile', { failInnerWrapper: true, rootPackage: 'oscam' });
assert.equal(l2InnerTarget.runtime.conclusion, 'incompatible');
assert.deepEqual(l2InnerTarget.runtime.attempts[0].failedBuildTargets, ['package/network/oscam'],
  'inner oscam target must outrank an explicit outer wrapper');
assert.equal(l2InnerTarget.runtime.attempts[0].packageCauseKind, 'direct',
  'inner oscam target must remain directly attributable to the selected root');

const l2Prerequisite = scenario('package-compile', { failPrerequisite: true, expectedStatus: 0 });
assert.equal(l2Prerequisite.runtime.conclusion, 'inconclusive');
assert.equal(l2Prerequisite.runtime.reason, 'package-compile-prerequisite-failure');
assert.deepEqual(l2Prerequisite.runtime.attempts[0].failedBuildTargets, ['package/kernel/linux']);
assert.equal(l2Prerequisite.runtime.attempts[0].prerequisiteCause, 'kernel-prerequisite');
assert.match(l2Prerequisite.runtime.attempts[0].errorSummary, /geniv\.ko is missing/);

const l2InnerKernel = scenario('package-compile', {
  rootPackage: 'oscam', failInnerKernelWrapper: true, expectedStatus: 0,
});
assert.equal(l2InnerKernel.runtime.conclusion, 'inconclusive');
assert.equal(l2InnerKernel.runtime.reason, 'package-compile-prerequisite-failure',
  'an explicit inner kernel failure must be classified as a prerequisite, not an oscam package failure');
assert.deepEqual(l2InnerKernel.runtime.attempts[0].failedBuildTargets, ['package/kernel/linux'],
  'an explicit inner kernel target must outrank the outer oscam make wrapper');
assert.equal(l2InnerKernel.runtime.attempts[0].prerequisiteCause, 'kernel-prerequisite');
assert.equal(l2InnerKernel.runtime.attempts[0].packageCauseKind || '', '',
  'an upstream kernel prerequisite must not receive a plugin cause attribution');
assert.match(l2InnerKernel.runtime.attempts[0].failureFingerprint, /^[a-f0-9]{64}$/);

const l2InnerKernelMakeOnly = scenario('package-compile', {
  rootPackage: 'oscam', failInnerKernelMakeOnly: true, expectedStatus: 0,
});
assert.equal(l2InnerKernelMakeOnly.runtime.reason, 'package-compile-prerequisite-failure',
  'Make-only inner kernel failure must remain a prerequisite conclusion');
assert.deepEqual(l2InnerKernelMakeOnly.runtime.attempts[0].failedBuildTargets, ['package/kernel/linux'],
  'the first non-wrapper Make target must outrank the later oscam propagation wrapper');
assert.equal(l2InnerKernelMakeOnly.runtime.attempts[0].prerequisiteCause, 'kernel-prerequisite');
assert.equal(l2InnerKernelMakeOnly.runtime.attempts[0].packageCauseKind || '', '');

const l2DirectMakeOnly = scenario('package-compile', {
  rootPackage: 'oscam', failRootMakeOnly: true, expectedStatus: 0,
});
assert.equal(l2DirectMakeOnly.runtime.conclusion, 'incompatible',
  'a single direct oscam Make target must remain a plugin incompatibility');
assert.deepEqual(l2DirectMakeOnly.runtime.attempts[0].failedBuildTargets, ['package/network/oscam']);
assert.equal(l2DirectMakeOnly.runtime.attempts[0].packageCauseKind, 'direct');

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
  assert.deepEqual(targetPrerequisite.runtime.attempts[0].failedBuildTargets, ['target/linux'], `${mode} must preserve the generic failed target`);
  assert.match(targetPrerequisite.runtime.attempts[0].errorSummary, /\S+/, `${mode} must preserve a deterministic error summary`);
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
assert.equal(probeResultExitCode([{ result: 'inconclusive', reason: 'package-compile-prerequisite-failure', prerequisiteCause: 'kernel-prerequisite',
  failedBuildTargets: ['package/kernel/linux'], errorSummary: 'ERROR: module crypto/geniv.ko is missing' }]), 0,
  'a complete package prerequisite cause is a valid product terminal result');
assert.equal(probeResultExitCode([{ result: 'inconclusive', reason: 'package-compile-prerequisite-failure', prerequisiteCause: 'kernel-prerequisite',
  errorSummary: 'ERROR: module crypto/geniv.ko is missing' }]), 1,
  'a package prerequisite without a failed target must remain red');
assert.equal(probeResultExitCode([{ result: 'inconclusive', reason: 'package-compile-prerequisite-failure', prerequisiteCause: 'kernel-prerequisite',
  failedBuildTargets: ['package/kernel/linux'] }]), 1,
  'a package prerequisite without a deterministic error summary must remain red');
assert.equal(probeResultExitCode([{ result: 'inconclusive', reason: 'package-compile-prerequisite-failure' }]), 1,
  'a package prerequisite reason without a cause must remain red');
assert.equal(probeResultExitCode([{
  result: 'inconclusive', reason: 'baseline-failure', pairConclusion: 'baseline-failure',
  baseline: { result: 'inconclusive', reason: 'target-prerequisite-failure', targetPrerequisiteCause: 'kernel-prerequisite',
    failedBuildTargets: ['target/linux'], errorSummary: 'ERROR: target/linux failed to build' },
  issues: [{ type: 'target-prerequisite-failure', reason: 'target-prerequisite-failure', cause: 'kernel-prerequisite',
    targets: ['target/linux'], errorSummary: 'ERROR: target/linux failed to build' }],
}]), 0, 'a paired Baseline-B reported prerequisite is a valid product terminal result');
assert.equal(isReportedInconclusive({ result: 'inconclusive', reason: 'target-prerequisite-failure', targetPrerequisiteCause: 'patch-apply',
  failedBuildTargets: ['target/linux'], errorSummary: 'Hunk FAILED at 12' }), true);
assert.equal(isReportedInconclusive({ result: 'inconclusive', reason: 'target-prerequisite-failure', targetPrerequisiteCause: 'unknown' }), false);
assert.equal(isReportedInconclusive({ result: 'inconclusive', reason: 'package-compile-prerequisite-failure', prerequisiteCause: 'kernel-prerequisite',
  failedBuildTargets: ['package/kernel/linux'], errorSummary: 'ERROR: module crypto/geniv.ko is missing', packageCauseKind: 'direct' }), false,
  'direct package failures must never be reported as upstream prerequisites');

const kernelFingerprint = scenario('package-compile', { failPrerequisite: true, expectedStatus: 0 });
const patchFingerprint = scenario('package-compile', { failTargetPrerequisite: true, targetPrerequisiteCause: 'patch-apply' });
assert.notEqual(kernelFingerprint.runtime.attempts[0].failureFingerprint, patchFingerprint.runtime.attempts[0].failureFingerprint,
  'failure fingerprints must distinguish kernel prerequisite and patch errors');

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

const l3Prerequisite = scenario('rootfs-integration', { failRootfsPrerequisite: true, expectedStatus: 0 });
assert.equal(l3Prerequisite.runtime.conclusion, 'inconclusive');
assert.equal(l3Prerequisite.runtime.reason, 'rootfs-package-prerequisite-failure');
assert.deepEqual(l3Prerequisite.runtime.attempts[0].failedBuildTargets, ['package/kernel/linux']);
assert.equal(l3Prerequisite.runtime.attempts[0].prerequisiteCause, 'kernel-prerequisite');

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

const l4Prerequisite = scenario('firmware-integration', { failFirmwarePrerequisite: true, expectedStatus: 0 });
assert.equal(l4Prerequisite.runtime.conclusion, 'inconclusive');
assert.equal(l4Prerequisite.runtime.reason, 'firmware-prerequisite-failure');
assert.deepEqual(l4Prerequisite.runtime.attempts[0].failedBuildTargets, ['package/kernel/linux']);
assert.equal(l4Prerequisite.runtime.attempts[0].prerequisiteCause, 'kernel-prerequisite');

const l7InheritedPrerequisite = scenario('reboot-validation', { failFirmwarePrerequisite: true, expectedStatus: 0 });
assert.equal(l7InheritedPrerequisite.runtime.conclusion, 'inconclusive',
  'L5-L7 must inherit the same prerequisite attribution instead of blaming the selected package');
assert.equal(l7InheritedPrerequisite.runtime.reason, 'firmware-prerequisite-failure');
assert.equal(l7InheritedPrerequisite.runtime.attempts[0].prerequisiteCause, 'kernel-prerequisite');

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

const finalizeBaseEnv = {
  PROBE_BOOTSTRAP_OUTCOME: 'success', PROBE_CLONE_OUTCOME: 'success', PROBE_REQUIREMENTS_OUTCOME: 'success', PROBE_PYTHON_SETUP_OUTCOME: 'skipped',
  PROBE_RUNTIME_SETUP_OUTCOME: 'success', PROBE_FEEDS_OUTCOME: 'success', PROBE_EVIDENCE_OUTCOME: 'success',
  PROBE_EVIDENCE_UPLOAD_OUTCOME: 'success', PROBE_LOG_UPLOAD_OUTCOME: 'success', PROBE_BUILD_OUTCOME: 'success',
};
const finalizeIdentity = {
  source: 'LEDE', branch: 'master', targetSystem: 'x86', subtarget: '64', target: 'x86/64', profile: 'DEVICE_generic',
  phase: 'final', pairId: '',
};
const finalizeErrorSummary = 'ERROR: module crypto/geniv.ko is missing';
const finalizeTarget = 'package/kernel/linux';
const finalizeIssue = {
  type: 'package-build-failure', reason: 'package-compile-prerequisite-failure', cause: 'kernel-prerequisite',
  targets: [finalizeTarget], errorSummary: finalizeErrorSummary,
};
const finalizeAttempt = {
  ...finalizeIdentity, result: 'inconclusive', reason: 'package-compile-prerequisite-failure',
  prerequisiteCause: 'kernel-prerequisite', failedBuildTargets: [finalizeTarget], errorSummary: finalizeErrorSummary,
};
const finalizeEvidence = {
  ...finalizeIdentity, conclusion: 'inconclusive', reason: finalizeAttempt.reason,
  prerequisiteCause: finalizeAttempt.prerequisiteCause, failedBuildTargets: [finalizeTarget], errorSummary: finalizeErrorSummary,
  issues: [finalizeIssue],
};
assert.equal(probeResultExitCode([finalizeAttempt]), 0,
  'runtime attempts may omit normalized issues when cause, target, and summary are complete');
const finalizeReported = evaluateFinalize({
  env: finalizeBaseEnv,
  runtime: { attempts: [finalizeAttempt] },
  evidence: [finalizeEvidence],
});
assert.equal(finalizeReported.ok, true, 'Finalize must accept complete LEDE prerequisite evidence');
const pairedFinalizeIdentity = { ...finalizeIdentity, phase: 'paired', pairId: 'pair:lede-baseline' };
const pairedBaselineAttempt = {
  result: 'inconclusive', reason: 'package-compile-prerequisite-failure', prerequisiteCause: 'kernel-prerequisite',
  failedBuildTargets: [finalizeTarget], errorSummary: finalizeErrorSummary,
};
const pairedRuntimeAttempt = {
  ...pairedFinalizeIdentity, result: 'inconclusive', reason: 'baseline-failure', pairConclusion: 'baseline-failure',
  baseline: pairedBaselineAttempt, final: { result: 'not-run', reason: 'baseline-failure' },
};
const pairedEvidence = {
  ...pairedFinalizeIdentity, schema: 5, conclusion: 'inconclusive', reason: 'baseline-failure', pairConclusion: 'baseline-failure',
  baseline: pairedBaselineAttempt, final: { result: 'not-run', reason: 'baseline-failure' }, issues: [finalizeIssue],
};
assert.equal(probeResultExitCode([pairedRuntimeAttempt]), 0,
  'paired runtime wrappers may omit normalized issues when the inner prerequisite is complete');
const finalizePairedReported = evaluateFinalize({
  env: finalizeBaseEnv, runtime: { attempts: [pairedRuntimeAttempt] }, evidence: [pairedEvidence],
});
assert.equal(finalizePairedReported.ok, true, 'Finalize must accept a complete paired Baseline-B prerequisite evidence row');
const pairedEvidenceWithoutIssues = { ...pairedEvidence };
delete pairedEvidenceWithoutIssues.issues;
const finalizePairedMissingIssues = evaluateFinalize({
  env: finalizeBaseEnv, runtime: { attempts: [pairedRuntimeAttempt] }, evidence: [pairedEvidenceWithoutIssues],
});
assert.equal(finalizePairedMissingIssues.ok, false,
  'Finalize must reject a paired evidence row whose normalized issues array is absent');
const finalizeUnattributed = evaluateFinalize({
  env: finalizeBaseEnv,
  runtime: { attempts: [{ ...finalizeAttempt, reason: 'package-compile-unattributed-failure' }] },
  evidence: [{ ...finalizeEvidence, reason: 'package-compile-unattributed-failure', issues: [] }],
});
assert.equal(finalizeUnattributed.ok, false, 'Finalize must reject an unattributed package failure');
const finalizeMissingTarget = evaluateFinalize({
  env: finalizeBaseEnv,
  runtime: { attempts: [{ ...finalizeAttempt, failedBuildTargets: [] }] },
  evidence: [{ ...finalizeEvidence, failedBuildTargets: [], issues: [{ ...finalizeIssue, targets: [] }] }],
});
assert.equal(finalizeMissingTarget.ok, false, 'Finalize must reject prerequisite evidence without a failed target');
const finalizeMissingSummary = evaluateFinalize({
  env: finalizeBaseEnv,
  runtime: { attempts: [{ ...finalizeAttempt, errorSummary: '' }] },
  evidence: [{ ...finalizeEvidence, errorSummary: '', issues: [{ ...finalizeIssue, errorSummary: '' }] }],
});
assert.equal(finalizeMissingSummary.ok, false, 'Finalize must reject prerequisite evidence without a deterministic summary');
const finalizeMissingIssue = evaluateFinalize({
  env: finalizeBaseEnv,
  runtime: { attempts: [finalizeAttempt] },
  evidence: [{ ...finalizeEvidence, issues: [] }],
});
assert.equal(finalizeMissingIssue.ok, false, 'Finalize must reject prerequisite evidence without a matching structured issue');
const finalizeMissingIssuesFieldEvidence = { ...finalizeEvidence };
delete finalizeMissingIssuesFieldEvidence.issues;
const finalizeMissingIssuesField = evaluateFinalize({
  env: finalizeBaseEnv,
  runtime: { attempts: [finalizeAttempt] },
  evidence: [finalizeMissingIssuesFieldEvidence],
});
assert.equal(finalizeMissingIssuesField.ok, false, 'Finalize must reject evidence with no issues array');
const finalizeInfrastructure = evaluateFinalize({
  env: finalizeBaseEnv,
  runtime: { attempts: [finalizeAttempt] },
  evidence: [{ ...finalizeEvidence, issues: [finalizeIssue, { type: 'infrastructure-failure', reason: 'feed-stage' }] }],
});
assert.equal(finalizeInfrastructure.ok, false, 'Finalize must reject evidence containing infrastructure failure');
const finalizeRuntimeMissing = evaluateFinalize({ env: finalizeBaseEnv, runtime: { attempts: [] }, evidence: [] });
assert.equal(finalizeRuntimeMissing.ok, false, 'Finalize must reject missing runtime attempts and evidence');
const finalizeEvidenceMissing = evaluateFinalize({ env: finalizeBaseEnv, runtime: { attempts: [finalizeAttempt] }, evidence: [] });
assert.equal(finalizeEvidenceMissing.ok, false, 'Finalize must reject missing evidence for a runtime attempt');
const finalizeCountMismatch = evaluateFinalize({
  env: finalizeBaseEnv, runtime: { attempts: [finalizeAttempt] }, evidence: [finalizeEvidence, { ...finalizeEvidence, pairId: 'extra' }],
});
assert.equal(finalizeCountMismatch.ok, false, 'Finalize must reject a runtime/evidence count mismatch');
const finalizeIdentityMismatch = evaluateFinalize({
  env: finalizeBaseEnv, runtime: { attempts: [finalizeAttempt] }, evidence: [{ ...finalizeEvidence, profile: 'DEVICE_other' }],
});
assert.equal(finalizeIdentityMismatch.ok, false, 'Finalize must reject a runtime/evidence identity mismatch');
for (const outcome of ['failure', 'cancelled', 'skipped', '']) {
  const result = evaluateFinalize({ env: { ...finalizeBaseEnv, PROBE_BUILD_OUTCOME: outcome }, runtime: { attempts: [finalizeAttempt] }, evidence: [finalizeEvidence] });
  assert.equal(result.ok, false, `Finalize must reject build outcome ${outcome || 'empty'}`);
}

console.log('Package Probe final-only and paired runner checks passed.');

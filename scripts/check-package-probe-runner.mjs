#!/usr/bin/env node
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const runner = resolve(import.meta.dirname, 'run-package-probe.mjs');

function fakeMakeSource() {
  return `#!/usr/bin/env node
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const args = process.argv.slice(2);
appendFileSync(process.env.FAKE_MAKE_LOG, JSON.stringify(args) + '\\n');
if (args.includes('defconfig')) {
  if (process.env.FAKE_EXPECT_DISABLED === 'true' && !readFileSync(join(process.cwd(), '.config'), 'utf8').includes('# CONFIG_PACKAGE_beta is not set')) process.exit(2);
  mkdirSync(join(process.cwd(), 'tmp'), { recursive: true });
  writeFileSync(join(process.cwd(), 'tmp', '.packageinfo'), 'Source-Makefile: package/network/alpha/Makefile\\nPackage: alpha\\n');
  appendFileSync(join(process.cwd(), '.config'), 'CONFIG_PACKAGE_auto-dependency=y\\n');
}
if (process.env.FAKE_FAIL_INFRA === 'true' && args.includes('package/network/alpha/compile')) {
  console.error('curl: (6) Could not resolve host: downloads.example.invalid');
  process.exit(2);
}
if (process.env.FAKE_FAIL_PARALLEL === 'true' && args.includes('package/network/alpha/compile') && args[0] !== '-j1') process.exitCode = 1;
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
    return { calls, runtime };
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
const l2Infrastructure = scenario('package-compile', { failInfrastructure: true, expectedStatus: 1 });
assert.equal(l2Infrastructure.runtime.conclusion, 'inconclusive');
assert.equal(l2Infrastructure.runtime.reason, 'package-compile-infrastructure');
assert.equal(l2Infrastructure.runtime.attempts[0].serialRetries[0].result, 'failure');

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

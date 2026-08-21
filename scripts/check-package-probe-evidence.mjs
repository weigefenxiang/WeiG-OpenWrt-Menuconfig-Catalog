#!/usr/bin/env node
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  aggregateEvidence, aggregateRunStatus, aggregateScopeConclusions, createEvidence, evidenceSummaryLines, parseProbeLog,
} from './write-package-probe-evidence.mjs';

const state = (env, count = 0) => aggregateRunStatus(env, count).state;
assert.equal(state({ PLAN_RESULT: 'failure', PROBE_RESULT: 'skipped' }), 'plan-failure');
assert.equal(state({ PLAN_RESULT: 'success', PROBE_RESULT: 'skipped', EXECUTE: 'false', AUTHORIZED: 'true' }), 'plan-only');
assert.equal(state({ PLAN_RESULT: 'success', PROBE_RESULT: 'failure', EXECUTE: 'true', AUTHORIZED: 'true' }, 1), 'execution-collected-with-failures');
assert.equal(state({ PLAN_RESULT: 'success', PROBE_RESULT: 'success', EXECUTE: 'true', AUTHORIZED: 'true' }, 1), 'execution-success');

const row = (source, branch, conclusion) => ({ schema: 4, source, branch, targetSystem: 'x86', subtarget: '64', target: 'x86/64', profile: 'DEVICE_generic',
  roots: ['luci-app-test'], conclusion, issues: [], attempts: [], fingerprint: 'a'.repeat(64) });
assert.equal(aggregateScopeConclusions([row('A', 'main', 'compatible'), row('A', 'main', 'compatible')], { exhaustive: true })[0].conclusion, 'fully-compatible');
assert.equal(aggregateScopeConclusions([row('A', 'main', 'incompatible')], { exhaustive: false })[0].conclusion, 'sampled-incompatible');
assert.equal(aggregateScopeConclusions([row('A', 'main', 'compatible'), row('A', 'main', 'incompatible')], { exhaustive: true })[0].conclusion, 'partially-compatible');
assert.equal(aggregateScopeConclusions([row('A', 'main', 'compatible'), row('A', 'main', 'incompatible'), row('A', 'main', 'inconclusive')], { exhaustive: true })[0].conclusion, 'incomplete',
  'infrastructure uncertainty must mark mixed business compatibility results incomplete without erasing them');

const workflow = readFileSync(resolve(import.meta.dirname, '../.github/workflows/package-probe.yml'), 'utf8');
assert(workflow.includes("format('[probe · {0}] {1} · #{2} · {3}'"), 'Issue-triggered run name must expose Probe level, roots, Issue, and channel without repeating the mode');
assert(workflow.includes("inputs.batch_index != '0'"), 'batch suffix must be omitted for the first batch and retained for continuations');
assert(!workflow.includes('Package probe issue #{0} · batch {1}'), 'legacy opaque Issue run name must not return');

const dependencyInstaller = readFileSync(resolve(import.meta.dirname, './install-probe-dependencies.sh'), 'utf8');
const feedInstaller = readFileSync(resolve(import.meta.dirname, './install-probe-feeds.sh'), 'utf8');
const runtimeSetup = readFileSync(resolve(import.meta.dirname, './setup-probe-runtime.sh'), 'utf8');
assert(workflow.includes('bash scripts/install-probe-dependencies.sh'), 'Probe jobs must use the bounded dependency bootstrap helper');
assert(dependencyInstaller.includes('PROBE_APT_MAX_ATTEMPTS:-3'), 'dependency bootstrap must default to three total attempts');
assert(dependencyInstaller.includes('PROBE_APT_UPDATE_TIMEOUT_SECONDS:-60'), 'apt update attempts must default to the approved 60-second bound');
assert(dependencyInstaller.includes('PROBE_APT_INSTALL_TIMEOUT_SECONDS:-300'), 'dependency bootstrap must default to the approved 300-second bound');
assert(!dependencyInstaller.includes('PROBE_APT_ATTEMPT_TIMEOUT_SECONDS'), 'the obsolete one-size-fits-all apt timeout must not return');
assert(dependencyInstaller.includes('prepare_initial_ubuntu_source'), 'dependency bootstrap must prepare the Ubuntu source before the first update attempt');
assert(dependencyInstaller.indexOf('prepare_initial_ubuntu_source\nretry_apt \"apt-get update\"') > dependencyInstaller.indexOf('prepare_initial_ubuntu_source() {'),
  'the first apt update must run only after the initial Ubuntu source preparation call');
assert(dependencyInstaller.includes('replacing the GitHub Runner Ubuntu mirror with direct archive/security sources before the first update attempt'),
  'the first apt update must bypass the unstable Runner Azure mirror when the mirror list is available');
assert(dependencyInstaller.includes('retry_apt "apt-get update" "$UPDATE_TIMEOUT_SECONDS" update'), 'apt update must use its own timeout stage');
assert(dependencyInstaller.includes('retry_apt "config-resolve build dependencies" "$INSTALL_TIMEOUT_SECONDS" install'), 'dependency install must use its own timeout stage');
assert(dependencyInstaller.includes('python3-pyelftools'),
  'build-capable Probe depths must install the pyelftools host prerequisite required by upstream package and RootFS builds');
assert.equal((dependencyInstaller.match(/retry_apt "apt-get update"/g) || []).length, 1, 'successful apt update must not be repeated by install retries');
assert(!dependencyInstaller.includes('apt-get clean') && !dependencyInstaller.includes('apt clean') && !dependencyInstaller.includes('/var/cache/apt/archives'), 'dependency retries must preserve apt download/cache state');
assert(!dependencyInstaller.includes('  -qq\n'), 'dependency bootstrap must not suppress apt diagnostics with quiet level 2');
assert(dependencyInstaller.includes('  -y\n'), 'dependency bootstrap must remain noninteractive after exposing apt output');
assert(dependencyInstaller.includes('ATTEMPT_LOG_TAIL_LINES=80'), 'failed dependency attempts must retain a bounded diagnostic tail');
assert(dependencyInstaller.includes('tail -n "$ATTEMPT_LOG_TAIL_LINES" "$attempt_log"'), 'failed dependency attempts must print their captured output tail');
assert(dependencyInstaller.includes('status == 124 || status == 137'), 'timeout-related dependency exits must be diagnosed explicitly');
assert(dependencyInstaller.includes('completed in ${elapsed}s'), 'dependency attempts must expose elapsed time');
assert(dependencyInstaller.includes('[TIMING] stage=${stage}'), 'dependency bootstrap must emit machine-readable stage timing records');
assert(dependencyInstaller.includes("record_timing 'mirror-switch'"), 'mirror failover preparation must expose elapsed time');
assert(dependencyInstaller.includes("record_timing 'dpkg-recovery'"), 'dpkg recovery must expose elapsed time');
assert(dependencyInstaller.includes("record_timing 'backoff'"), 'retry backoff must expose its actual elapsed time');
assert(dependencyInstaller.includes("record_timing 'bootstrap-total'"), 'dependency bootstrap must expose total elapsed time on exit');
assert(dependencyInstaller.includes('Probe bootstrap timing summary:'), 'dependency bootstrap must print a human-readable timing summary');
assert(!dependencyInstaller.includes('echo "$machine" | tee -a "$PROBE_LOG"'), 'timing telemetry must stay out of the shared Probe evidence log');
assert(!dependencyInstaller.includes('cat "$TIMING_SUMMARY_FILE" | tee -a "$PROBE_LOG"'), 'timing summary must not contaminate shared Probe evidence');
assert(dependencyInstaller.includes('Acquire::Retries=3'), 'apt must retain its own transport retry protection');
assert(dependencyInstaller.includes('Acquire::http::Timeout=${APT_IO_TIMEOUT_SECONDS}'), 'apt HTTP reads must have a bounded timeout');
assert(dependencyInstaller.includes('Acquire::https::Timeout=${APT_IO_TIMEOUT_SECONDS}'), 'apt HTTPS reads must have a bounded timeout');
assert(dependencyInstaller.includes('dpkg --configure -a'), 'interrupted package installation must recover dpkg state before retry');
assert(!dependencyInstaller.includes('/var/lib/dpkg/lock'), 'dependency recovery must never delete dpkg lock files');
assert(!dependencyInstaller.includes('make defconfig'), 'infrastructure retries must not wrap Kconfig business conclusions');
assert(dependencyInstaller.includes('UBUNTU_MIRROR_INDEX_URL="http://mirrors.ubuntu.com/mirrors.txt"'), 'apt update failover must use the official Ubuntu geo mirror index');
assert(dependencyInstaller.includes('prepare_update_retry_source "$((attempt + 1))"'), 'apt update retries must change mirror strategy after a failed attempt');
assert(dependencyInstaller.includes('official geo mirror index before attempt'), 'the second apt update attempt must expose its geo-mirror failover');
assert(dependencyInstaller.includes('direct archive/security fallback before attempt'), 'the final apt update attempt must expose its direct Ubuntu fallback');
assert(dependencyInstaller.includes('https://archive.ubuntu.com/ubuntu/') && dependencyInstaller.includes('https://security.ubuntu.com/ubuntu/'), 'direct failover must stay on official Ubuntu archives');
assert(!dependencyInstaller.includes('apt-get clean') && !dependencyInstaller.includes('rm -rf /var/lib/apt/lists'), 'mirror failover must preserve apt state rather than clearing caches or lists');
assert(workflow.includes('id: bootstrap') && workflow.includes('continue-on-error: true'), 'dependency bootstrap must be recorded without automatically failing the matrix job');
assert(workflow.includes("if: steps.bootstrap.outcome == 'success'"), 'Probe business steps must run only after dependency bootstrap succeeds');
assert(workflow.includes("steps.clone.outcome != 'success'") && workflow.includes("steps.requirements.outcome != 'success'"),
  'clone and upstream runtime-contract failures must fail the environment job after evidence is written');
assert(workflow.includes('PROBE_BOOTSTRAP_OUTCOME: ${{ steps.bootstrap.outcome }}'), 'normalized evidence must explicitly record dependency bootstrap outcome');
assert(workflow.includes('id: clone') && workflow.includes('id: requirements') && workflow.includes('bash scripts/setup-probe-runtime.sh detect'),
  'Probe jobs must clone first, then detect the upstream runtime contract');
assert(workflow.indexOf('id: clone') < workflow.indexOf('id: requirements') && workflow.indexOf('id: requirements') < workflow.indexOf('id: runtime'),
  'runtime selection must be driven by the cloned upstream prerequisite files');
assert(workflow.includes('id: feeds') && workflow.includes('bash "$GITHUB_WORKSPACE/scripts/install-probe-feeds.sh"'), 'Probe jobs must use the bounded feed installer');
assert(workflow.includes("if: steps.bootstrap.outcome == 'success' && steps.clone.outcome == 'success' && steps.runtime.outcome == 'success'"),
  'Probe business execution must require bootstrap, clone, runtime, and feeds success');
assert(workflow.includes('PROBE_RUNTIME_SETUP_OUTCOME: ${{ steps.runtime.outcome }}'), 'normalized evidence must record runtime setup outcome');
assert(workflow.includes('PROBE_RUNTIME_REQUIREMENTS_OUTCOME: ${{ steps.requirements.outcome }}') &&
  workflow.includes('PROBE_PYTHON_SETUP_OUTCOME: ${{ steps.python.outcome }}'),
  'normalized evidence must distinguish runtime detection and Python installation failures');
assert(workflow.includes('PROBE_FEEDS_OUTCOME: ${{ steps.feeds.outcome }}'), 'normalized evidence must record feeds outcome');
assert(workflow.includes('probe-feeds-runtime.json'), 'Probe log artifacts must retain normalized feed identity metadata');
assert(feedInstaller.includes('PROBE_FEED_MAX_ATTEMPTS:-3'), 'feed updates must default to three total attempts');
assert(feedInstaller.includes('PROBE_FEED_TIMEOUT_SECONDS:-180'), 'each feed update attempt must have a bounded timeout');
assert(feedInstaller.includes('./scripts/feeds list -sf | awk -v name="$feed"'),
  'feed URI lookup must request source URLs from the upstream feeds parser before the first update attempt');
assert(!feedInstaller.includes('./scripts/feeds list -f | awk -v name="$feed"'),
  'feed URI lookup must never call list -f without -s because that omits source URLs');
const feedListingFixture = [
  'src-git packages https://git.openwrt.org/feed/packages.git',
  'src-git luci https://git.openwrt.org/project/luci.git',
].join('\n');
const packagesFeedUriFixture = feedListingFixture.split(/\n/)
  .map((line) => line.trim().split(/\s+/))
  .find((fields) => fields[1] === 'packages')?.[2] || '';
assert.equal(packagesFeedUriFixture, 'https://git.openwrt.org/feed/packages.git',
  'canonical feeds list output must resolve the packages feed URI before retries are counted');
assert(feedInstaller.includes('https://github.com/openwrt/packages.git') && feedInstaller.includes('https://github.com/openwrt/luci.git') &&
  feedInstaller.includes('https://github.com/openwrt/routing.git') && feedInstaller.includes('https://github.com/openwrt/telephony.git'),
'network recovery must stay on official OpenWrt GitHub mirrors');
assert(feedInstaller.includes("reason='feed-network'") && feedInstaller.includes("reason='feed-timeout'"),
  'feed retries must expose network and timeout reasons structurally');
assert(feedInstaller.includes("fail_stage 'feed-config'") && feedInstaller.includes('fail_stage "$reason"'),
  'deterministic or exhausted feed failures must stop the feed stage immediately');
assert(feedInstaller.indexOf("./scripts/feeds install -a") > feedInstaller.indexOf('for feed in "${FEEDS[@]}"'),
  'feed installation must start only after all feed updates complete');
assert(!runtimeSetup.includes('PROBE_SOURCE') && !runtimeSetup.includes('PROBE_BRANCH') &&
  !/OpenWrt|ImmortalWrt|lede|openwrt-\d/i.test(runtimeSetup),
  'runtime selection must not special-case a Source or Branch name');
assert(runtimeSetup.includes('include/prereq-build.mk') && runtimeSetup.includes('contract_block python') && runtimeSetup.includes('contract_block gcc'),
  'runtime selection must derive Python and compiler requirements from the cloned upstream prerequisite contract');
assert(runtimeSetup.includes('make -C "$WORKDIR" -j1 prepare-mk'),
  'the activated runtime must validate upstream host prerequisites without requiring Target/Profile configuration');
assert(!runtimeSetup.includes('make -C "$WORKDIR" -j1 prereq'),
  'runtime activation must not invoke the interactive top-level prereq target before .config exists');
assert(runtimeSetup.includes('install gcc-10 g++-10'),
  'a generically detected legacy compiler contract must retain the supported gcc-10 adapter');
assert(runtimeSetup.includes('Python-${PYTHON2_VERSION}.tar.xz') && runtimeSetup.includes('www.python.org/ftp/python'),
  'legacy Python 2 must come from the official Python source release');
assert(runtimeSetup.includes('b62c0e7937551d0cc02b8fd5cb0f544f9405bafc9a54d3808ed4594812edef43'),
  'legacy Python 2 source must be checksum pinned');
assert(!runtimeSetup.includes('FORCE=1'), 'legacy source prerequisites must be satisfied rather than bypassed with FORCE=1');

function detectRuntimeFixture(prerequisiteContract, options = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'probe-runtime-contract-'));
  try {
    const workdir = join(directory, 'upstream');
    const include = join(workdir, 'include');
    const bin = join(directory, 'bin');
    const output = join(directory, 'outputs.txt');
    mkdirSync(include, { recursive: true });
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(include, 'prereq-build.mk'), prerequisiteContract);
    const executable = (name, lines) => {
      const file = join(bin, name);
      writeFileSync(file, lines.join('\n') + '\n');
      chmodSync(file, 0o755);
    };
    executable('python3', [
      '#!/usr/bin/env bash',
      `if [[ "\${1:-}" == '-V' ]]; then echo 'Python 3.${options.pythonMinor ?? 13}.0'; exit 0; fi`,
      `if [[ "\${2:-}" == *distutils* ]]; then exit ${options.distutils === false ? 1 : 0}; fi`,
      `echo '${options.pythonMinor ?? 13}'`,
    ]);
    executable('gcc', ['#!/usr/bin/env bash', `[[ "\${1:-}" != '-dumpversion' ]] || { echo '${options.gccMajor ?? 13}'; exit; }`,
      `echo 'gcc (Ubuntu) ${options.gccMajor ?? 13}.2.0'`]);
    executable('gcc-10', ['#!/usr/bin/env bash', "[[ \"${1:-}\" != '-dumpversion' ]] || { echo '10'; exit; }",
      "echo 'gcc (Ubuntu) 10.5.0'"]);
    const result = spawnSync('bash', [resolve(import.meta.dirname, 'setup-probe-runtime.sh'), 'detect'], {
      encoding: 'utf8', env: { ...process.env, PATH: `${bin.replaceAll('\\', '/')}:${process.env.PATH || ''}`,
        PROBE_WORKDIR: workdir, GITHUB_OUTPUT: output },
    });
    assert.equal(result.status, 0, `runtime fixture failed:\n${result.stdout}\n${result.stderr}`);
    return Object.fromEntries(readFileSync(output, 'utf8').trim().split(/\r?\n/)
      .map((line) => line.split(/=(.*)/s).slice(0, 2)));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function activateRuntimeFixture() {
  const directory = mkdtempSync(join(tmpdir(), 'probe-runtime-activate-'));
  try {
    const workdir = join(directory, 'upstream');
    const include = join(workdir, 'include');
    const bin = join(directory, 'bin');
    const output = join(directory, 'outputs.txt');
    const makeLog = join(directory, 'make.log');
    mkdirSync(include, { recursive: true });
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(include, 'prereq-build.mk'), '# upstream host prerequisite contract\n');
    const executable = (name, lines) => {
      const file = join(bin, name);
      writeFileSync(file, lines.join('\n') + '\n');
      chmodSync(file, 0o755);
    };
    executable('python3', ['#!/usr/bin/env bash', "echo 'Python 3.13.0'"]);
    executable('make', [
      '#!/usr/bin/env bash',
      'printf \'%s\\n\' "$*" >>"$PROBE_ACTIVATE_LOG"',
      '[[ "$*" == "-C $PROBE_WORKDIR -j1 prepare-mk" ]] || { echo "unexpected make target: $*" >&2; exit 91; }',
      '[[ ! -e "$PROBE_WORKDIR/.config" ]] || { echo "activate must not create .config" >&2; exit 92; }',
    ]);
    const result = spawnSync('bash', [resolve(import.meta.dirname, 'setup-probe-runtime.sh'), 'activate'], {
      encoding: 'utf8', env: { ...process.env, PATH: `${bin.replaceAll('\\', '/')}:${process.env.PATH || ''}`,
        PROBE_WORKDIR: workdir.replaceAll('\\', '/'), PROBE_RUNTIME_KIND: 'python3', PROBE_COMPILER_KIND: 'system',
        PROBE_ACTIVATE_LOG: makeLog.replaceAll('\\', '/'), GITHUB_OUTPUT: output.replaceAll('\\', '/') },
    });
    assert.equal(result.status, 0, `runtime activation fixture failed:\n${result.stdout}\n${result.stderr}`);
    assert.equal(readFileSync(makeLog, 'utf8').trim(), `-C ${workdir.replaceAll('\\', '/')} -j1 prepare-mk`);
    assert(!existsSync(join(workdir, '.config')), 'runtime activation must not synthesize Target/Profile configuration');
    const outputs = Object.fromEntries(readFileSync(output, 'utf8').trim().split(/\r?\n/)
      .map((line) => line.split(/=(.*)/s).slice(0, 2)));
    assert.deepEqual(outputs, { runtime: 'python3', version: 'Python 3.13.0', compiler: 'system' });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

const legacyRuntime = detectRuntimeFixture([
  '$(eval $(call SetupHostCommand,python,Please install Python 2.x, \\', '\tpython2.7 -V, \\', '\tpython2 -V))',
  '$(eval $(call SetupHostCommand,gcc,Please install GCC, \\', "\tgcc -dumpversion | grep -E '^(4\\.[8-9]|[5-9]\\.?|10\\.?)'))", '',
].join('\n'));
assert.deepEqual(legacyRuntime, { runtime: 'python2', python_version: '2.7', compiler: 'gcc-10' });

const distutilsRuntime = detectRuntimeFixture([
  '$(eval $(call SetupHostCommand,python,Please install Python, \\', '\tpython3.10 -V, \\', '\tpython3.9 -V, \\',
  "\tpython3 -V 2>&1 | grep -E 'Python 3\\.(6|7|8|9|10)'))",
  "$(eval $(call TestHostCommand,python3-distutils,python3 -c 'import distutils'))",
  '$(eval $(call SetupHostCommand,gcc,Please install GCC, \\', '\tgcc --version))', '',
].join('\n'), { distutils: false });
assert.deepEqual(distutilsRuntime, { runtime: 'python3', python_version: '3.10', compiler: 'system' });

const modernRuntime = detectRuntimeFixture([
  '$(eval $(call SetupHostCommand,python,Please install Python, \\', '\tpython3.13 -V, \\', '\tpython3.12 -V, \\',
  "\tpython3 -V 2>&1 | grep -E 'Python 3\\.(8|9|10|11|12|13)'))",
  "$(eval $(call TestHostCommand,python3-distutils,printf 'from distutils if old' | python3))",
  '$(eval $(call SetupHostCommand,gcc,Please install GCC, \\', '\tgcc --version))', '',
].join('\n'));
assert.deepEqual(modernRuntime, { runtime: 'python3', python_version: 'system', compiler: 'system' });
activateRuntimeFixture();

const evidenceWriter = readFileSync(resolve(import.meta.dirname, './write-package-probe-evidence.mjs'), 'utf8');
assert.equal((evidenceWriter.match(/appendFileSync\(env\.GITHUB_STEP_SUMMARY/g) || []).length, 1,
  'only the aggregate job may write the GitHub Step Summary');

const infrastructure = createEvidence({ log: 'No space left on device', runtime: { conclusion: 'incompatible', attempts: [] }, env: { PROBE_ROOTS: 'alpha' } });
assert.equal(infrastructure.conclusion, 'inconclusive');

const bootstrapInfrastructure = createEvidence({ log: '', runtime: null, env: { PROBE_ROOTS: 'alpha', PROBE_BOOTSTRAP_OUTCOME: 'failure', PROBE_CONCLUSION: 'failure' } });
assert.equal(bootstrapInfrastructure.conclusion, 'inconclusive');
assert(bootstrapInfrastructure.issues.some((issue) => issue.type === 'infrastructure-failure' && issue.reason === 'dependency-bootstrap'));

const cloneInfrastructure = createEvidence({ log: '', runtime: null, env: {
  PROBE_ROOTS: 'alpha', PROBE_BOOTSTRAP_OUTCOME: 'success', PROBE_CLONE_OUTCOME: 'failure', PROBE_CONCLUSION: 'failure',
} });
assert.equal(cloneInfrastructure.conclusion, 'inconclusive');
assert(cloneInfrastructure.issues.some((issue) => issue.type === 'infrastructure-failure' && issue.reason === 'source-clone'));

const runtimeInfrastructure = createEvidence({ log: '', runtime: null, env: {
  PROBE_ROOTS: 'alpha', PROBE_BOOTSTRAP_OUTCOME: 'success', PROBE_RUNTIME_SETUP_OUTCOME: 'failure', PROBE_RUNTIME_KIND: 'python2',
} });
assert.equal(runtimeInfrastructure.conclusion, 'inconclusive');
assert(runtimeInfrastructure.issues.some((issue) => issue.type === 'infrastructure-failure' && issue.reason === 'runtime-setup' && issue.runtime === 'python2'));

const feedInfrastructure = createEvidence({ log: `error: RPC failed; HTTP 504 curl 22\nfatal: expected packfile\n`, runtime: null, env: {
  PROBE_ROOTS: 'alpha', PROBE_BOOTSTRAP_OUTCOME: 'success', PROBE_RUNTIME_SETUP_OUTCOME: 'success',
  PROBE_FEEDS_OUTCOME: 'failure', PROBE_FEEDS_FAILURE_REASON: 'feed-network', PROBE_FEEDS_FAILURE_FEED: 'packages',
} });
assert.equal(feedInfrastructure.conclusion, 'inconclusive');
assert(feedInfrastructure.issues.some((issue) => issue.type === 'infrastructure-failure' && issue.reason === 'feed-network' && issue.feed === 'packages'));
assert(feedInfrastructure.issues.some((issue) => issue.type === 'package-download-failure'), 'HTTP 5xx/RPC feed failures must remain recognizable as network failures');

const feedFallbackClassification = createEvidence({ log: `error: RPC failed; HTTP 504 curl 22\n`, runtime: null, env: {
  PROBE_ROOTS: 'alpha', PROBE_FEEDS_OUTCOME: 'failure',
} });
assert(feedFallbackClassification.issues.some((issue) => issue.type === 'infrastructure-failure' && issue.reason === 'feed-network'),
  'feeds failure must infer network infrastructure when structured feed outputs are missing');

const hostPrerequisite = createEvidence({
  log: "Checking 'python'... failed.\nBuild dependency: Please install Python 2.x\nPrerequisite check failed. Use FORCE=1 to override.\n",
  runtime: { conclusion: 'incompatible', reason: 'kconfig-resolver-failure', attempts: [] }, env: { PROBE_ROOTS: 'alpha' },
});
assert.equal(hostPrerequisite.conclusion, 'inconclusive');
assert(hostPrerequisite.issues.some((issue) => issue.type === 'infrastructure-failure' && issue.reason === 'host-prerequisite'));

const sharedHostLog = "Checking 'python'... failed.\nBuild dependency: Please install Python 2.x\nPrerequisite check failed. Use FORCE=1 to override.\n";
const selectedCompatible = createEvidence({
  log: sharedHostLog,
  runtime: { mode: 'config-resolve', conclusion: 'inconclusive', roots: ['alpha'], attempts: [] },
  attempt: { source: 'ImmortalWrt', branch: 'openwrt-18.06', targetSystem: 'ar71xx', subtarget: 'nand', profile: 'DEVICE_test',
    result: 'compatible', reason: '', rootStates: { alpha: 'y' }, unavailableRoots: [], rejectedRoots: [] },
  env: { PROBE_ROOTS: 'alpha', PROBE_MODE: 'config-resolve' },
});
assert.equal(selectedCompatible.conclusion, 'compatible', 'a conclusive selected attempt must not inherit shared host-prerequisite noise');
assert(!selectedCompatible.issues.some((issue) => issue.type === 'infrastructure-failure'), 'shared branch log issues must not be attributed to a compatible attempt');
assert.equal(selectedCompatible.errors.length, 0, 'shared branch log errors must not contaminate a compatible attempt');

const selectedSkipped = createEvidence({
  log: sharedHostLog,
  runtime: { mode: 'config-resolve', conclusion: 'inconclusive', roots: ['alpha'], attempts: [] },
  attempt: { source: 'OpenWrt', branch: 'openwrt-18.06', targetSystem: 'ath25', subtarget: '', profile: 'DEVICE_test',
    result: 'skipped', reason: 'root-absent-source', rootStates: { alpha: 'missing' }, unavailableRoots: ['alpha'], rejectedRoots: [] },
  env: { PROBE_ROOTS: 'alpha', PROBE_MODE: 'config-resolve' },
});
assert.equal(selectedSkipped.conclusion, 'skipped', 'root absence must remain SKIP even when the shared branch log contains host-prerequisite noise');
assert(selectedSkipped.issues.some((issue) => issue.type === 'not-applicable' && issue.roots.includes('alpha')));
assert(!selectedSkipped.issues.some((issue) => issue.type === 'infrastructure-failure'), 'a skipped attempt must not inherit unrelated host-prerequisite issues');

const selectedInconclusive = createEvidence({
  log: sharedHostLog,
  runtime: { mode: 'config-resolve', conclusion: 'inconclusive', roots: ['alpha'], attempts: [] },
  attempt: { source: 'OpenWrt', branch: 'openwrt-18.06', targetSystem: 'lantiq', subtarget: 'xway', profile: 'DEVICE_test',
    result: 'inconclusive', reason: 'kconfig-resolver-failure', rootStates: {}, unavailableRoots: [], rejectedRoots: [] },
  env: { PROBE_ROOTS: 'alpha', PROBE_MODE: 'config-resolve' },
});
assert.equal(selectedInconclusive.conclusion, 'inconclusive', 'a truly inconclusive selected attempt must remain ERROR-class evidence');
assert(selectedInconclusive.issues.some((issue) => issue.type === 'infrastructure-failure' && issue.reason === 'host-prerequisite'));
const reasonOnly = createEvidence({ log: '', runtime: { conclusion: 'inconclusive', reason: 'metadata-unresolved', attempts: [] }, env: { PROBE_ROOTS: 'alpha' } });
assert(evidenceSummaryLines(reasonOnly).some((line) => line.includes('metadata-unresolved')), 'evidence summary must expose runtime reason when no normalized issue exists');

const runtimeSkipped = createEvidence({ log: '', runtime: { mode: 'runtime-health', selectedLevel: 6, conclusion: 'skipped',
  roots: ['alpha'], finalPackageCount: 1, durationMs: 1500, attempts: [{ result: 'skipped', reason: 'runtime-control-unavailable',
    selectedLevel: 6, deepestPassedLevel: 5, durationMs: 1400, stages: { boot: { status: 'success', durationMs: 900 },
      runtimeHealth: { status: 'skipped', durationMs: 500 } } }] }, env: { PROBE_ROOTS: 'alpha', PROBE_MODE: 'runtime-health', PROBE_EVIDENCE_LEVEL: '6' } });
assert.equal(runtimeSkipped.conclusion, 'skipped');
assert.equal(runtimeSkipped.selectedLevel, 6);
assert.equal(runtimeSkipped.deepestPassedLevel, 5);
assert.equal(runtimeSkipped.durationMs, 1400);
assert(runtimeSkipped.issues.some((row) => row.type === 'capability-unavailable' && row.reason === 'runtime-control-unavailable'));
assert(evidenceSummaryLines(runtimeSkipped).some((line) => line.includes('L6 / L5')));
assert(!evidenceSummaryLines(runtimeSkipped).some((line) => line.includes('Baseline / Final')),
  'Final-only Probe evidence must not present an A/B package comparison');

const resolvedDependencyEvidence = createEvidence({ log: '', runtime: { mode: 'package-compile', conclusion: 'compatible',
  roots: ['alpha'], requestedPackageCount: 1, attempts: [{ result: 'compatible', resolvedPackageCount: 3 }] }, env: {
  PROBE_ROOTS: 'alpha', PROBE_MODE: 'package-compile', PROBE_RUNTIME_KIND: 'python3',
  PROBE_RUNTIME_VERSION: 'Python 3.10.14', PROBE_COMPILER_KIND: 'gcc-10',
} });
assert.equal(resolvedDependencyEvidence.requestedPackageCount, 1);
assert.equal(resolvedDependencyEvidence.resolvedPackageCount, 3);
assert(evidenceSummaryLines(resolvedDependencyEvidence).some((line) => line.includes('直接探针配置: 1')));
assert(evidenceSummaryLines(resolvedDependencyEvidence).some((line) => line.includes('Defconfig 解析软件包: 3')));

const rebootFailure = createEvidence({ log: '', runtime: { mode: 'reboot-validation', selectedLevel: 7, conclusion: 'incompatible',
  roots: ['alpha'], attempts: [{ result: 'incompatible', reason: 'final-reboot-failed', selectedLevel: 7,
    deepestPassedLevel: 6, stages: {} }] }, env: { PROBE_ROOTS: 'alpha', PROBE_MODE: 'reboot-validation', PROBE_EVIDENCE_LEVEL: '7' } });
assert.equal(rebootFailure.conclusion, 'incompatible');
assert(rebootFailure.issues.some((row) => row.type === 'virtual-probe-failure' && row.reason === 'final-reboot-failed'));

const virtualInfrastructure = createEvidence({ log: '', runtime: { mode: 'boot-smoke', conclusion: 'inconclusive', roots: ['alpha'],
  attempts: [{ result: 'inconclusive', reason: 'runner-infrastructure', selectedLevel: 5, deepestPassedLevel: 4, stages: {} }] },
env: { PROBE_ROOTS: 'alpha', PROBE_MODE: 'boot-smoke', PROBE_EVIDENCE_LEVEL: '5' } });
assert.equal(virtualInfrastructure.conclusion, 'inconclusive');
assert(virtualInfrastructure.issues.some((row) => row.type === 'infrastructure-failure' && row.reason === 'runner-infrastructure'));

const timeoutPackageNames = parseProbeLog([
  'Package: python-async-timeout:',
  'Package: python3-async-timeout:',
  'Package: cttimeout:',
].join('\n'));
assert(!timeoutPackageNames.some((issue) => issue.type === 'timeout'), 'package names containing timeout must not be classified as runner timeout');
assert(parseProbeLog('ERROR: operation timed out after 300 seconds').some((issue) => issue.type === 'timeout'));
assert(!parseProbeLog('Probe bootstrap: apt-get update attempt 1/3 (timeout 240s).').some((issue) => issue.type === 'timeout'),
  'configured timeout limits must not be mistaken for actual timeout failures');
const configuredTimeoutEvidence = createEvidence({ log: 'Probe bootstrap: apt-get update attempt 1/3 (timeout 240s).', runtime: null, env: { PROBE_ROOTS: 'alpha' } });
assert.equal(configuredTimeoutEvidence.errors.length, 0, 'configured timeout limits must stay out of normalized errors');
assert(parseProbeLog('error: RPC failed; HTTP 504 curl 22 The requested URL returned error: 504').some((issue) => issue.type === 'package-download-failure'));
const packageNameEvidence = createEvidence({
  log: 'Package: python-async-timeout:\nPackage: cttimeout:\nERROR: package compile failed for Probe roots: alpha\n',
  runtime: { conclusion: 'incompatible', attempts: [] }, env: { PROBE_ROOTS: 'alpha' },
});
assert.equal(packageNameEvidence.conclusion, 'incompatible', 'timeout-like package names must not downgrade a conclusive package failure');

const dir = mkdtempSync(join(tmpdir(), 'probe-evidence-'));
try {
  for (const [i, evidence] of [{ ...row('A', 'main', 'incompatible'), reason: 'package-compile-failure' },
    { ...row('B', 'main', 'incompatible'), reason: 'package-unavailable' }].entries()) {
    const sub = join(dir, String(i)); mkdirSync(sub); writeFileSync(join(sub, 'evidence.json'), JSON.stringify(evidence));
  }
  const sampled = aggregateEvidence(dir, { PLAN_RESULT: 'success', PROBE_RESULT: 'failure', EXECUTE: 'true', AUTHORIZED: 'true',
    COVERAGE_TOTAL: '100', COVERAGE_PLANNED: '2', COVERAGE_SAMPLED: 'true', BATCH_COUNT: '1' });
  assert.equal(sampled.overallConclusion, 'sampled-incompatible');
  assert.equal(sampled.overallResult, 'FAIL (sampled)');
  assert.equal(sampled.summaryScopes.length, 2, 'Source summary must always retain one top-level row per source');
  assert(sampled.lines.includes('| Source<br>源码源 | Compatible<br>兼容 | Success rate<br>成功率 | Incompatible<br>不兼容 | Inconclusive<br>待定 | Package-caused rate<br>插件主因率 | Skipped<br>跳过 | Notes<br>备注 |'),
    'Source summary must expose two-line bilingual headers, success rate, and package-caused rate in the approved order');
  assert(sampled.lines.some((line) => line.includes('| A | 0 | **0%** | 1 | 0 | **1/1 · 100% · compile/link** | 0 | — |')),
    'sampled incompatible source must preserve counts, show 0% success, and expose the package primary cause without claiming exhaustive coverage');
  assert(sampled.lines.some((line) => line.includes('Probe roots / 测试入口: `luci-app-test`')), 'summary must expose the probed package/root');

  const full = aggregateEvidence(dir, { PLAN_RESULT: 'success', PROBE_RESULT: 'failure', EXECUTE: 'true', AUTHORIZED: 'true',
    COVERAGE_TOTAL: '2', COVERAGE_PLANNED: '2', COVERAGE_SAMPLED: 'false', BATCH_COUNT: '1' });
  assert.equal(full.overallConclusion, 'fully-incompatible');
  assert.equal(full.overallResult, 'FAIL');
  const batch = aggregateEvidence(dir, { PLAN_RESULT: 'success', PROBE_RESULT: 'failure', EXECUTE: 'true', AUTHORIZED: 'true',
    COVERAGE_TOTAL: '600', COVERAGE_PLANNED: '600', COVERAGE_SAMPLED: 'false', BATCH_COUNT: '3' });
  assert.equal(batch.overallConclusion, 'sampled-incompatible', 'one exhaustive batch must not claim whole-range completion');

  const successDir = join(dir, 'success-rate'); mkdirSync(successDir);
  for (let i = 0; i < 14; i += 1) {
    const sub = join(successDir, String(i)); mkdirSync(sub); writeFileSync(join(sub, 'evidence.json'), JSON.stringify(row('ImmortalWrt', 'master', 'compatible')));
  }
  const success = aggregateEvidence(successDir, { PLAN_RESULT: 'success', PROBE_RESULT: 'success', EXECUTE: 'true', AUTHORIZED: 'true',
    COVERAGE_TOTAL: '14', COVERAGE_PLANNED: '14', COVERAGE_SAMPLED: 'false', BATCH_COUNT: '1' });
  assert(success.lines.some((line) => line.includes('| ImmortalWrt | 14 | **100%** | 0 | 0 | **0/14 · 0% · —** | 0 | — |')),
    'fourteen compatible Probe samples must render 100% success without changing package-caused attribution');

  const mixedDir = join(dir, 'mixed'); mkdirSync(mixedDir);
  for (const [i, evidence] of [row('OpenWrt', 'main', 'compatible'),
    { ...row('OpenWrt', 'openwrt-23.05', 'incompatible'), reason: 'package-unavailable' },
    { ...row('ImmortalWrt', 'openwrt-23.05', 'incompatible'), reason: 'package-compile-failure' }].entries()) {
    const sub = join(mixedDir, String(i)); mkdirSync(sub); writeFileSync(join(sub, 'evidence.json'), JSON.stringify(evidence));
  }
  const mixed = aggregateEvidence(mixedDir, { PLAN_RESULT: 'success', PROBE_RESULT: 'success', EXECUTE: 'true', AUTHORIZED: 'true',
    COVERAGE_TOTAL: '3', COVERAGE_PLANNED: '3', COVERAGE_SAMPLED: 'false', BATCH_COUNT: '1' });
  assert(mixed.lines.some((line) => line.includes('| OpenWrt | 1 | **50%** | 1 | 0 | **1/2 · 50% · unavailable** | 0 | — |')),
    'mixed source must keep its top-level totals, success rate, and package-caused attribution');
  assert(mixed.lines.some((line) => line.includes('<summary>OpenWrt · Branch breakdown / 分支明细</summary>')), 'mixed source must expose branch breakdown');
  assert(!mixed.lines.some((line) => line.includes('<summary>ImmortalWrt · Branch breakdown / 分支明细</summary>')), 'uniform source must stay compact');

  const errorDir = join(dir, 'error'); mkdirSync(errorDir);
  for (const [i, evidence] of [row('OpenWrt', 'main', 'compatible'), { ...row('OpenWrt', 'openwrt-18.06', 'inconclusive'), issues: [{ type: 'timeout' }] }].entries()) {
    const sub = join(errorDir, String(i)); mkdirSync(sub); writeFileSync(join(sub, 'evidence.json'), JSON.stringify(evidence));
  }
  const error = aggregateEvidence(errorDir, { PLAN_RESULT: 'success', PROBE_RESULT: 'failure', EXECUTE: 'true', AUTHORIZED: 'true',
    COVERAGE_TOTAL: '2', COVERAGE_PLANNED: '2', COVERAGE_SAMPLED: 'false', BATCH_COUNT: '1' });
  assert.equal(error.overallResult, 'INCOMPLETE');
  assert.equal(error.overallConclusion, 'incomplete');
  assert(error.lines.some((line) => line.includes('| OpenWrt | 1 | **50%** | 0 | 1 | **0/2 · 0% · —** | 0 | Infrastructure incomplete / 基础设施未完成: 1 (timeout) |')),
    'one infrastructure failure must remain inconclusive without erasing the valid compatible result');
  assert(error.lines.some((line) => line.includes('Conclusive compatibility / 明确结果兼容率')), 'compatibility percentage must be labeled as conclusive-only');

  const infraOnlyDir = join(dir, 'infra-only'); mkdirSync(infraOnlyDir);
  { const sub = join(infraOnlyDir, '0'); mkdirSync(sub); writeFileSync(join(sub, 'evidence.json'), JSON.stringify({ ...row('OpenWrt', 'main', 'inconclusive'), issues: [{ type: 'timeout' }] })); }
  const infraOnly = aggregateEvidence(infraOnlyDir, { PLAN_RESULT: 'success', PROBE_RESULT: 'success', EXECUTE: 'true', AUTHORIZED: 'true',
    COVERAGE_TOTAL: '1', COVERAGE_PLANNED: '1', COVERAGE_SAMPLED: 'false', BATCH_COUNT: '1' });
  assert.equal(infraOnly.overallResult, 'INFRA ERROR');
  assert.equal(infraOnly.overallConclusion, 'inconclusive');

  const unknownOnlyDir = join(dir, 'unknown-only'); mkdirSync(unknownOnlyDir);
  { const sub = join(unknownOnlyDir, '0'); mkdirSync(sub); writeFileSync(join(sub, 'evidence.json'), JSON.stringify(row('OpenWrt', 'main', 'inconclusive'))); }
  const unknownOnly = aggregateEvidence(unknownOnlyDir, { PLAN_RESULT: 'success', PROBE_RESULT: 'success', EXECUTE: 'true', AUTHORIZED: 'true',
    COVERAGE_TOTAL: '1', COVERAGE_PLANNED: '1', COVERAGE_SAMPLED: 'false', BATCH_COUNT: '1' });
  assert.equal(unknownOnly.overallResult, 'ERROR', 'non-infrastructure inconclusive evidence must not be mislabeled as infrastructure');

  const skipInfraDir = join(dir, 'skip-infra'); mkdirSync(skipInfraDir);
  const skipInfraRows = [{ ...row('OpenWrt', 'openwrt-18.06', 'skipped'), reason: 'root-absent-source', unavailableRoots: ['luci-app-test'],
    issues: [{ type: 'not-applicable', roots: ['luci-app-test'] }] }, { ...row('OpenWrt', 'main', 'inconclusive'), issues: [{ type: 'timeout' }] }];
  for (const [i, evidence] of skipInfraRows.entries()) {
    const sub = join(skipInfraDir, String(i)); mkdirSync(sub); writeFileSync(join(sub, 'evidence.json'), JSON.stringify(evidence));
  }
  const skipInfra = aggregateEvidence(skipInfraDir, { PLAN_RESULT: 'success', PROBE_RESULT: 'success', EXECUTE: 'true', AUTHORIZED: 'true',
    COVERAGE_TOTAL: '2', COVERAGE_PLANNED: '2', COVERAGE_SAMPLED: 'false', BATCH_COUNT: '1' });
  assert.equal(skipInfra.overallResult, 'INCOMPLETE');
  assert(skipInfra.lines.some((line) => line.includes('| OpenWrt | 0 | **0%** | 0 | 1 | **0/2 · 0% · —** | 1 | Infrastructure incomplete / 基础设施未完成: 1 (timeout); Skipped: plugin unavailable in source/branch / 跳过：源码/分支不存在插件 (`luci-app-test`) |')),
    'skipped environments plus one infrastructure failure must be INCOMPLETE rather than ERROR');

  const skippedDir = join(dir, 'skipped-source'); mkdirSync(skippedDir);
  const absent = (branch) => ({ ...row('OpenWrt', branch, 'skipped'), reason: 'root-absent-source', unavailableRoots: ['luci-app-test'],
    issues: [{ type: 'not-applicable', roots: ['luci-app-test'] }] });
  for (const [i, evidence] of [absent('openwrt-18.06'), absent('openwrt-19.07')].entries()) {
    const sub = join(skippedDir, String(i)); mkdirSync(sub); writeFileSync(join(sub, 'evidence.json'), JSON.stringify(evidence));
  }
  const skippedSource = aggregateEvidence(skippedDir, { PLAN_RESULT: 'success', PROBE_RESULT: 'success', EXECUTE: 'true', AUTHORIZED: 'true',
    COVERAGE_TOTAL: '2', COVERAGE_PLANNED: '2', COVERAGE_SAMPLED: 'false', BATCH_COUNT: '1' });
  assert(skippedSource.lines.some((line) => line.includes('| OpenWrt | 0 | **—** | 0 | 0 | **—** | 2 | Skipped: plugin unavailable in source/branch / 跳过：源码/分支不存在插件 (`luci-app-test`) |')),
    'an all-skipped source must show no success/package-caused rate and explicitly explain plugin absence');
  assert(skippedSource.lines.some((line) => line.includes('<summary>OpenWrt · Branch breakdown / 分支明细</summary>')), 'skipped sources must expose branch details');
  assert(skippedSource.lines.some((line) => line.includes('| openwrt-18.06 | 0 | 0 | 0 | **—** | 1 | Skipped: plugin unavailable in source/branch / 跳过：源码/分支不存在插件 (`luci-app-test`) |')),
    'skipped branch rows must explicitly annotate plugin absence');

  const passSkipDir = join(dir, 'pass-skip'); mkdirSync(passSkipDir);
  for (const [i, evidence] of [row('ImmortalWrt', 'master', 'compatible'), { ...absent('openwrt-18.06'), source: 'ImmortalWrt' }].entries()) {
    const sub = join(passSkipDir, String(i)); mkdirSync(sub); writeFileSync(join(sub, 'evidence.json'), JSON.stringify(evidence));
  }
  const passSkip = aggregateEvidence(passSkipDir, { PLAN_RESULT: 'success', PROBE_RESULT: 'success', EXECUTE: 'true', AUTHORIZED: 'true',
    COVERAGE_TOTAL: '100', COVERAGE_PLANNED: '2', COVERAGE_SAMPLED: 'true', BATCH_COUNT: '1' });
  assert(passSkip.lines.some((line) => line.includes('| ImmortalWrt | 1 | **100%** | 0 | 0 | **0/2 · 0% · —** | 1 |')),
    'compatible plus skipped environments must exclude skipped rows from success-rate denominator while showing skipped count');
  assert(passSkip.lines.some((line) => line.includes('<summary>ImmortalWrt · Branch breakdown / 分支明细</summary>')), 'PASS plus SKIP must expose the skipped branch');
} finally { rmSync(dir, { recursive: true, force: true }); }

const missing = resolve(import.meta.dirname, '.package-probe-evidence-test-missing');
assert.equal(aggregateEvidence(missing, { PLAN_RESULT: 'failure', PROBE_RESULT: 'skipped' }).runStatus.state, 'plan-failure');
const skippedEvidence = createEvidence({ log: '', runtime: { mode: 'config-resolve', conclusion: 'skipped', roots: ['alpha'], attempts: [{
  source: 'OpenWrt', branch: 'main', targetSystem: 'x86', subtarget: '64', target: 'x86/64', profile: 'DEVICE_generic',
  result: 'skipped', reason: 'root-not-applicable', unavailableRoots: ['alpha'], rootStates: { alpha: 'n' },
}] }, env: { PROBE_ROOTS: 'alpha', PROBE_MODE: 'config-resolve' } });
assert.equal(skippedEvidence.conclusion, 'skipped');
assert(skippedEvidence.issues.some((row) => row.type === 'not-applicable'));

console.log('Package Probe V3 evidence checks passed.');

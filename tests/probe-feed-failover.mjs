#!/usr/bin/env node
import assert from 'node:assert/strict';
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const installer = resolve(import.meta.dirname, '../scripts/install-probe-feeds.sh');

function runScenario({ mode }) {
  const dir = mkdtempSync(join(tmpdir(), 'probe-feed-failover-'));
  try {
    mkdirSync(join(dir, 'scripts'), { recursive: true });
    mkdirSync(join(dir, 'bin'), { recursive: true });
    copyFileSync(installer, join(dir, 'install-probe-feeds.sh'));
    chmodSync(join(dir, 'install-probe-feeds.sh'), 0o755);
    writeFileSync(join(dir, 'feeds.conf'), 'src-git packages https://git.openwrt.org/feed/packages.git;openwrt-21.02\n');
    writeFileSync(join(dir, 'mode'), `${mode}\n`);
    writeFileSync(join(dir, 'bin', 'sleep'), '#!/usr/bin/env bash\nexit 0\n');
    chmodSync(join(dir, 'bin', 'sleep'), 0o755);
    writeFileSync(join(dir, 'scripts', 'feeds'), `#!/usr/bin/env bash
set -e
cmd="$1"; shift || true
case "$cmd" in
  list)
    if [[ "\${1:-}" == "-n" ]]; then
      echo packages
    elif [[ "\${1:-}" == "-sf" ]]; then
      awk '$1 ~ /^src-/ {print $1, $2, $3}' feeds.conf
    else
      exit 2
    fi
    ;;
  update)
    uri="$(awk '$2 == "packages" {print $3}' feeds.conf)"
    mode="$(cat mode)"
    echo "Updating feed 'packages' from '\${uri}' ..."
    if [[ "$mode" == "github-success" && "$uri" == https://github.com/openwrt/packages.git* ]]; then
      mkdir -p feeds/packages
      exit 0
    fi
    if [[ "$mode" == "network-fail" ]]; then
      echo "fatal: unable to access '\${uri%%;*}/': Failed to connect to host port 443: Couldn't connect to server" >&2
    elif [[ "$mode" == "gateway-fail" ]]; then
      echo "fatal: unable to access '\${uri%%;*}/': The requested URL returned error: 504" >&2
    elif [[ "$mode" == "auth-fail" ]]; then
      echo "fatal: could not read Username for '\${uri%%;*}': terminal prompts disabled" >&2
    else
      echo "fatal: unable to access '\${uri%%;*}/': The requested URL returned error: 504" >&2
    fi
    exit 1
    ;;
  install)
    exit 0
    ;;
  *) exit 2 ;;
esac
`);
    chmodSync(join(dir, 'scripts', 'feeds'), 0o755);

    const result = spawnSync('bash', ['./install-probe-feeds.sh'], {
      cwd: dir,
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${join(dir, 'bin')}:${process.env.PATH || ''}`,
        PROBE_LOG: join(dir, 'probe.log'),
        PROBE_FEEDS_RUNTIME: join(dir, 'runtime.json'),
        PROBE_FEED_BACKOFF_BASE_SECONDS: '0',
      },
    });
    return {
      status: result.status,
      output: `${result.stdout || ''}${result.stderr || ''}`,
      runtime: JSON.parse(readFileSync(join(dir, 'runtime.json'), 'utf8')),
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const gatewayFailure = runScenario({ mode: 'gateway-fail' });
assert.equal(gatewayFailure.status, 1);
assert.equal((gatewayFailure.output.match(/^Probe feeds: updating packages provider /gm) || []).length, 9,
  'HTTP 504 failures must receive three attempts on each of three providers');
assert.equal((gatewayFailure.output.match(/^Probe feeds: switching packages provider /gm) || []).length, 2,
  'HTTP 504 failures must switch source exactly twice before failing');
assert(gatewayFailure.output.includes('provider 1/3 git.openwrt.org attempt 3/3 failed'),
  'the upstream provider must be exhausted before the first source switch');
assert(gatewayFailure.output.includes('provider 2/3 github-openwrt attempt 3/3 failed'),
  'the GitHub provider must be exhausted before the second source switch');
assert(gatewayFailure.output.includes('provider 3/3 codeberg-openwrt attempt 3/3 failed'),
  'the final Codeberg provider must receive all three attempts');
assert(gatewayFailure.output.includes('exhausted 3 provider(s) after 9 total attempts'),
  'the feed stage must not fail before all nine attempts are exhausted');
assert.equal(gatewayFailure.runtime.failureReason, 'feed-network');
assert.equal(gatewayFailure.runtime.failureClass, 'feed-fetch-infrastructure');
assert(gatewayFailure.output.includes('class=feed-fetch-infrastructure'),
  'exhausted transient feed failures must expose the infrastructure classification in logs');
assert.equal(gatewayFailure.runtime.feeds[0]?.attempts, 9);
assert.equal(gatewayFailure.runtime.feeds[0]?.provider, 'codeberg-openwrt');

const networkFailure = runScenario({ mode: 'network-fail' });
assert.equal(networkFailure.status, 1);
assert.equal(networkFailure.runtime.failureReason, 'feed-network',
  'Failed to connect / Could not connect errors must be classified as feed-network');
assert.equal(networkFailure.runtime.feeds[0]?.attempts, 9);

const authFailure = runScenario({ mode: 'auth-fail' });
assert.equal(authFailure.status, 1);
assert.equal((authFailure.output.match(/^Probe feeds: updating packages provider /gm) || []).length, 1,
  'authentication failures must fail immediately without retrying or switching providers');
assert(!authFailure.output.includes('switching packages provider'),
  'authentication failures must not try an alternate provider');
assert.equal(authFailure.runtime.failureReason, 'feed-permanent');
assert.equal(authFailure.runtime.failureClass, 'feed-fetch-permanent');

const githubRecovery = runScenario({ mode: 'github-success' });
assert.equal(githubRecovery.status, 0);
assert.equal((githubRecovery.output.match(/^Probe feeds: updating packages provider /gm) || []).length, 4,
  'GitHub recovery must occur only after three upstream attempts, then succeed on its first attempt');
assert.equal((githubRecovery.output.match(/^Probe feeds: switching packages provider /gm) || []).length, 1);
assert(!githubRecovery.output.includes('codeberg-openwrt'), 'a successful first source switch must not continue to the second fallback');
assert.equal(githubRecovery.runtime.outcome, 'success');
assert.equal(githubRecovery.runtime.feeds[0]?.provider, 'github-openwrt');
assert.equal(githubRecovery.runtime.feeds[0]?.attempts, 4);
assert(githubRecovery.output.includes('exponential backoff'),
  'feed retries must identify exponential backoff in diagnostics');

console.log('Package Probe feed failover checks passed.');

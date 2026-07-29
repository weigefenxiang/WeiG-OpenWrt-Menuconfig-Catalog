#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const temp = mkdtempSync(join(tmpdir(), 'weig-catalog-index-'));
const dist = join(temp, 'dist');
const attempts = join(temp, 'attempts');
mkdirSync(dist);
mkdirSync(attempts);
try {
  writeFileSync(join(temp, 'previous.json'), JSON.stringify({
    schema: 1,
    sources: [{
      id: 'OpenWrt', label: 'OpenWrt', repo: 'openwrt/openwrt', branches: [
        { id: 'main', branch: 'main', asset: 'openwrt--main.json.gz', state: 'fresh', lastSuccessAt: '2026-01-01T00:00:00Z' },
        { id: '18.06', branch: 'openwrt-18.06', asset: 'openwrt--openwrt-18.06.json.gz', state: 'fresh', lastSuccessAt: '2026-01-01T00:00:00Z' },
      ],
    }],
  }));
  writeFileSync(join(dist, 'openwrt--main.meta.json'), JSON.stringify({
    source: { id: 'OpenWrt', label: 'OpenWrt', repo: 'openwrt/openwrt', branch: 'main', commit: 'abcdef' },
    counts: { targets: 1, profiles: 1, menuOptions: 10, packages: 20 },
    asset: 'openwrt--main.json.gz',
    generatedAt: '2026-07-29T00:00:00Z',
  }));
  const attempt = (branch, status, stage) => ({
    schema: 1,
    source: { id: 'OpenWrt', label: 'OpenWrt', repo: 'openwrt/openwrt', legacy: false },
    branch, status, stage, attemptedAt: '2026-07-29T00:10:00Z', runUrl: 'https://example.invalid/run/1',
  });
  writeFileSync(join(attempts, 'main.attempt.json'), JSON.stringify(attempt('main', 'success', 'complete')));
  writeFileSync(join(attempts, '18.attempt.json'), JSON.stringify(attempt('openwrt-18.06', 'failure', 'defconfig')));
  writeFileSync(join(attempts, '19.attempt.json'), JSON.stringify(attempt('openwrt-19.07', 'failure', 'feeds')));
  const out = join(temp, 'index.json');
  execFileSync(process.execPath, [
    join(ROOT, 'scripts', 'build-index.mjs'), dist, out, join(temp, 'previous.json'), attempts,
  ], { stdio: 'pipe' });
  const index = JSON.parse(readFileSync(out, 'utf8'));
  const branches = index.sources.find((source) => source.id === 'OpenWrt').branches;
  const main = branches.find((branch) => branch.branch === 'main');
  const old = branches.find((branch) => branch.branch === 'openwrt-18.06');
  const never = branches.find((branch) => branch.branch === 'openwrt-19.07');
  if (main.state !== 'fresh' || main.commit !== 'abcdef') throw new Error('fresh branch merge failed');
  if (old.state !== 'stale' || !old.asset || old.errorStage !== 'defconfig') throw new Error('stale branch merge failed');
  if (never.state !== 'unavailable' || never.asset || never.errorStage !== 'feeds') throw new Error('unavailable branch merge failed');
  if (index.health.fresh !== 1 || index.health.stale !== 1 || index.health.unavailable !== 1) {
    throw new Error('health counts failed');
  }
  console.log('catalog index checks passed: fresh=1 stale=1 unavailable=1');
} finally {
  rmSync(temp, { recursive: true, force: true });
}

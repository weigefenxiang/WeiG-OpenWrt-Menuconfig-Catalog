#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createProbePlan, normalizeProbeAuthorization, normalizeProbeRequest } from './package-probe-controller.mjs';

const ROOT = resolve(import.meta.dirname, '..');
const policy = JSON.parse(readFileSync(resolve(ROOT, '.github', 'automation-policy.json'), 'utf8'));
const packageConfig = 'CONFIG_PACKAGE_oscam=y\nCONFIG_PACKAGE_luci-app-oscam=y\n';
const baselinePackageConfig = 'CONFIG_PACKAGE_oscam=y\n';
const index = { schema: 2, sources: [{ id: 'Source', label: 'Source', repo: 'example/source',
  branches: Array.from({ length: 17 }, (_, i) => ({ branch: `branch-${i + 1}`, commit: String(i + 1).padStart(40, '0'), state: 'fresh' })) }] };
const requestRaw = {
  schema: 3, channel: 'dev', mode: 'package-compile', useDefconfig: true,
  baselinePackageConfig, packageConfig, packageIntent: [{ package: 'luci-app-oscam', before: 'n', after: 'y' }],
  environmentScope: { sources: ['*'], branches: ['*'], targetSystems: ['*'], subtargets: ['*'], profiles: ['*'] },
  coverage: { mode: 'auto', limit: 200 }, maxParallel: 0, execute: false,
};
const request = normalizeProbeRequest(requestRaw);

const ownerAuth = normalizeProbeAuthorization({ requester: 'Owner', repositoryOwner: 'owner', permission: 'admin' });
assert.deepEqual(ownerAuth, { actor: 'Owner', owner: true, authorization: 'admin', elevatedParallel: true });
assert.equal(normalizeProbeAuthorization({ requester: 'admin-helper', repositoryOwner: 'owner', permission: 'admin' }).elevatedParallel, true);
for (const permission of ['maintain', 'write']) assert.equal(normalizeProbeAuthorization({ requester: 'helper', repositoryOwner: 'owner', permission }).elevatedParallel, false);

function plan(env, requestOverride = request) { return createProbePlan({ index, policy, request: requestOverride, env }); }
const issueOwner = plan({ REPOSITORY_OWNER: 'owner', GITHUB_ACTOR: 'github-actions[bot]', PROBE_REQUESTER: 'owner', PROBE_AUTHORIZATION: 'admin', PROBE_AUTHORIZED: 'true' });
assert.equal(issueOwner.actor, 'owner');
assert.equal(issueOwner.owner, true);
assert.equal(issueOwner.matrix.include.length, 17);
assert.equal(issueOwner.maxParallel, 256, 'pre-target owner plan may use the Matrix boundary; target attachment narrows it to actual batch size');
const admin = plan({ REPOSITORY_OWNER: 'owner', GITHUB_ACTOR: 'github-actions[bot]', PROBE_REQUESTER: 'admin-helper', PROBE_AUTHORIZATION: 'admin', PROBE_AUTHORIZED: 'true' });
assert.equal(admin.maxParallel, 256);
for (const permission of ['maintain', 'write']) {
  const collaborator = plan({ REPOSITORY_OWNER: 'owner', GITHUB_ACTOR: 'github-actions[bot]', PROBE_REQUESTER: `${permission}-helper`, PROBE_AUTHORIZATION: permission, PROBE_AUTHORIZED: 'true' });
  assert.equal(collaborator.maxParallel, 3);
}
const limited = plan({ REPOSITORY_OWNER: 'owner', GITHUB_ACTOR: 'owner', PROBE_AUTHORIZATION: 'admin' }, normalizeProbeRequest({ ...requestRaw, maxParallel: 5 }));
assert.equal(limited.maxParallel, 5);
assert.throws(() => plan({ REPOSITORY_OWNER: 'owner', GITHUB_ACTOR: 'owner', PROBE_AUTHORIZATION: 'admin' },
  normalizeProbeRequest({ ...requestRaw, maxParallel: 257 })), /integer from 1 to 256/);
console.log('Probe V3 authorization checks passed.');

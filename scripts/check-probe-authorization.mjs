#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  createProbePlan,
  normalizeProbeAuthorization,
  normalizeProbeRequest,
} from './package-probe-controller.mjs';

const ROOT = resolve(import.meta.dirname, '..');
const policy = JSON.parse(readFileSync(resolve(ROOT, '.github', 'automation-policy.json'), 'utf8'));
const packageConfig = 'CONFIG_PACKAGE_oscam=y\nCONFIG_PACKAGE_luci-app-oscam=y\n';
const index = {
  schema: 2,
  sources: [{
    id: 'Source', label: 'Source', repo: 'example/source',
    branches: Array.from({ length: 17 }, (_, index) => ({
      branch: `branch-${index + 1}`, commit: String(index + 1).padStart(40, '0'), state: 'fresh',
    })),
  }],
};
const requestRaw = {
  schema: 2, channel: 'dev', mode: 'package-compile', packageConfig,
  scope: { mode: 'all' }, targetPolicy: { mode: 'auto' }, maxParallel: 0, execute: false,
};
const request = normalizeProbeRequest(requestRaw);

const ownerAuth = normalizeProbeAuthorization({ requester: 'Owner', repositoryOwner: 'owner', permission: 'admin' });
assert.deepEqual(ownerAuth, { actor: 'Owner', owner: true, authorization: 'admin', elevatedParallel: true });
const adminAuth = normalizeProbeAuthorization({ requester: 'admin-helper', repositoryOwner: 'owner', permission: 'admin' });
assert.equal(adminAuth.owner, false);
assert.equal(adminAuth.elevatedParallel, true);
for (const permission of ['maintain', 'write']) {
  assert.equal(normalizeProbeAuthorization({ requester: 'helper', repositoryOwner: 'owner', permission }).elevatedParallel, false);
}

function plan(env, requestOverride = request) {
  return createProbePlan({ index, policy, request: requestOverride, env });
}

const issueOwner = plan({
  REPOSITORY_OWNER: 'owner', GITHUB_ACTOR: 'github-actions[bot]',
  PROBE_REQUESTER: 'owner', PROBE_AUTHORIZATION: 'admin', PROBE_AUTHORIZED: 'true',
});
assert.equal(issueOwner.actor, 'owner');
assert.equal(issueOwner.owner, true);
assert.equal(issueOwner.authorization, 'admin');
assert.equal(issueOwner.matrix.include.length, 17);
assert.equal(issueOwner.maxParallel, 17, 'bot-dispatched owner Issue must retain owner/admin parallelism');

const adminCollaborator = plan({
  REPOSITORY_OWNER: 'owner', GITHUB_ACTOR: 'github-actions[bot]',
  PROBE_REQUESTER: 'admin-helper', PROBE_AUTHORIZATION: 'admin', PROBE_AUTHORIZED: 'true',
});
assert.equal(adminCollaborator.owner, false);
assert.equal(adminCollaborator.maxParallel, 17, 'admin collaborators must receive elevated parallelism');

for (const permission of ['maintain', 'write']) {
  const collaborator = plan({
    REPOSITORY_OWNER: 'owner', GITHUB_ACTOR: 'github-actions[bot]',
    PROBE_REQUESTER: `${permission}-helper`, PROBE_AUTHORIZATION: permission, PROBE_AUTHORIZED: 'true',
  });
  assert.equal(collaborator.maxParallel, 3, `${permission} collaborators must remain capped`);
}

const manualOwner = plan({ REPOSITORY_OWNER: 'owner', GITHUB_ACTOR: 'owner', PROBE_AUTHORIZATION: 'admin' });
assert.equal(manualOwner.maxParallel, 17, 'manual owner dispatch must retain elevated parallelism');

const limitedAdmin = plan({
  REPOSITORY_OWNER: 'owner', GITHUB_ACTOR: 'github-actions[bot]', PROBE_REQUESTER: 'owner',
  PROBE_AUTHORIZATION: 'admin',
}, normalizeProbeRequest({ ...requestRaw, maxParallel: 5 }));
assert.equal(limitedAdmin.maxParallel, 5);

assert.throws(() => plan({
  REPOSITORY_OWNER: 'owner', GITHUB_ACTOR: 'owner', PROBE_AUTHORIZATION: 'admin',
}, normalizeProbeRequest({ ...requestRaw, maxParallel: 257 })), /integer from 1 to 256/);

console.log('probe authorization checks passed: owner/admin elevated, bot identity preserved, collaborators capped, 256 boundary enforced');

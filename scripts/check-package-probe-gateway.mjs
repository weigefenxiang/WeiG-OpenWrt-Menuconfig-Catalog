#!/usr/bin/env node
import assert from 'node:assert/strict';
import { gzipSync } from 'node:zlib';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  normalizeProbeEnvelope,
  parseProbeEnvelopeToken,
  probeGatewayDispatchInputs,
  probeGatewayWorkerCompatible,
  probeGatewayWorkerInputs,
} from './package-probe-envelope.mjs';
import {
  isProbeIssue, normalizeGatewayRequest, probeCancellationAuthorized, probeCancellationRequested,
  probeIssueCommand, probeRunMarkers,
} from './package-probe-gateway.mjs';


const ROOT = resolve(import.meta.dirname, '..');
const gatewayWorkflow = readFileSync(resolve(ROOT, '.github', 'workflows', 'package-probe-request.yml'), 'utf8');
const issueForm = readFileSync(resolve(ROOT, '.github', 'ISSUE_TEMPLATE', 'package-probe.yml'), 'utf8');
const issueGateway = readFileSync(resolve(ROOT, 'scripts', 'package-probe-gateway.mjs'), 'utf8');

const token = (version, raw) => `WEIG_PACKAGE_PROBE_STATE_V${version}:${gzipSync(Buffer.from(JSON.stringify(raw))).toString('base64url')}`;
const v2 = { schema: 2, channel: 'main', mode: 'package-compile', packageConfig: 'CONFIG_PACKAGE_alpha=y\n' };
const v3 = { schema: 3, channel: 'dev', mode: 'package-compile', packageConfig: 'CONFIG_PACKAGE_alpha=y\n',
  packageIntent: [{ package: 'alpha', before: 'n', after: 'y' }],
  environmentScope: { sources: ['*'], branches: ['*'], targetSystems: ['*'], subtargets: ['*'], profiles: ['*'] },
  coverage: { mode: 'auto', limit: 8 } };

const p2 = parseProbeEnvelopeToken(token(2, v2));
assert.equal(p2.protocolVersion, 2);
assert.equal(p2.channel, 'main');
assert.equal(p2.raw.schema, 2);
const p3 = parseProbeEnvelopeToken(token(3, v3));
assert.equal(p3.protocolVersion, 3);
assert.equal(p3.channel, 'dev');
assert.equal(p3.raw.schema, 3);
assert.match(p3.sha256, /^[a-f0-9]{64}$/);

assert.throws(() => parseProbeEnvelopeToken(`${token(2, v2)}\n${token(3, v3)}`), /exactly one/);
assert.throws(() => parseProbeEnvelopeToken(`${token(3, v3)}\n${token(3, v3)}`), /exactly one/);
assert.throws(() => parseProbeEnvelopeToken(`${token(3, v3)}\nWEIG_PACKAGE_PROBE_STATE_V2:`), /exactly one/);
assert.throws(() => parseProbeEnvelopeToken(token(4, { ...v3, schema: 4 })), /unsupported Probe state protocol V4/);
assert.throws(() => parseProbeEnvelopeToken(token(3, { ...v3, schema: 2 })), /does not match schema/);
assert.throws(() => normalizeProbeEnvelope({ ...v3, channel: 'fix/../main' }, 3), /unsupported probe channel/);
assert.throws(() => normalizeProbeEnvelope({ ...v3, channel: 'feature/test' }, 3), /unsupported probe channel/);
assert.throws(() => normalizeProbeEnvelope({ ...v3, mode: 'plugin-special-case' }, 3), /unsupported probe mode/);

assert.deepEqual(normalizeGatewayRequest(v2), { protocolVersion: 2, schema: 2, channel: 'main', mode: 'package-compile' });
assert.deepEqual(normalizeGatewayRequest(v3), { protocolVersion: 3, schema: 3, channel: 'dev', mode: 'package-compile' });


assert(isProbeIssue({ title: '[probe] package', user: { login: 'author' } }));
assert(!isProbeIssue({ title: '[build] package' }));
assert(!isProbeIssue({ title: '[probe] pull', pull_request: {} }));
assert.equal(probeIssueCommand(' /CANCEL\n'), 'cancel');
assert.equal(probeIssueCommand('/cancel now'), '');
assert(probeCancellationAuthorized({ requester: 'Author', commenter: 'author', permission: 'read' }));
for (const permission of ['write', 'maintain', 'admin']) {
  assert(probeCancellationAuthorized({ requester: 'author', commenter: 'helper', permission }));
}
assert(!probeCancellationAuthorized({ requester: 'author', commenter: 'reader', permission: 'read' }));
assert(probeCancellationRequested([{ body: '<!-- WEIG_PACKAGE_PROBE_CANCEL_V1 -->' }]));

assert.deepEqual(probeGatewayWorkerInputs(2), ['issue_number', 'state_sha256', 'issue_created_at']);
assert.deepEqual(probeGatewayWorkerInputs(3), ['issue_number', 'state_sha256', 'issue_created_at', 'batch_index', 'sampling_seed', 'data_commit']);
assert.deepEqual(Object.keys(probeGatewayDispatchInputs(2, { issueNumber: 1, stateSha256: 'a', issueCreatedAt: 'time' })),
  ['issue_number', 'state_sha256', 'issue_created_at']);
assert.deepEqual(Object.keys(probeGatewayDispatchInputs(3, { issueNumber: 1, stateSha256: 'a', issueCreatedAt: 'time' })),
  ['issue_number', 'state_sha256', 'issue_created_at', 'batch_index', 'sampling_seed', 'data_commit']);

const v2Workflow = 'issue_number:\nstate_sha256:\nissue_created_at:\n';
const v3Workflow = `${v2Workflow}batch_index:\nsampling_seed:\ndata_commit:\n`;
assert(probeGatewayWorkerCompatible(2, v2Workflow, "PROBE_STATE_PREFIX = 'WEIG_PACKAGE_PROBE_STATE_V2:'"));
assert(!probeGatewayWorkerCompatible(3, v2Workflow, "PROBE_STATE_PREFIX = 'WEIG_PACKAGE_PROBE_STATE_V2:'"));
assert(probeGatewayWorkerCompatible(3, v3Workflow, "PROBE_STATE_PREFIX = 'WEIG_PACKAGE_PROBE_STATE_V3:'"));
assert(!probeGatewayWorkerCompatible(2, v3Workflow, "PROBE_STATE_PREFIX = 'WEIG_PACKAGE_PROBE_STATE_V3:'"));

const sha = 'a'.repeat(64);
const markers = probeRunMarkers([
  { body: `<!-- WEIG_PACKAGE_PROBE_RUN_V2 run=11 sha=${sha} -->` },
  { body: `<!-- WEIG_PACKAGE_PROBE_RUN_V3 run=12 sha=${sha} batch=3 -->` },
]);
assert.deepEqual(markers, [{ runId: 11, sha256: sha }, { runId: 12, sha256: sha, batchIndex: 3 }]);


assert(gatewayWorkflow.includes('\n  issues:\n') && gatewayWorkflow.includes('\n  issue_comment:\n'));
assert(gatewayWorkflow.includes('node scripts/package-probe-gateway.mjs'));
assert(gatewayWorkflow.includes('actions: write') && gatewayWorkflow.includes('issues: write'));
assert(issueForm.includes('id: state') && !issueForm.includes('type: upload') &&
  !issueForm.includes('probe-request.json') && issueForm.includes('`/cancel`'));
assert(!issueGateway.includes('downloadProbeRequest') && !issueGateway.includes('probe-request.json'));
assert(!existsSync(resolve(ROOT, 'scripts', 'package-probe-issue.mjs')),
  'obsolete duplicate Probe Issue gateway must remain removed');

console.log('Package Probe gateway protocol router contracts passed.');

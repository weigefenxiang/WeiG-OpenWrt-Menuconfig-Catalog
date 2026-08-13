#!/usr/bin/env node
// SPDX-FileCopyrightText: 2026 weigefenxiang and contributors
// SPDX-License-Identifier: GPL-3.0-or-later
import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { runtimeDataBranchForChannel } from './catalog-channels.mjs';

export const PROBE_GATEWAY_PROTOCOLS = Object.freeze([2, 3]);
export const PROBE_GATEWAY_MAX_COMPRESSED_BYTES = 64 * 1024;
export const PROBE_GATEWAY_MAX_JSON_BYTES = 256 * 1024;

const TOKEN_PREFIX_RE = /WEIG_PACKAGE_PROBE_STATE_V(\d+):/g;
const TOKEN_RE = /^WEIG_PACKAGE_PROBE_STATE_V(\d+):([A-Za-z0-9_-]+)/;
const MODE_RE = /^(?:package-compile|rootfs-integration|firmware-integration|boot-smoke)$/;
const FIX_CHANNEL_RE = /^fix\/[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/;
const BASE_WORKER_INPUTS = Object.freeze(['issue_number', 'state_sha256', 'issue_created_at']);
const V3_WORKER_INPUTS = Object.freeze([...BASE_WORKER_INPUTS, 'batch_index', 'sampling_seed', 'data_commit']);

const plainObject = (value) => Boolean(value && typeof value === 'object' && !Array.isArray(value));

function normalizeChannel(value) {
  const channel = String(value || 'main').trim();
  const stable = channel === 'main' || channel === 'dev' || channel === 'staging';
  const segments = channel.split('/');
  const fix = channel.length <= 154 && FIX_CHANNEL_RE.test(channel) &&
    !segments.some((part) => part === '.' || part === '..');
  if ((!stable && !fix) || !runtimeDataBranchForChannel(channel)) {
    throw new Error(`unsupported probe channel: ${channel}`);
  }
  return channel;
}

export function normalizeProbeEnvelope(raw, protocolVersion = Number(raw?.schema)) {
  if (!plainObject(raw)) throw new Error('Probe state payload must be an object');
  const version = Number(protocolVersion);
  if (!PROBE_GATEWAY_PROTOCOLS.includes(version)) throw new Error(`unsupported Probe state protocol V${protocolVersion}`);
  const schema = Number(raw.schema);
  if (schema !== version) throw new Error(`Probe state token V${version} does not match schema ${raw.schema}`);
  const mode = String(raw.mode || 'package-compile');
  if (!MODE_RE.test(mode)) throw new Error(`unsupported probe mode: ${mode}`);
  return { protocolVersion: version, schema, channel: normalizeChannel(raw.channel), mode };
}

export function parseProbeEnvelopeToken(body) {
  const text = String(body || '');
  const prefixes = [...text.matchAll(new RegExp(TOKEN_PREFIX_RE.source, TOKEN_PREFIX_RE.flags))];
  if (prefixes.length !== 1) throw new Error('Issue must contain exactly one generated Probe state token');
  const tail = text.slice(prefixes[0].index);
  const match = tail.match(TOKEN_RE);
  if (!match) throw new Error('Generated Probe state token is malformed');
  const protocolVersion = Number(match[1]);
  if (!PROBE_GATEWAY_PROTOCOLS.includes(protocolVersion)) {
    throw new Error(`unsupported Probe state protocol V${match[1]}`);
  }
  const token = match[0];
  const encoded = match[2];
  const compressed = Buffer.from(encoded, 'base64url');
  if (!compressed.length || compressed.length > PROBE_GATEWAY_MAX_COMPRESSED_BYTES ||
      compressed.toString('base64url') !== encoded) {
    throw new Error('Probe state compressed size or encoding is invalid');
  }
  let jsonBytes;
  try { jsonBytes = gunzipSync(compressed); }
  catch { throw new Error('Probe state is not valid gzip data'); }
  if (!jsonBytes.length || jsonBytes.length > PROBE_GATEWAY_MAX_JSON_BYTES) {
    throw new Error('Probe state JSON size is invalid');
  }
  let raw;
  try { raw = JSON.parse(jsonBytes.toString('utf8')); }
  catch { throw new Error('Probe state is not valid JSON'); }
  const envelope = normalizeProbeEnvelope(raw, protocolVersion);
  return { token, raw, sha256: createHash('sha256').update(token).digest('hex'), ...envelope };
}

export function probeGatewayWorkerInputs(protocolVersion) {
  const version = Number(protocolVersion);
  if (version === 2) return [...BASE_WORKER_INPUTS];
  if (version === 3) return [...V3_WORKER_INPUTS];
  throw new Error(`unsupported Probe state protocol V${protocolVersion}`);
}

export function probeGatewayWorkerCompatible(protocolVersion, workflowText, stateParserText) {
  const version = Number(protocolVersion);
  const inputs = probeGatewayWorkerInputs(version);
  return inputs.every((needle) => String(workflowText || '').includes(`${needle}:`)) &&
    String(stateParserText || '').includes(`WEIG_PACKAGE_PROBE_STATE_V${version}:`);
}

export function probeGatewayDispatchInputs(protocolVersion, { issueNumber, stateSha256, issueCreatedAt }) {
  const inputs = {
    issue_number: String(issueNumber || ''),
    state_sha256: String(stateSha256 || ''),
    issue_created_at: String(issueCreatedAt || ''),
  };
  if (Number(protocolVersion) === 3) Object.assign(inputs, { batch_index: '0', sampling_seed: '', data_commit: '' });
  else if (Number(protocolVersion) !== 2) throw new Error(`unsupported Probe state protocol V${protocolVersion}`);
  return inputs;
}

#!/usr/bin/env node
// SPDX-FileCopyrightText: 2026 weigefenxiang and contributors
// SPDX-License-Identifier: GPL-3.0-or-later
import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';

export const PROBE_STATE_PREFIX = 'WEIG_PACKAGE_PROBE_STATE_V2:';
export const PROBE_STATE_MAX_COMPRESSED_BYTES = 64 * 1024;
export const PROBE_STATE_MAX_JSON_BYTES = 256 * 1024;

export function probeStateToken(body) {
  const matches = [...String(body || '').matchAll(/WEIG_PACKAGE_PROBE_STATE_V2:([A-Za-z0-9_-]+)/g)];
  if (matches.length !== 1) throw new Error('Issue must contain exactly one generated Probe state token');
  return `${PROBE_STATE_PREFIX}${matches[0][1]}`;
}

export function parseProbeStateToken(body) {
  const token = probeStateToken(body);
  const encoded = token.slice(PROBE_STATE_PREFIX.length);
  const compressed = Buffer.from(encoded, 'base64url');
  if (!compressed.length || compressed.length > PROBE_STATE_MAX_COMPRESSED_BYTES) {
    throw new Error('Probe state compressed size is invalid');
  }
  let jsonBytes;
  try { jsonBytes = gunzipSync(compressed); }
  catch { throw new Error('Probe state is not valid gzip data'); }
  if (!jsonBytes.length || jsonBytes.length > PROBE_STATE_MAX_JSON_BYTES) throw new Error('Probe state JSON size is invalid');
  let raw;
  try { raw = JSON.parse(jsonBytes.toString('utf8')); }
  catch { throw new Error('Probe state is not valid JSON'); }
  return { token, raw, sha256: createHash('sha256').update(token).digest('hex') };
}

#!/usr/bin/env node
// SPDX-FileCopyrightText: 2026 weigefenxiang and contributors
// SPDX-License-Identifier: GPL-3.0-or-later
import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';

export const PROBE_STATE_PREFIX = 'WEIG_PACKAGE_PROBE_STATE_V3:';
export const PROBE_STATE_MAX_COMPRESSED_BYTES = 64 * 1024;
export const PROBE_STATE_MAX_JSON_BYTES = 256 * 1024;

const TOKEN_RE = /WEIG_PACKAGE_PROBE_STATE_V3:([A-Za-z0-9_-]+)/g;
const LEGACY_TOKEN_RE = /WEIG_PACKAGE_PROBE_STATE_V2:[A-Za-z0-9_-]+/g;

export function probeStateToken(body) {
  const text = String(body || '');
  const matches = [...text.matchAll(TOKEN_RE)];
  if (matches.length !== 1) {
    if (!matches.length && LEGACY_TOKEN_RE.test(text)) {
      throw new Error('Probe request schema has changed; return to the current AutoBuild page and submit again');
    }
    throw new Error('Issue must contain exactly one generated Probe V3 state token');
  }
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
  if (!jsonBytes.length || jsonBytes.length > PROBE_STATE_MAX_JSON_BYTES) {
    throw new Error('Probe state JSON size is invalid');
  }
  let raw;
  try { raw = JSON.parse(jsonBytes.toString('utf8')); }
  catch { throw new Error('Probe state is not valid JSON'); }
  return { token, raw, sha256: createHash('sha256').update(token).digest('hex') };
}

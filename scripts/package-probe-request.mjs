#!/usr/bin/env node
// SPDX-FileCopyrightText: 2026 weigefenxiang and contributors
// SPDX-License-Identifier: GPL-3.0-or-later
import { createHash } from 'node:crypto';

const DEFAULT_MAX_BYTES = 32 * 1024;
const ATTACHMENT_LINK_RE = /\[([^\]\r\n]{1,160})\]\((https:\/\/github\.com\/user-attachments\/(?:files|assets)\/[A-Za-z0-9._~!$&'()*+,;=:@%/-]+)\)/g;
const BARE_ATTACHMENT_RE = /https:\/\/github\.com\/user-attachments\/(?:files|assets)\/[A-Za-z0-9._~!$&'()*+,;=:@%/-]+/g;

function fail(message) {
  throw new Error(`probe request attachment: ${message}`);
}

export function probeRequestAttachment(body) {
  const text = String(body || '');
  const rows = [...text.matchAll(ATTACHMENT_LINK_RE)].map((match) => ({
    name: String(match[1] || '').trim(),
    url: String(match[2] || '').replace(/[)>.,]+$/, ''),
  }));
  const seen = new Set(rows.map((row) => row.url));
  for (const match of text.matchAll(BARE_ATTACHMENT_RE)) {
    const url = String(match[0] || '').replace(/[)>.,]+$/, '');
    if (!seen.has(url)) rows.push({ name: decodeURIComponent(new URL(url).pathname.split('/').pop() || ''), url });
    seen.add(url);
  }
  if (rows.length !== 1) fail(`expected exactly one GitHub attachment, found ${rows.length}`);
  if (!/\.json$/i.test(rows[0].name) && !/\.json(?:$|[?#])/i.test(rows[0].url)) {
    fail('the only attachment must be a JSON file');
  }
  return rows[0];
}

export function parseProbeRequestBytes(bytes, options = {}) {
  const maximum = Number(options.maximumBytes || DEFAULT_MAX_BYTES);
  const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes || []);
  if (buffer.length < 2 || buffer.length > maximum) fail(`size must be 2-${maximum} bytes, got ${buffer.length}`);
  if (buffer.length >= 3 && buffer[0] === 0xEF && buffer[1] === 0xBB && buffer[2] === 0xBF) fail('BOM is not allowed');
  let text;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(buffer); }
  catch { fail('file is not valid UTF-8'); }
  if (text.charCodeAt(0) === 0xFEFF || text.includes('\0')) fail('BOM/NUL is not allowed');
  let raw;
  try { raw = JSON.parse(text); }
  catch (error) { fail(`invalid JSON: ${error.message}`); }
  return {
    raw,
    bytes: buffer.length,
    sha256: createHash('sha256').update(buffer).digest('hex'),
  };
}

export async function downloadProbeRequest(body, options = {}) {
  const attachment = probeRequestAttachment(body);
  const fetcher = options.fetcher || fetch;
  const response = await fetcher(attachment.url, { redirect: 'follow' });
  if (!response?.ok) fail(`${attachment.name || attachment.url}: download returned HTTP ${response?.status || 'unknown'}`);
  const maximum = Number(options.maximumBytes || DEFAULT_MAX_BYTES);
  const declared = Number(response.headers?.get?.('content-length') || 0);
  if (declared > maximum) fail(`${attachment.name}: declared size exceeds ${maximum} bytes`);
  const parsed = parseProbeRequestBytes(Buffer.from(await response.arrayBuffer()), { maximumBytes: maximum });
  return { ...attachment, ...parsed };
}

export const PROBE_REQUEST_MAX_BYTES = DEFAULT_MAX_BYTES;

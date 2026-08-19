#!/usr/bin/env node
// SPDX-FileCopyrightText: 2026 weigefenxiang and contributors
// SPDX-License-Identifier: GPL-3.0-or-later
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { parseProbeStateToken } from './package-probe-state.mjs';
import { normalizeProbeRequest } from './package-probe-controller.mjs';

const WRITE_PERMISSIONS = new Set(['admin', 'maintain', 'write']);
const PROBE_TITLE_RE = /^\[probe\](?:\s|$)/i;
const RUN_MARKER_RE = /<!--\s*WEIG_PACKAGE_PROBE_RUN_V3\s+run=(\d+)\s+sha=([a-f0-9]{64})(?:\s+batch=(\d+))?\s*-->/gi;
const INTAKE_MARKER_RE = /<!--\s*WEIG_PACKAGE_PROBE_INTAKE_V3\s+sha=([a-f0-9]{64})\s*-->/i;
const CANCEL_MARKER = '<!-- WEIG_PACKAGE_PROBE_CANCEL_V1 -->';

const plainObject = (value) => Boolean(value && typeof value === 'object' && !Array.isArray(value));

export function normalizeGatewayRequest(raw) {
  const request = normalizeProbeRequest(raw);
  return {
    channel: request.channel,
    mode: request.mode,
    useDefconfig: request.useDefconfig,
    roots: request.roots,
    finalPackageCount: request.packages.length,
    environmentScope: request.environmentScope,
    coverage: request.coverage,
  };
}

export function probeDisplayContext(request, issueNumber) {
  const roots = Array.isArray(request?.roots) ? request.roots : [];
  const rootLabel = roots.length > 1 ? `${roots[0]} +${roots.length - 1}` : (roots[0] || 'package');
  return `${rootLabel} · #${Number(issueNumber)} · ${request.channel}`;
}


export function probeIssueCommand(body) {
  return String(body || '').trim().toLowerCase() === '/cancel' ? 'cancel' : '';
}

export function isProbeIssue(issue) {
  return Boolean(issue && !issue.pull_request && PROBE_TITLE_RE.test(String(issue.title || '')));
}

export function probeRunMarkers(comments) {
  const rows = [];
  for (const comment of comments || []) {
    for (const match of String(comment?.body || '').matchAll(RUN_MARKER_RE)) {
      rows.push({ runId: Number(match[1]), sha256: match[2], batchIndex: Number(match[3] || 0) });
    }
  }
  return [...new Map(rows.map((row) => [row.runId, row])).values()];
}

export function probeCancellationAuthorized({ requester, commenter, permission }) {
  return String(requester || '').toLowerCase() === String(commenter || '').toLowerCase() ||
    WRITE_PERMISSIONS.has(String(permission || '').toLowerCase());
}

export function probeCancellationRequested(comments) {
  return (comments || []).some((comment) => String(comment?.body || '').includes(CANCEL_MARKER));
}

function eventPayload(env) {
  return JSON.parse(readFileSync(env.GITHUB_EVENT_PATH, 'utf8'));
}

function repositoryParts(env) {
  const [owner, repo] = String(env.GITHUB_REPOSITORY || '').split('/');
  if (!owner || !repo) throw new Error('GITHUB_REPOSITORY is invalid');
  return { owner, repo };
}

function apiClient(env) {
  const token = String(env.GITHUB_TOKEN || '');
  if (!token) throw new Error('GITHUB_TOKEN is required');
  return async (path, options = {}) => {
    const response = await fetch(`https://api.github.com${path}`, {
      method: options.method || 'GET',
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${token}`,
        'User-Agent': 'WeiG-OpenWrt-Menuconfig-Catalog',
        'X-GitHub-Api-Version': '2026-03-10',
        ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: options.body ? JSON.stringify(options.body) : undefined,
    });
    const text = await response.text();
    let data = null;
    if (text) {
      try { data = JSON.parse(text); }
      catch { data = text; }
    }
    if (!response.ok) {
      const message = plainObject(data) && data.message ? ` ${data.message}` : '';
      const error = new Error(`${options.method || 'GET'} ${path}: HTTP ${response.status}${message}`);
      error.status = response.status;
      throw error;
    }
    return data;
  };
}

async function permissionFor(api, owner, repo, actor) {
  if (String(actor).toLowerCase() === String(owner).toLowerCase()) return 'admin';
  try {
    const data = await api(`/repos/${owner}/${repo}/collaborators/${encodeURIComponent(actor)}/permission`);
    return String(data?.permission || 'read');
  } catch (error) {
    if (Number(error.status) === 404) return 'read';
    throw error;
  }
}

async function issueComments(api, owner, repo, number) {
  return await api(`/repos/${owner}/${repo}/issues/${number}/comments?per_page=100`);
}

async function comment(api, owner, repo, number, body) {
  return await api(`/repos/${owner}/${repo}/issues/${number}/comments`, {
    method: 'POST', body: { body },
  });
}

async function closeIssue(api, owner, repo, number) {
  await api(`/repos/${owner}/${repo}/issues/${number}`, {
    method: 'PATCH', body: { state: 'closed', state_reason: 'not_planned' },
  });
}

async function workerSupportsGateway(api, owner, repo, channel) {
  const data = await api(`/repos/${owner}/${repo}/contents/.github/workflows/package-probe.yml?ref=${encodeURIComponent(channel)}`);
  const text = Buffer.from(String(data?.content || '').replace(/\s+/g, ''), 'base64').toString('utf8');
  return ['issue_number:', 'display_context:', 'state_sha256:', 'issue_created_at:', 'batch_index:', 'sampling_seed:', 'data_commit:']
    .every((needle) => text.includes(needle));
}

async function cancelRun(api, owner, repo, runId) {
  const run = await api(`/repos/${owner}/${repo}/actions/runs/${runId}`);
  if (run.event !== 'workflow_dispatch' || !String(run.path || '').startsWith('.github/workflows/package-probe.yml')) {
    throw new Error(`run ${runId} is not a package probe workflow`);
  }
  if (run.status === 'completed') return { url: run.html_url, state: run.conclusion || 'completed', active: false };
  try { await api(`/repos/${owner}/${repo}/actions/runs/${runId}/cancel`, { method: 'POST' }); }
  catch (error) { if (![409, 422].includes(Number(error.status))) throw error; }
  await new Promise((resolveDelay) => setTimeout(resolveDelay, 15000));
  const latest = await api(`/repos/${owner}/${repo}/actions/runs/${runId}`);
  if (latest.status !== 'completed') {
    try { await api(`/repos/${owner}/${repo}/actions/runs/${runId}/force-cancel`, { method: 'POST' }); }
    catch (error) { if (![409, 422].includes(Number(error.status))) throw error; }
  }
  return { url: run.html_url, state: 'cancel-requested', active: true };
}

async function intake(env, event) {
  const issue = event.issue;
  if (!isProbeIssue(issue)) return { relevant: false };
  const { owner, repo } = repositoryParts(env);
  const api = apiClient(env);
  const requester = String(issue.user?.login || '');
  const parsedState = parseProbeStateToken(issue.body || '');
  const request = normalizeGatewayRequest(parsedState.raw);
  const permission = await permissionFor(api, owner, repo, requester);
  const comments = await issueComments(api, owner, repo, issue.number);
  if (comments.some((row) => INTAKE_MARKER_RE.test(String(row.body || ''))) || probeRunMarkers(comments).length) {
    console.log(`Probe Issue #${issue.number} was already accepted / 探针 Issue 已受理`);
    return { relevant: true, duplicate: true };
  }
  if (!WRITE_PERMISSIONS.has(permission)) {
    await comment(api, owner, repo, issue.number,
      `@${requester}\n\nPermission denied / 权限不足\n\nOnly the repository owner or a collaborator with write access can start a package probe Matrix. / 只有仓库所有者或具有写权限的协作者可以启动软件包探针 Matrix。`);
    await closeIssue(api, owner, repo, issue.number);
    return { relevant: true, authorized: false };
  }
  if (!await workerSupportsGateway(api, owner, repo, request.channel)) {
    throw new Error(`Probe worker on ${request.channel} is not compatible with state-token Issue dispatch`);
  }
  await comment(api, owner, repo, issue.number, [
    `@${requester}`, '', 'Request accepted / 请求已接收', '',
    `- Channel / 通道: \`${request.channel}\``,
    `- Mode / 深度: \`${request.mode}\``,
    `- Probe roots / 测试入口: ${request.roots.map((row) => `\`${row}\``).join(', ')}`,
    `- Final enabled packages / 最终启用软件包: ${request.finalPackageCount}`,
    `- Defconfig: \`${request.useDefconfig ? 'on' : 'off'}\``,
    `- Coverage / 覆盖: \`${request.coverage.mode}${request.coverage.mode === 'auto' ? ` <= ${request.coverage.limit}` : ''}\``,
    '', 'To cancel, reply `/cancel` in this Issue. / 如需取消，请在本 Issue 回复 `/cancel`。', '',
    `<!-- WEIG_PACKAGE_PROBE_INTAKE_V3 sha=${parsedState.sha256} -->`,
  ].join('\n'));
  const [currentIssue, beforeDispatch] = await Promise.all([
    api(`/repos/${owner}/${repo}/issues/${issue.number}`), issueComments(api, owner, repo, issue.number),
  ]);
  if (currentIssue.state !== 'open' || probeCancellationRequested(beforeDispatch)) {
    await closeIssue(api, owner, repo, issue.number);
    return { relevant: true, authorized: true, cancelled: true };
  }
  const dispatched = await api(`/repos/${owner}/${repo}/actions/workflows/package-probe.yml/dispatches`, {
    method: 'POST',
    body: {
      ref: request.channel,
      inputs: {
        issue_number: String(issue.number),
        display_context: probeDisplayContext(request, issue.number),
        mode: request.mode,
        state_sha256: parsedState.sha256,
        issue_created_at: String(issue.created_at || ''),
        batch_index: '0',
        sampling_seed: '',
        data_commit: '',
      },
      return_run_details: true,
    },
  });
  const runId = Number(dispatched?.workflow_run_id || 0);
  if (!runId || !dispatched?.html_url) throw new Error('workflow dispatch did not return a run identity');
  await comment(api, owner, repo, issue.number, [
    'Probe started / 探针已启动', '', `Run / 运行: ${dispatched.html_url}`, '',
    'To cancel, reply `/cancel` in this Issue. / 如需取消，请在本 Issue 回复 `/cancel`。', '',
    `<!-- WEIG_PACKAGE_PROBE_RUN_V3 run=${runId} sha=${parsedState.sha256} batch=0 -->`,
  ].join('\n'));
  const [latestIssue, afterDispatch] = await Promise.all([
    api(`/repos/${owner}/${repo}/issues/${issue.number}`), issueComments(api, owner, repo, issue.number),
  ]);
  if (latestIssue.state !== 'open' || probeCancellationRequested(afterDispatch)) {
    await cancelRun(api, owner, repo, runId);
  }
  return { relevant: true, authorized: true, runId, request };
}

async function cancel(env, event) {
  if (probeIssueCommand(event.comment?.body) !== 'cancel' || !isProbeIssue(event.issue)) return { relevant: false };
  const { owner, repo } = repositoryParts(env);
  const api = apiClient(env);
  const issue = event.issue;
  const requester = String(issue.user?.login || '');
  const commenter = String(event.comment?.user?.login || '');
  const permission = await permissionFor(api, owner, repo, commenter);
  if (!probeCancellationAuthorized({ requester, commenter, permission })) {
    await comment(api, owner, repo, issue.number,
      `@${commenter}\n\nPermission denied / 权限不足\n\nOnly the requester or a collaborator with write access can cancel this probe. / 只有请求提交者或具有写权限的协作者可以取消本探针。`);
    return { relevant: true, authorized: false };
  }
  let comments = await issueComments(api, owner, repo, issue.number);
  if (!probeCancellationRequested(comments)) {
    await comment(api, owner, repo, issue.number, [
      `@${commenter}`, '', 'Cancellation requested / 已请求取消', '',
      'Stopping every queued or running Matrix job linked to this Issue. / 正在停止与本 Issue 关联的全部排队或运行中 Matrix Job。', '',
      CANCEL_MARKER,
    ].join('\n'));
    comments = await issueComments(api, owner, repo, issue.number);
  }
  const runs = probeRunMarkers(comments);
  const results = [];
  for (const marker of runs) results.push(await cancelRun(api, owner, repo, marker.runId));
  const active = results.filter((row) => row.active);
  await comment(api, owner, repo, issue.number, active.length ? [
    'Probe cancelled / 探针已取消', '', ...active.map((row) => `- ${row.url}`), '',
    'Normal cancellation is used first; force cancellation is only used when the Run remains active. / 系统优先普通取消，只有 Run 仍未停止时才使用强制取消。',
  ].join('\n') :
    'No active probe Run was found; the cancellation marker will prevent a pending dispatch. / 未找到运行中的探针；取消标记会阻止尚未开始的派发。');
  await closeIssue(api, owner, repo, issue.number);
  return { relevant: true, authorized: true, cancelled: active.length, runs: results };
}

export async function main(env = process.env) {
  const event = eventPayload(env);
  if (env.GITHUB_EVENT_NAME === 'issues') {
    try { return await intake(env, event); }
    catch (error) {
      if (isProbeIssue(event.issue)) {
        const { owner, repo } = repositoryParts(env);
        const api = apiClient(env);
        await comment(api, owner, repo, event.issue.number, [
          'Request rejected / 请求被拒绝', '', `\`${String(error?.message || error).slice(0, 1000)}\``, '',
          'Return to AutoBuild, reopen Package Probe, and submit the generated Advanced menuconfig state again. / 请返回 AutoBuild，重新打开插件兼容探针并再次提交由 Advanced menuconfig 生成的状态。',
        ].join('\n'));
        await closeIssue(api, owner, repo, event.issue.number);
      }
      throw error;
    }
  }
  if (env.GITHUB_EVENT_NAME === 'issue_comment') return await cancel(env, event);
  throw new Error(`unsupported Issue gateway event: ${env.GITHUB_EVENT_NAME}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();

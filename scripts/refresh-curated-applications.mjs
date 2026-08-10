#!/usr/bin/env node
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CONFIG_FILE = join(ROOT, 'catalog.config.json');
const TRANSLATION_FILE = join(ROOT, 'translations', 'zh-CN.json');
const args = new Map();
for (let index = 2; index < process.argv.length; index++) {
  const key = process.argv[index];
  const next = process.argv[index + 1];
  if (key.startsWith('--') && next && !next.startsWith('--')) {
    args.set(key.slice(2), next);
    index++;
  } else if (key.startsWith('--')) args.set(key.slice(2), true);
}

const NEW_METADATA = {
  '3cat': ['3CAT 网络工具', '网络管理', '移动网络诊断与连接工具', '3CAT network tools', 'Mobile-network diagnostics and connection tools'],
  '3ginfo-lite': ['3G/4G 信息', '网络管理', '查看移动网络和基带状态', '3G/4G information', 'View mobile-network and modem status'],
  'airoha-npu': ['Airoha NPU', '系统工具', '管理 Airoha 网络加速引擎', 'Airoha NPU', 'Manage the Airoha network acceleration engine'],
  dae: ['DAE', '魔法与加速', '管理高性能透明代理服务', 'DAE', 'Manage the high-performance transparent proxy service'],
  daed: ['DAED', '魔法与加速', '管理 DAE 控制与订阅服务', 'DAED', 'Manage DAE control and subscription services'],
  dufs: ['DUFS 文件服务', '存储与下载', '提供轻量网页文件服务器', 'DUFS file server', 'Provide a lightweight web file server'],
  example: ['LuCI 示例', '其他与高级', 'LuCI 应用开发示例', 'LuCI example', 'Example application for LuCI development'],
  'filebrowser-go': ['File Browser Go', '存储与下载', '通过网页管理路由器文件', 'File Browser Go', 'Manage router files from a web browser'],
  firewall: ['防火墙', '系统基础', '配置防火墙区域和访问规则', 'Firewall', 'Configure firewall zones and traffic rules'],
  k3screenctrl: ['K3 屏幕控制', '系统工具', '管理 K3 路由器屏幕显示', 'K3 screen control', 'Manage the display on K3 routers'],
  lucky: ['Lucky 网络工具', '网络管理', '管理端口转发、动态域名和证书', 'Lucky network tools', 'Manage forwarding, dynamic DNS, and certificates'],
  modemband: ['ModemBand', '网络管理', '查看并锁定移动网络频段', 'ModemBand', 'Inspect and lock mobile-network bands'],
  mosdns: ['MosDNS', '广告过滤与DNS', '用规则和缓存优化 DNS', 'MosDNS', 'Optimize DNS with rules and caching'],
  onekeyap: ['一键 AP', '网络管理', '快速配置无线接入点模式', 'One-key AP', 'Quickly configure wireless access-point mode'],
  qiyougamebooster: ['奇游联机宝', '魔法与加速', '管理奇游游戏加速服务', 'Qiyou game booster', 'Manage the Qiyou game acceleration service'],
  'qos-legacy': ['传统 QoS', '网络管理', '配置传统流量优先级规则', 'Legacy QoS', 'Configure legacy traffic-priority rules'],
  qosify: ['QoSify', '网络管理', '使用 nftables 和 CAKE 管理流量', 'QoSify', 'Manage traffic with nftables and CAKE'],
  repeater: ['无线中继', '网络管理', '配置无线扫描和中继连接', 'Wireless repeater', 'Configure wireless scanning and relay connections'],
  rtp2httpd: ['RTP 转 HTTP', '多媒体与外设', '把组播 RTP 流转换为 HTTP', 'RTP to HTTP', 'Convert multicast RTP streams to HTTP'],
  samba: ['Samba 文件共享', '存储与下载', '提供局域网 SMB 文件共享', 'Samba file sharing', 'Provide SMB file sharing on the local network'],
  'sms-tool-js': ['短信工具', '网络管理', '通过移动网络模块收发短信', 'SMS Tool', 'Send and receive SMS through a mobile modem'],
  spotifyd: ['Spotifyd', '多媒体与外设', '把路由器作为 Spotify 播放设备', 'Spotifyd', 'Use the router as a Spotify playback device'],
  ua2f: ['UA2F', '魔法与加速', '统一转发流量的 User-Agent', 'UA2F', 'Normalize the User-Agent of forwarded traffic'],
  unblockneteasemusic: ['解锁网易云音乐', '多媒体与外设', '改善网易云音乐歌曲可用性', 'Unblock NetEase Music', 'Improve song availability in NetEase Music'],
  wechatpush: ['微信推送', '监控统计', '推送设备状态和网络事件通知', 'WeChat push', 'Send device status and network event notifications'],
};

function readJson(file) {
  return JSON.parse(readFileSync(file, 'utf8'));
}

async function githubTree(repo, ref) {
  const headers = { 'User-Agent': 'WeiG-OpenWrt-Menuconfig-Catalog' };
  if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  const url = `https://api.github.com/repos/${repo}/git/trees/${encodeURIComponent(ref)}?recursive=1`;
  const response = await fetch(url, { headers });
  if (!response.ok) throw new Error(`${repo}@${ref}: HTTP ${response.status}`);
  const body = await response.json();
  if (body.truncated) throw new Error(`${repo}@${ref}: recursive tree was truncated`);
  const names = (body.tree || []).map((item) => item.path)
    .map((path) => path.match(/(?:^|\/)applications\/(luci-app-[A-Za-z0-9_.+@-]+)\/Makefile$/)?.[1])
    .filter(Boolean);
  return [...new Set(names)].sort();
}

const config = readJson(CONFIG_FILE);
const translations = readJson(TRANSLATION_FILE);
const sources = config.curatedAuditSources || [
  { id: 'OpenWrt', repo: 'openwrt/luci', ref: 'master' },
  { id: 'ImmortalWrt', repo: 'immortalwrt/luci', ref: 'master' },
  { id: 'lede', repo: 'coolsnowwolf/luci', ref: 'openwrt-25.12' },
];
const audited = [];
for (const source of sources) {
  const packages = await githubTree(source.repo, source.ref);
  audited.push({ ...source, count: packages.length, packages });
}
const union = [...new Set(audited.flatMap((source) => source.packages))].sort();
const existing = new Map((config.curatedApplications || config.curatedCandidates || [])
  .map((row) => [row.id, row]));
let legacy = { groups: [], plugins: [] };
if (args.get('legacy-meta')) legacy = readJson(resolve(String(args.get('legacy-meta'))));
const legacyById = new Map((legacy.plugins || []).map((row) => [row.id, row]));
const groups = config.curatedGroups || legacy.groups || [];
const applications = union.map((packageName) => {
  const id = packageName.slice('luci-app-'.length);
  const old = existing.get(id) || {};
  const legacyRow = legacyById.get(id) || {};
  const added = NEW_METADATA[id] || [];
  const group = old.group || legacyRow.group || added[1] || '其他与高级';
  return {
    id,
    packages: [packageName],
    group,
    ...(old.hot || legacyRow.hot ? { hot: true } : {}),
  };
});

for (const row of applications) {
  const packageName = row.packages[0];
  const symbol = `PACKAGE_${packageName}`;
  if (translations.entries[symbol]) continue;
  const legacyRow = legacyById.get(row.id);
  const added = NEW_METADATA[row.id] || [];
  const titleZh = legacyRow?.name || added[0] || row.id;
  const usageZh = legacyRow?.desc || added[2] || '';
  const titleEn = added[3] || row.id;
  const usageEn = added[4] || '';
  translations.entries[symbol] = {
    titleEn, titleZh, usageEn, usageZh,
    titleI18n: { 'zh-CN': titleZh },
    usageI18n: { 'zh-CN': usageZh },
    source: 'Catalog curated applications',
  };
}

const report = {
  schema: 1,
  generatedAt: new Date().toISOString(),
  sources: audited.map(({ packages, ...source }) => source),
  union: union.length,
  added: applications.filter((row) => !existing.has(row.id)).map((row) => row.id),
  removed: [...existing.keys()].filter((id) => !applications.some((row) => row.id === id)).sort(),
  applications,
};
mkdirSync(join(ROOT, 'diagnostics'), { recursive: true });
writeFileSync(join(ROOT, 'diagnostics', 'curated-applications-refresh.json'),
  JSON.stringify(report, null, 2) + '\n');

if (args.get('write')) {
  config.curatedAuditSources = sources;
  config.curatedGroups = groups;
  config.curatedApplications = applications;
  delete config.curatedCandidates;
  translations.generatedAt = report.generatedAt;
  writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2) + '\n');
  writeFileSync(TRANSLATION_FILE, JSON.stringify(translations, null, 2) + '\n');
}

console.log(`Curated applications: sources=${audited.map((row) => `${row.id}:${row.count}`).join(', ')}` +
  ` union=${union.length} added=${report.added.length} removed=${report.removed.length}` +
  `${args.get('write') ? ' (written)' : ' (report only)'}`);

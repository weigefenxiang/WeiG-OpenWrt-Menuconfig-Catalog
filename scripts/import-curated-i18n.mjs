#!/usr/bin/env node
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const [metaFile, i18nFile, outFile = 'translations/zh-CN.json'] = process.argv.slice(2);
if (!metaFile || !i18nFile) {
  throw new Error('Usage: node scripts/import-curated-i18n.mjs <plugins-meta.json> <plugins-i18n.json> [output]');
}

const meta = JSON.parse(readFileSync(resolve(metaFile), 'utf8'));
const i18n = JSON.parse(readFileSync(resolve(i18nFile), 'utf8'));
const english = i18n.plugins || {};
const entries = {};
for (const plugin of meta.plugins || []) {
  const translated = english[plugin.id] || {};
  entries[`PACKAGE_luci-app-${plugin.id}`] = {
    titleEn: translated.name?.en || plugin.id,
    titleZh: plugin.name || '',
    usageEn: translated.desc?.en || '',
    usageZh: plugin.desc || '',
    source: 'WeiG curated plugins',
  };
}

const prompts = {
  'Advanced configuration options (for developers)': {
    titleZh: '高级配置选项（开发者）',
    usageEn: 'Configure low-level build and toolchain settings',
    usageZh: '配置底层构建与工具链设置',
  },
  Administration: { titleZh: '系统管理', usageEn: 'System administration tools', usageZh: '系统管理工具' },
  Applications: { titleZh: '应用', usageEn: 'LuCI web applications', usageZh: 'LuCI 网页应用' },
  'Base system': { titleZh: '基础系统', usageEn: 'Core packages required by the firmware', usageZh: '固件所需的核心软件包' },
  'Build the OpenWrt Image Builder': { titleZh: '构建 OpenWrt 镜像生成器', usageEn: 'Build the Image Builder archive', usageZh: '生成 Image Builder 压缩包' },
  'Build the OpenWrt SDK': { titleZh: '构建 OpenWrt SDK', usageEn: 'Build the software development kit', usageZh: '生成软件开发工具包' },
  'Package the OpenWrt-based Toolchain': { titleZh: '打包 OpenWrt 工具链', usageEn: 'Build a standalone toolchain archive', usageZh: '生成独立工具链压缩包' },
  'Boot Loaders': { titleZh: '引导加载程序', usageEn: 'Bootloader packages and utilities', usageZh: '引导程序软件包与工具' },
  Development: { titleZh: '开发工具', usageEn: 'Development and debugging tools', usageZh: '开发与调试工具' },
  'Enable experimental features by default': { titleZh: '默认启用实验功能', usageEn: 'Expose experimental build options', usageZh: '显示实验性构建选项' },
  'Extra packages': { titleZh: '扩展软件包', usageEn: 'Additional optional packages', usageZh: '其他可选软件包' },
  Firmware: { titleZh: '固件组件', usageEn: 'Firmware blobs and device components', usageZh: '固件文件与设备组件' },
  Fonts: { titleZh: '字体', usageEn: 'Font packages', usageZh: '字体软件包' },
  Games: { titleZh: '游戏', usageEn: 'Games and entertainment packages', usageZh: '游戏与娱乐软件包' },
  'Global build settings': { titleZh: '全局构建设置', usageEn: 'Configure global build behavior', usageZh: '配置全局构建行为' },
  'Image configuration': { titleZh: '镜像配置', usageEn: 'Configure generated firmware images', usageZh: '配置生成的固件镜像' },
  'Kernel modules': { titleZh: '内核模块', usageEn: 'Optional Linux kernel modules', usageZh: '可选 Linux 内核模块' },
  Languages: { titleZh: '语言', usageEn: 'Language runtimes and tools', usageZh: '语言运行环境与工具' },
  Libraries: { titleZh: '程序库', usageEn: 'Shared libraries used by packages', usageZh: '软件包使用的共享程序库' },
  LuCI: { titleZh: 'LuCI 网页管理', usageEn: 'Web administration interface and applications', usageZh: '网页管理界面与应用' },
  Collections: { titleZh: '套件集合', usageEn: 'LuCI package collections', usageZh: 'LuCI 软件包集合' },
  Modules: { titleZh: '模块', usageEn: 'LuCI core modules', usageZh: 'LuCI 核心模块' },
  Plugins: { titleZh: '插件', usageEn: 'LuCI service plugins', usageZh: 'LuCI 服务插件' },
  Protocols: { titleZh: '协议', usageEn: 'LuCI network protocol support', usageZh: 'LuCI 网络协议支持' },
  Themes: { titleZh: '主题', usageEn: 'LuCI web interface themes', usageZh: 'LuCI 网页界面主题' },
  Mail: { titleZh: '邮件', usageEn: 'Mail clients and servers', usageZh: '邮件客户端与服务器' },
  Multimedia: { titleZh: '多媒体', usageEn: 'Audio and video applications', usageZh: '音频与视频应用' },
  Network: { titleZh: '网络', usageEn: 'Network services and utilities', usageZh: '网络服务与工具' },
  'Network Support': { titleZh: '网络支持', usageEn: 'Network drivers and protocol support', usageZh: '网络驱动与协议支持' },
  Sound: { titleZh: '声音', usageEn: 'Audio drivers and tools', usageZh: '音频驱动与工具' },
  'Target Images': { titleZh: '目标镜像', usageEn: 'Choose firmware image formats and filesystems', usageZh: '选择固件镜像格式与文件系统' },
  Utilities: { titleZh: '实用工具', usageEn: 'General system utilities', usageZh: '通用系统工具' },
  Video: { titleZh: '视频', usageEn: 'Video drivers and tools', usageZh: '视频驱动与工具' },
  Xorg: { titleZh: 'Xorg 图形系统', usageEn: 'X Window System packages', usageZh: 'X Window 图形系统软件包' },
};

const output = resolve(outFile);
mkdirSync(dirname(output), { recursive: true });
writeFileSync(output, JSON.stringify({
  schema: 1,
  generatedAt: new Date().toISOString(),
  policy: {
    primary: ['en', 'zh-CN'],
    fallback: 'en',
    note: 'Canonical English comes from upstream. Chinese overrides never replace symbols.',
  },
  prompts,
  entries,
}, null, 2) + '\n');
console.log(`${output}: ${Object.keys(entries).length} package translations / ${Object.keys(prompts).length} prompt translations`);

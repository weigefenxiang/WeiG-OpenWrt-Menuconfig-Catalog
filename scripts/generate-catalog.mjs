#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { gzipSync } from 'node:zlib';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseInfoRecords, parseKconfigTree, parsePackageInfo, safeSlug } from './lib.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = {};
for (let i = 2; i < process.argv.length; i += 2) args[process.argv[i].replace(/^--/, '')] = process.argv[i + 1];
for (const key of ['source-id', 'repo', 'branch', 'tree']) {
  if (!args[key]) throw new Error(`缺少 --${key}`);
}
const tree = resolve(args.tree);
const outDir = resolve(args.out || join(ROOT, 'dist'));
const targetInfo = join(tree, 'tmp', '.targetinfo');
const packageInfo = join(tree, 'tmp', '.packageinfo');
const targets = parseInfoRecords(readFileSync(targetInfo, 'utf8'));
const packages = parsePackageInfo(readFileSync(packageInfo, 'utf8'));
const menu = parseKconfigTree(tree);
const translations = JSON.parse(readFileSync(join(ROOT, 'translations', 'zh-CN.json'), 'utf8'));
const menuI18n = JSON.parse(readFileSync(join(ROOT, 'translations', 'menu-i18n.json'), 'utf8'));
if (!targets.length || !menu.options.length) {
  throw new Error(`目录异常:targets=${targets.length},menu options=${menu.options.length}`);
}
const targetSymbols = new Set(['TARGET_BOARD', 'TARGET_SUBTARGET', 'TARGET_PROFILE']);
for (const target of targets) {
  targetSymbols.add(`TARGET_${target.board}`);
  targetSymbols.add(`TARGET_${target.board}_${target.subtarget}`);
  for (const profile of target.profiles) {
    targetSymbols.add(`TARGET_${target.board}_${target.subtarget}_${profile.id}`);
  }
}
const menuOptions = menu.options.filter((option) =>
  option.path[0] !== 'Target Devices' && !targetSymbols.has(option.symbol));
const pollutedDependencies = menuOptions.flatMap((option) =>
  (option.depends || []).filter((expression) =>
    /\s/.test(expression) && !/[&|=!<>]/.test(expression))
    .map((expression) => `${option.symbol}: ${expression}`));
if (pollutedDependencies.length) {
  throw new Error(`Kconfig 依赖疑似混入 help 正文:\n${pollutedDependencies.slice(0, 20).join('\n')}`);
}
const packageByName = new Map(packages.map((item) => [item.name, item]));
const promptTranslations = translations.prompts || {};
const entryTranslations = translations.entries || {};
const translatedOptions = menuOptions.map((option) => {
  const packageName = option.symbol.startsWith('PACKAGE_') ? option.symbol.slice(8) : '';
  const packageRow = packageByName.get(packageName);
  const translated = entryTranslations[option.symbol] || {};
  const promptRow = promptTranslations[option.prompt] || {};
  return {
    ...option,
    promptEn: packageRow?.title || option.prompt,
    promptZh: translated.titleZh || promptRow.titleZh || '',
    promptI18n: translated.titleI18n || {},
    usageEn: packageRow?.description || option.help || translated.usageEn || promptRow.usageEn || '',
    usageZh: translated.usageZh || promptRow.usageZh || '',
    usageI18n: translated.usageI18n || {},
    translationSource: translated.source || (promptRow.titleZh ? 'Catalog glossary' : ''),
  };
});
const menuPathNames = [...new Set(menuOptions.flatMap((option) => option.path || []))];
const menuLabels = Object.fromEntries(menuPathNames.map((name) => [
  name,
  {
    en: name,
    zhCN: promptTranslations[name]?.titleZh || '',
    i18n: menuI18n[name] || {},
    usageEn: promptTranslations[name]?.usageEn || '',
    usageZh: promptTranslations[name]?.usageZh || '',
  },
]));
const choiceIds = new Set(menuOptions.map((option) => option.choice).filter(Boolean));
const compactMenu = {
  categories: menu.categories.filter((name) => name !== 'Target Devices'),
  labels: menuLabels,
  options: translatedOptions,
  choices: menu.choices.filter((choice) => choiceIds.has(choice.id)).map((choice) => {
    const row = promptTranslations[choice.prompt] || {};
    return {
      ...choice,
      promptEn: choice.prompt,
      promptZh: row.titleZh || '',
      promptI18n: menuI18n[choice.prompt] || {},
      usageEn: row.usageEn || '',
      usageZh: row.usageZh || '',
      usageI18n: {},
    };
  }),
};
const targetTree = [];
for (const target of targets) {
  let system = targetTree.find((item) => item.value === target.board);
  if (!system) {
    system = { value: target.board, labelEn: target.name || target.board, labelZh: '', children: [] };
    targetTree.push(system);
  }
  system.children.push({
    value: target.subtarget,
    labelEn: target.subtargetName || target.subtarget,
    labelZh: '',
    targetId: target.id,
    children: target.profiles.map((profile) => ({
      value: profile.id,
      labelEn: profile.name || profile.id,
      labelZh: '',
      profileId: profile.id,
      descriptionEn: profile.description || '',
    })),
  });
}
targetTree.sort((a, b) => a.labelEn.localeCompare(b.labelEn));
for (const system of targetTree) {
  system.children.sort((a, b) => a.labelEn.localeCompare(b.labelEn));
  for (const subtarget of system.children) {
    subtarget.children.sort((a, b) => a.labelEn.localeCompare(b.labelEn));
  }
}
const targetSelectors = [
  { id: 'system', labelEn: 'Target System', labelZh: '目标系统' },
  { id: 'subtarget', labelEn: 'Subtarget', labelZh: '子目标' },
  { id: 'profile', labelEn: 'Target Profile', labelZh: '目标配置' },
];
const missingTranslations = translatedOptions.filter((item) => !item.promptZh).map((item) => ({
  symbol: item.symbol, promptEn: item.promptEn || item.prompt, path: item.path,
}));
const missingMenuTranslations = menuPathNames.filter((name) => !promptTranslations[name]?.titleZh);
const missingChoiceTranslations = compactMenu.choices.filter((choice) => !choice.promptZh)
  .map((choice) => ({ id: choice.id, promptEn: choice.promptEn || choice.prompt }));
const translationReport = {
  schema: 1,
  source: { id: args['source-id'], branch: args.branch },
  generatedAt: new Date().toISOString(),
  languages: ['en', 'zh-CN', 'zh-TW', 'ru', 'es', 'pt', 'ja', 'ko', 'de', 'fr', 'vi'],
  options: translatedOptions.length,
  translatedZhCN: translatedOptions.length - missingTranslations.length,
  missingZhCN: missingTranslations,
  missingMenusZhCN: missingMenuTranslations,
  missingChoicesZhCN: missingChoiceTranslations,
};
let commit = '';
try { commit = execFileSync('git', ['-C', tree, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(); } catch {}
const payload = {
  schema: 2,
  generatedAt: new Date().toISOString(),
  source: {
    id: args['source-id'], label: args.label || args['source-id'],
    repo: args.repo, branch: args.branch,
    commit, legacy: args.legacy === 'true',
  },
  counts: { targets: targets.length, profiles: targets.reduce((n, item) => n + item.profiles.length, 0),
    menuOptions: compactMenu.options.length, packages: packages.length,
    translatedZhCN: translationReport.translatedZhCN,
    missingZhCN: missingTranslations.length },
  targetSelectors,
  targetTree,
  targets,
  menu: compactMenu,
  translation: {
    languages: translationReport.languages,
    fallback: 'en',
    translatedZhCN: translationReport.translatedZhCN,
    missingZhCN: missingTranslations.length,
  },
};
const json = JSON.stringify(payload);
const slug = `${safeSlug(args['source-id'])}--${safeSlug(args.branch)}`;
mkdirSync(outDir, { recursive: true });
const asset = `${slug}.json.gz`;
writeFileSync(join(outDir, asset), gzipSync(Buffer.from(json), { level: 9 }));
writeFileSync(join(outDir, `${slug}.translations.json`), JSON.stringify(translationReport, null, 2) + '\n');
writeFileSync(join(outDir, `${slug}.meta.json`), JSON.stringify({
  source: payload.source, counts: payload.counts, asset,
  generatedAt: payload.generatedAt,
  sha256: createHash('sha256').update(json).digest('hex'),
}, null, 2) + '\n');
console.log(`${asset}: ${targets.length} targets / ${payload.counts.profiles} profiles / ${compactMenu.options.length} menu options / ${packages.length} packages`);

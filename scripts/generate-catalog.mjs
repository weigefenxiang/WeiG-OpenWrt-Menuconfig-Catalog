#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { gzipSync } from 'node:zlib';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildTargetTree, incompleteSelectableTargets, parseInfoRecords, parseKconfigTree, parsePackageInfo, safeSlug,
  resolvePackageOption, targetBuildContract,
} from './lib.mjs';
import { buildKconfigRelations } from './kconfig-relations.mjs';

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
const slug = `${safeSlug(args['source-id'])}--${safeSlug(args.branch)}`;
mkdirSync(outDir, { recursive: true });
let commit = '';
try { commit = execFileSync('git', ['-C', tree, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(); } catch {}
const source = {
  id: args['source-id'], label: args.label || args['source-id'],
  repo: args.repo, branch: args.branch,
  commit, legacy: args.legacy === 'true',
};
const targets = parseInfoRecords(readFileSync(targetInfo, 'utf8'));
const packages = parsePackageInfo(readFileSync(packageInfo, 'utf8'));
const menu = parseKconfigTree(tree);
const duplicateReport = {
  schema: 1,
  source,
  generatedAt: new Date().toISOString(),
  summary: {
    symbols: menu.options.length,
    duplicateSymbols: menu.validation?.duplicates?.length || 0,
    duplicateNodes: menu.validation?.duplicateCount || 0,
    conflicts: menu.validation?.conflicts?.length || 0,
  },
  duplicates: menu.validation?.duplicates || [],
  conflicts: menu.validation?.conflicts || [],
};
writeFileSync(join(outDir, `${slug}.duplicates.json`), JSON.stringify(duplicateReport, null, 2) + '\n');
if (duplicateReport.summary.conflicts) {
  throw new Error(`Kconfig symbol merge conflicts: ${duplicateReport.conflicts
    .slice(0, 20).map((item) => item.symbol).join(', ')}`);
}
const kconfigSymbols = new Set(menu.options.map((option) => option.symbol));
const translations = JSON.parse(readFileSync(join(ROOT, 'translations', 'zh-CN.json'), 'utf8'));
const menuI18n = JSON.parse(readFileSync(join(ROOT, 'translations', 'menu-i18n.json'), 'utf8'));
if (!targets.length || !menu.options.length) {
  throw new Error(`目录异常:targets=${targets.length},menu options=${menu.options.length}`);
}
for (const target of targets) {
  target.contract = targetBuildContract(target, kconfigSymbols);
  target.targetSelector = target.contract.targetSelector || '';
  const profileContracts = new Map((target.contract.profileContracts || []).map((item) => [item.id, item]));
  for (const profile of target.profiles) {
    const profileContract = profileContracts.get(profile.id);
    profile.selector = profileContract?.selector || '';
    profile.targetSelector = profileContract?.targetSelector || target.contract.targetSelector || '';
    profile.boardSelector = profileContract?.boardSelector || target.contract.boardSelector || '';
    profile.selectable = profileContract?.selectable !== false;
    profile.unavailableReason = profileContract?.reason || '';
  }
}
const selectableTargets = targets.filter((target) => target.contract.selectable);
const unavailableTargets = incompleteSelectableTargets(targets, kconfigSymbols);
const contractReport = {
  schema: 1, source, generatedAt: new Date().toISOString(),
  summary: {
    targets: targets.length, selectableTargets: selectableTargets.length,
    unavailableTargets: unavailableTargets.length,
    abstractTargets: targets.filter((target) => target.contract.kind === 'abstract').length,
  },
  unavailable: unavailableTargets.map((target) => ({
    target: target.id, board: target.board, subtarget: target.subtarget,
    profiles: target.contract.profiles, missing: target.contract.missing,
  })),
};
writeFileSync(join(outDir, `${slug}.contract.json`), JSON.stringify(contractReport, null, 2) + '\n');
if (!selectableTargets.length) {
  throw new Error(`No buildable Target/Profile contract: ${targets.slice(0, 20)
    .map((target) => `${target.id}[${target.contract.kind}]`).join(', ')}`);
}
const targetSymbols = new Set(['TARGET_BOARD', 'TARGET_SUBTARGET', 'TARGET_PROFILE']);
for (const target of targets) {
  if (target.contract.boardSelector) targetSymbols.add(target.contract.boardSelector);
  if (target.contract.targetSelector) targetSymbols.add(target.contract.targetSelector);
  for (const profile of target.profiles) {
    if (profile.targetSelector) targetSymbols.add(profile.targetSelector);
    if (profile.selector) targetSymbols.add(profile.selector);
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
const catalogPolicy = JSON.parse(readFileSync(join(ROOT, 'catalog.config.json'), 'utf8'));
const curatedCandidates = Array.isArray(catalogPolicy.curatedCandidates)
  ? catalogPolicy.curatedCandidates
  : [];
if (curatedCandidates.some((candidate) => !candidate || typeof candidate !== 'object' ||
    !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,95}$/.test(String(candidate.id || '')) ||
    !Array.isArray(candidate.packages) || candidate.packages.length === 0 ||
    candidate.packages.some((name) => !/^luci-app-[A-Za-z0-9_.+@-]+$/.test(String(name || ''))))) {
  throw new Error('catalog.config.json curatedCandidates must use {id, packages:[luci-app-*]} objects');
}
const packageSymbols = new Set(menu.options
  .filter((option) => option.symbol.startsWith('PACKAGE_'))
  .map((option) => option.symbol.slice('PACKAGE_'.length)));
const resolveCandidate = (candidate) => resolvePackageOption(candidate, packageSymbols);
const candidateRows = curatedCandidates.map((candidate) => {
  const packageName = resolveCandidate(candidate);
  return {
    id: candidate.id,
    packages: [...candidate.packages],
    package: packageName,
    available: Boolean(packageName),
  };
});
const luciApplications = packages.filter((item) => item.category === 'LuCI' &&
  (item.submenu === 'Applications' || item.name.startsWith('luci-app-')))
  .map((item) => item.name).sort();
const candidateReport = {
  schema: 1, source, generatedAt: new Date().toISOString(),
  curated: candidateRows,
  available: candidateRows.filter((item) => item.available).map((item) => item.package),
  missing: candidateRows.filter((item) => !item.available).map((item) => item.id),
  applications: { count: luciApplications.length, unique: [...new Set(luciApplications)].length, names: luciApplications },
};
writeFileSync(join(outDir, `${slug}.curated-candidates.json`), JSON.stringify(candidateReport, null, 2) + '\n');
const promptTranslations = translations.prompts || {};
const entryTranslations = translations.entries || {};
const translatedOptions = menuOptions.map((option) => {
  const packageName = option.symbol.startsWith('PACKAGE_') ? option.symbol.slice(8) : '';
  const packageRow = packageByName.get(packageName);
  const conflicts = (packageRow?.conflicts || [])
    .map((name) => `PACKAGE_${name}`);
  const translated = entryTranslations[option.symbol] || {};
  const promptRow = promptTranslations[option.prompt] || {};
  return {
    ...option,
    conflicts,
    promptEn: packageRow?.title || option.prompt,
    promptZh: translated.titleZh || promptRow.titleZh || '',
    promptI18n: translated.titleI18n || {},
    usageEn: packageRow?.description || option.help || translated.usageEn || promptRow.usageEn || '',
    usageZh: translated.usageZh || promptRow.usageZh || '',
    usageI18n: translated.usageI18n || {},
    translationSource: translated.source || (promptRow.titleZh ? 'Catalog glossary' : ''),
  };
});
const relations = buildKconfigRelations(menuOptions, packages, menu.choices);
if (!relations.validation.structurallyValid) {
  throw new Error(`Invalid Kconfig choice references: ${relations.validation.invalidChoices.join(', ')}`);
}
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
const targetTree = buildTargetTree(selectableTargets, menu.options);
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
const payload = {
  schema: 4,
  generatedAt: new Date().toISOString(),
  source,
  validation: {
    symbolsUnique: true,
    duplicateSymbols: duplicateReport.summary.duplicateSymbols,
    duplicateNodes: duplicateReport.summary.duplicateNodes,
    duplicateReport: `${slug}.duplicates.json`,
    curatedCandidatesReport: `${slug}.curated-candidates.json`,
  },
  counts: {
    targets: targets.length,
    selectableTargets: selectableTargets.length,
    unavailableTargets: unavailableTargets.length,
    abstractTargets: targets.filter((target) => target.contract.kind === 'abstract').length,
    profiles: selectableTargets.reduce((n, item) => n + item.profiles.length, 0),
    menuOptions: compactMenu.options.length, packages: packages.length,
    translatedZhCN: translationReport.translatedZhCN,
    missingZhCN: missingTranslations.length,
  },
  targetSelectors,
  targetTree,
  targets,
  menu: compactMenu,
  relations,
  translation: {
    languages: translationReport.languages,
    fallback: 'en',
    translatedZhCN: translationReport.translatedZhCN,
    missingZhCN: missingTranslations.length,
  },
};
const json = JSON.stringify(payload);
const asset = `${slug}.json.gz`;
const compressed = gzipSync(Buffer.from(json), { level: 9 });
writeFileSync(join(outDir, asset), compressed);
writeFileSync(join(outDir, `${slug}.relations.json`), JSON.stringify({
  schema: relations.schema, source: payload.source, generatedAt: payload.generatedAt,
  summary: relations.summary, validation: relations.validation, records: relations.records,
}, null, 2) + '\n');
writeFileSync(join(outDir, `${slug}.translations.json`), JSON.stringify(translationReport, null, 2) + '\n');
writeFileSync(join(outDir, `${slug}.meta.json`), JSON.stringify({
  source: payload.source, counts: payload.counts, asset,
  generatedAt: payload.generatedAt,
  commit: payload.source.commit,
  hash: createHash('sha256').update(compressed).digest('hex'),
  sha256: createHash('sha256').update(json).digest('hex'),
  bytes: compressed.byteLength,
  jsonBytes: Buffer.byteLength(json),
}, null, 2) + '\n');
console.log(`${asset}: ${payload.counts.selectableTargets}/${targets.length} selectable targets / ` +
  `${payload.counts.profiles} profiles / ${compactMenu.options.length} menu options / ${packages.length} packages` +
  (unavailableTargets.length ? ` / unavailable contracts: ${unavailableTargets.length}` : ''));

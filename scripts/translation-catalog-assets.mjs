import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';

export const translationLanguages = [
  'zh-CN',
  'zh-TW',
  'ru',
  'es',
  'pt',
  'ja',
  'ko',
  'de',
  'fr',
  'vi',
];

export function indexedTranslationCatalogs(index, directory) {
  if (!index || typeof index !== 'object' || !Array.isArray(index.sources)) {
    throw new Error('index.json must contain a sources array');
  }
  const rows = [];
  const seen = new Set();
  for (const source of index.sources) {
    for (const branch of source.branches || []) {
      const legacy = branch.legacy || branch;
      const asset = String(legacy?.asset || '');
      if (!asset || seen.has(asset)) continue;
      const file = join(directory, asset);
      if (!existsSync(file)) throw new Error(`indexed translation asset is missing: ${asset}`);
      seen.add(asset);
      const languageAssets = Object.fromEntries(Object.entries(branch.assets || {})
        .filter(([logical, contract]) => logical.startsWith('menu:') && contract?.asset)
        .map(([logical, contract]) => [logical.slice(5), join(directory, contract.asset)]));
      rows.push({
        source: String(source.id || ''),
        branch: String(branch.branch || branch.id || ''),
        name: asset,
        file,
        languageAssets,
      });
    }
  }
  return rows;
}

export function menuLanguagePayload(catalog, language, generatedAt) {
  const options = catalog.menu?.options || [];
  const labels = catalog.menu?.labels || {};
  const choices = catalog.menu?.choices || [];
  const localized = (row, chineseKey, i18nKey) => language === 'zh-CN'
    ? String(row?.[chineseKey] || row?.[i18nKey]?.['zh-CN'] || '')
    : String(row?.[i18nKey]?.[language] || '');
  return {
    schema: 1,
    kind: 'menu-language',
    language,
    generatedAt,
    source: catalog.source,
    options: options.map((option) => {
      const title = localized(option, 'promptZh', 'promptI18n');
      const usage = localized(option, 'usageZh', 'usageI18n');
      return title || usage ? [option.symbol, title, usage] : null;
    }).filter(Boolean),
    labels: Object.entries(labels).map(([name, row]) => {
      const title = localized(row, 'zhCN', 'i18n');
      const usage = localized(row, 'usageZh', 'usageI18n');
      return title || usage ? [name, title, usage] : null;
    }).filter(Boolean),
    choices: choices.map((choice) => {
      const title = localized(choice, 'promptZh', 'promptI18n');
      const usage = localized(choice, 'usageZh', 'usageI18n');
      return title || usage ? [choice.id, title, usage] : null;
    }).filter(Boolean),
  };
}

export function writeIndexedLanguageAssets(entry, catalog, generatedAt) {
  let written = 0;
  for (const [language, file] of Object.entries(entry.languageAssets)) {
    if (!translationLanguages.includes(language)) continue;
    const payload = menuLanguagePayload(catalog, language, generatedAt);
    if (existsSync(file)) {
      const current = JSON.parse(gunzipSync(readFileSync(file)));
      const currentBody = { ...current, generatedAt: '' };
      const nextBody = { ...payload, generatedAt: '' };
      if (JSON.stringify(currentBody) === JSON.stringify(nextBody)) continue;
    }
    writeFileSync(file, gzipSync(Buffer.from(JSON.stringify(payload)), { level: 9 }));
    written += 1;
  }
  return written;
}

export function readTranslationIndex(directory) {
  const file = join(directory, 'index.json');
  if (!existsSync(file)) throw new Error('translation requires catalog-data index.json');
  return JSON.parse(readFileSync(file, 'utf8'));
}

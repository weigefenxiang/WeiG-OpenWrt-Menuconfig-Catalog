#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';

const [distArg = 'dist', previousArg = 'previous/i18n-cache.json'] = process.argv.slice(2);
const distDir = resolve(distArg);
const previousFile = resolve(previousArg);
const languages = ['zh-CN', 'zh-TW', 'ru', 'es', 'pt', 'ja', 'ko', 'de', 'fr', 'vi'];
const languageCodes = {
  'zh-CN': 'zh-Hans', 'zh-TW': 'zh-Hant', ru: 'ru', es: 'es', pt: 'pt',
  ja: 'ja', ko: 'ko', de: 'de', fr: 'fr', vi: 'vi',
};
const limit = Math.max(0, Number(process.env.TRANSLATE_LIMIT || 500));
const azureKey = process.env.AZURE_TRANSLATOR_KEY || '';
const azureRegion = process.env.AZURE_TRANSLATOR_REGION || '';
const azureEndpoint = String(process.env.AZURE_TRANSLATOR_ENDPOINT ||
  'https://api.cognitive.microsofttranslator.com').replace(/\/+$/, '');
const provider = azureKey ? 'azure-translator' : 'cache-only';
const cache = existsSync(previousFile)
  ? JSON.parse(readFileSync(previousFile, 'utf8'))
  : { schema: 1, entries: {} };
cache.entries ||= {};

const keyFor = (kind, text) => createHash('sha256').update(`${kind}\0${text}`).digest('hex');
const cleanMap = (value, english) => Object.fromEntries(languages
  .map((lang) => [lang, String(value?.[lang] || '').trim()])
  .filter(([, text]) => text && text !== english));
const fallbackDescription = (option) => {
  const name = String(option.promptEn || option.prompt || option.symbol || '').trim();
  if (option.symbol?.startsWith('PACKAGE_')) return `${name} package for OpenWrt firmware.`;
  return `OpenWrt configuration option: ${name}.`;
};
const jobs = new Map();
const catalogs = [];
const register = (kind, english, manual = {}) => {
  const text = String(english || '').trim();
  if (!text) return {};
  const key = keyFor(kind, text);
  const saved = cache.entries[key] || {};
  const translations = { ...saved.translations, ...cleanMap(manual, text) };
  cache.entries[key] = { kind, english: text, translations };
  if (languages.some((lang) => !translations[lang])) jobs.set(key, cache.entries[key]);
  return translations;
};

for (const name of readdirSync(distDir).filter((item) => item.endsWith('.json.gz')).sort()) {
  const file = join(distDir, name);
  const catalog = JSON.parse(gunzipSync(readFileSync(file)));
  for (const option of catalog.menu?.options || []) {
    option.usageEn ||= fallbackDescription(option);
    for (const [kind, english, manual] of [
      ['title', option.promptEn || option.prompt || option.symbol, option.promptI18n],
      ['usage', option.usageEn, option.usageI18n],
    ]) {
      const translations = register(kind, english, manual);
      if (kind === 'title') option.promptI18n = translations;
      else option.usageI18n = translations;
    }
  }
  for (const row of Object.values(catalog.menu?.labels || {})) {
    row.i18n = register('title', row.en, {
      ...(row.i18n || {}), 'zh-CN': row.zhCN || row.i18n?.['zh-CN'] || '',
    });
    row.usageI18n = register('usage', row.usageEn, {
      ...(row.usageI18n || {}), 'zh-CN': row.usageZh || row.usageI18n?.['zh-CN'] || '',
    });
  }
  for (const choice of catalog.menu?.choices || []) {
    choice.promptI18n = register('title', choice.promptEn || choice.prompt, {
      ...(choice.promptI18n || {}), 'zh-CN': choice.promptZh || choice.promptI18n?.['zh-CN'] || '',
    });
    choice.usageI18n = register('usage', choice.usageEn, {
      ...(choice.usageI18n || {}), 'zh-CN': choice.usageZh || choice.usageI18n?.['zh-CN'] || '',
    });
  }
  catalogs.push({ file, name, catalog });
}

const pending = [...jobs].slice(0, limit);
let translated = 0;
let apiError = '';
const translatedByLanguage = Object.fromEntries(languages.map((lang) => [lang, 0]));
for (let offset = 0; azureKey && offset < pending.length; offset += 50) {
  const batch = pending.slice(offset, offset + 50);
  try {
    const query = new URLSearchParams({ 'api-version': '3.0', from: 'en', textType: 'plain' });
    for (const lang of languages) query.append('to', languageCodes[lang]);
    const headers = {
      'Ocp-Apim-Subscription-Key': azureKey,
      'Content-Type': 'application/json',
    };
    if (azureRegion) headers['Ocp-Apim-Subscription-Region'] = azureRegion;
    const response = await fetch(`${azureEndpoint}/translate?${query}`, {
      method: 'POST', headers, body: JSON.stringify(batch.map(([, row]) => ({ Text: row.english }))),
    });
    if (!response.ok) throw new Error(`${response.status} ${await response.text()}`);
    const payload = await response.json();
    for (let index = 0; index < batch.length; index++) {
      const [id] = batch[index];
      const row = cache.entries[id];
      if (!row) continue;
      const incoming = Object.fromEntries((payload[index]?.translations || [])
        .map((item) => [languages.find((lang) => languageCodes[lang] === item.to), item.text])
        .filter(([lang, text]) => lang && text));
      const additions = cleanMap(incoming, row.english);
      let changed = false;
      for (const lang of languages) if (additions[lang] && !row.translations[lang]) {
        translatedByLanguage[lang] += 1;
        changed = true;
      }
      row.translations = { ...row.translations, ...additions };
      if (changed) translated += 1;
    }
  } catch (error) {
    apiError = error.message;
    break;
  }
}

let localizedFields = 0;
let pendingFields = 0;
const localizedByLanguage = Object.fromEntries(languages.map((lang) => [lang, 0]));
const pendingByLanguage = Object.fromEntries(languages.map((lang) => [lang, 0]));
const countCoverage = (translations) => {
  for (const lang of languages) {
    if (translations[lang]) localizedByLanguage[lang] += 1;
    else pendingByLanguage[lang] += 1;
  }
};
for (const { file, name, catalog } of catalogs) {
  for (const option of catalog.menu?.options || []) {
    for (const [kind, english] of [
      ['title', option.promptEn || option.prompt || option.symbol], ['usage', option.usageEn],
    ]) {
      const row = cache.entries[keyFor(kind, String(english || '').trim())];
      const translations = cleanMap(row?.translations, english);
      if (kind === 'title') option.promptI18n = translations;
      else option.usageI18n = translations;
      localizedFields += Object.keys(translations).length;
      pendingFields += languages.filter((lang) => !translations[lang]).length;
      countCoverage(translations);
    }
  }
  for (const row of Object.values(catalog.menu?.labels || {})) {
    row.i18n = cleanMap(cache.entries[keyFor('title', String(row.en || '').trim())]?.translations, row.en);
    row.usageI18n = cleanMap(
      cache.entries[keyFor('usage', String(row.usageEn || '').trim())]?.translations, row.usageEn,
    );
    countCoverage(row.i18n);
    countCoverage(row.usageI18n);
  }
  for (const choice of catalog.menu?.choices || []) {
    const title = choice.promptEn || choice.prompt;
    choice.promptI18n = cleanMap(
      cache.entries[keyFor('title', String(title || '').trim())]?.translations, title,
    );
    choice.usageI18n = cleanMap(
      cache.entries[keyFor('usage', String(choice.usageEn || '').trim())]?.translations, choice.usageEn,
    );
    countCoverage(choice.promptI18n);
    countCoverage(choice.usageI18n);
  }
  catalog.translation = { ...(catalog.translation || {}), languages: ['en', ...languages], fallback: 'en', updatedAt: new Date().toISOString() };
  writeFileSync(file, gzipSync(Buffer.from(JSON.stringify(catalog)), { level: 9 }));
  const reportFile = join(distDir, name.replace(/\.json\.gz$/, '.translations.json'));
  const report = existsSync(reportFile) ? JSON.parse(readFileSync(reportFile, 'utf8')) : {};
  report.languages = ['en', ...languages];
  report.automation = { provider, localizedFields, pendingFields, localizedByLanguage, pendingByLanguage, apiError };
  writeFileSync(reportFile, JSON.stringify(report, null, 2) + '\n');
}

cache.schema = 1;
cache.updatedAt = new Date().toISOString();
writeFileSync(join(distDir, 'i18n-cache.json'), JSON.stringify(cache) + '\n');
writeFileSync(join(distDir, 'translation-summary.json'), JSON.stringify({
  generatedAt: cache.updatedAt, catalogs: catalogs.length, cachedTexts: Object.keys(cache.entries).length,
  queuedThisRun: pending.length, translatedThisRun: translated, translatedByLanguage,
  localizedFields, pendingFields, localizedByLanguage, pendingByLanguage,
  provider, providerConfigured: Boolean(azureKey), apiError,
}, null, 2) + '\n');
console.log(`translations: catalogs=${catalogs.length} cache=${Object.keys(cache.entries).length}` +
  ` provider=${provider} translated=${translated} pending-fields=${pendingFields}` +
  `${apiError ? ` api-warning=${apiError}` : ''}`);

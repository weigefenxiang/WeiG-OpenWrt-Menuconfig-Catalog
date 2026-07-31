#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';

const [distArg = 'dist', previousArg = 'previous/i18n-cache.json'] = process.argv.slice(2);
const distDir = resolve(distArg);
const previousFile = resolve(previousArg);
const previousStateFile = join(dirname(previousFile), 'translation-state.json');
const languages = ['zh-CN', 'zh-TW', 'ru', 'es', 'pt', 'ja', 'ko', 'de', 'fr', 'vi'];
const rotationLanguages = ['ru', 'es', 'pt', 'ja', 'ko', 'de', 'fr', 'vi'];
const frozenLanguages = ['zh-TW'];
const languageCodes = {
  'zh-CN': 'zh-Hans', 'zh-TW': 'zh-Hant', ru: 'ru', es: 'es', pt: 'pt',
  ja: 'ja', ko: 'ko', de: 'de', fr: 'fr', vi: 'vi',
};
const trigger = process.env.TRANSLATE_TRIGGER || 'local';
const requestedLanguage = process.env.TRANSLATE_LANGUAGE || 'auto';
const translateEnabled = process.env.TRANSLATE_ENABLED
  ? process.env.TRANSLATE_ENABLED === 'true'
  : Boolean(process.env.AZURE_TRANSLATOR_KEY);
const runBudgetSetting = Math.max(0, Number(process.env.TRANSLATE_CHAR_BUDGET || 400000));
const monthlyBudget = Math.max(0, Number(process.env.TRANSLATE_MONTHLY_BUDGET || 1900000));
const azureKey = process.env.AZURE_TRANSLATOR_KEY || '';
const azureRegion = process.env.AZURE_TRANSLATOR_REGION || '';
const azureEndpoint = String(process.env.AZURE_TRANSLATOR_ENDPOINT ||
  'https://api.cognitive.microsofttranslator.com').replace(/\/+$/, '');
const provider = azureKey ? 'azure-translator' : 'cache-only';
const cache = existsSync(previousFile)
  ? JSON.parse(readFileSync(previousFile, 'utf8'))
  : { schema: 1, entries: {} };
const state = existsSync(previousStateFile)
  ? JSON.parse(readFileSync(previousStateFile, 'utf8'))
  : { schema: 1, phase: 'zh-CN-usage', rotationIndex: 0 };
cache.entries ||= {};
state.rotationIndex = Number.isInteger(state.rotationIndex)
  ? state.rotationIndex % rotationLanguages.length : 0;

if (requestedLanguage !== 'auto' &&
    requestedLanguage !== 'zh-CN' &&
    !rotationLanguages.includes(requestedLanguage)) {
  throw new Error(`Unsupported translation language: ${requestedLanguage}`);
}

const month = new Date().toISOString().slice(0, 7);
if (state.monthly?.month !== month) state.monthly = { month, requestedCharacters: 0 };
state.monthly.requestedCharacters = Math.max(0, Number(state.monthly.requestedCharacters || 0));

const keyFor = (kind, text) => createHash('sha256').update(`${kind}\0${text}`).digest('hex');
const cleanMap = (value, english) => Object.fromEntries(languages
  .map((lang) => [lang, String(value?.[lang] || '').trim()])
  .filter(([, text]) => text && text !== english));
const fallbackDescription = (option) => {
  const name = String(option.promptEn || option.prompt || option.symbol || '').trim();
  if (option.symbol?.startsWith('PACKAGE_')) return `${name} package for OpenWrt firmware.`;
  return `OpenWrt configuration option: ${name}.`;
};
const catalogRank = (name) => {
  const value = name.toLowerCase();
  if (value.startsWith('immortalwrt--openwrt-25.12')) return 0;
  if (value.startsWith('immortalwrt--')) return 1;
  return 2;
};
const catalogNames = readdirSync(distDir).filter((item) => item.endsWith('.json.gz'))
  .sort((a, b) => catalogRank(a) - catalogRank(b) || a.localeCompare(b));
const usageKeys = [];
const knownUsageKeys = new Set();
const catalogs = [];
const register = (kind, english, manual = {}) => {
  const text = String(english || '').trim();
  if (!text) return {};
  const key = keyFor(kind, text);
  const saved = cache.entries[key] || {};
  const translations = { ...saved.translations, ...cleanMap(manual, text) };
  cache.entries[key] = { kind, english: text, translations };
  if (kind === 'usage' && !knownUsageKeys.has(key)) {
    knownUsageKeys.add(key);
    usageKeys.push(key);
  }
  return translations;
};

for (const name of catalogNames) {
  const file = join(distDir, name);
  const catalog = JSON.parse(gunzipSync(readFileSync(file)));
  for (const option of catalog.menu?.options || []) {
    option.usageEn ||= fallbackDescription(option);
    option.promptI18n = register(
      'title', option.promptEn || option.prompt || option.symbol, option.promptI18n,
    );
    option.usageI18n = register('usage', option.usageEn, option.usageI18n);
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

const missingUsageKeys = (language) => usageKeys.filter((key) =>
  !cache.entries[key]?.translations?.[language]);
const zhPendingBefore = missingUsageKeys('zh-CN').length;
if (zhPendingBefore > 0) state.phase = 'zh-CN-usage';
else if (state.phase !== 'rotation') state.phase = 'rotation';
const runPhase = state.phase;
const activeLanguage = requestedLanguage !== 'auto'
  ? requestedLanguage
  : runPhase === 'zh-CN-usage'
    ? 'zh-CN'
    : rotationLanguages[state.rotationIndex];
const targetPending = missingUsageKeys(activeLanguage);
const remainingMonthlyBudget = Math.max(
  0, monthlyBudget - state.monthly.requestedCharacters,
);
const runBudget = translateEnabled
  ? Math.min(runBudgetSetting, remainingMonthlyBudget) : 0;
const pending = [];
let queuedCharacters = 0;
let oversizedTexts = 0;
for (const key of targetPending) {
  const characters = [...cache.entries[key].english].length;
  if (characters > 4500) {
    oversizedTexts += 1;
    continue;
  }
  if (queuedCharacters + characters > runBudget) continue;
  pending.push([key, cache.entries[key], characters]);
  queuedCharacters += characters;
}

let translated = 0;
let requestedCharacters = 0;
let apiError = '';
const translatedByLanguage = Object.fromEntries(languages.map((lang) => [lang, 0]));
for (let offset = 0; azureKey && translateEnabled && offset < pending.length;) {
  const batch = [];
  let batchCharacters = 0;
  while (offset < pending.length && batch.length < 50) {
    const row = pending[offset];
    if (batch.length && batchCharacters + row[2] > 4500) break;
    batch.push(row);
    batchCharacters += row[2];
    offset += 1;
  }
  requestedCharacters += batchCharacters;
  try {
    const query = new URLSearchParams({
      'api-version': '3.0', from: 'en', textType: 'plain',
      to: languageCodes[activeLanguage],
    });
    const headers = {
      'Ocp-Apim-Subscription-Key': azureKey,
      'Content-Type': 'application/json',
    };
    if (azureRegion) headers['Ocp-Apim-Subscription-Region'] = azureRegion;
    const response = await fetch(`${azureEndpoint}/translate?${query}`, {
      method: 'POST',
      headers,
      body: JSON.stringify(batch.map(([, row]) => ({ Text: row.english }))),
    });
    if (!response.ok) throw new Error(`${response.status} ${await response.text()}`);
    const payload = await response.json();
    for (let index = 0; index < batch.length; index++) {
      const [id] = batch[index];
      const row = cache.entries[id];
      const text = String(payload[index]?.translations?.[0]?.text || '').trim();
      if (!row || !text || text === row.english || row.translations[activeLanguage]) continue;
      row.translations[activeLanguage] = text;
      translatedByLanguage[activeLanguage] += 1;
      translated += 1;
    }
  } catch (error) {
    apiError = error.message;
    break;
  }
}
state.monthly.requestedCharacters += requestedCharacters;

const targetPendingAfter = missingUsageKeys(activeLanguage).length;
const zhPendingAfter = missingUsageKeys('zh-CN').length;
if (zhPendingAfter === 0) state.phase = 'rotation';
if (trigger === 'schedule' && state.phase === 'rotation' &&
    runPhase === 'rotation' && azureKey && !apiError &&
    (translated > 0 || targetPending.length === 0)) {
  state.rotationIndex = (state.rotationIndex + 1) % rotationLanguages.length;
}
const nextLanguage = state.phase === 'zh-CN-usage'
  ? 'zh-CN' : rotationLanguages[state.rotationIndex];
if (translateEnabled) {
  state.updatedAt = new Date().toISOString();
  state.lastRun = {
    trigger, requestedLanguage, activeLanguage, translated,
    requestedCharacters, apiError,
  };
}

let localizedFields = 0;
let pendingFields = 0;
const localizedByLanguage = Object.fromEntries(languages.map((lang) => [lang, 0]));
const pendingByLanguage = Object.fromEntries(languages.map((lang) => [lang, 0]));
const descriptionLocalizedByLanguage = Object.fromEntries(languages.map((lang) => [lang, 0]));
const descriptionPendingByLanguage = Object.fromEntries(languages.map((lang) => [lang, 0]));
const uniqueDescriptionPendingByLanguage = Object.fromEntries(languages
  .map((lang) => [lang, missingUsageKeys(lang).length]));
const countCoverage = (translations, usage = false) => {
  for (const lang of languages) {
    if (translations[lang]) {
      localizedByLanguage[lang] += 1;
      if (usage) descriptionLocalizedByLanguage[lang] += 1;
    } else {
      pendingByLanguage[lang] += 1;
      if (usage) descriptionPendingByLanguage[lang] += 1;
    }
  }
};

for (const { file, catalog } of catalogs) {
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
      countCoverage(translations, kind === 'usage');
    }
  }
  for (const row of Object.values(catalog.menu?.labels || {})) {
    row.i18n = cleanMap(cache.entries[keyFor('title', String(row.en || '').trim())]?.translations, row.en);
    row.usageI18n = cleanMap(
      cache.entries[keyFor('usage', String(row.usageEn || '').trim())]?.translations, row.usageEn,
    );
    countCoverage(row.i18n);
    countCoverage(row.usageI18n, true);
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
    countCoverage(choice.usageI18n, true);
  }
  catalog.translation = {
    ...(catalog.translation || {}),
    languages: ['en', ...languages],
    fallback: 'en',
    updatedAt: new Date().toISOString(),
  };
  writeFileSync(file, gzipSync(Buffer.from(JSON.stringify(catalog)), { level: 9 }));
}

cache.schema = 1;
cache.updatedAt = new Date().toISOString();
writeFileSync(join(distDir, 'i18n-cache.json'), JSON.stringify(cache) + '\n');
writeFileSync(join(distDir, 'translation-state.json'), JSON.stringify(state, null, 2) + '\n');
const summary = {
  generatedAt: cache.updatedAt,
  catalogs: catalogs.length,
  cachedTexts: Object.keys(cache.entries).length,
  trigger,
  phase: state.phase,
  activeLanguage,
  nextLanguage,
  rotationLanguages,
  frozenLanguages,
  queuedThisRun: pending.length,
  queuedCharacters,
  requestedCharactersThisRun: requestedCharacters,
  runCharacterBudget: runBudget,
  monthlyRequestedCharacters: state.monthly.requestedCharacters,
  monthlyCharacterBudget: monthlyBudget,
  translatedThisRun: translated,
  translatedByLanguage,
  targetPendingBefore: targetPending.length,
  targetPendingAfter,
  oversizedTexts,
  localizedFields,
  pendingFields,
  localizedByLanguage,
  pendingByLanguage,
  descriptionLocalizedByLanguage,
  descriptionPendingByLanguage,
  uniqueDescriptionPendingByLanguage,
  provider,
  providerConfigured: Boolean(azureKey),
  translationEnabled: translateEnabled,
  apiError: apiError || (!azureKey && translateEnabled
    ? 'AZURE_TRANSLATOR_KEY is not configured' : ''),
};
writeFileSync(join(distDir, 'translation-summary.json'), JSON.stringify(summary, null, 2) + '\n');
for (const { name } of catalogs) {
  const reportFile = join(distDir, name.replace(/\.json\.gz$/, '.translations.json'));
  const report = existsSync(reportFile) ? JSON.parse(readFileSync(reportFile, 'utf8')) : {};
  report.languages = ['en', ...languages];
  report.automation = summary;
  writeFileSync(reportFile, JSON.stringify(report, null, 2) + '\n');
}

console.log(`translations: catalogs=${catalogs.length} cache=${Object.keys(cache.entries).length}` +
  ` provider=${provider} active=${activeLanguage} translated=${translated}` +
  ` chars=${requestedCharacters}/${runBudget} next=${nextLanguage}` +
  `${summary.apiError ? ` api-warning=${summary.apiError}` : ''}`);

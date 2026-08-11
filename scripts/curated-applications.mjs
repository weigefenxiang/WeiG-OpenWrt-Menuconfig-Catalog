import { readFileSync } from 'node:fs';
import { join } from 'node:path';

function readJson(file) {
  return JSON.parse(readFileSync(file, 'utf8'));
}

export function activeCuratedGroups(groups, items) {
  const used = new Set((items || []).map((item) => item?.group).filter(Boolean));
  const seen = new Set();
  return (groups || []).filter((group) => {
    if (!used.has(group) || seen.has(group)) return false;
    seen.add(group);
    return true;
  });
}

export function buildCuratedApplications(root) {
  const config = readJson(join(root, 'catalog.config.json'));
  const translations = readJson(join(root, 'translations', 'zh-CN.json'));
  const probeUi = readJson(join(root, 'translations', 'probe-ui.json'));
  const sizes = readJson(join(root, 'curated-sizes.json'));
  const sizeMap = sizes.bytes || {};
  const items = (config.curatedApplications || []).map((row) => {
    const packageName = row.packages?.[0] || '';
    const translation = translations.entries?.[`PACKAGE_${packageName}`] || {};
    return {
      id: row.id,
      package: packageName,
      group: row.group,
      ...(row.hot ? { hot: true } : {}),
      titleEn: translation.titleEn || row.id,
      titleZh: translation.titleZh || '',
      usageEn: translation.usageEn || '',
      usageZh: translation.usageZh || '',
      titleI18n: translation.titleI18n || {},
      usageI18n: translation.usageI18n || {},
      ...(Number.isSafeInteger(sizeMap[packageName]) && sizeMap[packageName] >= 0
        ? { sizeBytes: sizeMap[packageName] } : {}),
    };
  });
  return {
    schema: 1,
    groups: activeCuratedGroups(config.curatedGroups, items),
    probeUi,
    sizeMetric: sizes.metric,
    sizeGeneratedAt: sizes.generatedAt,
    items,
  };
}

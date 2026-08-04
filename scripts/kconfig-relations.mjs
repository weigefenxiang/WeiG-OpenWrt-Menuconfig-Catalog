function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function packageNameFromDependency(token) {
  const raw = String(token || '').trim();
  if (!raw || raw.startsWith('@')) return '';
  const clean = raw.replace(/^\+/, '');
  const right = clean.includes(':') ? clean.split(':').at(-1) : clean;
  return right.replace(/^PACKAGE_/, '').match(/^[A-Za-z0-9_.+-]+/)?.[0] || '';
}

function packageSymbols(expressions = []) {
  return unique(expressions.flatMap((expression) =>
    String(expression).match(/\bPACKAGE_[A-Za-z0-9_+.-]+\b/g) || []));
}

function statesFor(option) {
  if (option?.type === 'tristate') return ['n', 'm', 'y'];
  if (option?.type === 'bool') return ['n', 'y'];
  return [];
}

/**
 * Normalized, source-derived relationship data. Missing edges remain visible as
 * warnings; final configuration is always resolved by the selected upstream.
 */
export function buildKconfigRelations(menuOptions = [], packages = [], choices = []) {
  const optionBySymbol = new Map(menuOptions.map((option) => [option.symbol, option]));
  const packageByName = new Map(packages.map((item) => [item.name, item]));
  const choiceIds = new Set(choices.map((choice) => choice.id));
  const records = [];
  const seenPackages = new Set();
  const unresolvedKconfig = [];
  const unresolvedPackageDependencies = [];
  const unresolvedConflicts = [];
  const invalidChoices = [];

  for (const option of menuOptions.filter((item) => item.symbol.startsWith('PACKAGE_'))) {
    const packageName = option.symbol.slice('PACKAGE_'.length);
    const packageInfo = packageByName.get(packageName);
    const expressionsFor = (field) => {
      const variants = option[`${field}Variants`];
      return Array.isArray(variants) && variants.length ? variants : [option[field] || []];
    };
    const kconfig = {
      depends: packageSymbols(expressionsFor('depends').flat()),
      selects: packageSymbols(expressionsFor('selects').flat()),
      implies: packageSymbols(expressionsFor('implies').flat()),
      dependsVariants: expressionsFor('depends').map((items) => packageSymbols(items)),
      selectsVariants: expressionsFor('selects').map((items) => packageSymbols(items)),
      impliesVariants: expressionsFor('implies').map((items) => packageSymbols(items)),
    };
    const missingKconfig = unique([kconfig.depends, kconfig.selects, kconfig.implies].flat())
      .filter((symbol) => !optionBySymbol.has(symbol));
    const packageDepends = packageInfo?.depends || [];
    const dependencyPackages = unique(packageDepends.map(packageNameFromDependency));
    const conflicts = packageInfo?.conflicts || [];
    const missingDependencies = dependencyPackages.filter((name) => !packageByName.has(name));
    const missingConflicts = conflicts.filter((name) => !packageByName.has(name));
    if (missingKconfig.length) unresolvedKconfig.push({ symbol: option.symbol, missing: missingKconfig });
    if (missingDependencies.length) unresolvedPackageDependencies.push({ package: packageName, missing: missingDependencies });
    if (missingConflicts.length) unresolvedConflicts.push({ package: packageName, missing: missingConflicts });
    if (option.choice && !choiceIds.has(option.choice)) invalidChoices.push(option.symbol);
    records.push({
      package: packageName, symbol: option.symbol,
      origin: packageInfo ? 'kconfig+packageinfo' : 'kconfig-only',
      states: statesFor(option), choice: option.choice || '', kconfig,
      packageDepends, dependencyPackages, provides: packageInfo?.provides || [], conflicts,
      menuDepends: packageInfo?.menuDepends || '', architecture: packageInfo?.architecture || '',
    });
    seenPackages.add(packageName);
  }

  for (const packageInfo of packages.filter((item) => !seenPackages.has(item.name))) {
    const dependencyPackages = unique((packageInfo.depends || []).map(packageNameFromDependency));
    const missingDependencies = dependencyPackages.filter((name) => !packageByName.has(name));
    const missingConflicts = (packageInfo.conflicts || []).filter((name) => !packageByName.has(name));
    if (missingDependencies.length) unresolvedPackageDependencies.push({ package: packageInfo.name, missing: missingDependencies });
    if (missingConflicts.length) unresolvedConflicts.push({ package: packageInfo.name, missing: missingConflicts });
    records.push({
      package: packageInfo.name, symbol: '', origin: 'packageinfo-only', states: [], choice: '',
      kconfig: { depends: [], selects: [], implies: [] },
      packageDepends: packageInfo.depends || [], dependencyPackages,
      provides: packageInfo.provides || [], conflicts: packageInfo.conflicts || [],
      menuDepends: packageInfo.menuDepends || '', architecture: packageInfo.architecture || '',
    });
  }

  records.sort((a, b) => a.package.localeCompare(b.package));
  return {
    schema: 1,
    records,
    summary: {
      packages: records.length,
      kconfigPackages: records.filter((item) => item.symbol).length,
      packageinfoOnly: records.filter((item) => item.origin === 'packageinfo-only').length,
      kconfigOnly: records.filter((item) => item.origin === 'kconfig-only').length,
    },
    validation: {
      structurallyValid: invalidChoices.length === 0,
      unresolvedKconfig, unresolvedPackageDependencies, unresolvedConflicts, invalidChoices,
    },
  };
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function packageName(value) {
  return String(value || '').replace(/^PACKAGE_/, '')
    .match(/^[A-Za-z0-9_.+@-]+/)?.[0] || '';
}

function packageSymbols(expressions = []) {
  return unique(expressions.flatMap((expression) =>
    String(expression).match(/\bPACKAGE_[A-Za-z0-9_+@.-]+\b/g) || []));
}

function statesFor(option) {
  if (option?.type === 'tristate') return ['n', 'm', 'y'];
  if (option?.type === 'bool') return ['n', 'y'];
  return [];
}

function expressionVariants(option, field) {
  const variants = option?.[`${field}Variants`];
  const rows = Array.isArray(variants) && variants.length ? variants : [option?.[field] || []];
  return rows.map((items) => (Array.isArray(items) ? items : [items]).filter(Boolean));
}

function parsePackageDependency(token) {
  const raw = String(token || '').trim();
  if (!raw) return null;
  const required = raw.startsWith('+') || !raw.startsWith('@');
  const clean = raw.replace(/^\+/, '');
  if (clean.startsWith('@')) {
    return { raw, required: false, kind: 'menu-condition', condition: clean.slice(1), packages: [] };
  }
  const colon = clean.lastIndexOf(':');
  const condition = colon >= 0 ? clean.slice(0, colon) : '';
  const target = colon >= 0 ? clean.slice(colon + 1) : clean;
  const packages = unique(target.split(/\|\|/).map((item) => packageName(item.trim())));
  if (!packages.length) return { raw, required: false, kind: 'unknown', condition, packages: [] };
  return {
    raw,
    required,
    kind: packages.length > 1 ? 'alternative' : 'package',
    condition,
    packages,
  };
}

function objectFromMap(map) {
  return Object.fromEntries([...map].sort(([a], [b]) => a.localeCompare(b))
    .map(([key, values]) => [key, unique(values).sort()]));
}

function emptyPackageInfo() {
  return { depends: [], rawDepends: [], provides: [], conflicts: [] };
}

/**
 * Normalized, source-derived relationship data. The schema is declarative:
 * consumers interpret it without package-specific rules. Every Kconfig symbol
 * is represented, while package metadata is attached only to PACKAGE_* symbols.
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
  const providerMap = new Map();

  for (const item of packages) {
    for (const provided of item.provides || []) {
      const name = packageName(provided);
      if (!name) continue;
      const rows = providerMap.get(name) || [];
      rows.push(item.name);
      providerMap.set(name, rows);
    }
  }

  for (const option of menuOptions) {
    const isPackage = option.symbol.startsWith('PACKAGE_');
    const name = isPackage ? option.symbol.slice('PACKAGE_'.length) : '';
    const packageInfo = isPackage ? packageByName.get(name) : null;
    const dependsVariants = expressionVariants(option, 'depends');
    const selectsVariants = expressionVariants(option, 'selects');
    const impliesVariants = expressionVariants(option, 'implies');
    const kconfig = {
      depends: packageSymbols(dependsVariants.flat()),
      selects: packageSymbols(selectsVariants.flat()),
      implies: packageSymbols(impliesVariants.flat()),
      dependsVariants: dependsVariants.map((items) => packageSymbols(items)),
      selectsVariants: selectsVariants.map((items) => packageSymbols(items)),
      impliesVariants: impliesVariants.map((items) => packageSymbols(items)),
      dependsExpressions: dependsVariants,
      selectsExpressions: selectsVariants,
      impliesExpressions: impliesVariants,
    };
    const referencedSymbols = unique([dependsVariants, selectsVariants, impliesVariants]
      .flat(2)
      .flatMap((expression) => String(expression).match(/\b[A-Z][A-Za-z0-9_+@.-]*\b/g) || []));
    const missingKconfig = referencedSymbols.filter((symbol) =>
      !['y', 'm', 'n'].includes(symbol) && !optionBySymbol.has(symbol));

    const packageDepends = packageInfo?.depends || [];
    const parsedDepends = packageDepends.map(parsePackageDependency).filter(Boolean);
    const dependencyPackages = unique(parsedDepends.flatMap((item) => item.packages));
    const conflicts = (packageInfo?.conflicts || []).map(packageName).filter(Boolean);
    const missingDependencies = dependencyPackages.filter((dependency) =>
      !packageByName.has(dependency) && !providerMap.has(dependency));
    const missingConflicts = conflicts.filter((dependency) =>
      !packageByName.has(dependency) && !providerMap.has(dependency));

    if (missingKconfig.length) unresolvedKconfig.push({ symbol: option.symbol, missing: missingKconfig });
    if (missingDependencies.length) unresolvedPackageDependencies.push({ package: name, missing: missingDependencies });
    if (missingConflicts.length) unresolvedConflicts.push({ package: name, missing: missingConflicts });
    if (option.choice && !choiceIds.has(option.choice)) invalidChoices.push(option.symbol);

    const packageFields = packageInfo ? {
      depends: parsedDepends,
      rawDepends: packageDepends,
      provides: packageInfo.provides || [],
      conflicts,
    } : emptyPackageInfo();
    records.push({
      kind: isPackage ? 'package' : 'config',
      package: name,
      configSymbol: option.symbol,
      kconfigSymbol: option.symbol,
      symbol: option.symbol,
      origin: packageInfo
        ? (option.visible === false ? 'hidden-kconfig+packageinfo' : 'kconfig+packageinfo')
        : (option.visible === false ? 'hidden-kconfig-only' : 'kconfig-only'),
      states: statesFor(option),
      visible: option.visible !== false,
      hidden: option.visible === false,
      userSettable: option.userSettable !== false && option.visible !== false,
      canDisable: true,
      choice: option.choice || '',
      type: option.type || '',
      prompt: option.prompt || packageInfo?.title || name || option.symbol,
      title: packageInfo?.title || option.prompt || name || option.symbol,
      description: packageInfo?.description || option.help || '',
      category: packageInfo?.category || '',
      submenu: packageInfo?.submenu || '',
      path: option.path || [],
      parent: option.parent || '',
      kconfig,
      packageInfo: packageFields,
      packageDepends,
      dependencyPackages,
      provides: packageInfo?.provides || [],
      conflicts,
      menuDepends: packageInfo?.menuDepends || '',
      architecture: packageInfo?.architecture || '',
    });
    if (isPackage) seenPackages.add(name);
  }

  for (const packageInfo of packages.filter((item) => !seenPackages.has(item.name))) {
    const parsedDepends = (packageInfo.depends || []).map(parsePackageDependency).filter(Boolean);
    const dependencyPackages = unique(parsedDepends.flatMap((item) => item.packages));
    const conflicts = (packageInfo.conflicts || []).map(packageName).filter(Boolean);
    const missingDependencies = dependencyPackages.filter((dependency) =>
      !packageByName.has(dependency) && !providerMap.has(dependency));
    const missingConflicts = conflicts.filter((dependency) =>
      !packageByName.has(dependency) && !providerMap.has(dependency));
    if (missingDependencies.length) unresolvedPackageDependencies.push({ package: packageInfo.name, missing: missingDependencies });
    if (missingConflicts.length) unresolvedConflicts.push({ package: packageInfo.name, missing: missingConflicts });
    records.push({
      kind: 'package',
      package: packageInfo.name,
      configSymbol: `PACKAGE_${packageInfo.name}`,
      kconfigSymbol: '',
      symbol: '',
      origin: 'packageinfo-only',
      states: [],
      visible: false,
      hidden: true,
      userSettable: false,
      canDisable: true,
      choice: '',
      type: '',
      prompt: packageInfo.title || packageInfo.name,
      title: packageInfo.title || packageInfo.name,
      description: packageInfo.description || '',
      category: packageInfo.category || '',
      submenu: packageInfo.submenu || '',
      path: [],
      parent: '',
      kconfig: {
        depends: [], selects: [], implies: [],
        dependsVariants: [], selectsVariants: [], impliesVariants: [],
        dependsExpressions: [], selectsExpressions: [], impliesExpressions: [],
      },
      packageInfo: {
        depends: parsedDepends,
        rawDepends: packageInfo.depends || [],
        provides: packageInfo.provides || [],
        conflicts,
      },
      packageDepends: packageInfo.depends || [],
      dependencyPackages,
      provides: packageInfo.provides || [],
      conflicts,
      menuDepends: packageInfo.menuDepends || '',
      architecture: packageInfo.architecture || '',
    });
  }

  records.sort((a, b) => (a.configSymbol || a.package).localeCompare(b.configSymbol || b.package));
  const byPackage = new Map();
  const bySymbol = new Map();
  const reverseDependencies = new Map();
  const reverseKconfig = new Map();
  records.forEach((record, index) => {
    if (record.package) byPackage.set(record.package, index);
    if (record.configSymbol) bySymbol.set(record.configSymbol, index);
    for (const dependency of record.dependencyPackages) {
      const rows = reverseDependencies.get(dependency) || [];
      rows.push(record.package);
      reverseDependencies.set(dependency, rows);
    }
    const symbols = unique([record.kconfig.depends, record.kconfig.dependsExpressions]
      .flat(3)
      .flatMap((expression) => String(expression).match(/\b[A-Z][A-Za-z0-9_+@.-]*\b/g) || []));
    for (const symbol of symbols) {
      const rows = reverseKconfig.get(symbol) || [];
      rows.push(record.configSymbol);
      reverseKconfig.set(symbol, rows);
    }
  });

  const choicesIndex = Object.fromEntries(choices.map((choice) => [choice.id,
    records.filter((record) => record.choice === choice.id).map((record) => record.configSymbol)]));

  return {
    schema: 2,
    records,
    indexes: {
      byPackage: Object.fromEntries(byPackage),
      bySymbol: Object.fromEntries(bySymbol),
      providers: objectFromMap(providerMap),
      reverseDependencies: objectFromMap(reverseDependencies),
      reverseKconfig: objectFromMap(reverseKconfig),
      choices: choicesIndex,
    },
    summary: {
      symbols: records.filter((item) => item.kconfigSymbol).length,
      visibleSymbols: records.filter((item) => item.kconfigSymbol && item.visible).length,
      hiddenSymbols: records.filter((item) => item.kconfigSymbol && item.hidden).length,
      packages: records.filter((item) => item.package).length,
      kconfigPackages: records.filter((item) => item.package && item.kconfigSymbol).length,
      visibleKconfigPackages: records.filter((item) => item.package && item.kconfigSymbol && item.visible).length,
      hiddenKconfigPackages: records.filter((item) => item.package && item.kconfigSymbol && item.hidden).length,
      packageinfoOnly: records.filter((item) => item.origin === 'packageinfo-only').length,
      kconfigOnly: records.filter((item) => item.origin.endsWith('kconfig-only')).length,
    },
    validation: {
      structurallyValid: invalidChoices.length === 0,
      unresolvedKconfig,
      unresolvedPackageDependencies,
      unresolvedConflicts,
      invalidChoices,
    },
  };
}

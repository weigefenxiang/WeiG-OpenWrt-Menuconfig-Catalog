const TYPE_CODES = Object.freeze({ '': 0, bool: 1, tristate: 2, string: 3, int: 4, hex: 5 });
const TYPES = Object.freeze(['', 'bool', 'tristate', 'string', 'int', 'hex']);
const ORIGIN_CODES = Object.freeze({
  '': 0,
  'kconfig-only': 1,
  'kconfig+packageinfo': 2,
  'hidden-kconfig-only': 3,
  'hidden-kconfig+packageinfo': 4,
  'packageinfo-only': 5,
});
const ORIGINS = Object.freeze([
  '', 'kconfig-only', 'kconfig+packageinfo', 'hidden-kconfig-only',
  'hidden-kconfig+packageinfo', 'packageinfo-only',
]);
const FLAG_VISIBLE = 1;
const FLAG_USER_SETTABLE = 2;
const FLAG_CAN_DISABLE = 4;
const FLAG_HAS_KCONFIG = 8;
const FLAG_PACKAGE = 16;

function pool() {
  const values = [];
  const indexes = new Map();
  return {
    values,
    id(value) {
      const text = String(value ?? '');
      if (!indexes.has(text)) {
        indexes.set(text, values.length);
        values.push(text);
      }
      return indexes.get(text);
    },
  };
}

function tablePool() {
  const values = [];
  const indexes = new Map();
  return {
    values,
    id(value) {
      const key = JSON.stringify(value);
      if (!indexes.has(key)) {
        indexes.set(key, values.length);
        values.push(value);
      }
      return indexes.get(key);
    },
  };
}

function statesMask(states = []) {
  return (states.includes('n') ? 1 : 0) | (states.includes('m') ? 2 : 0) | (states.includes('y') ? 4 : 0);
}

function parseDefault(raw) {
  const match = String(raw || '').trim().match(/^(.+?)(?:\s+if\s+(.+))?$/);
  return match ? [match[1], match[2] || ''] : ['', ''];
}

function array(value) {
  return Array.isArray(value) ? value : [];
}

function normalizeExpressionVariants(record, key) {
  const rows = record.kconfig?.[`${key}Expressions`] || record.kconfig?.[`${key}Variants`] || [];
  return array(rows).map((row) => array(row).map(String));
}

function indexRows(object, strings, lists) {
  return Object.entries(object || {}).sort(([a], [b]) => a.localeCompare(b)).map(([key, rows]) => [
    strings.id(key), lists.id(array(rows).map((item) => strings.id(item))),
  ]);
}

/**
 * Convert readable relations schema 2 into compact relations schema 3.
 * The compact form is lossless for the generic Catalog engine but omits
 * presentation-only title/help/path fields, which live in menu/hidden/help shards.
 */
export function compactRelations(relations) {
  if (Number(relations?.schema || 0) < 2) throw new Error('relations schema 2 is required');
  const strings = pool();
  const expressions = pool();
  const stringLists = tablePool();
  const expressionLists = tablePool();
  const expressionVariants = tablePool();
  const defaults = tablePool();
  const packageDependencies = tablePool();

  const expressionId = (value) => value ? expressions.id(value) : -1;
  const stringListId = (values) => stringLists.id(array(values).map((value) => strings.id(value)));
  const variantId = (rows) => expressionVariants.id(array(rows).map((row) =>
    expressionLists.id(array(row).map((value) => expressions.id(value)))));

  const records = (relations.records || []).map((record) => {
    const symbol = record.configSymbol || record.symbol || (record.package ? `PACKAGE_${record.package}` : '');
    let flags = 0;
    if (record.visible !== false) flags |= FLAG_VISIBLE;
    if (record.userSettable !== false && record.visible !== false) flags |= FLAG_USER_SETTABLE;
    if (record.canDisable !== false) flags |= FLAG_CAN_DISABLE;
    if (record.kconfigSymbol || record.symbol || record.origin !== 'packageinfo-only') flags |= FLAG_HAS_KCONFIG;
    if (symbol.startsWith('PACKAGE_') || record.kind === 'package' || record.package) flags |= FLAG_PACKAGE;
    const defaultRows = array(record.defaults).map(parseDefault).map(([value, condition]) => [
      strings.id(value), expressionId(condition),
    ]);
    const dependencies = array(record.packageInfo?.depends).map((dependency) => [
      dependency.required === false ? 0 : 1,
      expressionId(dependency.condition || ''),
      strings.id(dependency.raw || ''),
      stringListId(dependency.packages || []),
    ]);
    return [
      strings.id(symbol),
      flags,
      TYPE_CODES[record.type || ''] ?? 0,
      ORIGIN_CODES[record.origin || ''] ?? 0,
      statesMask(record.states),
      record.choice ? strings.id(record.choice) : -1,
      defaults.id(defaultRows),
      variantId(normalizeExpressionVariants(record, 'depends')),
      variantId(normalizeExpressionVariants(record, 'selects')),
      variantId(normalizeExpressionVariants(record, 'implies')),
      packageDependencies.id(dependencies),
      stringListId(record.provides || record.packageInfo?.provides || []),
      stringListId(record.conflicts || record.packageInfo?.conflicts || []),
    ];
  });

  const lists = stringLists.values;
  const indexes = {
    providers: indexRows(relations.indexes?.providers, strings, stringLists),
    reverseDependencies: indexRows(relations.indexes?.reverseDependencies, strings, stringLists),
    reverseKconfig: indexRows(relations.indexes?.reverseKconfig, strings, stringLists),
    choices: indexRows(relations.indexes?.choices, strings, stringLists),
  };

  return {
    schema: 3,
    fields: [
      'symbolId', 'flags', 'typeCode', 'originCode', 'statesMask', 'choiceId',
      'defaultsId', 'dependsVariantsId', 'selectsVariantsId', 'impliesVariantsId',
      'packageDependenciesId', 'providesId', 'conflictsId',
    ],
    flags: {
      visible: FLAG_VISIBLE,
      userSettable: FLAG_USER_SETTABLE,
      canDisable: FLAG_CAN_DISABLE,
      hasKconfig: FLAG_HAS_KCONFIG,
      package: FLAG_PACKAGE,
    },
    types: TYPES,
    origins: ORIGINS,
    strings: strings.values,
    expressions: expressions.values,
    stringLists: lists,
    expressionLists: expressionLists.values,
    expressionVariants: expressionVariants.values,
    defaults: defaults.values,
    packageDependencies: packageDependencies.values,
    records,
    indexes,
    summary: relations.summary || {},
    validation: relations.validation || {},
  };
}

function statesFromMask(mask) {
  return ['n', 'm', 'y'].filter((_, index) => mask & (1 << index));
}

/** Expand compact schema 3 into the canonical schema 2 shape used by tests/debuggers. */
export function expandCompactRelations(compact) {
  if (Number(compact?.schema || 0) !== 3) throw new Error('relations schema 3 is required');
  const strings = compact.strings || [];
  const expressions = compact.expressions || [];
  const stringLists = compact.stringLists || [];
  const expressionLists = compact.expressionLists || [];
  const variants = compact.expressionVariants || [];
  const list = (id) => id < 0 ? [] : (stringLists[id] || []).map((item) => strings[item] || '');
  const expressionRows = (id) => id < 0 ? [] : (variants[id] || []).map((listId) =>
    (expressionLists[listId] || []).map((item) => expressions[item] || ''));
  const indexObject = (rows) => Object.fromEntries((rows || []).map(([keyId, listId]) => [
    strings[keyId] || '', list(listId),
  ]));
  const records = (compact.records || []).map((row) => {
    const [symbolId, flags, typeCode, originCode, mask, choiceId, defaultsId,
      dependsId, selectsId, impliesId, packageDependenciesId, providesId, conflictsId] = row;
    const symbol = strings[symbolId] || '';
    const hasKconfig = Boolean(flags & FLAG_HAS_KCONFIG);
    const isPackage = Boolean(flags & FLAG_PACKAGE);
    const dependsExpressions = expressionRows(dependsId);
    const selectsExpressions = expressionRows(selectsId);
    const impliesExpressions = expressionRows(impliesId);
    const packageDepends = (compact.packageDependencies?.[packageDependenciesId] || []).map(
      ([required, conditionId, rawId, packagesId]) => ({
        raw: strings[rawId] || '',
        required: Boolean(required),
        condition: conditionId < 0 ? '' : expressions[conditionId] || '',
        packages: list(packagesId),
      }),
    );
    const defaultRows = (compact.defaults?.[defaultsId] || []).map(([valueId, conditionId]) => {
      const value = strings[valueId] || '';
      const condition = conditionId < 0 ? '' : expressions[conditionId] || '';
      return condition ? `${value} if ${condition}` : value;
    });
    const packageName = isPackage && symbol.startsWith('PACKAGE_') ? symbol.slice(8) : '';
    const provides = list(providesId);
    const conflicts = list(conflictsId);
    return {
      kind: isPackage ? 'package' : 'config',
      package: packageName,
      configSymbol: symbol,
      kconfigSymbol: hasKconfig ? symbol : '',
      symbol: hasKconfig ? symbol : '',
      origin: compact.origins?.[originCode] || '',
      states: statesFromMask(mask),
      visible: Boolean(flags & FLAG_VISIBLE),
      hidden: !(flags & FLAG_VISIBLE),
      userSettable: Boolean(flags & FLAG_USER_SETTABLE),
      canDisable: Boolean(flags & FLAG_CAN_DISABLE),
      choice: choiceId < 0 ? '' : strings[choiceId] || '',
      type: compact.types?.[typeCode] || '',
      defaults: defaultRows,
      kconfig: {
        dependsExpressions,
        selectsExpressions,
        impliesExpressions,
      },
      packageInfo: { depends: packageDepends, provides, conflicts },
      provides,
      conflicts,
    };
  });
  return {
    schema: 2,
    records,
    indexes: {
      providers: indexObject(compact.indexes?.providers),
      reverseDependencies: indexObject(compact.indexes?.reverseDependencies),
      reverseKconfig: indexObject(compact.indexes?.reverseKconfig),
      choices: indexObject(compact.indexes?.choices),
    },
    summary: compact.summary || {},
    validation: compact.validation || {},
  };
}

export const COMPACT_RELATIONS_FLAGS = Object.freeze({
  visible: FLAG_VISIBLE,
  userSettable: FLAG_USER_SETTABLE,
  canDisable: FLAG_CAN_DISABLE,
  hasKconfig: FLAG_HAS_KCONFIG,
  package: FLAG_PACKAGE,
});

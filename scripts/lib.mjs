import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, normalize, resolve } from 'node:path';

export const safeSlug = (value) => String(value).toLowerCase()
  .replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'item';

export function parseInfoRecords(text) {
  const targets = [];
  let target = null;
  let profile = null;
  const finishProfile = () => {
    if (profile && target) {
      const duplicateIndex = target.profiles.findIndex((item) => item.id === profile.id);
      if (duplicateIndex < 0) target.profiles.push(profile);
      else {
        const previous = target.profiles[duplicateIndex];
        profile.aliases = [...new Set([
          ...(previous.aliases || []), previous.name,
          ...(profile.aliases || []),
        ].filter((name) => name && name !== profile.name))];
        target.profiles[duplicateIndex] = profile;
      }
    }
    profile = null;
  };
  const finishTarget = () => {
    finishProfile();
    if (target) targets.push(target);
    target = null;
  };
  for (const raw of text.replace(/\r\n/g, '\n').split('\n')) {
    const match = raw.match(/^([A-Za-z][A-Za-z0-9-]*):\s*(.*)$/);
    if (!match) continue;
    const [, key, value] = match;
    if (key === 'Target') {
      finishTarget();
      const [board, ...subtargetParts] = value.split('/');
      const subtarget = subtargetParts.join('/') || '';
      target = {
        id: value, board, subtarget, hasSubtarget: Boolean(subtarget), name: value,
        subtargetName: subtarget,
        arch: '', archPackages: '', features: [], packages: [], profiles: [],
      };
      continue;
    }
    if (!target) continue;
    if (key === 'Target-Profile') {
      finishProfile();
      profile = { id: value, name: value, packages: [], default: '' };
      continue;
    }
    if (profile && key.startsWith('Target-Profile-')) {
      const field = key.slice('Target-Profile-'.length);
      if (field === 'Name') profile.name = value;
      else if (field === 'Packages') {
        profile.packages = value.split(/\s+/).filter(Boolean);
        profile.packagesAdd = profile.packages.filter((name) => !name.startsWith('-'))
          .map((name) => name.replace(/^\+/, '')).filter(Boolean);
        profile.packagesRemove = profile.packages.filter((name) => name.startsWith('-'))
          .map((name) => name.slice(1)).filter(Boolean);
      }
      else if (field === 'Default') profile.default = value;
      else if (field === 'Description') profile.description = value;
      continue;
    }
    if (key === 'Target-Board') target.board = value;
    else if (key === 'Target-Subtarget') {
      target.subtarget = value;
      target.hasSubtarget = Boolean(value);
    }
    else if (key === 'Target-Name') target.name = value;
    else if (key === 'Target-Subtarget-Name') target.subtargetName = value;
    else if (key === 'Target-Arch') target.arch = value;
    else if (key === 'Target-Arch-Packages') target.archPackages = value;
    else if (key === 'Target-Features') target.features = value.split(/\s+/).filter(Boolean);
    else if (key === 'Target-Packages') target.packages = value.split(/\s+/).filter(Boolean);
  }
  finishTarget();
  return targets;
}

function selectorCandidates(target, profile) {
  const board = String(target.board || '').trim();
  const subtarget = String(target.subtarget || '').trim();
  const profileId = String(profile?.id || '').trim();
  const profileNames = [...new Set([profileId,
    profileId.replace(/^DEVICE_/, ''),
    profileId.startsWith('DEVICE_') ? '' : `DEVICE_${profileId}`,
  ].filter(Boolean))];
  const targetNames = [...new Set([
    subtarget ? `TARGET_${board}_${subtarget}` : `TARGET_${board}`,
    `TARGET_${board}`,
  ])];
  const boardNames = board ? [`TARGET_${board}`] : [];
  const profiles = targetNames.flatMap((name) => profileNames.map((id) => `${name}_${id}`));
  return { boardNames, targetNames, profiles };
}

function findActualSymbol(candidates, symbols) {
  if (!symbols) return candidates[0] || '';
  for (const candidate of candidates) if (symbols.has(candidate)) return candidate;
  const normalizeSymbol = (value) => String(value).replace(/[^A-Za-z0-9]/g, '').toLowerCase();
  const normalized = new Map();
  for (const symbol of symbols) {
    const key = normalizeSymbol(symbol);
    const matches = normalized.get(key) || [];
    matches.push(symbol);
    normalized.set(key, matches);
  }
  for (const candidate of candidates) {
    const matches = normalized.get(normalizeSymbol(candidate)) || [];
    if (matches.length === 1) return matches[0];
  }
  return '';
}

export function resolveTargetSelectors(target, profile, symbols) {
  const candidates = selectorCandidates(target, profile);
  return {
    board: findActualSymbol(candidates.boardNames, symbols),
    target: findActualSymbol(candidates.targetNames, symbols),
    profile: findActualSymbol(candidates.profiles, symbols),
    candidates,
  };
}

export function targetBuildContract(target, symbols = null) {
  const profileCount = (target.profiles || []).length;
  const missing = [];
  if (!/^[A-Za-z0-9_+-]+$/.test(target.arch)) missing.push('Target-Arch');
  if (!/^[A-Za-z0-9._+-]+$/.test(target.archPackages)) missing.push('Target-Arch-Packages');
  if (!profileCount) {
    return { kind: 'abstract', selectable: false, profiles: 0, missing: [] };
  }
  if (missing.length) {
    return { kind: 'unavailable', selectable: false, profiles: profileCount, missing };
  }
  const profileContracts = target.profiles.map((profile) => {
    const selectors = resolveTargetSelectors(target, profile, symbols);
    return {
      id: profile.id,
      selector: selectors.profile,
      targetSelector: selectors.target,
      boardSelector: selectors.board,
      selectable: Boolean(selectors.target && selectors.profile),
      reason: selectors.target && selectors.profile ? '' : 'missing-selector',
    };
  });
  const selectableProfiles = profileContracts.filter((item) => item.selectable).length;
  if (symbols && !selectableProfiles) {
    return {
      kind: 'unavailable', selectable: false, profiles: profileCount, missing: ['Kconfig-selector'],
      targetSelector: profileContracts[0]?.targetSelector || '', profileContracts,
    };
  }
  return {
    kind: 'buildable', selectable: true, profiles: profileCount, missing: [],
    targetSelector: profileContracts.find((item) => item.targetSelector)?.targetSelector || '',
    boardSelector: profileContracts.find((item) => item.boardSelector)?.boardSelector || '',
    profileContracts,
  };
}

export function incompleteSelectableTargets(targets, symbols = null) {
  return targets.filter((target) => {
    const contract = targetBuildContract(target, symbols);
    return contract.kind === 'unavailable';
  });
}

export function buildTargetTree(targets, options = []) {
  const optionBySymbol = new Map(options.map((option) => [option.symbol, option]));
  const systems = new Map();
  for (const target of targets) {
    const systemSymbol = `TARGET_${target.board}`;
    const systemName = optionBySymbol.get(systemSymbol)?.prompt || target.board;
    const subtargetName = target.hasSubtarget
      ? optionBySymbol.get(target.targetSelector)?.prompt || target.subtargetName || target.subtarget
      : 'Default';
    target.systemName = systemName;
    target.subtargetLabel = subtargetName;

    let system = systems.get(target.board);
    if (!system) {
      system = { value: target.board, labelEn: systemName, labelZh: '', children: [] };
      systems.set(target.board, system);
    } else if (system.labelEn !== systemName) {
      throw new Error(`Target System label conflict: ${target.board} => ${system.labelEn} / ${systemName}`);
    }

    const subtargetValue = target.subtarget || 'default';
    if (system.children.some((item) => item.value === subtargetValue)) {
      throw new Error(`Duplicate Target/Subtarget: ${target.board}/${subtargetValue}`);
    }
    const profiles = new Set();
    const children = [];
    for (const profile of target.profiles.filter((item) => item.selectable !== false)) {
      if (profiles.has(profile.id)) throw new Error(`Duplicate Target Profile: ${target.id}/${profile.id}`);
      profiles.add(profile.id);
      children.push({
        value: profile.id,
        labelEn: profile.name || profile.id,
        labelZh: '',
        profileId: profile.id,
        selector: profile.selector,
        descriptionEn: profile.description || '',
        aliasesEn: profile.aliases || [],
      });
    }
    children.sort((a, b) => a.labelEn.localeCompare(b.labelEn));
    system.children.push({
      value: subtargetValue,
      labelEn: subtargetName,
      labelZh: '',
      targetId: target.id,
      children,
    });
  }
  const targetTree = [...systems.values()];
  targetTree.sort((a, b) => a.labelEn.localeCompare(b.labelEn));
  for (const system of targetTree) {
    system.children.sort((a, b) => a.labelEn.localeCompare(b.labelEn));
  }
  return targetTree;
}

export function parsePackageInfo(text) {
  const packages = [];
  let item = null;
  let lastKey = '';
  const finish = () => {
    if (item?.name) packages.push(item);
    item = null;
    lastKey = '';
  };
  for (const raw of text.replace(/\r\n/g, '\n').split('\n')) {
    const match = raw.match(/^([A-Za-z][A-Za-z0-9-]*):\s*(.*)$/);
    if (!match) {
      if (item && lastKey === 'Description' && /^\s+/.test(raw) && raw.trim()) {
        item.description = `${item.description}${item.description ? ' ' : ''}${raw.trim()}`;
      }
      continue;
    }
    const [, key, value] = match;
    lastKey = key;
    if (key === 'Package') {
      finish();
      item = {
        name: value, title: value, description: '', category: 'Other',
        submenu: '', depends: [], provides: [], conflicts: [],
      };
      lastKey = key;
      continue;
    }
    if (!item) continue;
    if (key === 'Title') item.title = value;
    else if (key === 'Description') item.description = value;
    else if (key === 'Category') item.category = value || 'Other';
    else if (key === 'Submenu') item.submenu = value;
    else if (key === 'Depends') item.depends = value.split(/\s+/).filter(Boolean);
    else if (key === 'Provides') item.provides = value.split(/\s+/).filter(Boolean);
    else if (key === 'Conflicts') item.conflicts = value.split(/\s+/).filter(Boolean);
    else if (key === 'Menu-Depends') item.menuDepends = value;
    else if (key === 'Architecture') item.architecture = value;
  }
  finish();
  return packages;
}

// These are data capabilities, not evaluator capabilities.  The parser only
// promises to preserve source facts; a runtime consumer may still choose to
// defer a decision when it does not implement the native Kconfig fixpoint.
export const KCONFIG_PARSER_CAPABILITIES = Object.freeze([
  'kconfig-expression-ast-v1', 'typed-scalars-v1', 'conditional-defaults-v1',
  'conditional-ranges-v1', 'prompt-visible-menu-conditions-v1',
  'visibility-conditions-v1', 'choice-metadata-v1', 'choice-relations-v1',
  'module-directive-capture-v1', 'module-semantics-v1',
  'per-definition-provenance-v1',
]);

export const KCONFIG_RELATION_CAPABILITIES = Object.freeze([
  'kconfig-expression-ast-v1', 'typed-kconfig-v1', 'conditional-defaults-v1',
  'conditional-ranges-v1', 'visibility-conditions-v1', 'choice-relations-v1',
  'module-semantics-v1', 'typed-package-capabilities-v1', 'alternatives-v1',
  'forward-reverse-edges-v1',
]);

/**
 * Generic golden fixtures for the parser data contract.  These fixtures are
 * intentionally source-independent: they exercise the shared lexer/typed
 * value helpers and the exact output shapes consumed by parseKconfigTree.
 * They do not evaluate a real config; native evaluation remains a consumer
 * concern and is not reimplemented by the catalog producer.
 *
 * Every capability is marked from a check result.  Keeping the matrix next to
 * the checks makes an omitted or failing fixture fail closed instead of
 * silently manufacturing an all-true capability declaration.
 */
export function validateKconfigParserFixture() {
  const failures = [];
  const capabilityMatrix = Object.fromEntries(KCONFIG_PARSER_CAPABILITIES.map((capability) => [capability, false]));
  const capabilityChecks = new Set();
  const check = (capability, name, actual, expected) => {
    capabilityChecks.add(capability);
    const valid = JSON.stringify(actual) === JSON.stringify(expected);
    if (!valid) {
      capabilityMatrix[capability] = false;
      failures.push({ capability, name, actual, expected });
    } else if (!failures.some((row) => row.capability === capability)) capabilityMatrix[capability] = true;
    return valid;
  };
  const checkShape = (capability, name, value, predicate, expected = true) => {
    capabilityChecks.add(capability);
    const actual = Boolean(predicate(value));
    if (actual !== expected) {
      capabilityMatrix[capability] = false;
      failures.push({ capability, name, actual, expected });
    } else if (!failures.some((row) => row.capability === capability)) capabilityMatrix[capability] = true;
    return actual === expected;
  };

  const expression = parseKconfigExpression('A || B && !C');
  check('kconfig-expression-ast-v1', 'expression-symbols', expression.symbols, ['A', 'B', 'C']);
  check('kconfig-expression-ast-v1', 'expression-alternatives', expression.alternatives, [['A'], ['B', 'C']]);
  check('kconfig-expression-ast-v1', 'expression-complete', expression.complete, true);
  const relation = parseKconfigRelation('TARGET_FEATURE if GATE && OTHER');
  check('kconfig-expression-ast-v1', 'relation-target', relation.target, 'TARGET_FEATURE');
  check('kconfig-expression-ast-v1', 'relation-condition-symbols', relation.conditionSymbols, ['GATE', 'OTHER']);
  check('kconfig-expression-ast-v1', 'relation-complete', relation.complete, true);

  const scalarRows = [
    parseKconfigScalar('y', 'bool'), parseKconfigScalar('m', 'tristate'),
    parseKconfigScalar('"fast path"', 'string'), parseKconfigScalar('42', 'int'),
    parseKconfigScalar('0x2a', 'hex'),
  ];
  check('typed-scalars-v1', 'scalar-types', scalarRows.map((row) => row.type),
    ['bool', 'tristate', 'string', 'int', 'hex']);
  checkShape('typed-scalars-v1', 'scalar-validity', scalarRows,
    (rows) => rows.every((row) => row.valid === true && typeof row.raw === 'string' && row.valueKind));

  const defaultRow = parseKconfigDefault('"foo if bar" if DEFAULT_GATE', 'string');
  check('conditional-defaults-v1', 'default-roundtrip-raw', defaultRow.raw,
    '"foo if bar" if DEFAULT_GATE');
  check('conditional-defaults-v1', 'default-value', defaultRow.value, 'foo if bar');
  check('conditional-defaults-v1', 'default-condition', defaultRow.condition, 'DEFAULT_GATE');
  checkShape('conditional-defaults-v1', 'default-validity', defaultRow,
    (row) => row.valid === true && row.precise === true && row.valueKind === 'literal');

  const rangeRow = parseKconfigRange('1 64 if RANGE_GATE', 'int');
  check('conditional-ranges-v1', 'range-bounds', [rangeRow.min, rangeRow.max], [1, 64]);
  check('conditional-ranges-v1', 'range-condition', rangeRow.condition, 'RANGE_GATE');
  check('conditional-ranges-v1', 'range-raw', rangeRow.raw, '1 64 if RANGE_GATE');
  checkShape('conditional-ranges-v1', 'range-validity', rangeRow,
    (row) => row.valid === true && row.minKind === 'literal' && row.maxKind === 'literal');

  const prompt = parsePromptClause('"Golden prompt" if PROMPT_GATE');
  check('prompt-visible-menu-conditions-v1', 'prompt-condition', prompt,
    { prompt: 'Golden prompt', condition: 'PROMPT_GATE' });
  const visibility = ['VISIBLE_GATE', 'MENU_VISIBLE_GATE', 'INHERITED_GATE']
    .map((condition) => parseKconfigExpression(condition));
  checkShape('visibility-conditions-v1', 'visibility-expressions', visibility,
    (rows) => rows.every((row) => row.complete === true && row.symbols.length === 1));

  const choice = {
    id: 'choice-golden', symbol: 'CHOICE_GOLDEN', type: 'tristate', optional: true,
    modules: true, options: ['modules'], optionFlags: ['modules'],
    depends: ['CHOICE_GATE'], visibleIf: ['CHOICE_VISIBLE'],
  };
  choice.dependsAst = choice.depends.map((value) => parseKconfigExpression(value));
  choice.promptIf = ['CHOICE_PROMPT'];
  checkShape('choice-metadata-v1', 'choice-shape', choice,
    (row) => row.id && row.type === 'tristate' && row.optional === true && Array.isArray(row.options));
  checkShape('choice-relations-v1', 'choice-relation-shape', choice,
    (row) => row.dependsAst.length === 1 && row.dependsAst[0].complete === true &&
      row.visibleIf.length === 1 && row.promptIf.length === 1);

  const moduleFixture = { options: ['modules'], optionFlags: ['modules'], modules: true };
  checkShape('module-directive-capture-v1', 'module-directive-shape', moduleFixture,
    (row) => row.options.includes('modules') && row.optionFlags.includes('modules'));
  check('module-semantics-v1', 'module-semantics', moduleFixture.modules, true);

  const definitions = [
    { source: 'golden-a.in', location: { file: 'golden-a.in', line: 7 } },
    { source: 'golden-b.in', location: { file: 'golden-b.in', line: 11 } },
  ];
  checkShape('per-definition-provenance-v1', 'definition-provenance', definitions,
    (rows) => rows.length === 2 && rows.every((row) => row.source && row.location?.file && row.location?.line));

  const missing = KCONFIG_PARSER_CAPABILITIES.filter((capability) =>
    !capabilityChecks.has(capability) || capabilityMatrix[capability] !== true);
  return {
    id: 'kconfig-parser-fixture-v1', valid: failures.length === 0 && missing.length === 0,
    failures, cases: 11, capabilityMatrix,
    missingCapabilities: missing,
  };
}

// Kconfig scalar values are deliberately kept alongside their original text.
// The raw form is useful for audit/debug output while the typed form gives the
// browser/Worker evaluator an unambiguous value domain.  Expressions that
// cannot be reduced without a symbol environment remain expressions instead
// of being guessed into a bool/int value.
export function splitKconfigIfClause(raw) {
  const text = String(raw ?? '').trim();
  let quote = false;
  let escaped = false;
  for (let index = 0; index < text.length - 3; index++) {
    const char = text[index];
    if (escaped) { escaped = false; continue; }
    if (char === '\\' && quote) { escaped = true; continue; }
    if (char === '"') { quote = !quote; continue; }
    if (!quote && /\s/.test(char) && text.slice(index).match(/^\s+if\s+/)) {
      const match = text.slice(index).match(/^\s+if\s+(.+)$/);
      if (match) return { value: text.slice(0, index).trim(), condition: match[1].trim() };
    }
  }
  return { value: text, condition: '' };
}

function unquoteKconfigString(raw) {
  const text = String(raw ?? '').trim();
  if (!(text.startsWith('"') && text.endsWith('"') && text.length >= 2)) return text;
  // Kconfig strings use the kconfig lexer, not JSON.  Decode the two escapes
  // that the lexer gives a special meaning while preserving unknown escapes
  // verbatim (for example `\\xNN` is not silently reinterpreted as JSON).
  const body = text.slice(1, -1);
  let value = '';
  for (let index = 0; index < body.length; index += 1) {
    const char = body[index];
    if (char !== '\\' || index + 1 >= body.length) {
      value += char;
      continue;
    }
    const next = body[index + 1];
    if (next === '\\' || next === '"') {
      value += next;
      index += 1;
    } else {
      value += char;
    }
  }
  return value;
}

export function parseKconfigScalar(raw, type = '') {
  const text = String(raw ?? '').trim();
  const normalizedType = String(type || '').trim();
  // A choice/config without a parsed type is an unknown typed value, not an
  // implicit Kconfig string.  Keeping type empty lets the consumer defer to
  // the native evaluator rather than silently narrowing the domain.
  if (!normalizedType) {
    return { type: '', value: text, raw: text, valueKind: 'expression', valid: true, precise: false };
  }
  if (normalizedType === 'string') {
    const value = unquoteKconfigString(text);
    const startsQuoted = text.startsWith('"');
    const endsQuoted = text.endsWith('"');
    return {
      type: normalizedType, value, raw: text,
      valueKind: startsQuoted && endsQuoted ? 'literal' : startsQuoted || endsQuoted ? 'unknown' : 'expression',
      valid: !(startsQuoted !== endsQuoted), precise: !(startsQuoted !== endsQuoted),
    };
  }
  if (normalizedType === 'bool' || normalizedType === 'tristate') {
    if (/^[nmy]$/.test(text)) {
      if (normalizedType === 'bool' && text === 'm') {
        return { type: normalizedType, value: text, raw: text, valueKind: 'unknown', valid: false, precise: false };
      }
      return { type: normalizedType, value: text, raw: text, valueKind: 'literal', valid: true, precise: true };
    }
    return { type: normalizedType, value: text, raw: text, valueKind: 'expression', valid: true, precise: false };
  }
  const numericLiteral = normalizedType === 'hex'
    ? /^[-+]?0x[0-9a-f]+$/i.test(text)
    : /^[-+]?\d+$/.test(text);
  if (numericLiteral) {
    const numeric = normalizedType === 'hex' ? Number.parseInt(text, 16) : Number.parseInt(text, 10);
    // Do not round a value outside JavaScript's safe integer range.  Keeping
    // the exact token as a typed literal lets the shared evaluator compare it
    // with BigInt/decimal implementations without losing information.
    return {
      type: normalizedType, value: Number.isSafeInteger(numeric) ? numeric : text,
      raw: text, valueKind: 'literal', valid: true, precise: Number.isSafeInteger(numeric),
    };
  }
  return { type: normalizedType, value: text, raw: text, valueKind: 'expression', valid: true, precise: false };
}

export function parseKconfigDefault(raw, type = '') {
  const text = String(raw ?? '').trim();
  const { value, condition } = splitKconfigIfClause(text);
  return { ...parseKconfigScalar(value, type), raw: text, condition };
}

function kconfigTokens(raw) {
  const tokens = [];
  let token = '';
  let quote = false;
  let escaped = false;
  for (const char of String(raw ?? '').trim()) {
    if (escaped) { token += char; escaped = false; continue; }
    if (char === '\\' && quote) { token += char; escaped = true; continue; }
    if (char === '"') { token += char; quote = !quote; continue; }
    if (!quote && /\s/.test(char)) {
      if (token) { tokens.push(token); token = ''; }
    } else token += char;
  }
  if (token) tokens.push(token);
  return tokens;
}

export function parseKconfigRange(raw, type = '') {
  const text = String(raw ?? '').trim();
  const { value, condition } = splitKconfigIfClause(text);
  const bounds = kconfigTokens(value);
  const [minimum = '', maximum = ''] = bounds;
  const normalizedType = String(type || '').trim();
  const lower = parseKconfigScalar(minimum, normalizedType);
  const upper = parseKconfigScalar(maximum, normalizedType);
  return {
    type: normalizedType,
    min: lower.value, max: upper.value,
    minRaw: lower.raw, maxRaw: upper.raw,
    minKind: lower.valueKind, maxKind: upper.valueKind,
    raw: text, condition, valid: bounds.length === 2 && lower.valid !== false && upper.valid !== false,
  };
}

// Kconfig expressions are shared by the readable relation builder and every
// compact consumer.  Keep the lexer deliberately small but lossless: symbols,
// quoted literals, comparison/logical operators, parentheses, and unknown
// tokens are all retained.  A caller must not turn `A || B` into two required
// edges; the AST and `alternatives` below make that distinction explicit.
function lexKconfigExpression(raw) {
  const text = String(raw ?? '').trim();
  const tokens = [];
  const unknown = [];
  const isWord = (char) => /[A-Za-z0-9_+@./-]/.test(char);
  for (let index = 0; index < text.length;) {
    const char = text[index];
    if (/\s/.test(char)) { index += 1; continue; }
    if (char === '"') {
      const start = index;
      let value = '';
      let closed = false;
      index += 1;
      while (index < text.length) {
        const next = text[index];
        if (next === '"') { index += 1; closed = true; break; }
        if (next === '\\' && index + 1 < text.length) {
          value += text[index + 1] === '"' || text[index + 1] === '\\' ? text[index + 1] : next;
          if (text[index + 1] !== '"' && text[index + 1] !== '\\') value += text[index + 1];
          index += 2;
          continue;
        }
        value += next;
        index += 1;
      }
      const token = { type: 'string', raw: text.slice(start, index), value, closed };
      tokens.push(token);
      if (!closed) unknown.push(token.raw);
      continue;
    }
    const two = text.slice(index, index + 2);
    if (['&&', '||', '!=', '<=', '>='].includes(two)) {
      tokens.push({ type: 'operator', raw: two, value: two }); index += 2; continue;
    }
    if (['!', '=', '<', '>', '(', ')'].includes(char)) {
      tokens.push({ type: char === '(' || char === ')' ? 'paren' : 'operator', raw: char, value: char });
      index += 1; continue;
    }
    if (isWord(char)) {
      const start = index;
      while (index < text.length && isWord(text[index])) index += 1;
      const value = text.slice(start, index);
      tokens.push({ type: 'word', raw: value, value });
      continue;
    }
    const token = { type: 'unknown', raw: char, value: char };
    tokens.push(token); unknown.push(char); index += 1;
  }
  return { text, tokens, unknown };
}

function foldExpression(kind, values) {
  const rows = values.filter(Boolean);
  if (rows.length === 1) return rows[0];
  return { kind, values: rows };
}

function expressionSymbols(ast, output = new Set()) {
  if (!ast) return output;
  if (ast.kind === 'symbol' && !['n', 'm', 'y'].includes(ast.name)) output.add(ast.name);
  for (const child of ast.values || []) expressionSymbols(child, output);
  if (ast.left) expressionSymbols(ast.left, output);
  if (ast.right) expressionSymbols(ast.right, output);
  if (ast.value && typeof ast.value === 'object') expressionSymbols(ast.value, output);
  return output;
}

function expressionAlternatives(ast) {
  if (!ast) return [];
  if (ast.kind === 'symbol') return [[ast.name]];
  if (ast.kind === 'or') return ast.values.flatMap(expressionAlternatives);
  if (ast.kind === 'and') {
    const symbols = [...expressionSymbols(ast)].sort();
    return symbols.length ? [symbols] : [];
  }
  if (ast.kind === 'compare' || ast.kind === 'not') {
    const symbols = [...expressionSymbols(ast)].sort();
    return symbols.length ? [symbols] : [];
  }
  return [];
}

export function parseKconfigExpression(raw) {
  const lexed = lexKconfigExpression(raw);
  const tokens = lexed.tokens;
  let position = 0;
  let parseError = '';
  const peek = () => tokens[position];
  const consume = () => tokens[position++];
  const primary = () => {
    const token = peek();
    if (!token) { parseError ||= 'missing-expression'; return null; }
    if (token.type === 'paren' && token.value === '(') {
      consume();
      const value = orExpression();
      if (!peek() || peek().value !== ')') parseError ||= 'missing-close-parenthesis';
      else consume();
      return value;
    }
    if (token.type === 'word') {
      consume();
      return ['n', 'm', 'y'].includes(token.value)
        ? { kind: 'literal', value: token.value, raw: token.raw }
        : { kind: 'symbol', name: token.value, raw: token.raw };
    }
    if (token.type === 'string') {
      consume();
      return { kind: 'literal', value: token.value, raw: token.raw, quoted: true };
    }
    parseError ||= token.type === 'unknown' ? `unknown-token:${token.raw}` : `unexpected-token:${token.raw}`;
    consume();
    return { kind: 'unknown', raw: token.raw };
  };
  const unary = () => {
    if (peek()?.value === '!') { consume(); return { kind: 'not', value: unary() }; }
    return primary();
  };
  const compare = () => {
    let left = unary();
    while (['=', '!=', '<', '<=', '>', '>='].includes(peek()?.value)) {
      const operator = consume().value;
      const right = unary();
      left = { kind: 'compare', operator, left, right };
    }
    return left;
  };
  const andExpression = () => {
    const values = [compare()];
    while (peek()?.value === '&&') { consume(); values.push(compare()); }
    return foldExpression('and', values);
  };
  function orExpression() {
    const values = [andExpression()];
    while (peek()?.value === '||') { consume(); values.push(andExpression()); }
    return foldExpression('or', values);
  }
  const ast = orExpression();
  if (position < tokens.length) parseError ||= `trailing-token:${tokens[position].raw}`;
  const complete = Boolean(String(raw ?? '').trim()) && !lexed.unknown.length && !parseError && Boolean(ast);
  const symbols = [...expressionSymbols(ast)].sort();
  return {
    raw: String(raw ?? '').trim(), ast, tokens, symbols,
    alternatives: expressionAlternatives(ast), complete,
    error: complete ? '' : (parseError || (lexed.unknown[0] ? `unknown-token:${lexed.unknown[0]}` : 'incomplete-expression')),
  };
}

export function parseKconfigRelation(raw) {
  const text = String(raw ?? '').trim();
  const { value: targetExpression, condition } = splitKconfigIfClause(text);
  const targetParsed = parseKconfigExpression(targetExpression);
  const conditionParsed = condition ? parseKconfigExpression(condition) : null;
  const target = targetParsed.ast?.kind === 'symbol' ? targetParsed.ast.name : '';
  const complete = Boolean(target && targetParsed.complete && (!condition || conditionParsed?.complete));
  return {
    raw: text, target, targetExpression, condition,
    targetAst: targetParsed.ast, conditionAst: conditionParsed?.ast || null,
    targetSymbols: targetParsed.symbols, conditionSymbols: conditionParsed?.symbols || [],
    alternatives: targetParsed.alternatives, complete,
    error: complete ? '' : targetParsed.error || conditionParsed?.error || 'invalid-relation-target',
  };
}

// A curated package is selectable only when one of the explicitly declared
// package names exists in Kconfig.  The Catalog is intentionally strict:
// packageinfo metadata and implicit core-package fallbacks must never make a
// LuCI application appear selectable by itself.
export function resolvePackageOption(candidate, packageSymbols) {
  if (!candidate || typeof candidate !== 'object' || !Array.isArray(candidate.packages)) return '';
  const candidates = candidate.packages
    .map((name) => String(name || '').trim())
    .filter((name) => /^luci-app-[A-Za-z0-9_.+@-]+$/.test(name));
  return candidates.find((name) => packageSymbols.has(name)) || '';
}

function quoted(line) {
  const match = line.match(/"((?:[^"\\]|\\.)*)"/);
  return match ? match[1].replace(/\\"/g, '"') : '';
}

function expandSource(pattern, topdir, currentDir) {
  let value = pattern
    .replace(/\$\((?:TOPDIR)\)|\$\{?TOPDIR\}?/g, topdir)
    .replace(/\$\((?:INCLUDE_DIR)\)|\$\{?INCLUDE_DIR\}?/g, join(topdir, 'include'))
    .replace(/\$\((?:FEED_CONFIG)\)|\$\{?FEED_CONFIG\}?/g, join(topdir, 'feeds.conf'));
  if (!isAbsolute(value)) value = resolve(currentDir, value);
  if (!/[*?[]/.test(value)) return existsSync(value) ? [value] : [];
  const dir = dirname(value);
  const mask = basename(value).replace(/[.+^${}()|\\]/g, '\\$&')
    .replace(/\*/g, '.*').replace(/\?/g, '.');
  if (!existsSync(dir)) return [];
  const re = new RegExp(`^${mask}$`);
  return readdirSync(dir).filter((name) => re.test(name)).sort().map((name) => join(dir, name));
}

function hasPositiveDependency(expressions, symbol) {
  const visit = (node, negated = false) => {
    if (!node) return false;
    if (node.kind === 'symbol') return node.name === symbol && !negated;
    if (node.kind === 'not') return visit(node.value, !negated);
    if (node.kind === 'compare') {
      if (node.left?.kind === 'symbol' && node.left.name === symbol) {
        if (node.operator === '=' && node.right?.kind === 'literal' && node.right.value === 'n') return false;
        if (node.operator === '!=' && node.right?.kind === 'literal' && node.right.value === 'y') return false;
        return !negated;
      }
      return visit(node.left, negated) || visit(node.right, negated);
    }
    return (node.values || []).some((child) => visit(child, negated));
  };
  return expressions.some((expression) => visit(parseKconfigExpression(expression).ast));
}

function addImplicitMenuParents(options) {
  const menuconfigs = [];
  for (const option of options) {
    let parent = '';
    for (let index = menuconfigs.length - 1; index >= 0; index--) {
      const candidate = menuconfigs[index];
      const sameMenu = candidate.path.every((name, depth) => option.path[depth] === name);
      if (sameMenu && hasPositiveDependency(option.depends, candidate.symbol)) {
        parent = candidate.symbol;
        break;
      }
    }
    if (parent) {
      option.parent = parent;
      for (const node of option.nodes || []) node.parent = parent;
    }
    if (option.kind === 'menuconfig') menuconfigs.push(option);
  }
}

function parsePromptClause(text) {
  const value = String(text || '');
  const match = value.match(/"((?:[^"\\]|\\.)*)"/);
  if (!match) return { prompt: '', condition: '' };
  const prompt = match[1].replace(/\\"/g, '"');
  const suffix = value.slice(match.index + match[0].length).trim();
  const condition = suffix.match(/^if\s+(.+)$/)?.[1]?.trim() || '';
  return { prompt, condition };
}

function selfNegativeDependency(expression, symbol) {
  const visit = (node, negated = false) => {
    if (!node) return false;
    if (node.kind === 'symbol') return node.name === symbol && negated;
    if (node.kind === 'not') return visit(node.value, !negated);
    if (node.kind === 'compare' && node.left?.kind === 'symbol' && node.left.name === symbol) {
      if (node.operator === '=' && node.right?.kind === 'literal' && node.right.value === 'y') return negated;
      if (node.operator === '!=' && node.right?.kind === 'literal' && node.right.value !== 'y') return negated;
      return !negated;
    }
    return (node.values || []).some((child) => visit(child, negated));
  };
  return visit(parseKconfigExpression(expression).ast);
}

/**
 * Diagnose parser output for relations that deserve source review. The check
 * is intentionally syntax-based and generic: it never names a package,
 * source, branch, or target. Findings are high-confidence diagnostics, not a
 * hard gate: unusual upstream constructs still require source-level review.
 */
export function lintKconfigOptions(options = []) {
  const findings = [];
  for (const option of options) {
    const symbol = String(option?.symbol || '').trim();
    if (!symbol) continue;
    const expressions = [...new Set([
      ...(option.depends || []),
      ...(option.directDepends || []),
      ...(option.inheritedDepends || []),
      ...(option.dependsVariants || []).flat(),
    ].map((value) => String(value || '').trim()).filter(Boolean))];
    const negative = expressions.filter((expression) => selfNegativeDependency(expression, symbol));
    if (!negative.length) continue;
    const defaultY = (option.defaults || []).some((value) => /^y(?:\s+if\s+|$)/.test(String(value).trim()));
    findings.push({
      kind: defaultY ? 'default-y-self-negative-dependency' : 'self-negative-dependency',
      symbol,
      expressions: negative,
      defaultY,
    });
  }
  return {
    valid: findings.length === 0,
    findings,
    counts: {
      selfNegativeDependency: findings.filter((item) => item.kind === 'self-negative-dependency').length,
      defaultYSelfNegativeDependency: findings.filter((item) => item.kind === 'default-y-self-negative-dependency').length,
    },
  };
}

function validateParsedKconfigOutput(options = [], choices = []) {
  const rows = [...(Array.isArray(options) ? options : []), ...(Array.isArray(choices) ? choices : [])];
  const all = (predicate) => rows.every(predicate);
  const expressions = rows.flatMap((row) => [
    ...(row.dependsAst || []), ...(row.selectRelations || []), ...(row.implyRelations || []),
  ]);
  const typedDefaults = rows.flatMap((row) => row.defaultsTyped || []);
  const typedRanges = rows.flatMap((row) => row.rangesTyped || []);
  const observed = {
    'kconfig-expression-ast-v1': expressions.length,
    'typed-scalars-v1': typedDefaults.length + typedRanges.length,
    'conditional-defaults-v1': typedDefaults.filter((row) => row?.condition).length,
    'conditional-ranges-v1': typedRanges.filter((row) => row?.condition).length,
    'prompt-visible-menu-conditions-v1': rows.filter((row) =>
      (row.promptIf || []).length || (row.promptConditions || []).length).length,
    'visibility-conditions-v1': rows.filter((row) =>
      (row.visibleIf || []).length || (row.menuVisibleIf || []).length).length,
    'choice-metadata-v1': choices.length,
    'choice-relations-v1': choices.filter((row) => (row.dependsAst || []).length ||
      (row.selectRelations || []).length || (row.implyRelations || []).length).length,
    'module-directive-capture-v1': rows.filter((row) => (row.options || []).includes('modules') ||
      (row.optionFlags || []).includes('modules')).length,
    'module-semantics-v1': rows.filter((row) => row.modules === true).length,
    'per-definition-provenance-v1': (options || []).filter((row) => (row.nodes || []).length > 1).length,
  };
  const capabilityMatrix = {
    'kconfig-expression-ast-v1': expressions.every((row) => row && row.complete === true &&
      (row.ast || row.targetAst)),
    'typed-scalars-v1': [...typedDefaults, ...typedRanges].every((row) => row &&
      typeof row.type === 'string' && typeof row.raw === 'string' && row.valid !== undefined),
    'conditional-defaults-v1': typedDefaults.every((row) => row && typeof row.condition === 'string'),
    'conditional-ranges-v1': typedRanges.every((row) => row && typeof row.condition === 'string'),
    'prompt-visible-menu-conditions-v1': all((row) => Array.isArray(row.promptIf) &&
      Array.isArray(row.promptConditions)),
    'visibility-conditions-v1': all((row) => Array.isArray(row.visibleIf) &&
      Array.isArray(row.menuVisibleIf) && Array.isArray(row.directVisibleIf) &&
      Array.isArray(row.inheritedVisibleIf) && Array.isArray(row.inheritedMenuVisibleIf)),
    'choice-metadata-v1': (choices || []).every((row) => row && typeof row.id === 'string' &&
      typeof row.type === 'string' && typeof row.optional === 'boolean' && Array.isArray(row.options)),
    'choice-relations-v1': (choices || []).every((row) => row && Array.isArray(row.dependsAst) &&
      Array.isArray(row.selectRelations) && Array.isArray(row.implyRelations)),
    'module-directive-capture-v1': all((row) => Array.isArray(row.options) && Array.isArray(row.optionFlags)),
    'module-semantics-v1': all((row) => typeof row.modules === 'boolean'),
    'per-definition-provenance-v1': (options || []).every((row) => Array.isArray(row.nodes) && row.nodes.length > 0 &&
      row.nodes.every((node) => node && typeof node.source === 'string' && node.location?.file && node.location?.line)),
  };
  const missing = KCONFIG_PARSER_CAPABILITIES.filter((capability) => capabilityMatrix[capability] !== true);
  return { valid: missing.length === 0, capabilityMatrix, missing, observed };
}

export function parseKconfigTree(topdir, entry = join(topdir, 'Config.in')) {
  const options = [];
  const choices = [];
  const comments = [];
  const menus = [];
  const unsupportedDirectives = [];
  const structuralErrors = [];
  const missingSources = [];
  const seen = new Set();
  let choiceSeq = 0;
  const supportedDirectives = new Set([
    'config', 'menuconfig', 'mainmenu', 'menu', 'endmenu', 'if', 'endif',
    'choice', 'endchoice', 'source', 'rsource', 'osource', 'orsource',
    'comment', 'bool', 'tristate', 'string', 'int', 'hex', 'prompt',
    'depends', 'visible', 'default', 'def_bool', 'def_tristate', 'select',
    'imply', 'range', 'help', 'optional', 'option', 'modules',
  ]);
  const parserCapabilities = KCONFIG_PARSER_CAPABILITIES;
  const requiredRelationCapabilities = Object.freeze([...KCONFIG_PARSER_CAPABILITIES]);

  function parseFile(file, inheritedPath = [], inheritedDepends = [], inheritedChoice = '', inheritedVisibleIf = [], inheritedMenuVisibleIf = []) {
    file = normalize(file);
    const seenKey = `${file}\0${inheritedPath.join('/')}\0${inheritedDepends.join('&&')}\0${inheritedVisibleIf.join('&&')}\0${inheritedMenuVisibleIf.join('&&')}\0${inheritedChoice}`;
    if (seen.has(seenKey)) return;
    if (!existsSync(file)) {
      missingSources.push({ file: relativeSource(topdir, file), reason: 'missing-source' });
      return;
    }
    seen.add(seenKey);
    const lines = readFileSync(file, 'utf8').replace(/\\\r?\n/g, ' ').replace(/\r\n/g, '\n').split('\n');
    const menuPath = [...inheritedPath];
    const conditions = [...inheritedDepends];
    const visibilityConditions = [...inheritedVisibleIf];
    const menuVisibilityConditions = [...inheritedMenuVisibleIf];
    const choiceStack = inheritedChoice ? [inheritedChoice] : [];
    const ifFrames = [];
    const menuFrames = [];
    const choiceFrames = [];
    let current = null;
    let currentChoice = null;
    let currentComment = null;
    let help = false;
    let helpIndent = -1;
    const indentWidth = (raw) => {
      const prefix = raw.match(/^\s*/)?.[0] || '';
      return [...prefix].reduce((total, char) => total + (char === '\t' ? 8 : 1), 0);
    };
    const recordUnsupported = (text, lineNumber) => {
      const directive = String(text || '').match(/^([a-z][a-z0-9_-]*)\b/)?.[1] || '';
      if (directive && !supportedDirectives.has(directive)) {
        unsupportedDirectives.push({
          file: relativeSource(topdir, file), line: lineNumber, directive, text: String(text || ''),
        });
      }
    };
    const finishComment = () => {
      if (!currentComment) return;
      currentComment.directDepends = [...new Set((currentComment.directDepends || []).filter(Boolean))];
      currentComment.inheritedDepends = [...new Set((currentComment.inheritedDepends || []).filter(Boolean))];
      currentComment.depends = [...new Set([
        ...currentComment.inheritedDepends,
        ...currentComment.directDepends,
      ].filter(Boolean))];
      currentComment.promptIf = [...new Set((currentComment.promptIf || []).filter(Boolean))];
      currentComment.visibleIf = [...new Set((currentComment.visibleIf || []).filter(Boolean))];
      comments.push(currentComment);
      currentComment = null;
    };
    const finish = () => {
      if (!current) return;
      current.directDepends = [...new Set((current.directDepends || []).filter(Boolean))];
      current.inheritedDepends = [...new Set((current.inheritedDepends || []).filter(Boolean))];
      current.depends = [...new Set([
        ...current.inheritedDepends,
        ...current.directDepends,
      ].filter(Boolean))];
      current.promptIf = [...new Set((current.promptIf || []).filter(Boolean))];
      current.promptConditions = [...current.promptIf];
      current.dependsAst = current.depends.map((value) => parseKconfigExpression(value));
      current.selectRelations = current.selects.map((value) => parseKconfigRelation(value));
      current.implyRelations = current.implies.map((value) => parseKconfigRelation(value));
      current.defaultsTyped = (current.defaults || []).map((value) =>
        parseKconfigDefault(value, current.type));
      current.rangesTyped = (current.ranges || []).map((value) =>
        parseKconfigRange(value, current.type));
      current.inheritedVisibleIf = [...new Set((current.inheritedVisibleIf || []).filter(Boolean))];
      current.menuVisibleIf = [...new Set((current.menuVisibleIf || []).filter(Boolean))];
      current.visibleIf = [...new Set([
        ...current.inheritedVisibleIf,
        ...(current.directVisibleIf || []),
      ].filter(Boolean))];
      current.visibility = {
        promptIf: [...current.promptIf],
        menuVisibleIf: [...current.menuVisibleIf],
        effective: [...current.visibleIf],
      };
      if (current.symbol) {
        current.visible = Boolean(current.prompt);
        current.hidden = !current.visible;
        current.userSettable = current.visible;
        options.push(current);
      }
      current = null;
      help = false;
      helpIndent = -1;
    };
    const finishNode = () => {
      finish();
      finishComment();
    };
    const prompt = (node, value) => {
      const parsed = parsePromptClause(value);
      if (parsed.prompt) node.prompt = parsed.prompt;
      if (parsed.condition) node.promptIf.push(parsed.condition);
    };

    for (let index = 0; index < lines.length; index++) {
      const raw = lines[index];
      const line = raw.trim();
      if (!line || line.startsWith('#')) continue;
      if (help && indentWidth(raw) > helpIndent) {
        current.help = `${current.help || ''}${current.help ? '\n' : ''}${line}`;
        continue;
      }
      help = false;
      helpIndent = -1;
      if (/^(config|menuconfig)\s+/.test(line)) {
        finishNode();
        const [, kind, symbol] = line.match(/^(config|menuconfig)\s+(\S+)/);
        current = {
          symbol, kind, type: '', prompt: '', path: [...menuPath],
          depends: [...conditions], directDepends: [], inheritedDepends: [...conditions],
          directVisibleIf: [], inheritedVisibleIf: [...visibilityConditions],
          inheritedMenuVisibleIf: [...menuVisibilityConditions],
          menuVisibleIf: [...menuVisibilityConditions], visibleIf: [],
          promptIf: [], defaults: [], defaultsTyped: [], selects: [], implies: [], ranges: [],
          rangesTyped: [], options: [], optionFlags: [], modules: false,
          choice: choiceStack.at(-1) || '',
          dependsAst: [], selectRelations: [], implyRelations: [],
          source: relativeSource(topdir, file),
          location: { file: relativeSource(topdir, file), line: index + 1 },
        };
        continue;
      }
      if (/^mainmenu\s+"/.test(line)) {
        finishNode();
        continue;
      }
      if (/^menu\s+"/.test(line)) {
        finishNode();
        const label = quoted(line);
        const frame = {
          pathLength: menuPath.length,
          dependsLength: conditions.length,
          visibleLength: visibilityConditions.length,
          menuVisibleLength: menuVisibilityConditions.length,
          directDepends: [],
          directVisibleIf: [],
          prompt: label,
          path: [...menuPath, label],
          source: relativeSource(topdir, file),
          location: { file: relativeSource(topdir, file), line: index + 1 },
        };
        menuFrames.push(frame);
        menuPath.push(label);
        menus.push(frame);
        continue;
      }
      if (/^endmenu\b/.test(line)) {
        finishNode();
        const frame = menuFrames.pop();
        if (!frame) structuralErrors.push({ file: relativeSource(topdir, file), line: index + 1, error: 'unexpected-endmenu' });
        else {
          conditions.length = frame.dependsLength;
          visibilityConditions.length = frame.visibleLength;
          menuVisibilityConditions.length = frame.menuVisibleLength;
          menuPath.length = frame.pathLength;
        }
        continue;
      }
      if (line.startsWith('if ')) {
        finishNode();
        ifFrames.push({ dependsLength: conditions.length });
        conditions.push(line.slice(3).trim());
        continue;
      }
      if (/^endif\b/.test(line)) {
        finishNode();
        const frame = ifFrames.pop();
        if (!frame) structuralErrors.push({ file: relativeSource(topdir, file), line: index + 1, error: 'unexpected-endif' });
        else conditions.length = frame.dependsLength;
        continue;
      }
      if (line === 'choice' || line.startsWith('choice ')) {
        finishNode();
        const id = `choice-${++choiceSeq}`;
        const choiceTail = line.slice('choice'.length).trim();
        const choiceSymbol = choiceTail.match(/^([A-Za-z0-9_]+)(?:\s|$)/)?.[1] || '';
        const choicePrompt = choiceSymbol ? choiceTail.slice(choiceSymbol.length).trim() : choiceTail;
        const choice = {
          id, symbol: choiceSymbol, prompt: parsePromptClause(choicePrompt).prompt,
          type: '', depends: [...conditions], directDepends: [], inheritedDepends: [...conditions],
          promptIf: [], directVisibleIf: [], inheritedVisibleIf: [...visibilityConditions],
          inheritedMenuVisibleIf: [...menuVisibilityConditions],
          visibleIf: [...visibilityConditions], menuVisibleIf: [...menuVisibilityConditions], defaults: [],
          defaultsTyped: [], selects: [], implies: [], options: [], optionFlags: [], modules: false, optional: false,
          ranges: [], rangesTyped: [],
          dependsAst: [], selectRelations: [], implyRelations: [],
          source: relativeSource(topdir, file),
          location: { file: relativeSource(topdir, file), line: index + 1 },
        };
        const initialPrompt = parsePromptClause(choicePrompt);
        if (initialPrompt.condition) choice.promptIf.push(initialPrompt.condition);
        currentChoice = choice;
        choices.push(currentChoice);
        choiceFrames.push({ choice, menuDepth: menuFrames.length,
          dependsLength: conditions.length, visibleLength: visibilityConditions.length,
          menuVisibleLength: menuVisibilityConditions.length });
        choiceStack.push(id);
        continue;
      }
      if (/^endchoice\b/.test(line)) {
        finishNode();
        const frame = choiceFrames.pop();
        if (!frame) structuralErrors.push({ file: relativeSource(topdir, file), line: index + 1, error: 'unexpected-endchoice' });
        else {
          frame.choice.directDepends = [...new Set(frame.choice.directDepends.filter(Boolean))];
          frame.choice.inheritedDepends = [...new Set(frame.choice.inheritedDepends.filter(Boolean))];
          frame.choice.depends = [...new Set([...frame.choice.inheritedDepends, ...frame.choice.directDepends].filter(Boolean))];
          frame.choice.visibleIf = [...new Set([...frame.choice.inheritedVisibleIf, ...frame.choice.directVisibleIf].filter(Boolean))];
          frame.choice.menuVisibleIf = [...frame.choice.inheritedMenuVisibleIf];
          frame.choice.promptConditions = [...frame.choice.promptIf];
          frame.choice.dependsAst = frame.choice.depends.map((value) => parseKconfigExpression(value));
          frame.choice.selectRelations = frame.choice.selects.map((value) => parseKconfigRelation(value));
          frame.choice.implyRelations = frame.choice.implies.map((value) => parseKconfigRelation(value));
          frame.choice.defaultsTyped = (frame.choice.defaults || []).map((value) =>
            parseKconfigDefault(value, frame.choice.type));
          frame.choice.rangesTyped = (frame.choice.ranges || []).map((value) =>
            parseKconfigRange(value, frame.choice.type));
          frame.choice.visibility = {
            promptIf: [...frame.choice.promptIf],
            menuVisibleIf: [...frame.choice.menuVisibleIf],
            effective: [...frame.choice.visibleIf],
          };
          conditions.length = frame.dependsLength;
          visibilityConditions.length = frame.visibleLength;
          menuVisibilityConditions.length = frame.menuVisibleLength;
        }
        choiceStack.pop();
        currentChoice = choiceFrames.at(-1)?.choice || null;
        continue;
      }
      const sourceMatch = line.match(/^((?:o|r|or)?source)\s+"([^"]+)"/);
      if (sourceMatch) {
        finishNode();
        const relativeBase = sourceMatch[1].includes('rsource') ? dirname(file) : topdir;
        const children = expandSource(sourceMatch[2], topdir, relativeBase);
        // `source`/`rsource` are required includes. An empty glob or a missing
        // literal would otherwise make the parser silently publish a partial
        // relation graph. The `o*source` forms are explicitly optional and are
        // allowed to have no matching file.
        if (!children.length && !sourceMatch[1].startsWith('o')) {
          missingSources.push({
            file: relativeSource(topdir, resolve(relativeBase, sourceMatch[2])),
            source: sourceMatch[2], reason: 'missing-source',
          });
        }
        for (const child of children) {
          parseFile(child, menuPath, conditions, choiceStack.at(-1) || '', visibilityConditions, menuVisibilityConditions);
        }
        continue;
      }
      if (line.startsWith('comment ')) {
        finishNode();
        const parsed = parsePromptClause(line.slice('comment'.length));
        currentComment = {
          prompt: parsed.prompt,
          path: [...menuPath],
          directDepends: [],
          inheritedDepends: [...conditions],
          depends: [...conditions],
          promptIf: parsed.condition ? [parsed.condition] : [],
          visibleIf: [...visibilityConditions],
          source: relativeSource(topdir, file),
          location: { file: relativeSource(topdir, file), line: index + 1 },
        };
        continue;
      }
      if (currentComment) {
        if (line.startsWith('depends on ')) currentComment.directDepends.push(line.slice(11).trim());
        else if (line.startsWith('visible if ')) currentComment.visibleIf.push(line.slice(11).trim());
        else if (line.startsWith('prompt ')) {
          const parsed = parsePromptClause(line);
          if (parsed.condition) currentComment.promptIf.push(parsed.condition);
        } else recordUnsupported(line, index + 1);
        continue;
      }
      if (!current && currentChoice && menuFrames.length === (choiceFrames.at(-1)?.menuDepth ?? menuFrames.length)) {
        if (/^(bool|tristate|string|int|hex)\b/.test(line)) {
          currentChoice.type = line.match(/^(\w+)/)[1];
          prompt(currentChoice, line.replace(/^(bool|tristate|string|int|hex)\b/, ''));
        } else if (line.startsWith('prompt ')) prompt(currentChoice, line);
        else if (line.startsWith('depends on ')) {
          const expression = line.slice(11).trim();
          currentChoice.directDepends.push(expression);
          currentChoice.depends.push(expression);
          conditions.push(expression);
        } else if (line.startsWith('visible if ')) {
          const expression = line.slice(11).trim();
          currentChoice.directVisibleIf.push(expression);
          currentChoice.visibleIf.push(expression);
          visibilityConditions.push(expression);
        }
        else if (line.startsWith('default ')) currentChoice.defaults.push(line.slice(8).trim());
        else if (line === 'optional') currentChoice.optional = true;
        else if (line.startsWith('option ')) {
          const option = line.slice(7).trim();
          if (option) {
            currentChoice.options.push(option);
            currentChoice.optionFlags.push(option.split(/[=\s]/, 1)[0]);
            if (option === 'modules' || option.startsWith('modules=')) currentChoice.modules = true;
          }
        } else if (line === 'modules') {
          currentChoice.modules = true;
          currentChoice.optionFlags.push('modules');
        } else recordUnsupported(line, index + 1);
        continue;
      }
      if (!current) {
        if (menuFrames.length && line.startsWith('depends on ')) {
          const expression = line.slice(11).trim();
          menuFrames.at(-1).directDepends.push(expression);
          conditions.push(expression);
        } else if (menuFrames.length && line.startsWith('visible if ')) {
          const expression = line.slice(11).trim();
          menuFrames.at(-1).directVisibleIf.push(expression);
          visibilityConditions.push(expression);
          menuVisibilityConditions.push(expression);
        } else recordUnsupported(line, index + 1);
        continue;
      }
      if (line === 'help' || line === '---help---') {
        help = true;
        helpIndent = indentWidth(raw);
        continue;
      }
      const typeMatch = line.match(/^(bool|tristate|string|int|hex)\b(.*)$/);
      if (typeMatch) {
        current.type = typeMatch[1];
        prompt(current, typeMatch[2]);
      } else if (line.startsWith('prompt ')) prompt(current, line);
      else if (line.startsWith('depends on ')) current.directDepends.push(line.slice(11).trim());
      else if (line.startsWith('visible if ')) current.directVisibleIf.push(line.slice(11).trim());
      else if (line.startsWith('default ')) current.defaults.push(line.slice(8).trim());
      else if (line.startsWith('def_bool ')) {
        current.type ||= 'bool';
        current.defaults.push(line.slice(9).trim());
      } else if (line.startsWith('def_tristate ')) {
        current.type ||= 'tristate';
        current.defaults.push(line.slice(13).trim());
      }
      else if (line.startsWith('select ')) current.selects.push(line.slice(7).trim());
      else if (line.startsWith('imply ')) current.implies.push(line.slice(6).trim());
      else if (line.startsWith('range ')) current.ranges.push(line.slice(6).trim());
      else if (line.startsWith('option ')) {
        const option = line.slice(7).trim();
        if (option) {
          current.options.push(option);
          current.optionFlags.push(option.split(/[=\s]/, 1)[0]);
          if (option === 'modules' || option.startsWith('modules=')) current.modules = true;
        }
      } else if (line === 'modules') {
        current.modules = true;
        current.optionFlags.push('modules');
      } else recordUnsupported(line, index + 1);
    }
    finishNode();
    if (ifFrames.length) structuralErrors.push({ file: relativeSource(topdir, file), error: 'unclosed-if', count: ifFrames.length });
    if (menuFrames.length) structuralErrors.push({ file: relativeSource(topdir, file), error: 'unclosed-menu', count: menuFrames.length });
    if (choiceFrames.length) structuralErrors.push({ file: relativeSource(topdir, file), error: 'unclosed-choice', count: choiceFrames.length });
  }

  parseFile(entry);
  const validation = mergeKconfigOptions(options);
  addImplicitMenuParents(validation.options);
  const semantic = lintKconfigOptions(validation.options);
  const parserFixture = validateKconfigParserFixture();
  const parserOutput = validateParsedKconfigOutput(validation.options, choices);
  const capabilityMatrix = Object.fromEntries(requiredRelationCapabilities.map((capability) => [
    capability, parserFixture.capabilityMatrix?.[capability] === true &&
      parserOutput.capabilityMatrix?.[capability] === true,
  ]));
  const missingRelationCapabilities = requiredRelationCapabilities.filter((capability) =>
    capabilityMatrix[capability] !== true);
  const capabilityMatrixComplete = missingRelationCapabilities.length === 0;
  const parserStructuralErrors = [
    ...structuralErrors,
    ...missingSources,
    ...validation.conflicts.map((row) => ({ ...row, error: 'kconfig-symbol-conflict' })),
  ];
  const parserFixtureValidated = parserFixture.valid && parserOutput.valid;
  const parserComplete = capabilityMatrixComplete && !unsupportedDirectives.length &&
    !parserStructuralErrors.length && parserFixtureValidated;
  const visibleOptions = validation.options.filter((item) => item.visible !== false);
  const categories = [...new Set(visibleOptions.map((item) => item.path[0] || 'Other'))];
  return {
    categories, options: visibleOptions, allOptions: validation.options, choices, comments, menus,
    relationsComplete: parserComplete,
    validation: {
      ...validation, semantic,
      relationsComplete: parserComplete,
      capabilityMatrixComplete,
      roundTripValidated: false,
      parserFixtureValidated,
      parserFixture,
      parserOutput,
      capabilities: parserCapabilities,
      capabilityMatrix,
      unsupportedDirectives,
      structuralErrors: parserStructuralErrors,
      requiredRelationCapabilities,
      missingRelationCapabilities,
    },
  };
}

function relativeSource(topdir, file) {
  const root = normalize(resolve(topdir)).replace(/[\\/]$/, '');
  const value = normalize(resolve(file));
  return value.startsWith(`${root}/`) || value.startsWith(`${root}\\`)
    ? value.slice(root.length + 1).replaceAll('\\', '/')
    : value.replaceAll('\\', '/');
}

function mergeKconfigOptions(rawOptions) {
  const groups = new Map();
  for (const option of rawOptions) {
    const list = groups.get(option.symbol) || [];
    list.push(option);
    groups.set(option.symbol, list);
  }
  const options = [];
  const duplicates = [];
  const conflicts = [];
  const unique = (values) => [...new Set(values.filter((value) => value !== undefined && value !== ''))];
  const uniquePaths = (values) => {
    const seen = new Set();
    return values.filter((path) => {
      const key = path.join('\0');
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  };
  const nodeSnapshot = (node) => ({
    kind: node.kind, type: node.type, symbol: node.symbol, prompt: node.prompt,
    path: [...(node.path || [])], depends: [...(node.depends || [])],
    directDepends: [...(node.directDepends || [])],
    inheritedDepends: [...(node.inheritedDepends || [])],
    directVisibleIf: [...(node.directVisibleIf || [])],
    inheritedVisibleIf: [...(node.inheritedVisibleIf || [])],
    inheritedMenuVisibleIf: [...(node.inheritedMenuVisibleIf || [])],
    visibleIf: [...(node.visibleIf || [])], menuVisibleIf: [...(node.menuVisibleIf || [])],
    promptIf: [...(node.promptIf || [])],
    dependsAst: [...(node.dependsAst || [])],
    selectRelations: [...(node.selectRelations || [])],
    implyRelations: [...(node.implyRelations || [])],
    kconfigConflicts: [...(node.kconfigConflicts || [])],
    packageConflicts: [...(node.packageConflicts || [])],
    defaults: [...(node.defaults || [])], defaultsTyped: [...(node.defaultsTyped || [])],
    selects: [...(node.selects || [])], implies: [...(node.implies || [])],
    ranges: [...(node.ranges || [])], rangesTyped: [...(node.rangesTyped || [])],
    options: [...(node.options || [])], optionFlags: [...(node.optionFlags || [])],
    modules: node.modules === true, optional: node.optional === true,
    choice: node.choice || '', parent: node.parent || '', help: node.help || '', source: node.source || '',
    location: node.location || null,
  });
  for (const [symbol, nodes] of groups) {
    const first = nodes[0];
    const snapshots = nodes.map(nodeSnapshot);
    const paths = uniquePaths(nodes.flatMap((node) => [node.path || []]));
    const prompts = unique(nodes.map((node) => node.prompt));
    const helps = unique(nodes.map((node) => node.help));
    const kinds = unique(nodes.map((node) => node.kind));
    const types = unique(nodes.map((node) => node.type));
    const choicesForSymbol = unique(nodes.map((node) => node.choice));
    const variants = [];
    if (kinds.length > 1) variants.push({ field: 'kind', values: kinds });
    if (prompts.length > 1) variants.push({ field: 'prompt', values: prompts });
    if (choicesForSymbol.length > 1) variants.push({ field: 'choice', values: choicesForSymbol });
    const symbolConflicts = types.length > 1 ? [{ field: 'type', values: types }] : [];
    const merged = {
      ...first,
      // An omitted type is meaningful for choices and for definitions whose
      // type is supplied by another native Kconfig declaration.  Do not turn
      // an unknown source value into an invented bool domain.
      type: types[0] || '',
      path: paths[0] || [],
      paths,
      nodes: snapshots,
      locations: nodes.map((node) => node.location).filter(Boolean),
      sources: unique(nodes.map((node) => node.source)),
      prompts,
      helps,
      // Keep the first definition's semantics for existing consumers. Every
      // other definition is retained in the node/variant arrays below instead
      // of incorrectly turning conditional alternatives into one AND clause.
      depends: [...(first.depends || [])],
      directDepends: [...(first.directDepends || [])],
      inheritedDepends: [...(first.inheritedDepends || [])],
      directVisibleIf: [...(first.directVisibleIf || [])],
      inheritedVisibleIf: [...(first.inheritedVisibleIf || [])],
      inheritedMenuVisibleIf: [...(first.inheritedMenuVisibleIf || [])],
      visibleIf: [...(first.visibleIf || [])],
      menuVisibleIf: [...(first.menuVisibleIf || [])],
      promptIf: [...(first.promptIf || [])],
      promptConditions: [...(first.promptConditions || first.promptIf || [])],
      dependsAst: [...(first.dependsAst || [])],
      selectRelations: nodes.flatMap((node) => node.selectRelations || []),
      implyRelations: nodes.flatMap((node) => node.implyRelations || []),
      defaults: unique(nodes.flatMap((node) => node.defaults || [])),
      defaultsTyped: nodes.flatMap((node) => node.defaultsTyped || []),
      selects: unique(nodes.flatMap((node) => node.selects || [])),
      implies: unique(nodes.flatMap((node) => node.implies || [])),
      ranges: unique(nodes.flatMap((node) => node.ranges || [])),
      rangesTyped: nodes.flatMap((node) => node.rangesTyped || []),
      options: unique(nodes.flatMap((node) => node.options || [])),
      optionFlags: unique(nodes.flatMap((node) => node.optionFlags || [])),
      modules: nodes.some((node) => node.modules === true),
      optional: nodes.some((node) => node.optional === true),
      // Kconfig definition/type conflicts are not package metadata conflicts.
      // Keep the namespaces separate so a consumer cannot mistake one for
      // the other when resolving a package capability.
      kconfigConflicts: symbolConflicts,
      packageConflicts: [],
      variants,
      dependsVariants: nodes.map((node) => [...(node.depends || [])]),
      dependsAstVariants: nodes.map((node) => [...(node.dependsAst || [])]),
      directDependsVariants: nodes.map((node) => [...(node.directDepends || [])]),
      inheritedDependsVariants: nodes.map((node) => [...(node.inheritedDepends || [])]),
      visibleIfVariants: nodes.map((node) => [...(node.visibleIf || [])]),
      menuVisibleIfVariants: nodes.map((node) => [...(node.menuVisibleIf || [])]),
      promptIfVariants: nodes.map((node) => [...(node.promptIf || [])]),
      defaultsVariants: nodes.map((node) => [...(node.defaults || [])]),
      defaultsTypedVariants: nodes.map((node) => [...(node.defaultsTyped || [])]),
      selectsVariants: nodes.map((node) => [...(node.selects || [])]),
      selectRelationsVariants: nodes.map((node) => [...(node.selectRelations || [])]),
      impliesVariants: nodes.map((node) => [...(node.implies || [])]),
      implyRelationsVariants: nodes.map((node) => [...(node.implyRelations || [])]),
      rangesVariants: nodes.map((node) => [...(node.ranges || [])]),
      rangesTypedVariants: nodes.map((node) => [...(node.rangesTyped || [])]),
      optionsVariants: nodes.map((node) => [...(node.options || [])]),
      optionFlagsVariants: nodes.map((node) => [...(node.optionFlags || [])]),
      modulesVariants: nodes.map((node) => node.modules === true),
      optionalVariants: nodes.map((node) => node.optional === true),
    };
    if (nodes.length > 1) duplicates.push({
      symbol, count: nodes.length, paths, locations: merged.locations,
      sources: merged.sources, conflicts: symbolConflicts, variants,
    });
    if (symbolConflicts.length) conflicts.push({ symbol, count: nodes.length, conflicts: symbolConflicts });
    options.push(merged);
  }
  return {
    options,
    duplicates,
    conflicts,
    duplicateCount: duplicates.reduce((sum, item) => sum + item.count - 1, 0),
  };
}

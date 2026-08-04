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
  for (const expression of expressions) {
    const tokens = String(expression).match(/\|\||&&|!=|=|!|\(|\)|"[^"]*"|[A-Za-z0-9_+./-]+/g) || [];
    for (let index = 0; index < tokens.length; index++) {
      if (tokens[index] !== symbol || tokens[index - 1] === '!') continue;
      if (tokens[index + 1] === '!=') continue;
      if (tokens[index + 1] === '=' && tokens[index + 2] === 'n') continue;
      return true;
    }
  }
  return false;
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
    if (parent) option.parent = parent;
    if (option.kind === 'menuconfig') menuconfigs.push(option);
  }
}

export function parseKconfigTree(topdir, entry = join(topdir, 'Config.in')) {
  const options = [];
  const choices = [];
  const seen = new Set();
  let choiceSeq = 0;

  function parseFile(file, inheritedPath = [], inheritedDepends = [], inheritedChoice = '') {
    file = normalize(file);
    const seenKey = `${file}\0${inheritedPath.join('/')}\0${inheritedDepends.join('&&')}`;
    if (seen.has(seenKey) || !existsSync(file)) return;
    seen.add(seenKey);
    const lines = readFileSync(file, 'utf8').replace(/\\\r?\n/g, ' ').replace(/\r\n/g, '\n').split('\n');
    const menuPath = [...inheritedPath];
    const conditions = [...inheritedDepends];
    const choiceStack = inheritedChoice ? [inheritedChoice] : [];
    let current = null;
    let currentChoice = null;
    let help = false;
    let helpIndent = -1;
    const indentWidth = (raw) => {
      const prefix = raw.match(/^\s*/)?.[0] || '';
      return [...prefix].reduce((total, char) => total + (char === '\t' ? 8 : 1), 0);
    };
    const finish = () => {
      if (!current) return;
      current.depends = [...new Set(current.depends.filter(Boolean))];
      if (current.prompt && current.symbol) options.push(current);
      current = null;
      help = false;
      helpIndent = -1;
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
        finish();
        const [, kind, symbol] = line.match(/^(config|menuconfig)\s+(\S+)/);
        current = {
          symbol, kind, type: '', prompt: '', path: [...menuPath],
          depends: [...conditions], defaults: [], selects: [], implies: [], ranges: [],
          choice: choiceStack.at(-1) || '',
          source: relativeSource(topdir, file),
          location: { file: relativeSource(topdir, file), line: index + 1 },
        };
        continue;
      }
      if (/^mainmenu\s+"/.test(line)) {
        finish();
        continue;
      }
      if (/^menu\s+"/.test(line)) {
        finish();
        menuPath.push(quoted(line));
        continue;
      }
      if (line === 'endmenu') {
        finish();
        if (menuPath.length > inheritedPath.length) menuPath.pop();
        continue;
      }
      if (line.startsWith('if ')) {
        finish();
        conditions.push(line.slice(3).trim());
        continue;
      }
      if (line === 'endif') {
        finish();
        if (conditions.length > inheritedDepends.length) conditions.pop();
        continue;
      }
      if (line === 'choice' || line.startsWith('choice ')) {
        finish();
        const id = `choice-${++choiceSeq}`;
        currentChoice = { id, prompt: '', type: 'bool', depends: [...conditions], defaults: [] };
        choices.push(currentChoice);
        choiceStack.push(id);
        continue;
      }
      if (line === 'endchoice') {
        finish();
        choiceStack.pop();
        currentChoice = null;
        continue;
      }
      const sourceMatch = line.match(/^((?:o|r|or)?source)\s+"([^"]+)"/);
      if (sourceMatch) {
        finish();
        const relativeBase = sourceMatch[1].includes('rsource') ? dirname(file) : topdir;
        for (const child of expandSource(sourceMatch[2], topdir, relativeBase)) {
          parseFile(child, menuPath, conditions, choiceStack.at(-1) || '');
        }
        continue;
      }
      if (!current && currentChoice) {
        if (/^(bool|tristate|string|int|hex)\b/.test(line)) {
          currentChoice.type = line.match(/^(\w+)/)[1];
          currentChoice.prompt ||= quoted(line);
        } else if (line.startsWith('prompt ')) currentChoice.prompt = quoted(line);
        else if (line.startsWith('depends on ')) currentChoice.depends.push(line.slice(11).trim());
        else if (line.startsWith('default ')) currentChoice.defaults.push(line.slice(8).trim());
        continue;
      }
      if (!current) continue;
      if (line === 'help' || line === '---help---') {
        help = true;
        helpIndent = indentWidth(raw);
        continue;
      }
      const typeMatch = line.match(/^(bool|tristate|string|int|hex)\b(.*)$/);
      if (typeMatch) {
        current.type = typeMatch[1];
        current.prompt ||= quoted(typeMatch[2]);
      } else if (line.startsWith('prompt ')) current.prompt = quoted(line);
      else if (line.startsWith('depends on ')) current.depends.push(line.slice(11).trim());
      else if (line.startsWith('visible if ')) current.depends.push(line.slice(11).trim());
      else if (line.startsWith('default ')) current.defaults.push(line.slice(8).trim());
      else if (line.startsWith('select ')) current.selects.push(line.slice(7).trim());
      else if (line.startsWith('imply ')) current.implies.push(line.slice(6).trim());
      else if (line.startsWith('range ')) current.ranges.push(line.slice(6).trim());
    }
    finish();
  }

  parseFile(entry);
  const validation = mergeKconfigOptions(options);
  addImplicitMenuParents(validation.options);
  const categories = [...new Set(validation.options.map((item) => item.path[0] || 'Other'))];
  return { categories, options: validation.options, choices, validation };
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
    defaults: [...(node.defaults || [])], selects: [...(node.selects || [])],
    implies: [...(node.implies || [])], ranges: [...(node.ranges || [])],
    choice: node.choice || '', help: node.help || '', source: node.source || '',
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
      type: types[0] || 'bool',
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
      defaults: unique(nodes.flatMap((node) => node.defaults || [])),
      selects: unique(nodes.flatMap((node) => node.selects || [])),
      implies: unique(nodes.flatMap((node) => node.implies || [])),
      ranges: unique(nodes.flatMap((node) => node.ranges || [])),
      conflicts: symbolConflicts,
      variants,
      dependsVariants: nodes.map((node) => [...(node.depends || [])]),
      defaultsVariants: nodes.map((node) => [...(node.defaults || [])]),
      selectsVariants: nodes.map((node) => [...(node.selects || [])]),
      impliesVariants: nodes.map((node) => [...(node.implies || [])]),
      rangesVariants: nodes.map((node) => [...(node.ranges || [])]),
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

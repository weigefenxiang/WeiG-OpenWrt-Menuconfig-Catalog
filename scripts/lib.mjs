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
  const tokens = String(expression || '').match(/\|\||&&|!=|=|!|\(|\)|"[^"\\]*(?:\\.[^"\\]*)*"|[A-Za-z0-9_+./@-]+/g) || [];
  for (let index = 0; index < tokens.length; index++) {
    if (tokens[index] !== symbol) continue;
    const previous = tokens[index - 1] || '';
    const next = tokens[index + 1] || '';
    const value = tokens[index + 2] || '';
    if (previous === '!' || (next === '=' && value !== 'y') || (next === '!=' && value === 'y')) {
      return true;
    }
  }
  return false;
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

export function parseKconfigTree(topdir, entry = join(topdir, 'Config.in')) {
  const options = [];
  const choices = [];
  const comments = [];
  const menus = [];
  const seen = new Set();
  let choiceSeq = 0;

  function parseFile(file, inheritedPath = [], inheritedDepends = [], inheritedChoice = '', inheritedVisibleIf = [], inheritedMenuVisibleIf = []) {
    file = normalize(file);
    const seenKey = `${file}\0${inheritedPath.join('/')}\0${inheritedDepends.join('&&')}\0${inheritedVisibleIf.join('&&')}\0${inheritedMenuVisibleIf.join('&&')}\0${inheritedChoice}`;
    if (seen.has(seenKey) || !existsSync(file)) return;
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
          promptIf: [], defaults: [], selects: [], implies: [], ranges: [],
          choice: choiceStack.at(-1) || '',
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
        if (frame) {
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
        if (frame) conditions.length = frame.dependsLength;
        continue;
      }
      if (line === 'choice' || line.startsWith('choice ')) {
        finishNode();
        const id = `choice-${++choiceSeq}`;
        const choice = {
          id, prompt: parsePromptClause(line.slice('choice'.length)).prompt,
          type: 'bool', depends: [...conditions], directDepends: [], inheritedDepends: [...conditions],
          promptIf: [], directVisibleIf: [], inheritedVisibleIf: [...visibilityConditions],
          inheritedMenuVisibleIf: [...menuVisibilityConditions],
          visibleIf: [...visibilityConditions], menuVisibleIf: [...menuVisibilityConditions], defaults: [],
          source: relativeSource(topdir, file),
          location: { file: relativeSource(topdir, file), line: index + 1 },
        };
        const initialPrompt = parsePromptClause(line.slice('choice'.length));
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
        if (frame) {
          frame.choice.directDepends = [...new Set(frame.choice.directDepends.filter(Boolean))];
          frame.choice.inheritedDepends = [...new Set(frame.choice.inheritedDepends.filter(Boolean))];
          frame.choice.depends = [...new Set([...frame.choice.inheritedDepends, ...frame.choice.directDepends].filter(Boolean))];
          frame.choice.visibleIf = [...new Set([...frame.choice.inheritedVisibleIf, ...frame.choice.directVisibleIf].filter(Boolean))];
          frame.choice.menuVisibleIf = [...frame.choice.inheritedMenuVisibleIf];
          frame.choice.promptConditions = [...frame.choice.promptIf];
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
        for (const child of expandSource(sourceMatch[2], topdir, relativeBase)) {
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
        }
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
        }
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
    }
    finishNode();
  }

  parseFile(entry);
  const validation = mergeKconfigOptions(options);
  addImplicitMenuParents(validation.options);
  const semantic = lintKconfigOptions(validation.options);
  const visibleOptions = validation.options.filter((item) => item.visible !== false);
  const categories = [...new Set(visibleOptions.map((item) => item.path[0] || 'Other'))];
  return {
    categories, options: visibleOptions, allOptions: validation.options, choices, comments, menus,
    validation: { ...validation, semantic },
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
      directDepends: [...(first.directDepends || [])],
      inheritedDepends: [...(first.inheritedDepends || [])],
      directVisibleIf: [...(first.directVisibleIf || [])],
      inheritedVisibleIf: [...(first.inheritedVisibleIf || [])],
      inheritedMenuVisibleIf: [...(first.inheritedMenuVisibleIf || [])],
      visibleIf: [...(first.visibleIf || [])],
      menuVisibleIf: [...(first.menuVisibleIf || [])],
      promptIf: [...(first.promptIf || [])],
      promptConditions: [...(first.promptConditions || first.promptIf || [])],
      defaults: unique(nodes.flatMap((node) => node.defaults || [])),
      selects: unique(nodes.flatMap((node) => node.selects || [])),
      implies: unique(nodes.flatMap((node) => node.implies || [])),
      ranges: unique(nodes.flatMap((node) => node.ranges || [])),
      conflicts: symbolConflicts,
      variants,
      dependsVariants: nodes.map((node) => [...(node.depends || [])]),
      directDependsVariants: nodes.map((node) => [...(node.directDepends || [])]),
      inheritedDependsVariants: nodes.map((node) => [...(node.inheritedDepends || [])]),
      visibleIfVariants: nodes.map((node) => [...(node.visibleIf || [])]),
      menuVisibleIfVariants: nodes.map((node) => [...(node.menuVisibleIf || [])]),
      promptIfVariants: nodes.map((node) => [...(node.promptIf || [])]),
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

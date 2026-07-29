import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, normalize, resolve } from 'node:path';

export const safeSlug = (value) => String(value).toLowerCase()
  .replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'item';

export function parseInfoRecords(text) {
  const targets = [];
  let target = null;
  let profile = null;
  const finishProfile = () => {
    if (profile && target) target.profiles.push(profile);
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
      const [board, subtarget = 'generic'] = value.split('/');
      target = {
        id: value, board, subtarget, name: value, subtargetName: subtarget,
        archPackages: board, features: [], packages: [], profiles: [],
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
      else if (field === 'Packages') profile.packages = value.split(/\s+/).filter(Boolean);
      else if (field === 'Default') profile.default = value;
      else if (field === 'Description') profile.description = value;
      continue;
    }
    if (key === 'Target-Name') target.name = value;
    else if (key === 'Target-Subtarget-Name') target.subtargetName = value;
    else if (key === 'Target-Arch-Packages') target.archPackages = value;
    else if (key === 'Target-Features') target.features = value.split(/\s+/).filter(Boolean);
    else if (key === 'Target-Packages') target.packages = value.split(/\s+/).filter(Boolean);
  }
  finishTarget();
  return targets;
}

export function parsePackageInfo(text) {
  const packages = [];
  let item = null;
  const finish = () => {
    if (item?.name) packages.push(item);
    item = null;
  };
  for (const raw of text.replace(/\r\n/g, '\n').split('\n')) {
    const match = raw.match(/^([A-Za-z][A-Za-z0-9-]*):\s*(.*)$/);
    if (!match) continue;
    const [, key, value] = match;
    if (key === 'Package') {
      finish();
      item = { name: value, title: value, category: 'Other', submenu: '', depends: [], provides: [] };
      continue;
    }
    if (!item) continue;
    if (key === 'Title') item.title = value;
    else if (key === 'Category') item.category = value || 'Other';
    else if (key === 'Submenu') item.submenu = value;
    else if (key === 'Depends') item.depends = value.split(/\s+/).filter(Boolean);
    else if (key === 'Provides') item.provides = value.split(/\s+/).filter(Boolean);
    else if (key === 'Menu-Depends') item.menuDepends = value;
    else if (key === 'Architecture') item.architecture = value;
  }
  finish();
  return packages;
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
    const finish = () => {
      if (!current) return;
      current.depends = [...new Set(current.depends.filter(Boolean))];
      if (current.prompt && current.symbol) options.push(current);
      current = null;
      help = false;
    };

    for (let index = 0; index < lines.length; index++) {
      const raw = lines[index];
      const line = raw.trim();
      if (!line || line.startsWith('#')) continue;
      if (/^(config|menuconfig)\s+/.test(line)) {
        finish();
        const [, kind, symbol] = line.match(/^(config|menuconfig)\s+(\S+)/);
        current = {
          symbol, kind, type: 'bool', prompt: '', path: [...menuPath],
          depends: [...conditions], defaults: [], selects: [], implies: [], ranges: [],
          choice: choiceStack.at(-1) || '',
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
        continue;
      }
      if (help && /^\s/.test(raw) && !/^\s*(depends on|default|select|imply|range|prompt)\b/.test(raw)) {
        const text = line;
        if (text) current.help = `${current.help || ''}${current.help ? '\n' : ''}${text}`;
        continue;
      }
      help = false;
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
  const categories = [...new Set(options.map((item) => item.path[0] || 'Other'))];
  return { categories, options, choices };
}

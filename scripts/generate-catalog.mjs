#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { gzipSync } from 'node:zlib';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseInfoRecords, parseKconfigTree, parsePackageInfo, safeSlug } from './lib.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = {};
for (let i = 2; i < process.argv.length; i += 2) args[process.argv[i].replace(/^--/, '')] = process.argv[i + 1];
for (const key of ['source-id', 'repo', 'branch', 'tree']) {
  if (!args[key]) throw new Error(`缺少 --${key}`);
}
const tree = resolve(args.tree);
const outDir = resolve(args.out || join(ROOT, 'dist'));
const targetInfo = join(tree, 'tmp', '.targetinfo');
const packageInfo = join(tree, 'tmp', '.packageinfo');
const targets = parseInfoRecords(readFileSync(targetInfo, 'utf8'));
const packages = parsePackageInfo(readFileSync(packageInfo, 'utf8'));
const menu = parseKconfigTree(tree);
if (!targets.length || !menu.options.length) {
  throw new Error(`目录异常:targets=${targets.length},menu options=${menu.options.length}`);
}
const targetSymbols = new Set(['TARGET_BOARD', 'TARGET_SUBTARGET', 'TARGET_PROFILE']);
for (const target of targets) {
  targetSymbols.add(`TARGET_${target.board}`);
  targetSymbols.add(`TARGET_${target.board}_${target.subtarget}`);
  for (const profile of target.profiles) {
    targetSymbols.add(`TARGET_${target.board}_${target.subtarget}_${profile.id}`);
  }
}
const menuOptions = menu.options.filter((option) =>
  option.path[0] !== 'Target Devices' && !targetSymbols.has(option.symbol));
const choiceIds = new Set(menuOptions.map((option) => option.choice).filter(Boolean));
const compactMenu = {
  categories: menu.categories.filter((name) => name !== 'Target Devices'),
  options: menuOptions,
  choices: menu.choices.filter((choice) => choiceIds.has(choice.id)),
};
let commit = '';
try { commit = execFileSync('git', ['-C', tree, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(); } catch {}
const payload = {
  schema: 1,
  generatedAt: new Date().toISOString(),
  source: {
    id: args['source-id'], label: args.label || args['source-id'],
    repo: args.repo, branch: args.branch,
    commit, legacy: args.legacy === 'true',
  },
  counts: { targets: targets.length, profiles: targets.reduce((n, item) => n + item.profiles.length, 0),
    menuOptions: compactMenu.options.length, packages: packages.length },
  targets,
  menu: compactMenu,
};
const json = JSON.stringify(payload);
const slug = `${safeSlug(args['source-id'])}--${safeSlug(args.branch)}`;
mkdirSync(outDir, { recursive: true });
const asset = `${slug}.json.gz`;
writeFileSync(join(outDir, asset), gzipSync(Buffer.from(json), { level: 9 }));
writeFileSync(join(outDir, `${slug}.meta.json`), JSON.stringify({
  source: payload.source, counts: payload.counts, asset,
  generatedAt: payload.generatedAt,
  sha256: createHash('sha256').update(json).digest('hex'),
}, null, 2) + '\n');
console.log(`${asset}: ${targets.length} targets / ${payload.counts.profiles} profiles / ${compactMenu.options.length} menu options / ${packages.length} packages`);

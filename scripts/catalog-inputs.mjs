import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { sourceEnvironment, sourceAllowsBranch } from './source-policy.mjs';

// This is an execution-input receipt, not another package dependency database.
export function catalogInputsHash(inputs) {
  return createHash('sha256').update(JSON.stringify(inputs)).digest('hex');
}

export function captureCatalogInputs(tree, runtime = null) {
  const git = (directory, ...args) => execFileSync('git', ['-C', directory, ...args],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const sourceCommit = git(tree, 'rev-parse', 'HEAD');
  const config = join(tree, existsSync(join(tree, 'feeds.conf')) ? 'feeds.conf' : 'feeds.conf.default');
  const seen = new Set();
  const feeds = readFileSync(config, 'utf8').split(/\r?\n/).flatMap((line) => {
    const declaration = line.replace(/\s*#.*$/, '').trim();
    if (!declaration) return [];
    const match = /^(src-git(?:-full)?)((?:\s+--[\w-]+(?:=[\w.-]+)?)*)\s+(\w+)\s+(https?:\/\/[^\s]+)$/.exec(declaration);
    if (!match) throw new Error(`Catalog cannot lock this feed declaration: ${declaration.split(/\s+/).slice(0, 2).join(' ')}`);
    const [, method, flags, name, declaredUrl] = match;
    if (seen.has(name)) throw new Error(`Duplicate feed: ${name}`);
    seen.add(name);
    const url = declaredUrl.split(/[;^]/)[0];
    const parsed = new URL(url);
    if (parsed.username || parsed.password || /['"`\\]/.test(url)) throw new Error(`Unsafe feed URL: ${name}`);
    const directory = join(tree, 'feeds', name);
    const commit = git(directory, 'rev-parse', 'HEAD');
    if (!/^[a-f0-9]{40}$/.test(commit)) throw new Error(`Feed has no exact commit: ${name}`);
    // Generated untracked indices are harmless; modified tracked recipes are not reproducible.
    if (git(directory, 'status', '--porcelain', '--untracked-files=no')) {
      throw new Error(`Feed has modified tracked inputs: ${name}`);
    }
    return [{ name, method, options: flags.trim() ? flags.trim().split(/\s+/) : [], url, commit }];
  });
  if (runtime && (runtime.outcome !== 'success' || runtime.feeds?.length !== feeds.length ||
      feeds.some((feed, i) => runtime.feeds[i]?.name !== feed.name ||
        runtime.feeds[i]?.status !== 'success' || runtime.feeds[i]?.commit !== feed.commit))) {
    throw new Error('Catalog feeds do not match the completed bootstrap receipt');
  }
  return { schema: 1, sourceCommit, feeds };
}

export function applyEnvironmentFeeds(text, environment) {
  const replacements = new Map((environment.feeds || []).map(row => [row.name, row]));
  const lines = text.split(/\r?\n/).map(line => {
    const match = /^(src-git(?:-full)?(?:\s+--[\w-]+(?:=[\w.-]+)?)*)\s+(\w+)\s+(\S+)(.*)$/.exec(line);
    const feed = replacements.get(match?.[2]);
    if (!feed) return line;
    if (match[3].split(/[;^]/)[0].replace(/\.git$/, '') !== 'https://github.com/' + feed.repo) {
      throw new Error('Source environment feed repository mismatch: ' + feed.name);
    }
    replacements.delete(feed.name);
    return match[1] + ' ' + feed.name + ' https://github.com/' + feed.repo + '.git;' + feed.ref;
  });
  if (replacements.size) throw new Error('Source environment feed is not active: ' + [...replacements.keys()].join(', '));
  return lines.join('\n');
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [mode, repo, key, tree] = process.argv.slice(2);
  const policy = JSON.parse(readFileSync(fileURLToPath(new URL('../catalog.config.json', import.meta.url)), 'utf8'));
  const source = policy.sources.find(row => 'https://github.com/' + row.repo === repo.replace(/\.git$/, ''));
  const environment = sourceEnvironment(source, key);
  if (source && !sourceAllowsBranch(source, key)) throw new Error('Source environment is outside reviewed policy');
  if (mode === 'source-ref') console.log(environment.branch);
  else if (mode === 'apply-profile') {
    if (environment.feeds.length) {
      const original = join(tree, existsSync(join(tree, 'feeds.conf')) ? 'feeds.conf' : 'feeds.conf.default');
      writeFileSync(join(tree, 'feeds.conf'), applyEnvironmentFeeds(readFileSync(original, 'utf8'), environment));
    }
  } else throw new Error('Unknown source environment command');
}

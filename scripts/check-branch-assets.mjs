#!/usr/bin/env node
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { decodeCompactRelationTables } from './relation-table-codec.mjs';
import { captureCatalogInputs, catalogInputsHash, applyEnvironmentFeeds } from './catalog-inputs.mjs';
import { indexedTranslationCatalogs, readIndexedTranslationCatalog, menuLanguagePayload } from './translation-catalog-assets.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const feedInput = 'src-git packages https://github.com/example/packages.git\n#src-git luci https://github.com/coolsnowwolf/luci.git;master\nsrc-git luci https://github.com/coolsnowwolf/luci.git;openwrt-25.12\n';
const environment = { feeds: [{ name: 'luci', repo: 'coolsnowwolf/luci', ref: 'openwrt-24.10' }] };
assert.match(applyEnvironmentFeeds(feedInput, environment), /luci.git;openwrt-24.10/);
assert(applyEnvironmentFeeds(feedInput, environment).includes('packages https://github.com/example/packages.git'));
assert.throws(() => applyEnvironmentFeeds(feedInput, { feeds: [{ ...environment.feeds[0], repo: 'other/luci' }] }), /mismatch/);
const output = mkdtempSync(join(tmpdir(), 'weig-branch-assets-'));
const fixture = join(ROOT, 'tests', 'fixture');
const tree = join(output, 'tree');

try {
  mkdirSync(join(tree, 'tmp'), { recursive: true });
  writeFileSync(join(tree, 'Config.in'), readFileSync(join(fixture, 'Config.in'), 'utf8') +
    '\nconfig PACKAGE_luci-app-demo_INCLUDE_payload\n\tbool "Optional data"\n' +
    '\nconfig PACKAGE_luci-app-symbol-only\n\ttristate "Not an installable package"\n');
  copyFileSync(join(fixture, 'targetinfo'), join(tree, 'tmp', '.targetinfo'));
  copyFileSync(join(fixture, 'packageinfo'), join(tree, 'tmp', '.packageinfo'));
  const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const initialize = directory => {
    git(directory, 'init');
    git(directory, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--allow-empty', '-m', 'Fixture inputs');
  };
  initialize(tree);
  const feedTree = join(tree, 'feeds', 'packages');
  mkdirSync(feedTree, { recursive: true });
  initialize(feedTree);
  const feedCommit = git(feedTree, 'rev-parse', 'HEAD');
  writeFileSync(join(tree, 'feeds.conf'), 'src-git --force packages https://example.invalid/packages.git;stable\n');
  const receipt = { outcome: 'success', feeds: [{ name: 'packages', status: 'success', commit: feedCommit }] };
  const receiptPath = join(output, 'feeds-runtime.json');
  writeFileSync(receiptPath, JSON.stringify(receipt));
  const inputs = captureCatalogInputs(tree, receipt);
  assert.equal(inputs.feeds[0].url, 'https://example.invalid/packages.git');
  assert.deepEqual(inputs.feeds[0].options, ['--force']);
  assert.throws(() => captureCatalogInputs(tree, { ...receipt, outcome: 'failure' }), /receipt/);
  assert.throws(() => captureCatalogInputs(tree, { ...receipt, feeds: [] }), /receipt/);
  execFileSync(process.execPath, [
    join(ROOT, 'scripts', 'generate-catalog.mjs'),
    '--source-id', 'Fixture',
    '--label', 'Fixture',
    '--repo', 'example/fixture',
    '--branch', 'test',
    '--default-branch', 'test',
    '--legacy', 'false',
    '--tree', tree,
    '--feeds-runtime', receiptPath,
    '--out', output,
  ], { stdio: ['ignore', 'pipe', 'pipe'] });

  const readGzipJson = (name) => JSON.parse(gunzipSync(readFileSync(join(output, name))).toString('utf8'));
  const core = readGzipJson('fixture--test.core.json.gz');
  const meta = JSON.parse(readFileSync(join(output, 'fixture--test.meta.json'), 'utf8'));
  assert(!existsSync(join(output, 'fixture--test.graph.json.gz')), 'new snapshots must retire the duplicate readable graph');
  assert.deepEqual(meta.buildInputs, inputs);
  assert.equal(core.source.inputsHash, catalogInputsHash(inputs));

  const compactGraph = readGzipJson('fixture--test.graph.compact.json.gz');
  const referenceGraph = readGzipJson('fixture--test.relations.json.gz');
  assert.deepEqual(decodeCompactRelationTables(compactGraph.relations), referenceGraph.relations,
    'published compact graph must remain field-for-field equal to the producer reference');
  assert.equal(meta.assets.graphCompact.asset, 'fixture--test.graph.compact.json.gz');
  assert.equal(compactGraph.source.commit, referenceGraph.source.commit);
  assert.equal(core.source.defaultBranch, 'test', 'discovered upstream default must survive generated source metadata');
  assert.equal(meta.sizeReport.split.initialBytes, meta.assets.core.bytes + meta.assets.graphCompact.bytes);
  const textEntry = indexedTranslationCatalogs({ sources: [{ id: 'Fixture', branches: [{
    branch: 'test', legacy: meta.legacy, assets: meta.assets,
  }] }] }, output)[0];
  const modernText = readIndexedTranslationCatalog(textEntry);
  assert.equal(modernText.modern, true, 'fresh generator must publish a complete text projection');
  const legacyText = readGzipJson('fixture--test.json.gz');
  for (const language of ['zh-CN', 'zh-TW', 'ru', 'es', 'pt', 'ja', 'ko', 'de', 'fr', 'vi']) {
    assert.deepEqual(menuLanguagePayload(modernText.catalog, language, 'same'),
      menuLanguagePayload(legacyText, language, 'same'), 'producer modern text and legacy projection must match');
  }

  assert.deepEqual(core.applications.fields, ['symbol', 'package', 'group', 'hot']);
  assert(core.applications.rows.some((row) => row[0] === 'PACKAGE_luci-app-demo' && row[1] === 'luci-app-demo'));
  assert(!core.applications.rows.some((row) => /INCLUDE_payload|symbol-only/.test(row[0])),
    'Kconfig suboptions must not become application packages');
  assert.equal(core.applications.rows.some((row) => row[1] === 'luci-app-packageinfo-only'), false,
    'packageinfo-only metadata must not become a selectable branch application');
  assert(!Object.keys(meta.assets).some((key) => key.startsWith('packageSizes')),
    'retired size assets must not be advertised');
  assert(!core.capabilities.includes('package-sizes-v1'));
  assert(!readdirSync(output).some((name) => name.includes('.package-sizes')),
    'the producer must not emit retired size files');
  console.log(`Branch applications passed without retired sizes: ${core.applications.rows.length}`);
} finally {
  rmSync(output, { recursive: true, force: true });
}

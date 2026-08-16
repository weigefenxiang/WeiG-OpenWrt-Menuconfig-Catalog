from pathlib import Path
import shutil

ROOT = Path('.')

def read(path):
    return (ROOT / path).read_text(encoding='utf-8')

def write(path, text):
    (ROOT / path).write_text(text, encoding='utf-8', newline='\n')

def replace_once(text, old, new, label):
    count = text.count(old)
    if count != 1:
        raise SystemExit(f'{label}: expected 1 match, got {count}')
    return text.replace(old, new, 1)

catalog_channels = r'''#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

export const PRODUCTION_CANDIDATE_BRANCH = 'catalog-candidate';
export const PRODUCTION_DATA_BRANCH = 'catalog-main';
const GIT_SHA_RE = /^[0-9a-f]{40}$/i;
const CANONICAL_FIX_RE = /^fix-([A-Za-z0-9][A-Za-z0-9._-]{0,95})$/;
const CANONICAL_FIX_DATA_RE = /^catalog-fix-([A-Za-z0-9][A-Za-z0-9._-]{0,95})$/;

const BUILD_DATA_BRANCHES = Object.freeze({
  dev: 'catalog-dev',
  staging: 'catalog-staging',
  main: PRODUCTION_CANDIDATE_BRANCH,
});

const RUNTIME_DATA_BRANCHES = Object.freeze({
  dev: 'catalog-dev',
  staging: 'catalog-staging',
  main: PRODUCTION_DATA_BRANCH,
});

function canonicalFixDataBranch(ref) {
  const suffix = CANONICAL_FIX_RE.exec(ref)?.[1] || '';
  return suffix ? `catalog-fix-${suffix}` : '';
}

// Frozen compatibility for historical slash-style experiment branches.
function legacyFixDataBranch(ref) {
  if (!ref.startsWith('fix/')) return '';
  const dMatch = /^fix\/(DA|DB)$/i.exec(ref);
  if (dMatch) return `catalog-${dMatch[1].toUpperCase()}`;
  const lane = /-([ABC])$/i.exec(ref)?.[1]?.toUpperCase() || '';
  return lane ? `catalog-fix-${lane}` : 'catalog-fix';
}

export function fixDataBranchForCodeRef(codeRef) {
  const ref = String(codeRef || '').trim();
  return canonicalFixDataBranch(ref) || legacyFixDataBranch(ref);
}

export function buildDataBranchForCodeRef(codeRef) {
  const ref = String(codeRef || '').trim();
  if (BUILD_DATA_BRANCHES[ref]) return BUILD_DATA_BRANCHES[ref];
  return fixDataBranchForCodeRef(ref);
}

export function runtimeDataBranchForChannel(channel) {
  const ref = String(channel || '').trim();
  if (RUNTIME_DATA_BRANCHES[ref]) return RUNTIME_DATA_BRANCHES[ref];
  return fixDataBranchForCodeRef(ref);
}

export function translationChannel(channel) {
  const value = String(channel || '').trim();
  if (value === 'candidate') return { codeRef: 'main', dataBranch: PRODUCTION_CANDIDATE_BRANCH };
  if (value === 'dev') return { codeRef: 'dev', dataBranch: 'catalog-dev' };
  if (value === 'staging') return { codeRef: 'staging', dataBranch: 'catalog-staging' };
  const fixBranch = fixDataBranchForCodeRef(value);
  return fixBranch ? { codeRef: value, dataBranch: fixBranch } : null;
}

export function codeRefForDataBranch(dataBranch) {
  const branch = String(dataBranch || '').trim();
  if (branch === 'catalog-dev') return 'dev';
  if (branch === 'catalog-staging') return 'staging';
  if (branch === PRODUCTION_CANDIDATE_BRANCH || branch === PRODUCTION_DATA_BRANCH) return 'main';
  const canonical = CANONICAL_FIX_DATA_RE.exec(branch)?.[1] || '';
  if (canonical) return `fix-${canonical}`;
  if (branch === 'catalog-DA') return 'fix/DA';
  if (branch === 'catalog-DB') return 'fix/DB';
  return '';
}

export function isWritableNonProductionDataBranch(dataBranch) {
  const branch = String(dataBranch || '').trim();
  return branch === 'catalog-dev' || branch === 'catalog-staging' || branch === PRODUCTION_CANDIDATE_BRANCH ||
    branch === 'catalog-fix' || CANONICAL_FIX_DATA_RE.test(branch) || branch === 'catalog-DA' || branch === 'catalog-DB';
}

export function defaultReuseSourceForCodeRef(codeRef) {
  const ref = String(codeRef || '').trim();
  if (canonicalFixDataBranch(ref)) return { codeRef: 'dev', dataBranch: 'catalog-dev' };
  if (ref === 'dev') return { codeRef: 'dev', dataBranch: 'catalog-dev' };
  if (ref === 'staging') return { codeRef: 'dev', dataBranch: 'catalog-dev' };
  if (ref === 'main') return { codeRef: 'staging', dataBranch: 'catalog-staging' };
  return null;
}

export function validatePromotionSource(targetCodeRef, sourceDataBranch) {
  const target = String(targetCodeRef || '').trim();
  const source = String(sourceDataBranch || '').trim();
  const targetDataBranch = buildDataBranchForCodeRef(target);
  const sourceCodeRef = codeRefForDataBranch(source);
  if (!targetDataBranch || !sourceCodeRef || !isWritableNonProductionDataBranch(targetDataBranch)) {
    throw new Error(`unsupported Catalog promotion: ${source || '(missing)'} -> ${target || '(missing)'}`);
  }
  const canonicalTargetFix = Boolean(canonicalFixDataBranch(target));
  const canonicalSourceFix = Boolean(CANONICAL_FIX_DATA_RE.test(source));
  const allowed = canonicalTargetFix ? source === 'catalog-dev'
    : target === 'dev' ? (source === 'catalog-dev' || canonicalSourceFix)
      : target === 'staging' ? source === 'catalog-dev'
        : target === 'main' ? source === 'catalog-staging'
          : false;
  if (!allowed) throw new Error(`Catalog promotion edge is not allowed: ${source} -> ${targetDataBranch}`);
  return { sourceCodeRef, sourceDataBranch: source, targetDataBranch };
}

export function pushBeforeSha(event = {}) {
  const before = String(event?.before || '').trim().toLowerCase();
  if (!GIT_SHA_RE.test(before) || /^0{40}$/.test(before)) return '';
  return before;
}

export function ensurePushBeforeCommitAvailable({
  eventName = process.env.GITHUB_EVENT_NAME || '',
  eventPath = process.env.GITHUB_EVENT_PATH || '',
  cwd = process.cwd(),
} = {}) {
  if (eventName !== 'push' || !eventPath) return '';
  const before = pushBeforeSha(JSON.parse(readFileSync(eventPath, 'utf8')));
  if (!before) return '';
  try {
    execFileSync('git', ['cat-file', '-e', `${before}^{commit}`], { cwd, stdio: 'ignore' });
    return before;
  } catch {
    execFileSync('git', ['fetch', '--no-tags', '--depth=1', 'origin', before], { cwd, stdio: 'inherit' });
    execFileSync('git', ['cat-file', '-e', `${before}^{commit}`], { cwd, stdio: 'ignore' });
    return before;
  }
}

function printResult(mode, value, extra = '') {
  if (mode === 'build') {
    const branch = buildDataBranchForCodeRef(value);
    if (!branch) throw new Error(`unsupported Catalog code ref: ${value}`);
    process.stdout.write(`${branch}\n`);
    return;
  }
  if (mode === 'runtime') {
    const branch = runtimeDataBranchForChannel(value);
    if (!branch) throw new Error(`unsupported Catalog runtime channel: ${value}`);
    process.stdout.write(`${branch}\n`);
    return;
  }
  if (mode === 'translation') {
    const resolved = translationChannel(value);
    if (!resolved) throw new Error(`unsupported Catalog translation channel: ${value}`);
    process.stdout.write(`code_ref=${resolved.codeRef}\ndata_branch=${resolved.dataBranch}\n`);
    return;
  }
  if (mode === 'code-for-data') {
    const codeRef = codeRefForDataBranch(value);
    if (!codeRef) throw new Error(`unsupported Catalog data branch: ${value}`);
    process.stdout.write(`${codeRef}\n`);
    return;
  }
  if (mode === 'validate-non-production') {
    if (!isWritableNonProductionDataBranch(value)) throw new Error(`unsupported or production Catalog data branch: ${value}`);
    process.stdout.write(`${value}\n`);
    return;
  }
  if (mode === 'reuse-source') {
    const source = defaultReuseSourceForCodeRef(value);
    if (!source) throw new Error(`unsupported Catalog reuse code ref: ${value}`);
    process.stdout.write(`source_code_ref=${source.codeRef}\nsource_data_branch=${source.dataBranch}\n`);
    return;
  }
  if (mode === 'validate-promotion') {
    const result = validatePromotionSource(value, extra);
    process.stdout.write(`source_code_ref=${result.sourceCodeRef}\nsource_data_branch=${result.sourceDataBranch}\ntarget_data_branch=${result.targetDataBranch}\n`);
    return;
  }
  throw new Error(`unsupported Catalog channel mode: ${mode}`);
}

const invokedDirectly = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  ensurePushBeforeCommitAvailable();
  printResult(process.argv[2] || '', process.argv[3] || '', process.argv[4] || '');
}
'''
write('scripts/catalog-channels.mjs', catalog_channels)

text = read('scripts/stamp-catalog-snapshot.mjs')
text = replace_once(text,
    "const CODE_REF_RE = /^(?:main|dev|staging|fix-E|fix\\/[A-Za-z0-9._/-]+)$/;",
    "const CODE_REF_RE = /^(?:main|dev|staging|fix-[A-Za-z0-9][A-Za-z0-9._-]{0,95}|fix\\/[A-Za-z0-9._/-]+)$/;",
    'stamp code ref regex')
write('scripts/stamp-catalog-snapshot.mjs', text)

text = read('scripts/catalog-change-impact.mjs')
for item in [
    "    '.github/workflows/catalog.yml',\n",
    "    'scripts/catalog-change-impact.mjs',\n",
    "    'scripts/collect-results.mjs',\n",
    "    'scripts/generate-profile-config-groups.mjs',\n",
    "    'scripts/stamp-catalog-snapshot.mjs',\n",
]:
    if text.count(item) != 1:
        raise SystemExit(f'impact full removal mismatch: {item!r} -> {text.count(item)}')
    text = text.replace(item, '', 1)
none_anchor = "  none: Object.freeze([\n"
none_insert = "  none: Object.freeze([\n    '.github/workflows/catalog-production.yml',\n    '.github/workflows/catalog-reuse.yml',\n    '.github/workflows/catalog.yml',\n    '.github/workflows/probe-contracts.yml',\n"
text = replace_once(text, none_anchor, none_insert, 'impact none workflow insert')
for item in [
    "    'scripts/catalog-change-impact.mjs',\n",
    "    'scripts/collect-results.mjs',\n",
    "    'scripts/generate-profile-config-groups.mjs',\n",
    "    'scripts/stamp-catalog-snapshot.mjs',\n",
]:
    anchor = "    'package.json',\n" if item == "    'scripts/catalog-change-impact.mjs',\n" else None
# Add moved script entries after package.json as a single deterministic block.
text = replace_once(text,
    "    'package.json',\n",
    "    'package.json',\n    'scripts/catalog-change-impact.mjs',\n    'scripts/collect-results.mjs',\n    'scripts/generate-profile-config-groups.mjs',\n    'scripts/stamp-catalog-snapshot.mjs',\n",
    'impact moved script insert')
text = replace_once(text,
    "function isManagedPath(path) {\n  return path.startsWith('scripts/') || path.startsWith('translations/') ||\n    path === '.github/workflows/catalog.yml' || (!path.includes('/') && path.endsWith('.json'));\n}",
    "const MANAGED_WORKFLOWS = new Set([\n  '.github/workflows/catalog-production.yml',\n  '.github/workflows/catalog-reuse.yml',\n  '.github/workflows/catalog.yml',\n  '.github/workflows/probe-contracts.yml',\n]);\n\nfunction isManagedPath(path) {\n  return path.startsWith('scripts/') || path.startsWith('translations/') ||\n    MANAGED_WORKFLOWS.has(path) || (!path.includes('/') && path.endsWith('.json'));\n}",
    'impact managed paths')
text = replace_once(text,
    "    ...readdirSync(root).filter((name) => name.endsWith('.json')),\n    '.github/workflows/catalog.yml',\n",
    "    ...readdirSync(root).filter((name) => name.endsWith('.json')),\n    ...MANAGED_WORKFLOWS,\n",
    'impact coverage workflows')
write('scripts/catalog-change-impact.mjs', text)

check_impact = r'''#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  catalogChangeImpact,
  catalogImpactRegistryCoverage,
  classifyCatalogPath,
} from './catalog-change-impact.mjs';
import { pushBeforeSha } from './catalog-channels.mjs';

assert.equal(classifyCatalogPath('.github/workflows/catalog.yml'), 'none');
assert.equal(classifyCatalogPath('.github/workflows/catalog-reuse.yml'), 'none');
assert.equal(classifyCatalogPath('.github/workflows/catalog-production.yml'), 'none');
assert.equal(classifyCatalogPath('scripts/package-probe-controller.mjs'), 'none');
assert.equal(classifyCatalogPath('translations/probe-ui.json'), 'applications');
assert.equal(classifyCatalogPath('compatibility.json'), 'compatibility');
assert.equal(classifyCatalogPath('scripts/generate-catalog.mjs'), 'full');
assert.equal(classifyCatalogPath('scripts/build-index.mjs'), 'full');
assert.equal(classifyCatalogPath('scripts/generate-profile-config-groups.mjs'), 'none');
assert.equal(classifyCatalogPath('scripts/catalog-change-impact.mjs'), 'none');
assert.equal(classifyCatalogPath('scripts/stamp-catalog-snapshot.mjs'), 'none');
assert.equal(classifyCatalogPath('scripts/check-profile-config-groups.mjs'), 'none');
assert.equal(classifyCatalogPath('scripts/benchmark-profile-config-groups.mjs'), 'none');
assert.equal(classifyCatalogPath('docs/COMPATIBILITY.md'), 'none');

assert.equal(pushBeforeSha({ before: 'A'.repeat(40) }), 'a'.repeat(40));
assert.equal(pushBeforeSha({ before: '0'.repeat(40) }), '');
assert.equal(pushBeforeSha({ before: 'bad' }), '');

assert.deepEqual(catalogChangeImpact([
  'scripts/package-probe-controller.mjs',
  'scripts/check-package-probe.mjs',
]), { mode: 'none', fastAssets: [], classified: [
  { path: 'scripts/package-probe-controller.mjs', impact: 'none' },
  { path: 'scripts/check-package-probe.mjs', impact: 'none' },
] });
assert.equal(catalogChangeImpact([
  '.github/workflows/catalog.yml',
  'scripts/catalog-change-impact.mjs',
]).mode, 'none');
assert.equal(catalogChangeImpact([
  'scripts/generate-profile-config-groups.mjs',
  'scripts/check-profile-config-groups.mjs',
]).mode, 'none');
assert.equal(catalogChangeImpact([
  'scripts/stamp-catalog-snapshot.mjs',
  'scripts/check-catalog-snapshot.mjs',
]).mode, 'none');
assert.equal(catalogChangeImpact([
  'scripts/build-index.mjs',
]).mode, 'full');

assert.deepEqual(catalogChangeImpact([
  'translations/probe-ui.json',
  'curated-sizes.json',
]).fastAssets, ['applications']);
assert.deepEqual(catalogChangeImpact([
  'translations/probe-ui.json',
  'compatibility.json',
]), { mode: 'root-assets', fastAssets: ['applications', 'compatibility'], classified: [
  { path: 'translations/probe-ui.json', impact: 'applications' },
  { path: 'compatibility.json', impact: 'compatibility' },
] });
assert.equal(catalogChangeImpact([
  'translations/probe-ui.json',
  'scripts/generate-catalog.mjs',
]).mode, 'full');

assert.throws(() => classifyCatalogPath('scripts/new-catalog-output.mjs'), /Unclassified Catalog-impact file/);
assert.throws(() => classifyCatalogPath('translations/new-runtime-ui.json'), /Unclassified Catalog-impact file/);

const catalogWorkflow = readFileSync(resolve('.github/workflows/catalog.yml'), 'utf8');
assert(!catalogWorkflow.includes('- "scripts/**"'), 'Menuconfig Catalog push must not watch every script');
assert(!catalogWorkflow.includes('- ".github/workflows/catalog.yml"'), 'Menuconfig Catalog push must not self-trigger on control changes');
for (const required of [
  'scripts/generate-catalog.mjs', 'scripts/build-index.mjs', 'catalog.config.json',
  'translations/menu-i18n.json', 'translations/zh-CN.json', 'compatibility.json', 'curated-sizes.json',
]) {
  assert(catalogWorkflow.includes(`- "${required}"`), `Catalog runtime input missing from push.paths: ${required}`);
}

const coverage = catalogImpactRegistryCoverage();
assert.deepEqual(coverage.missing, []);
assert.deepEqual(coverage.stale, []);
console.log(`Catalog change impact checks passed (${coverage.managed.length} managed files).`);
'''
write('scripts/check-catalog-change-impact.mjs', check_impact)

text = read('scripts/check-catalog-snapshot.mjs')
text = text.replace('const eStamped =', 'const fStamped =').replace('eStamped.', 'fStamped.')
text = text.replace("codeRef: 'fix-E'", "codeRef: 'fix-F'")
text = text.replace("!== 'fix-E'", "!== 'fix-F'")
text = text.replace("const reusableE =", "const reusableF =")
text = text.replace("reusableE", "reusableF")
text = text.replace("const reuseE =", "const reuseF =")
text = text.replace("reuseE.", "reuseF.")
text = text.replace("E snapshot", "generic fix snapshot")
text = text.replace("E reusable", "generic fix reusable")
text = text.replace("invalid E index", "invalid generic fix index")
text = text.replace("preserve E assets", "preserve generic fix assets")
write('scripts/check-catalog-snapshot.mjs', text)

boundary = r'''#!/usr/bin/env node
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildDataBranchForCodeRef,
  runtimeDataBranchForChannel,
  translationChannel,
  validatePromotionSource,
} from './catalog-channels.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const workflowDir = join(ROOT, '.github', 'workflows');
const workflows = new Map(readdirSync(workflowDir)
  .filter((name) => /\.ya?ml$/i.test(name))
  .map((name) => [name, readFileSync(join(workflowDir, name), 'utf8')]));
const productionName = 'catalog-production.yml';
const production = workflows.get(productionName) || '';
const catalog = workflows.get('catalog.yml') || '';
const reuse = workflows.get('catalog-reuse.yml') || '';
const translation = workflows.get('translate.yml') || '';
const sizes = workflows.get('curated-sizes.yml') || '';
const failures = [];
const channelContracts = [
  [buildDataBranchForCodeRef('main'), 'catalog-candidate', 'build main'],
  [buildDataBranchForCodeRef('dev'), 'catalog-dev', 'build dev'],
  [buildDataBranchForCodeRef('staging'), 'catalog-staging', 'build staging'],
  [buildDataBranchForCodeRef('fix-F'), 'catalog-fix-F', 'build fix F'],
  [buildDataBranchForCodeRef('fix-next.test'), 'catalog-fix-next.test', 'build generic fix'],
  [buildDataBranchForCodeRef('fix/DB'), 'catalog-DB', 'build frozen DB compatibility'],
  [runtimeDataBranchForChannel('main'), 'catalog-main', 'runtime main'],
  [runtimeDataBranchForChannel('dev'), 'catalog-dev', 'runtime dev'],
  [runtimeDataBranchForChannel('staging'), 'catalog-staging', 'runtime staging'],
  [runtimeDataBranchForChannel('fix-F'), 'catalog-fix-F', 'runtime fix F'],
  [translationChannel('candidate')?.codeRef, 'main', 'translation candidate code'],
  [translationChannel('candidate')?.dataBranch, 'catalog-candidate', 'translation candidate data'],
  [translationChannel('fix-F')?.codeRef, 'fix-F', 'translation fix F code'],
  [translationChannel('fix-F')?.dataBranch, 'catalog-fix-F', 'translation fix F data'],
  [validatePromotionSource('fix-F', 'catalog-dev').targetDataBranch, 'catalog-fix-F', 'seed fix F'],
  [validatePromotionSource('dev', 'catalog-fix-F').targetDataBranch, 'catalog-dev', 'promote fix F to dev'],
  [validatePromotionSource('staging', 'catalog-dev').targetDataBranch, 'catalog-staging', 'promote dev to staging'],
  [validatePromotionSource('main', 'catalog-staging').targetDataBranch, 'catalog-candidate', 'promote staging to candidate'],
];
for (const [actual, expected, label] of channelContracts) {
  if (actual !== expected) failures.push(`${label}: ${actual || '(empty)'} != ${expected}`);
}
for (const invalid of [
  () => validatePromotionSource('dev', 'catalog-staging'),
  () => validatePromotionSource('staging', 'catalog-fix-F'),
  () => validatePromotionSource('main', 'catalog-dev'),
  () => validatePromotionSource('fix-F', 'catalog-candidate'),
]) {
  try { invalid(); failures.push('invalid Catalog promotion edge was accepted'); } catch {}
}

const requireText = (text, needle, label) => { if (!text.includes(needle)) failures.push(label); };
const forbidText = (text, needle, label) => { if (text.includes(needle)) failures.push(label); };

requireText(production, 'workflow_dispatch:', 'production must be manual');
forbidText(production, 'schedule:', 'production must not be scheduled');
forbidText(production, 'push:', 'production must not run on push');
requireText(production, "if: github.ref_name == 'main'", 'production must be pinned to main code');
requireText(production, 'group: catalog-write-catalog-main', 'production must own the catalog-main writer lock');
requireText(production, 'scripts/verify-production-candidate.mjs', 'production must verify candidate provenance');
requireText(production, 'HEAD:catalog-main', 'production must be the catalog-main writer');
requireText(production, 'scripts/publish-release.sh', 'production must own the complete Release alias');
forbidText(production, 'catalog-data', 'production workflow must not retain the retired catalog-data name');

for (const [name, text] of workflows) {
  if (/^\s*queue\s*:/m.test(text)) failures.push(`${name} contains unsupported concurrency queue syntax`);
  if (name !== productionName && /HEAD:catalog-main|HEAD:\$\{?[^\n]*catalog-main/.test(text)) {
    failures.push(`${name} writes catalog-main outside Production Gate`);
  }
  if (name !== productionName && text.includes('scripts/publish-release.sh')) {
    failures.push(`${name} publishes the complete Release outside Production Gate`);
  }
  if (text.includes('catalog-data')) failures.push(`${name} still references retired catalog-data`);
}

requireText(catalog, 'scripts/catalog-channels.mjs build', 'catalog build must use centralized channel mapping');
requireText(catalog, 'scripts/catalog-channels.mjs validate-non-production', 'catalog writers must use centralized non-production guard');
forbidText(catalog, 'catalog-fix-[ABC]', 'Catalog workflow must not hard-code A/B/C lanes');
forbidText(catalog, 'catalog-fix-E', 'Catalog workflow must not hard-code E lane');
forbidText(catalog, '- "scripts/**"', 'Catalog heavy push must not watch every script');
forbidText(catalog, '- ".github/workflows/catalog.yml"', 'Catalog heavy push must not self-trigger');
forbidText(catalog, 'Publish complete catalog Release', 'catalog build must not publish production Release');

requireText(reuse, 'branches: [main, dev, staging, "fix-*"]', 'reuse workflow must cover canonical fix/dev/staging/main');
requireText(reuse, 'scripts/catalog-channels.mjs validate-promotion', 'reuse workflow must validate promotion edges centrally');
requireText(reuse, 'scripts/catalog-change-impact.mjs', 'reuse workflow must gate on data impact');
requireText(reuse, 'EXPECTED_ASSET_REF', 'reuse workflow must pin immutable asset identity');

requireText(translation, 'default: candidate', 'translation default must be candidate');
requireText(translation, 'options: [candidate, dev, staging]', 'translation channels must be bounded');
requireText(translation, 'scripts/catalog-channels.mjs translation', 'translation must use centralized channel mapping');
forbidText(translation, 'catalog-main', 'translation must not write or select production data');
forbidText(translation, 'data_channel:', 'translation must not expose a free data-channel selector');
forbidText(translation, 'code_channel:', 'translation must not expose a free code-channel selector');

requireText(sizes, 'ref: dev', 'curated size automation must check out dev');
requireText(sizes, 'git push origin HEAD:dev', 'curated size automation must write dev');
forbidText(sizes, 'HEAD:$GITHUB_REF_NAME', 'curated size automation must not write the triggering code ref');

const scan = [
  ...[...workflows].map(([name, text]) => [`.github/workflows/${name}`, text]),
  ...readdirSync(join(ROOT, 'scripts')).filter((name) => /\.(?:mjs|sh|py)$/.test(name) && !name.startsWith('check-') && name !== 'check.mjs')
    .map((name) => [`scripts/${name}`, readFileSync(join(ROOT, 'scripts', name), 'utf8')]),
];
for (const [name, text] of scan) {
  if (/git\s+(?:-C\s+\S+\s+)?push[^\n]*(?:--force|-f\b)/.test(text)) failures.push(`${name} contains a force push`);
}

const productionWriters = [...workflows].filter(([, text]) => text.includes('HEAD:catalog-main')).map(([name]) => name);
if (productionWriters.join(',') !== productionName) failures.push(`catalog-main writer set is ${productionWriters.join(',') || '(none)'}`);

if (failures.length) throw new Error(`production boundary check failed:\n- ${failures.join('\n- ')}`);
console.log(`production boundary checks passed: writer=${productionName}, workflows=${workflows.size}`);
'''
write('scripts/check-production-boundary.mjs', boundary)

# catalog.yml: narrow heavy push, generic Profile output, centralized writer guard.
text = read('.github/workflows/catalog.yml')
old_paths = '''    # Broad managed scopes route through scripts/catalog-change-impact.mjs.\n    # The registry is the single authority for none/root-asset/full impact.\n    paths:\n      - "scripts/**"\n      - "translations/**"\n      - "*.json"\n      - ".github/workflows/catalog.yml"\n'''
new_paths = '''    # Only inputs that can change browser/build runtime Catalog data start this heavy workflow.\n    # Control-plane/test/performance changes are covered by Probe contracts + catalog-reuse.\n    paths:\n      - "catalog.config.json"\n      - "compatibility.json"\n      - "curated-sizes.json"\n      - "translations/menu-i18n.json"\n      - "translations/zh-CN.json"\n      - "translations/probe-ui.json"\n      - "scripts/build-index.mjs"\n      - "scripts/clone-upstream.sh"\n      - "scripts/compact-relations.mjs"\n      - "scripts/compatibility-rules.mjs"\n      - "scripts/curated-applications.mjs"\n      - "scripts/discover.mjs"\n      - "scripts/generate-catalog.mjs"\n      - "scripts/index-contract.mjs"\n      - "scripts/kconfig-relations.mjs"\n      - "scripts/lib.mjs"\n      - "scripts/prepare-metadata.sh"\n      - "scripts/source-policy.mjs"\n'''
text = replace_once(text, old_paths, new_paths, 'catalog push paths')
text = replace_once(text,
    "        if: steps.kconfig_contract.outcome == 'success' && (github.ref_name == 'fix-E' || github.ref_name == 'dev')",
    "        if: steps.kconfig_contract.outcome == 'success'",
    'profile generation condition')
text = replace_once(text,
    "          EXPERIMENT_STAGE: ${{ (github.ref_name == 'fix-E' || github.ref_name == 'dev') && 'profile-config-groups' || '' }}",
    "          EXPERIMENT_STAGE: ${{ steps.kconfig_contract.outcome == 'success' && 'profile-config-groups' || '' }}",
    'profile attempt stage')
old_guard = '''      - name: Validate non-production publish channel\n        run: |\n          case "$CATALOG_DATA_BRANCH" in\n            catalog-fix|catalog-fix-[ABC]|catalog-fix-E|catalog-dev|catalog-staging|catalog-candidate) ;;\n            *) echo "unsupported or production Catalog data branch: $CATALOG_DATA_BRANCH"; exit 1 ;;\n          esac\n'''
new_guard = '''      - name: Validate non-production publish channel\n        run: node scripts/catalog-channels.mjs validate-non-production "$CATALOG_DATA_BRANCH" >/dev/null\n'''
if text.count(old_guard) != 2:
    raise SystemExit(f'catalog writer guard: expected 2, got {text.count(old_guard)}')
text = text.replace(old_guard, new_guard)
# Seed a new canonical fix data branch from its safe upstream snapshot for root-asset-only first changes.
old_fetch = '''          git clone --filter=blob:none --no-checkout --single-branch \\\n            --branch "$CATALOG_DATA_BRANCH" \\\n            "https://x-access-token:${{ github.token }}@github.com/${{ github.repository }}" previous\n          git -C previous sparse-checkout init --no-cone\n'''
new_fetch = '''          remote="https://x-access-token:${{ github.token }}@github.com/${{ github.repository }}"\n          if git ls-remote --exit-code --heads "$remote" "refs/heads/$CATALOG_DATA_BRANCH" >/dev/null 2>&1; then\n            git clone --filter=blob:none --no-checkout --single-branch --branch "$CATALOG_DATA_BRANCH" "$remote" previous\n          else\n            eval "$(node scripts/catalog-channels.mjs reuse-source "$GITHUB_REF_NAME")"\n            node scripts/catalog-channels.mjs validate-promotion "$GITHUB_REF_NAME" "$source_data_branch" >/dev/null\n            git clone --filter=blob:none --no-checkout --single-branch --branch "$source_data_branch" "$remote" previous\n            git -C previous checkout -b "$CATALOG_DATA_BRANCH"\n          fi\n          git -C previous sparse-checkout init --no-cone\n'''
text = replace_once(text, old_fetch, new_fetch, 'root asset seed')
write('.github/workflows/catalog.yml', text)

production = read('.github/workflows/catalog-production.yml').replace('catalog-data', 'catalog-main')
production = production.replace('Catalog production', 'Catalog production')
write('.github/workflows/catalog-production.yml', production)

reuse = r'''name: Reuse and Promote Catalog Snapshot
run-name: Catalog snapshot reuse · ${{ github.event_name }} · ${{ github.ref_name }} · run ${{ github.run_number }}

on:
  push:
    branches: [main, dev, staging, "fix-*"]
  workflow_dispatch:
    inputs:
      source_data_branch:
        description: "Optional validated source snapshot (for example catalog-fix-F when promoting to dev)"
        required: false
        default: ""

permissions:
  contents: write
  actions: write

jobs:
  preflight:
    name: Verify reusable Catalog snapshot / 验证可复用 Catalog 快照
    runs-on: ubuntu-24.04
    timeout-minutes: 12
    concurrency:
      group: catalog-reuse-preflight-${{ github.ref_name }}
      cancel-in-progress: true
    outputs:
      mode: ${{ steps.impact.outputs.mode }}
      reuse: ${{ steps.verify.outputs.reuse }}
      asset_ref: ${{ steps.verify.outputs.asset_ref }}
      base_sha: ${{ steps.verify.outputs.base_sha }}
      source_code_ref: ${{ steps.channel.outputs.source_code_ref }}
      source_data_branch: ${{ steps.channel.outputs.source_data_branch }}
      target_data_branch: ${{ steps.channel.outputs.target_data_branch }}
    steps:
      - uses: actions/checkout@v7
        with:
          fetch-depth: 1

      - id: channel
        name: Resolve promotion edge / 解析晋级边
        env:
          SOURCE_OVERRIDE: ${{ inputs.source_data_branch || '' }}
        run: |
          set -euo pipefail
          source_data_branch="$SOURCE_OVERRIDE"
          if [[ -z "$source_data_branch" ]]; then
            eval "$(node scripts/catalog-channels.mjs reuse-source "$GITHUB_REF_NAME")"
          fi
          node scripts/catalog-channels.mjs validate-promotion "$GITHUB_REF_NAME" "$source_data_branch" | tee "$RUNNER_TEMP/promotion.outputs"
          cat "$RUNNER_TEMP/promotion.outputs" >> "$GITHUB_OUTPUT"

      - id: impact
        name: Classify code delta / 判定代码差异是否改变运行数据
        env:
          BEFORE_SHA: ${{ github.event.before }}
        run: |
          set -euo pipefail
          mode=none
          if [[ "$GITHUB_EVENT_NAME" == push && "$BEFORE_SHA" =~ ^[0-9a-f]{40}$ &&
                "$BEFORE_SHA" != 0000000000000000000000000000000000000000 ]]; then
            if ! git cat-file -e "$BEFORE_SHA^{commit}" 2>/dev/null; then
              git fetch --no-tags --depth=1 origin "$BEFORE_SHA"
            fi
            mapfile -t changed < <(git diff --name-only "$BEFORE_SHA" "$GITHUB_SHA")
            node scripts/catalog-change-impact.mjs "${changed[@]}" | tee "$RUNNER_TEMP/catalog-impact.outputs"
            mode="$(sed -n 's/^mode=//p' "$RUNNER_TEMP/catalog-impact.outputs")"
          fi
          echo "mode=$mode" >> "$GITHUB_OUTPUT"

      - name: Fetch source snapshot / 获取来源快照
        if: steps.impact.outputs.mode == 'none'
        env:
          GH_TOKEN: ${{ github.token }}
          SOURCE_DATA_BRANCH: ${{ steps.channel.outputs.source_data_branch }}
        run: |
          set -euo pipefail
          remote="https://x-access-token:${GH_TOKEN}@github.com/${GITHUB_REPOSITORY}"
          git clone --depth 1 --single-branch --branch "$SOURCE_DATA_BRANCH" "$remote" source

      - id: verify
        name: Verify cumulative reuse safety / 验证累计复用安全性
        if: steps.impact.outputs.mode == 'none'
        env:
          SOURCE_CODE_REF: ${{ steps.channel.outputs.source_code_ref }}
        run: |
          set -euo pipefail
          node scripts/sync-index-assets.mjs source --check
          readarray -t snapshot < <(node --input-type=module - <<'NODE'
          import { readFileSync } from 'node:fs';
          import { verifyReusableCatalogSnapshot } from './scripts/stamp-catalog-snapshot.mjs';
          const index = JSON.parse(readFileSync('source/index.json', 'utf8'));
          const baseSha = String(index?.provenance?.codeSha || '').trim().toLowerCase();
          const reusable = verifyReusableCatalogSnapshot(index, {
            repository: process.env.GITHUB_REPOSITORY || '',
            codeRef: process.env.SOURCE_CODE_REF || '',
            previousCodeSha: baseSha,
          });
          if (reusable.complete !== true) throw new Error('Catalog promotion requires a complete source snapshot');
          console.log(reusable.assetRef);
          console.log(baseSha);
          NODE
          )
          asset_ref="${snapshot[0]}"
          base_sha="${snapshot[1]}"

          for deepen in 32 64 128 256; do
            if git cat-file -e "$base_sha^{commit}" 2>/dev/null &&
               git merge-base --is-ancestor "$base_sha" "$GITHUB_SHA" 2>/dev/null; then
              break
            fi
            [[ "$(git rev-parse --is-shallow-repository)" == true ]] || break
            git fetch --no-tags --deepen="$deepen" origin "$GITHUB_REF_NAME"
          done
          if ! git cat-file -e "$base_sha^{commit}" 2>/dev/null ||
             ! git merge-base --is-ancestor "$base_sha" "$GITHUB_SHA" 2>/dev/null; then
            if [[ "$(git rev-parse --is-shallow-repository)" == true ]]; then
              git fetch --no-tags --unshallow origin "$GITHUB_REF_NAME"
            fi
          fi
          git cat-file -e "$base_sha^{commit}"
          git merge-base --is-ancestor "$base_sha" "$GITHUB_SHA"

          mapfile -t since_snapshot < <(git diff --name-only "$base_sha" "$GITHUB_SHA")
          node scripts/catalog-change-impact.mjs "${since_snapshot[@]}" | tee "$RUNNER_TEMP/catalog-reuse-impact.outputs"
          [[ "$(sed -n 's/^mode=//p' "$RUNNER_TEMP/catalog-reuse-impact.outputs")" == none ]]

          git -C source fetch --depth 1 origin "$asset_ref"
          git -C source cat-file -e "${asset_ref}^{commit}"
          echo "reuse=true" >> "$GITHUB_OUTPUT"
          echo "asset_ref=$asset_ref" >> "$GITHUB_OUTPUT"
          echo "base_sha=$base_sha" >> "$GITHUB_OUTPUT"

      - name: Preflight summary / 预检摘要
        if: always()
        env:
          MODE: ${{ steps.impact.outputs.mode }}
          REUSE: ${{ steps.verify.outputs.reuse }}
          SOURCE: ${{ steps.channel.outputs.source_data_branch }}
          TARGET: ${{ steps.channel.outputs.target_data_branch }}
          BASE_SHA: ${{ steps.verify.outputs.base_sha }}
        run: |
          {
            echo "## Catalog snapshot reuse preflight"
            echo
            echo "- Code impact: \`${MODE:-unknown}\`"
            echo "- Reusable: \`${REUSE:-false}\`"
            echo "- Source: \`${SOURCE:-n/a}\`"
            echo "- Target: \`${TARGET:-n/a}\`"
            echo "- Source provenance: \`${BASE_SHA:-n/a}\`"
            echo "- Target code: \`${GITHUB_SHA}\`"
          } >> "$GITHUB_STEP_SUMMARY"

  publish:
    name: Promote immutable Catalog snapshot / 晋级不可变 Catalog 快照
    needs: preflight
    if: needs.preflight.outputs.reuse == 'true'
    runs-on: ubuntu-24.04
    timeout-minutes: 10
    concurrency:
      group: catalog-write-${{ needs.preflight.outputs.target_data_branch }}
      cancel-in-progress: true
    steps:
      - uses: actions/checkout@v7
        with:
          fetch-depth: 1

      - name: Ensure this is still the latest code ref / 确认仍为最新代码
        id: latest
        run: |
          set -euo pipefail
          current_sha="$(git ls-remote origin "refs/heads/$GITHUB_REF_NAME" | awk '{print $1}')"
          [[ "$current_sha" =~ ^[0-9a-f]{40}$ ]]
          if [[ "$current_sha" == "$GITHUB_SHA" ]]; then
            echo "latest=true" >> "$GITHUB_OUTPUT"
          else
            echo "latest=false" >> "$GITHUB_OUTPUT"
            echo "A newer code push exists; skip stale snapshot promotion."
          fi

      - name: Cancel stale heavy Catalog builds / 取消过期重型 Catalog 构建
        if: steps.latest.outputs.latest == 'true' && github.event_name == 'push'
        env:
          GH_TOKEN: ${{ github.token }}
        run: |
          set -euo pipefail
          mapfile -t stale_runs < <(
            gh api "/repos/${GITHUB_REPOSITORY}/actions/workflows/catalog.yml/runs?branch=${GITHUB_REF_NAME}&per_page=50" \
              --jq ".workflow_runs[] | select(.head_sha != \"${GITHUB_SHA}\") | select(.status != \"completed\") | .id"
          )
          for run_id in "${stale_runs[@]}"; do
            echo "Cancel stale Catalog run: $run_id"
            gh api --method POST "/repos/${GITHUB_REPOSITORY}/actions/runs/${run_id}/cancel" || true
          done

      - name: Promote exact reusable snapshot / 晋级精确可复用快照
        if: steps.latest.outputs.latest == 'true'
        env:
          GH_TOKEN: ${{ github.token }}
          SOURCE_DATA_BRANCH: ${{ needs.preflight.outputs.source_data_branch }}
          TARGET_DATA_BRANCH: ${{ needs.preflight.outputs.target_data_branch }}
          SOURCE_CODE_REF: ${{ needs.preflight.outputs.source_code_ref }}
          EXPECTED_ASSET_REF: ${{ needs.preflight.outputs.asset_ref }}
          EXPECTED_BASE_SHA: ${{ needs.preflight.outputs.base_sha }}
        run: |
          set -euo pipefail
          remote="https://x-access-token:${GH_TOKEN}@github.com/${GITHUB_REPOSITORY}"
          git clone --depth 1 --single-branch --branch "$SOURCE_DATA_BRANCH" "$remote" source
          node scripts/sync-index-assets.mjs source --check
          readarray -t source_identity < <(node - <<'NODE'
          const i = require('./source/index.json');
          console.log(String(i.assetRef || '').trim().toLowerCase());
          console.log(String(i.provenance?.codeSha || '').trim().toLowerCase());
          NODE
          )
          [[ "${source_identity[0]}" == "$EXPECTED_ASSET_REF" ]] || { echo "source assetRef changed after preflight"; exit 1; }
          [[ "${source_identity[1]}" == "$EXPECTED_BASE_SHA" ]] || { echo "source provenance changed after preflight"; exit 1; }

          if git ls-remote --exit-code --heads "$remote" "refs/heads/$TARGET_DATA_BRANCH" >/dev/null 2>&1; then
            git clone --depth 1 --single-branch --branch "$TARGET_DATA_BRANCH" "$remote" target
          else
            git clone --depth 1 --single-branch --branch "$SOURCE_DATA_BRANCH" "$remote" target
            git -C target checkout -b "$TARGET_DATA_BRANCH"
          fi
          find target -mindepth 1 -maxdepth 1 ! -name .git -exec rm -rf -- {} +
          cp -a source/. target/
          rm -rf target/.git
          # cp copied source/.git only when glob semantics allow it; restore target Git metadata if needed.
          if [[ ! -d target/.git ]]; then
            echo "target Git metadata unexpectedly removed"; exit 1
          fi
          node scripts/stamp-catalog-snapshot.mjs target/index.json "$EXPECTED_ASSET_REF" "$GITHUB_REF_NAME" "$GITHUB_SHA" true
          node scripts/sync-index-assets.mjs target --check
          git -C target config user.name github-actions[bot]
          git -C target config user.email 41898282+github-actions[bot]@users.noreply.github.com
          git -C target add -A
          if git -C target diff --cached --quiet; then
            echo "$TARGET_DATA_BRANCH already matches the verified snapshot and provenance."
          else
            git -C target commit -m "data: promote reusable Catalog snapshot"
            git -C target push origin "HEAD:$TARGET_DATA_BRANCH"
          fi

      - name: Publish summary / 发布摘要
        if: always()
        env:
          LATEST: ${{ steps.latest.outputs.latest }}
          SOURCE: ${{ needs.preflight.outputs.source_data_branch }}
          TARGET: ${{ needs.preflight.outputs.target_data_branch }}
          ASSET_REF: ${{ needs.preflight.outputs.asset_ref }}
        run: |
          {
            echo "## Catalog snapshot promotion"
            echo
            echo "- Latest code: \`${LATEST:-false}\`"
            echo "- Source: \`${SOURCE:-n/a}\`"
            echo "- Target: \`${TARGET:-n/a}\`"
            echo "- Preserved assetRef: \`${ASSET_REF:-n/a}\`"
            echo "- Code: \`${GITHUB_SHA}\`"
          } >> "$GITHUB_STEP_SUMMARY"
'''
# Fix target copy: use rsync so target .git is never touched.
reuse = reuse.replace("          find target -mindepth 1 -maxdepth 1 ! -name .git -exec rm -rf -- {} +\n          cp -a source/. target/\n          rm -rf target/.git\n          # cp copied source/.git only when glob semantics allow it; restore target Git metadata if needed.\n          if [[ ! -d target/.git ]]; then\n            echo \"target Git metadata unexpectedly removed\"; exit 1\n          fi\n",
                     "          rsync -a --delete --exclude=.git source/ target/\n")
write('.github/workflows/catalog-reuse.yml', reuse)

probe = read('.github/workflows/probe-contracts.yml')
for anchor in ['      - ".github/workflows/catalog.yml"\n', '      - ".github/workflows/catalog-reuse.yml"\n']:
    if probe.count(anchor) != 2:
        raise SystemExit(f'probe path anchor mismatch {anchor!r}: {probe.count(anchor)}')
probe = probe.replace('      - ".github/workflows/catalog.yml"\n',
                      '      - ".github/workflows/catalog.yml"\n      - ".github/workflows/catalog-production.yml"\n', 2)
write('.github/workflows/probe-contracts.yml', probe)

# Save tested workflow bodies outside .github so the bot can commit them without workflow permission.
for name in ['catalog.yml', 'catalog-reuse.yml', 'catalog-production.yml', 'probe-contracts.yml']:
    shutil.copyfile(ROOT / '.github' / 'workflows' / name, ROOT / f'.f-output-{name}')

print('F channel migration patch applied')

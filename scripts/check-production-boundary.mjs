#!/usr/bin/env node
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildDataBranchForCodeRef, runtimeDataBranchForChannel, translationChannel } from './catalog-channels.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const workflowDir = join(ROOT, '.github', 'workflows');
const workflows = new Map(readdirSync(workflowDir)
  .filter((name) => /\.ya?ml$/i.test(name))
  .map((name) => [name, readFileSync(join(workflowDir, name), 'utf8')]));
const productionName = 'catalog-production.yml';
const production = workflows.get(productionName) || '';
const catalog = workflows.get('catalog.yml') || '';
const translation = workflows.get('translate.yml') || '';
const sizes = workflows.get('curated-sizes.yml') || '';
const failures = [];
const channelContracts = [
  [buildDataBranchForCodeRef('main'), 'catalog-candidate', 'build main'],
  [buildDataBranchForCodeRef('dev'), 'catalog-dev', 'build dev'],
  [buildDataBranchForCodeRef('staging'), 'catalog-staging', 'build staging'],
  [buildDataBranchForCodeRef('fix/demo'), 'catalog-fix', 'build legacy fix'],
  [buildDataBranchForCodeRef('fix/demo-A'), 'catalog-fix-A', 'build fix A'],
  [buildDataBranchForCodeRef('fix/demo-B'), 'catalog-fix-B', 'build fix B'],
  [buildDataBranchForCodeRef('fix/demo-C'), 'catalog-fix-C', 'build fix C'],
  [buildDataBranchForCodeRef('fix/demo-a'), 'catalog-fix-A', 'build lowercase fix A'],
  [runtimeDataBranchForChannel('main'), 'catalog-data', 'runtime main'],
  [runtimeDataBranchForChannel('dev'), 'catalog-dev', 'runtime dev'],
  [runtimeDataBranchForChannel('staging'), 'catalog-staging', 'runtime staging'],
  [runtimeDataBranchForChannel('fix/demo'), 'catalog-fix', 'runtime legacy fix'],
  [runtimeDataBranchForChannel('fix/demo-A'), 'catalog-fix-A', 'runtime fix A'],
  [runtimeDataBranchForChannel('fix/demo-B'), 'catalog-fix-B', 'runtime fix B'],
  [runtimeDataBranchForChannel('fix/demo-C'), 'catalog-fix-C', 'runtime fix C'],
  [translationChannel('candidate')?.codeRef, 'main', 'translation candidate code'],
  [translationChannel('candidate')?.dataBranch, 'catalog-candidate', 'translation candidate data'],
  [translationChannel('fix/demo-A')?.dataBranch, 'catalog-fix-A', 'translation fix A data'],
  [translationChannel('fix/demo-B')?.dataBranch, 'catalog-fix-B', 'translation fix B data'],
  [translationChannel('fix/demo-C')?.dataBranch, 'catalog-fix-C', 'translation fix C data'],
];
for (const [actual, expected, label] of channelContracts) {
  if (actual !== expected) failures.push(`${label}: ${actual || '(empty)'} != ${expected}`);
}

const requireText = (text, needle, label) => { if (!text.includes(needle)) failures.push(label); };
const forbidText = (text, needle, label) => { if (text.includes(needle)) failures.push(label); };

requireText(production, 'workflow_dispatch:', 'production must be manual');
forbidText(production, 'schedule:', 'production must not be scheduled');
forbidText(production, 'push:', 'production must not run on push');
requireText(production, "if: github.ref_name == 'main'", 'production must be pinned to main code');
requireText(production, 'group: catalog-write-catalog-data', 'production must own the production writer lock');
requireText(production, 'scripts/verify-production-candidate.mjs', 'production must verify candidate provenance');
requireText(production, 'HEAD:catalog-data', 'production must be the catalog-data writer');
requireText(production, 'scripts/publish-release.sh', 'production must own the complete Release alias');

for (const [name, text] of workflows) {
  if (/^\s*queue\s*:/m.test(text)) failures.push(`${name} contains unsupported concurrency queue syntax`);
  if (name === productionName) continue;
  if (/HEAD:catalog-data|HEAD:\$\{?[^\n]*catalog-data/.test(text)) failures.push(`${name} writes catalog-data outside Production Gate`);
  if (text.includes('scripts/publish-release.sh')) failures.push(`${name} publishes the complete Release outside Production Gate`);
}

requireText(catalog, 'scripts/catalog-channels.mjs build', 'catalog build must use centralized channel mapping');
requireText(catalog, 'catalog-candidate', 'main build must support catalog-candidate');
requireText(catalog, 'catalog-fix-[ABC]', 'Catalog experiment lanes must be explicitly bounded to A/B/C');
forbidText(catalog, "github.ref_name == 'main' && 'catalog-data'", 'catalog main must not map directly to catalog-data');
forbidText(catalog, 'Publish complete catalog Release', 'catalog build must not publish production Release');

requireText(translation, 'default: candidate', 'translation default must be candidate');
requireText(translation, 'options: [candidate, dev, staging]', 'translation channels must be bounded');
requireText(translation, 'scripts/catalog-channels.mjs translation', 'translation must use centralized channel mapping');
forbidText(translation, 'catalog-data', 'translation must not write or select production data');
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

const productionWriters = [...workflows].filter(([, text]) => text.includes('HEAD:catalog-data')).map(([name]) => name);
if (productionWriters.join(',') !== productionName) failures.push(`catalog-data writer set is ${productionWriters.join(',') || '(none)'}`);

if (failures.length) throw new Error(`production boundary check failed:\n- ${failures.join('\n- ')}`);
console.log(`production boundary checks passed: writer=${productionName}, workflows=${workflows.size}`);

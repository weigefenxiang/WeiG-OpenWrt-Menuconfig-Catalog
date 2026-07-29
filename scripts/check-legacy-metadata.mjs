#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import {
  copyFileSync, cpSync, existsSync, mkdtempSync, readFileSync, rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const fixture = join(ROOT, 'tests', 'legacy-metadata');
const scriptPath = join(ROOT, 'scripts', 'prepare-metadata.sh');

if (process.platform === 'win32') {
  console.log('legacy metadata compatibility fixture: deferred to Linux CI (Windows shell bridge skipped)');
  process.exit(0);
}

function makeTree() {
  const tree = mkdtempSync(join(tmpdir(), 'weig-legacy-metadata-'));
  cpSync(fixture, tree, { recursive: true });
  copyFileSync(scriptPath, join(tree, 'prepare-metadata.sh'));
  return tree;
}

const nativeTree = makeTree();
const compatTree = makeTree();
try {
  const native = spawnSync('bash', ['./prepare-metadata.sh', 'native'], {
    cwd: nativeTree, encoding: 'utf8',
  });
  if (native.status === 0 ||
      !`${native.stdout}\n${native.stderr}`.includes('obsolete host-version gate')) {
    throw new Error('native fixture did not enforce the obsolete prerequisite gate');
  }
  const compat = spawnSync('bash', ['./prepare-metadata.sh', 'legacy-metadata'], {
    cwd: compatTree, encoding: 'utf8',
  });
  if (compat.status !== 0 ||
      !existsSync(join(compatTree, 'tmp', '.targetinfo')) ||
      !existsSync(join(compatTree, 'tmp', '.packageinfo')) ||
      !readFileSync(join(compatTree, 'tmp', '.targetinfo'), 'utf8').includes('fixture')) {
    throw new Error(`legacy metadata compatibility failed:\n${compat.stdout}\n${compat.stderr}`);
  }
  console.log('legacy metadata compatibility checks passed: native=blocked compat=metadata-generated');
} finally {
  rmSync(nativeTree, { recursive: true, force: true });
  rmSync(compatTree, { recursive: true, force: true });
}

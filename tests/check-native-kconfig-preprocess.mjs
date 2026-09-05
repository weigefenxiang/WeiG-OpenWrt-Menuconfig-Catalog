import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { traceNativeKconfig, createNativeExpansionReplay } from '../scripts/native-kconfig-preprocess.mjs';
import { parseKconfigDefault, parseKconfigExpression, parseKconfigTree } from '../scripts/lib.mjs';

for (const [raw, value] of [
  [String.raw`"a\n"`, 'an'], [String.raw`"a\\n"`, String.raw`a\n`],
  [String.raw`"a\q"`, 'aq'], [String.raw`"a\\q"`, String.raw`a\q`],
]) {
  assert.equal(parseKconfigDefault(raw, 'string').value, value);
  assert.equal(parseKconfigExpression(raw).ast.value, value);
}
const root = mkdtempSync(join(tmpdir(), 'catalog-preprocess-contract-'));
try {
  const event = { file: 'Config.in', line: 2, input: '$(VALUE)', output: 'y', quoted: false };
  let replay = createNativeExpansionReplay(root, [event]);
  assert.equal(replay.line(join(root, 'Config.in'), 2, ' def_bool $(VALUE)'), ' def_bool y');
  assert.equal(replay.finish().complete, true);
  assert.throws(() => replay.line(join(root, 'Config.in'), 2, ' def_bool $(VALUE)'), /Repeated/);
  assert.throws(() => createNativeExpansionReplay(root, [event]).finish(), /Unconsumed/);
  assert.throws(() => createNativeExpansionReplay(root, [event]).line(join(root, 'Config.in'), 2, 'default n'), /mismatch/);
  replay = createNativeExpansionReplay(root, [{ ...event, output: 'y || n' }]);
  assert.throws(() => replay.line(join(root, 'Config.in'), 2, 'default $(VALUE)'), /representable/);
  replay = createNativeExpansionReplay(root, [{ ...event, quoted: true, output: String.raw`a"b\q` }]);
  const expanded = replay.line(join(root, 'Config.in'), 2, '"$(VALUE)"');
  assert.equal(parseKconfigDefault(expanded, 'string').value, String.raw`a"b\q`);

  const implementation = process.env.KCONFIG_NATIVE_TEST_TREE;
  if (implementation) {
    writeFileSync(join(root, 'Config.in'), [
      'mainmenu "Native expansion contract"',
      'VALUE := $(shell, printf x >> calls; printf y)',
      'config ENABLED', ' bool "Enabled"', ' default $(VALUE)',
      'config AGAIN', ' bool', ' default $(VALUE)',
      'PART := fragment', 'source "$(PART).in"', '',
    ].join('\n'));
    writeFileSync(join(root, 'fragment.in'), 'config TEXT\n string\n default "$(VALUE) text"\n');
    assert(parseKconfigTree(root).validation.dynamicExpressions.length > 0);
    const events = traceNativeKconfig(root, join(root, 'Config.in'), resolve(implementation));
    const menu = parseKconfigTree(root, join(root, 'Config.in'), {
      nativeReplay: createNativeExpansionReplay(root, events),
    });
    assert.equal(menu.validation.dynamicExpressions.length, 0);
    assert.equal(menu.validation.nativePreprocessing.complete, true);
    assert.equal(menu.allOptions.find((row) => row.symbol === 'TEXT').defaultsTyped[0].value, 'y text');
    assert.equal(menu.allOptions.find((row) => row.symbol === 'ENABLED').defaults[0], 'y');
    assert.equal(readFileSync(join(root, 'calls'), 'utf8'), 'x', 'native immediate assignment executes once');
    assert.equal(existsSync(join(root, '.config')), false, 'parse-only must not write .config');
    console.log('Native upstream parser integration passed');
  }
  console.log('Native expansion replay and source string contracts passed');
} finally { rmSync(root, { recursive: true, force: true }); }

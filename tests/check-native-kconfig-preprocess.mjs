import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { traceNativeKconfig, createNativeExpansionReplay, hasNativeLiteralQuotedDollars } from '../scripts/native-kconfig-preprocess.mjs';
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
  // Tab-space-tab and tab-tab end at the same native column (16), even
  // though adding eight for every tab would incorrectly end this help block.
  const helpFixture = [
    'mainmenu "Whitespace contract"', 'config HELP_TEXT', ' bool "Help"', ' help',
    '\t \tFirst paragraph.', '\t\tSame native column.', '',
    '\t\tContinued text with $(LITERAL_HELP).',
    '\t \tFinal paragraph.', '', 'config AFTER_HELP', ' bool "After"', ' default y', '',
  ].join('\n');
  writeFileSync(join(root, 'Config.in'), helpFixture);
  let menu = parseKconfigTree(root);
  assert.deepEqual(menu.validation.unsupportedDirectives, []);
  assert.deepEqual(menu.validation.dynamicExpressions, []);
  assert.match(menu.allOptions.find((row) => row.symbol === 'HELP_TEXT').help, /Same native column\.[\s\S]*Final paragraph\./);
  assert.equal(menu.allOptions.find((row) => row.symbol === 'AFTER_HELP').defaults[0], 'y');

  const literalFixture = [
    'config LIB_PATH', ' string "Library path"', ' default "$$(STAGING_DIR_HOSTPKG)/lib/runtime"',
    'config EXEC_PATH', ' string "Interpreter$(INTERPRETER_VERSION)"',
    ' default "$$(STAGING_DIR_HOSTPKG)/bin/interpreter$(INTERPRETER_VERSION)"',
    'config SINGLE_QUOTED', " string 'Path$(SUFFIX)'", " default '$(shell, touch should-not-exist)'", '',
  ].join('\n');
  writeFileSync(join(root, 'Config.in'), helpFixture + literalFixture);
  assert.equal(hasNativeLiteralQuotedDollars(root), false, 'missing lexer cannot prove legacy semantics');
  assert(parseKconfigTree(root).validation.dynamicExpressions.length > 0);
  const implementationDir = join(root, 'legacy-implementation');
  mkdirSync(join(implementationDir, 'scripts', 'config'), { recursive: true });
  // Minimal exact literal-token rule shape; the Linux integration below also
  // runs the real shipped lexer/parser rather than relying on this stub.
  writeFileSync(join(implementationDir, 'scripts', 'config', 'zconf.l'), String.raw`<STRING>{
  [^'"\\\n]+ {
    append_string(yytext, yyleng);
  }
  \'|\" { return T_WORD_QUOTE; }
}
`);
  assert.equal(hasNativeLiteralQuotedDollars(implementationDir), true);
  menu = parseKconfigTree(root, join(root, 'Config.in'), { implementation: implementationDir });
  assert.deepEqual(menu.validation.dynamicExpressions, []);
  assert.equal(menu.allOptions.find((row) => row.symbol === 'LIB_PATH').defaultsTyped[0].value, '$$(STAGING_DIR_HOSTPKG)/lib/runtime');
  assert.equal(menu.allOptions.find((row) => row.symbol === 'EXEC_PATH').prompt, 'Interpreter$(INTERPRETER_VERSION)');
  for (const directive of ['source "$(UNRESOLVED).in"', 'mainmenu "$(UNRESOLVED)"',
    'config CONDITIONAL\n bool\n default "literal$(VALUE)" if $(UNKNOWN)', 'config RAW\n bool\n default $(UNKNOWN)']) {
    writeFileSync(join(root, 'Config.in'), directive + '\n');
    assert(parseKconfigTree(root, join(root, 'Config.in'), { implementation: implementationDir }).validation.dynamicExpressions.length > 0,
      'legacy quoted values must not suppress source/mainmenu/condition diagnostics');
  }
  writeFileSync(join(root, 'Config.in'), 'config COMMENT\n bool\n default y # $(NOT_A_MACRO)\n');
  assert.deepEqual(parseKconfigTree(root).validation.dynamicExpressions, [], 'comments never require preprocessing');

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
    assert.equal(hasNativeLiteralQuotedDollars(resolve(implementation)), false);
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
  const legacyImplementation = process.env.KCONFIG_LEGACY_TEST_TREE;
  if (legacyImplementation) {
    const source = resolve(legacyImplementation);
    assert.equal(hasNativeLiteralQuotedDollars(source), true);
    writeFileSync(join(root, 'Config.in'), helpFixture + literalFixture);
    const parsed = parseKconfigTree(root, join(root, 'Config.in'), { implementation: source });
    assert.deepEqual(parsed.validation.dynamicExpressions, []);
    assert.deepEqual(parsed.validation.unsupportedDirectives, []);
    const build = join(root, 'legacy-build');
    cpSync(join(source, 'scripts', 'config'), build, { recursive: true });
    execFileSync('make', ['-C', build, 'conf'], { encoding: 'utf8', timeout: 120000 });
    writeFileSync(join(root, 'input.config'), '');
    execFileSync(join(build, 'conf'), ['--defconfig=input.config', 'Config.in'], {
      cwd: root, encoding: 'utf8', timeout: 30000,
      env: { ...process.env, KCONFIG_CONFIG: join(root, 'native.config') },
    });
    const nativeConfig = readFileSync(join(root, 'native.config'), 'utf8');
    for (const symbol of ['LIB_PATH', 'EXEC_PATH', 'SINGLE_QUOTED']) {
      const value = parsed.allOptions.find((row) => row.symbol === symbol).defaultsTyped[0].value;
      assert(nativeConfig.includes(`CONFIG_${symbol}="${value}"`), `native literal value mismatch: ${symbol}`);
    }
    assert(nativeConfig.includes('CONFIG_AFTER_HELP=y'));
    assert.equal(existsSync(join(root, 'should-not-exist')), false, 'legacy literal must not execute shell');
    console.log('Legacy upstream lexer, literal values and help integration passed');
  }
  console.log('Native expansion replay and source string contracts passed');
} finally { rmSync(root, { recursive: true, force: true }); }

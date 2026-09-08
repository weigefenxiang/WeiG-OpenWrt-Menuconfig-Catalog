import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parsePackageInfo } from '../scripts/lib.mjs';
import { buildKconfigRelations } from '../scripts/kconfig-relations.mjs';
import { expandCompactRelations } from '../scripts/compact-relations.mjs';
import { gunzipSync } from 'node:zlib';

const text = [
  'Source-Makefile: package/old/Makefile',
  'Package: duplicate', 'Title: Old definition', 'Depends: old-dependency',
  'Provides: @old-capability', 'Conflicts: old-conflict',
  'Source-Makefile: package/new/Makefile', 'Override: package/old',
  'Package: duplicate', 'Title: Effective definition', 'Depends: +TLS:tls-any @NETWORK',
  'Provides: @new-capability', 'Conflicts: provider,',
  'Description: Multiline metadata', 'Package: not-a-package', '@@',
  'Config:', 'Depends: not-a-dependency', '@@',
  'Package: provider', 'Provides: @tls-any versioned-capability=1.2',
  'Source-Makefile: package/firmware/Makefile',
  'Package: firmware/device', 'Build-Only: 1', '',
].join('\n');
const rows = parsePackageInfo(text);
assert.deepEqual(rows.map((row) => row.name), ['duplicate', 'provider', 'firmware/device']);
assert.equal(rows[0].sourceMakefile, 'package/new/Makefile');
assert.equal(rows[0].override, 'package/old');
assert.deepEqual(rows[0].rawProvides, ['@new-capability']);
assert.deepEqual(rows[0].depends, ['+TLS:tls-any', '@NETWORK']);
assert.deepEqual(rows[0].replacedSources[0].depends, ['old-dependency']);
assert.equal(rows[2].buildOnly, true);
const graph = buildKconfigRelations([], rows, []);
assert.equal(graph.packageClosureComplete, true);
assert.deepEqual(graph.indexes.providers['new-capability'], ['duplicate']);
assert.deepEqual(graph.indexes.providers['old-capability'], ['duplicate']);
assert.deepEqual(graph.indexes.providers['versioned-capability=1.2'], ['provider']);
assert.equal(graph.indexes.providers['versioned-capability'], undefined);
assert.equal(graph.records.find((row) => row.package === 'firmware/device').origin, 'packageinfo-only');

// Use the existing native integration source checkout when supplied. No
// pinned implementation copy or package/source-specific dependency fixture.
const implementation = process.env.KCONFIG_NATIVE_TEST_TREE;
if (implementation) {
  const root = mkdtempSync(join(tmpdir(), 'catalog-metadata-parity-'));
  try {
    const input = join(root, 'packageinfo');
    writeFileSync(input, text);
    const program = String.raw`use metadata; use JSON::PP;
      parse_package_metadata($ARGV[0]) or die "metadata parse failed";
      print encode_json({ packages => [map { my $p = $package{$_};
        +{name => $_, depends => $p->{depends}, provides => $p->{provides},
          conflicts => $p->{conflicts} || [], makefile => $p->{src}{makefile},
          buildOnly => $p->{buildonly} ? JSON::PP::true : JSON::PP::false}
      } sort keys %package], providers => {map { $_ => [map { $_->{name} } @{$vpackage{$_}}] } keys %vpackage}});`;
    const nativeResult = JSON.parse(execFileSync(process.env.PERL || 'perl', [
      '-I', join(resolve(implementation), 'scripts'), '-e', program, input,
    ], { encoding: 'utf8' }));
    const native = nativeResult.packages;
    for (const expected of native) {
      const row = rows.find((item) => item.name === expected.name);
      assert(row, `Missing native package ${expected.name}`);
      assert.deepEqual(row.depends, expected.depends);
      // Native generations differ in their internal Provides representation:
      // some retain the marker, others strip it in metadata.pm. Compare the
      // public capability projection on both sides; raw input is tested above.
      const capability = (name) => name.replace(/^@/, '');
      assert.deepEqual([row.name, ...(row.rawProvides || row.provides)].map(capability),
        expected.provides.map(capability));
      assert.deepEqual(row.conflicts, expected.conflicts);
      assert.equal(row.sourceMakefile, expected.makefile);
      assert.equal(Boolean(row.buildOnly), expected.buildOnly);
    }
    assert.equal(rows.length, native.length);
    for (const [name, providers] of Object.entries(nativeResult.providers)) {
      if (rows.some((row) => row.name === name)) continue;
      assert.deepEqual(graph.indexes.providers[name.replace(/^@/, '')], [...new Set(providers)].sort(), `Provider identity mismatch: ${name}`);
    }
    console.log('Native metadata.pm concrete-package projection parity passed');
  } finally {
    // root is a task-created mkdtemp child, never a repository or user path.
    rmSync(root, { recursive: true, force: true });
  }
} else console.log('Package metadata regression passed (native oracle requires KCONFIG_NATIVE_TEST_TREE)');

// Optional real-asset replay: this checks preserved package metadata across
// historical branches, not a substitute for regenerating from native source.
if (process.argv[2]) {
  const visit = (directory) => readdirSync(directory, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? visit(join(directory, entry.name)) :
      entry.name.endsWith('.graph.json.gz') ? [join(directory, entry.name)] : []);
  for (const path of visit(resolve(process.argv[2]))) {
    const document = JSON.parse(gunzipSync(readFileSync(path)));
    const relations = expandCompactRelations(document.relations);
    const metadata = relations.records.filter((row) => row.package && row.origin.includes('packageinfo')).map((row) => ({
      name: row.package, depends: row.packageInfo.rawDepends, provides: row.provides,
      conflicts: (row.conflictsRelations || []).map((relation) => relation.raw),
    }));
    const replay = buildKconfigRelations([], metadata, []);
    assert.equal(replay.packageClosureComplete, true,
      `${path}: ${JSON.stringify(replay.packageClosureValidation.reasons.slice(0, 3))}`);
    console.log(`Package metadata replay passed: ${document.source.id}/${document.source.branch} (${metadata.length} packages)`);
    global.gc?.();
  }
}

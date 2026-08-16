from pathlib import Path


def replace_once(text, old, new, label):
    count = text.count(old)
    if count != 1:
        raise SystemExit(f'{label} anchor count={count}')
    return text.replace(old, new, 1)


generator_path = Path('scripts/generate-profile-config-groups.mjs')
generator = generator_path.read_text().replace('\r\n', '\n').replace('\r', '\n')

generator = replace_once(
    generator,
    "import { cpus } from 'node:os';",
    "import { availableParallelism } from 'node:os';",
    'os parallelism import',
)
generator = replace_once(generator, 'const MAX_PROFILE_JOBS = 4;\n', '', 'fixed Profile worker cap')
generator = replace_once(
    generator,
    """export function normalizeProfileGroupJobs(value, cpuCount = cpus().length) {
  const requested = Number.parseInt(String(value || ''), 10);
  const fallback = Math.max(1, Number(cpuCount) || 1);
  return Math.max(1, Math.min(MAX_PROFILE_JOBS, Number.isFinite(requested) && requested > 0 ? requested : fallback));
}
""",
    """export function normalizeProfileGroupJobs(value, parallelism = availableParallelism()) {
  const requested = Number.parseInt(String(value || ''), 10);
  if (Number.isFinite(requested) && requested > 0) return requested;
  return Math.max(1, Number(parallelism) || 1);
}
""",
    'Profile worker normalization',
)
generator = replace_once(
    generator,
    """  const jobs = normalizeProfileGroupJobs(args.jobs || process.env.PROFILE_GROUP_JOBS);
  console.log(`E Native Profile workers: ${jobs}`);
  const workDir = join(outDir, `.profile-group-work-${process.pid}`);
""",
    """  const requestedJobs = normalizeProfileGroupJobs(args.jobs || process.env.PROFILE_GROUP_JOBS);
  const jobs = Math.max(1, Math.min(entries.length, requestedJobs));
  console.log(`E Native Profile workers: ${jobs}${jobs === requestedJobs ? '' : ` (requested ${requestedJobs})`}`);
  const workDir = join(outDir, `.profile-group-work-${process.pid}`);
""",
    'actual Profile worker count',
)
generator = replace_once(
    generator,
    """  try {
    let completed = 0;
    const rows = await mapConcurrentOrdered(entries, async (entry, index) => {
""",
    """  try {
    let completed = 0;
    const nativeStarted = Date.now();
    const rows = await mapConcurrentOrdered(entries, async (entry, index) => {
""",
    'Native Profile throughput timer',
)
generator = replace_once(
    generator,
    """    const preliminary = buildProfileGroupDocument(rows, { id: args['source-id'], branch: args.branch, commit: '' });
    const aliases = preliminary.identity.aliases;
    const overrides = preliminary.identity.overrides;
    const targetOverrides = preliminary.identity.targetOverrides;
    const nativeParitySamples = verifyMakeDefconfigParity(tree, rows, aliases, overrides, targetOverrides);
    let commit = '';
    try { commit = execFileSync('git', ['-C', tree, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(); } catch {}
    const rawConfigBytes = rows.reduce((sum, row) => sum + row.rawBytes, 0);
    const payload = buildProfileGroupDocument(rows, { id: args['source-id'], branch: args.branch, commit }, {
      generatedAt: new Date().toISOString(), rawConfigBytes, concurrency: jobs,
      nativeParitySamples, generationMs: Date.now() - started,
    });
""",
    """    const nativeConfigMs = Date.now() - nativeStarted;
    const nativeProfilesPerSecond = nativeConfigMs > 0 ? (rows.length * 1000) / nativeConfigMs : rows.length;
    console.log(`E Native Profile throughput: ${rows.length} profiles / ${nativeConfigMs} ms / ${nativeProfilesPerSecond.toFixed(2)} profiles/s`);

    let commit = '';
    try { commit = execFileSync('git', ['-C', tree, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(); } catch {}
    const rawConfigBytes = rows.reduce((sum, row) => sum + row.rawBytes, 0);
    const payload = buildProfileGroupDocument(rows, { id: args['source-id'], branch: args.branch, commit }, {
      rawConfigBytes, concurrency: jobs,
    });
    const nativeParitySamples = verifyMakeDefconfigParity(
      tree, rows, payload.identity.aliases, payload.identity.overrides, payload.identity.targetOverrides,
    );
    payload.generatedAt = new Date().toISOString();
    payload.metrics.nativeParitySamples = nativeParitySamples;
    payload.metrics.generationMs = Date.now() - started;
""",
    'single Profile Group document build',
)
generator = replace_once(
    generator,
    """      `${payload.identity.overrides.length} profile identity overrides / ${compressed.byteLength} compressed bytes / ` +
      `${nativeParitySamples} make defconfig parity samples`);
""",
    """      `${payload.identity.overrides.length} profile identity overrides / ${compressed.byteLength} compressed bytes / ` +
      `${nativeParitySamples} make defconfig parity samples / ${payload.metrics.generationMs} ms total`);
""",
    'Profile generation summary timing',
)
generator_path.write_text(generator)

check_path = Path('scripts/check-profile-config-groups.mjs')
check = check_path.read_text().replace('\r\n', '\n').replace('\r', '\n')
check = replace_once(
    check,
    "import assert from 'node:assert/strict';\n",
    "import assert from 'node:assert/strict';\nimport { readFileSync } from 'node:fs';\n",
    'Profile Group check fs import',
)
check = replace_once(
    check,
    """assert.deepEqual(PROFILE_GROUP_STATE_GROUPS, ['n', 'm', 'y', 'otherIndexValue']);

const entry =""",
    """assert.deepEqual(PROFILE_GROUP_STATE_GROUPS, ['n', 'm', 'y', 'otherIndexValue']);

const generatorSource = readFileSync(new URL('./generate-profile-config-groups.mjs', import.meta.url), 'utf8');
assert(generatorSource.includes("import { availableParallelism } from 'node:os';"),
  'Profile generation must use the runtime-available parallelism authority');
assert(!generatorSource.includes('MAX_PROFILE_JOBS'), 'Profile generation must not retain a fixed worker cap');
assert(!generatorSource.includes('const preliminary = buildProfileGroupDocument('),
  'Profile generation must not build the complete Config Group document twice');
assert.equal((generatorSource.match(/const payload = buildProfileGroupDocument\\(rows,/g) || []).length, 1,
  'Profile generation must build the final Config Group document exactly once');

const entry =""",
    'Profile generator structural checks',
)
check = replace_once(
    check,
    """assert.equal(normalizeProfileGroupJobs('', 8), 4);
assert.equal(normalizeProfileGroupJobs('1', 8), 1);
assert.equal(normalizeProfileGroupJobs('9', 8), 4);
""",
    """assert.equal(normalizeProfileGroupJobs('', 8), 8);
assert.equal(normalizeProfileGroupJobs('1', 8), 1);
assert.equal(normalizeProfileGroupJobs('9', 8), 9);
assert.equal(normalizeProfileGroupJobs('0', 8), 8);
assert.equal(normalizeProfileGroupJobs('invalid', 8), 8);
assert.equal(normalizeProfileGroupJobs('', 0), 1);
""",
    'Profile worker normalization checks',
)
check = replace_once(
    check,
    "console.log('E Profile Config Group checks passed: exact grouping, exact selectors, Target identity normalization, aliases, exact fallback overrides, semantic split, grouped states, bounded workers.');",
    "console.log('E Profile Config Group checks passed: exact grouping, exact selectors, Target identity normalization, aliases, exact fallback overrides, semantic split, grouped states, runtime parallelism, explicit override, ordered worker pool.');",
    'Profile Group check summary',
)
check_path.write_text(check)

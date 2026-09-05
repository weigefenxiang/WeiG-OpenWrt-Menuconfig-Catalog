import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';

// No macro interpreter here: use the exact source tree's lexer, parser and
// preprocessor together, with the same variable assignment order and cwd.
export function traceNativeKconfig(tree, entry = join(tree, 'Config.in'), implementation = tree) {
  const source = join(implementation, 'scripts', 'config');
  const preprocess = join(source, 'preprocess.c');
  if (!existsSync(preprocess) || !/char\s*\*\s*expand_one_token\s*\(/.test(readFileSync(preprocess, 'utf8'))) {
    throw new Error('Native Kconfig preprocessing API unavailable for dynamic source expressions');
  }
  const scratch = mkdtempSync(join(tmpdir(), 'catalog-native-preprocess-'));
  try {
    const build = join(scratch, 'config');
    cpSync(source, build, { recursive: true, filter: (path) => !/\.(?:o|cmd)$/.test(path) });
    cpSync(new URL('./native-kconfig-trace.c', import.meta.url), join(build, 'conf.c'));
    // The temporary main replaces conf.c only. Native common objects and
    // Makefile remain authoritative; no dependency/choice/shell logic copied.
    execFileSync('make', ['-C', build, '-B', 'conf',
      'LDFLAGS=-Wl,--wrap=expand_one_token,--wrap=expand_dollar'],
    { encoding: 'utf8', stdio: 'pipe', timeout: 180000, maxBuffer: 8 * 1024 * 1024 });
    const output = join(scratch, 'expansions.jsonl');
    execFileSync(join(build, 'conf'), [resolve(entry), output], {
      cwd: tree, env: { ...process.env }, encoding: 'utf8', stdio: 'pipe',
      timeout: 180000, maxBuffer: 8 * 1024 * 1024,
    });
    return readFileSync(output, 'utf8').split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
  } finally {
    // Exact directory returned by mkdtemp, never a source/workspace directory.
    rmSync(scratch, { recursive: true, force: true });
  }
}

export function createNativeExpansionReplay(tree, events) {
  const byLocation = new Map();
  const consumed = new Set();
  for (const [index, event] of events.entries()) {
    if (!event.input || typeof event.output !== 'string' || !Number.isInteger(event.line)) {
      throw new Error('Invalid native Kconfig expansion event');
    }
    const key = `${resolve(tree, event.file)}:${event.line}`;
    const rows = byLocation.get(key) || [];
    rows.push({ ...event, index }); byLocation.set(key, rows);
  }
  return {
    line(file, number, raw) {
      const rows = byLocation.get(`${resolve(file)}:${number}`) || [];
      if (!rows.length) return raw;
      // A repeated include with different expansions needs instance-level
      // provenance. Never pick an arbitrary visit and assert completeness.
      if (rows.some((row) => consumed.has(row.index))) throw new Error(`Repeated native expansion location: ${file}:${number}`);
      let cursor = 0;
      let result = '';
      for (const row of rows) {
        let at = -1;
        let quote = '';
        for (let index = 0; index < raw.length; index++) {
          const char = raw[index];
          if (quote && char === '\\') { index++; continue; }
          if (!quote && char === '#') break;
          if (index >= cursor && Boolean(quote) === row.quoted && raw.startsWith(row.input, index)) {
            at = index; break;
          }
          if (quote && char === quote) quote = '';
          else if (!quote && (char === '"' || char === "'")) quote = char;
        }
        if (at < 0) throw new Error(`Native expansion/source mismatch: ${file}:${number}`);
        const prefix = raw.slice(cursor, at);
        if (!row.quoted && row.output && !/^[A-Za-z0-9_./-]+$/.test(row.output)) {
          throw new Error(`Native expansion is not a representable word: ${file}:${number}`);
        }
        if (/[\r\n\0]/.test(row.output)) throw new Error(`Multiline native expansion: ${file}:${number}`);
        // Native STRING expansion appends literal bytes without lexing them.
        // Escape them for the existing source parser, which decodes once.
        const value = row.quoted ? row.output.replace(/[\\"'$]/g, '\\$&') : row.output;
        result += prefix + value;
        cursor = at + row.input.length;
        consumed.add(row.index);
      }
      return result + raw.slice(cursor);
    },
    finish() {
      if (consumed.size !== events.length) throw new Error(`Unconsumed native Kconfig expansions: ${events.length - consumed.size}`);
      return { implementation: 'upstream-native-preprocessor', expansions: events.length, complete: true,
        trace: events.map((event) => ({ ...event, file: relative(tree, resolve(tree, event.file)).replaceAll('\\', '/') })) };
    },
  };
}

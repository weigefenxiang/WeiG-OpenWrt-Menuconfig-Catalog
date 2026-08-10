function dependencyNames(value) {
  const rows = Array.isArray(value) ? value : String(value || '').split(',');
  return rows.flatMap((part) => String(part).split('|').slice(0, 1))
    .map((part) => part.trim().replace(/^\+/, '').replace(/\s*\(.+$/, '').replace(/[<>=~].*$/, ''))
    .filter((name) => /^[A-Za-z0-9][A-Za-z0-9+_.@-]{0,127}$/.test(name));
}

export function parseOpkgPackages(text) {
  return String(text).split(/\r?\n\r?\n/).map((block) => {
    const fields = {};
    let key = '';
    for (const line of block.split(/\r?\n/)) {
      if (/^[ \t]/.test(line) && key) fields[key] += ` ${line.trim()}`;
      else {
        const match = line.match(/^([^:]+):\s*(.*)$/);
        if (match) [key, fields[key]] = [match[1], match[2]];
      }
    }
    const name = fields.Package || '';
    const size = Number(fields.Size || 0);
    return name && Number.isSafeInteger(size) && size >= 0
      ? { name, size, depends: dependencyNames(fields.Depends) }
      : null;
  }).filter(Boolean);
}

export function parseApkDump(value) {
  const parsed = typeof value === 'string' ? JSON.parse(value) : value;
  const rows = Array.isArray(parsed) ? parsed : parsed.packages || parsed.package || [];
  return rows.map((row) => {
    const info = row.info && typeof row.info === 'object' ? row.info : row;
    const name = String(info.name || info.package || info.pkgname || '');
    const size = Number(info.file_size ?? info['file-size'] ?? info.size ?? info.archive_size ?? 0);
    return name && Number.isSafeInteger(size) && size >= 0
      ? { name, size, depends: dependencyNames(info.depends || info.dependencies || []) }
      : null;
  }).filter(Boolean);
}

export function dependencyClosureBytes(packageName, packages) {
  const byName = packages instanceof Map ? packages : new Map(packages.map((row) => [row.name, row]));
  const seen = new Set();
  const visit = (name) => {
    if (seen.has(name)) return 0;
    seen.add(name);
    const row = byName.get(name);
    if (!row) return 0;
    return Number(row.size || 0) + (row.depends || []).reduce((total, dependency) => total + visit(dependency), 0);
  };
  return visit(packageName);
}

export function aggregateCuratedSizes(packageNames, samples) {
  const bytes = {};
  const coverage = {};
  for (const packageName of packageNames) {
    const observations = [];
    for (const sample of samples) {
      const packages = Array.isArray(sample.packages) ? sample.packages : [];
      if (!packages.some((row) => row.name === packageName)) continue;
      observations.push({
        source: sample.source || '', branch: sample.branch || '', architecture: sample.architecture || '',
        bytes: dependencyClosureBytes(packageName, packages),
      });
    }
    if (observations.length) {
      bytes[packageName] = Math.max(...observations.map((row) => row.bytes));
      coverage[packageName] = observations;
    }
  }
  return { bytes, coverage };
}

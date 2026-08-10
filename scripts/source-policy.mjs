const BRANCH_RE = /^[A-Za-z0-9._/-]{1,160}$/;
const GLOB_RE = /^[A-Za-z0-9._/-]*\*[A-Za-z0-9._/-]*$/;

export function matchPattern(value, pattern) {
  const text = String(value || '');
  const rule = String(pattern || '');
  if (!BRANCH_RE.test(text) || (!BRANCH_RE.test(rule) && !GLOB_RE.test(rule))) return false;
  if (!rule.includes('*')) return text === rule;
  const escaped = rule.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp(`^${escaped}$`).test(text);
}

export function sourceBranchPatterns(source) {
  if (Array.isArray(source?.branches)) return source.branches;
  if (source?.branches === 'all') return ['*'];
  if (source?.branches && typeof source.branches === 'object' && Array.isArray(source.branches.include)) {
    return source.branches.include;
  }
  return [];
}

export function validateSourcePolicy(source) {
  const patterns = sourceBranchPatterns(source);
  if (!patterns.length || patterns.some((pattern) => !BRANCH_RE.test(pattern) && !GLOB_RE.test(pattern))) {
    throw new Error(`${source?.id || 'source'}.branches contains an invalid include pattern`);
  }
  const exclude = Array.isArray(source?.exclude) ? source.exclude : [];
  if (exclude.some((pattern) => !BRANCH_RE.test(pattern) && !GLOB_RE.test(pattern))) {
    throw new Error(`${source?.id || 'source'}.exclude contains an invalid pattern`);
  }
  return { patterns, exclude };
}

export function sourceAllowsBranch(source, branch) {
  const { patterns, exclude } = validateSourcePolicy(source);
  return patterns.some((pattern) => matchPattern(branch, pattern)) &&
    !exclude.some((pattern) => matchPattern(branch, pattern));
}

export function sourceNeedsDiscovery(source) {
  return sourceBranchPatterns(source).some((pattern) => pattern.includes('*'));
}

function versionParts(value) {
  return String(value).replace(/^openwrt-/, '').split(/[.-]/).map((part) => {
    const number = Number(part);
    return Number.isFinite(number) ? number : part;
  });
}

export function compareBranches(left, right) {
  const rank = (value) => value === 'main' || value === 'master' ? 0 : value.startsWith('openwrt-') ? 1 : 2;
  const rankDelta = rank(left) - rank(right);
  if (rankDelta) return rankDelta;
  if (rank(left) !== 1) return left.localeCompare(right);
  const a = versionParts(left);
  const b = versionParts(right);
  for (let index = 0; index < Math.max(a.length, b.length); index++) {
    const av = a[index] ?? -1;
    const bv = b[index] ?? -1;
    if (av === bv) continue;
    if (typeof av === 'number' && typeof bv === 'number') return bv - av;
    return String(bv).localeCompare(String(av));
  }
  return left.localeCompare(right);
}

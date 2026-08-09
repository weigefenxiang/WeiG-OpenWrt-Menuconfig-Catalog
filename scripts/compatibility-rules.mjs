const DOCUMENT_KEYS = new Set(['schema', 'rules']);
const RULE_KEYS = new Set(['id', 'kind', 'scope', 'if', 'packages', 'paths', 'refs']);
const RULE_ID_RE = /^[A-Z][A-Z0-9-]{2,31}$/;
const PACKAGE_RE = /^[A-Za-z0-9][A-Za-z0-9+_.@-]{0,95}$/;
const SOURCE_RE = /^[A-Za-z0-9_.-]{1,64}$/;
const BRANCH_RE = /^[A-Za-z0-9._/-]{1,160}$/;
const PATH_RE = /^\/(?!.*(?:^|\/)\.\.(?:\/|$))[^\0\r\n]{1,255}$/;
const REF_RE = /^[A-Za-z0-9][A-Za-z0-9+_.:/@#-]{0,255}$/;
const CONDITION_RE = /^[A-Za-z0-9_().!&|=<>+\-\s\"']{1,512}$/;
const MAX_DOCUMENT_BYTES = 512 * 1024;

function plainObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value);
}

function rejectUnknownKeys(value, allowed, label) {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new Error(`${label} contains unsupported field: ${key}`);
  }
}

function uniqueStrings(value, { label, min = 1, max, pattern }) {
  if (!Array.isArray(value) || value.length < min || value.length > max) {
    throw new Error(`${label} must contain ${min}-${max} entries`);
  }
  const rows = value.map((item) => String(item || '').trim());
  if (rows.some((item) => !pattern.test(item))) throw new Error(`${label} contains an invalid value`);
  if (new Set(rows).size !== rows.length) throw new Error(`${label} contains duplicate values`);
  return rows;
}

function normalizeScope(value, sourcePolicy, label) {
  if (!plainObject(value) || !Object.keys(value).length) throw new Error(`${label} must be a non-empty object`);
  const result = {};
  for (const [sourceId, rawBranches] of Object.entries(value)) {
    if (!SOURCE_RE.test(sourceId) || !sourcePolicy.has(sourceId)) {
      throw new Error(`${label} references an unknown source: ${sourceId}`);
    }
    const branches = uniqueStrings(rawBranches, {
      label: `${label}.${sourceId}`, min: 1, max: 32, pattern: BRANCH_RE,
    });
    const policy = sourcePolicy.get(sourceId);
    if (Array.isArray(policy.branches)) {
      for (const branch of branches) {
        if (!policy.branches.includes(branch) || policy.exclude?.includes(branch)) {
          throw new Error(`${label}.${sourceId} references a branch outside catalog.config.json: ${branch}`);
        }
      }
    } else {
      for (const branch of branches) {
        if (policy.exclude?.includes(branch)) throw new Error(`${label}.${sourceId} references an excluded branch: ${branch}`);
      }
    }
    result[sourceId] = branches;
  }
  return result;
}

export function normalizeCompatibilityDocument(raw, policy = { sources: [] }) {
  if (!plainObject(raw)) throw new Error('compatibility document must be an object');
  rejectUnknownKeys(raw, DOCUMENT_KEYS, 'compatibility document');
  if (Number(raw.schema) !== 1 || !Array.isArray(raw.rules)) {
    throw new Error('compatibility document requires schema 1 and a rules array');
  }
  const sourcePolicy = new Map((policy.sources || []).map((source) => [source.id, source]));
  const seen = new Set();
  const rules = raw.rules.map((rule, index) => {
    const label = `compatibility.rules[${index}]`;
    if (!plainObject(rule)) throw new Error(`${label} must be an object`);
    rejectUnknownKeys(rule, RULE_KEYS, label);
    const id = String(rule.id || '').trim();
    if (!RULE_ID_RE.test(id)) throw new Error(`${label}.id is invalid`);
    if (seen.has(id)) throw new Error(`duplicate compatibility rule id: ${id}`);
    seen.add(id);
    if (rule.kind !== 'ownership') throw new Error(`${id}.kind must be ownership`);
    const condition = String(rule.if || '').trim();
    if (!CONDITION_RE.test(condition)) throw new Error(`${id}.if is invalid`);
    return {
      id,
      kind: 'ownership',
      scope: normalizeScope(rule.scope, sourcePolicy, `${id}.scope`),
      if: condition,
      packages: uniqueStrings(rule.packages, { label: `${id}.packages`, min: 2, max: 16, pattern: PACKAGE_RE }),
      paths: uniqueStrings(rule.paths, { label: `${id}.paths`, min: 1, max: 16, pattern: PATH_RE }),
      refs: uniqueStrings(rule.refs, { label: `${id}.refs`, min: 1, max: 8, pattern: REF_RE }),
    };
  });
  const result = { schema: 1, rules };
  if (Buffer.byteLength(JSON.stringify(result)) > MAX_DOCUMENT_BYTES) {
    throw new Error(`compatibility document exceeds ${MAX_DOCUMENT_BYTES} bytes`);
  }
  return result;
}

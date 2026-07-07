// JSON helpers used across storage, ingest matching, and export.

export function tryParse(str) {
  if (str == null || String(str).trim() === '') return { ok: true, value: undefined };
  try {
    return { ok: true, value: JSON.parse(str) };
  } catch (e) {
    return { ok: false, error: e };
  }
}

export function safeParse(str, fallback) {
  const r = tryParse(str);
  return r.ok ? r.value : fallback;
}

// Authoritative validity check (matches design's isJSONValid): empty is valid.
export function isJSONValid(str) {
  if (str == null || String(str).trim() === '') return true;
  try {
    JSON.parse(str);
    return true;
  } catch {
    return false;
  }
}

// Pretty-print either a JS value or a JSON string. Non-JSON strings pass through.
export function pretty(objOrStr) {
  if (typeof objOrStr === 'string') {
    try {
      return JSON.stringify(JSON.parse(objOrStr), null, 2);
    } catch {
      return objOrStr;
    }
  }
  try {
    return JSON.stringify(objOrStr, null, 2);
  } catch {
    return String(objOrStr);
  }
}

// Resolve a dot-path ("data.object.amount") into a parsed object. Supports
// numeric array indices. Returns undefined when any segment is missing.
export function getPath(obj, path) {
  if (obj == null || !path) return undefined;
  const parts = String(path).split('.');
  let cur = obj;
  for (const p of parts) {
    if (cur == null) return undefined;
    cur = cur[p];
  }
  return cur;
}

// Serialize a value for a JSON TEXT column (objects → JSON, null → null).
export function toColumn(v) {
  if (v == null) return null;
  if (typeof v === 'string') return v;
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

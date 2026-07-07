// Field extraction + operator evaluation for mock scenario rules and webhook
// forwarding rules.
import { getHeader } from './hmac.js';
import { getPath } from './json.js';

// Extract a value from the request context for a given field/key.
// ctx: { method, path, headers, query, bodyObj }
export function extractField(field, key, ctx) {
  switch (field) {
    case 'header': return getHeader(ctx.headers, key);
    case 'query': return ctx.query ? ctx.query[key] : undefined;
    case 'body': return getPath(ctx.bodyObj, key);
    case 'method': return ctx.method;
    case 'path': return ctx.path;
    default: return undefined;
  }
}

export function compareOp(op, actual, expected) {
  const a = actual;
  const e = expected;
  switch (op) {
    case 'equals': return String(a) === String(e);
    case '≠':
    case 'ne':
    case 'not_equal': return String(a) !== String(e);
    case 'contains': return a != null && String(a).includes(String(e));
    case 'exists': return a != null && a !== '';
    case 'regex':
      try { return new RegExp(String(e)).test(String(a == null ? '' : a)); }
      catch { return false; }
    case '>': return Number(a) > Number(e);
    case '<': return Number(a) < Number(e);
    default: return false;
  }
}

// Evaluate a single rule ({ when|field, key, op, value }) against the context.
export function matchRule(rule, ctx) {
  const field = rule.when || rule.field;
  const actual = extractField(field, rule.key, ctx);
  return compareOp(rule.op, actual, rule.value);
}

// Mock scenario resolution: first match_rule (top-to-bottom) whose condition
// holds selects its `then` scenario id. Returns { scenarioId, ruleId } or null.
export function resolveScenarioRule(rules, ctx) {
  for (const r of rules || []) {
    if (r.enabled === false) continue;
    if (r.then && matchRule(r, ctx)) return { scenarioId: r.then, ruleId: r.id };
  }
  return null;
}

// Webhook forwarding: choose the winning rule.
// mode 'any' -> first enabled rule whose condition matches.
// mode 'all' -> if every enabled rule matches, the first enabled rule wins.
export function evaluateForwarding(rules, mode, ctx) {
  const enabled = (rules || []).filter((r) => r.enabled);
  if (!enabled.length) return null;
  if (mode === 'all') {
    return enabled.every((r) => matchRule(r, ctx)) ? enabled[0] : null;
  }
  for (const r of enabled) {
    if (matchRule(r, ctx)) return r;
  }
  return null;
}

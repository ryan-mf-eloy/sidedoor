// Form validation, ported from the design's validateInsp / validateMock.
import { isJSONValid } from './json.js';

const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

// Webhook (inspector) creation. `existingSlugs` is the set of slugs already in use.
export function validateInspector(f, existingSlugs = []) {
  const e = {};
  if (!f.name || !String(f.name).trim()) e.name = 'Enter a name for this endpoint';
  if (!f.slug || !String(f.slug).trim()) e.slug = 'A slug is required';
  else if (!SLUG_RE.test(f.slug)) e.slug = 'Lowercase letters, numbers and hyphens only';
  else if (existingSlugs.includes(f.slug)) e.slug = 'That slug is already in use';
  return e;
}

// Mock creation.
export function validateMock(m, existingSlugs = []) {
  const e = {};
  if (!m.name || !String(m.name).trim()) e.name = 'Enter a name for this mock';
  if (!m.path || !String(m.path).trim()) e.path = 'A path is required';
  else if (String(m.path).charAt(0) !== '/') e.path = 'Path must start with a slash';
  const st = Number(m.status);
  if (!Number.isInteger(st) || st < 100 || st > 599) e.status = 'Use a status from 100–599';
  if (!isJSONValid(m.body)) e.body = 'Response body is not valid JSON';
  if (m.slug && existingSlugs.includes(m.slug)) e.slug = 'That slug is already in use';
  return e;
}

export function isEmpty(errors) {
  return !errors || Object.keys(errors).length === 0;
}

export { SLUG_RE };

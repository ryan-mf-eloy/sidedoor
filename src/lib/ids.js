// ID and slug helpers.
import { randomUUID, randomBytes } from 'node:crypto';

// Short, collision-resistant id with a readable prefix, e.g. "ep-3f9a2c1b".
export function newId(prefix = 'id') {
  return `${prefix}-${randomBytes(6).toString('hex')}`;
}

export function uuid() {
  return randomUUID();
}

// Ported verbatim from the design's slugify(): lowercase, non-alphanumerics to
// hyphens, trimmed of leading/trailing hyphens.
export function slugify(v) {
  return String(v || '')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

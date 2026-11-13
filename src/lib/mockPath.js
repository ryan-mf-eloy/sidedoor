// Path/method matching helpers for mock endpoints.
import { randomUUID } from 'node:crypto';

export function allowedMethods(ep) {
  if (ep.allowed_methods) {
    try {
      const parsed = JSON.parse(ep.allowed_methods);
      if (Array.isArray(parsed) && parsed.length) return parsed.map(String);
    } catch {
      /* ignore */
    }
  }
  return ep.method ? [String(ep.method)] : [];
}

export function methodMatches(ep, method) {
  const methods = allowedMethods(ep);
  if (!methods.length) return true;
  return methods.includes(String(method || '').toUpperCase());
}

export function pathMatches(ep, subpath) {
  const configured = ep.path || '';
  const normalized = subpath || '/';
  if (normalized === '/') {
    const mode = ep.path_mode || ep.pathMode || 'exact';
    if (mode === 'exact') return true;
    return !configured || configured === '/';
  }
  if (!configured) return true;
  const mode = ep.path_mode || ep.pathMode || 'exact';
  if (mode === 'prefix') {
    const segmentPrefix = configured.endsWith('/') ? configured : `${configured}/`;
    return normalized === configured || normalized.startsWith(segmentPrefix);
  }
  return normalized === configured;
}

export function pathPaymentId(subpath) {
  const match = /^\/1\/sales\/([^/?]+)/.exec(String(subpath || ''));
  return match ? match[1] : '';
}

function readBodyPath(bodyObj, dottedPath) {
  if (!bodyObj || typeof bodyObj !== 'object' || !dottedPath) return '';
  return dottedPath.split('.').reduce((acc, key) => {
    if (acc == null || typeof acc !== 'object') return '';
    return acc[key];
  }, bodyObj);
}

export function renderScenarioBody(template, mctx) {
  const raw = template == null ? '' : String(template);
  if (!raw.includes('{{')) return raw;
  const paymentId = pathPaymentId(mctx.subpath || mctx.path || '');
  return raw
    .replace(/\{\{randomUuid\}\}/g, () => randomUUID())
    .replace(/\{\{pendingPaymentId\}\}/g, () => `pending-${randomUUID()}`)
    .replace(/\{\{paidPaymentId\}\}/g, () => `paid-${randomUUID()}`)
    .replace(/\{\{refundedPaymentId\}\}/g, () => `refunded-${randomUUID()}`)
    .replace(/\{\{deniedPaymentId\}\}/g, () => `denied-${randomUUID()}`)
    .replace(/\{\{\$pathPaymentId\}\}/g, paymentId)
    .replace(/\{\{\$body\.([^}]+)\}\}/g, (_all, path) => String(readBodyPath(mctx.bodyObj, path) || ''));
}

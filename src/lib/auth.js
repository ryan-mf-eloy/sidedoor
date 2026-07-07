// Request authentication checks for endpoints that require credentials.
import { timingSafeEqual } from 'node:crypto';
import { getHeader } from './hmac.js';

function safeEqual(a, b) {
  const ba = Buffer.from(String(a == null ? '' : a));
  const bb = Buffer.from(String(b == null ? '' : b));
  if (ba.length !== bb.length) return false;
  try { return timingSafeEqual(ba, bb); } catch { return false; }
}

// Verify a request against an endpoint's auth config.
// Returns { ok:true } or { ok:false, reason }.
//
// An endpoint with auth "enabled" but no credential actually configured yet
// (e.g. right after creation, before the user pastes a token) must never
// accept requests just because the configured value is also empty — a bare
// `X-Api-Key:` header or `Basic <base64(":")>` would otherwise match an
// empty stored value via safeEqual('', ''). Each method checks its
// configured secret is non-empty before comparing anything presented.
export function verifyAuth(cfg, { headers = {}, query = {} } = {}) {
  if (!cfg || !cfg.enabled || cfg.method === 'none') return { ok: true };

  if (cfg.method === 'bearer') {
    if (!cfg.token) return { ok: false, reason: 'not-configured' };
    const raw = getHeader(headers, cfg.header || 'Authorization') || '';
    const m = /^Bearer\s+(.*)$/i.exec(String(raw).trim());
    if (!m) return { ok: false, reason: 'missing-bearer' };
    return safeEqual(m[1], cfg.token) ? { ok: true } : { ok: false, reason: 'bad-token' };
  }

  if (cfg.method === 'apikey') {
    if (!cfg.token) return { ok: false, reason: 'not-configured' };
    const name = cfg.apiKeyName || 'X-Api-Key';
    const provided = cfg.apiKeyLoc === 'query' ? query[name] : getHeader(headers, name);
    if (provided == null || provided === '') return { ok: false, reason: 'missing-apikey' };
    return safeEqual(provided, cfg.token) ? { ok: true } : { ok: false, reason: 'bad-apikey' };
  }

  if (cfg.method === 'basic') {
    // Both halves must be set, not just "not both empty" — a config with
    // only a username and an empty password is still bypassable by sending
    // that same empty password (safeEqual('', '') would match).
    if (!cfg.user || !cfg.pass) return { ok: false, reason: 'not-configured' };
    const raw = getHeader(headers, 'Authorization') || '';
    const m = /^Basic\s+(.*)$/i.exec(String(raw).trim());
    if (!m) return { ok: false, reason: 'missing-basic' };
    let decoded = '';
    try { decoded = Buffer.from(m[1], 'base64').toString('utf8'); } catch { return { ok: false, reason: 'bad-basic' }; }
    const idx = decoded.indexOf(':');
    const user = idx >= 0 ? decoded.slice(0, idx) : decoded;
    const pass = idx >= 0 ? decoded.slice(idx + 1) : '';
    const okUser = safeEqual(user, cfg.user || '');
    const okPass = safeEqual(pass, cfg.pass || '');
    return okUser && okPass ? { ok: true } : { ok: false, reason: 'bad-credentials' };
  }

  return { ok: true };
}

export function failStatus(cfg) {
  const n = parseInt(cfg && cfg.failStatus, 10);
  return Number.isInteger(n) && n >= 100 && n <= 599 ? n : 401;
}

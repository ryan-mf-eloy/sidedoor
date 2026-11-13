// HMAC signature computation and verification with provider presets.
// Presets mirror the design's HMAC_PRESETS and drive the settings UI defaults.
import { createHmac, timingSafeEqual } from 'node:crypto';

export const HMAC_PRESETS = {
  stripe:  { algo: 'sha256', header: 'Stripe-Signature',      encoding: 'hex',    scheme: 'stripe' },
  github:  { algo: 'sha256', header: 'X-Hub-Signature-256',   encoding: 'hex',    scheme: 'prefix', prefix: 'sha256=' },
  shopify: { algo: 'sha256', header: 'X-Shopify-Hmac-Sha256', encoding: 'base64', scheme: 'body' },
  twilio:  { algo: 'sha1',   header: 'X-Twilio-Signature',    encoding: 'base64', scheme: 'body' },
  slack:   { algo: 'sha256', header: 'X-Slack-Signature',     encoding: 'hex',    scheme: 'slack', prefix: 'v0=' },
  custom:  { algo: 'sha256', header: 'X-Signature',           encoding: 'hex',    scheme: 'body' },
};

export function presetFor(provider) {
  return HMAC_PRESETS[provider] || HMAC_PRESETS.custom;
}

// Case-insensitive header lookup over a plain (already-lowercased) header map or
// a raw map with mixed case.
export function getHeader(headers, name) {
  if (!headers || !name) return undefined;
  const target = String(name).toLowerCase();
  if (Object.prototype.hasOwnProperty.call(headers, target)) return headers[target];
  for (const k of Object.keys(headers)) {
    if (k.toLowerCase() === target) return headers[k];
  }
  return undefined;
}

export function compute(algo, secret, payload, encoding) {
  const h = createHmac(algo, secret);
  h.update(payload, 'utf8');
  return h.digest(encoding);
}

// Build an outbound signature using the same provider presets used for
// inbound verification. This deliberately returns only request headers; the
// secret and the computed signature never enter delivery history.
export function buildOutboundHmacHeaders(cfg, { body = '', now = Date.now() } = {}) {
  if (!cfg || !cfg.enabled) return {};
  const secret = cfg.secret || '';
  if (!secret) throw new Error('HMAC secret is required');
  const preset = presetFor(cfg.provider);
  const algo = cfg.algo || preset.algo;
  const encoding = cfg.encoding || preset.encoding;
  const header = cfg.header || preset.header;
  const timestamp = String(Math.floor(Number(now) / 1000));
  let signature;
  const output = {};

  if (preset.scheme === 'stripe') {
    signature = `t=${timestamp},v1=${compute(algo, secret, `${timestamp}.${body}`, encoding)}`;
  } else if (preset.scheme === 'slack') {
    signature = `${preset.prefix || 'v0='}${compute(algo, secret, `v0:${timestamp}:${body}`, encoding)}`;
    output['X-Slack-Request-Timestamp'] = timestamp;
  } else {
    signature = compute(algo, secret, body, encoding);
    if (preset.scheme === 'prefix' && preset.prefix) signature = preset.prefix + signature;
  }

  output[header] = signature;
  return output;
}

function safeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) return false;
  try {
    return timingSafeEqual(ba, bb);
  } catch {
    return false;
  }
}

// Parse "t=123,v1=abc,v0=def" style multi-part signature headers.
function parseParts(value) {
  const out = {};
  for (const seg of String(value || '').split(',')) {
    const i = seg.indexOf('=');
    if (i > 0) out[seg.slice(0, i).trim()] = seg.slice(i + 1).trim();
  }
  return out;
}

// Verify a request against an endpoint's HMAC config.
// Returns { result: 'valid'|'invalid'|'skipped', expected, provided, reason }.
//
// 'skipped' means verification wasn't requested at all (hmac disabled) — the
// only case where letting a request through is the deliberate default. Once
// enabled but with no secret configured yet, we cannot verify anything, so
// that must count as 'invalid' (not 'skipped'), so the existing `reject`
// toggle still governs whether such requests are blocked. Treating a missing
// secret as a silent bypass would make the "Verify HMAC signatures" toggle
// look active while doing nothing.
export function verify(cfg, { headers, rawBody, now = Date.now() }) {
  if (!cfg || !cfg.enabled) return { result: 'skipped', reason: 'disabled' };
  const secret = cfg.secret || '';
  if (!secret) return { result: 'invalid', reason: 'no-secret-configured' };

  const preset = presetFor(cfg.provider);
  const algo = cfg.algo || preset.algo;
  const encoding = cfg.encoding || preset.encoding;
  const headerName = cfg.header || preset.header;
  const scheme = preset.scheme;
  const body = rawBody == null ? '' : String(rawBody);
  const provided = getHeader(headers, headerName);
  if (provided == null || provided === '') {
    return { result: 'invalid', reason: 'missing-signature' };
  }

  const tolerance = parseInt(cfg.tolerance, 10);
  let signedPayload = body;
  let providedSig = String(provided).trim();

  if (scheme === 'stripe') {
    const parts = parseParts(provided);
    const t = parts.t;
    providedSig = parts.v1 || parts.v0 || '';
    if (!t || !providedSig) return { result: 'invalid', reason: 'malformed-header' };
    signedPayload = `${t}.${body}`;
    if (Number.isFinite(tolerance) && tolerance > 0) {
      const skew = Math.abs(now / 1000 - Number(t));
      if (!Number.isFinite(Number(t)) || skew > tolerance) {
        return { result: 'invalid', reason: 'timestamp-out-of-tolerance' };
      }
    }
  } else if (scheme === 'slack') {
    const ts = getHeader(headers, 'X-Slack-Request-Timestamp');
    signedPayload = `v0:${ts || ''}:${body}`;
    if (preset.prefix && providedSig.startsWith(preset.prefix)) {
      providedSig = providedSig.slice(preset.prefix.length);
    }
    if (Number.isFinite(tolerance) && tolerance > 0 && ts) {
      const skew = Math.abs(now / 1000 - Number(ts));
      if (skew > tolerance) return { result: 'invalid', reason: 'timestamp-out-of-tolerance' };
    }
  } else if (scheme === 'prefix') {
    if (preset.prefix && providedSig.startsWith(preset.prefix)) {
      providedSig = providedSig.slice(preset.prefix.length);
    }
  }

  const expected = compute(algo, secret, signedPayload, encoding);
  const ok = safeEqual(expected, providedSig);
  return { result: ok ? 'valid' : 'invalid', expected, provided: providedSig };
}

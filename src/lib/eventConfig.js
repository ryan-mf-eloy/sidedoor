// Validation, normalization and safe presentation helpers for outbound
// scenario events. Kept independent from routes so the same rules apply to
// the UI, manual test runs and runtime dispatch.
import { presetFor } from './hmac.js';

export const EVENT_LIMITS = Object.freeze({
  maxEventsPerScenario: 50,
  maxRepeatCount: 100,
  maxRetryCount: 10,
  maxDelayMs: 60 * 60 * 1000,
  minRetryBaseDelayMs: 250,
  maxTimeoutMs: 60_000,
  minTimeoutMs: 1_000,
});

export class EventConfigError extends Error {
  constructor(message, field) {
    super(message);
    this.name = 'EventConfigError';
    this.field = field || null;
  }
}

export function defaultOutboundAuth() {
  return { enabled: false, method: 'none', header: 'Authorization', token: '', apiKeyName: 'X-Api-Key', apiKeyLoc: 'header', user: '', pass: '' };
}

export function defaultOutboundHmac() {
  return { enabled: false, provider: 'custom', secret: '', algo: 'sha256', header: 'X-Signature', encoding: 'hex' };
}

export function defaultScenarioEvent() {
  return {
    name: 'Async event',
    enabled: true,
    request: {
      url: '', method: 'POST', headers: {}, contentType: 'application/json', payload: '',
      auth: defaultOutboundAuth(), hmac: defaultOutboundHmac(), timeoutMs: 10_000,
    },
    schedule: { delayMs: 0, repeatCount: 1, repeatIntervalMs: 0, retryCount: 0, retryBaseDelayMs: EVENT_LIMITS.minRetryBaseDelayMs },
  };
}

function object(value, field) {
  if (value == null) return {};
  if (typeof value !== 'object' || Array.isArray(value)) throw new EventConfigError(`${field} must be an object`, field);
  return value;
}

function string(value, field, { required = false, max = 16_384 } = {}) {
  const result = value == null ? '' : String(value);
  if (required && !result.trim()) throw new EventConfigError(`${field} is required`, field);
  if (result.length > max) throw new EventConfigError(`${field} is too long`, field);
  return result;
}

function integer(value, field, min, max) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < min || number > max) {
    throw new EventConfigError(`${field} must be an integer from ${min} to ${max}`, field);
  }
  return number;
}

export function isUnsafeHeaderName(name) {
  const value = String(name || '').toLowerCase();
  return value === 'host' || value === 'content-length' || value === 'connection' || value === 'keep-alive'
    || value === 'proxy-authenticate' || value === 'proxy-authorization' || value === 'te'
    || value === 'trailer' || value === 'transfer-encoding' || value === 'upgrade' || value === 'expect'
    || value.startsWith('proxy-');
}

export function validateHeader(name, value, field = 'headers') {
  const headerName = String(name || '').trim();
  if (!/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(headerName)) throw new EventConfigError(`Invalid header name "${headerName}"`, field);
  if (isUnsafeHeaderName(headerName)) throw new EventConfigError(`Header "${headerName}" is not allowed for outbound events`, field);
  const headerValue = String(value == null ? '' : value);
  if (/[\r\n\u0000]/.test(headerValue)) throw new EventConfigError(`Header "${headerName}" contains an unsafe value`, field);
  return [headerName, headerValue];
}

function originPrefix(raw) {
  const match = /^(https?:\/\/[^/?#]+)(?=[/?#]|$)/i.exec(raw);
  if (!match) throw new EventConfigError('URL must be an absolute HTTP or HTTPS URL', 'request.url');
  return match[1];
}

// Template substitutions are deliberately forbidden in the origin. This lets
// callers vary a path or query safely without turning a public mock endpoint
// into a host-selection / SSRF primitive.
export function validateEventUrlTemplate(value) {
  const raw = string(value, 'request.url', { required: true, max: 8_192 }).trim();
  if (raw.includes('#')) throw new EventConfigError('URL fragments are not supported', 'request.url');
  const prefix = originPrefix(raw);
  if (prefix.includes('{{') || prefix.includes('}}')) throw new EventConfigError('Templates are allowed only in the URL path or query', 'request.url');
  const replaced = raw.replace(/\{\{[^{}]+\}\}/g, 'template-value');
  let parsed;
  try { parsed = new URL(replaced); } catch { throw new EventConfigError('Invalid event URL', 'request.url'); }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new EventConfigError('Only HTTP and HTTPS event URLs are allowed', 'request.url');
  if (parsed.username || parsed.password) throw new EventConfigError('Event URLs cannot contain credentials', 'request.url');
  return { url: raw, origin: parsed.origin };
}

export function validateRenderedEventUrl(value, expectedOrigin) {
  let parsed;
  try { parsed = new URL(String(value)); } catch { throw new EventConfigError('Rendered event URL is invalid', 'request.url'); }
  if ((parsed.protocol !== 'http:' && parsed.protocol !== 'https:') || parsed.username || parsed.password) {
    throw new EventConfigError('Rendered event URL is not allowed', 'request.url');
  }
  if (expectedOrigin && parsed.origin !== expectedOrigin) throw new EventConfigError('Templates cannot change the event URL origin', 'request.url');
  return parsed;
}

function normalizeAuth(value) {
  const raw = { ...defaultOutboundAuth(), ...object(value, 'request.auth') };
  const method = String(raw.method || 'none').toLowerCase();
  if (!['none', 'bearer', 'apikey', 'basic'].includes(method)) throw new EventConfigError('Unsupported authentication method', 'request.auth.method');
  const enabled = !!raw.enabled && method !== 'none';
  const result = {
    enabled, method, header: string(raw.header || 'Authorization', 'request.auth.header', { max: 256 }),
    token: string(raw.token, 'request.auth.token', { max: 16_384 }),
    apiKeyName: string(raw.apiKeyName || 'X-Api-Key', 'request.auth.apiKeyName', { max: 256 }),
    apiKeyLoc: raw.apiKeyLoc === 'query' ? 'query' : 'header',
    user: string(raw.user, 'request.auth.user', { max: 8_192 }),
    pass: string(raw.pass, 'request.auth.pass', { max: 16_384 }),
  };
  if (method === 'bearer') validateHeader(result.header, '', 'request.auth.header');
  if (method === 'apikey' && result.apiKeyLoc === 'header') validateHeader(result.apiKeyName, '', 'request.auth.apiKeyName');
  if (method === 'basic') validateHeader(result.header, '', 'request.auth.header');
  if (enabled && (method === 'bearer' || method === 'apikey') && !result.token) throw new EventConfigError('Authentication credential is required', 'request.auth.token');
  if (enabled && method === 'basic' && (!result.user || !result.pass)) throw new EventConfigError('Both Basic authentication credentials are required', 'request.auth');
  return result;
}

function normalizeHmac(value) {
  const supplied = object(value, 'request.hmac');
  const providerInput = String(supplied.provider || 'custom').toLowerCase();
  const providerPreset = presetFor(providerInput);
  const providerDefaults = providerInput === 'custom'
    ? defaultOutboundHmac()
    : { ...defaultOutboundHmac(), provider: providerInput, algo: providerPreset.algo, header: providerPreset.header, encoding: providerPreset.encoding };
  const raw = { ...providerDefaults, ...supplied };
  const provider = String(raw.provider || 'custom').toLowerCase();
  const preset = presetFor(provider);
  const enabled = !!raw.enabled;
  const algo = String(raw.algo || preset.algo).toLowerCase();
  const encoding = String(raw.encoding || preset.encoding).toLowerCase();
  const header = string(raw.header || preset.header, 'request.hmac.header', { max: 256 });
  if (!['sha1', 'sha256', 'sha384', 'sha512'].includes(algo)) throw new EventConfigError('Unsupported HMAC algorithm', 'request.hmac.algo');
  if (!['hex', 'base64', 'base64url'].includes(encoding)) throw new EventConfigError('Unsupported HMAC encoding', 'request.hmac.encoding');
  validateHeader(header, '', 'request.hmac.header');
  const secret = string(raw.secret, 'request.hmac.secret', { max: 16_384 });
  if (enabled && !secret) throw new EventConfigError('HMAC secret is required', 'request.hmac.secret');
  return { enabled, provider: Object.prototype.hasOwnProperty.call({ stripe: 1, github: 1, shopify: 1, twilio: 1, slack: 1, custom: 1 }, provider) ? provider : 'custom', secret, algo, header, encoding };
}

function normalizeRequest(value) {
  const raw = { ...defaultScenarioEvent().request, ...object(value, 'request') };
  const urlInfo = validateEventUrlTemplate(raw.url);
  const method = string(raw.method || 'POST', 'request.method', { required: true, max: 32 }).toUpperCase();
  if (!/^[!#$%&'*+\-.^_`|~0-9A-Z]+$/.test(method) || ['CONNECT', 'TRACE', 'TRACK'].includes(method)) {
    throw new EventConfigError('Unsupported outbound HTTP method', 'request.method');
  }
  const headers = {};
  const rawHeaders = object(raw.headers, 'request.headers');
  if (Object.keys(rawHeaders).length > 64) throw new EventConfigError('At most 64 custom headers are allowed', 'request.headers');
  for (const [key, value] of Object.entries(rawHeaders)) {
    const [name, headerValue] = validateHeader(key, value, 'request.headers');
    headers[name] = headerValue;
  }
  const contentType = string(raw.contentType || '', 'request.contentType', { max: 256 });
  if (/[\r\n\u0000]/.test(contentType)) throw new EventConfigError('Content type contains an unsafe value', 'request.contentType');
  return {
    url: urlInfo.url, origin: urlInfo.origin, method, headers, contentType,
    payload: string(raw.payload, 'request.payload', { max: 1_048_576 }),
    auth: normalizeAuth(raw.auth), hmac: normalizeHmac(raw.hmac),
    timeoutMs: integer(raw.timeoutMs == null ? 10_000 : raw.timeoutMs, 'request.timeoutMs', EVENT_LIMITS.minTimeoutMs, EVENT_LIMITS.maxTimeoutMs),
  };
}

function normalizeSchedule(value) {
  const raw = { ...defaultScenarioEvent().schedule, ...object(value, 'schedule') };
  return {
    delayMs: integer(raw.delayMs == null ? 0 : raw.delayMs, 'schedule.delayMs', 0, EVENT_LIMITS.maxDelayMs),
    repeatCount: integer(raw.repeatCount == null ? 1 : raw.repeatCount, 'schedule.repeatCount', 1, EVENT_LIMITS.maxRepeatCount),
    repeatIntervalMs: integer(raw.repeatIntervalMs == null ? 0 : raw.repeatIntervalMs, 'schedule.repeatIntervalMs', 0, EVENT_LIMITS.maxDelayMs),
    retryCount: integer(raw.retryCount == null ? 0 : raw.retryCount, 'schedule.retryCount', 0, EVENT_LIMITS.maxRetryCount),
    retryBaseDelayMs: integer(raw.retryBaseDelayMs == null ? EVENT_LIMITS.minRetryBaseDelayMs : raw.retryBaseDelayMs, 'schedule.retryBaseDelayMs', EVENT_LIMITS.minRetryBaseDelayMs, EVENT_LIMITS.maxDelayMs),
  };
}

export function normalizeScenarioEvent(input, current = null) {
  const base = current || defaultScenarioEvent();
  const raw = object(input, 'event');
  const requestPatch = object(raw.request, 'request');
  const hmacPatch = object(requestPatch.hmac, 'request.hmac');
  const currentHmac = base.request.hmac || defaultOutboundHmac();
  const providerChanged = hmacPatch.provider != null
    && String(hmacPatch.provider).toLowerCase() !== String(currentHmac.provider || 'custom').toLowerCase();
  const name = string(raw.name == null ? base.name : raw.name, 'name', { required: true, max: 160 }).trim();
  return {
    name,
    enabled: raw.enabled == null ? !!base.enabled : !!raw.enabled,
    request: normalizeRequest({
      ...base.request,
      ...requestPatch,
      auth: { ...base.request.auth, ...object(requestPatch.auth, 'request.auth') },
      // A partial PATCH retains its secret/configuration. Changing provider
      // intentionally starts from that provider's signing defaults.
      hmac: providerChanged ? hmacPatch : { ...currentHmac, ...hmacPatch },
    }),
    schedule: normalizeSchedule({ ...base.schedule, ...object(raw.schedule, 'schedule') }),
  };
}

export function isRetryableDelivery(status, error) {
  if (error) return true;
  const value = Number(status);
  return value === 408 || value === 425 || value === 429 || (value >= 500 && value <= 599);
}

export function retryDelayMs(baseDelayMs, completedAttempts) {
  const base = Math.max(EVENT_LIMITS.minRetryBaseDelayMs, Number(baseDelayMs) || EVENT_LIMITS.minRetryBaseDelayMs);
  return Math.min(EVENT_LIMITS.maxDelayMs, base * (2 ** Math.max(0, Number(completedAttempts) - 1)));
}

const SENSITIVE_HEADER = /(^|[-_])(authorization|api[-_]?key|signature|secret|token|cookie|set-cookie)([-_]|$)/i;
const SENSITIVE_QUERY = /^(authorization|api[-_]?key|signature|secret|token|access[_-]?token|key|password)$/i;
const SENSITIVE_RESPONSE_KEY = /(authorization|api[-_]?key|signature|secret|token|password|cookie)/i;

export function redactHeaders(headers) {
  const output = {};
  for (const [key, value] of Object.entries(object(headers, 'headers'))) {
    output[key] = SENSITIVE_HEADER.test(key) ? '••••••' : String(value).slice(0, 8_192);
  }
  return output;
}

export function redactEventUrl(value) {
  try {
    const url = new URL(String(value));
    for (const key of [...url.searchParams.keys()]) if (SENSITIVE_QUERY.test(key)) url.searchParams.set(key, '••••••');
    return url.toString();
  } catch {
    return '[invalid URL]';
  }
}

function redactResponseValue(value) {
  if (Array.isArray(value)) return value.map(redactResponseValue);
  if (value && typeof value === 'object') {
    const output = {};
    for (const [key, child] of Object.entries(value)) output[key] = SENSITIVE_RESPONSE_KEY.test(key) ? '••••••' : redactResponseValue(child);
    return output;
  }
  return value;
}

export function redactResponseBody(value) {
  const body = String(value == null ? '' : value).slice(0, 40_000);
  if (!body) return body;
  try { return JSON.stringify(redactResponseValue(JSON.parse(body))); }
  catch {
    // Plain-text bodies have no reliable structure. Cover common key=value
    // forms without attempting lossy general-purpose content inspection.
    return body.replace(/\b(authorization|api[-_]?key|signature|secret|token|password)\s*([:=])\s*[^\s,;]+/gi, '$1$2••••••');
  }
}

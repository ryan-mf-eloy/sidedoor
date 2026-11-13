// Shared realtime configuration, validation, matching and safe history helpers.
// Runtime transports consume these plain data objects; no user configuration is
// ever evaluated as code.
import { redactHeaders, redactResponseBody } from './eventConfig.js';

const MB = 1024 * 1024;
const MAX_CONNECTIONS = 10_000;
const MAX_MESSAGE_BYTES = 16 * MB;
const MAX_MESSAGES_PER_SESSION = 100_000;
const MAX_CAPTURE_BYTES = MB;
const MAX_IDLE_MS = 24 * 60 * 60 * 1000;
const MAX_DELAY_MS = 60 * 60 * 1000;

export const REALTIME_PROTOCOLS = new Set(['websocket', 'socketio', 'graphql']);

export class RealtimeConfigError extends Error {
  constructor(message, field) {
    super(message);
    this.name = 'RealtimeConfigError';
    this.field = field;
  }
}

function text(value, field, { max = 20000, allowEmpty = true } = {}) {
  const result = value == null ? '' : String(value);
  if (!allowEmpty && !result.trim()) throw new RealtimeConfigError(`${field} is required`, field);
  if (result.length > max) throw new RealtimeConfigError(`${field} is too long`, field);
  return result;
}

function bool(value, dflt = false) {
  return value == null ? dflt : !!value;
}

function int(value, dflt, min, max, field) {
  if (value == null || value === '') return dflt;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new RealtimeConfigError(`${field} must be an integer from ${min} to ${max}`, field);
  }
  return parsed;
}

function object(value, field) {
  if (value == null) return {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new RealtimeConfigError(`${field} must be an object`, field);
  return value;
}

function array(value, field) {
  if (value == null) return [];
  if (!Array.isArray(value)) throw new RealtimeConfigError(`${field} must be an array`, field);
  return value;
}

export function defaultRealtimeConfig() {
  return {
    maxConnections: 100,
    maxMessageBytes: MB,
    maxMessagesPerSession: 1000,
    maxPayloadCaptureBytes: 64 * 1024,
    idleTimeoutMs: 2 * 60 * 1000,
    allowedOrigins: ['*'],
    authSource: 'handshake', // handshake | protocol_init | both
    protocolAuthPath: 'authorization',
    messageRate: { enabled: false, limit: 120, window: 'minute' },
  };
}

export function normalizeRealtimeConfig(value, current = defaultRealtimeConfig()) {
  const raw = object(value, 'realtime');
  const base = { ...defaultRealtimeConfig(), ...(current || {}) };
  const source = raw.authSource == null ? base.authSource : String(raw.authSource);
  if (!['handshake', 'protocol_init', 'both'].includes(source)) {
    throw new RealtimeConfigError('authSource must be handshake, protocol_init, or both', 'realtime.authSource');
  }
  const origins = raw.allowedOrigins == null ? base.allowedOrigins : array(raw.allowedOrigins, 'realtime.allowedOrigins')
    .map((origin) => text(origin, 'realtime.allowedOrigins', { max: 512, allowEmpty: false }).trim());
  if (!origins.length) throw new RealtimeConfigError('At least one allowed origin is required', 'realtime.allowedOrigins');
  const rateRaw = raw.messageRate == null ? base.messageRate : object(raw.messageRate, 'realtime.messageRate');
  const window = rateRaw.window == null ? base.messageRate.window : String(rateRaw.window);
  if (!['second', 'minute', 'hour'].includes(window)) throw new RealtimeConfigError('messageRate.window must be second, minute, or hour', 'realtime.messageRate.window');
  return {
    maxConnections: int(raw.maxConnections, base.maxConnections, 1, MAX_CONNECTIONS, 'realtime.maxConnections'),
    maxMessageBytes: int(raw.maxMessageBytes, base.maxMessageBytes, 256, MAX_MESSAGE_BYTES, 'realtime.maxMessageBytes'),
    maxMessagesPerSession: int(raw.maxMessagesPerSession, base.maxMessagesPerSession, 1, MAX_MESSAGES_PER_SESSION, 'realtime.maxMessagesPerSession'),
    maxPayloadCaptureBytes: int(raw.maxPayloadCaptureBytes, base.maxPayloadCaptureBytes, 0, MAX_CAPTURE_BYTES, 'realtime.maxPayloadCaptureBytes'),
    idleTimeoutMs: int(raw.idleTimeoutMs, base.idleTimeoutMs, 0, MAX_IDLE_MS, 'realtime.idleTimeoutMs'),
    allowedOrigins: origins,
    authSource: source,
    protocolAuthPath: text(raw.protocolAuthPath == null ? base.protocolAuthPath : raw.protocolAuthPath, 'realtime.protocolAuthPath', { max: 200, allowEmpty: false }),
    messageRate: {
      enabled: bool(rateRaw.enabled, base.messageRate.enabled),
      limit: int(rateRaw.limit, base.messageRate.limit, 1, 100000, 'realtime.messageRate.limit'),
      window,
    },
  };
}

function jsonValue(value, field, fallback = {}) {
  if (value == null || value === '') return fallback;
  if (typeof value === 'object') return value;
  try { return JSON.parse(String(value)); }
  catch { throw new RealtimeConfigError(`${field} must be valid JSON`, field); }
}

function normalizeAction(value, field) {
  const raw = object(value, field);
  const type = text(raw.type, `${field}.type`, { max: 32, allowEmpty: false });
  if (!['send', 'emit', 'close'].includes(type)) throw new RealtimeConfigError(`${field}.type must be send, emit, or close`, `${field}.type`);
  const delayMs = int(raw.delayMs, 0, 0, MAX_DELAY_MS, `${field}.delayMs`);
  if (type === 'close') {
    return {
      type,
      delayMs,
      code: int(raw.code, 1000, 1000, 4999, `${field}.code`),
      reason: text(raw.reason, `${field}.reason`, { max: 123 }),
    };
  }
  const action = { type, delayMs, payload: raw.payload == null ? '' : raw.payload };
  if (type === 'emit') action.event = text(raw.event, `${field}.event`, { max: 200, allowEmpty: false });
  return action;
}

function normalizeActions(value, field) {
  const items = array(value, field);
  if (items.length > 100) throw new RealtimeConfigError(`${field} can contain at most 100 actions`, field);
  return items.map((item, index) => normalizeAction(item, `${field}.${index}`));
}

export function normalizeRealtimeScript(value, current = null) {
  const raw = object(value, 'script');
  return {
    name: text(raw.name == null ? (current && current.name) || 'Conversation' : raw.name, 'script.name', { max: 120, allowEmpty: false }).trim(),
    enabled: raw.enabled == null ? (current ? current.enabled : true) : !!raw.enabled,
    connectActions: raw.connectActions == null ? (current && current.connectActions) || [] : normalizeActions(raw.connectActions, 'script.connectActions'),
  };
}

export function normalizeRealtimeStep(value, current = null) {
  const raw = object(value, 'step');
  const match = raw.match == null ? (current && current.match) || {} : object(raw.match, 'step.match');
  const kind = match.kind == null ? 'message' : String(match.kind);
  if (!['message', 'event'].includes(kind)) throw new RealtimeConfigError('step.match.kind must be message or event', 'step.match.kind');
  const result = {
    match: {
      kind,
      event: kind === 'event' ? text(match.event, 'step.match.event', { max: 200, allowEmpty: false }) : '',
      payload: match.payload == null ? null : jsonValue(match.payload, 'step.match.payload', null),
      text: match.text == null ? '' : text(match.text, 'step.match.text', { max: 20000 }),
    },
    actions: raw.actions == null ? (current && current.actions) || [] : normalizeActions(raw.actions, 'step.actions'),
  };
  if (result.match.payload == null && !result.match.text && kind !== 'event') {
    throw new RealtimeConfigError('A message step needs text or payload matching', 'step.match');
  }
  return result;
}

export function normalizeGraphqlFixture(value, current = null) {
  const raw = object(value, 'fixture');
  const hasVariablesMatch = Object.prototype.hasOwnProperty.call(raw, 'variablesMatch');
  const type = raw.operationType == null ? (current && current.operationType) || 'query' : String(raw.operationType);
  if (!['query', 'mutation', 'subscription'].includes(type)) throw new RealtimeConfigError('operationType must be query, mutation, or subscription', 'fixture.operationType');
  const response = raw.response == null ? (current && current.response) || {} : jsonValue(raw.response, 'fixture.response');
  if (!response || typeof response !== 'object' || Array.isArray(response)) throw new RealtimeConfigError('fixture.response must be an object', 'fixture.response');
  const events = raw.subscriptionEvents == null ? (current && current.subscriptionEvents) || [] : array(raw.subscriptionEvents, 'fixture.subscriptionEvents');
  if (events.length > 1000) throw new RealtimeConfigError('fixture.subscriptionEvents can contain at most 1000 events', 'fixture.subscriptionEvents');
  return {
    name: text(raw.name == null ? (current && current.name) || 'Fixture' : raw.name, 'fixture.name', { max: 120, allowEmpty: false }).trim(),
    operationName: raw.operationName == null ? (current && current.operationName) || '' : text(raw.operationName, 'fixture.operationName', { max: 200 }),
    documentHash: raw.documentHash == null ? (current && current.documentHash) || '' : text(raw.documentHash, 'fixture.documentHash', { max: 128 }),
    operationType: type,
    variablesMatch: !hasVariablesMatch ? (current && current.variablesMatch) || null : jsonValue(raw.variablesMatch, 'fixture.variablesMatch', null),
    response,
    subscriptionEvents: events.map((event, index) => {
      const item = object(event, `fixture.subscriptionEvents.${index}`);
      return { delayMs: int(item.delayMs, 0, 0, MAX_DELAY_MS, `fixture.subscriptionEvents.${index}.delayMs`), payload: item.payload == null ? {} : jsonValue(item.payload, `fixture.subscriptionEvents.${index}.payload`) };
    }),
    delayMs: int(raw.delayMs, current ? current.delayMs : 0, 0, MAX_DELAY_MS, 'fixture.delayMs'),
    enabled: raw.enabled == null ? (current ? current.enabled : true) : !!raw.enabled,
  };
}

// A JSON fixture matcher is deliberately a structural subset comparison: every
// configured key/value must appear in the incoming payload, while extra client
// variables remain valid. This is deterministic and avoids user-supplied code.
export function payloadMatches(pattern, actual) {
  if (pattern == null) return true;
  if (Array.isArray(pattern)) {
    return Array.isArray(actual) && pattern.length === actual.length && pattern.every((item, index) => payloadMatches(item, actual[index]));
  }
  if (typeof pattern === 'object') {
    return !!actual && typeof actual === 'object' && !Array.isArray(actual)
      && Object.entries(pattern).every(([key, value]) => Object.prototype.hasOwnProperty.call(actual, key) && payloadMatches(value, actual[key]));
  }
  return Object.is(pattern, actual);
}

export function payloadText(value) {
  if (Buffer.isBuffer(value)) return value.toString('base64');
  if (typeof value === 'string') return value;
  try {
    const text = JSON.stringify(value);
    return text == null ? '' : text;
  } catch { return String(value); }
}

export function safeRealtimePayload(value, limit) {
  const raw = payloadText(value);
  const size = Buffer.byteLength(raw);
  const cap = Math.max(0, Number(limit) || 0);
  if (cap === 0) return { payload: '', size, truncated: size > 0 };
  if (size <= cap) return { payload: redactResponseBody(raw), size, truncated: false };
  // Byte-aware truncation avoids persisting more than the configured cap for
  // multi-byte UTF-8 payloads. Strip only an incomplete final code point,
  // rather than letting Buffer#toString add a replacement character.
  const bytes = Buffer.from(raw);
  let end = cap;
  let start = end - 1;
  while (start >= 0 && (bytes[start] & 0xc0) === 0x80) start--;
  if (start >= 0) {
    const lead = bytes[start];
    const expected = lead < 0x80 ? 1 : lead < 0xe0 ? 2 : lead < 0xf0 ? 3 : lead < 0xf8 ? 4 : 1;
    if (end - start < expected) end = start;
  }
  const stored = bytes.subarray(0, end).toString('utf8');
  return { payload: redactResponseBody(stored), size, truncated: true };
}

export function safeRealtimeHeaders(headers) {
  return redactHeaders(headers || {});
}

// Query values are persisted with GraphQL-over-HTTP history. Treat both an
// explicitly sensitive parameter name and nested JSON values as credentials;
// this keeps a GET operation from becoming an accidental token log.
const SENSITIVE_QUERY_KEY = /^(authorization|api[-_]?key|signature|secret|token|access[_-]?token|key|password)$/i;
export function safeRealtimeQuery(query) {
  const output = {};
  for (const [key, value] of Object.entries(query || {})) {
    output[key] = SENSITIVE_QUERY_KEY.test(key)
      ? '••••••'
      : redactResponseBody(String(value == null ? '' : value));
  }
  return output;
}

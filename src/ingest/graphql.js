// GraphQL-over-HTTP endpoint runtime. It reuses the endpoint's normal auth,
// HMAC and rate policies, while fixtures provide deterministic GraphQL results.
import { verifyAuth, failStatus } from '../lib/auth.js';
import { verify as verifyHmac } from '../lib/hmac.js';
import { clampStatus } from './handler.js';
import { safeRealtimeHeaders, safeRealtimePayload, safeRealtimeQuery } from '../lib/realtime.js';
import {
  analyzeGraphqlOperation,
  executeIntrospection,
  fixtureNotFoundResult,
  inspectorOnlyResult,
  invalidOperationResult,
  isIntrospectionOperation,
  selectGraphqlFixture,
  sleep,
} from '../lib/graphql.js';

function contentTypeFor(accept) {
  const value = String(accept || '*/*').toLowerCase();
  if (value.includes('application/graphql-response+json')) return 'application/graphql-response+json; charset=utf-8';
  if (value.includes('*/*') || value.includes('application/json') || !value.trim()) return 'application/json; charset=utf-8';
  return null;
}

function errorResult(message, code) {
  return { errors: [{ message, extensions: { code } }] };
}

function parseVariables(raw) {
  if (raw == null || raw === '') return {};
  if (typeof raw === 'object' && !Array.isArray(raw)) return raw;
  try {
    const value = JSON.parse(String(raw));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('variables must be an object');
    return value;
  } catch (error) {
    throw new Error(error.message === 'variables must be an object' ? error.message : 'variables must be valid JSON');
  }
}

function extractRequest(rc) {
  if (rc.method === 'GET') return {
    query: rc.query.query,
    operationName: rc.query.operationName,
    variables: parseVariables(rc.query.variables),
  };
  if (rc.method !== 'POST') throw Object.assign(new Error('GraphQL accepts GET and POST only'), { status: 405, code: 'METHOD_NOT_ALLOWED' });
  if (!String(rc.contentType || '').toLowerCase().includes('application/json')) {
    throw Object.assign(new Error('GraphQL POST requests must use application/json'), { status: 415, code: 'UNSUPPORTED_MEDIA_TYPE' });
  }
  if (!rc.bodyObj || typeof rc.bodyObj !== 'object' || Array.isArray(rc.bodyObj)) {
    throw Object.assign(new Error('GraphQL POST body must be a JSON object'), { status: 400, code: 'BAD_REQUEST' });
  }
  return {
    query: rc.bodyObj.query,
    operationName: rc.bodyObj.operationName,
    variables: parseVariables(rc.bodyObj.variables),
  };
}

function captureBase(ep, rc) {
  const safeBody = safeRealtimePayload(rc.rawBody || '', ep.config.realtime.maxPayloadCaptureBytes);
  return {
    endpointId: ep.id, method: rc.method, path: rc.path, ip: rc.ip, size: rc.size, receivedAt: Date.now(),
    contentType: rc.contentType, headers: safeRealtimeHeaders(rc.headers), query: safeRealtimeQuery(rc.query), body: safeBody.payload,
    eventLabel: 'GraphQL operation',
  };
}

function json(result) { return JSON.stringify(result == null ? {} : result); }

export async function handleGraphqlHttp(ctx, ep, rc, respond) {
  const store = ctx.store;
  const cfg = ep.config;
  const base = captureBase(ep, rc);
  let signature = null;
  const capture = (extra) => {
    const row = store.insertRequest({ ...base, ...extra });
    store.bumpActivity(ep.id, base.receivedAt);
    ctx.events.broadcast('request', { endpointId: ep.id, request: row });
    return row;
  };
  const responseType = contentTypeFor(rc.headers.accept);
  const reply = (status, result, headers = {}) => {
    const output = json(result);
    respond(status, { 'Content-Type': responseType || 'application/json; charset=utf-8', ...headers }, output);
    const safeOutput = safeRealtimePayload(output, ep.config.realtime.maxPayloadCaptureBytes);
    capture({ status, responseStatus: status, responseHeaders: safeRealtimeHeaders({ 'Content-Type': responseType || 'application/json; charset=utf-8', ...headers }), responseBody: safeOutput.payload, outcome: 'graphql', signature });
  };

  if (!responseType) return reply(406, errorResult('Accept must allow application/graphql-response+json or application/json', 'NOT_ACCEPTABLE'));
  if (rc.subpath && rc.subpath !== '/') return reply(404, errorResult('GraphQL endpoint path not found', 'NOT_FOUND'));

  const auth = verifyAuth(cfg.auth, { headers: rc.headers, query: rc.query });
  if (!auth.ok) return reply(failStatus(cfg.auth), errorResult('Unauthorized', 'UNAUTHENTICATED'));

  if (cfg.hmac.enabled) {
    const checked = verifyHmac(cfg.hmac, { headers: rc.headers, rawBody: rc.rawBody, now: Date.now() });
    signature = checked.result;
    if (checked.result === 'invalid' && cfg.hmac.reject) return reply(401, errorResult('Invalid signature', 'INVALID_SIGNATURE'));
  }
  if (cfg.rate.enabled) {
    const rate = ctx.rateLimiter.check(ep.id, cfg.rate, { ip: rc.ip, headers: rc.headers }, Date.now());
    if (!rate.allowed) {
      const status = clampStatus(cfg.rate.status, 429);
      const headers = cfg.rate.retryAfter && rate.retryAfter ? { 'Retry-After': String(rate.retryAfter) } : {};
      return reply(status, errorResult('Rate limited', 'RATE_LIMITED'), headers);
    }
  }

  let request;
  try { request = extractRequest(rc); }
  catch (error) {
    return reply(error.status || 400, errorResult(error.message, error.code || 'BAD_REQUEST'), error.status === 405 ? { Allow: 'GET, POST' } : {});
  }

  const stored = store.getGraphqlSchema(ep.id);
  let operation;
  try { operation = analyzeGraphqlOperation({ sdl: stored.sdl, ...request }); }
  catch (error) { return reply(500, errorResult(error.message, 'SIDEDOOR_SCHEMA_INVALID')); }
  if (operation.errors.length) return reply(400, invalidOperationResult(operation.errors));
  if (rc.method === 'GET' && operation.operationType !== 'query') {
    return reply(405, errorResult('Only GraphQL queries may use GET', 'METHOD_NOT_ALLOWED'), { Allow: 'POST' });
  }
  if (isIntrospectionOperation(operation)) {
    const result = await executeIntrospection(operation);
    return reply(200, result);
  }
  const fixture = selectGraphqlFixture(store.listGraphqlFixtures(ep.id), operation);
  if (!fixture) return reply(200, ep.type === 'inspector' ? inspectorOnlyResult() : fixtureNotFoundResult());
  await sleep(fixture.delayMs);
  return reply(200, fixture.response);
}

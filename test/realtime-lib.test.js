import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  RealtimeConfigError,
  normalizeGraphqlFixture,
  normalizeRealtimeConfig,
  normalizeRealtimeScript,
  normalizeRealtimeStep,
  payloadMatches,
  safeRealtimePayload,
  safeRealtimeQuery,
} from '../src/lib/realtime.js';
import {
  analyzeGraphqlOperation,
  compileGraphqlSchema,
  operationFingerprint,
  selectGraphqlFixture,
  validateGraphqlSdl,
} from '../src/lib/graphql.js';

test('realtime config keeps safe defaults and rejects unsafe bounds', () => {
  const config = normalizeRealtimeConfig({ maxConnections: 3, allowedOrigins: ['https://app.example.test'] });
  assert.equal(config.maxConnections, 3);
  assert.deepEqual(config.allowedOrigins, ['https://app.example.test']);
  assert.throws(() => normalizeRealtimeConfig({ maxMessageBytes: 10 }), RealtimeConfigError);
  assert.throws(() => normalizeRealtimeConfig({ authSource: 'cookie' }), RealtimeConfigError);
  assert.throws(() => normalizeRealtimeConfig({ allowedOrigins: [] }), RealtimeConfigError);
});

test('script and structural matchers are deterministic', () => {
  const script = normalizeRealtimeScript({ name: 'Checkout', connectActions: [{ type: 'send', payload: { ready: true } }] });
  const step = normalizeRealtimeStep({ match: { kind: 'event', event: 'charge', payload: { amount: 42 } }, actions: [{ type: 'emit', event: 'accepted', payload: { ok: true } }] });
  assert.equal(script.connectActions[0].type, 'send');
  assert.equal(step.match.event, 'charge');
  assert.equal(payloadMatches({ order: { amount: 42 } }, { order: { amount: 42, currency: 'BRL' }, other: true }), true);
  assert.equal(payloadMatches({ amount: 42 }, { amount: 43 }), false);
  assert.throws(() => normalizeRealtimeStep({ match: { kind: 'message' }, actions: [] }), RealtimeConfigError);
});

test('realtime payload previews are byte-capped and redact JSON secrets', () => {
  const redacted = safeRealtimePayload(JSON.stringify({ authorization: 'Bearer hidden', nested: { token: 'hidden-too' } }), 1024);
  assert.match(redacted.payload, /••••••/);
  assert.doesNotMatch(redacted.payload, /hidden/);
  const capped = safeRealtimePayload('á'.repeat(20), 7);
  assert.equal(capped.truncated, true);
  assert.ok(Buffer.byteLength(capped.payload) <= 7);
  const query = safeRealtimeQuery({ token: 'do-not-store', variables: JSON.stringify({ nested: { password: 'do-not-store' } }) });
  assert.equal(query.token, '••••••');
  assert.doesNotMatch(query.variables, /do-not-store/);
});

test('GraphQL SDL and fixture selection prioritize a structural variable matcher', () => {
  const sdl = 'type Query { order(id: ID!): String! }';
  assert.ok(compileGraphqlSchema(sdl));
  const query = 'query Order($id: ID!) { order(id: $id) }';
  const operation = analyzeGraphqlOperation({ sdl, query, variables: { id: 'ord_1', region: 'BR' }, operationName: 'Order' });
  assert.equal(operation.errors.length, 0);
  assert.equal(operation.documentHash, operationFingerprint(query));
  const base = normalizeGraphqlFixture({ name: 'Base', operationName: 'Order', operationType: 'query', response: { data: { order: 'base' } } });
  const specific = normalizeGraphqlFixture({ name: 'Specific', operationName: 'Order', operationType: 'query', variablesMatch: { region: 'BR' }, response: { data: { order: 'specific' } } });
  assert.equal(selectGraphqlFixture([specific, base], operation).name, 'Specific');
  const fallbackOperation = analyzeGraphqlOperation({ sdl, query, variables: { id: 'ord_2' }, operationName: 'Order' });
  assert.equal(selectGraphqlFixture([specific, base], fallbackOperation).name, 'Base');
  const invalid = analyzeGraphqlOperation({ sdl, query: '{ missing }' });
  assert.ok(invalid.errors.length > 0);

  const coercionSdl = 'type Query { count(value: Int!): Int }';
  const coercionQuery = 'query Count($value: Int!) { count(value: $value) }';
  const coerced = analyzeGraphqlOperation({ sdl: coercionSdl, query: coercionQuery, variables: { value: 42 } });
  assert.equal(coerced.errors.length, 0);
  assert.deepEqual(coerced.variables, { value: 42 });
  const wrongType = analyzeGraphqlOperation({ sdl: coercionSdl, query: coercionQuery, variables: { value: 'not-an-int' } });
  assert.ok(wrongType.errors.length > 0);
  const missingRequired = analyzeGraphqlOperation({ sdl: coercionSdl, query: coercionQuery, variables: {} });
  assert.ok(missingRequired.errors.length > 0);

  const invalidSdl = validateGraphqlSdl('type Query { greeting: }');
  assert.equal(invalidSdl.valid, false);
  assert.ok(invalidSdl.message);
});

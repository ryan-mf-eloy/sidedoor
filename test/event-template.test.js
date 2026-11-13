import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { buildEventContext, TemplateError, renderEventTemplate } from '../src/lib/eventTemplate.js';
import {
  EventConfigError,
  isRetryableDelivery,
  normalizeScenarioEvent,
  retryDelayMs,
  validateEventUrlTemplate,
  validateRenderedEventUrl,
} from '../src/lib/eventConfig.js';
import { buildOutboundEventRequest, sendOutboundEvent } from '../src/lib/outbound.js';

function context() {
  return buildEventContext({
    request: {
      method: 'POST', path: '/orders/42', subpath: '/orders/42',
      headers: { 'X-Request-Id': 'req-42' }, query: { source: 'checkout' },
      body: '{"order":{"id":"ord_42"}}',
    },
    response: { status: 202, headers: { 'X-Mock': 'accepted' }, body: '{"id":"mock_42"}' },
  });
}

test('event templates render request and response context, while unknown variables fail closed', () => {
  const rendered = renderEventTemplate(
    '{{request.method}} {{request.path}} {{request.query.source}} {{request.headers.x-request-id}} {{request.body.order.id}} {{response.status}} {{response.body.id}}',
    context(),
  );
  assert.equal(rendered, 'POST /orders/42 checkout req-42 ord_42 202 mock_42');
  assert.throws(() => renderEventTemplate('{{request.body.missing}}', context()), TemplateError);
  assert.throws(() => renderEventTemplate('{{unknown.value}}', context()), TemplateError);
  assert.throws(() => renderEventTemplate('{{request.path}', context()), /Invalid template syntax/);
});

test('event URL and header validation keep the target origin static and safe', () => {
  const valid = validateEventUrlTemplate('https://receiver.example.test/events/{{request.body.order.id}}?source={{request.query.source}}');
  assert.equal(valid.origin, 'https://receiver.example.test');
  assert.equal(validateRenderedEventUrl('https://receiver.example.test/events/ord_42?source=checkout', valid.origin).hostname, 'receiver.example.test');
  assert.throws(() => validateEventUrlTemplate('https://{{request.headers.host}}/events'), EventConfigError);
  assert.throws(() => validateEventUrlTemplate('https://user:password@receiver.example.test/events'), EventConfigError);
  assert.throws(() => validateRenderedEventUrl('https://other.example.test/events', valid.origin), EventConfigError);
  assert.throws(() => normalizeScenarioEvent({ name: 'Unsafe header', request: { url: 'https://receiver.example.test/events', headers: { Host: 'other.example.test' } } }), EventConfigError);
  assert.throws(() => normalizeScenarioEvent({ name: 'Unsafe value', request: { url: 'https://receiver.example.test/events', headers: { 'X-Test': 'a\r\nb' } } }), EventConfigError);
});

test('outbound construction applies authentication, HMAC presets and masks generated headers', () => {
  const event = normalizeScenarioEvent({
    name: 'Notify receiver',
    request: {
      url: 'https://receiver.example.test/events/{{response.body.id}}',
      method: 'POST', payload: '{"result":"{{response.body.id}}"}',
      headers: { 'X-Request': '{{request.headers.x-request-id}}' },
      auth: { enabled: true, method: 'bearer', token: 'test-token' },
      hmac: { enabled: true, provider: 'github', secret: 'test-signing-key' },
    },
  });
  const built = buildOutboundEventRequest(event, context(), 1_700_000_000_000);
  const expected = `sha256=${createHmac('sha256', 'test-signing-key').update('{"result":"mock_42"}').digest('hex')}`;
  assert.equal(built.url, 'https://receiver.example.test/events/mock_42');
  assert.equal(built.headers.Authorization, 'Bearer test-token');
  assert.equal(built.headers['X-Hub-Signature-256'], expected);
  assert.equal(built.safeHeaders.Authorization, '••••••');
  assert.equal(built.safeHeaders['X-Hub-Signature-256'], '••••••');
});

test('outbound history masks custom generated credentials and treats redirects as final failures', async () => {
  const event = normalizeScenarioEvent({
    name: 'Custom credential callback',
    request: {
      url: 'https://receiver.example.test/events',
      auth: { enabled: true, method: 'apikey', apiKeyName: 'receiverCredential', apiKeyLoc: 'query', token: 'example-api-key' },
      hmac: { enabled: true, provider: 'custom', header: 'X-Receiver-Proof', secret: 'example-signing-key' },
    },
  });
  const built = buildOutboundEventRequest(event, context());
  assert.equal(built.safeUrl.includes('example-api-key'), false);
  assert.equal(built.safeHeaders['X-Receiver-Proof'], '••••••');

  let redirectMode = null;
  const redirected = await sendOutboundEvent(event, context(), {
    fetchImpl: async (_url, options) => {
      redirectMode = options.redirect;
      return new Response('', { status: 302, headers: { Location: 'https://elsewhere.example.test' } });
    },
  });
  assert.equal(redirectMode, 'manual');
  assert.equal(redirected.ok, false);
  assert.equal(redirected.retryable, false);

  const networkFailure = await sendOutboundEvent(event, context(), {
    fetchImpl: async (url) => { throw new Error(`Cannot reach ${url}`); },
  });
  assert.equal(networkFailure.error.includes('example-api-key'), false);
});

test('outbound HMAC signs the actual body sent for bodyless methods', () => {
  const event = normalizeScenarioEvent({
    name: 'Bodyless signature',
    request: {
      url: 'https://receiver.example.test/ping', method: 'GET', payload: 'not-sent',
      hmac: { enabled: true, provider: 'custom', secret: 'example-signing-key' },
    },
  });
  const built = buildOutboundEventRequest(event, context());
  const expected = createHmac('sha256', 'example-signing-key').update('').digest('hex');
  assert.equal(built.body, undefined);
  assert.equal(built.headers['X-Signature'], expected);
});

test('partial event updates retain signing credentials while provider changes use presets', () => {
  const current = normalizeScenarioEvent({
    name: 'Signed callback',
    request: {
      url: 'https://receiver.example.test/events',
      hmac: { enabled: true, provider: 'github', secret: 'kept-signing-key' },
    },
  });
  const retained = normalizeScenarioEvent({ request: { hmac: { enabled: false } } }, current);
  assert.equal(retained.request.hmac.secret, 'kept-signing-key');
  assert.equal(retained.request.hmac.provider, 'github');
  assert.equal(retained.request.hmac.header, 'X-Hub-Signature-256');

  const switched = normalizeScenarioEvent({ request: { hmac: { provider: 'slack', secret: 'new-signing-key' } } }, current);
  assert.equal(switched.request.hmac.header, 'X-Slack-Signature');
  assert.equal(switched.request.hmac.algo, 'sha256');
});

test('configuration failures never invoke fetch and retry policy is deterministic', async () => {
  let calls = 0;
  const event = normalizeScenarioEvent({
    name: 'Broken template',
    request: { url: 'https://receiver.example.test/{{request.body.missing}}' },
  });
  const result = await sendOutboundEvent(event, context(), { fetchImpl: async () => { calls++; throw new Error('should not run'); } });
  assert.equal(calls, 0);
  assert.equal(result.kind, 'configuration');
  assert.equal(result.retryable, false);
  assert.equal(isRetryableDelivery(408), true);
  assert.equal(isRetryableDelivery(425), true);
  assert.equal(isRetryableDelivery(429), true);
  assert.equal(isRetryableDelivery(503), true);
  assert.equal(isRetryableDelivery(400), false);
  assert.equal(isRetryableDelivery(302), false);
  assert.equal(retryDelayMs(250, 1), 250);
  assert.equal(retryDelayMs(250, 3), 1000);
});

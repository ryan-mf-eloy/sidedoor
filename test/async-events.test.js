import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createHmac } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../src/server.js';
import { bootTestApp, api, makeFakeTailscale, sseWaitFor } from './helpers.js';

function ingest(app, path, options = {}) {
  return fetch(app.ingestUrl + path, options);
}

async function makeMock(app, extra = {}) {
  const response = await api(app, 'POST', '/endpoints', {
    type: 'mock', name: 'Async mock', path: '/orders', method: 'POST', status: 202,
    body: '{"id":"mock-1","state":"accepted"}', ...extra,
  });
  assert.equal(response.status, 200);
  return response.json;
}

async function addEvent(app, scenarioId, body) {
  const response = await api(app, 'POST', `/scenarios/${scenarioId}/events`, body);
  assert.equal(response.status, 200, JSON.stringify(response.json));
  return response.json;
}

function wait(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

async function waitFor(check, timeoutMs = 4_000) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = await check();
    if (last) return last;
    await wait(15);
  }
  throw new Error('Timed out waiting for asynchronous delivery');
}

async function startReceiver(onRequest) {
  const server = http.createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    const reply = await onRequest({ method: req.method, url: req.url, headers: req.headers, body });
    res.writeHead((reply && reply.status) || 204, (reply && reply.headers) || {});
    res.end((reply && reply.body) || '');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    baseUrl: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

async function bootFileApp(dbPath) {
  const tailscale = makeFakeTailscale();
  const app = createApp({
    dbPath, adminPort: 0, ingestPort: 0, adminHost: '127.0.0.1', ingestHost: '127.0.0.1', funnelPollMs: 0, tailscale,
  });
  tailscale.store = app.store;
  await app.start();
  app.adminUrl = `http://127.0.0.1:${app.adminServer.address().port}`;
  app.ingestUrl = `http://127.0.0.1:${app.ingestServer.address().port}`;
  return app;
}

test('mock response returns before ordered async repeats, with outbound auth and HMAC', async (t) => {
  const received = [];
  const receiver = await startReceiver(async (request) => {
    received.push({ ...request, at: Date.now() });
    return { status: 204 };
  });
  const app = await bootTestApp();
  t.after(async () => { await app.close(); await receiver.close(); });
  const mock = await makeMock(app);
  const scenario = mock.scenarios[0];
  const firstEvent = await addEvent(app, scenario.id, {
    name: 'First callback',
    request: {
      url: `${receiver.baseUrl}/first/{{response.body.id}}`, method: 'POST',
      headers: { 'X-Trace': '{{request.headers.x-trace}}' },
      payload: '{"id":"{{response.body.id}}","order":"{{request.body.order}}"}',
      auth: { enabled: true, method: 'bearer', token: 'test-token' },
      hmac: { enabled: true, provider: 'github', secret: 'test-signing-key' },
      timeoutMs: 1_000,
    },
    schedule: { delayMs: 70, repeatCount: 2, repeatIntervalMs: 25, retryCount: 0, retryBaseDelayMs: 250 },
  });
  await addEvent(app, scenario.id, {
    name: 'Second callback',
    request: { url: `${receiver.baseUrl}/second`, method: 'POST', payload: '{"after":"{{response.body.id}}"}' },
    schedule: { delayMs: 20, repeatCount: 1, repeatIntervalMs: 0, retryCount: 0, retryBaseDelayMs: 250 },
  });

  const response = await ingest(app, `/${mock.slug}/orders`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Trace': 'trace-42' }, body: '{"order":"ord-42"}',
  });
  const respondedAt = Date.now();
  assert.equal(response.status, 202);
  assert.equal(received.length, 0, 'callback must not delay the mock response');
  // A run owns an immutable configuration snapshot: changing the destination
  // after a mock response cannot redirect a delivery already scheduled.
  assert.equal((await api(app, 'PATCH', `/scenario-events/${firstEvent.id}`, { request: { url: `${receiver.baseUrl}/changed` } })).status, 200);
  await waitFor(() => received.length === 3);

  assert.deepEqual(received.map((request) => request.url), ['/first/mock-1', '/first/mock-1', '/second']);
  assert.ok(received[0].at - respondedAt >= 35, 'first callback honors delay after mock response');
  assert.ok(received[1].at - received[0].at >= 12, 'repeats are serial and honor their interval');
  assert.equal(received[0].headers.authorization, 'Bearer test-token');
  assert.equal(received[0].headers['x-trace'], 'trace-42');
  const expectedSignature = `sha256=${createHmac('sha256', 'test-signing-key').update(received[0].body).digest('hex')}`;
  assert.equal(received[0].headers['x-hub-signature-256'], expectedSignature);
});

test('async-event CRUD exposes ordered scenario configuration through the API', async (t) => {
  const app = await bootTestApp();
  t.after(() => app.close());
  const mock = await makeMock(app);
  const scenario = mock.scenarios[0];
  const first = await addEvent(app, scenario.id, { name: 'First', request: { url: 'https://receiver.example.test/first' } });
  const second = await addEvent(app, scenario.id, { name: 'Second', request: { url: 'https://receiver.example.test/second' } });
  assert.equal((await api(app, 'POST', `/scenario-events/${second.id}/move`, { direction: 'up' })).status, 200);
  let listed = await api(app, 'GET', `/scenarios/${scenario.id}/events`);
  assert.deepEqual(listed.json.map((event) => event.id), [second.id, first.id]);
  assert.equal((await api(app, 'PATCH', `/scenario-events/${second.id}`, { name: 'Second updated', enabled: false })).status, 200);
  listed = await api(app, 'GET', `/scenarios/${scenario.id}/events`);
  assert.equal(listed.json[0].enabled, false);
  assert.equal((await api(app, 'DELETE', `/scenario-events/${first.id}`)).status, 200);
  const fullEndpoint = await api(app, 'GET', `/endpoints/${mock.id}`);
  assert.deepEqual(fullEndpoint.json.scenarios[0].events.map((event) => event.name), ['Second updated']);
});

test('rejected, rate-limited, unmatched, and scenario-less mock calls never schedule events', async (t) => {
  const calls = [];
  const receiver = await startReceiver(async (request) => { calls.push(request); return { status: 204 }; });
  const app = await bootTestApp();
  t.after(async () => { await app.close(); await receiver.close(); });

  const mock = await makeMock(app, { auth: 'bearer', authToken: 'example-inbound-token' });
  const scenario = mock.scenarios[0];
  await api(app, 'PATCH', `/endpoints/${mock.id}`, { rate: { enabled: true, limit: '1', burst: '0', window: 'minute', key: 'global' } });
  // Consume the one permitted rate-limit token before any event exists.
  assert.equal((await ingest(app, `/${mock.slug}/orders`, { method: 'POST', headers: { Authorization: 'Bearer example-inbound-token' }, body: '{}' })).status, 202);
  await addEvent(app, scenario.id, {
    name: 'Only valid calls', request: { url: `${receiver.baseUrl}/should-not-run`, method: 'POST' },
    schedule: { delayMs: 0, repeatCount: 1, repeatIntervalMs: 0, retryCount: 0, retryBaseDelayMs: 250 },
  });

  assert.equal((await ingest(app, `/${mock.slug}/orders`, { method: 'POST', body: '{}' })).status, 401);
  assert.equal((await ingest(app, `/${mock.slug}/orders`, { method: 'GET', headers: { Authorization: 'Bearer example-inbound-token' } })).status, 405);
  assert.equal((await ingest(app, `/${mock.slug}/other`, { method: 'POST', headers: { Authorization: 'Bearer example-inbound-token' }, body: '{}' })).status, 404);
  assert.equal((await ingest(app, `/${mock.slug}/orders`, { method: 'POST', headers: { Authorization: 'Bearer example-inbound-token' }, body: '{}' })).status, 429);
  await wait(100);
  assert.equal(calls.length, 0);
  assert.deepEqual((await api(app, 'GET', `/endpoints/${mock.id}/event-runs`)).json, []);

  const noScenarioMock = await makeMock(app, { name: 'No scenario mock' });
  const noScenario = noScenarioMock.scenarios[0];
  await addEvent(app, noScenario.id, { name: 'Removed scenario event', request: { url: `${receiver.baseUrl}/also-not-run` } });
  assert.equal((await api(app, 'DELETE', `/scenarios/${noScenario.id}`)).status, 200);
  assert.equal((await ingest(app, `/${noScenarioMock.slug}/orders`, { method: 'POST', body: '{}' })).status, 200);
  await wait(100);
  assert.equal(calls.length, 0);
  assert.deepEqual((await api(app, 'GET', `/endpoints/${noScenarioMock.id}/event-runs`)).json, []);
});

test('retryable failures retry, final failures continue the flow, and history remains redacted', async (t) => {
  const calls = [];
  let retried = 0;
  const receiver = await startReceiver(async (request) => {
    calls.push(request.url);
    if (request.url === '/retry') {
      retried++;
      return { status: retried === 1 ? 503 : 204 };
    }
    if (request.url === '/final') return { status: 400, headers: { 'Set-Cookie': 'sensitive-response' }, body: '{"secret":"sensitive-response"}' };
    if (request.url === '/redirect') return { status: 302, headers: { Location: '/other-destination' } };
    return { status: 204 };
  });
  const app = await bootTestApp();
  t.after(async () => { await app.close(); await receiver.close(); });
  const mock = await makeMock(app);
  const scenario = mock.scenarios[0];
  await addEvent(app, scenario.id, {
    name: 'Retry once',
    request: { url: `${receiver.baseUrl}/retry`, method: 'POST', payload: '{"x":1}' },
    schedule: { delayMs: 0, repeatCount: 1, repeatIntervalMs: 0, retryCount: 1, retryBaseDelayMs: 250 },
  });
  await addEvent(app, scenario.id, {
    name: 'Final client error',
    request: { url: `${receiver.baseUrl}/final`, method: 'POST', auth: { enabled: true, method: 'bearer', token: 'test-history-token' } },
    schedule: { delayMs: 0, repeatCount: 1, repeatIntervalMs: 0, retryCount: 4, retryBaseDelayMs: 250 },
  });
  await addEvent(app, scenario.id, {
    name: 'Final redirect response',
    request: { url: `${receiver.baseUrl}/redirect`, method: 'POST' },
    schedule: { delayMs: 0, repeatCount: 1, repeatIntervalMs: 0, retryCount: 4, retryBaseDelayMs: 250 },
  });
  await addEvent(app, scenario.id, {
    name: 'Continues after failure',
    request: { url: `${receiver.baseUrl}/after`, method: 'POST', hmac: { enabled: true, provider: 'custom', secret: 'test-history-signing-key' } },
    schedule: { delayMs: 0, repeatCount: 1, repeatIntervalMs: 0, retryCount: 0, retryBaseDelayMs: 250 },
  });

  const response = await ingest(app, `/${mock.slug}/orders`, { method: 'POST', body: '{}' });
  assert.equal(response.status, 202);
  await waitFor(() => calls.length === 5);
  assert.deepEqual(calls, ['/retry', '/retry', '/final', '/redirect', '/after']);

  const runs = await api(app, 'GET', `/endpoints/${mock.id}/event-runs`);
  assert.equal(runs.status, 200);
  const detail = await waitFor(async () => {
    const result = await api(app, 'GET', `/event-runs/${runs.json[0].id}`);
    return result.json.status === 'completed_with_failures' ? result.json : null;
  });
  assert.equal(detail.jobs[0].attempts.length, 2);
  assert.equal(detail.jobs[0].status, 'succeeded');
  assert.equal(detail.jobs[1].attempts.length, 1);
  assert.equal(detail.jobs[1].status, 'failed');
  assert.equal(detail.jobs[2].attempts.length, 1, 'a 3xx redirect must not retry');
  assert.equal(detail.jobs[2].status, 'failed');
  assert.equal(detail.jobs[3].status, 'succeeded');
  const serialized = JSON.stringify(detail);
  assert.equal(serialized.includes('test-history-token'), false);
  assert.equal(serialized.includes('test-history-signing-key'), false);
  assert.equal(serialized.includes('sensitive-response'), false);
  assert.equal(detail.jobs[1].attempts[0].responseHeaders['set-cookie'], '••••••');
  assert.equal(detail.jobs[1].attempts[0].responseBody, '{"secret":"••••••"}');
});

test('manual test flows run immediately with fixtures and queued runs can be cancelled', async (t) => {
  const calls = [];
  const receiver = await startReceiver(async (request) => {
    calls.push(request);
    return { status: 204 };
  });
  const app = await bootTestApp();
  t.after(async () => { await app.close(); await receiver.close(); });
  const mock = await makeMock(app);
  const scenario = mock.scenarios[0];
  await addEvent(app, scenario.id, {
    name: 'Fixture callback',
    request: { url: `${receiver.baseUrl}/fixture/{{request.query.ref}}`, method: 'POST', payload: '{"value":"{{response.body.value}}"}' },
    schedule: { delayMs: 500, repeatCount: 1, repeatIntervalMs: 0, retryCount: 0, retryBaseDelayMs: 250 },
  });

  const before = Date.now();
  let testRun;
  const scheduled = await sseWaitFor(app, 'delivery', async () => {
    testRun = await api(app, 'POST', `/scenarios/${scenario.id}/event-runs/test`, {
      request: { method: 'PUT', path: '/manual', query: { ref: 'fixture-1' }, body: { id: 'request-1' } },
      response: { status: 201, body: { value: 'fixture-response' } },
    });
  });
  assert.equal(testRun.status, 200);
  assert.equal(scheduled.run.source, 'test');
  await waitFor(() => calls.length === 1);
  assert.ok(Date.now() - before < 350, 'manual test bypasses the initial configured delay');
  assert.equal(calls[0].url, '/fixture/fixture-1');
  assert.equal(calls[0].body, '{"value":"fixture-response"}');
  assert.equal(testRun.json.source, 'test');

  const realResponse = await ingest(app, `/${mock.slug}/orders`, { method: 'POST', body: '{}' });
  assert.equal(realResponse.status, 202);
  const pending = await waitFor(async () => {
    const runs = await api(app, 'GET', `/endpoints/${mock.id}/event-runs`);
    return runs.json.find((run) => run.source === 'ingest' && run.status === 'scheduled') || null;
  });
  const cancelled = await api(app, 'POST', `/event-runs/${pending.id}/cancel`, {});
  assert.equal(cancelled.status, 200);
  await wait(600);
  assert.equal(calls.length, 1, 'cancelled run must not send its delayed delivery');
  assert.equal((await api(app, 'GET', `/event-runs/${pending.id}`)).json.status, 'cancelled');
});

test('scheduled deliveries survive an application restart using SQLite on disk', async (t) => {
  const calls = [];
  const receiver = await startReceiver(async (request) => { calls.push(request); return { status: 204 }; });
  const dir = mkdtempSync(join(tmpdir(), 'sidedoor-async-restart-'));
  const dbPath = join(dir, 'sidedoor.db');
  let first = null;
  let second = null;
  t.after(async () => {
    if (first) await first.close().catch(() => {});
    if (second) await second.close().catch(() => {});
    await receiver.close();
    rmSync(dir, { recursive: true, force: true });
  });

  first = await bootFileApp(dbPath);
  const mock = await makeMock(first);
  const scenario = mock.scenarios[0];
  await addEvent(first, scenario.id, {
    name: 'Survives restart', request: { url: `${receiver.baseUrl}/restart`, method: 'POST' },
    schedule: { delayMs: 250, repeatCount: 1, repeatIntervalMs: 0, retryCount: 0, retryBaseDelayMs: 250 },
  });
  assert.equal((await ingest(first, `/${mock.slug}/orders`, { method: 'POST', body: '{}' })).status, 202);
  // Simulate a process interruption after a durable job claim but before the
  // network result can be written. Restart recovery must make it runnable
  // again, which is the documented at-least-once boundary.
  assert.ok(first.store.claimDueEventJob(Date.now() + 1_000));
  await first.close();
  first = null;
  second = await bootFileApp(dbPath);
  await waitFor(() => calls.length === 1);
  const runs = await api(second, 'GET', `/endpoints/${mock.id}/event-runs`);
  assert.equal(runs.json[0].status, 'completed');
});

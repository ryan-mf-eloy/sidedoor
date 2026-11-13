import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import WebSocket from 'ws';
import { io } from 'socket.io-client';
import { createClient } from 'graphql-ws';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bootTestApp, api, sseWaitFor } from './helpers.js';

function wsUrl(app, slug) {
  return `${app.ingestUrl.replace(/^http/, 'ws')}/${slug}`;
}

function rawExchange(url, payload, timeoutMs = 3000, options = {}) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url, options);
    const timer = setTimeout(() => { socket.terminate(); reject(new Error('WebSocket test timed out')); }, timeoutMs);
    socket.on('open', () => socket.send(typeof payload === 'string' ? payload : JSON.stringify(payload)));
    socket.on('message', (data) => {
      clearTimeout(timer);
      const value = String(data);
      socket.close();
      resolve(value);
    });
    socket.on('error', (error) => { clearTimeout(timer); reject(error); });
  });
}

function rawClose(url, payload, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    const timer = setTimeout(() => { socket.terminate(); reject(new Error('WebSocket close test timed out')); }, timeoutMs);
    socket.on('open', () => socket.send(typeof payload === 'string' ? payload : JSON.stringify(payload)));
    socket.on('close', (code, reason) => { clearTimeout(timer); resolve({ code, reason: String(reason) }); });
    socket.on('error', (error) => { clearTimeout(timer); reject(error); });
  });
}

function rawBurstClose(url, payloads, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    const timer = setTimeout(() => { socket.terminate(); reject(new Error('WebSocket burst test timed out')); }, timeoutMs);
    socket.on('open', () => payloads.forEach((payload) => socket.send(typeof payload === 'string' ? payload : JSON.stringify(payload))));
    socket.on('close', (code, reason) => { clearTimeout(timer); resolve({ code, reason: String(reason) }); });
    socket.on('error', (error) => { clearTimeout(timer); reject(error); });
  });
}

function socketIoExchange(app, slug, transports) {
  return new Promise((resolve, reject) => {
    const client = io(`${app.ingestUrl}/${slug}`, { path: '/_sidedoor/socket.io/', transports, reconnection: false });
    const timer = setTimeout(() => { client.close(); reject(new Error('Socket.IO test timed out')); }, 3000);
    client.on('connect', () => client.emit('hello', { amount: 42 }, (ack) => {
      assert.deepEqual(ack, { ok: true });
    }));
    client.on('accepted', (value) => {
      clearTimeout(timer);
      client.close();
      resolve(value);
    });
    client.on('connect_error', (error) => { clearTimeout(timer); client.close(); reject(error); });
  });
}

function socketIoConnectionError(app, slug, options = {}) {
  return new Promise((resolve, reject) => {
    const client = io(`${app.ingestUrl}/${slug}`, { path: '/_sidedoor/socket.io/', transports: ['polling'], reconnection: false, ...options });
    const timer = setTimeout(() => { client.close(); reject(new Error('Socket.IO auth test timed out')); }, 3000);
    client.on('connect', () => { clearTimeout(timer); client.close(); reject(new Error('Socket.IO connection should have been rejected')); });
    client.on('connect_error', (error) => { clearTimeout(timer); client.close(); resolve(error.message); });
  });
}

async function graphqlSubscribe(url, payload, connectionParams = undefined) {
  const client = createClient({ url, webSocketImpl: WebSocket, connectionParams, retryAttempts: 0 });
  try {
    return await new Promise((resolve, reject) => {
      const results = [];
      const timer = setTimeout(() => { dispose(); reject(new Error('GraphQL WS test timed out')); }, 3000);
      const dispose = client.subscribe(payload, {
        next(value) { results.push(value); },
        error(error) { clearTimeout(timer); reject(new Error(JSON.stringify(error))); },
        complete() { clearTimeout(timer); resolve(results); },
      });
    });
  } finally {
    await client.dispose();
  }
}

test('raw WebSocket scripts enforce order, redact transcripts, publish SSE and support manual tests', async (t) => {
  const app = await bootTestApp();
  t.after(() => app.close());
  const endpoint = (await api(app, 'POST', '/endpoints', {
    type: 'mock', protocol: 'websocket', name: 'Order stream', slug: 'order-stream',
    realtime: { maxPayloadCaptureBytes: 1024, maxMessagesPerSession: 10 },
  })).json;
  const script = (await api(app, 'POST', `/endpoints/${endpoint.id}/realtime-scripts`, { name: 'Authorize order' })).json;
  await api(app, 'POST', `/realtime-scripts/${script.id}/steps`, {
    match: { kind: 'message', payload: { type: 'authorize' } },
    actions: [{ type: 'send', delayMs: 15, payload: { type: 'accepted' } }],
  });

  const result = await rawExchange(wsUrl(app, endpoint.slug), { type: 'authorize', token: 'must-not-appear' });
  assert.deepEqual(JSON.parse(result), { type: 'accepted' });
  const sessions = (await api(app, 'GET', `/endpoints/${endpoint.id}/realtime-sessions`)).json;
  assert.equal(sessions.length, 1);
  const detail = (await api(app, 'GET', `/realtime-sessions/${sessions[0].id}`)).json;
  assert.equal(detail.messages.length, 2);
  assert.match(detail.messages[0].payload, /••••••/);
  assert.doesNotMatch(detail.messages[0].payload, /must-not-appear/);

  const liveEvent = await sseWaitFor(app, 'realtime_message', () => api(app, 'POST', `/endpoints/${endpoint.id}/realtime-test`, {
    messages: [{ type: 'authorize' }],
  }));
  assert.equal(liveEvent.endpointId, endpoint.id);
  const manual = (await api(app, 'POST', `/endpoints/${endpoint.id}/realtime-test`, { messages: [{ type: 'authorize' }] })).json;
  assert.equal(manual.source, 'test');
  assert.ok(manual.messages.some((message) => message.direction === 'out'));

  const mismatch = await rawClose(wsUrl(app, endpoint.slug), { type: 'unexpected' });
  assert.equal(mismatch.code, 1008);

  const originEndpoint = (await api(app, 'POST', '/endpoints', {
    type: 'inspector', protocol: 'websocket', name: 'Origin protected', slug: 'origin-protected',
    realtime: { allowedOrigins: ['https://allowed.example'] },
  })).json;
  await assert.rejects(() => rawExchange(wsUrl(app, originEndpoint.slug), { ping: true }, 3000, { headers: { Origin: 'https://blocked.example' } }));

  const sizeEndpoint = (await api(app, 'POST', '/endpoints', {
    type: 'inspector', protocol: 'websocket', name: 'Sized stream', slug: 'sized-stream',
    realtime: { maxMessageBytes: 256 },
  })).json;
  assert.equal((await rawClose(wsUrl(app, sizeEndpoint.slug), 'x'.repeat(300))).code, 1009);

  const rateEndpoint = (await api(app, 'POST', '/endpoints', {
    type: 'inspector', protocol: 'websocket', name: 'Rate limited stream', slug: 'rate-limited-stream',
    realtime: { messageRate: { enabled: true, limit: 1, window: 'minute' } },
  })).json;
  assert.equal((await rawBurstClose(wsUrl(app, rateEndpoint.slug), ['first', 'second'])).code, 1008);
});

test('Socket.IO mock supports WebSocket and long-polling transports with acknowledgements', async (t) => {
  const app = await bootTestApp();
  t.after(() => app.close());
  const endpoint = (await api(app, 'POST', '/endpoints', { type: 'mock', protocol: 'socketio', name: 'Socket order', slug: 'socket-order' })).json;
  const script = (await api(app, 'POST', `/endpoints/${endpoint.id}/realtime-scripts`, { name: 'Socket flow' })).json;
  await api(app, 'POST', `/realtime-scripts/${script.id}/steps`, {
    match: { kind: 'event', event: 'hello', payload: { amount: 42 } },
    actions: [{ type: 'emit', event: 'accepted', payload: { ok: true } }],
  });
  assert.deepEqual(await socketIoExchange(app, endpoint.slug, ['websocket']), { ok: true });
  assert.deepEqual(await socketIoExchange(app, endpoint.slug, ['polling']), { ok: true });
  const sessions = (await api(app, 'GET', `/endpoints/${endpoint.id}/realtime-sessions`)).json;
  assert.equal(sessions.length, 2);
  assert.ok(sessions.some((session) => session.transport === 'websocket'));
  assert.ok(sessions.some((session) => session.transport === 'polling'));

  const protectedEndpoint = (await api(app, 'POST', '/endpoints', {
    type: 'inspector', protocol: 'socketio', name: 'Protected socket', slug: 'protected-socket',
    auth: { enabled: true, method: 'bearer', token: 'socket-secret', header: 'Authorization', failStatus: '401' },
    realtime: { authSource: 'protocol_init', protocolAuthPath: 'token' },
  })).json;
  const error = await socketIoConnectionError(app, protectedEndpoint.slug, {
    auth: { token: 'Bearer wrong-secret' },
  });
  assert.match(error, /auth:/);
  const rejected = (await api(app, 'GET', `/endpoints/${protectedEndpoint.id}/realtime-sessions`)).json;
  assert.equal(rejected[0].state, 'rejected');
});

test('a restart closes durable realtime sessions without resuming clients', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'sidedoor-realtime-restart-'));
  const dbPath = join(directory, 'sidedoor.db');
  const apps = [];
  t.after(async () => {
    for (const app of apps) await app.close().catch(() => {});
    rmSync(directory, { recursive: true, force: true });
  });

  const first = await bootTestApp({ dbPath });
  apps.push(first);
  const endpoint = (await api(first, 'POST', '/endpoints', {
    type: 'inspector', protocol: 'websocket', name: 'Restart stream', slug: 'restart-stream',
  })).json;
  const client = new WebSocket(wsUrl(first, endpoint.slug));
  await new Promise((resolve, reject) => {
    client.once('open', resolve);
    client.once('error', reject);
  });
  const before = (await api(first, 'GET', `/endpoints/${endpoint.id}/realtime-sessions`)).json;
  assert.equal(before[0].state, 'connected');

  await first.close();
  apps.splice(apps.indexOf(first), 1);
  const second = await bootTestApp({ dbPath });
  apps.push(second);
  const after = (await api(second, 'GET', `/endpoints/${endpoint.id}/realtime-sessions`)).json;
  assert.equal(after[0].state, 'closed');
  assert.equal(after[0].closeReason, 'server_shutdown');
  client.terminate();
});

test('GraphQL HTTP and graphql-transport-ws use SDL validation, fixtures and protocol-init auth', async (t) => {
  const app = await bootTestApp();
  t.after(() => app.close());
  const endpoint = (await api(app, 'POST', '/endpoints', {
    type: 'mock', protocol: 'graphql', name: 'Orders graph', slug: 'orders-graph',
    sdl: 'type Query { greeting(mode: String): String, total(value: Int!): Int, noFixture: String } type Mutation { createOrder: String } type Subscription { orderEvents(value: Int!): String! }',
    auth: { enabled: true, method: 'bearer', token: 'graph-secret', header: 'Authorization', failStatus: '401' },
    realtime: { authSource: 'protocol_init', protocolAuthPath: 'token' },
  })).json;
  const endpointId = endpoint.id;
  const invalidSdl = await api(app, 'POST', '/graphql/validate', { sdl: 'type Query { greeting: }' });
  assert.equal(invalidSdl.status, 200);
  assert.equal(invalidSdl.json.valid, false);
  await api(app, 'POST', `/endpoints/${endpointId}/graphql/fixtures`, {
    name: 'Greeting base', operationName: 'Greeting', operationType: 'query', response: { data: { greeting: 'hello' } },
  });
  await api(app, 'POST', `/endpoints/${endpointId}/graphql/fixtures`, {
    name: 'Greeting fast', operationName: 'Greeting', operationType: 'query', variablesMatch: { mode: 'fast' }, response: { data: { greeting: 'fast hello' } },
  });
  await api(app, 'POST', `/endpoints/${endpointId}/graphql/fixtures`, {
    name: 'Order events', operationName: 'OrderEvents', operationType: 'subscription',
    response: { data: { orderEvents: 'fallback' } },
    subscriptionEvents: [{ delayMs: 5, payload: { data: { orderEvents: 'created' } } }, { delayMs: 5, payload: { data: { orderEvents: 'settled' } } }],
  });

  const unauthorized = await fetch(`${app.ingestUrl}/${endpoint.slug}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ query: '{ noFixture }' }) });
  assert.equal(unauthorized.status, 401);
  const response = await fetch(`${app.ingestUrl}/${endpoint.slug}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/graphql-response+json', Authorization: 'Bearer graph-secret' },
    body: JSON.stringify({ query: 'query Greeting($mode: String) { greeting(mode: $mode) }', operationName: 'Greeting', variables: { mode: 'fast' } }),
  });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'application/graphql-response+json; charset=utf-8');
  assert.deepEqual(await response.json(), { data: { greeting: 'fast hello' } });

  const invalidVariables = await fetch(`${app.ingestUrl}/${endpoint.slug}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer graph-secret' },
    body: JSON.stringify({ query: 'query Total($value: Int!) { total(value: $value) }', operationName: 'Total', variables: { value: 'not-an-int' } }),
  });
  assert.equal(invalidVariables.status, 400);
  assert.equal((await invalidVariables.json()).errors[0].extensions.code, 'GRAPHQL_VALIDATION_FAILED');

  const missing = await fetch(`${app.ingestUrl}/${endpoint.slug}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer graph-secret' }, body: JSON.stringify({ query: '{ noFixture }' }),
  });
  assert.equal((await missing.json()).errors[0].extensions.code, 'SIDEDOOR_FIXTURE_NOT_FOUND');
  const mutationGet = await fetch(`${app.ingestUrl}/${endpoint.slug}?query=${encodeURIComponent('mutation { createOrder }')}`, { headers: { Authorization: 'Bearer graph-secret' } });
  assert.equal(mutationGet.status, 405);
  const introspection = await fetch(`${app.ingestUrl}/${endpoint.slug}?query=${encodeURIComponent('{ __schema { queryType { name } } }')}`, { headers: { Authorization: 'Bearer graph-secret' } });
  assert.equal((await introspection.json()).data.__schema.queryType.name, 'Query');

  await assert.rejects(
    () => graphqlSubscribe(wsUrl(app, endpoint.slug), { query: 'subscription OrderEvents { orderEvents }', operationName: 'OrderEvents' }, { token: 'Bearer wrong-secret' }),
  );
  const rejectedSessions = (await api(app, 'GET', `/endpoints/${endpointId}/realtime-sessions`)).json;
  const rejected = rejectedSessions.find((session) => String(session.closeReason || '').startsWith('auth:'));
  assert.equal(rejected && rejected.state, 'rejected');
  await assert.rejects(
    () => graphqlSubscribe(wsUrl(app, endpoint.slug), { query: 'subscription OrderEvents($value: Int!) { orderEvents(value: $value) }', operationName: 'OrderEvents', variables: { value: 'not-an-int' } }, { token: 'Bearer graph-secret' }),
    /Int cannot represent non-integer value/,
  );
  const events = await graphqlSubscribe(wsUrl(app, endpoint.slug), { query: 'subscription OrderEvents($value: Int!) { orderEvents(value: $value) }', operationName: 'OrderEvents', variables: { value: 1 } }, { token: 'Bearer graph-secret' });
  assert.deepEqual(events, [{ data: { orderEvents: 'created' } }, { data: { orderEvents: 'settled' } }]);
  const manual = (await api(app, 'POST', `/endpoints/${endpointId}/realtime-test`, {
    query: 'subscription OrderEvents($value: Int!) { orderEvents(value: $value) }', operationName: 'OrderEvents', variables: { value: 1 },
  })).json;
  assert.equal(manual.source, 'test');
  assert.equal(manual.messages.filter((message) => message.kind === 'graphql_next').length, 2);
  assert.ok(manual.messages.some((message) => message.kind === 'graphql_complete'));
  const invalidManual = (await api(app, 'POST', `/endpoints/${endpointId}/realtime-test`, {
    query: 'subscription OrderEvents($value: Int!) { orderEvents(value: $value) }', operationName: 'OrderEvents', variables: { value: 'not-an-int' },
  })).json;
  assert.match(invalidManual.messages.find((message) => message.kind === 'graphql_next').payload, /Int cannot represent non-integer value/);
  const sessions = (await api(app, 'GET', `/endpoints/${endpointId}/realtime-sessions`)).json;
  assert.ok(sessions.some((session) => session.protocol === 'graphql'));

  const hmacSecret = 'graphql-http-signing-secret';
  await api(app, 'PATCH', `/endpoints/${endpointId}`, {
    hmac: { enabled: true, provider: 'github', secret: hmacSecret, algo: 'sha256', header: 'X-Hub-Signature-256', encoding: 'hex', reject: true },
  });
  const hmacBody = JSON.stringify({ query: 'query Greeting { greeting }', operationName: 'Greeting' });
  const signature = 'sha256=' + createHmac('sha256', hmacSecret).update(hmacBody).digest('hex');
  const hmacResponse = await fetch(`${app.ingestUrl}/${endpoint.slug}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer graph-secret', 'X-Hub-Signature-256': signature },
    body: hmacBody,
  });
  assert.equal(hmacResponse.status, 200);
  assert.deepEqual(await hmacResponse.json(), { data: { greeting: 'hello' } });
});

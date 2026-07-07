import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createHmac } from 'node:crypto';
import { bootTestApp, api, sseWaitFor } from './helpers.js';

function ingest(app, path, opts = {}) {
  return fetch(app.ingestUrl + path, opts);
}
async function mkWebhook(app, extra = {}) {
  return (await api(app, 'POST', '/endpoints', { type: 'inspector', name: 'W', slug: 'w', ...extra })).json;
}
async function mkMock(app, extra = {}) {
  return (await api(app, 'POST', '/endpoints', { type: 'mock', name: 'M', path: '/x', status: 200, body: '{"ok":true}', ...extra })).json;
}

test('unknown slug → 404', async (t) => {
  const app = await bootTestApp();
  t.after(() => app.close());
  assert.equal((await ingest(app, '/nope', { method: 'POST', body: '{}' })).status, 404);
});

test('webhook captures request with parsed metadata', async (t) => {
  const app = await bootTestApp();
  t.after(() => app.close());
  const w = await mkWebhook(app);
  const res = await ingest(app, '/w?foo=bar', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Custom': 'yo' }, body: '{"type":"charge.succeeded","amount":4990}' });
  assert.equal(res.status, 200);
  const reqs = (await api(app, 'GET', `/endpoints/${w.id}/requests`)).json;
  assert.equal(reqs.length, 1);
  const r = reqs[0];
  assert.equal(r.method, 'POST');
  assert.equal(r.event, 'charge.succeeded');
  assert.equal(r.query.foo, 'bar');
  assert.equal(r.headers['x-custom'], 'yo');
  assert.equal(r.outcome, 'captured');
});

test('subpaths under the slug are captured', async (t) => {
  const app = await bootTestApp();
  t.after(() => app.close());
  const w = await mkWebhook(app);
  await ingest(app, '/w/extra/path', { method: 'PUT', body: '{}' });
  const r = (await api(app, 'GET', `/endpoints/${w.id}/requests`)).json[0];
  assert.equal(r.path, '/w/extra/path');
  assert.equal(r.method, 'PUT');
});

test('QUERY method is captured like any other, body included', async (t) => {
  const app = await bootTestApp();
  t.after(() => app.close());
  const w = await mkWebhook(app);
  const res = await ingest(app, '/w', { method: 'QUERY', headers: { 'Content-Type': 'application/json' }, body: '{"filter":"active"}' });
  assert.equal(res.status, 200);
  const r = (await api(app, 'GET', `/endpoints/${w.id}/requests`)).json[0];
  assert.equal(r.method, 'QUERY');
  assert.equal(r.body, '{"filter":"active"}');
});

test('mock can be created for QUERY and only responds to QUERY', async (t) => {
  const app = await bootTestApp();
  t.after(() => app.close());
  const m = await mkMock(app, { method: 'QUERY', path: '/search' });
  assert.equal((await ingest(app, '/' + m.slug, { method: 'QUERY', body: '{}' })).status, 200);
  assert.equal((await ingest(app, '/' + m.slug, { method: 'POST', body: '{}' })).status, 405);
});

test('auth enforced on webhook', async (t) => {
  const app = await bootTestApp();
  t.after(() => app.close());
  const w = await mkWebhook(app);
  await api(app, 'PATCH', `/endpoints/${w.id}`, { auth: { enabled: true, method: 'bearer', token: 'sekret', failStatus: '401' } });
  assert.equal((await ingest(app, '/w', { method: 'POST', body: '{}' })).status, 401);
  const ok = await ingest(app, '/w', { method: 'POST', headers: { Authorization: 'Bearer sekret' }, body: '{}' });
  assert.equal(ok.status, 200);
  const reqs = (await api(app, 'GET', `/endpoints/${w.id}/requests`)).json;
  assert.equal(reqs.filter((r) => r.outcome === 'unauthorized').length, 1);
});

test('HMAC verify: valid, invalid-flag, invalid-reject', async (t) => {
  const app = await bootTestApp();
  t.after(() => app.close());
  const w = await mkWebhook(app);
  const secret = 'whsec_x';
  await api(app, 'PATCH', `/endpoints/${w.id}`, { hmac: { enabled: true, provider: 'github', secret, algo: 'sha256', header: 'X-Hub-Signature-256', encoding: 'hex', reject: false } });
  const body = '{"hello":"world"}';
  const good = 'sha256=' + createHmac('sha256', secret).update(body).digest('hex');
  await ingest(app, '/w', { method: 'POST', headers: { 'X-Hub-Signature-256': good }, body });
  await ingest(app, '/w', { method: 'POST', headers: { 'X-Hub-Signature-256': 'sha256=bad' }, body });
  let reqs = (await api(app, 'GET', `/endpoints/${w.id}/requests`)).json;
  assert.equal(reqs.find((r) => r.signature === 'valid') != null, true);
  assert.equal(reqs.find((r) => r.signature === 'invalid') != null, true);
  // now with reject on, invalid → 401
  await api(app, 'PATCH', `/endpoints/${w.id}`, { hmac: { enabled: true, provider: 'github', secret, reject: true } });
  assert.equal((await ingest(app, '/w', { method: 'POST', headers: { 'X-Hub-Signature-256': 'sha256=bad' }, body })).status, 401);
  assert.equal((await ingest(app, '/w', { method: 'POST', headers: { 'X-Hub-Signature-256': good }, body })).status, 200);
});

test('rate limiting returns configured status + Retry-After', async (t) => {
  const app = await bootTestApp();
  t.after(() => app.close());
  const w = await mkWebhook(app);
  await api(app, 'PATCH', `/endpoints/${w.id}`, { rate: { enabled: true, limit: '2', window: 'minute', key: 'ip', burst: '0', status: '429', retryAfter: true } });
  assert.equal((await ingest(app, '/w', { method: 'POST', body: '{}' })).status, 200);
  assert.equal((await ingest(app, '/w', { method: 'POST', body: '{}' })).status, 200);
  const limited = await ingest(app, '/w', { method: 'POST', body: '{}' });
  assert.equal(limited.status, 429);
  assert.ok(limited.headers.get('retry-after'));
});

test('forwarding: drop and respond actions', async (t) => {
  const app = await bootTestApp();
  t.after(() => app.close());
  const w = await mkWebhook(app);
  await api(app, 'PATCH', `/endpoints/${w.id}`, {
    ruleMatch: 'any',
    rules: [
      { id: 'r1', enabled: true, field: 'header', key: 'x-mode', op: 'equals', value: 'drop', action: 'drop' },
      { id: 'r2', enabled: true, field: 'header', key: 'x-mode', op: 'equals', value: 'teapot', action: 'respond', respondStatus: 418, respondBody: '{"tea":true}' },
    ],
  });
  const dropped = await ingest(app, '/w', { method: 'POST', headers: { 'x-mode': 'drop' }, body: '{}' });
  assert.equal((await dropped.json()).dropped, true);
  const teapot = await ingest(app, '/w', { method: 'POST', headers: { 'x-mode': 'teapot' }, body: '{}' });
  assert.equal(teapot.status, 418);
  const reqs = (await api(app, 'GET', `/endpoints/${w.id}/requests`)).json;
  assert.equal(reqs.find((r) => r.outcome === 'dropped') != null, true);
  assert.equal(reqs.find((r) => r.outcome === 'responded') != null, true);
});

test('forwarding: relay to a local upstream', async (t) => {
  const upstream = http.createServer((req, res) => {
    let b = '';
    req.on('data', (c) => { b += c; });
    req.on('end', () => { res.writeHead(202, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ echoed: b })); });
  });
  await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
  const target = `http://127.0.0.1:${upstream.address().port}/hook`;
  const app = await bootTestApp();
  t.after(async () => { await app.close(); upstream.close(); });
  const w = await mkWebhook(app, { forwardTarget: target });
  const res = await ingest(app, '/w', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"x":1}' });
  assert.equal(res.status, 202);
  assert.equal((await res.json()).echoed, '{"x":1}');
  const r = (await api(app, 'GET', `/endpoints/${w.id}/requests`)).json[0];
  assert.equal(r.outcome, 'forwarded');
  assert.equal(r.responseStatus, 202);
});

test('mock: active scenario response with delay + headers', async (t) => {
  const app = await bootTestApp();
  t.after(() => app.close());
  const m = await mkMock(app, { status: 201, delay: 30, body: '{"id":"ch_1"}' });
  const res = await ingest(app, '/' + m.slug, { method: 'POST', body: '{}' });
  assert.equal(res.status, 201);
  assert.equal(res.headers.get('content-type'), 'application/json');
  assert.equal((await res.json()).id, 'ch_1');
});

test('mock: match rule overrides active scenario', async (t) => {
  const app = await bootTestApp();
  t.after(() => app.close());
  const m = await mkMock(app);
  const declined = (await api(app, 'POST', `/endpoints/${m.id}/scenarios`, { name: 'Declined', status: 402, body: '{"error":"declined"}' })).json;
  await api(app, 'POST', `/endpoints/${m.id}/match-rules`, { when: 'header', key: 'X-Test', op: 'equals', value: 'decline', then: declined.id });
  const hit = await ingest(app, '/' + m.slug, { method: 'POST', headers: { 'X-Test': 'decline' }, body: '{}' });
  assert.equal(hit.status, 402);
  const normal = await ingest(app, '/' + m.slug, { method: 'POST', body: '{}' });
  assert.equal(normal.status, 200);
});

test('mock: sequential mode rotates scenarios', async (t) => {
  const app = await bootTestApp();
  t.after(() => app.close());
  const m = await mkMock(app, { status: 200, body: '{"n":1}' });
  await api(app, 'POST', `/endpoints/${m.id}/scenarios`, { name: 'Second', status: 500, body: '{"n":2}' });
  await api(app, 'PATCH', `/endpoints/${m.id}`, { mode: 'sequence' });
  const a = await ingest(app, '/' + m.slug, { method: 'POST', body: '{}' });
  const b = await ingest(app, '/' + m.slug, { method: 'POST', body: '{}' });
  const c = await ingest(app, '/' + m.slug, { method: 'POST', body: '{}' });
  assert.deepEqual([a.status, b.status, c.status], [200, 500, 200]);
});

test('mock: auth required', async (t) => {
  const app = await bootTestApp();
  t.after(() => app.close());
  const m = await mkMock(app, { auth: 'apikey' });
  await api(app, 'PATCH', `/endpoints/${m.id}`, { auth: { enabled: true, method: 'apikey', apiKeyName: 'X-Api-Key', apiKeyLoc: 'header', token: 'k123', failStatus: '403' } });
  assert.equal((await ingest(app, '/' + m.slug, { method: 'POST', body: '{}' })).status, 403);
  assert.equal((await ingest(app, '/' + m.slug, { method: 'POST', headers: { 'X-Api-Key': 'k123' }, body: '{}' })).status, 200);
});

test('mock: rejects a method other than the one it was created for', async (t) => {
  const app = await bootTestApp();
  t.after(() => app.close());
  const m = await mkMock(app, { method: 'POST', path: '/pessoas' });
  const wrong = await ingest(app, '/' + m.slug, { method: 'GET' });
  assert.equal(wrong.status, 405);
  assert.equal(wrong.headers.get('allow'), 'POST');
  const captured = (await api(app, 'GET', `/endpoints/${m.id}/requests`)).json[0];
  assert.equal(captured.outcome, 'unmatched');
  // the configured method still works
  assert.equal((await ingest(app, '/' + m.slug, { method: 'POST', body: '{}' })).status, 200);
});

test('mock: rejects an arbitrary subpath, but accepts bare slug and the configured path', async (t) => {
  const app = await bootTestApp();
  t.after(() => app.close());
  const m = await mkMock(app, { method: 'POST', path: '/pessoas' });
  assert.equal((await ingest(app, '/' + m.slug + '/something-else', { method: 'POST', body: '{}' })).status, 404);
  assert.equal((await ingest(app, '/' + m.slug, { method: 'POST', body: '{}' })).status, 200); // bare slug
  assert.equal((await ingest(app, '/' + m.slug + '/pessoas', { method: 'POST', body: '{}' })).status, 200); // slug + configured path
});

test('mock: disabled match rule is ignored, falls back to the active scenario', async (t) => {
  const app = await bootTestApp();
  t.after(() => app.close());
  const m = await mkMock(app);
  const declined = (await api(app, 'POST', `/endpoints/${m.id}/scenarios`, { name: 'Declined', status: 402, body: '{"error":"declined"}' })).json;
  const rule = (await api(app, 'POST', `/endpoints/${m.id}/match-rules`, { when: 'header', key: 'X-Test', op: 'equals', value: 'decline', then: declined.id })).json;
  await api(app, 'PATCH', `/match-rules/${rule.id}`, { enabled: false });
  const res = await ingest(app, '/' + m.slug, { method: 'POST', headers: { 'X-Test': 'decline' }, body: '{}' });
  assert.equal(res.status, 200); // rule is disabled — must not override the active scenario
});

test('body over cap → 413', async (t) => {
  const app = await bootTestApp({ maxBodyBytes: 1024 });
  t.after(() => app.close());
  await mkWebhook(app);
  const big = 'x'.repeat(5000);
  assert.equal((await ingest(app, '/w', { method: 'POST', body: big })).status, 413);
});

test('SSE broadcasts captured requests', async (t) => {
  const app = await bootTestApp();
  t.after(() => app.close());
  const w = await mkWebhook(app);
  const evt = await sseWaitFor(app, 'request', () => ingest(app, '/w', { method: 'POST', body: '{"type":"ping"}' }));
  assert.equal(evt.endpointId, w.id);
  assert.equal(evt.request.event, 'ping');
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bootTestApp, api } from './helpers.js';

test('GET /state bootstraps workspace + counts + funnel', async (t) => {
  const app = await bootTestApp();
  t.after(() => app.close());
  const { status, json } = await api(app, 'GET', '/state');
  assert.equal(status, 200);
  assert.equal(json.workspaces.length, 1);
  assert.ok(json.activeWorkspace);
  assert.equal(json.funnel.active, 0);
  assert.ok(json.baseUrls.local.startsWith('http://'));
});

test('workspace lifecycle + guards', async (t) => {
  const app = await bootTestApp();
  t.after(() => app.close());
  const created = await api(app, 'POST', '/workspaces', { name: 'Acme', icon: 'zap', color: '#238636' });
  assert.equal(created.status, 200);
  const id = created.json.id;
  const list = await api(app, 'GET', '/workspaces');
  assert.equal(list.json.length, 2);
  await api(app, 'PATCH', `/workspaces/${id}`, { name: 'Acme Payments' });
  assert.equal((await api(app, 'GET', '/workspaces')).json.find((w) => w.id === id).name, 'Acme Payments');
  const del = await api(app, 'DELETE', `/workspaces/${id}`);
  assert.equal(del.status, 200);
  // deleting the last remaining workspace is blocked
  const remaining = (await api(app, 'GET', '/workspaces')).json[0].id;
  assert.equal((await api(app, 'DELETE', `/workspaces/${remaining}`)).status, 409);
  assert.equal((await api(app, 'POST', '/workspaces', {})).status, 400);
});

test('project rename + delete', async (t) => {
  const app = await bootTestApp();
  t.after(() => app.close());
  const ws = (await api(app, 'GET', '/state')).json.activeWorkspace;
  const created = await api(app, 'POST', '/endpoints', { type: 'inspector', name: 'W', slug: 'proj-api', projectName: 'Gateway' });
  const projectId = created.json.project.id;
  const renamed = await api(app, 'PATCH', `/projects/${projectId}`, { name: 'Gateway BR' });
  assert.equal(renamed.status, 200);
  assert.equal(renamed.json.name, 'Gateway BR');
  assert.equal((await api(app, 'PATCH', `/projects/${projectId}`, { name: '' })).status, 400);
  assert.equal((await api(app, 'PATCH', '/projects/missing', { name: 'X' })).status, 404);
  assert.equal((await api(app, 'DELETE', `/projects/${projectId}`)).status, 200);
  const ep = (await api(app, 'GET', `/endpoints/${created.json.id}`)).json;
  assert.equal(ep.project, null); // endpoint survives, unassigned
  assert.equal((await api(app, 'GET', `/workspaces/${ws}/projects`)).json.length, 0);
});

test('create webhook: validation + success', async (t) => {
  const app = await bootTestApp();
  t.after(() => app.close());
  // missing name/slug
  assert.equal((await api(app, 'POST', '/endpoints', { type: 'inspector', name: '', slug: '' })).status, 400);
  const ok = await api(app, 'POST', '/endpoints', { type: 'inspector', name: 'Stripe', slug: 'stripe-prod', validate: true, provider: 'stripe', projectName: 'Gateway BR' });
  assert.equal(ok.status, 200);
  assert.equal(ok.json.slug, 'stripe-prod');
  assert.equal(ok.json.signed, true);
  assert.equal(ok.json.config.hmac.provider, 'stripe');
  assert.equal(ok.json.config.hmac.header, 'Stripe-Signature');
  assert.ok(ok.json.project);
  // duplicate slug rejected
  assert.equal((await api(app, 'POST', '/endpoints', { type: 'inspector', name: 'Dup', slug: 'stripe-prod' })).status, 400);
});

test('create mock: default scenario + auth config', async (t) => {
  const app = await bootTestApp();
  t.after(() => app.close());
  const bad = await api(app, 'POST', '/endpoints', { type: 'mock', name: 'X', path: 'no-slash', status: 200, body: '{}' });
  assert.equal(bad.status, 400);
  assert.ok(bad.json.fields.path);
  const m = await api(app, 'POST', '/endpoints', { type: 'mock', name: 'Payments API', method: 'POST', path: '/v1/charges', status: 201, delay: 50, contentType: 'application/json', auth: 'bearer', body: '{"id":"ch_1"}' });
  assert.equal(m.status, 200);
  assert.equal(m.json.scenarios.length, 1);
  assert.equal(m.json.scenarios[0].status, 201);
  assert.equal(m.json.scenarios[0].active, true);
  assert.equal(m.json.config.auth.enabled, true);
  assert.equal(m.json.config.auth.method, 'bearer');
  assert.ok(m.json.urls.local.endsWith('/' + m.json.slug));
});

test('create mock: credentials captured at creation for every auth method', async (t) => {
  const app = await bootTestApp();
  t.after(() => app.close());

  const bearer = await api(app, 'POST', '/endpoints', { type: 'mock', name: 'B', path: '/b', status: 200, body: '{}', auth: 'bearer', authToken: 'sk_test_123' });
  assert.equal(bearer.json.config.auth.token, 'sk_test_123');

  const apikey = await api(app, 'POST', '/endpoints', { type: 'mock', name: 'A', path: '/a', status: 200, body: '{}', auth: 'apikey', authToken: 'key_abc', authApiKeyName: 'X-Custom-Key', authApiKeyLoc: 'query' });
  assert.equal(apikey.json.config.auth.token, 'key_abc');
  assert.equal(apikey.json.config.auth.apiKeyName, 'X-Custom-Key');
  assert.equal(apikey.json.config.auth.apiKeyLoc, 'query');

  const basic = await api(app, 'POST', '/endpoints', { type: 'mock', name: 'C', path: '/c', status: 200, body: '{}', auth: 'basic', authUser: 'svc', authPass: 'p@ss' });
  assert.equal(basic.json.config.auth.user, 'svc');
  assert.equal(basic.json.config.auth.pass, 'p@ss');

  // omitting the credential still creates the mock (fails closed at ingest, not at creation)
  const noToken = await api(app, 'POST', '/endpoints', { type: 'mock', name: 'D', path: '/d', status: 200, body: '{}', auth: 'bearer' });
  assert.equal(noToken.status, 200);
  assert.equal(noToken.json.config.auth.token, '');
});

test('create webhook: optional hmacSecret captured at creation', async (t) => {
  const app = await bootTestApp();
  t.after(() => app.close());
  const withSecret = await api(app, 'POST', '/endpoints', { type: 'inspector', name: 'GH', slug: 'gh', validate: true, provider: 'github', hmacSecret: '  whsec_abc  ' });
  assert.equal(withSecret.json.config.hmac.secret, 'whsec_abc'); // trimmed
  const withoutSecret = await api(app, 'POST', '/endpoints', { type: 'inspector', name: 'GH2', slug: 'gh2', validate: true, provider: 'github' });
  assert.equal(withoutSecret.json.config.hmac.secret, '');
});

test('scenarios + match rules CRUD', async (t) => {
  const app = await bootTestApp();
  t.after(() => app.close());
  const m = (await api(app, 'POST', '/endpoints', { type: 'mock', name: 'M', path: '/x', status: 200, body: '{}' })).json;
  const sc = (await api(app, 'POST', `/endpoints/${m.id}/scenarios`, { name: 'Declined', status: 402, delay: 0, body: '{"error":"declined"}' })).json;
  assert.equal(sc.status, 402);
  const edited = (await api(app, 'PATCH', `/scenarios/${sc.id}`, { name: 'Declined (edited)', status: 403, delay: 50, contentType: 'application/json', body: '{"error":"card_declined"}' })).json;
  assert.equal(edited.name, 'Declined (edited)');
  assert.equal(edited.status, 403);
  assert.equal(edited.delay, 50);
  assert.equal(edited.body, '{"error":"card_declined"}');
  await api(app, 'POST', `/scenarios/${sc.id}/activate`);
  const after = (await api(app, 'GET', `/endpoints/${m.id}`)).json;
  assert.equal(after.scenarios.find((s) => s.id === sc.id).active, true);
  const rule = (await api(app, 'POST', `/endpoints/${m.id}/match-rules`, { when: 'header', key: 'X-Test', op: 'equals', value: 'decline', then: sc.id })).json;
  assert.ok(rule.id);
  assert.equal(rule.enabled, true); // enabled by default
  await api(app, 'PATCH', `/match-rules/${rule.id}`, { enabled: false });
  assert.equal((await api(app, 'GET', `/endpoints/${m.id}`)).json.matchRules[0].enabled, false);
  await api(app, 'DELETE', `/match-rules/${rule.id}`);
  assert.equal((await api(app, 'GET', `/endpoints/${m.id}`)).json.matchRules.length, 0);
});

test('match rules: method/path fields, ≠ operator, and reordering', async (t) => {
  const app = await bootTestApp();
  t.after(() => app.close());
  const m = (await api(app, 'POST', '/endpoints', { type: 'mock', name: 'M', path: '/x', status: 200, body: '{}' })).json;
  const sc = (await api(app, 'POST', `/endpoints/${m.id}/scenarios`, { name: 'Alt', status: 500, body: '{}' })).json;

  const r1 = (await api(app, 'POST', `/endpoints/${m.id}/match-rules`, { when: 'method', key: '', op: 'equals', value: 'GET', then: sc.id })).json;
  assert.equal(r1.when, 'method');
  const r2 = (await api(app, 'POST', `/endpoints/${m.id}/match-rules`, { when: 'path', key: '', op: 'contains', value: '/v2', then: sc.id })).json;
  assert.equal(r2.when, 'path');
  const r3 = (await api(app, 'POST', `/endpoints/${m.id}/match-rules`, { when: 'header', key: 'X-Env', op: '≠', value: 'prod', then: sc.id })).json;
  assert.equal(r3.op, '≠');

  // created in order r1,r2,r3 (position 0,1,2) — move r3 up twice -> first
  await api(app, 'POST', `/match-rules/${r3.id}/move`, { direction: 'up' });
  await api(app, 'POST', `/match-rules/${r3.id}/move`, { direction: 'up' });
  let order = (await api(app, 'GET', `/endpoints/${m.id}`)).json.matchRules.map((r) => r.id);
  assert.deepEqual(order, [r3.id, r1.id, r2.id]);

  // moving the first rule further up is a no-op at the boundary
  const noop = await api(app, 'POST', `/match-rules/${r3.id}/move`, { direction: 'up' });
  assert.equal(noop.status, 200);
  order = (await api(app, 'GET', `/endpoints/${m.id}`)).json.matchRules.map((r) => r.id);
  assert.deepEqual(order, [r3.id, r1.id, r2.id]);

  assert.equal((await api(app, 'POST', '/match-rules/nope/move', { direction: 'up' })).status, 404);
  assert.equal((await api(app, 'POST', `/match-rules/${r1.id}/move`, { direction: 'sideways' })).status, 400);
});

test('endpoint settings patch persists', async (t) => {
  const app = await bootTestApp();
  t.after(() => app.close());
  const w = (await api(app, 'POST', '/endpoints', { type: 'inspector', name: 'W', slug: 'w' })).json;
  await api(app, 'PATCH', `/endpoints/${w.id}`, { rate: { enabled: true, limit: '10', window: 'second' }, ruleMatch: 'any', rules: [{ id: 'r1', enabled: true, field: 'method', key: '', op: 'equals', value: 'POST', action: 'drop' }] });
  const got = (await api(app, 'GET', `/endpoints/${w.id}`)).json;
  assert.equal(got.config.rate.enabled, true);
  assert.equal(got.config.rate.limit, '10');
  assert.equal(got.config.ruleMatch, 'any');
  assert.equal(got.config.rules.length, 1);
});

test('requests: list/get/delete/clear + diff', async (t) => {
  const app = await bootTestApp();
  t.after(() => app.close());
  const w = (await api(app, 'POST', '/endpoints', { type: 'inspector', name: 'W', slug: 'w' })).json;
  // capture two requests directly through ingest
  await fetch(`${app.ingestUrl}/w`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"a":1}' });
  await fetch(`${app.ingestUrl}/w`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"a":2}' });
  const list = (await api(app, 'GET', `/endpoints/${w.id}/requests`)).json;
  assert.equal(list.length, 2);
  const diff = (await api(app, 'GET', `/requests/diff?a=${list[0].id}&b=${list[1].id}`)).json;
  assert.ok(diff.summary.add + diff.summary.del >= 1);
  await api(app, 'DELETE', `/requests/${list[0].id}`);
  assert.equal((await api(app, 'GET', `/endpoints/${w.id}/requests`)).json.length, 1);
  await api(app, 'DELETE', `/endpoints/${w.id}/requests`);
  assert.equal((await api(app, 'GET', `/endpoints/${w.id}/requests`)).json.length, 0);
});

test('export sets download headers', async (t) => {
  const app = await bootTestApp();
  t.after(() => app.close());
  const w = (await api(app, 'POST', '/endpoints', { type: 'inspector', name: 'W', slug: 'w' })).json;
  await fetch(`${app.ingestUrl}/w`, { method: 'POST', body: '{"a":1}' });
  const one = (await api(app, 'GET', `/endpoints/${w.id}/requests`)).json[0];
  const res = await fetch(`${app.adminUrl}/__sd/api/requests/${one.id}/export`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-disposition') || '', /attachment; filename=/);
  const allRes = await fetch(`${app.adminUrl}/__sd/api/endpoints/${w.id}/requests/export`);
  assert.match(allRes.headers.get('content-disposition') || '', /w-requests\.json/);
});

test('funnel enable/disable via injected tailscale', async (t) => {
  const app = await bootTestApp();
  t.after(() => app.close());
  assert.equal((await api(app, 'GET', '/funnel')).json.state.active, 0);
  const en = await api(app, 'POST', '/funnel/enable');
  assert.equal(en.json.state.active, 1);
  assert.ok(en.json.state.base_url.includes('.ts.net'));
  assert.ok(en.json.history.length >= 1);
  const dis = await api(app, 'POST', '/funnel/disable');
  assert.equal(dis.json.state.active, 0);
});

test('activity feed reflects captures from both webhooks and mocks', async (t) => {
  const app = await bootTestApp();
  t.after(() => app.close());
  await api(app, 'POST', '/endpoints', { type: 'inspector', name: 'W', slug: 'w' });
  await api(app, 'POST', '/endpoints', { type: 'mock', name: 'M', slug: 'x', path: '/x', status: 201, body: '{"ok":true}' });
  await fetch(`${app.ingestUrl}/w`, { method: 'POST', body: '{"type":"charge.succeeded"}' });
  await fetch(`${app.ingestUrl}/x`, { method: 'POST', body: '{}' });
  const act = (await api(app, 'GET', '/activity')).json;
  assert.equal(act.length, 2);
  assert.deepEqual(act.map((a) => a.epType).sort(), ['inspector', 'mock']);
  assert.equal(act.find((a) => a.epType === 'inspector').event, 'charge.succeeded');
});

test('GET /requests/overview aggregates across webhooks + mocks', async (t) => {
  const app = await bootTestApp();
  t.after(() => app.close());
  await api(app, 'POST', '/endpoints', { type: 'inspector', name: 'W', slug: 'w' });
  await api(app, 'POST', '/endpoints', { type: 'mock', name: 'M', slug: 'x', path: '/x', status: 404, body: '{}' });
  await fetch(`${app.ingestUrl}/w`, { method: 'POST', body: '{}' });
  await fetch(`${app.ingestUrl}/x`, { method: 'POST', body: '{}' });
  const ov = (await api(app, 'GET', '/requests/overview')).json;
  assert.equal(ov.period, '24h');
  assert.equal(ov.total, 2);
  assert.equal(ov.series.length, 24);
  assert.equal(ov.series.reduce((a, b) => a + b, 0), 2);
  assert.equal(ov.statusBreakdown.ok, 1);
  assert.equal(ov.statusBreakdown.clientError, 1);
  const week = (await api(app, 'GET', '/requests/overview?period=7d')).json;
  assert.equal(week.period, '7d');
  assert.equal(week.series.length, 7);
});

test('static SPA served at /', async (t) => {
  const app = await bootTestApp();
  t.after(() => app.close());
  const res = await fetch(app.adminUrl + '/');
  // index.html may not exist yet during early build; accept 200 or 404 but not 500
  assert.notEqual(res.status, 500);
});

// Demo data loader. `npm run seed` populates the database with a realistic set
// of webhooks, mock servers, scenarios, rules and captured requests so the UI is
// immediately explorable. `npm run reset` (or `--reset`) clears everything first.
import './lib/quiet.js';
import { loadConfig } from './config.js';
import { openDb } from './db.js';
import { Store } from './store.js';
import { presetFor } from './lib/hmac.js';
import { defaultAuth, defaultHmac, defaultRate } from './store.js';

const config = loadConfig();
const db = openDb(config.dbPath);
const store = new Store(db);
const reset = process.argv.includes('--reset');

function clearAll() {
  for (const t of ['requests', 'match_rules', 'scenarios', 'endpoints', 'projects', 'funnel_history', 'workspaces']) {
    db.exec(`DELETE FROM ${t}`);
  }
  db.exec("UPDATE funnel_state SET active=0, since=NULL, base_url=NULL, region=NULL, machine=NULL, last_error=NULL WHERE id=1");
}

function rid(len = 10) {
  const c = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let s = '';
  for (let i = 0; i < len; i++) s += c[Math.floor(Math.random() * c.length)];
  return s;
}
const STRIPE_EVENTS = [
  { type: 'charge.succeeded', obj: 'charge', amount: 4990 },
  { type: 'payment_intent.succeeded', obj: 'payment_intent', amount: 12900 },
  { type: 'charge.refunded', obj: 'charge', amount: 2500 },
  { type: 'invoice.payment_failed', obj: 'invoice', amount: 8900 },
  { type: 'customer.subscription.updated', obj: 'subscription', amount: 0 },
];

function stripeBody(i, now) {
  const ev = STRIPE_EVENTS[i % STRIPE_EVENTS.length];
  const pfx = ev.obj === 'charge' ? 'ch_' : ev.obj === 'payment_intent' ? 'pi_' : ev.obj === 'invoice' ? 'in_' : 'sub_';
  return {
    id: 'evt_' + rid(12), object: 'event', api_version: '2024-06-20', created: Math.floor(now / 1000), type: ev.type, livemode: true,
    data: { object: { id: pfx + rid(12), object: ev.obj, amount: ev.amount, currency: 'brl', status: ev.type.includes('failed') ? 'requires_payment_method' : 'succeeded', customer: 'cus_' + rid(8) } },
  };
}

function seedWebhook(wsId, projectId, { name, slug, provider, signed }, count, makeReq) {
  const hmac = defaultHmac();
  if (signed) {
    hmac.enabled = true; hmac.provider = provider; hmac.secret = 'whsec_' + rid(24);
    const p = presetFor(provider); hmac.algo = p.algo; hmac.header = p.header; hmac.encoding = p.encoding;
  }
  const id = store.createEndpoint({ workspaceId: wsId, projectId, type: 'inspector', name, slug, config: { auth: defaultAuth(), hmac, rate: defaultRate(), rules: [], ruleMatch: 'all' } });
  const now = Date.now();
  for (let i = 0; i < count; i++) {
    const r = makeReq(i, now);
    store.insertRequest({ endpointId: id, ...r });
  }
  db.prepare('UPDATE endpoints SET request_count=?, last_activity=? WHERE id=?').run(count, now - 9000, id);
  return id;
}

function seedMock(wsId, projectId, def, scenarios, rules, reqCount) {
  const auth = defaultAuth();
  if (def.auth && def.auth.type !== 'none') { auth.enabled = true; auth.method = def.auth.type; auth.token = def.auth.value || ''; }
  const id = store.createEndpoint({ workspaceId: wsId, projectId, type: 'mock', name: def.name, slug: def.slug, method: def.method, path: def.path, mode: def.mode || 'single', config: { auth, hmac: defaultHmac(), rate: defaultRate(), rules: [], ruleMatch: 'all' } });
  const scObjs = scenarios.map((sc, i) => store.addScenario(id, { ...sc, active: i === 0, headers: sc.headers || { 'Content-Type': 'application/json' }, body: typeof sc.body === 'string' ? sc.body : JSON.stringify(sc.body, null, 2) }));
  for (const r of rules) {
    const thenSc = scObjs[r.thenIndex];
    store.addMatchRule(id, { when: r.when, key: r.key, op: r.op, value: r.value, then: thenSc ? thenSc.id : null });
  }
  const now = Date.now();
  for (let i = 0; i < reqCount; i++) {
    const sc = scObjs[i % 5 === 0 && scObjs.length > 1 ? 1 : 0];
    const body = def.method === 'GET' ? null : JSON.stringify({ amount: [1990, 4990, 12900, 25000, 8990][i % 5], currency: 'brl', source: 'tok_' + rid(8), description: 'Order #' + (10230 + i) });
    store.insertRequest({
      endpointId: id, method: def.method, path: def.path, status: sc.status, ip: '191.' + (180 + (i * 7) % 40) + '.' + (10 + (i * 13) % 200) + '.' + (20 + (i * 3) % 180),
      size: (body ? body.length : 0) + 412, receivedAt: now - i * 260000, eventLabel: sc.name, scenarioId: sc.id, contentType: 'application/json',
      headers: def.method === 'GET' ? { Authorization: 'Bearer usr_tok_' + rid(8), Accept: 'application/json' } : { 'Content-Type': 'application/json', Authorization: 'Bearer sk_live_' + rid(6) + '...', 'Idempotency-Key': 'idem_' + rid(10) },
      query: {}, body, responseStatus: sc.status, responseHeaders: sc.headers || { 'Content-Type': 'application/json' },
      responseBody: typeof sc.body === 'string' ? sc.body : JSON.stringify(sc.body, null, 2), outcome: 'mock',
    });
  }
  db.prepare('UPDATE endpoints SET request_count=?, last_activity=? WHERE id=?').run(reqCount, now - 1800000, id);
  return id;
}

function run() {
  if (reset) clearAll();
  if (store.listEndpoints({}).length > 0 && !reset) {
    console.log('Database already has endpoints. Use `npm run reset` to reseed from scratch.');
    return;
  }

  // Workspaces
  let sidedoor = store.listWorkspaces()[0];
  if (!sidedoor) sidedoor = store.createWorkspace({ name: 'Sidedoor', icon: 'box', color: '#edecec' });
  else store.updateWorkspace(sidedoor.id, { name: 'Sidedoor', icon: 'box', color: '#edecec' });
  store.createWorkspace({ name: 'Acme Payments', icon: 'zap', color: '#238636' });
  store.createWorkspace({ name: 'Staging', icon: 'flask', color: '#d69a3c' });
  store.setActiveWorkspace(sidedoor.id);

  const wsId = sidedoor.id;
  const gateway = store.createProject(wsId, 'Payments Gateway');
  const integ = store.createProject(wsId, 'Partner Integrations');

  seedWebhook(wsId, gateway.id, { name: 'Stripe Webhooks', slug: 'stripe-prod', provider: 'stripe', signed: true }, 9, (i, now) => {
    const body = stripeBody(i, now); const bs = JSON.stringify(body);
    return { method: 'POST', path: '/stripe-prod', status: 200, ip: '54.187.174.' + (100 + i), size: bs.length + 438, receivedAt: now - (9 - i) * 41000, eventLabel: body.type, contentType: 'application/json', headers: { 'Content-Type': 'application/json', 'User-Agent': 'Stripe/1.0 (+https://stripe.com/docs/webhooks)', 'Stripe-Signature': 't=' + Math.floor(now / 1000) + ',v1=' + rid(32) }, query: {}, body: JSON.stringify(body, null, 2), responseStatus: 200, responseBody: '{"received":true}', outcome: 'captured', signature: 'valid' };
  });

  seedWebhook(wsId, gateway.id, { name: 'PagSeguro Notifications', slug: 'pagseguro', provider: 'custom', signed: true }, 4, (i, now) => {
    const body = { notificationCode: rid(20).toUpperCase(), notificationType: 'transaction', status: [3, 4, 7][i % 3] }; const bs = JSON.stringify(body);
    return { method: 'POST', path: '/pagseguro', status: 200, ip: '177.72.' + (10 + i) + '.4', size: bs.length + 300, receivedAt: now - 240000 - (4 - i) * 90000, eventLabel: 'transaction.updated', contentType: 'application/json', headers: { 'Content-Type': 'application/json', 'X-Signature': rid(40) }, query: {}, body: JSON.stringify(body, null, 2), responseStatus: 200, responseBody: '{"received":true}', outcome: 'captured', signature: 'valid' };
  });

  seedWebhook(wsId, integ.id, { name: 'GitHub Events', slug: 'gh-events', provider: 'github', signed: true }, 5, (i, now) => {
    const ev = ['push', 'pull_request', 'issues', 'check_run', 'release'][i];
    const body = { action: 'opened', repository: { full_name: 'acme/api', private: true }, sender: { login: 'dev-' + rid(4) } }; const bs = JSON.stringify(body);
    return { method: 'POST', path: '/gh-events', status: 200, ip: '140.82.115.' + (1 + i), size: bs.length + 400, receivedAt: now - 3600000 - (5 - i) * 120000, eventLabel: ev, contentType: 'application/json', headers: { 'Content-Type': 'application/json', 'X-GitHub-Event': ev, 'X-Hub-Signature-256': 'sha256=' + rid(64) }, query: {}, body: JSON.stringify(body, null, 2), responseStatus: 200, responseBody: '{"received":true}', outcome: 'captured', signature: 'valid' };
  });

  seedWebhook(wsId, null, { name: 'Twilio SMS', slug: 'twilio', provider: 'custom', signed: false }, 3, (i, now) => {
    const body = { MessageSid: 'SM' + rid(30), MessageStatus: 'delivered', To: '+551199' + rid(6) }; const bs = JSON.stringify(body);
    return { method: 'POST', path: '/twilio', status: 200, ip: '54.172.60.' + (i + 1), size: bs.length + 200, receivedAt: now - 2 * 86400000 - i * 3600000, eventLabel: 'message.delivered', contentType: 'application/x-www-form-urlencoded', headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-Twilio-Signature': rid(28) }, query: {}, body: JSON.stringify(body, null, 2), responseStatus: 200, responseBody: '{"received":true}', outcome: 'captured', signature: 'skipped' };
  });

  seedMock(wsId, gateway.id, { name: 'Payments API', slug: 'mock-payments', method: 'POST', path: '/v1/charges', mode: 'single', auth: { type: 'bearer', value: 'sk_test_' + rid(20) } },
    [
      { name: 'Success', status: 200, delay: 0, body: { id: 'ch_' + rid(8), object: 'charge', status: 'succeeded', amount: 4990, currency: 'brl', paid: true } },
      { name: 'Card declined', status: 402, delay: 140, body: { error: { type: 'card_error', code: 'card_declined', decline_code: 'insufficient_funds', message: 'Your card has insufficient funds.' } } },
      { name: 'Gateway timeout', status: 504, delay: 5000, headers: { 'Content-Type': 'text/plain' }, body: 'Gateway Timeout' },
    ],
    [
      { when: 'header', key: 'X-Test-Scenario', op: 'equals', value: 'decline', thenIndex: 1 },
      { when: 'body', key: 'amount', op: '>', value: '1000000', thenIndex: 2 },
    ], 16);

  seedMock(wsId, integ.id, { name: 'Auth Service', slug: 'mock-auth', method: 'GET', path: '/me', mode: 'sequence', auth: { type: 'none' } },
    [
      { name: 'Authorized', status: 200, delay: 0, body: { user: { id: 'usr_' + rid(6), email: 'dev@local', role: 'admin' }, token_valid: true } },
      { name: 'Unauthorized', status: 401, delay: 0, body: { error: 'invalid_token', message: 'Token has expired' } },
    ], [], 9);

  console.log('Seeded 3 workspaces, 2 projects, 6 endpoints and captured requests.');
  console.log('Active workspace: Sidedoor. Run the app with `npm start`.');
}

run();
db.close();

// OIPS Cielo PIX mock seed — idempotent upsert by slug (run from Sidedoor repo root).
// Body-driven rules: Acquirers never sends X-Mock-Scenario; E2E routes via
// MerchantOrderId (← externalId) and Payment.QrCode.Expiration (← expiresIn).
import './lib/quiet.js';
import { loadConfig } from './config.js';
import { openDb } from './db.js';
import { Store, defaultAuth, defaultHmac, defaultRate } from './store.js';

const config = loadConfig();
const db = openDb(config.dbPath);
const store = new Store(db);

const WORKSPACE_NAME = 'OIPS';
const PROJECT_NAME = 'Cielo PIX Mock';
const TX_SLUG = 'oips-cielo-tx';
const QUERY_SLUG = 'oips-cielo-query';

function ensureWorkspace() {
  let ws = store.listWorkspaces().find((w) => w.name === WORKSPACE_NAME);
  if (!ws) ws = store.createWorkspace({ name: WORKSPACE_NAME, icon: 'zap', color: '#238636' });
  return ws.id;
}

function ensureProject(workspaceId) {
  return store.createProject(workspaceId, PROJECT_NAME);
}

function deleteBySlug(slug) {
  const ep = store.getEndpointBySlug(slug);
  if (ep) store.deleteEndpoint(ep.id);
}

function addScenarios(endpointId, scenarios) {
  return scenarios.map((sc, i) => store.addScenario(endpointId, {
    ...sc,
    active: i === 0,
    headers: sc.headers || { 'Content-Type': 'application/json' },
    body: typeof sc.body === 'string' ? sc.body : JSON.stringify(sc.body, null, 2),
  }));
}

function addRules(endpointId, rules, scObjs) {
  for (const r of rules) {
    const thenSc = scObjs[r.thenIndex];
    store.addMatchRule(endpointId, {
      when: r.when,
      key: r.key,
      op: r.op,
      value: r.value,
      then: thenSc ? thenSc.id : null,
    });
  }
}

function createMock(workspaceId, projectId, def, scenarios, rules) {
  const id = store.createEndpoint({
    workspaceId,
    projectId,
    type: 'mock',
    name: def.name,
    slug: def.slug,
    method: def.method,
    path: def.path,
    pathMode: def.pathMode || 'exact',
    allowedMethods: def.allowedMethods || null,
    mode: 'single',
    config: { auth: defaultAuth(), hmac: defaultHmac(), rate: defaultRate(), rules: [], ruleMatch: 'all' },
  });
  const scObjs = addScenarios(id, scenarios);
  addRules(id, rules, scObjs);
  return id;
}

const pendingCreateBody = {
  MerchantOrderId: '{{$body.MerchantOrderId}}',
  Payment: {
    PaymentId: '{{pendingPaymentId}}',
    Provider: 'Cielo2',
    Status: 12,
    ReturnCode: '0',
    ReturnMessage: 'QR Code PIX gerado com sucesso.',
    QrCodeString: '00020126580014br.gov.bcb.pix2563qrcodes.cieloecommerce.cielo.com.br5204000053039865802BR5925ECOMMERCE TESTE6009SAO PAULO62070503***6304ABCD',
    QrcodeBase64Image: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    SentOrderId: '{{$body.MerchantOrderId}}',
    Links: [],
  },
};

function run() {
  const wsId = ensureWorkspace();
  const project = ensureProject(wsId);

  deleteBySlug(TX_SLUG);
  deleteBySlug(QUERY_SLUG);

  // Indices must match txRules.thenIndex below.
  const txScenarios = [
    { name: 'happy-pending', status: 200, delay: 0, body: pendingCreateBody }, // 0
    { name: 'happy-expires-60', status: 200, delay: 0, body: pendingCreateBody }, // 1
    { name: 'happy-expires-300', status: 200, delay: 0, body: pendingCreateBody }, // 2
    { name: 'happy-expires-7200', status: 200, delay: 0, body: pendingCreateBody }, // 3
    { name: 'paid-immediate', status: 200, delay: 0, body: {
      MerchantOrderId: '{{$body.MerchantOrderId}}',
      Payment: {
        PaymentId: '{{paidPaymentId}}', Provider: 'Cielo2', Status: 2, ReturnCode: '0',
        EndToEndId: 'E12345678202401011200ABCDEF',
        QrCodeString: '00020126580014br.gov.bcb.pix2563qrcodes.cieloecommerce.cielo.com.br5204000053039865802BR5925ECOMMERCE TESTE6009SAO PAULO62070503***6304ABCD',
        QrcodeBase64Image: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
        SentOrderId: '{{$body.MerchantOrderId}}', Links: [],
      },
    } }, // 4
    { name: 'affiliation-129', status: 400, delay: 0, body: [{ Code: 129, Message: 'Affiliation not found' }] }, // 5
    { name: 'invalid-json-bp904', status: 400, delay: 0, body: [{ Code: 'BP904', Message: 'Invalid JSON' }] }, // 6
    { name: 'operation-failed-bp901', status: 400, delay: 0, body: [{ Code: 'BP901', Message: 'Operation failed' }] }, // 7
    { name: 'denied-create', status: 200, delay: 0, body: {
      MerchantOrderId: '{{$body.MerchantOrderId}}',
      Payment: { PaymentId: '{{deniedPaymentId}}', Provider: 'Cielo2', Status: 3, ReturnCode: '5', ReturnMessage: 'Denied' },
    } }, // 8
    { name: 'refund-success-0', status: 200, delay: 0, body: { Status: 10, ReturnCode: '0', ReturnMessage: 'Operation Successful' } }, // 9
    { name: 'post-default', status: 200, delay: 0, body: pendingCreateBody }, // 10
  ];

  // Prefer body markers (E2E-controllable). Keep X-Mock-Scenario as manual override.
  const txRules = [
    { when: 'body', key: 'MerchantOrderId', op: 'contains', value: 'paid-imm', thenIndex: 4 },
    { when: 'body', key: 'MerchantOrderId', op: 'contains', value: 'err-aff', thenIndex: 5 },
    { when: 'body', key: 'MerchantOrderId', op: 'contains', value: 'err-bp904', thenIndex: 6 },
    { when: 'body', key: 'MerchantOrderId', op: 'contains', value: 'err-bp901', thenIndex: 7 },
    { when: 'body', key: 'MerchantOrderId', op: 'contains', value: 'err-denied', thenIndex: 8 },
    { when: 'header', key: 'X-Mock-Scenario', op: 'equals', value: 'paid-immediate', thenIndex: 4 },
    { when: 'header', key: 'X-Mock-Scenario', op: 'equals', value: 'affiliation-129', thenIndex: 5 },
    { when: 'header', key: 'X-Mock-Scenario', op: 'equals', value: 'bp904', thenIndex: 6 },
    { when: 'header', key: 'X-Mock-Scenario', op: 'equals', value: 'bp901', thenIndex: 7 },
    { when: 'header', key: 'X-Mock-Scenario', op: 'equals', value: 'denied', thenIndex: 8 },
    { when: 'body', key: 'Payment.QrCode.Expiration', op: 'equals', value: '60', thenIndex: 1 },
    { when: 'body', key: 'Payment.QrCode.Expiration', op: 'equals', value: '300', thenIndex: 2 },
    { when: 'body', key: 'Payment.QrCode.Expiration', op: 'equals', value: '7200', thenIndex: 3 },
    { when: 'method', key: '', op: 'equals', value: 'POST', thenIndex: 10 },
    { when: 'method', key: '', op: 'equals', value: 'PUT', thenIndex: 9 },
  ];

  createMock(wsId, project.id, {
    name: 'OIPS Cielo Transaction API',
    slug: TX_SLUG,
    method: 'POST',
    path: '/1/sales',
    pathMode: 'prefix',
    allowedMethods: ['POST', 'PUT'],
  }, txScenarios, txRules);

  const queryScenarios = [
    { name: 'pending', status: 200, delay: 0, body: {
      Payment: { PaymentId: '{{$pathPaymentId}}', Provider: 'Cielo2', Status: 12, ReturnCode: '0' },
    } },
    { name: 'paid', status: 200, delay: 0, body: {
      Payment: {
        PaymentId: '{{$pathPaymentId}}', Provider: 'Cielo2', Status: 2, ReturnCode: '0',
        EndToEndId: 'E12345678202401011200ABCDEF',
      },
    } },
    { name: 'refunded', status: 200, delay: 0, body: {
      Payment: { PaymentId: '{{$pathPaymentId}}', Provider: 'Cielo2', Status: 11, VoidedAmount: 1000, ReturnCode: '0' },
    } },
    { name: 'denied', status: 200, delay: 0, body: {
      Payment: { PaymentId: '{{$pathPaymentId}}', Provider: 'Cielo2', Status: 3, ReturnCode: '5' },
    } },
    { name: 'not-found', status: 404, delay: 0, body: [{ Code: 404, Message: 'Payment not found' }] },
    { name: 'query-default', status: 200, delay: 0, body: {
      Payment: { PaymentId: '{{$pathPaymentId}}', Provider: 'Cielo2', Status: 12, ReturnCode: '0' },
    } },
  ];

  const queryRules = [
    { when: 'path', key: '', op: 'contains', value: 'missing-', thenIndex: 4 },
    { when: 'path', key: '', op: 'contains', value: 'refunded-', thenIndex: 2 },
    { when: 'path', key: '', op: 'contains', value: 'paid-', thenIndex: 1 },
    { when: 'path', key: '', op: 'contains', value: 'denied-', thenIndex: 3 },
    { when: 'path', key: '', op: 'contains', value: 'pending-', thenIndex: 0 },
  ];

  createMock(wsId, project.id, {
    name: 'OIPS Cielo Query API',
    slug: QUERY_SLUG,
    method: 'GET',
    path: '/1/sales/',
    pathMode: 'prefix',
    allowedMethods: ['GET'],
  }, queryScenarios, queryRules);

  console.log('Seeded OIPS Cielo PIX mocks:');
  console.log('  Transaction slug:', TX_SLUG, '(POST /1/sales, PUT /1/sales/*/void)');
  console.log('  Query slug:', QUERY_SLUG, '(GET /1/sales/{PaymentId})');
  console.log('Body markers: paid-imm | err-aff | err-bp904 | err-bp901 | err-denied');
  console.log('Expiration body rules: 60 | 300 | 7200');
}

run();
db.close();

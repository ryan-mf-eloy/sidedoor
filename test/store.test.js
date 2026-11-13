import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, SCHEMA_VERSION } from '../src/db.js';
import { Store } from '../src/store.js';

function fresh() {
  return new Store(openDb(':memory:'));
}

test('boots with one default workspace + funnel row', () => {
  const s = fresh();
  assert.equal(s.listWorkspaces().length, 1);
  assert.equal(s.listWorkspaces()[0].name, 'Sidedoor');
  assert.ok(s.getActiveWorkspace());
  assert.equal(s.getFunnel().active, 0);
});

test('workspace CRUD + last-workspace guard + active repoint', () => {
  const s = fresh();
  const first = s.getActiveWorkspace();
  const w2 = s.createWorkspace({ name: 'Acme', icon: 'zap', color: '#238636' });
  assert.equal(s.listWorkspaces().length, 2);
  s.setActiveWorkspace(w2.id);
  const del = s.deleteWorkspace(w2.id);
  assert.equal(del.ok, true);
  assert.equal(del.active, first); // repointed
  // cannot delete the last one
  assert.equal(s.deleteWorkspace(first).ok, false);
});

test('projects dedupe by name within a workspace', () => {
  const s = fresh();
  const ws = s.getActiveWorkspace();
  const p1 = s.createProject(ws, 'Gateway');
  const p2 = s.createProject(ws, 'Gateway');
  assert.equal(p1.id, p2.id);
  assert.equal(s.listProjects(ws).length, 1);
});

test('updateProject: renames, rejects duplicates, and deleting keeps endpoints unassigned', () => {
  const s = fresh();
  const ws = s.getActiveWorkspace();
  const p1 = s.createProject(ws, 'Gateway');
  const p2 = s.createProject(ws, 'Payments');
  const renamed = s.updateProject(p1.id, 'Gateway BR');
  assert.equal(renamed.ok, true);
  assert.equal(renamed.project.name, 'Gateway BR');
  assert.deepEqual(s.updateProject(p1.id, 'Payments'), { ok: false, reason: 'duplicate-name' });
  assert.deepEqual(s.updateProject(p1.id, '  '), { ok: false, reason: 'empty-name' });
  assert.deepEqual(s.updateProject('missing', 'X'), { ok: false, reason: 'not-found' });

  const epId = s.createEndpoint({ workspaceId: ws, projectId: p2.id, type: 'inspector', name: 'W', slug: 'proj-del', config: {} });
  s.deleteProject(p2.id);
  assert.equal(s.getEndpoint(epId).project, null); // endpoint survives, just unassigned
});

test('endpoint create/hydrate/update, unique slug', () => {
  const s = fresh();
  const ws = s.getActiveWorkspace();
  const id = s.createEndpoint({ workspaceId: ws, type: 'inspector', name: 'GH', slug: 'gh', config: {} });
  const ep = s.getEndpoint(id);
  assert.equal(ep.config.hmac.enabled, false);
  assert.equal(s.slugExists('gh'), true);
  assert.equal(s.slugExists('gh', id), false); // excluding self
  s.updateEndpoint(id, { hmac: { enabled: true, provider: 'github' } });
  assert.equal(s.getEndpoint(id).config.hmac.provider, 'github');
});

test('scenarios: add, single-active toggle, delete', () => {
  const s = fresh();
  const ws = s.getActiveWorkspace();
  const id = s.createEndpoint({ workspaceId: ws, type: 'mock', name: 'M', slug: 'm', method: 'POST', path: '/x', config: {} });
  const a = s.addScenario(id, { name: 'A', status: 200, active: true, body: '{}' });
  const b = s.addScenario(id, { name: 'B', status: 500, body: '{}' });
  assert.equal(s.activeScenario(id).id, a.id);
  s.activateScenario(id, b.id);
  assert.equal(s.activeScenario(id).id, b.id);
  assert.equal(s.listScenarios(id).filter((x) => x.active).length, 1);
  s.deleteScenario(a.id);
  assert.equal(s.listScenarios(id).length, 1);
});

test('requests: seq increments, filters, clear', () => {
  const s = fresh();
  const ws = s.getActiveWorkspace();
  const id = s.createEndpoint({ workspaceId: ws, type: 'inspector', name: 'W', slug: 'w', config: {} });
  s.insertRequest({ endpointId: id, method: 'POST', path: '/w', status: 200, eventLabel: 'a.b', body: '{"x":1}' });
  s.insertRequest({ endpointId: id, method: 'GET', path: '/w', status: 404, eventLabel: 'c.d', body: '' });
  assert.equal(s.listRequests({ endpointId: id }).length, 2);
  assert.equal(s.listRequests({ endpointId: id })[1].seq, 2); // ascending, newest last
  assert.equal(s.listRequests({ endpointId: id, method: 'GET' }).length, 1);
  assert.equal(s.listRequests({ endpointId: id, search: 'a.b' }).length, 1);
  assert.equal(s.listRequests({ endpointId: id, after: 1 }).length, 1); // only seq>1
  s.clearRequests(id);
  assert.equal(s.listRequests({ endpointId: id }).length, 0);
});

test('cascade delete removes scenarios/rules/requests', () => {
  const s = fresh();
  const ws = s.getActiveWorkspace();
  const id = s.createEndpoint({ workspaceId: ws, type: 'mock', name: 'M', slug: 'mm', method: 'POST', path: '/x', config: {} });
  const sc = s.addScenario(id, { name: 'A', active: true, body: '{}' });
  s.addMatchRule(id, { when: 'header', key: 'k', op: 'equals', value: 'v', then: sc.id });
  s.insertRequest({ endpointId: id, method: 'POST', path: '/x', status: 200 });
  s.deleteEndpoint(id);
  assert.equal(s.getEndpoint(id), null);
  assert.equal(s.db.prepare('SELECT COUNT(*) AS n FROM scenarios WHERE endpoint_id=?').get(id).n, 0);
  assert.equal(s.db.prepare('SELECT COUNT(*) AS n FROM match_rules WHERE endpoint_id=?').get(id).n, 0);
  assert.equal(s.db.prepare('SELECT COUNT(*) AS n FROM requests WHERE endpoint_id=?').get(id).n, 0);
});

test('deleting a workspace cascades to endpoints', () => {
  const s = fresh();
  const ws2 = s.createWorkspace({ name: 'Scoped' });
  const id = s.createEndpoint({ workspaceId: ws2.id, type: 'inspector', name: 'X', slug: 'scoped-x', config: {} });
  assert.ok(s.getEndpoint(id));
  s.deleteWorkspace(ws2.id);
  assert.equal(s.getEndpoint(id), null);
});

test('sequence cursor rotates', () => {
  const s = fresh();
  const ws = s.getActiveWorkspace();
  const id = s.createEndpoint({ workspaceId: ws, type: 'mock', name: 'M', slug: 'seq', method: 'GET', path: '/x', config: {} });
  assert.deepEqual([0, 1, 2, 0].map(() => s.advanceSeqCursor(id, 3)), [0, 1, 2, 0]);
});

test('restart recovery never requeues a cancelled in-flight delivery', () => {
  const s = fresh();
  const ws = s.getActiveWorkspace();
  const endpointId = s.createEndpoint({ workspaceId: ws, type: 'mock', name: 'Queue', slug: 'queue', method: 'POST', path: '/jobs', config: {} });
  const scenario = s.addScenario(endpointId, { name: 'Accepted', active: true, body: '{}' });
  const event = s.addScenarioEvent(scenario.id, { name: 'Callback', request: { url: 'https://receiver.example.test/callback' } });
  const run = s.createEventRun({ endpointId, scenarioId: scenario.id, events: [event], context: {} });
  assert.ok(s.claimDueEventJob(Date.now() + 1));
  s.cancelEventRun(run.id);
  s.recoverEventJobs(Date.now() + 2);

  const recovered = s.getEventRun(run.id, { details: true });
  assert.equal(recovered.status, 'cancelled');
  assert.equal(recovered.pendingJobs, 0);
  assert.equal(recovered.jobs[0].status, 'cancelled');
});

test('deleting a mock cascades its async-event configuration and delivery history', () => {
  const s = fresh();
  const ws = s.getActiveWorkspace();
  const endpointId = s.createEndpoint({ workspaceId: ws, type: 'mock', name: 'Cascade', slug: 'cascade', method: 'POST', path: '/jobs', config: {} });
  const scenario = s.addScenario(endpointId, { name: 'Accepted', active: true, body: '{}' });
  const event = s.addScenarioEvent(scenario.id, { name: 'Callback', request: { url: 'https://receiver.example.test/callback' } });
  const run = s.createEventRun({ endpointId, scenarioId: scenario.id, events: [event], context: {} });
  const execution = s.claimDueEventJob(Date.now() + 1);
  s.recordEventAttempt(execution.job.id, { ok: true, status: 204, durationMs: 1 });
  s.deleteEndpoint(endpointId);

  assert.equal(s.db.prepare('SELECT COUNT(*) AS n FROM scenario_events').get().n, 0);
  assert.equal(s.db.prepare('SELECT COUNT(*) AS n FROM event_runs WHERE id=?').get(run.id).n, 0);
  assert.equal(s.db.prepare('SELECT COUNT(*) AS n FROM event_jobs').get().n, 0);
  assert.equal(s.db.prepare('SELECT COUNT(*) AS n FROM event_attempts').get().n, 0);
});

test('activity + counts scope HTTP and realtime mock servers to the workspace', () => {
  const s = fresh();
  const ws = s.getActiveWorkspace();
  const id = s.createEndpoint({ workspaceId: ws, type: 'inspector', name: 'W', slug: 'act', config: {} });
  s.insertRequest({ endpointId: id, method: 'POST', path: '/act', status: 200, eventLabel: 'e1' });
  s.bumpActivity(id, Date.now());
  const mockId = s.createEndpoint({ workspaceId: ws, type: 'mock', name: 'M', slug: 'act-mock', method: 'POST', path: '/x', config: {} });
  s.insertRequest({ endpointId: mockId, method: 'POST', path: '/x', status: 201, eventLabel: 'e2' });
  s.bumpActivity(mockId, Date.now());
  s.createEndpoint({ workspaceId: ws, type: 'mock', protocol: 'websocket', name: 'Stream', slug: 'act-stream', config: {} });

  const activity = s.recentActivity(ws);
  assert.equal(activity.length, 2);
  assert.deepEqual(activity.map((a) => a.epType).sort(), ['inspector', 'mock']);

  const counts = s.counts(ws);
  assert.equal(counts.webhooks, 1);
  assert.equal(counts.mocks, 2);
  assert.equal(counts.websockets, 1);
  assert.equal(counts.captured, 1);
  assert.equal(counts.mocked, 1);
  assert.equal(counts.totalRequests, 2);
});

test('requestsOverview: buckets, status breakdown, trend vs previous period', () => {
  const s = fresh();
  const ws = s.getActiveWorkspace();
  const id = s.createEndpoint({ workspaceId: ws, type: 'inspector', name: 'W', slug: 'ov', config: {} });
  const mockId = s.createEndpoint({ workspaceId: ws, type: 'mock', name: 'M', slug: 'ov-mock', method: 'POST', path: '/x', config: {} });
  const now = Date.now();
  const HOUR = 3600000;
  // current 24h window: 3 requests (2×2xx, 1×4xx) spread across buckets
  s.insertRequest({ endpointId: id, method: 'GET', path: '/ov', status: 200, receivedAt: now - 1000 });
  s.insertRequest({ endpointId: id, method: 'GET', path: '/ov', status: 200, receivedAt: now - 2 * HOUR - 1000 });
  s.insertRequest({ endpointId: mockId, method: 'POST', path: '/x', status: 404, receivedAt: now - 5 * HOUR - 1000 });
  // previous 24h window (24-48h ago): 2 requests — a known previousTotal
  s.insertRequest({ endpointId: id, method: 'GET', path: '/ov', status: 500, receivedAt: now - 25 * HOUR });
  s.insertRequest({ endpointId: mockId, method: 'POST', path: '/x', status: 200, receivedAt: now - 30 * HOUR });
  // outside both windows — must not affect totals or the trend
  s.insertRequest({ endpointId: id, method: 'GET', path: '/ov', status: 200, receivedAt: now - 90 * HOUR });

  const ov = s.requestsOverview(ws, '24h');
  assert.equal(ov.period, '24h');
  assert.equal(ov.total, 3);
  assert.equal(ov.previousTotal, 2);
  assert.equal(ov.changePct, 50);
  assert.equal(ov.series.length, 24);
  assert.equal(ov.series.reduce((a, b) => a + b, 0), 3);
  assert.equal(ov.statusBreakdown.ok, 2);
  assert.equal(ov.statusBreakdown.clientError, 1);
  assert.equal(ov.statusBreakdown.serverError, 0);

  assert.equal(s.requestsOverview(ws, 'bogus-period').period, '24h'); // unknown period falls back

  const s2 = fresh();
  const ov2 = s2.requestsOverview(s2.getActiveWorkspace(), '7d');
  assert.equal(ov2.total, 0);
  assert.equal(ov2.changePct, 0);
  assert.equal(ov2.series.length, 7);
});

test('migration v1->v2: existing match_rules rows survive, when_field widened', () => {
  // :memory: databases can't be closed and reopened by path, so this uses a
  // real temp file — build a v1-shaped database by hand (the schema in place
  // before this migration existed) with a real pre-existing rule, then open
  // it through the app's own openDb() and confirm the migration ran.
  const dir = mkdtempSync(join(tmpdir(), 'sidedoor-migration-'));
  const dbPath = join(dir, 'test.db');
  try {
    const setup = new DatabaseSync(dbPath);
    setup.exec('CREATE TABLE endpoints (id TEXT PRIMARY KEY, workspace_id TEXT, type TEXT, name TEXT, slug TEXT)');
    setup.exec('CREATE TABLE scenarios (id TEXT PRIMARY KEY, endpoint_id TEXT, name TEXT, status INTEGER, position INTEGER)');
    setup.exec(`CREATE TABLE match_rules (
      id TEXT PRIMARY KEY, endpoint_id TEXT NOT NULL, when_field TEXT NOT NULL CHECK (when_field IN ('header','body','query')),
      key TEXT NOT NULL DEFAULT '', op TEXT NOT NULL DEFAULT 'equals', value TEXT NOT NULL DEFAULT '',
      then_scenario_id TEXT, position INTEGER NOT NULL DEFAULT 0
    )`);
    setup.exec('CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT)');
    setup.prepare("INSERT INTO meta VALUES('schema_version','1')").run();
    setup.prepare('INSERT INTO endpoints(id,type,name,slug) VALUES (?,?,?,?)').run('ep-1', 'mock', 'M', 'm');
    setup.prepare('INSERT INTO scenarios(id,endpoint_id,name,status) VALUES (?,?,?,?)').run('sc-1', 'ep-1', 'Declined', 402);
    setup.prepare('INSERT INTO match_rules(id,endpoint_id,when_field,key,op,value,then_scenario_id,position) VALUES (?,?,?,?,?,?,?,?)')
      .run('mr-1', 'ep-1', 'header', 'X-Test-Scenario', 'equals', 'decline', 'sc-1', 0);
    setup.close();

    const db = openDb(dbPath); // must run the migration on this pre-existing file
    const s = new Store(db);

    assert.equal(db.prepare("SELECT value FROM meta WHERE key='schema_version'").get().value, SCHEMA_VERSION);
    const survived = s.listMatchRules('ep-1');
    assert.equal(survived.length, 1);
    assert.deepEqual(survived[0], { id: 'mr-1', when: 'header', key: 'X-Test-Scenario', op: 'equals', value: 'decline', then: 'sc-1', position: 0, enabled: true });

    // The widened constraint actually accepts new method/path rules post-migration.
    assert.equal(s.addMatchRule('ep-1', { when: 'method', key: '', op: 'equals', value: 'GET', then: 'sc-1' }).when, 'method');
    assert.equal(s.addMatchRule('ep-1', { when: 'path', key: '', op: 'contains', value: '/v2', then: 'sc-1' }).when, 'path');

    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('migration v3->v4: async event tables are added without changing scenario data', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sidedoor-v3-migration-'));
  const dbPath = join(dir, 'test.db');
  try {
    const setup = new DatabaseSync(dbPath);
    setup.exec(`
      CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);
      CREATE TABLE endpoints (
        id TEXT PRIMARY KEY, workspace_id TEXT, project_id TEXT, type TEXT, name TEXT, slug TEXT,
        method TEXT, path TEXT, path_mode TEXT NOT NULL DEFAULT 'exact', allowed_methods TEXT,
        mode TEXT, forward_target TEXT, seq_cursor INTEGER, config_auth TEXT, config_hmac TEXT,
        config_rate TEXT, config_rules TEXT, rule_match TEXT, created_at INTEGER, last_activity INTEGER, request_count INTEGER
      );
      CREATE TABLE scenarios (
        id TEXT PRIMARY KEY, endpoint_id TEXT NOT NULL, name TEXT NOT NULL, status INTEGER NOT NULL,
        delay_ms INTEGER NOT NULL DEFAULT 0, is_active INTEGER NOT NULL DEFAULT 0, headers TEXT, body TEXT,
        content_type TEXT NOT NULL DEFAULT 'application/json', position INTEGER NOT NULL DEFAULT 0
      );
    `);
    setup.prepare("INSERT INTO meta(key,value) VALUES('schema_version','3')").run();
    setup.prepare('INSERT INTO endpoints(id,type,name,slug,path_mode,mode,seq_cursor,created_at,request_count) VALUES(?,?,?,?,?,?,?,?,?)')
      .run('ep-v3', 'mock', 'Legacy mock', 'legacy-v3', 'exact', 'single', 0, Date.now(), 0);
    setup.prepare('INSERT INTO scenarios(id,endpoint_id,name,status,body,content_type,position) VALUES(?,?,?,?,?,?,?)')
      .run('sc-v3', 'ep-v3', 'Existing scenario', 202, '{"ok":true}', 'application/json', 0);
    setup.close();

    const db = openDb(dbPath);
    const store = new Store(db);
    assert.equal(db.prepare("SELECT value FROM meta WHERE key='schema_version'").get().value, SCHEMA_VERSION);
    for (const table of ['scenario_events', 'event_runs', 'event_jobs', 'event_attempts']) {
      assert.ok(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(table));
    }
    assert.equal(store.getScenario('sc-v3').body, '{"ok":true}');
    const event = store.addScenarioEvent('sc-v3', {
      name: 'Legacy callback',
      request: { url: 'https://example.test/callback', method: 'POST' },
    });
    assert.equal(store.listScenarioEvents('sc-v3')[0].id, event.id);
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('migration v4->v5: legacy HTTP endpoints gain realtime defaults and cascades', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sidedoor-v4-migration-'));
  const dbPath = join(dir, 'test.db');
  try {
    const setup = new DatabaseSync(dbPath);
    setup.exec(`
      CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);
      CREATE TABLE endpoints (
        id TEXT PRIMARY KEY, workspace_id TEXT, project_id TEXT, type TEXT, name TEXT, slug TEXT,
        method TEXT, path TEXT, path_mode TEXT NOT NULL DEFAULT 'exact', allowed_methods TEXT,
        mode TEXT NOT NULL DEFAULT 'single', forward_target TEXT, seq_cursor INTEGER NOT NULL DEFAULT 0,
        config_auth TEXT, config_hmac TEXT, config_rate TEXT, config_rules TEXT,
        rule_match TEXT NOT NULL DEFAULT 'all', created_at INTEGER NOT NULL, last_activity INTEGER, request_count INTEGER NOT NULL DEFAULT 0
      );
    `);
    setup.prepare("INSERT INTO meta(key,value) VALUES('schema_version','4')").run();
    setup.prepare('INSERT INTO endpoints(id,type,name,slug,path_mode,mode,seq_cursor,created_at,request_count) VALUES(?,?,?,?,?,?,?,?,?)')
      .run('ep-v4', 'mock', 'Legacy HTTP mock', 'legacy-v4', 'exact', 'single', 0, Date.now(), 0);
    setup.close();

    const db = openDb(dbPath);
    const store = new Store(db);
    assert.equal(db.prepare("SELECT value FROM meta WHERE key='schema_version'").get().value, SCHEMA_VERSION);
    const legacy = store.getEndpoint('ep-v4');
    assert.equal(legacy.protocol, 'http');
    assert.equal(legacy.config.realtime.maxConnections, 100);
    for (const table of ['realtime_sessions', 'realtime_messages', 'realtime_scripts', 'realtime_script_steps', 'graphql_schemas', 'graphql_fixtures']) {
      assert.ok(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(table));
    }

    const session = store.createRealtimeSession({ endpointId: legacy.id, protocol: 'websocket', transport: 'websocket' });
    store.appendRealtimeMessage(session.id, { direction: 'in', kind: 'text', payload: 'hello', payloadSize: 5 }, 10);
    const script = store.addRealtimeScript(legacy.id, { name: 'Flow' });
    store.addRealtimeStep(script.id, { match: { kind: 'message', text: 'hello', payload: null }, actions: [] });
    store.setGraphqlSchema(legacy.id, 'type Query { health: String }');
    store.addGraphqlFixture(legacy.id, { name: 'Health', operationType: 'query', response: { data: { health: 'ok' } } });
    store.deleteEndpoint(legacy.id);
    for (const table of ['realtime_sessions', 'realtime_messages', 'realtime_scripts', 'realtime_script_steps', 'graphql_schemas', 'graphql_fixtures']) {
      assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n, 0);
    }
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

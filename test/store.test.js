import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../src/db.js';
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

test('activity + counts scoped to workspace, combining webhooks and mocks', () => {
  const s = fresh();
  const ws = s.getActiveWorkspace();
  const id = s.createEndpoint({ workspaceId: ws, type: 'inspector', name: 'W', slug: 'act', config: {} });
  s.insertRequest({ endpointId: id, method: 'POST', path: '/act', status: 200, eventLabel: 'e1' });
  s.bumpActivity(id, Date.now());
  const mockId = s.createEndpoint({ workspaceId: ws, type: 'mock', name: 'M', slug: 'act-mock', method: 'POST', path: '/x', config: {} });
  s.insertRequest({ endpointId: mockId, method: 'POST', path: '/x', status: 201, eventLabel: 'e2' });
  s.bumpActivity(mockId, Date.now());

  const activity = s.recentActivity(ws);
  assert.equal(activity.length, 2);
  assert.deepEqual(activity.map((a) => a.epType).sort(), ['inspector', 'mock']);

  const counts = s.counts(ws);
  assert.equal(counts.webhooks, 1);
  assert.equal(counts.mocks, 1);
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

    assert.equal(db.prepare("SELECT value FROM meta WHERE key='schema_version'").get().value, '2');
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

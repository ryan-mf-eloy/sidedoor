// Data-access layer over the SQLite database. All query logic lives here so the
// API and ingest layers work with plain hydrated objects.
import { newId } from './lib/ids.js';
import { safeParse, toColumn } from './lib/json.js';
import { presetFor } from './lib/hmac.js';
import { getAppState, setAppState } from './db.js';

export function defaultAuth() {
  return { enabled: false, method: 'none', header: 'Authorization', token: '', apiKeyName: 'X-Api-Key', apiKeyLoc: 'header', user: '', pass: '', failStatus: '401' };
}
export function defaultHmac() {
  return { enabled: false, provider: 'custom', secret: '', algo: 'sha256', header: 'X-Signature', encoding: 'hex', tolerance: '300', reject: true };
}
export function defaultRate() {
  return { enabled: false, limit: '120', window: 'minute', key: 'ip', keyHeader: '', burst: '20', status: '429', retryAfter: true };
}

// Merge stored JSON config over defaults so older rows always expose every field.
function hydrateConfig(row) {
  return {
    auth: { ...defaultAuth(), ...(safeParse(row.config_auth, {}) || {}) },
    hmac: { ...defaultHmac(), ...(safeParse(row.config_hmac, {}) || {}) },
    rate: { ...defaultRate(), ...(safeParse(row.config_rate, {}) || {}) },
    rules: safeParse(row.config_rules, []) || [],
    ruleMatch: row.rule_match || 'all',
  };
}

function plain(row) {
  return row ? { ...row } : null;
}

export class Store {
  constructor(db) {
    this.db = db;
  }

  tx(fn) {
    this.db.exec('BEGIN');
    try {
      const r = fn();
      this.db.exec('COMMIT');
      return r;
    } catch (e) {
      try { this.db.exec('ROLLBACK'); } catch { /* ignore */ }
      throw e;
    }
  }

  // ---- app state / prefs ----
  getActiveWorkspace() {
    const id = getAppState(this.db, 'active_workspace');
    if (id && this.getWorkspace(id)) return id;
    const first = this.db.prepare('SELECT id FROM workspaces ORDER BY position, created_at LIMIT 1').get();
    if (first) { setAppState(this.db, 'active_workspace', first.id); return first.id; }
    return null;
  }
  setActiveWorkspace(id) { setAppState(this.db, 'active_workspace', id); }
  getSidebarCollapsed() { return getAppState(this.db, 'sidebar_collapsed') === '1'; }
  setSidebarCollapsed(v) { setAppState(this.db, 'sidebar_collapsed', v ? '1' : '0'); }

  // ---- workspaces ----
  listWorkspaces() {
    return this.db.prepare('SELECT * FROM workspaces ORDER BY position, created_at').all().map(plain);
  }
  getWorkspace(id) { return plain(this.db.prepare('SELECT * FROM workspaces WHERE id=?').get(id)); }
  createWorkspace({ name, icon = 'box', color = '#edecec' }) {
    const id = newId('ws');
    const pos = (this.db.prepare('SELECT COALESCE(MAX(position),-1)+1 AS p FROM workspaces').get().p) || 0;
    this.db.prepare('INSERT INTO workspaces(id,name,icon,color,position,created_at) VALUES(?,?,?,?,?,?)')
      .run(id, (name || 'Untitled').trim() || 'Untitled', icon, color, pos, Date.now());
    return this.getWorkspace(id);
  }
  updateWorkspace(id, patch) {
    const ws = this.getWorkspace(id);
    if (!ws) return null;
    const name = patch.name != null ? (String(patch.name).trim() || 'Untitled') : ws.name;
    const icon = patch.icon != null ? patch.icon : ws.icon;
    const color = patch.color != null ? patch.color : ws.color;
    this.db.prepare('UPDATE workspaces SET name=?, icon=?, color=? WHERE id=?').run(name, icon, color, id);
    return this.getWorkspace(id);
  }
  // Returns { ok, active } or { ok:false, reason }.
  deleteWorkspace(id) {
    const count = this.db.prepare('SELECT COUNT(*) AS n FROM workspaces').get().n;
    if (count <= 1) return { ok: false, reason: 'last-workspace' };
    if (!this.getWorkspace(id)) return { ok: false, reason: 'not-found' };
    return this.tx(() => {
      this.db.prepare('DELETE FROM workspaces WHERE id=?').run(id);
      let active = this.getActiveWorkspace();
      if (active === id || !this.getWorkspace(active)) {
        const next = this.db.prepare('SELECT id FROM workspaces ORDER BY position, created_at LIMIT 1').get();
        active = next ? next.id : null;
        if (active) this.setActiveWorkspace(active);
      }
      return { ok: true, active };
    });
  }

  // ---- projects ----
  listProjects(workspaceId) {
    return this.db.prepare('SELECT * FROM projects WHERE workspace_id=? ORDER BY name').all(workspaceId).map(plain);
  }
  getProject(id) { return plain(this.db.prepare('SELECT * FROM projects WHERE id=?').get(id)); }
  findProjectByName(workspaceId, name) {
    return plain(this.db.prepare('SELECT * FROM projects WHERE workspace_id=? AND name=?').get(workspaceId, name));
  }
  createProject(workspaceId, name) {
    const trimmed = String(name || '').trim();
    if (!trimmed) return null;
    const existing = this.findProjectByName(workspaceId, trimmed);
    if (existing) return existing;
    const id = newId('proj');
    this.db.prepare('INSERT INTO projects(id,workspace_id,name,created_at) VALUES(?,?,?,?)')
      .run(id, workspaceId, trimmed, Date.now());
    return this.getProject(id);
  }
  // Returns { ok, project } or { ok:false, reason }.
  updateProject(id, name) {
    const proj = this.getProject(id);
    if (!proj) return { ok: false, reason: 'not-found' };
    const trimmed = String(name || '').trim();
    if (!trimmed) return { ok: false, reason: 'empty-name' };
    const dupe = this.findProjectByName(proj.workspace_id, trimmed);
    if (dupe && dupe.id !== id) return { ok: false, reason: 'duplicate-name' };
    this.db.prepare('UPDATE projects SET name=? WHERE id=?').run(trimmed, id);
    return { ok: true, project: this.getProject(id) };
  }
  deleteProject(id) { this.db.prepare('DELETE FROM projects WHERE id=?').run(id); }

  // ---- endpoints ----
  slugExists(slug, exceptId = null) {
    const row = exceptId
      ? this.db.prepare('SELECT id FROM endpoints WHERE slug=? AND id<>?').get(slug, exceptId)
      : this.db.prepare('SELECT id FROM endpoints WHERE slug=?').get(slug);
    return !!row;
  }
  allSlugs() { return this.db.prepare('SELECT slug FROM endpoints').all().map((r) => r.slug); }

  listEndpoints({ workspaceId, type } = {}) {
    let sql = 'SELECT * FROM endpoints';
    const cond = [], args = [];
    if (workspaceId) { cond.push('workspace_id=?'); args.push(workspaceId); }
    if (type) { cond.push('type=?'); args.push(type); }
    if (cond.length) sql += ' WHERE ' + cond.join(' AND ');
    sql += ' ORDER BY created_at DESC';
    return this.db.prepare(sql).all(...args).map((r) => this.hydrateEndpoint(r));
  }
  getEndpoint(id) {
    const row = this.db.prepare('SELECT * FROM endpoints WHERE id=?').get(id);
    return row ? this.hydrateEndpoint(row) : null;
  }
  getEndpointBySlug(slug) {
    const row = this.db.prepare('SELECT * FROM endpoints WHERE slug=?').get(slug);
    return row ? this.hydrateEndpoint(row) : null;
  }
  getRawEndpoint(id) { return plain(this.db.prepare('SELECT * FROM endpoints WHERE id=?').get(id)); }

  hydrateEndpoint(row) {
    const ep = plain(row);
    ep.config = hydrateConfig(row);
    ep.project = ep.project_id ? this.getProject(ep.project_id) : null;
    if (ep.type === 'mock') {
      ep.scenarios = this.listScenarios(ep.id);
      ep.matchRules = this.listMatchRules(ep.id);
    }
    return ep;
  }

  createEndpoint(data) {
    const id = newId('ep');
    const now = Date.now();
    const c = data.config || {};
    this.db.prepare(
      `INSERT INTO endpoints
        (id,workspace_id,project_id,type,name,slug,method,path,mode,forward_target,seq_cursor,
         config_auth,config_hmac,config_rate,config_rules,rule_match,created_at,last_activity,request_count)
       VALUES (?,?,?,?,?,?,?,?,?,?,0,?,?,?,?,?,?,NULL,0)`
    ).run(
      id, data.workspaceId, data.projectId || null, data.type, data.name, data.slug,
      data.method || null, data.path || null, data.mode || 'single', data.forwardTarget || null,
      toColumn(c.auth || defaultAuth()), toColumn(c.hmac || defaultHmac()),
      toColumn(c.rate || defaultRate()), toColumn(c.rules || []), c.ruleMatch || 'all', now,
    );
    return id;
  }

  updateEndpoint(id, patch) {
    const ep = this.getRawEndpoint(id);
    if (!ep) return null;
    const cfg = hydrateConfig(ep);
    const fields = [], args = [];
    const set = (col, val) => { fields.push(`${col}=?`); args.push(val); };
    if (patch.name != null) set('name', patch.name);
    if (patch.slug != null) set('slug', patch.slug);
    if ('projectId' in patch) set('project_id', patch.projectId || null);
    if (patch.method != null) set('method', patch.method);
    if (patch.path != null) set('path', patch.path);
    if (patch.mode != null) set('mode', patch.mode);
    if ('forwardTarget' in patch) set('forward_target', patch.forwardTarget || null);
    if (patch.auth) set('config_auth', toColumn({ ...cfg.auth, ...patch.auth }));
    if (patch.hmac) set('config_hmac', toColumn({ ...cfg.hmac, ...patch.hmac }));
    if (patch.rate) set('config_rate', toColumn({ ...cfg.rate, ...patch.rate }));
    if (patch.rules) set('config_rules', toColumn(patch.rules));
    if (patch.ruleMatch != null) set('rule_match', patch.ruleMatch);
    if (fields.length) {
      this.db.prepare(`UPDATE endpoints SET ${fields.join(', ')} WHERE id=?`).run(...args, id);
    }
    return this.getEndpoint(id);
  }

  deleteEndpoint(id) { this.db.prepare('DELETE FROM endpoints WHERE id=?').run(id); }

  bumpActivity(id, ts) {
    this.db.prepare('UPDATE endpoints SET request_count=request_count+1, last_activity=? WHERE id=?').run(ts, id);
  }
  advanceSeqCursor(id, len) {
    const ep = this.getRawEndpoint(id);
    if (!ep || !len) return 0;
    const idx = ep.seq_cursor % len;
    this.db.prepare('UPDATE endpoints SET seq_cursor=? WHERE id=?').run((ep.seq_cursor + 1) % len, id);
    return idx;
  }

  // ---- scenarios ----
  listScenarios(endpointId) {
    return this.db.prepare('SELECT * FROM scenarios WHERE endpoint_id=? ORDER BY position, rowid').all(endpointId)
      .map((r) => ({
        id: r.id, name: r.name, status: r.status, delay: r.delay_ms, active: !!r.is_active,
        headers: safeParse(r.headers, {}) || {}, body: r.body, contentType: r.content_type, position: r.position,
      }));
  }
  getScenario(id) {
    const r = this.db.prepare('SELECT * FROM scenarios WHERE id=?').get(id);
    if (!r) return null;
    return { id: r.id, endpointId: r.endpoint_id, name: r.name, status: r.status, delay: r.delay_ms, active: !!r.is_active, headers: safeParse(r.headers, {}) || {}, body: r.body, contentType: r.content_type, position: r.position };
  }
  addScenario(endpointId, data) {
    const id = data.id || newId('sc');
    const pos = this.db.prepare('SELECT COALESCE(MAX(position),-1)+1 AS p FROM scenarios WHERE endpoint_id=?').get(endpointId).p;
    const headers = data.headers || { 'Content-Type': data.contentType || 'application/json' };
    this.db.prepare(
      'INSERT INTO scenarios(id,endpoint_id,name,status,delay_ms,is_active,headers,body,content_type,position) VALUES(?,?,?,?,?,?,?,?,?,?)'
    ).run(id, endpointId, data.name || 'Scenario', Number(data.status) || 200, Number(data.delay) || 0,
      data.active ? 1 : 0, toColumn(headers), data.body == null ? '' : String(data.body),
      data.contentType || 'application/json', pos);
    if (data.active) this.activateScenario(endpointId, id);
    return this.getScenario(id);
  }
  updateScenario(id, patch) {
    const sc = this.getScenario(id);
    if (!sc) return null;
    const fields = [], args = [];
    const set = (c, v) => { fields.push(`${c}=?`); args.push(v); };
    if (patch.name != null) set('name', patch.name);
    if (patch.status != null) set('status', Number(patch.status) || 200);
    if (patch.delay != null) set('delay_ms', Number(patch.delay) || 0);
    if (patch.headers != null) set('headers', toColumn(patch.headers));
    if (patch.body != null) set('body', String(patch.body));
    if (patch.contentType != null) set('content_type', patch.contentType);
    if (fields.length) this.db.prepare(`UPDATE scenarios SET ${fields.join(', ')} WHERE id=?`).run(...args, id);
    if (patch.active === true) this.activateScenario(sc.endpointId, id);
    return this.getScenario(id);
  }
  deleteScenario(id) { this.db.prepare('DELETE FROM scenarios WHERE id=?').run(id); }
  activateScenario(endpointId, scId) {
    this.tx(() => {
      this.db.prepare('UPDATE scenarios SET is_active=0 WHERE endpoint_id=?').run(endpointId);
      this.db.prepare('UPDATE scenarios SET is_active=1 WHERE id=? AND endpoint_id=?').run(scId, endpointId);
    });
  }
  activeScenario(endpointId) {
    const list = this.listScenarios(endpointId);
    return list.find((s) => s.active) || list[0] || null;
  }

  // ---- match rules ----
  listMatchRules(endpointId) {
    return this.db.prepare('SELECT * FROM match_rules WHERE endpoint_id=? ORDER BY position, rowid').all(endpointId)
      .map((r) => ({ id: r.id, when: r.when_field, key: r.key, op: r.op, value: r.value, then: r.then_scenario_id, position: r.position, enabled: !!r.enabled }));
  }
  addMatchRule(endpointId, data) {
    const id = data.id || newId('mr');
    const pos = this.db.prepare('SELECT COALESCE(MAX(position),-1)+1 AS p FROM match_rules WHERE endpoint_id=?').get(endpointId).p;
    const enabled = data.enabled === false ? 0 : 1;
    this.db.prepare('INSERT INTO match_rules(id,endpoint_id,when_field,key,value,op,then_scenario_id,position,enabled) VALUES(?,?,?,?,?,?,?,?,?)')
      .run(id, endpointId, data.when || 'header', data.key || '', data.value || '', data.op || 'equals', data.then || null, pos, enabled);
    return this.listMatchRules(endpointId).find((r) => r.id === id);
  }
  updateMatchRule(id, patch) {
    const cur = this.db.prepare('SELECT * FROM match_rules WHERE id=?').get(id);
    if (!cur) return null;
    const map = { when: 'when_field', key: 'key', value: 'value', op: 'op', then: 'then_scenario_id' };
    const fields = [], args = [];
    for (const [k, col] of Object.entries(map)) {
      if (patch[k] != null) { fields.push(`${col}=?`); args.push(patch[k]); }
    }
    if (patch.enabled != null) { fields.push('enabled=?'); args.push(patch.enabled ? 1 : 0); }
    if (fields.length) this.db.prepare(`UPDATE match_rules SET ${fields.join(', ')} WHERE id=?`).run(...args, id);
    return this.listMatchRules(cur.endpoint_id).find((r) => r.id === id);
  }
  // Swap position with the adjacent rule (by current ordering); a no-op at
  // either boundary (already first/last). Priority matters for correctness
  // here — the first matching rule wins — so reordering is a real feature,
  // not cosmetic.
  moveMatchRule(id, direction) {
    const cur = this.db.prepare('SELECT * FROM match_rules WHERE id=?').get(id);
    if (!cur) return null;
    const neighbor = direction === 'up'
      ? this.db.prepare('SELECT * FROM match_rules WHERE endpoint_id=? AND position<? ORDER BY position DESC LIMIT 1').get(cur.endpoint_id, cur.position)
      : this.db.prepare('SELECT * FROM match_rules WHERE endpoint_id=? AND position>? ORDER BY position ASC LIMIT 1').get(cur.endpoint_id, cur.position);
    if (neighbor) {
      this.tx(() => {
        this.db.prepare('UPDATE match_rules SET position=? WHERE id=?').run(neighbor.position, cur.id);
        this.db.prepare('UPDATE match_rules SET position=? WHERE id=?').run(cur.position, neighbor.id);
      });
    }
    return this.listMatchRules(cur.endpoint_id).find((r) => r.id === id);
  }
  deleteMatchRule(id) { this.db.prepare('DELETE FROM match_rules WHERE id=?').run(id); }

  // ---- requests ----
  nextSeq(endpointId) {
    return this.db.prepare('SELECT COALESCE(MAX(seq),0)+1 AS s FROM requests WHERE endpoint_id=?').get(endpointId).s;
  }
  insertRequest(data) {
    const id = data.id || newId('req');
    const seq = data.seq != null ? data.seq : this.nextSeq(data.endpointId);
    const ts = data.receivedAt || Date.now();
    this.db.prepare(
      `INSERT INTO requests
        (id,endpoint_id,seq,method,path,status,ip,size,received_at,event_label,scenario_id,content_type,
         headers,query,body,response_status,response_headers,response_body,signature,outcome,note)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    ).run(
      id, data.endpointId, seq, data.method, data.path, data.status, data.ip || null, data.size || 0, ts,
      data.eventLabel || null, data.scenarioId || null, data.contentType || null,
      toColumn(data.headers || {}), toColumn(data.query || {}), data.body == null ? null : String(data.body),
      data.responseStatus != null ? data.responseStatus : null, toColumn(data.responseHeaders || {}),
      data.responseBody == null ? null : String(data.responseBody),
      data.signature || null, data.outcome || 'captured', data.note || null,
    );
    return this.getRequest(id);
  }
  hydrateRequest(r) {
    if (!r) return null;
    return {
      id: r.id, endpointId: r.endpoint_id, seq: r.seq, method: r.method, path: r.path, status: r.status,
      ip: r.ip, size: r.size, receivedAt: r.received_at, event: r.event_label, scenarioId: r.scenario_id,
      contentType: r.content_type, headers: safeParse(r.headers, {}) || {}, query: safeParse(r.query, {}) || {},
      body: r.body, responseStatus: r.response_status, responseHeaders: safeParse(r.response_headers, {}) || {},
      responseBody: r.response_body, signature: r.signature, outcome: r.outcome, note: r.note,
    };
  }
  getRequest(id) { return this.hydrateRequest(this.db.prepare('SELECT * FROM requests WHERE id=?').get(id)); }
  countRequests(endpointId) { return this.db.prepare('SELECT COUNT(*) AS n FROM requests WHERE endpoint_id=?').get(endpointId).n; }

  listRequests({ endpointId, search, method, after, limit = 500 } = {}) {
    const cond = ['endpoint_id=?'], args = [endpointId];
    if (method && method !== 'ALL') { cond.push('method=?'); args.push(method); }
    if (after != null) { cond.push('seq>?'); args.push(Number(after)); }
    if (search && search.trim()) {
      const like = `%${search.trim()}%`;
      cond.push('(method LIKE ? OR event_label LIKE ? OR path LIKE ? OR body LIKE ? OR headers LIKE ?)');
      args.push(like, like, like, like, like);
    }
    const where = cond.join(' AND ');
    if (after != null) {
      const rows = this.db.prepare(`SELECT * FROM requests WHERE ${where} ORDER BY seq ASC LIMIT ?`).all(...args, limit);
      return rows.map((r) => this.hydrateRequest(r));
    }
    const rows = this.db.prepare(`SELECT * FROM requests WHERE ${where} ORDER BY seq DESC LIMIT ?`).all(...args, limit);
    return rows.reverse().map((r) => this.hydrateRequest(r));
  }
  deleteRequest(id) { this.db.prepare('DELETE FROM requests WHERE id=?').run(id); }
  clearRequests(endpointId) {
    this.db.prepare('DELETE FROM requests WHERE endpoint_id=?').run(endpointId);
    this.db.prepare('UPDATE endpoints SET request_count=0, last_activity=NULL WHERE id=?').run(endpointId);
  }

  // ---- activity / counts ----
  recentActivity(workspaceId, limit = 12) {
    const cond = workspaceId ? 'WHERE e.workspace_id=?' : '';
    const rows = this.db.prepare(
      `SELECT r.*, e.name AS ep_name, e.id AS ep_id, e.type AS ep_type FROM requests r
       JOIN endpoints e ON e.id = r.endpoint_id
       ${cond}
       ORDER BY r.received_at DESC LIMIT ?`
    ).all(...(workspaceId ? [workspaceId, limit] : [limit]));
    return rows.map((r) => ({ ...this.hydrateRequest(r), epName: r.ep_name, epId: r.ep_id, epType: r.ep_type }));
  }
  counts(workspaceId) {
    const wsArgs = workspaceId ? [workspaceId] : [];
    const wsCond = workspaceId ? ' AND workspace_id=?' : '';
    const webhooks = this.db.prepare(`SELECT COUNT(*) AS n FROM endpoints WHERE type='inspector'${wsCond}`).get(...wsArgs).n;
    const mocks = this.db.prepare(`SELECT COUNT(*) AS n FROM endpoints WHERE type='mock'${wsCond}`).get(...wsArgs).n;
    const captured = this.db.prepare(`SELECT COALESCE(SUM(request_count),0) AS n FROM endpoints WHERE type='inspector'${wsCond}`).get(...wsArgs).n;
    const mocked = this.db.prepare(`SELECT COALESCE(SUM(request_count),0) AS n FROM endpoints WHERE type='mock'${wsCond}`).get(...wsArgs).n;
    return { webhooks, mocks, captured, mocked, totalRequests: captured + mocked };
  }

  // Time-bucketed request volume + status-code breakdown + trend vs the
  // previous equivalent period, across both webhooks and mocks. Powers the
  // dashboard's "Traffic overview" card. Bucketing/aggregation happens in JS
  // rather than SQL — request volumes here are local-dev-tool scale, and a
  // plain loop is far simpler to get right than a portable SQL time-bucket
  // query on top of node:sqlite.
  requestsOverview(workspaceId, period = '24h') {
    const specs = {
      '24h': { windowMs: 24 * 3600000, buckets: 24, bucketMs: 3600000 },
      '7d': { windowMs: 7 * 86400000, buckets: 7, bucketMs: 86400000 },
      '30d': { windowMs: 30 * 86400000, buckets: 30, bucketMs: 86400000 },
    };
    const resolvedPeriod = specs[period] ? period : '24h';
    const spec = specs[resolvedPeriod];
    const now = Date.now();
    const curStart = now - spec.windowMs;
    const since = now - 2 * spec.windowMs;
    const cond = workspaceId ? 'AND e.workspace_id=?' : '';
    const rows = this.db.prepare(
      `SELECT r.status, r.received_at FROM requests r
       JOIN endpoints e ON e.id = r.endpoint_id
       WHERE r.received_at>=? ${cond}`
    ).all(...(workspaceId ? [since, workspaceId] : [since]));

    const series = new Array(spec.buckets).fill(0);
    const statusBreakdown = { ok: 0, clientError: 0, serverError: 0, other: 0 };
    let total = 0, previousTotal = 0;
    for (const r of rows) {
      if (r.received_at < curStart) { previousTotal++; continue; }
      total++;
      const idx = Math.min(spec.buckets - 1, Math.floor((r.received_at - curStart) / spec.bucketMs));
      series[idx]++;
      if (r.status >= 200 && r.status < 300) statusBreakdown.ok++;
      else if (r.status >= 400 && r.status < 500) statusBreakdown.clientError++;
      else if (r.status >= 500 && r.status < 600) statusBreakdown.serverError++;
      else statusBreakdown.other++;
    }
    const changePct = previousTotal > 0 ? Math.round(((total - previousTotal) / previousTotal) * 100) : (total > 0 ? 100 : 0);
    return { period: resolvedPeriod, total, previousTotal, changePct, series, statusBreakdown };
  }

  // ---- funnel ----
  getFunnel() { return plain(this.db.prepare('SELECT * FROM funnel_state WHERE id=1').get()); }
  setFunnel(patch) {
    const cur = this.getFunnel() || {};
    const merged = { ...cur, ...patch, updated_at: Date.now() };
    this.db.prepare(
      'UPDATE funnel_state SET active=?, since=?, base_url=?, region=?, machine=?, ingest_port=?, updated_at=?, last_error=? WHERE id=1'
    ).run(
      merged.active ? 1 : 0, merged.since || null, merged.base_url || null, merged.region || null,
      merged.machine || null, merged.ingest_port || null, merged.updated_at, merged.last_error || null,
    );
    return this.getFunnel();
  }
  addFunnelHistory({ label, detail, kind = 'up' }) {
    this.db.prepare('INSERT INTO funnel_history(id,label,detail,kind,at) VALUES(?,?,?,?,?)')
      .run(newId('fh'), label, detail || null, kind, Date.now());
  }
  listFunnelHistory(limit = 12) {
    return this.db.prepare('SELECT * FROM funnel_history ORDER BY at DESC LIMIT ?').all(limit).map(plain);
  }
}

export { presetFor };

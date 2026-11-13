// Data-access layer over the SQLite database. All query logic lives here so the
// API and ingest layers work with plain hydrated objects.
import { newId } from './lib/ids.js';
import { safeParse, toColumn } from './lib/json.js';
import { presetFor } from './lib/hmac.js';
import { defaultScenarioEvent, retryDelayMs } from './lib/eventConfig.js';
import { getAppState, setAppState } from './db.js';
import { defaultRealtimeConfig, normalizeRealtimeConfig } from './lib/realtime.js';

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
    realtime: { ...defaultRealtimeConfig(), ...(safeParse(row.config_realtime, {}) || {}) },
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

  listEndpoints({ workspaceId, type, protocol } = {}) {
    let sql = 'SELECT * FROM endpoints';
    const cond = [], args = [];
    if (workspaceId) { cond.push('workspace_id=?'); args.push(workspaceId); }
    if (type) { cond.push('type=?'); args.push(type); }
    if (protocol) { cond.push('protocol=?'); args.push(protocol); }
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
    ep.protocol = ep.protocol || 'http';
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
        (id,workspace_id,project_id,type,protocol,name,slug,method,path,path_mode,allowed_methods,mode,forward_target,seq_cursor,
         config_auth,config_hmac,config_rate,config_realtime,config_rules,rule_match,created_at,last_activity,request_count)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,0,?,?,?,?,?,?,?,NULL,0)`
    ).run(
      id, data.workspaceId, data.projectId || null, data.type, data.protocol || 'http', data.name, data.slug,
      data.method || null, data.path || null, data.pathMode || data.path_mode || 'exact',
      data.allowedMethods != null ? toColumn(data.allowedMethods) : (data.allowed_methods || null),
      data.mode || 'single', data.forwardTarget || null,
      toColumn(c.auth || defaultAuth()), toColumn(c.hmac || defaultHmac()),
      toColumn(c.rate || defaultRate()), toColumn(normalizeRealtimeConfig(c.realtime || defaultRealtimeConfig())),
      toColumn(c.rules || []), c.ruleMatch || 'all', now,
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
    if (patch.protocol != null) set('protocol', patch.protocol);
    if ('projectId' in patch) set('project_id', patch.projectId || null);
    if (patch.method != null) set('method', patch.method);
    if (patch.path != null) set('path', patch.path);
    if (patch.pathMode != null || patch.path_mode != null) set('path_mode', patch.pathMode || patch.path_mode || 'exact');
    if ('allowedMethods' in patch || 'allowed_methods' in patch) {
      const am = patch.allowedMethods != null ? patch.allowedMethods : patch.allowed_methods;
      set('allowed_methods', am == null ? null : toColumn(am));
    }
    if (patch.mode != null) set('mode', patch.mode);
    if ('forwardTarget' in patch) set('forward_target', patch.forwardTarget || null);
    if (patch.auth) set('config_auth', toColumn({ ...cfg.auth, ...patch.auth }));
    if (patch.hmac) set('config_hmac', toColumn({ ...cfg.hmac, ...patch.hmac }));
    if (patch.rate) set('config_rate', toColumn({ ...cfg.rate, ...patch.rate }));
    if (patch.realtime) set('config_realtime', toColumn(normalizeRealtimeConfig(patch.realtime, cfg.realtime)));
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
        events: this.listScenarioEvents(r.id),
      }));
  }
  getScenario(id) {
    const r = this.db.prepare('SELECT * FROM scenarios WHERE id=?').get(id);
    if (!r) return null;
    return { id: r.id, endpointId: r.endpoint_id, name: r.name, status: r.status, delay: r.delay_ms, active: !!r.is_active, headers: safeParse(r.headers, {}) || {}, body: r.body, contentType: r.content_type, position: r.position, events: this.listScenarioEvents(r.id) };
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
  deleteScenario(id) {
    return this.tx(() => {
      this._cancelRunsForScenario(id, Date.now());
      this.db.prepare('DELETE FROM scenarios WHERE id=?').run(id);
    });
  }
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

  // ---- scenario async events ----
  hydrateScenarioEvent(row) {
    if (!row) return null;
    const base = defaultScenarioEvent();
    const request = safeParse(row.request_config, {}) || {};
    const schedule = safeParse(row.schedule_config, {}) || {};
    return {
      id: row.id, scenarioId: row.scenario_id, name: row.name, enabled: !!row.enabled, position: row.position,
      request: {
        ...base.request, ...request,
        auth: { ...base.request.auth, ...(request.auth || {}) },
        hmac: { ...base.request.hmac, ...(request.hmac || {}) },
      },
      schedule: { ...base.schedule, ...schedule },
      createdAt: row.created_at, updatedAt: row.updated_at,
    };
  }
  listScenarioEvents(scenarioId) {
    return this.db.prepare('SELECT * FROM scenario_events WHERE scenario_id=? ORDER BY position, rowid').all(scenarioId)
      .map((row) => this.hydrateScenarioEvent(row));
  }
  getScenarioEvent(id) {
    return this.hydrateScenarioEvent(this.db.prepare('SELECT * FROM scenario_events WHERE id=?').get(id));
  }
  addScenarioEvent(scenarioId, data) {
    const base = defaultScenarioEvent();
    const request = {
      ...base.request, ...(data.request || {}),
      auth: { ...base.request.auth, ...((data.request && data.request.auth) || {}) },
      hmac: { ...base.request.hmac, ...((data.request && data.request.hmac) || {}) },
    };
    const schedule = { ...base.schedule, ...(data.schedule || {}) };
    const id = data.id || newId('sev');
    const position = this.db.prepare('SELECT COALESCE(MAX(position),-1)+1 AS p FROM scenario_events WHERE scenario_id=?').get(scenarioId).p;
    const now = Date.now();
    this.db.prepare(
      'INSERT INTO scenario_events(id,scenario_id,name,enabled,position,request_config,schedule_config,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)'
    ).run(id, scenarioId, data.name || base.name, data.enabled === false ? 0 : 1, position, toColumn(request), toColumn(schedule), now, now);
    return this.getScenarioEvent(id);
  }
  updateScenarioEvent(id, patch) {
    const current = this.getScenarioEvent(id);
    if (!current) return null;
    const request = patch.request == null ? current.request : {
      ...current.request, ...patch.request,
      auth: { ...current.request.auth, ...((patch.request && patch.request.auth) || {}) },
      hmac: { ...current.request.hmac, ...((patch.request && patch.request.hmac) || {}) },
    };
    const schedule = patch.schedule == null ? current.schedule : { ...current.schedule, ...patch.schedule };
    return this.tx(() => {
      this.db.prepare(
        'UPDATE scenario_events SET name=?, enabled=?, request_config=?, schedule_config=?, updated_at=? WHERE id=?'
      ).run(
        patch.name == null ? current.name : patch.name,
        patch.enabled == null ? (current.enabled ? 1 : 0) : (patch.enabled ? 1 : 0),
        toColumn(request), toColumn(schedule), Date.now(), id,
      );
      if (patch.enabled === false) this._cancelPendingEventJobs(id, Date.now());
      return this.getScenarioEvent(id);
    });
  }
  moveScenarioEvent(id, direction) {
    const current = this.db.prepare('SELECT * FROM scenario_events WHERE id=?').get(id);
    if (!current) return null;
    const neighbor = direction === 'up'
      ? this.db.prepare('SELECT * FROM scenario_events WHERE scenario_id=? AND position<? ORDER BY position DESC LIMIT 1').get(current.scenario_id, current.position)
      : this.db.prepare('SELECT * FROM scenario_events WHERE scenario_id=? AND position>? ORDER BY position ASC LIMIT 1').get(current.scenario_id, current.position);
    if (neighbor) {
      this.tx(() => {
        this.db.prepare('UPDATE scenario_events SET position=?, updated_at=? WHERE id=?').run(neighbor.position, Date.now(), current.id);
        this.db.prepare('UPDATE scenario_events SET position=?, updated_at=? WHERE id=?').run(current.position, Date.now(), neighbor.id);
      });
    }
    return this.getScenarioEvent(id);
  }
  deleteScenarioEvent(id) {
    return this.tx(() => {
      this._cancelPendingEventJobs(id, Date.now());
      this.db.prepare('DELETE FROM scenario_events WHERE id=?').run(id);
    });
  }

  // ---- durable async event runs ----
  createEventRun({ endpointId, scenarioId, requestId = null, source = 'ingest', context, events, now = Date.now() }) {
    const snapshot = (events || []).filter((event) => event && event.enabled).sort((a, b) => a.position - b.position);
    if (!snapshot.length) return null;
    const runId = newId('er');
    const jobs = [];
    let sequenceIndex = 0;
    for (const event of snapshot) {
      const repeatCount = Math.max(1, Number(event.schedule && event.schedule.repeatCount) || 1);
      for (let repeatIndex = 0; repeatIndex < repeatCount; repeatIndex++) {
        const delayBeforeMs = sequenceIndex === 0
          ? (source === 'test' ? 0 : Math.max(0, Number(event.schedule && event.schedule.delayMs) || 0))
          : (repeatIndex > 0
            ? Math.max(0, Number(event.schedule && event.schedule.repeatIntervalMs) || 0)
            : Math.max(0, Number(event.schedule && event.schedule.delayMs) || 0));
        jobs.push({
          id: newId('ej'), eventId: event.id, eventName: event.name, position: event.position,
          sequenceIndex, repeatIndex, delayBeforeMs,
        });
        sequenceIndex++;
      }
    }
    return this.tx(() => {
      this.db.prepare(
        'INSERT INTO event_runs(id,endpoint_id,scenario_id,request_id,source,status,context,events_snapshot,created_at) VALUES(?,?,?,?,?,?,?,?,?)'
      ).run(runId, endpointId, scenarioId || null, requestId || null, source === 'test' ? 'test' : 'ingest', 'scheduled', toColumn(context || {}), toColumn(snapshot), now);
      const insertJob = this.db.prepare(
        'INSERT INTO event_jobs(id,run_id,event_id,event_name,position,sequence_index,repeat_index,delay_before_ms,status,scheduled_at) VALUES(?,?,?,?,?,?,?,?,?,?)'
      );
      for (const job of jobs) {
        insertJob.run(
          job.id, runId, job.eventId, job.eventName, job.position, job.sequenceIndex, job.repeatIndex, job.delayBeforeMs,
          job.sequenceIndex === 0 ? 'scheduled' : 'blocked', job.sequenceIndex === 0 ? now + job.delayBeforeMs : null,
        );
      }
      return this.getEventRun(runId);
    });
  }
  hydrateEventAttempt(row) {
    if (!row) return null;
    return {
      id: row.id, attemptNo: row.attempt_no, status: row.status, requestUrl: row.request_url,
      requestMethod: row.request_method, responseStatus: row.response_status,
      responseHeaders: safeParse(row.response_headers, {}) || {}, responseBody: row.response_body,
      error: row.error, durationMs: row.duration_ms, startedAt: row.started_at, finishedAt: row.finished_at,
    };
  }
  hydrateEventJob(row, { details = false } = {}) {
    if (!row) return null;
    const job = {
      id: row.id, eventId: row.event_id, eventName: row.event_name, position: row.position,
      sequenceIndex: row.sequence_index, repeatIndex: row.repeat_index, delayBeforeMs: row.delay_before_ms,
      status: row.status, scheduledAt: row.scheduled_at, startedAt: row.started_at, finishedAt: row.finished_at,
      attemptCount: row.attempt_count, responseStatus: row.response_status, lastError: row.last_error,
    };
    if (details) {
      job.attempts = this.db.prepare('SELECT * FROM event_attempts WHERE job_id=? ORDER BY attempt_no').all(row.id)
        .map((attempt) => this.hydrateEventAttempt(attempt));
    }
    return job;
  }
  hydrateEventRun(row, { details = false, internal = false } = {}) {
    if (!row) return null;
    const jobs = this.db.prepare('SELECT * FROM event_jobs WHERE run_id=? ORDER BY sequence_index').all(row.id);
    const run = {
      id: row.id, endpointId: row.endpoint_id, scenarioId: row.scenario_id, requestId: row.request_id,
      source: row.source, status: row.status, createdAt: row.created_at, startedAt: row.started_at, finishedAt: row.finished_at,
      jobs: jobs.map((job) => this.hydrateEventJob(job, { details })),
    };
    run.totalJobs = jobs.length;
    run.succeededJobs = jobs.filter((job) => job.status === 'succeeded').length;
    run.failedJobs = jobs.filter((job) => job.status === 'failed').length;
    run.cancelledJobs = jobs.filter((job) => job.status === 'cancelled').length;
    run.pendingJobs = jobs.filter((job) => ['blocked', 'scheduled', 'running'].includes(job.status)).length;
    if (internal) {
      run.context = safeParse(row.context, {}) || {};
      run.eventsSnapshot = safeParse(row.events_snapshot, []) || [];
    }
    return run;
  }
  getEventRun(id, options) {
    return this.hydrateEventRun(this.db.prepare('SELECT * FROM event_runs WHERE id=?').get(id), options);
  }
  listEventRuns({ endpointId, status, source, limit = 100 } = {}) {
    const conditions = [], values = [];
    if (endpointId) { conditions.push('endpoint_id=?'); values.push(endpointId); }
    if (status) { conditions.push('status=?'); values.push(status); }
    if (source) { conditions.push('source=?'); values.push(source); }
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const safeLimit = Math.min(Math.max(1, Number(limit) || 100), 500);
    return this.db.prepare(`SELECT * FROM event_runs ${where} ORDER BY created_at DESC LIMIT ?`).all(...values, safeLimit)
      .map((row) => this.hydrateEventRun(row));
  }
  nextEventJobAt() {
    const row = this.db.prepare(
      `SELECT MIN(j.scheduled_at) AS at FROM event_jobs j
       JOIN event_runs r ON r.id=j.run_id
       WHERE j.status='scheduled' AND r.status IN ('scheduled','running')`
    ).get();
    return row && row.at != null ? Number(row.at) : null;
  }
  recoverEventJobs(now = Date.now()) {
    return this.tx(() => {
      const recovered = this.db.prepare(
        `SELECT COUNT(*) AS n FROM event_jobs j JOIN event_runs r ON r.id=j.run_id
         WHERE j.status='running' AND r.status IN ('scheduled','running')`
      ).get().n;
      // A run cancelled while an attempt was in-flight must stay cancelled
      // across a restart; only active runs cross the at-least-once boundary.
      this.db.prepare(
        `UPDATE event_jobs SET status='cancelled', finished_at=?
         WHERE status='running' AND run_id IN (
           SELECT id FROM event_runs WHERE status IN ('cancelled','completed','completed_with_failures')
         )`
      ).run(now);
      this.db.prepare(
        `UPDATE event_jobs SET status='scheduled', scheduled_at=?
         WHERE status='running' AND run_id IN (
           SELECT id FROM event_runs WHERE status IN ('scheduled','running')
         )`
      ).run(now);
      this.db.prepare("UPDATE event_runs SET status='scheduled', started_at=NULL WHERE status='running'").run();
      return recovered;
    });
  }
  claimDueEventJob(now = Date.now()) {
    return this.tx(() => {
      const job = this.db.prepare(
        `SELECT j.* FROM event_jobs j JOIN event_runs r ON r.id=j.run_id
         WHERE j.status='scheduled' AND j.scheduled_at<=? AND r.status IN ('scheduled','running')
         ORDER BY j.scheduled_at, j.sequence_index LIMIT 1`
      ).get(now);
      if (!job) return null;
      this.db.prepare("UPDATE event_jobs SET status='running', started_at=COALESCE(started_at,?) WHERE id=? AND status='scheduled'").run(now, job.id);
      this.db.prepare("UPDATE event_runs SET status='running', started_at=COALESCE(started_at,?) WHERE id=? AND status='scheduled'").run(now, job.run_id);
      return this.getEventJobExecution(job.id);
    });
  }
  getEventJobExecution(jobId) {
    const row = this.db.prepare(
      `SELECT j.*, r.endpoint_id, r.scenario_id, r.source, r.status AS run_status, r.context, r.events_snapshot
       FROM event_jobs j JOIN event_runs r ON r.id=j.run_id WHERE j.id=?`
    ).get(jobId);
    if (!row) return null;
    const snapshot = safeParse(row.events_snapshot, []) || [];
    const event = snapshot.find((item) => item.id === row.event_id);
    if (!event) return null;
    return {
      job: this.hydrateEventJob(row),
      run: { id: row.run_id, endpointId: row.endpoint_id, scenarioId: row.scenario_id, source: row.source, status: row.run_status, context: safeParse(row.context, {}) || {} },
      event,
    };
  }
  _eventForJob(job, run) {
    const snapshot = safeParse(run.events_snapshot, []) || [];
    return snapshot.find((event) => event.id === job.event_id) || null;
  }
  _activateNextBlockedJob(runId, afterSequence, now) {
    const active = this.db.prepare("SELECT id FROM event_jobs WHERE run_id=? AND status IN ('scheduled','running') LIMIT 1").get(runId);
    if (active) return false;
    const next = this.db.prepare(
      "SELECT * FROM event_jobs WHERE run_id=? AND sequence_index>? AND status='blocked' ORDER BY sequence_index LIMIT 1"
    ).get(runId, afterSequence);
    if (!next) return false;
    this.db.prepare("UPDATE event_jobs SET status='scheduled', scheduled_at=? WHERE id=?").run(now + next.delay_before_ms, next.id);
    return true;
  }
  _activateFirstBlockedJob(runId, now) {
    const active = this.db.prepare("SELECT id FROM event_jobs WHERE run_id=? AND status IN ('scheduled','running') LIMIT 1").get(runId);
    if (active) return false;
    const next = this.db.prepare("SELECT * FROM event_jobs WHERE run_id=? AND status='blocked' ORDER BY sequence_index LIMIT 1").get(runId);
    if (!next) return false;
    this.db.prepare("UPDATE event_jobs SET status='scheduled', scheduled_at=? WHERE id=?").run(now + next.delay_before_ms, next.id);
    return true;
  }
  _refreshEventRunStatus(runId, now) {
    const run = this.db.prepare('SELECT * FROM event_runs WHERE id=?').get(runId);
    if (!run) return null;
    const pending = this.db.prepare("SELECT COUNT(*) AS n FROM event_jobs WHERE run_id=? AND status IN ('blocked','scheduled','running')").get(runId).n;
    if (pending) return run.status;
    if (run.status === 'cancelled') return run.status;
    const issues = this.db.prepare("SELECT COUNT(*) AS n FROM event_jobs WHERE run_id=? AND status IN ('failed','cancelled')").get(runId).n;
    const status = issues ? 'completed_with_failures' : 'completed';
    this.db.prepare('UPDATE event_runs SET status=?, finished_at=? WHERE id=?').run(status, now, runId);
    return status;
  }
  recordEventAttempt(jobId, outcome, now = Date.now()) {
    return this.tx(() => {
      const job = this.db.prepare('SELECT * FROM event_jobs WHERE id=?').get(jobId);
      if (!job) return null;
      const run = this.db.prepare('SELECT * FROM event_runs WHERE id=?').get(job.run_id);
      if (!run) return null;
      const event = this._eventForJob(job, run);
      const attemptNo = job.attempt_count + 1;
      const finalAt = Number(outcome.finishedAt) || now;
      const startedAt = Number(outcome.startedAt) || Math.max(0, finalAt - (Number(outcome.durationMs) || 0));
      const attemptStatus = run.status === 'cancelled' ? 'cancelled' : (outcome.ok ? 'succeeded' : (outcome.kind === 'configuration' ? 'configuration' : 'failed'));
      this.db.prepare(
        'INSERT INTO event_attempts(id,job_id,attempt_no,status,request_url,request_method,response_status,response_headers,response_body,error,duration_ms,started_at,finished_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)'
      ).run(
        newId('ea'), jobId, attemptNo, attemptStatus, outcome.requestUrl || null, outcome.requestMethod || null,
        outcome.status == null ? null : outcome.status, toColumn(outcome.responseHeaders || {}), outcome.responseBody == null ? null : String(outcome.responseBody),
        outcome.error || null, Math.max(0, Number(outcome.durationMs) || 0), startedAt, finalAt,
      );

      if (run.status === 'cancelled') {
        this.db.prepare("UPDATE event_jobs SET status='cancelled', attempt_count=?, finished_at=?, last_error=? WHERE id=?").run(attemptNo, finalAt, outcome.error || null, jobId);
        return this.getEventRun(run.id, { details: true });
      }
      if (outcome.ok) {
        this.db.prepare("UPDATE event_jobs SET status='succeeded', attempt_count=?, response_status=?, last_error=NULL, finished_at=? WHERE id=?")
          .run(attemptNo, outcome.status == null ? null : outcome.status, finalAt, jobId);
        this._activateNextBlockedJob(run.id, job.sequence_index, finalAt);
      } else {
        const retryCount = Math.max(0, Number(event && event.schedule && event.schedule.retryCount) || 0);
        if (outcome.retryable && attemptNo <= retryCount) {
          const baseDelay = event && event.schedule && event.schedule.retryBaseDelayMs;
          const retryAt = finalAt + retryDelayMs(baseDelay, attemptNo);
          this.db.prepare("UPDATE event_jobs SET status='scheduled', attempt_count=?, response_status=?, last_error=?, scheduled_at=? WHERE id=?")
            .run(attemptNo, outcome.status == null ? null : outcome.status, outcome.error || `HTTP ${outcome.status || 'failure'}`, retryAt, jobId);
        } else {
          this.db.prepare("UPDATE event_jobs SET status='failed', attempt_count=?, response_status=?, last_error=?, finished_at=? WHERE id=?")
            .run(attemptNo, outcome.status == null ? null : outcome.status, outcome.error || `HTTP ${outcome.status || 'failure'}`, finalAt, jobId);
          this._activateNextBlockedJob(run.id, job.sequence_index, finalAt);
        }
      }
      this._refreshEventRunStatus(run.id, finalAt);
      return this.getEventRun(run.id, { details: true });
    });
  }
  _cancelPendingEventJobs(eventId, now) {
    const affected = this.db.prepare("SELECT DISTINCT run_id FROM event_jobs WHERE event_id=? AND status IN ('blocked','scheduled')").all(eventId);
    this.db.prepare("UPDATE event_jobs SET status='cancelled', finished_at=? WHERE event_id=? AND status IN ('blocked','scheduled')").run(now, eventId);
    for (const { run_id: runId } of affected) {
      this._activateFirstBlockedJob(runId, now);
      this._refreshEventRunStatus(runId, now);
    }
  }
  cancelPendingEventJobs(eventId, now = Date.now()) {
    return this.tx(() => this._cancelPendingEventJobs(eventId, now));
  }
  _cancelRunsForScenario(scenarioId, now) {
    const runs = this.db.prepare("SELECT id FROM event_runs WHERE scenario_id=? AND status IN ('scheduled','running')").all(scenarioId);
    for (const { id } of runs) {
      this.db.prepare("UPDATE event_runs SET status='cancelled', finished_at=? WHERE id=?").run(now, id);
      this.db.prepare("UPDATE event_jobs SET status='cancelled', finished_at=? WHERE run_id=? AND status IN ('blocked','scheduled')").run(now, id);
    }
  }
  cancelEventRun(runId, now = Date.now()) {
    return this.tx(() => {
      const run = this.db.prepare('SELECT * FROM event_runs WHERE id=?').get(runId);
      if (!run) return null;
      if (['completed', 'completed_with_failures', 'cancelled'].includes(run.status)) return this.getEventRun(runId, { details: true });
      this.db.prepare("UPDATE event_runs SET status='cancelled', finished_at=? WHERE id=?").run(now, runId);
      this.db.prepare("UPDATE event_jobs SET status='cancelled', finished_at=? WHERE run_id=? AND status IN ('blocked','scheduled')").run(now, runId);
      return this.getEventRun(runId, { details: true });
    });
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

  // ---- realtime sessions and transcript history ----
  hydrateRealtimeMessage(row) {
    if (!row) return null;
    return {
      id: row.id, sessionId: row.session_id, seq: row.seq, direction: row.direction,
      kind: row.kind, eventName: row.event_name, operationName: row.operation_name,
      payload: row.payload, payloadSize: row.payload_size, truncated: !!row.truncated, at: row.at,
    };
  }
  hydrateRealtimeSession(row, { details = false } = {}) {
    if (!row) return null;
    const session = {
      id: row.id, endpointId: row.endpoint_id, protocol: row.protocol, transport: row.transport,
      source: row.source, state: row.state, remoteIp: row.remote_ip,
      headers: safeParse(row.headers, {}) || {}, connectedAt: row.connected_at, closedAt: row.closed_at,
      closeCode: row.close_code, closeReason: row.close_reason,
      messageCount: row.message_count, droppedMessageCount: row.dropped_message_count,
    };
    if (details) {
      session.messages = this.db.prepare('SELECT * FROM realtime_messages WHERE session_id=? ORDER BY seq').all(row.id)
        .map((message) => this.hydrateRealtimeMessage(message));
    }
    return session;
  }
  createRealtimeSession({ endpointId, protocol, transport, source = 'ingest', remoteIp = '', headers = {}, now = Date.now() }) {
    const id = newId('rts');
    this.db.prepare(
      'INSERT INTO realtime_sessions(id,endpoint_id,protocol,transport,source,state,remote_ip,headers,connected_at) VALUES(?,?,?,?,?,?,?,?,?)'
    ).run(id, endpointId, protocol, transport, source === 'test' ? 'test' : 'ingest', 'connected', remoteIp || null, toColumn(headers || {}), now);
    return this.getRealtimeSession(id);
  }
  getRealtimeSession(id, options) {
    return this.hydrateRealtimeSession(this.db.prepare('SELECT * FROM realtime_sessions WHERE id=?').get(id), options);
  }
  listRealtimeSessions({ endpointId, state, limit = 100 } = {}) {
    const conditions = [], values = [];
    if (endpointId) { conditions.push('endpoint_id=?'); values.push(endpointId); }
    if (state) { conditions.push('state=?'); values.push(state); }
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const safeLimit = Math.min(Math.max(1, Number(limit) || 100), 500);
    return this.db.prepare(`SELECT * FROM realtime_sessions ${where} ORDER BY connected_at DESC LIMIT ?`).all(...values, safeLimit)
      .map((row) => this.hydrateRealtimeSession(row));
  }
  countOpenRealtimeSessions(endpointId) {
    return this.db.prepare("SELECT COUNT(*) AS n FROM realtime_sessions WHERE endpoint_id=? AND state='connected'").get(endpointId).n;
  }
  appendRealtimeMessage(sessionId, data, maxMessages = 1000) {
    return this.tx(() => {
      const session = this.db.prepare('SELECT * FROM realtime_sessions WHERE id=?').get(sessionId);
      if (!session) return null;
      const seq = Number(session.message_count || 0) + 1;
      const now = data.at || Date.now();
      this.db.prepare(
        'INSERT INTO realtime_messages(id,session_id,seq,direction,kind,event_name,operation_name,payload,payload_size,truncated,at) VALUES(?,?,?,?,?,?,?,?,?,?,?)'
      ).run(
        newId('rtm'), sessionId, seq, data.direction || 'system', data.kind || 'message', data.eventName || null,
        data.operationName || null, data.payload == null ? null : String(data.payload), Math.max(0, Number(data.payloadSize) || 0),
        data.truncated ? 1 : 0, now,
      );
      const cap = Math.max(1, Number(maxMessages) || 1);
      const count = this.db.prepare('SELECT COUNT(*) AS n FROM realtime_messages WHERE session_id=?').get(sessionId).n;
      const excess = Math.max(0, count - cap);
      if (excess) {
        const oldest = this.db.prepare('SELECT id FROM realtime_messages WHERE session_id=? ORDER BY seq LIMIT ?').all(sessionId, excess);
        const remove = this.db.prepare('DELETE FROM realtime_messages WHERE id=?');
        for (const message of oldest) remove.run(message.id);
      }
      this.db.prepare('UPDATE realtime_sessions SET message_count=?, dropped_message_count=dropped_message_count+? WHERE id=?')
        .run(seq, excess, sessionId);
      return this.hydrateRealtimeMessage(this.db.prepare('SELECT * FROM realtime_messages WHERE session_id=? AND seq=?').get(sessionId, seq));
    });
  }
  closeRealtimeSession(id, { code = null, reason = '', state = 'closed', now = Date.now() } = {}) {
    const current = this.getRealtimeSession(id);
    if (!current) return null;
    if (current.state !== 'connected') return current;
    this.db.prepare('UPDATE realtime_sessions SET state=?, closed_at=?, close_code=?, close_reason=? WHERE id=?')
      .run(state === 'rejected' ? 'rejected' : 'closed', now, code == null ? null : Number(code), reason || null, id);
    return this.getRealtimeSession(id);
  }
  closeOpenRealtimeSessions(now = Date.now()) {
    const result = this.db.prepare("UPDATE realtime_sessions SET state='closed', closed_at=?, close_reason='server_shutdown' WHERE state='connected'").run(now);
    return result.changes || 0;
  }
  clearRealtimeSessions(endpointId) {
    this.db.prepare('DELETE FROM realtime_sessions WHERE endpoint_id=?').run(endpointId);
  }

  // ---- stateful realtime mock scripts ----
  hydrateRealtimeStep(row) {
    if (!row) return null;
    return {
      id: row.id, scriptId: row.script_id, position: row.position,
      match: safeParse(row.match_config, {}) || {}, actions: safeParse(row.actions, []) || [],
      createdAt: row.created_at, updatedAt: row.updated_at,
    };
  }
  hydrateRealtimeScript(row, { details = true } = {}) {
    if (!row) return null;
    const script = {
      id: row.id, endpointId: row.endpoint_id, name: row.name, enabled: !!row.enabled, position: row.position,
      connectActions: safeParse(row.connect_actions, []) || [], createdAt: row.created_at, updatedAt: row.updated_at,
    };
    if (details) {
      script.steps = this.db.prepare('SELECT * FROM realtime_script_steps WHERE script_id=? ORDER BY position, rowid').all(row.id)
        .map((step) => this.hydrateRealtimeStep(step));
    }
    return script;
  }
  listRealtimeScripts(endpointId) {
    return this.db.prepare('SELECT * FROM realtime_scripts WHERE endpoint_id=? ORDER BY position, rowid').all(endpointId)
      .map((row) => this.hydrateRealtimeScript(row));
  }
  getRealtimeScript(id) { return this.hydrateRealtimeScript(this.db.prepare('SELECT * FROM realtime_scripts WHERE id=?').get(id)); }
  addRealtimeScript(endpointId, data) {
    const id = data.id || newId('rtsc');
    const now = Date.now();
    const position = this.db.prepare('SELECT COALESCE(MAX(position),-1)+1 AS p FROM realtime_scripts WHERE endpoint_id=?').get(endpointId).p;
    this.db.prepare('INSERT INTO realtime_scripts(id,endpoint_id,name,enabled,position,connect_actions,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)')
      .run(id, endpointId, data.name || 'Conversation', data.enabled === false ? 0 : 1, position, toColumn(data.connectActions || []), now, now);
    return this.getRealtimeScript(id);
  }
  updateRealtimeScript(id, patch) {
    const current = this.getRealtimeScript(id);
    if (!current) return null;
    this.db.prepare('UPDATE realtime_scripts SET name=?, enabled=?, connect_actions=?, updated_at=? WHERE id=?')
      .run(patch.name == null ? current.name : patch.name, patch.enabled == null ? (current.enabled ? 1 : 0) : (patch.enabled ? 1 : 0),
        toColumn(patch.connectActions == null ? current.connectActions : patch.connectActions), Date.now(), id);
    return this.getRealtimeScript(id);
  }
  deleteRealtimeScript(id) { this.db.prepare('DELETE FROM realtime_scripts WHERE id=?').run(id); }
  moveRealtimeScript(id, direction) {
    const current = this.db.prepare('SELECT * FROM realtime_scripts WHERE id=?').get(id);
    if (!current) return null;
    const neighbor = direction === 'up'
      ? this.db.prepare('SELECT * FROM realtime_scripts WHERE endpoint_id=? AND position<? ORDER BY position DESC LIMIT 1').get(current.endpoint_id, current.position)
      : this.db.prepare('SELECT * FROM realtime_scripts WHERE endpoint_id=? AND position>? ORDER BY position ASC LIMIT 1').get(current.endpoint_id, current.position);
    if (neighbor) this.tx(() => {
      this.db.prepare('UPDATE realtime_scripts SET position=?, updated_at=? WHERE id=?').run(neighbor.position, Date.now(), current.id);
      this.db.prepare('UPDATE realtime_scripts SET position=?, updated_at=? WHERE id=?').run(current.position, Date.now(), neighbor.id);
    });
    return this.getRealtimeScript(id);
  }
  getRealtimeStep(id) { return this.hydrateRealtimeStep(this.db.prepare('SELECT * FROM realtime_script_steps WHERE id=?').get(id)); }
  addRealtimeStep(scriptId, data) {
    const id = data.id || newId('rtst');
    const now = Date.now();
    const position = this.db.prepare('SELECT COALESCE(MAX(position),-1)+1 AS p FROM realtime_script_steps WHERE script_id=?').get(scriptId).p;
    this.db.prepare('INSERT INTO realtime_script_steps(id,script_id,position,match_config,actions,created_at,updated_at) VALUES(?,?,?,?,?,?,?)')
      .run(id, scriptId, position, toColumn(data.match || {}), toColumn(data.actions || []), now, now);
    return this.getRealtimeStep(id);
  }
  updateRealtimeStep(id, patch) {
    const current = this.getRealtimeStep(id);
    if (!current) return null;
    this.db.prepare('UPDATE realtime_script_steps SET match_config=?, actions=?, updated_at=? WHERE id=?')
      .run(toColumn(patch.match == null ? current.match : patch.match), toColumn(patch.actions == null ? current.actions : patch.actions), Date.now(), id);
    return this.getRealtimeStep(id);
  }
  deleteRealtimeStep(id) { this.db.prepare('DELETE FROM realtime_script_steps WHERE id=?').run(id); }
  moveRealtimeStep(id, direction) {
    const current = this.db.prepare('SELECT * FROM realtime_script_steps WHERE id=?').get(id);
    if (!current) return null;
    const neighbor = direction === 'up'
      ? this.db.prepare('SELECT * FROM realtime_script_steps WHERE script_id=? AND position<? ORDER BY position DESC LIMIT 1').get(current.script_id, current.position)
      : this.db.prepare('SELECT * FROM realtime_script_steps WHERE script_id=? AND position>? ORDER BY position ASC LIMIT 1').get(current.script_id, current.position);
    if (neighbor) this.tx(() => {
      this.db.prepare('UPDATE realtime_script_steps SET position=?, updated_at=? WHERE id=?').run(neighbor.position, Date.now(), current.id);
      this.db.prepare('UPDATE realtime_script_steps SET position=?, updated_at=? WHERE id=?').run(current.position, Date.now(), neighbor.id);
    });
    return this.getRealtimeStep(id);
  }

  // ---- GraphQL schema and deterministic fixtures ----
  getGraphqlSchema(endpointId) {
    const row = this.db.prepare('SELECT * FROM graphql_schemas WHERE endpoint_id=?').get(endpointId);
    return row ? { endpointId: row.endpoint_id, sdl: row.sdl, updatedAt: row.updated_at } : { endpointId, sdl: '', updatedAt: null };
  }
  setGraphqlSchema(endpointId, sdl) {
    const now = Date.now();
    this.db.prepare(
      'INSERT INTO graphql_schemas(endpoint_id,sdl,updated_at) VALUES(?,?,?) ON CONFLICT(endpoint_id) DO UPDATE SET sdl=excluded.sdl, updated_at=excluded.updated_at'
    ).run(endpointId, String(sdl || ''), now);
    return this.getGraphqlSchema(endpointId);
  }
  hydrateGraphqlFixture(row) {
    if (!row) return null;
    return {
      id: row.id, endpointId: row.endpoint_id, name: row.name, operationName: row.operation_name || '', documentHash: row.document_hash || '',
      operationType: row.operation_type, variablesMatch: safeParse(row.variables_match, null), response: safeParse(row.response, {}) || {},
      subscriptionEvents: safeParse(row.subscription_events, []) || [], delayMs: row.delay_ms, enabled: !!row.enabled,
      position: row.position, createdAt: row.created_at, updatedAt: row.updated_at,
    };
  }
  listGraphqlFixtures(endpointId) {
    return this.db.prepare('SELECT * FROM graphql_fixtures WHERE endpoint_id=? ORDER BY position, rowid').all(endpointId)
      .map((row) => this.hydrateGraphqlFixture(row));
  }
  getGraphqlFixture(id) { return this.hydrateGraphqlFixture(this.db.prepare('SELECT * FROM graphql_fixtures WHERE id=?').get(id)); }
  addGraphqlFixture(endpointId, data) {
    const id = data.id || newId('gqlf');
    const now = Date.now();
    const position = this.db.prepare('SELECT COALESCE(MAX(position),-1)+1 AS p FROM graphql_fixtures WHERE endpoint_id=?').get(endpointId).p;
    this.db.prepare(
      'INSERT INTO graphql_fixtures(id,endpoint_id,name,operation_name,document_hash,operation_type,variables_match,response,subscription_events,delay_ms,enabled,position,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)'
    ).run(id, endpointId, data.name || 'Fixture', data.operationName || null, data.documentHash || null, data.operationType || 'query',
      data.variablesMatch == null ? null : toColumn(data.variablesMatch), toColumn(data.response || {}), toColumn(data.subscriptionEvents || []),
      Number(data.delayMs) || 0, data.enabled === false ? 0 : 1, position, now, now);
    return this.getGraphqlFixture(id);
  }
  updateGraphqlFixture(id, patch) {
    const current = this.getGraphqlFixture(id);
    if (!current) return null;
    this.db.prepare(
      'UPDATE graphql_fixtures SET name=?, operation_name=?, document_hash=?, operation_type=?, variables_match=?, response=?, subscription_events=?, delay_ms=?, enabled=?, updated_at=? WHERE id=?'
    ).run(
      patch.name == null ? current.name : patch.name,
      patch.operationName == null ? (current.operationName || null) : (patch.operationName || null),
      patch.documentHash == null ? (current.documentHash || null) : (patch.documentHash || null),
      patch.operationType == null ? current.operationType : patch.operationType,
      patch.variablesMatch == null ? (current.variablesMatch == null ? null : toColumn(current.variablesMatch)) : toColumn(patch.variablesMatch),
      patch.response == null ? toColumn(current.response) : toColumn(patch.response),
      patch.subscriptionEvents == null ? toColumn(current.subscriptionEvents) : toColumn(patch.subscriptionEvents),
      patch.delayMs == null ? current.delayMs : Number(patch.delayMs) || 0,
      patch.enabled == null ? (current.enabled ? 1 : 0) : (patch.enabled ? 1 : 0), Date.now(), id,
    );
    return this.getGraphqlFixture(id);
  }
  deleteGraphqlFixture(id) { this.db.prepare('DELETE FROM graphql_fixtures WHERE id=?').run(id); }
  moveGraphqlFixture(id, direction) {
    const current = this.db.prepare('SELECT * FROM graphql_fixtures WHERE id=?').get(id);
    if (!current) return null;
    const neighbor = direction === 'up'
      ? this.db.prepare('SELECT * FROM graphql_fixtures WHERE endpoint_id=? AND position<? ORDER BY position DESC LIMIT 1').get(current.endpoint_id, current.position)
      : this.db.prepare('SELECT * FROM graphql_fixtures WHERE endpoint_id=? AND position>? ORDER BY position ASC LIMIT 1').get(current.endpoint_id, current.position);
    if (neighbor) this.tx(() => {
      this.db.prepare('UPDATE graphql_fixtures SET position=?, updated_at=? WHERE id=?').run(neighbor.position, Date.now(), current.id);
      this.db.prepare('UPDATE graphql_fixtures SET position=?, updated_at=? WHERE id=?').run(current.position, Date.now(), neighbor.id);
    });
    return this.getGraphqlFixture(id);
  }

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
    const webhooks = this.db.prepare(`SELECT COUNT(*) AS n FROM endpoints WHERE type='inspector' AND protocol='http'${wsCond}`).get(...wsArgs).n;
    const mocks = this.db.prepare(`SELECT COUNT(*) AS n FROM endpoints WHERE type='mock'${wsCond}`).get(...wsArgs).n;
    const captured = this.db.prepare(`SELECT COALESCE(SUM(request_count),0) AS n FROM endpoints WHERE type='inspector' AND protocol='http'${wsCond}`).get(...wsArgs).n;
    const mocked = this.db.prepare(`SELECT COALESCE(SUM(request_count),0) AS n FROM endpoints WHERE type='mock' AND protocol='http'${wsCond}`).get(...wsArgs).n;
    const websockets = this.db.prepare(`SELECT COUNT(*) AS n FROM endpoints WHERE protocol IN ('websocket','socketio')${wsCond}`).get(...wsArgs).n;
    const graphql = this.db.prepare(`SELECT COUNT(*) AS n FROM endpoints WHERE protocol='graphql'${wsCond}`).get(...wsArgs).n;
    return { webhooks, mocks, websockets, graphql, captured, mocked, totalRequests: captured + mocked };
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

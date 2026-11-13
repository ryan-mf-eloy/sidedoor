// All admin REST handlers. Each handler receives a request context (rc) with
// { ctx, params, query, body, req, res } and returns a JSON-serializable value,
// or writes to rc.res directly (downloads/SSE) and returns undefined.
import { Router, ApiError } from './router.js';
import { localBase } from '../config.js';
import { slugify, newId } from '../lib/ids.js';
import { presetFor } from '../lib/hmac.js';
import { defaultAuth, defaultHmac, defaultRate } from '../store.js';
import { validateInspector, validateMock, isEmpty } from '../lib/validate.js';
import { diffLines, diffSummary } from '../lib/diff.js';
import { pretty } from '../lib/json.js';
import { EVENT_LIMITS, EventConfigError, normalizeScenarioEvent } from '../lib/eventConfig.js';
import { buildEventContext } from '../lib/eventTemplate.js';
import { publicTemplateCatalog } from '../lib/templateCatalog.js';
import {
  REALTIME_PROTOCOLS,
  RealtimeConfigError,
  defaultRealtimeConfig,
  normalizeGraphqlFixture,
  normalizeRealtimeConfig,
  normalizeRealtimeScript,
  normalizeRealtimeStep,
} from '../lib/realtime.js';
import { compileGraphqlSchema, DEFAULT_GRAPHQL_SDL, GraphqlConfigError, validateGraphqlSdl } from '../lib/graphql.js';
import { SOCKET_IO_PATH } from '../realtime-hub.js';

// ---- URL helpers ----
function baseUrls(ctx) {
  const local = localBase(ctx.config);
  const f = ctx.store.getFunnel();
  const publicBase = f && f.active && f.base_url ? f.base_url : null;
  return { local, publicBase };
}
function epUrls(ctx, ep) {
  const { local, publicBase } = baseUrls(ctx);
  const http = { local: `${local}/${ep.slug}`, public: publicBase ? `${publicBase}/${ep.slug}` : null };
  const ws = (url) => url ? url.replace(/^http:/, 'ws:').replace(/^https:/, 'wss:') : null;
  return {
    ...http,
    websocket: { local: ws(http.local), public: ws(http.public) },
    graphql: { httpLocal: http.local, httpPublic: http.public, wsLocal: ws(http.local), wsPublic: ws(http.public) },
    socketio: { path: SOCKET_IO_PATH, namespace: `/${ep.slug}`, local: local, public: publicBase },
  };
}
function presentEndpoint(ctx, ep) {
  if (!ep) return null;
  return {
    id: ep.id, type: ep.type, protocol: ep.protocol || 'http', name: ep.name, slug: ep.slug,
    workspaceId: ep.workspace_id, projectId: ep.project_id, project: ep.project,
    method: ep.method, path: ep.path, pathMode: ep.path_mode || 'exact', allowedMethods: (() => { try { return ep.allowed_methods ? JSON.parse(ep.allowed_methods) : null; } catch { return null; } })(),
    mode: ep.mode, forwardTarget: ep.forward_target,
    config: ep.config, signed: !!ep.config.hmac.enabled, provider: ep.config.hmac.provider,
    createdAt: ep.created_at, lastActivity: ep.last_activity, requestCount: ep.request_count,
    scenarios: ep.scenarios || undefined, matchRules: ep.matchRules || undefined,
    urls: epUrls(ctx, ep),
  };
}

function resolveProject(store, workspaceId, body) {
  if (body.projectId) return body.projectId;
  if (body.projectName && String(body.projectName).trim()) {
    const p = store.createProject(workspaceId, body.projectName);
    return p ? p.id : null;
  }
  return null;
}

function uniqueSlug(store, base) {
  const b = base || newId('ep');
  if (!store.slugExists(b)) return b;
  for (let i = 2; i < 500; i++) { const s = `${b}-${i}`; if (!store.slugExists(s)) return s; }
  return `${b}-${newId('x').slice(-4)}`;
}

// ---- download helper ----
function download(res, filename, data) {
  res.writeHead(200, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Disposition': `attachment; filename="${filename}"`,
  });
  res.end(data);
}

function normalizedEventOrThrow(body, current) {
  try {
    return normalizeScenarioEvent(body, current);
  } catch (error) {
    if (error instanceof EventConfigError) throw new ApiError(400, error.message, error.field ? { [error.field]: error.message } : undefined);
    throw error;
  }
}

function realtimeConfigOrThrow(value, current) {
  try { return normalizeRealtimeConfig(value, current); }
  catch (error) {
    if (error instanceof RealtimeConfigError) throw new ApiError(400, error.message, error.field ? { [error.field]: error.message } : undefined);
    throw error;
  }
}

function realtimeScriptOrThrow(value, current) {
  try { return normalizeRealtimeScript(value, current); }
  catch (error) {
    if (error instanceof RealtimeConfigError) throw new ApiError(400, error.message, error.field ? { [error.field]: error.message } : undefined);
    throw error;
  }
}

function realtimeStepOrThrow(value, current) {
  try { return normalizeRealtimeStep(value, current); }
  catch (error) {
    if (error instanceof RealtimeConfigError) throw new ApiError(400, error.message, error.field ? { [error.field]: error.message } : undefined);
    throw error;
  }
}

function graphqlFixtureOrThrow(value, current) {
  try { return normalizeGraphqlFixture(value, current); }
  catch (error) {
    if (error instanceof RealtimeConfigError) throw new ApiError(400, error.message, error.field ? { [error.field]: error.message } : undefined);
    throw error;
  }
}

function graphqlSchemaOrThrow(sdl) {
  try { compileGraphqlSchema(sdl); return String(sdl); }
  catch (error) {
    if (error instanceof GraphqlConfigError) throw new ApiError(400, error.message, { sdl: error.message });
    throw error;
  }
}

function assertRealtimeEndpoint(ep) {
  if (!ep || !REALTIME_PROTOCOLS.has(ep.protocol)) throw new ApiError(400, 'Not a realtime endpoint');
  return ep;
}

function initialAuth(body) {
  if (body.auth && typeof body.auth === 'object' && !Array.isArray(body.auth)) return { ...defaultAuth(), ...body.auth };
  const auth = defaultAuth();
  if (!body.auth || body.auth === 'none') return auth;
  auth.enabled = true;
  auth.method = body.auth;
  if (body.auth === 'bearer' || body.auth === 'apikey') auth.token = body.authToken ? String(body.authToken) : '';
  if (body.auth === 'apikey') {
    if (body.authApiKeyName) auth.apiKeyName = String(body.authApiKeyName);
    if (body.authApiKeyLoc === 'query' || body.authApiKeyLoc === 'header') auth.apiKeyLoc = body.authApiKeyLoc;
  }
  if (body.auth === 'basic') {
    auth.user = body.authUser ? String(body.authUser) : '';
    auth.pass = body.authPass ? String(body.authPass) : '';
  }
  return auth;
}

function createRealtimeEndpoint(ctx, body, workspaceId) {
  const store = ctx.store;
  const protocol = String(body.protocol || '').toLowerCase();
  if (!REALTIME_PROTOCOLS.has(protocol)) throw new ApiError(400, 'Unsupported realtime protocol', { protocol: 'Choose WebSocket, Socket.IO, or GraphQL' });
  const type = body.type === 'mock' ? 'mock' : body.type === 'inspector' ? 'inspector' : null;
  if (!type) throw new ApiError(400, 'Endpoint type must be inspector or mock', { type: 'Choose Inspector or Mock' });
  const slug = uniqueSlug(store, body.slug ? slugify(body.slug) : slugify(body.name) || newId(protocol));
  const errors = validateInspector({ name: body.name, slug }, store.allSlugs());
  if (!isEmpty(errors)) throw new ApiError(400, 'Validation failed', errors);
  const sdl = protocol === 'graphql' ? graphqlSchemaOrThrow(body.sdl == null ? DEFAULT_GRAPHQL_SDL : body.sdl) : null;
  const projectId = resolveProject(store, workspaceId, body);
  const config = {
    auth: initialAuth(body),
    hmac: { ...defaultHmac(), ...(body.hmac && typeof body.hmac === 'object' ? body.hmac : {}) },
    rate: { ...defaultRate(), ...(body.rate && typeof body.rate === 'object' ? body.rate : {}) },
    realtime: realtimeConfigOrThrow(body.realtime || defaultRealtimeConfig()),
    rules: [], ruleMatch: 'all',
  };
  const id = store.createEndpoint({ workspaceId, projectId, type, protocol, name: String(body.name).trim(), slug, config });
  if (sdl != null) store.setGraphqlSchema(id, sdl);
  return presentEndpoint(ctx, store.getEndpoint(id));
}

function fixtureBody(value) {
  if (value == null) return '';
  return typeof value === 'string' ? value : JSON.stringify(value);
}

function fixtureObject(value, field) {
  if (value == null) return {};
  if (typeof value !== 'object' || Array.isArray(value)) throw new ApiError(400, `${field} must be an object`, { [field]: 'Must be an object' });
  return value;
}

function manualEventContext(fixture, scenario, endpoint) {
  const root = fixture && typeof fixture === 'object' ? fixture : {};
  const request = fixtureObject(root.request, 'request');
  const response = fixtureObject(root.response, 'response');
  const requestBody = fixtureBody(request.body);
  const responseBody = fixtureBody(response.body == null ? scenario.body : response.body);
  return buildEventContext({
    request: {
      method: request.method || endpoint.method || 'POST',
      path: request.path || `/${endpoint.slug}`,
      subpath: request.subpath || request.path || '/',
      headers: fixtureObject(request.headers, 'request.headers'),
      query: fixtureObject(request.query, 'request.query'),
      body: requestBody,
    },
    response: {
      status: response.status == null ? scenario.status : Number(response.status),
      headers: response.headers == null ? scenario.headers : fixtureObject(response.headers, 'response.headers'),
      body: responseBody,
    },
  });
}

export function createApiRouter() {
  const r = new Router();

  // ---------- bootstrap state ----------
  r.get('/state', ({ ctx }) => {
    const store = ctx.store;
    const activeWs = store.getActiveWorkspace();
    return {
      workspaces: store.listWorkspaces(),
      activeWorkspace: activeWs,
      sidebarCollapsed: store.getSidebarCollapsed(),
      counts: store.counts(activeWs),
      funnel: store.getFunnel(),
      baseUrls: baseUrls(ctx),
      templateCatalog: publicTemplateCatalog(),
    };
  });

  r.post('/prefs/sidebar', ({ ctx, body }) => {
    ctx.store.setSidebarCollapsed(!!body.collapsed);
    return { ok: true, collapsed: ctx.store.getSidebarCollapsed() };
  });

  // ---------- workspaces ----------
  r.get('/workspaces', ({ ctx }) => ctx.store.listWorkspaces());
  r.post('/workspaces', ({ ctx, body }) => {
    if (!body.name || !String(body.name).trim()) throw new ApiError(400, 'Name is required', { name: 'Required' });
    const ws = ctx.store.createWorkspace(body);
    ctx.store.setActiveWorkspace(ws.id);
    return ws;
  });
  r.patch('/workspaces/:id', ({ ctx, params, body }) => {
    const ws = ctx.store.updateWorkspace(params.id, body);
    if (!ws) throw new ApiError(404, 'Workspace not found');
    return ws;
  });
  r.delete('/workspaces/:id', ({ ctx, params }) => {
    const res = ctx.store.deleteWorkspace(params.id);
    if (!res.ok) {
      if (res.reason === 'last-workspace') throw new ApiError(409, 'Cannot delete the last workspace');
      throw new ApiError(404, 'Workspace not found');
    }
    return { ok: true, active: res.active };
  });
  r.post('/workspaces/:id/activate', ({ ctx, params }) => {
    if (!ctx.store.getWorkspace(params.id)) throw new ApiError(404, 'Workspace not found');
    ctx.store.setActiveWorkspace(params.id);
    return { ok: true, active: params.id };
  });

  // ---------- projects ----------
  r.get('/workspaces/:id/projects', ({ ctx, params }) => ctx.store.listProjects(params.id));
  r.post('/projects', ({ ctx, body }) => {
    const workspaceId = body.workspaceId || ctx.store.getActiveWorkspace();
    const p = ctx.store.createProject(workspaceId, body.name);
    if (!p) throw new ApiError(400, 'Project name is required');
    return p;
  });
  r.patch('/projects/:id', ({ ctx, params, body }) => {
    const res = ctx.store.updateProject(params.id, body.name);
    if (!res.ok) {
      if (res.reason === 'not-found') throw new ApiError(404, 'Project not found');
      if (res.reason === 'duplicate-name') throw new ApiError(400, 'A project with that name already exists', { name: 'Name already in use' });
      throw new ApiError(400, 'Project name is required', { name: 'Required' });
    }
    return res.project;
  });
  r.delete('/projects/:id', ({ ctx, params }) => { ctx.store.deleteProject(params.id); return { ok: true }; });

  // ---------- endpoints ----------
  r.get('/endpoints', ({ ctx, query }) => {
    const workspaceId = query.workspace || ctx.store.getActiveWorkspace();
    const eps = ctx.store.listEndpoints({ workspaceId, type: query.type, protocol: query.protocol });
    return eps.map((e) => presentEndpoint(ctx, e));
  });

  r.post('/endpoints', ({ ctx, body }) => {
    const store = ctx.store;
    const workspaceId = body.workspaceId || store.getActiveWorkspace();
    if (!store.getWorkspace(workspaceId)) throw new ApiError(400, 'Unknown workspace');
    const protocol = body.protocol == null ? 'http' : String(body.protocol).toLowerCase();
    if (protocol !== 'http') return createRealtimeEndpoint(ctx, body, workspaceId);

    if (body.type === 'mock') {
      const errors = validateMock(
        { name: body.name, path: body.path, status: body.status, body: body.body, slug: body.slug ? slugify(body.slug) : '' },
        store.allSlugs(),
      );
      if (!isEmpty(errors)) throw new ApiError(400, 'Validation failed', errors);
      const slug = uniqueSlug(store, body.slug ? slugify(body.slug) : slugify(body.name) || newId('mock'));
      const auth = defaultAuth();
      if (body.auth && body.auth !== 'none') {
        auth.enabled = true;
        auth.method = body.auth;
        // Unlike a webhook's HMAC secret (issued by the third-party provider
        // only after the endpoint is registered), a mock's credentials are
        // invented by whoever is building the mock — so they're known up
        // front and the create form can capture them immediately instead of
        // leaving the endpoint enabled-but-unusable until a trip to Settings.
        if (body.auth === 'bearer' || body.auth === 'apikey') auth.token = body.authToken ? String(body.authToken) : '';
        if (body.auth === 'apikey') {
          if (body.authApiKeyName) auth.apiKeyName = String(body.authApiKeyName);
          if (body.authApiKeyLoc === 'query' || body.authApiKeyLoc === 'header') auth.apiKeyLoc = body.authApiKeyLoc;
        }
        if (body.auth === 'basic') {
          auth.user = body.authUser ? String(body.authUser) : '';
          auth.pass = body.authPass ? String(body.authPass) : '';
        }
      }
      const projectId = resolveProject(store, workspaceId, body);
      const id = store.createEndpoint({
        workspaceId, projectId, type: 'mock', name: String(body.name).trim(), slug,
        method: body.method || 'POST', path: body.path, pathMode: body.pathMode || 'exact',
        allowedMethods: body.allowedMethods || null, mode: 'single',
        config: { auth, hmac: defaultHmac(), rate: defaultRate(), rules: [], ruleMatch: 'all' },
      });
      store.addScenario(id, {
        name: 'Default', status: Number(body.status) || 200, delay: Number(body.delay) || 0,
        contentType: body.contentType || 'application/json', body: body.body != null ? String(body.body) : '{}', active: true,
      });
      return presentEndpoint(ctx, store.getEndpoint(id));
    }

    // inspector (webhook)
    const errors = validateInspector({ name: body.name, slug: body.slug ? slugify(body.slug) : body.slug }, store.allSlugs());
    if (!isEmpty(errors)) throw new ApiError(400, 'Validation failed', errors);
    const hmac = defaultHmac();
    if (body.validate) {
      hmac.enabled = true;
      hmac.provider = body.provider || 'custom';
      const p = presetFor(hmac.provider);
      hmac.algo = p.algo; hmac.header = p.header; hmac.encoding = p.encoding;
      // Optional: a real provider's signing secret usually only exists after
      // you register this URL with them, so this is never required here —
      // but if the user already has it (e.g. pasted from a provider
      // dashboard, or testing against their own sender), capture it now
      // instead of forcing a trip to Endpoint Settings first.
      if (body.hmacSecret && String(body.hmacSecret).trim()) hmac.secret = String(body.hmacSecret).trim();
    }
    const projectId = resolveProject(store, workspaceId, body);
    const id = store.createEndpoint({
      workspaceId, projectId, type: 'inspector', name: String(body.name).trim(), slug: slugify(body.slug),
      forwardTarget: body.forwardTarget || null,
      config: { auth: defaultAuth(), hmac, rate: defaultRate(), rules: [], ruleMatch: 'all' },
    });
    return presentEndpoint(ctx, store.getEndpoint(id));
  });

  r.get('/endpoints/:id', ({ ctx, params }) => {
    const ep = ctx.store.getEndpoint(params.id);
    if (!ep) throw new ApiError(404, 'Endpoint not found');
    return presentEndpoint(ctx, ep);
  });

  r.patch('/endpoints/:id', ({ ctx, params, body }) => {
    const store = ctx.store;
    const cur = store.getEndpoint(params.id);
    if (!cur) throw new ApiError(404, 'Endpoint not found');
    const patch = { ...body };
    const nextProtocol = body.protocol == null ? cur.protocol : String(body.protocol).toLowerCase();
    if (nextProtocol !== 'http' && !REALTIME_PROTOCOLS.has(nextProtocol)) throw new ApiError(400, 'Unsupported protocol', { protocol: 'Unsupported protocol' });
    if (body.protocol != null) patch.protocol = nextProtocol;
    if (body.realtime != null) patch.realtime = realtimeConfigOrThrow(body.realtime, cur.config.realtime);
    if (body.sdl != null && nextProtocol !== 'graphql') throw new ApiError(400, 'SDL is only available for GraphQL endpoints', { sdl: 'Endpoint is not GraphQL' });
    if (body.slug != null) {
      const slug = slugify(body.slug);
      if (!slug) throw new ApiError(400, 'Invalid slug', { slug: 'A slug is required' });
      if (store.slugExists(slug, params.id)) throw new ApiError(400, 'Slug in use', { slug: 'That slug is already in use' });
      patch.slug = slug;
    }
    if (body.projectName && !body.projectId) patch.projectId = resolveProject(store, cur.workspace_id, body);
    if (nextProtocol !== cur.protocol && ctx.realtime && ctx.realtime.disconnectEndpoint) ctx.realtime.disconnectEndpoint(params.id, 'protocol_changed');
    store.updateEndpoint(params.id, patch);
    if (nextProtocol === 'graphql' && (body.sdl != null || cur.protocol !== 'graphql')) {
      const sdl = graphqlSchemaOrThrow(body.sdl == null ? DEFAULT_GRAPHQL_SDL : body.sdl);
      store.setGraphqlSchema(params.id, sdl);
    }
    return presentEndpoint(ctx, store.getEndpoint(params.id));
  });

  r.delete('/endpoints/:id', ({ ctx, params }) => {
    if (!ctx.store.getRawEndpoint(params.id)) throw new ApiError(404, 'Endpoint not found');
    if (ctx.realtime && ctx.realtime.disconnectEndpoint) ctx.realtime.disconnectEndpoint(params.id, 'endpoint_deleted');
    ctx.store.deleteEndpoint(params.id);
    return { ok: true };
  });

  // ---------- realtime sessions ----------
  r.get('/endpoints/:id/realtime-sessions', ({ ctx, params, query }) => {
    assertRealtimeEndpoint(ctx.store.getEndpoint(params.id));
    return ctx.store.listRealtimeSessions({ endpointId: params.id, state: query.state, limit: query.limit });
  });
  r.get('/realtime-sessions/:id', ({ ctx, params }) => {
    const session = ctx.store.getRealtimeSession(params.id, { details: true });
    if (!session) throw new ApiError(404, 'Realtime session not found');
    return session;
  });
  r.post('/realtime-sessions/:id/disconnect', ({ ctx, params }) => {
    const current = ctx.store.getRealtimeSession(params.id);
    if (!current) throw new ApiError(404, 'Realtime session not found');
    const session = ctx.realtime && ctx.realtime.disconnect
      ? ctx.realtime.disconnect(params.id)
      : ctx.store.closeRealtimeSession(params.id, { code: 1001, reason: 'admin_disconnect' });
    return session;
  });
  r.delete('/endpoints/:id/realtime-sessions', ({ ctx, params }) => {
    assertRealtimeEndpoint(ctx.store.getEndpoint(params.id));
    if (ctx.realtime && ctx.realtime.disconnectEndpoint) ctx.realtime.disconnectEndpoint(params.id, 'history_cleared');
    ctx.store.clearRealtimeSessions(params.id);
    return { ok: true };
  });
  r.post('/endpoints/:id/realtime-test', async ({ ctx, params, body }) => {
    const endpoint = assertRealtimeEndpoint(ctx.store.getEndpoint(params.id));
    if (!ctx.realtime || !ctx.realtime.runTest) throw new ApiError(503, 'Realtime runtime is unavailable');
    return ctx.realtime.runTest(endpoint, body);
  });

  // ---------- WebSocket / Socket.IO mock scripts ----------
  r.get('/endpoints/:id/realtime-scripts', ({ ctx, params }) => {
    const endpoint = assertRealtimeEndpoint(ctx.store.getEndpoint(params.id));
    if (endpoint.type !== 'mock' || endpoint.protocol === 'graphql') throw new ApiError(400, 'Scripts are available for WebSocket and Socket.IO mocks only');
    return ctx.store.listRealtimeScripts(params.id);
  });
  r.post('/endpoints/:id/realtime-scripts', ({ ctx, params, body }) => {
    const endpoint = assertRealtimeEndpoint(ctx.store.getEndpoint(params.id));
    if (endpoint.type !== 'mock' || endpoint.protocol === 'graphql') throw new ApiError(400, 'Scripts are available for WebSocket and Socket.IO mocks only');
    return ctx.store.addRealtimeScript(params.id, realtimeScriptOrThrow(body));
  });
  r.patch('/realtime-scripts/:id', ({ ctx, params, body }) => {
    const current = ctx.store.getRealtimeScript(params.id);
    if (!current) throw new ApiError(404, 'Realtime script not found');
    const endpoint = assertRealtimeEndpoint(ctx.store.getEndpoint(current.endpointId));
    if (endpoint.type !== 'mock' || endpoint.protocol === 'graphql') throw new ApiError(400, 'Scripts are unavailable for this endpoint');
    return ctx.store.updateRealtimeScript(params.id, realtimeScriptOrThrow(body, current));
  });
  r.delete('/realtime-scripts/:id', ({ ctx, params }) => {
    if (!ctx.store.getRealtimeScript(params.id)) throw new ApiError(404, 'Realtime script not found');
    ctx.store.deleteRealtimeScript(params.id);
    return { ok: true };
  });
  r.post('/realtime-scripts/:id/move', ({ ctx, params, body }) => {
    if (body.direction !== 'up' && body.direction !== 'down') throw new ApiError(400, 'direction must be "up" or "down"');
    const script = ctx.store.moveRealtimeScript(params.id, body.direction);
    if (!script) throw new ApiError(404, 'Realtime script not found');
    return script;
  });
  r.post('/realtime-scripts/:id/steps', ({ ctx, params, body }) => {
    const script = ctx.store.getRealtimeScript(params.id);
    if (!script) throw new ApiError(404, 'Realtime script not found');
    return ctx.store.addRealtimeStep(params.id, realtimeStepOrThrow(body));
  });
  r.patch('/realtime-steps/:id', ({ ctx, params, body }) => {
    const current = ctx.store.getRealtimeStep(params.id);
    if (!current) throw new ApiError(404, 'Realtime script step not found');
    return ctx.store.updateRealtimeStep(params.id, realtimeStepOrThrow(body, current));
  });
  r.delete('/realtime-steps/:id', ({ ctx, params }) => {
    if (!ctx.store.getRealtimeStep(params.id)) throw new ApiError(404, 'Realtime script step not found');
    ctx.store.deleteRealtimeStep(params.id);
    return { ok: true };
  });
  r.post('/realtime-steps/:id/move', ({ ctx, params, body }) => {
    if (body.direction !== 'up' && body.direction !== 'down') throw new ApiError(400, 'direction must be "up" or "down"');
    const step = ctx.store.moveRealtimeStep(params.id, body.direction);
    if (!step) throw new ApiError(404, 'Realtime script step not found');
    return step;
  });

  // ---------- GraphQL schema and fixtures ----------
  r.post('/graphql/validate', ({ body }) => {
    const result = validateGraphqlSdl(body.sdl);
    if (result.valid) return { valid: true };
    return { valid: false, message: result.message, line: result.line, column: result.column };
  });
  r.get('/endpoints/:id/graphql/schema', ({ ctx, params }) => {
    const endpoint = assertRealtimeEndpoint(ctx.store.getEndpoint(params.id));
    if (endpoint.protocol !== 'graphql') throw new ApiError(400, 'Not a GraphQL endpoint');
    return ctx.store.getGraphqlSchema(params.id);
  });
  r.put('/endpoints/:id/graphql/schema', ({ ctx, params, body }) => {
    const endpoint = assertRealtimeEndpoint(ctx.store.getEndpoint(params.id));
    if (endpoint.protocol !== 'graphql') throw new ApiError(400, 'Not a GraphQL endpoint');
    return ctx.store.setGraphqlSchema(params.id, graphqlSchemaOrThrow(body.sdl));
  });
  r.get('/endpoints/:id/graphql/fixtures', ({ ctx, params }) => {
    const endpoint = assertRealtimeEndpoint(ctx.store.getEndpoint(params.id));
    if (endpoint.protocol !== 'graphql') throw new ApiError(400, 'Not a GraphQL endpoint');
    return ctx.store.listGraphqlFixtures(params.id);
  });
  r.post('/endpoints/:id/graphql/fixtures', ({ ctx, params, body }) => {
    const endpoint = assertRealtimeEndpoint(ctx.store.getEndpoint(params.id));
    if (endpoint.protocol !== 'graphql') throw new ApiError(400, 'Not a GraphQL endpoint');
    return ctx.store.addGraphqlFixture(params.id, graphqlFixtureOrThrow(body));
  });
  r.patch('/graphql-fixtures/:id', ({ ctx, params, body }) => {
    const current = ctx.store.getGraphqlFixture(params.id);
    if (!current) throw new ApiError(404, 'GraphQL fixture not found');
    return ctx.store.updateGraphqlFixture(params.id, graphqlFixtureOrThrow(body, current));
  });
  r.delete('/graphql-fixtures/:id', ({ ctx, params }) => {
    if (!ctx.store.getGraphqlFixture(params.id)) throw new ApiError(404, 'GraphQL fixture not found');
    ctx.store.deleteGraphqlFixture(params.id);
    return { ok: true };
  });
  r.post('/graphql-fixtures/:id/move', ({ ctx, params, body }) => {
    if (body.direction !== 'up' && body.direction !== 'down') throw new ApiError(400, 'direction must be "up" or "down"');
    const fixture = ctx.store.moveGraphqlFixture(params.id, body.direction);
    if (!fixture) throw new ApiError(404, 'GraphQL fixture not found');
    return fixture;
  });

  // ---------- scenarios ----------
  r.post('/endpoints/:id/scenarios', ({ ctx, params, body }) => {
    const ep = ctx.store.getRawEndpoint(params.id);
    if (!ep || ep.type !== 'mock') throw new ApiError(400, 'Not a mock endpoint');
    return ctx.store.addScenario(params.id, body);
  });
  r.patch('/scenarios/:id', ({ ctx, params, body }) => {
    const sc = ctx.store.updateScenario(params.id, body);
    if (!sc) throw new ApiError(404, 'Scenario not found');
    return sc;
  });
  r.delete('/scenarios/:id', ({ ctx, params }) => { ctx.store.deleteScenario(params.id); return { ok: true }; });
  r.post('/scenarios/:id/activate', ({ ctx, params }) => {
    const sc = ctx.store.getScenario(params.id);
    if (!sc) throw new ApiError(404, 'Scenario not found');
    ctx.store.activateScenario(sc.endpointId, params.id);
    return { ok: true };
  });

  // ---------- scenario async events ----------
  r.get('/scenarios/:id/events', ({ ctx, params }) => {
    if (!ctx.store.getScenario(params.id)) throw new ApiError(404, 'Scenario not found');
    return ctx.store.listScenarioEvents(params.id);
  });
  r.post('/scenarios/:id/events', ({ ctx, params, body }) => {
    const scenario = ctx.store.getScenario(params.id);
    if (!scenario) throw new ApiError(404, 'Scenario not found');
    if (ctx.store.listScenarioEvents(params.id).length >= EVENT_LIMITS.maxEventsPerScenario) {
      throw new ApiError(400, `A scenario can have at most ${EVENT_LIMITS.maxEventsPerScenario} async events`);
    }
    const event = ctx.store.addScenarioEvent(params.id, normalizedEventOrThrow(body));
    return event;
  });
  r.patch('/scenario-events/:id', ({ ctx, params, body }) => {
    const current = ctx.store.getScenarioEvent(params.id);
    if (!current) throw new ApiError(404, 'Async event not found');
    const event = ctx.store.updateScenarioEvent(params.id, normalizedEventOrThrow(body, current));
    if (ctx.dispatcher) ctx.dispatcher.wake();
    return event;
  });
  r.delete('/scenario-events/:id', ({ ctx, params }) => {
    if (!ctx.store.getScenarioEvent(params.id)) throw new ApiError(404, 'Async event not found');
    ctx.store.deleteScenarioEvent(params.id);
    if (ctx.dispatcher) ctx.dispatcher.wake();
    return { ok: true };
  });
  r.post('/scenario-events/:id/move', ({ ctx, params, body }) => {
    if (body.direction !== 'up' && body.direction !== 'down') throw new ApiError(400, 'direction must be "up" or "down"');
    const event = ctx.store.moveScenarioEvent(params.id, body.direction);
    if (!event) throw new ApiError(404, 'Async event not found');
    return event;
  });
  r.post('/scenarios/:id/event-runs/test', ({ ctx, params, body }) => {
    const scenario = ctx.store.getScenario(params.id);
    if (!scenario) throw new ApiError(404, 'Scenario not found');
    const endpoint = ctx.store.getRawEndpoint(scenario.endpointId);
    if (!endpoint || endpoint.type !== 'mock') throw new ApiError(400, 'Scenario is not attached to a mock endpoint');
    const events = ctx.store.listScenarioEvents(scenario.id).filter((event) => event.enabled);
    if (!events.length) throw new ApiError(409, 'Enable at least one async event before running a test flow');
    const run = ctx.store.createEventRun({
      endpointId: endpoint.id, scenarioId: scenario.id, source: 'test', events,
      context: manualEventContext(body, scenario, endpoint),
    });
    ctx.events.broadcast('delivery', { endpointId: endpoint.id, run });
    if (ctx.dispatcher) ctx.dispatcher.wake();
    return run;
  });

  // ---------- async delivery history ----------
  r.get('/endpoints/:id/event-runs', ({ ctx, params, query }) => {
    if (!ctx.store.getRawEndpoint(params.id)) throw new ApiError(404, 'Endpoint not found');
    return ctx.store.listEventRuns({ endpointId: params.id, status: query.status, source: query.source, limit: query.limit });
  });
  r.get('/event-runs/:id', ({ ctx, params }) => {
    const run = ctx.store.getEventRun(params.id, { details: true });
    if (!run) throw new ApiError(404, 'Delivery run not found');
    return run;
  });
  r.post('/event-runs/:id/cancel', ({ ctx, params }) => {
    const run = ctx.store.cancelEventRun(params.id);
    if (!run) throw new ApiError(404, 'Delivery run not found');
    if (ctx.dispatcher) ctx.dispatcher.cancelRun(params.id);
    ctx.events.broadcast('delivery', { endpointId: run.endpointId, run: ctx.store.getEventRun(params.id) });
    return run;
  });

  // ---------- match rules ----------
  r.post('/endpoints/:id/match-rules', ({ ctx, params, body }) => {
    const ep = ctx.store.getRawEndpoint(params.id);
    if (!ep || ep.type !== 'mock') throw new ApiError(400, 'Not a mock endpoint');
    return ctx.store.addMatchRule(params.id, body);
  });
  r.patch('/match-rules/:id', ({ ctx, params, body }) => {
    const rule = ctx.store.updateMatchRule(params.id, body);
    if (!rule) throw new ApiError(404, 'Rule not found');
    return rule;
  });
  r.delete('/match-rules/:id', ({ ctx, params }) => { ctx.store.deleteMatchRule(params.id); return { ok: true }; });
  r.post('/match-rules/:id/move', ({ ctx, params, body }) => {
    if (body.direction !== 'up' && body.direction !== 'down') throw new ApiError(400, 'direction must be "up" or "down"');
    const rule = ctx.store.moveMatchRule(params.id, body.direction);
    if (!rule) throw new ApiError(404, 'Rule not found');
    return rule;
  });

  // ---------- requests ----------
  r.get('/endpoints/:id/requests', ({ ctx, params, query }) => {
    const ep = ctx.store.getRawEndpoint(params.id);
    if (!ep) throw new ApiError(404, 'Endpoint not found');
    return ctx.store.listRequests({
      endpointId: params.id, search: query.search, method: query.method,
      after: query.after != null ? Number(query.after) : undefined,
      limit: query.limit != null ? Number(query.limit) : 500,
    });
  });
  r.delete('/endpoints/:id/requests', ({ ctx, params }) => { ctx.store.clearRequests(params.id); return { ok: true }; });

  // NOTE: static '/requests/diff' and '/requests/overview' must be
  // registered before '/requests/:id' (router matches in registration
  // order; :id would otherwise swallow them).
  r.get('/requests/diff', ({ ctx, query }) => {
    const a = ctx.store.getRequest(query.a);
    const b = ctx.store.getRequest(query.b);
    if (!a || !b) throw new ApiError(400, 'Two valid request ids (a, b) are required');
    const rows = diffLines(pretty(a.body || ''), pretty(b.body || ''));
    return { rows, summary: diffSummary(rows), a, b };
  });
  r.get('/requests/overview', ({ ctx, query }) => {
    const workspaceId = query.workspace || ctx.store.getActiveWorkspace();
    const period = ['24h', '7d', '30d'].includes(query.period) ? query.period : '24h';
    return ctx.store.requestsOverview(workspaceId, period);
  });

  r.get('/requests/:id', ({ ctx, params }) => {
    const req = ctx.store.getRequest(params.id);
    if (!req) throw new ApiError(404, 'Request not found');
    return req;
  });
  r.delete('/requests/:id', ({ ctx, params }) => { ctx.store.deleteRequest(params.id); return { ok: true }; });

  r.post('/requests/:id/replay', async ({ ctx, params, body }) => {
    const req = ctx.store.getRequest(params.id);
    if (!req) throw new ApiError(404, 'Request not found');
    const ep = ctx.store.getRawEndpoint(req.endpointId);
    const target = (body && body.target && String(body.target).trim())
      || (ep && ep.forward_target)
      || `${localBase(ctx.config)}/${ep ? ep.slug : ''}`;
    const headers = {};
    const skip = new Set(['host', 'content-length', 'connection', 'transfer-encoding', 'accept-encoding']);
    for (const [k, v] of Object.entries(req.headers || {})) if (!skip.has(k.toLowerCase())) headers[k] = v;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10000);
    const started = Date.now();
    try {
      const hasBody = req.method !== 'GET' && req.method !== 'HEAD' && req.body != null;
      const resp = await fetch(target, { method: req.method, headers, body: hasBody ? req.body : undefined, signal: controller.signal });
      const text = await resp.text();
      const respHeaders = {};
      resp.headers.forEach((v, k) => { respHeaders[k] = v; });
      return { ok: true, target, status: resp.status, statusText: resp.statusText, durationMs: Date.now() - started, headers: respHeaders, body: text.slice(0, 40000) };
    } catch (e) {
      return { ok: false, target, error: String(e && e.message || e), durationMs: Date.now() - started };
    } finally {
      clearTimeout(timer);
    }
  });

  r.get('/requests/:id/export', ({ ctx, params, res }) => {
    const req = ctx.store.getRequest(params.id);
    if (!req) throw new ApiError(404, 'Request not found');
    download(res, `request-${req.seq}.json`, JSON.stringify(req, null, 2));
  });
  r.get('/endpoints/:id/requests/export', ({ ctx, params, res }) => {
    const ep = ctx.store.getRawEndpoint(params.id);
    if (!ep) throw new ApiError(404, 'Endpoint not found');
    const all = ctx.store.listRequests({ endpointId: params.id, limit: 100000 });
    download(res, `${ep.slug}-requests.json`, JSON.stringify({ endpoint: ep.slug, exportedAt: Date.now(), count: all.length, requests: all }, null, 2));
  });

  // ---------- activity ----------
  r.get('/activity', ({ ctx, query }) => {
    const workspaceId = query.workspace || ctx.store.getActiveWorkspace();
    return ctx.store.recentActivity(workspaceId, query.limit ? Number(query.limit) : 12);
  });

  // ---------- funnel ----------
  r.get('/funnel', async ({ ctx }) => funnelPayload(ctx, await ctx.tailscale.summary()));
  r.post('/funnel/refresh', async ({ ctx }) => funnelPayload(ctx, await ctx.tailscale.refresh()));
  r.post('/funnel/enable', async ({ ctx }) => funnelPayload(ctx, await ctx.tailscale.enable()));
  r.post('/funnel/disable', async ({ ctx }) => funnelPayload(ctx, await ctx.tailscale.disable()));
  r.get('/funnel/history', ({ ctx }) => ctx.store.listFunnelHistory(20));

  return r;
}

function funnelPayload(ctx, state) {
  const store = ctx.store;
  const eps = store.listEndpoints({});
  const exposed = eps.map((e) => ({
    id: e.id, type: e.type, name: e.name, slug: e.slug,
    signed: !!e.config.hmac.enabled, url: epUrls(ctx, e).public || epUrls(ctx, e).local,
    requestCount: e.request_count,
  }));
  return { state: state || store.getFunnel(), history: store.listFunnelHistory(20), exposed, baseUrls: baseUrls(ctx) };
}

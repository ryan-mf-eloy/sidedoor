// Multiplexes the realtime ingest protocols without changing the legacy HTTP
// request handler. Every accepted connection receives a durable transcript;
// sockets themselves remain intentionally process-local and are never resumed.
import { Server as SocketIOServer } from 'socket.io';
import WebSocket, { WebSocketServer } from 'ws';
import { useServer } from 'graphql-ws/use/ws';
import { GraphQLError, execute as graphqlExecute } from 'graphql';
import { verifyAuth, failStatus } from './lib/auth.js';
import { clampStatus } from './ingest/handler.js';
import {
  safeRealtimeHeaders,
  safeRealtimePayload,
  payloadMatches,
  payloadText,
} from './lib/realtime.js';
import {
  analyzeGraphqlOperation,
  executeIntrospection,
  fixtureEventStream,
  fixtureNotFoundResult,
  inspectorOnlyResult,
  isIntrospectionOperation,
  selectGraphqlFixture,
  sleep,
} from './lib/graphql.js';

const MAX_REALTIME_FRAME_BYTES = 16 * 1024 * 1024;
const SOCKET_IO_PATH = '/_sidedoor/socket.io/';

function clientIp(req) {
  const xff = req.headers && req.headers['x-forwarded-for'];
  let ip = xff ? String(xff).split(',')[0].trim() : req.socket && req.socket.remoteAddress || '';
  if (ip.startsWith('::ffff:')) ip = ip.slice(7);
  if (ip === '::1') ip = '127.0.0.1';
  return ip;
}

function requestUrl(req) {
  return new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
}

function rejectUpgrade(socket, status, message) {
  const text = String(message || 'Rejected').replace(/[\r\n]/g, ' ').slice(0, 160);
  try {
    socket.write(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Type: application/json; charset=utf-8\r\nContent-Length: 0\r\n\r\n`);
  } finally {
    socket.destroy();
  }
}

function originAllowed(config, origin) {
  const allowed = config && config.allowedOrigins || ['*'];
  if (allowed.includes('*')) return true;
  if (!origin) return false;
  return allowed.includes(origin);
}

function objectPath(source, path) {
  let current = source;
  for (const key of String(path || '').split('.').filter(Boolean)) {
    if (!current || typeof current !== 'object' || !Object.prototype.hasOwnProperty.call(current, key)) return undefined;
    current = current[key];
  }
  return current;
}

function protocolAuthContext(endpoint, payload) {
  const value = objectPath(payload || {}, endpoint.config.realtime.protocolAuthPath);
  const auth = endpoint.config.auth || {};
  const headers = {};
  const query = {};
  if (value != null && value !== '') {
    if (auth.method === 'apikey') {
      if (auth.apiKeyLoc === 'query') query[auth.apiKeyName || 'X-Api-Key'] = String(value);
      else headers[auth.apiKeyName || 'X-Api-Key'] = String(value);
    } else {
      headers[auth.header || 'Authorization'] = String(value);
    }
  }
  return { headers, query };
}

function jsonPayload(value) {
  if (value === undefined) return '';
  if (typeof value === 'string') return value;
  try {
    const text = JSON.stringify(value);
    return text == null ? '' : text;
  } catch { return String(value); }
}

function messageKind(value, binary = false) {
  if (binary) return 'binary';
  if (typeof value === 'object' && value !== null) return 'json';
  if (typeof value === 'string') {
    try { JSON.parse(value); return 'json'; } catch { return 'text'; }
  }
  return 'message';
}

function parsedPayload(value) {
  const raw = Buffer.isBuffer(value) ? value.toString('utf8') : value;
  if (typeof raw !== 'string') return raw;
  try { return JSON.parse(raw); } catch { return raw; }
}

function graphQLError(message, code) {
  return new GraphQLError(message, { extensions: { code } });
}

function resultError(result) {
  return result && result.errors && result.errors[0]
    ? graphQLError(result.errors[0].message, result.errors[0].extensions && result.errors[0].extensions.code || 'SIDEDOOR_GRAPHQL_ERROR')
    : graphQLError('GraphQL fixture not found', 'SIDEDOOR_FIXTURE_NOT_FOUND');
}

export class RealtimeHub {
  constructor(ctx) {
    this.ctx = ctx;
    this.connections = new Map();
    this.wsMeta = new WeakMap();
    this.ingestServer = null;
    this.rawWss = null;
    this.graphqlWss = null;
    this.socketIo = null;
    this.graphqlDisposable = null;
  }

  attach(server) {
    if (this.ingestServer) return;
    this.ingestServer = server;
    const maxPayload = Math.max(1024, Number(this.ctx.config.maxRealtimeFrameBytes) || MAX_REALTIME_FRAME_BYTES);
    this.rawWss = new WebSocketServer({ noServer: true, perMessageDeflate: false, maxPayload });
    this.graphqlWss = new WebSocketServer({ noServer: true, perMessageDeflate: false, maxPayload });
    this.rawWss.on('connection', (socket, req) => this.openRawSocket(socket, req));

    this.graphqlDisposable = useServer({
      onConnect: async (gqlContext) => this.onGraphqlConnect(gqlContext),
      onSubscribe: async (gqlContext, _id, payload) => this.onGraphqlSubscribe(gqlContext, payload),
      execute: async (args) => this.executeGraphql(args),
      subscribe: async (args) => this.subscribeGraphql(args),
      onNext: async (gqlContext, _id, payload, _args, result) => {
        const live = this.liveForGraphql(gqlContext);
        if (live) this.log(live, { direction: 'out', kind: 'graphql_next', operationName: payload.operationName || '', payload: result });
      },
      onError: async (gqlContext, _id, payload, errors) => {
        const live = this.liveForGraphql(gqlContext);
        if (live) this.log(live, { direction: 'out', kind: 'graphql_error', operationName: payload.operationName || '', payload: errors.map((error) => error.toJSON ? error.toJSON() : { message: error.message }) });
      },
      onComplete: async (gqlContext, _id, payload) => {
        const live = this.liveForGraphql(gqlContext);
        if (live) this.log(live, { direction: 'out', kind: 'graphql_complete', operationName: payload.operationName || '', payload: { complete: true } });
      },
      onClose: async (gqlContext, code, reason) => {
        const live = this.liveForGraphql(gqlContext);
        if (live) this.closeLive(live, { code, reason: live.closeReason || reason || 'closed', state: live.rejected ? 'rejected' : 'closed' });
      },
    }, this.graphqlWss, 0);
    this.graphqlWss.on('connection', (socket) => this.observeGraphqlSocket(socket));

    this.socketIo = new SocketIOServer(server, {
      path: SOCKET_IO_PATH,
      transports: ['polling', 'websocket'],
      allowEIO3: false,
      cleanupEmptyChildNamespaces: true,
      maxHttpBufferSize: maxPayload,
      perMessageDeflate: false,
      httpCompression: false,
      cookie: false,
      // RealtimeHub owns every non-Socket.IO upgrade and rejects unknown
      // paths itself. Disable Engine.IO's delayed fallback destroyer so it
      // cannot race a valid raw WebSocket or GraphQL upgrade.
      destroyUpgrade: false,
      cors: {
        origin: (origin, done) => done(null, this.socketIoOriginAllowed(origin)),
        credentials: false,
        methods: ['GET', 'POST'],
      },
    });
    const namespaces = this.socketIo.of((name, _auth, next) => {
      const slug = String(name || '').replace(/^\//, '');
      const endpoint = slug && this.ctx.store.getEndpointBySlug(slug);
      next(null, !!(endpoint && endpoint.protocol === 'socketio'));
    });
    namespaces.use((socket, next) => {
      const endpoint = this.endpointForSocketIo(socket);
      if (!endpoint) return next(new Error('Unknown Socket.IO namespace'));
      const check = this.authorizeHandshake(endpoint, socket.handshake, { protocol: 'socketio' });
      if (!check.ok) return next(new Error(check.reason));
      if (endpoint.config.realtime.authSource === 'protocol_init' || endpoint.config.realtime.authSource === 'both') {
        const protocolCheck = this.authorizeProtocol(endpoint, socket.handshake.auth || {});
        if (!protocolCheck.ok) {
          this.recordRejected(endpoint, 'socketio', socket.handshake, protocolCheck.reason);
          return next(new Error(protocolCheck.reason));
        }
      }
      return next();
    });
    namespaces.on('connection', (socket) => this.openSocketIo(socket));

    server.on('upgrade', (req, socket, head) => this.handleUpgrade(req, socket, head));
  }

  socketIoOriginAllowed(origin) {
    const endpoints = this.ctx.store.listEndpoints({}).filter((endpoint) => endpoint.protocol === 'socketio');
    return endpoints.some((endpoint) => originAllowed(endpoint.config.realtime, origin));
  }

  endpointForSocketIo(socket) {
    const slug = String(socket.nsp && socket.nsp.name || '').replace(/^\//, '');
    const endpoint = slug && this.ctx.store.getEndpointBySlug(slug);
    return endpoint && endpoint.protocol === 'socketio' ? endpoint : null;
  }

  handleUpgrade(req, socket, head) {
    let url;
    try { url = requestUrl(req); } catch { return rejectUpgrade(socket, 400, 'Bad Request'); }
    if (url.pathname.startsWith(SOCKET_IO_PATH)) return;
    const segments = url.pathname.split('/').filter(Boolean);
    if (segments.length !== 1) return rejectUpgrade(socket, 404, 'Not Found');
    const endpoint = this.ctx.store.getEndpointBySlug(segments[0]);
    if (!endpoint || !['websocket', 'graphql'].includes(endpoint.protocol)) return rejectUpgrade(socket, 404, 'Not Found');
    const authorized = this.authorizeHandshake(endpoint, { headers: req.headers, query: Object.fromEntries(url.searchParams.entries()), address: clientIp(req) }, { protocol: endpoint.protocol });
    if (!authorized.ok) return rejectUpgrade(socket, authorized.status, authorized.reason);
    const target = endpoint.protocol === 'graphql' ? this.graphqlWss : this.rawWss;
    target.handleUpgrade(req, socket, head, (ws) => {
      this.wsMeta.set(ws, { endpoint, req, url });
      target.emit('connection', ws, req);
    });
  }

  authorizeHandshake(endpoint, handshake, { protocol }) {
    const cfg = endpoint.config;
    const realtime = cfg.realtime;
    const headers = handshake.headers || {};
    const query = handshake.query || {};
    const origin = headers.origin;
    if (!originAllowed(realtime, origin)) {
      this.recordRejected(endpoint, protocol, handshake, 'origin_not_allowed');
      return { ok: false, status: 403, reason: 'Origin not allowed' };
    }
    const source = protocol === 'websocket' ? 'handshake' : realtime.authSource;
    if (source === 'handshake' || source === 'both') {
      const auth = verifyAuth(cfg.auth, { headers, query });
      if (!auth.ok) {
        this.recordRejected(endpoint, protocol, handshake, `auth:${auth.reason}`);
        return { ok: false, status: failStatus(cfg.auth), reason: 'Unauthorized' };
      }
    }
    if (cfg.rate.enabled) {
      const result = this.ctx.rateLimiter.check(endpoint.id, cfg.rate, { ip: handshake.address || clientIp(handshake), headers }, Date.now());
      if (!result.allowed) {
        this.recordRejected(endpoint, protocol, handshake, 'rate_limited');
        return { ok: false, status: clampStatus(cfg.rate.status, 429), reason: 'Rate limited' };
      }
    }
    if (this.ctx.store.countOpenRealtimeSessions(endpoint.id) >= realtime.maxConnections) {
      this.recordRejected(endpoint, protocol, handshake, 'connection_limit');
      return { ok: false, status: 429, reason: 'Connection limit reached' };
    }
    return { ok: true };
  }

  authorizeProtocol(endpoint, payload) {
    const credentials = protocolAuthContext(endpoint, payload);
    const auth = verifyAuth(endpoint.config.auth, credentials);
    return auth.ok ? { ok: true } : { ok: false, reason: `auth:${auth.reason}` };
  }

  recordRejected(endpoint, protocol, handshake, reason) {
    const session = this.ctx.store.createRealtimeSession({
      endpointId: endpoint.id,
      protocol,
      transport: protocol === 'socketio' ? 'socket.io' : 'websocket',
      remoteIp: handshake.address || clientIp(handshake),
      headers: safeRealtimeHeaders(handshake.headers || {}),
    });
    const closed = this.ctx.store.closeRealtimeSession(session.id, { state: 'rejected', reason });
    this.ctx.events.broadcast('realtime_session', { endpointId: endpoint.id, session: closed });
    return closed;
  }

  createLive(endpoint, { protocol, transport, source = 'ingest', req, close }) {
    const session = this.ctx.store.createRealtimeSession({
      endpointId: endpoint.id,
      protocol,
      transport,
      source,
      remoteIp: req ? clientIp(req) : '',
      headers: safeRealtimeHeaders(req && req.headers || {}),
    });
    const live = {
      id: session.id,
      endpoint,
      protocol,
      transport,
      source,
      close,
      closed: false,
      script: endpoint.type === 'mock' ? this.ctx.store.listRealtimeScripts(endpoint.id).find((script) => script.enabled) || null : null,
      stepIndex: 0,
      rate: { start: Date.now(), count: 0 },
      idleTimer: null,
    };
    this.connections.set(live.id, live);
    this.scheduleIdle(live);
    this.ctx.events.broadcast('realtime_session', { endpointId: endpoint.id, session });
    return live;
  }

  scheduleIdle(live) {
    if (live.idleTimer) clearTimeout(live.idleTimer);
    const timeout = Number(live.endpoint.config.realtime.idleTimeoutMs) || 0;
    if (!timeout || live.closed) return;
    live.idleTimer = setTimeout(() => this.closeLive(live, { code: 1001, reason: 'idle_timeout' }), timeout);
    if (live.idleTimer.unref) live.idleTimer.unref();
  }

  touch(live) {
    this.scheduleIdle(live);
    const cfg = live.endpoint.config.realtime.messageRate;
    if (!cfg.enabled) return true;
    const windows = { second: 1000, minute: 60000, hour: 3600000 };
    const now = Date.now();
    const duration = windows[cfg.window] || 60000;
    if (now - live.rate.start >= duration) live.rate = { start: now, count: 0 };
    live.rate.count++;
    if (live.rate.count <= cfg.limit) return true;
    this.log(live, { direction: 'system', kind: 'rate_limit', payload: { limit: cfg.limit, window: cfg.window } });
    this.closeLive(live, { code: 1008, reason: 'message_rate_limited' });
    return false;
  }

  log(live, data) {
    if (!live || live.closed && data.kind !== 'close') return null;
    const safe = safeRealtimePayload(data.payload == null ? '' : data.payload, live.endpoint.config.realtime.maxPayloadCaptureBytes);
    const message = this.ctx.store.appendRealtimeMessage(live.id, {
      direction: data.direction,
      kind: data.kind,
      eventName: data.eventName || null,
      operationName: data.operationName || null,
      payload: safe.payload,
      payloadSize: safe.size,
      truncated: safe.truncated,
    }, live.endpoint.config.realtime.maxMessagesPerSession);
    if (message) this.ctx.events.broadcast('realtime_message', { endpointId: live.endpoint.id, sessionId: live.id, message });
    return message;
  }

  closeLive(live, { code = null, reason = 'closed', state = 'closed' } = {}) {
    if (!live || live.closed) return;
    live.closed = true;
    live.closeReason = reason;
    if (live.idleTimer) clearTimeout(live.idleTimer);
    this.connections.delete(live.id);
    try { if (live.close) live.close(code, reason); } catch { /* socket already gone */ }
    const session = this.ctx.store.closeRealtimeSession(live.id, { code, reason, state });
    if (session) this.ctx.events.broadcast('realtime_session', { endpointId: live.endpoint.id, session });
  }

  openRawSocket(socket, req) {
    const meta = this.wsMeta.get(socket);
    if (!meta) return socket.close(1011, 'Missing endpoint');
    const live = this.createLive(meta.endpoint, {
      protocol: 'websocket', transport: 'websocket', req,
      close: (code, reason) => socket.readyState === WebSocket.OPEN && socket.close(code || 1000, reason),
    });
    live.socket = socket;
    socket.on('error', () => this.closeLive(live, { reason: 'socket_error' }));
    socket.on('close', (code, reason) => this.closeLive(live, { code, reason: live.closeReason || String(reason || 'closed'), state: live.rejected ? 'rejected' : 'closed' }));
    socket.on('message', async (data, binary) => {
      if (live.closed || !this.touch(live)) return;
      const size = Buffer.isBuffer(data) ? data.length : Buffer.byteLength(String(data));
      if (size > live.endpoint.config.realtime.maxMessageBytes) return this.closeLive(live, { code: 1009, reason: 'message_too_large' });
      const payload = binary ? Buffer.from(data) : parsedPayload(data);
      this.log(live, { direction: 'in', kind: messageKind(payload, binary), payload });
      try { await this.applyScriptInput(live, { payload, text: payloadText(payload), kind: 'message' }); }
      catch { this.closeLive(live, { code: 1011, reason: 'script_error' }); }
    });
    this.runConnectActions(live).catch(() => this.closeLive(live, { code: 1011, reason: 'script_error' }));
  }

  async runConnectActions(live) {
    if (live.script && live.script.connectActions.length) await this.executeActions(live, live.script.connectActions);
  }

  scriptInputMatches(step, input) {
    const match = step.match || {};
    if (match.kind === 'event' && match.event !== input.eventName) return false;
    if (match.text && match.text !== input.text) return false;
    return match.payload == null || payloadMatches(match.payload, input.payload);
  }

  async applyScriptInput(live, input) {
    if (live.endpoint.type !== 'mock' || !live.script) return true;
    const step = live.script.steps[live.stepIndex];
    if (!step || !this.scriptInputMatches(step, input)) {
      this.log(live, { direction: 'system', kind: 'script_mismatch', payload: { expected: step && step.match || null, received: input.eventName || input.payload } });
      if (live.protocol === 'socketio' && live.socket) live.socket.emit('sidedoor:error', { code: 'SIDEDOOR_SCRIPT_MISMATCH' });
      else if (live.socket && live.socket.readyState === WebSocket.OPEN) live.socket.send(JSON.stringify({ error: 'SIDEDOOR_SCRIPT_MISMATCH' }));
      this.closeLive(live, { code: 1008, reason: 'script_mismatch' });
      return false;
    }
    live.stepIndex++;
    await this.executeActions(live, step.actions || []);
    return true;
  }

  async executeActions(live, actions) {
    for (const action of actions || []) {
      if (live.closed) return;
      await sleep(action.delayMs);
      if (live.closed) return;
      if (action.type === 'close') {
        this.log(live, { direction: 'system', kind: 'close', payload: { code: action.code, reason: action.reason } });
        this.closeLive(live, { code: action.code, reason: action.reason || 'script_close' });
      } else if (action.type === 'emit') {
        if (live.socket && live.protocol === 'socketio') live.socket.emit(action.event, action.payload);
        this.log(live, { direction: 'out', kind: 'event', eventName: action.event, payload: action.payload });
      } else if (action.type === 'send') {
        const body = jsonPayload(action.payload);
        if (live.socket && live.protocol === 'socketio') live.socket.emit('message', action.payload);
        else if (live.socket && live.socket.readyState === WebSocket.OPEN) live.socket.send(body);
        this.log(live, { direction: 'out', kind: messageKind(action.payload), payload: action.payload });
      }
    }
  }

  openSocketIo(socket) {
    const endpoint = this.endpointForSocketIo(socket);
    if (!endpoint) return socket.disconnect(true);
    const live = this.createLive(endpoint, {
      protocol: 'socketio', transport: socket.conn.transport.name || 'polling', req: { headers: socket.handshake.headers, socket: socket.conn.request.socket },
      close: () => socket.disconnect(true),
    });
    live.socket = socket;
    this.log(live, { direction: 'system', kind: 'connected', payload: { transport: socket.conn.transport.name || 'polling' } });
    socket.on('error', () => this.closeLive(live, { reason: 'socket_error' }));
    socket.on('disconnect', (reason) => this.closeLive(live, { reason: live.closeReason || reason || 'disconnected' }));
    socket.conn.on('upgrade', () => {
      live.transport = socket.conn.transport.name || 'websocket';
      this.log(live, { direction: 'system', kind: 'transport_upgrade', payload: { transport: live.transport } });
    });
    socket.onAny(async (eventName, ...args) => {
      if (live.closed || !this.touch(live)) return;
      const acknowledgement = typeof args[args.length - 1] === 'function' ? args.pop() : null;
      const payload = args.length <= 1 ? args[0] : args;
      const size = Buffer.byteLength(jsonPayload(payload));
      if (size > endpoint.config.realtime.maxMessageBytes) return this.closeLive(live, { reason: 'message_too_large' });
      this.log(live, { direction: 'in', kind: 'event', eventName, payload });
      const matched = await this.applyScriptInput(live, { kind: 'event', eventName, payload, text: payloadText(payload) });
      if (acknowledgement) {
        const response = matched ? { ok: true } : { ok: false, error: 'SIDEDOOR_SCRIPT_MISMATCH' };
        acknowledgement(response);
        this.log(live, { direction: 'out', kind: 'ack', eventName, payload: response });
      }
    });
    this.runConnectActions(live).catch(() => this.closeLive(live, { reason: 'script_error' }));
  }

  observeGraphqlSocket(socket) {
    const meta = this.wsMeta.get(socket);
    if (!meta) return socket.close(1011, 'Missing endpoint');
    const live = this.createLive(meta.endpoint, {
      protocol: 'graphql', transport: 'websocket', req: meta.req,
      close: (code, reason) => socket.readyState === WebSocket.OPEN && socket.close(code || 1000, reason),
    });
    live.socket = socket;
    socket.on('message', (data) => {
      if (live.closed || !this.touch(live)) return;
      const size = Buffer.isBuffer(data) ? data.length : Buffer.byteLength(String(data));
      if (size > live.endpoint.config.realtime.maxMessageBytes) return this.closeLive(live, { code: 1009, reason: 'message_too_large' });
      let payload;
      try { payload = JSON.parse(String(data)); } catch { payload = String(data); }
      if (!payload || payload.type !== 'subscribe') this.log(live, { direction: 'in', kind: 'graphql_protocol', payload });
    });
    socket.on('error', () => this.closeLive(live, { reason: 'socket_error' }));
    socket.on('close', (code, reason) => this.closeLive(live, { code, reason: live.closeReason || String(reason || 'closed'), state: live.rejected ? 'rejected' : 'closed' }));
  }

  liveForGraphql(gqlContext) {
    return gqlContext && gqlContext.extra && this.wsMeta.get(gqlContext.extra.socket)
      && [...this.connections.values()].find((live) => live.socket === gqlContext.extra.socket);
  }

  async onGraphqlConnect(gqlContext) {
    const live = this.liveForGraphql(gqlContext);
    if (!live) return false;
    const source = live.endpoint.config.realtime.authSource;
    if (source === 'protocol_init' || source === 'both') {
      const auth = this.authorizeProtocol(live.endpoint, gqlContext.connectionParams || {});
      if (!auth.ok) {
        live.closeReason = auth.reason;
        live.rejected = true;
        return false;
      }
    }
    this.log(live, { direction: 'out', kind: 'graphql_ack', payload: { acknowledged: true } });
    return true;
  }

  async onGraphqlSubscribe(gqlContext, payload) {
    const live = this.liveForGraphql(gqlContext);
    if (!live) return [graphQLError('Connection is unavailable', 'SIDEDOOR_CONNECTION_CLOSED')];
    const stored = this.ctx.store.getGraphqlSchema(live.endpoint.id);
    let operation;
    try {
      operation = analyzeGraphqlOperation({ sdl: stored.sdl, query: payload.query, variables: payload.variables || {}, operationName: payload.operationName });
    } catch (error) {
      return [graphQLError(error.message, 'SIDEDOOR_SCHEMA_INVALID')];
    }
    this.log(live, { direction: 'in', kind: 'graphql_operation', operationName: payload.operationName || '', payload });
    if (operation.errors.length) return operation.errors;
    const contextValue = { operation, fixture: null, introspection: isIntrospectionOperation(operation) };
    if (!contextValue.introspection) {
      const fixture = selectGraphqlFixture(this.ctx.store.listGraphqlFixtures(live.endpoint.id), operation);
      if (!fixture) return [resultError(live.endpoint.type === 'inspector' ? inspectorOnlyResult() : fixtureNotFoundResult())];
      contextValue.fixture = fixture;
    }
    return {
      schema: operation.schema,
      document: operation.document,
      operationName: operation.operationName || undefined,
      variableValues: operation.variables,
      contextValue,
    };
  }

  async executeGraphql(args) {
    const context = args.contextValue || {};
    if (context.introspection) return executeIntrospection(context.operation);
    if (!context.fixture) return fixtureNotFoundResult();
    await sleep(context.fixture.delayMs);
    return context.fixture.response;
  }

  async subscribeGraphql(args) {
    const context = args.contextValue || {};
    if (context.introspection) return graphqlExecute(args);
    if (!context.fixture) return fixtureNotFoundResult();
    return fixtureEventStream(context.fixture);
  }

  async runTest(endpoint, body = {}) {
    if (endpoint.protocol === 'graphql') return this.runGraphqlTest(endpoint, body);
    const live = this.createLive(endpoint, {
      protocol: endpoint.protocol,
      transport: 'test',
      source: 'test',
      close: null,
    });
    const messages = Array.isArray(body.messages) ? body.messages : [];
    this.log(live, { direction: 'system', kind: 'test_started', payload: { messages: messages.length } });
    await this.runConnectActions(live);
    for (const item of messages) {
      if (live.closed) break;
      const payload = item && typeof item === 'object' && Object.prototype.hasOwnProperty.call(item, 'payload') ? item.payload : item;
      const eventName = item && typeof item === 'object' ? item.event || item.eventName : null;
      const input = endpoint.protocol === 'socketio'
        ? { kind: 'event', eventName: String(eventName || 'message'), payload, text: payloadText(payload) }
        : { kind: 'message', payload, text: payloadText(payload) };
      this.log(live, { direction: 'in', kind: input.kind === 'event' ? 'event' : messageKind(payload), eventName: input.eventName, payload });
      await this.applyScriptInput(live, input);
    }
    if (!live.closed) this.closeLive(live, { reason: 'test_completed' });
    return this.ctx.store.getRealtimeSession(live.id, { details: true });
  }

  async runGraphqlTest(endpoint, body = {}) {
    const live = this.createLive(endpoint, { protocol: 'graphql', transport: 'test', source: 'test', close: null });
    const stored = this.ctx.store.getGraphqlSchema(endpoint.id);
    let result;
    try {
      const operation = analyzeGraphqlOperation({ sdl: stored.sdl, query: body.query, variables: body.variables || {}, operationName: body.operationName });
      this.log(live, { direction: 'in', kind: 'graphql_operation', operationName: body.operationName || '', payload: body });
      if (operation.errors.length) result = { errors: operation.errors.map((error) => ({ message: error.message, extensions: error.extensions })) };
      else if (isIntrospectionOperation(operation)) result = await executeIntrospection(operation);
      else {
        const fixture = selectGraphqlFixture(this.ctx.store.listGraphqlFixtures(endpoint.id), operation);
        if (!fixture) result = endpoint.type === 'inspector' ? inspectorOnlyResult() : fixtureNotFoundResult();
        else if (operation.operationType === 'subscription') {
          for await (const next of fixtureEventStream(fixture)) {
            this.log(live, { direction: 'out', kind: 'graphql_next', operationName: body.operationName || '', payload: next });
          }
          this.log(live, { direction: 'out', kind: 'graphql_complete', operationName: body.operationName || '', payload: { complete: true } });
          this.closeLive(live, { reason: 'test_completed' });
          return this.ctx.store.getRealtimeSession(live.id, { details: true });
        } else { await sleep(fixture.delayMs); result = fixture.response; }
      }
    } catch (error) {
      result = { errors: [{ message: error.message, extensions: { code: 'SIDEDOOR_SCHEMA_INVALID' } }] };
    }
    this.log(live, { direction: 'out', kind: 'graphql_next', operationName: body.operationName || '', payload: result });
    this.closeLive(live, { reason: 'test_completed' });
    return this.ctx.store.getRealtimeSession(live.id, { details: true });
  }

  disconnect(sessionId) {
    const live = this.connections.get(sessionId);
    if (live) {
      this.closeLive(live, { code: 1001, reason: 'admin_disconnect' });
      return this.ctx.store.getRealtimeSession(sessionId);
    }
    const current = this.ctx.store.getRealtimeSession(sessionId);
    if (!current || current.state !== 'connected') return current;
    const session = this.ctx.store.closeRealtimeSession(sessionId, { code: 1001, reason: 'admin_disconnect' });
    if (session) this.ctx.events.broadcast('realtime_session', { endpointId: session.endpointId, session });
    return session;
  }

  disconnectEndpoint(endpointId, reason = 'admin_disconnect') {
    let count = 0;
    for (const live of [...this.connections.values()]) {
      if (live.endpoint.id !== endpointId) continue;
      count++;
      this.closeLive(live, { code: 1001, reason });
    }
    return count;
  }

  async close() {
    for (const live of [...this.connections.values()]) this.closeLive(live, { code: 1001, reason: 'server_shutdown' });
    this.ctx.store.closeOpenRealtimeSessions();
    try { if (this.graphqlDisposable) await this.graphqlDisposable.dispose(); } catch { /* server is closing */ }
    try { if (this.rawWss) this.rawWss.close(); } catch { /* already closed */ }
    try { if (this.socketIo) await this.socketIo.close(); } catch { /* already closed */ }
  }
}

export { SOCKET_IO_PATH };

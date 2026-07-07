// Entry point. Boots the admin server (UI + REST API, localhost-only) and the
// ingest server (webhook/mock runtime, funnel-exposed) sharing one SQLite store.
import './lib/quiet.js';
import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { join, normalize, extname } from 'node:path';
import { loadConfig, localBase } from './config.js';
import { openDb } from './db.js';
import { Store } from './store.js';
import { Events } from './events.js';
import { RateLimiter } from './lib/ratelimit.js';
import { Tailscale } from './lib/tailscale.js';
import { createApiRouter, } from './api/routes.js';
import { sendJson, readJsonBody, ApiError } from './api/router.js';
import { createIngestHandler } from './ingest/handler.js';

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.png': 'image/png',
  '.woff2': 'font/woff2', '.woff': 'font/woff', '.map': 'application/json',
};

function sendError(res, e) {
  if (res.writableEnded) return;
  if (e instanceof ApiError) return sendJson(res, e.status, { error: e.message, fields: e.fields });
  // eslint-disable-next-line no-console
  console.error('[sidedoor] handler error:', e && e.stack || e);
  return sendJson(res, 500, { error: 'Internal error' });
}

async function serveStatic(config, req, res, path) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return sendJson(res, 405, { error: 'Method not allowed' });
  let rel = path === '/' ? '/index.html' : path;
  const filePath = normalize(join(config.publicDir, rel));
  if (!filePath.startsWith(normalize(config.publicDir))) return sendJson(res, 403, { error: 'Forbidden' });
  try {
    const info = await stat(filePath);
    if (!info.isFile()) throw new Error('not a file');
    const data = await readFile(filePath);
    res.writeHead(200, { 'Content-Type': MIME[extname(filePath)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(req.method === 'HEAD' ? undefined : data);
  } catch {
    // SPA fallback for extensionless routes; 404 for missing assets.
    if (!extname(path)) {
      try {
        const data = await readFile(join(config.publicDir, 'index.html'));
        res.writeHead(200, { 'Content-Type': MIME['.html'] });
        res.end(data);
        return;
      } catch { /* fall through */ }
    }
    sendJson(res, 404, { error: 'Not found' });
  }
}

async function dispatchApi(ctx, apiRouter, req, res, url) {
  const apiPath = url.pathname.slice('/__sd/api'.length) || '/';
  const match = apiRouter.match(req.method, apiPath);
  if (!match) return sendJson(res, 404, { error: 'Not found' });
  if (match.methodNotAllowed) return sendJson(res, 405, { error: 'Method not allowed' });
  let body = {};
  if (['POST', 'PATCH', 'PUT', 'DELETE'].includes(req.method)) {
    try { body = await readJsonBody(req, ctx.config.maxBodyBytes); }
    catch (e) { return sendError(res, e); }
  }
  const query = Object.fromEntries(url.searchParams.entries());
  const rc = { ctx, params: match.params, query, body, req, res };
  try {
    const result = await match.handler(rc);
    if (result !== undefined && !res.writableEnded) sendJson(res, 200, result);
  } catch (e) { sendError(res, e); }
}

function makeAdminHandler(ctx, apiRouter) {
  return async (req, res) => {
    let url;
    try { url = new URL(req.url, `http://${req.headers.host || 'localhost'}`); }
    catch { return sendJson(res, 400, { error: 'Bad request' }); }
    const path = url.pathname;
    try {
      if (path === '/__sd/api/events' && req.method === 'GET') { ctx.events.subscribe(res); return; }
      if (path === '/__sd/api/health') return sendJson(res, 200, { ok: true });
      if (path.startsWith('/__sd/api/')) return await dispatchApi(ctx, apiRouter, req, res, url);
      return await serveStatic(ctx.config, req, res, path);
    } catch (e) { sendError(res, e); }
  };
}

export function createApp(overrides = {}) {
  const config = loadConfig(overrides);
  const db = openDb(config.dbPath);
  const store = new Store(db);
  const events = new Events();
  const rateLimiter = new RateLimiter();
  const ctx = { config, db, store, events, rateLimiter };
  ctx.tailscale = overrides.tailscale || new Tailscale({ store, config, events });

  const apiRouter = createApiRouter();
  const adminServer = http.createServer(makeAdminHandler(ctx, apiRouter));
  const ingestServer = http.createServer(createIngestHandler(ctx));

  let pollTimer = null;

  function start() {
    return new Promise((resolve) => {
      let pending = 2;
      const done = () => { if (--pending === 0) resolve(app); };
      adminServer.listen(config.adminPort, config.adminHost, done);
      ingestServer.listen(config.ingestPort, config.ingestHost, done);
    });
  }

  function startFunnelPoll() {
    if (config.funnelPollMs > 0 && ctx.tailscale.refresh) {
      ctx.tailscale.refresh().catch(() => {});
      pollTimer = setInterval(() => ctx.tailscale.refresh().catch(() => {}), config.funnelPollMs);
      if (pollTimer.unref) pollTimer.unref();
    }
  }

  function close() {
    return new Promise((resolve) => {
      if (pollTimer) clearInterval(pollTimer);
      events.closeAll();
      let pending = 2;
      const done = () => { if (--pending === 0) { try { db.close(); } catch { /* ignore */ } resolve(); } };
      adminServer.close(done);
      ingestServer.close(done);
    });
  }

  const app = { config, db, store, events, rateLimiter, ctx, adminServer, ingestServer, start, startFunnelPoll, close };
  return app;
}

async function boot() {
  const app = await createApp().start();
  app.startFunnelPoll();
  const { adminHost, adminPort } = app.config;
  const shownHost = adminHost === '0.0.0.0' ? 'localhost' : adminHost;
  // eslint-disable-next-line no-console
  console.log(`\n  Sidedoor\n  ▸ Admin UI   http://${shownHost}:${adminPort}\n  ▸ Ingest     ${localBase(app.config)}  (funnel-exposed)\n  ▸ Database   ${app.config.dbPath}\n`);
  const shutdown = async () => { await app.close(); process.exit(0); };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

if (import.meta.main) boot();
